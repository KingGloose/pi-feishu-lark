/**
 * 交互澄清：AI 调 ask_feishu 工具 → 发一张选择卡 → 等用户在飞书点选 → 返回选择。
 *
 * 原理（回答「AI 为什么能询问」）：
 *   agent 调 ask_feishu 工具 = 一次普通工具调用。工具内发卡 + Promise 挂起
 *   （不 resolve），飞书用户点选卡片 → 卡片回调带着 clarify_id + 选择值回到
 *   扩展 → resolve Promise → 工具返回「用户选择了 X」→ agent 继续干活。
 *
 * 卡片：schema 2.0（与 CardKit 一致，回调返回也走 2.0 避免 200830/200671）。
 * 元素：问题 markdown + 选项列表 + select_static 下拉框（value 携带 clarify_id）。
 */
import { debugLog } from "./debug.js";

export interface ClarifyOption {
  value: string;
  label: string;
  description?: string;
}

interface Pending {
  id: string;
  options: ClarifyOption[];
  resolve: (choice: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

type ClarifyTransport = {
  /** 发一张卡，返回 message_id */
  sendCard(chatId: string, card: object): Promise<string | undefined>;
  /** 更新一张卡（选完/超时后改写摘要） */
  updateCard(messageId: string, card: object): Promise<void>;
};

const QUESTION_ELEMENT_ID = "clarify-question";
const SELECT_ELEMENT_ID = "clarify-select";
const INPUT_ELEMENT_ID = "clarify-input";

export class ClarifyManager {
  private pending: Pending | null = null;
  private readonly transport: ClarifyTransport;

  constructor(transport: ClarifyTransport) {
    this.transport = transport;
  }

  get hasPending(): boolean {
    return this.pending != null;
  }

  /** 发起澄清：发卡 + 挂起等用户点选 */
  async ask(
    chatId: string,
    question: string,
    options: ClarifyOption[],
    timeoutMs = 300_000,
    allowInput = false,
  ): Promise<string> {
    if (this.hasPending) throw new Error("已有一个等待中的澄清请求");
    const id = `clarify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messageId = await this.transport.sendCard(chatId, this.buildCard(id, question, options, allowInput));
    if (!messageId) throw new Error("澄清卡片发送失败");

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.finish("timeout", new Error("澄清请求超时"));
      }, timeoutMs);
      this.pending = { id, options, resolve, reject, timer, settled: false };
      debugLog("feishu.clarify.asked", { id, options: options.length, timeoutMs, allowInput });
    });
  }

  /** 卡片回调入口：匹配 clarify_id + 选择值 → resolve */
  async handleAction(action: { clarifyId: string; choice?: string; inputValue?: string; messageId?: string }): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.settled || pending.id !== action.clarifyId) return false;
    if (action.inputValue != null && action.inputValue.trim()) {
      // 自由输入：用户在输入框里打了字提交
      const text = action.inputValue.trim().slice(0, 200);
      await this.finish("submitted", undefined, `free:${text}`, `手动输入：${text}`);
    } else if (action.choice != null && action.choice !== "") {
      // 按钮选择
      const label = pending.options.find((o) => o.value === action.choice)?.label ?? action.choice;
      await this.finish("submitted", undefined, action.choice, label);
    } else {
      return false;
    }
    return true;
  }

  /** 会话关闭/中止时释放 */
  abort() {
    if (this.pending) void this.finish("aborted", new Error("澄清请求已取消"));
  }

  private async finish(
    status: "submitted" | "timeout" | "aborted",
    error?: Error,
    choice?: string,
    label?: string,
  ) {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending = null;
    debugLog("feishu.clarify.finished", { status, choice: choice ?? "" });
    if (error) pending.reject(error);
    else pending.resolve(choice ?? "");
  }

  /** schema 2.0 澄清卡：问题 + 选项按钮 + 可选输入框（自由输入） */
  private buildCard(id: string, question: string, options: ClarifyOption[], allowInput = false): object {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const elements: object[] = [
      {
        tag: "markdown",
        element_id: QUESTION_ELEMENT_ID,
        content: question,
        text_size: "title_2",
      },
      { tag: "hr" },
      ...options.map((option, index) => ({
        tag: "button",
        text: { tag: "plain_text", content: `${letters[index]}. ${option.label}` },
        type: index === 0 ? "primary" : "default",
        width: "fill",
        margin: "8px 0 4px 0",
        behaviors: [
          {
            type: "callback",
            value: {
              clarify_id: id,
              choice: option.value,
            },
          },
        ],
      })),
    ];
    if (allowInput) {
      // 自由输入框：用户打字后点输入框的提交图标触发回调
      // 回调里 action.input_value = 用户输入, action.value = { clarify_id }
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: "✏️ **或者手动输入**（不想点按钮就打字）",
        text_size: "notation",
      });
      elements.push({
        tag: "input",
        element_id: INPUT_ELEMENT_ID,
        placeholder: { tag: "plain_text", content: "输入你的回答…" },
        input_type: "text",
        behaviors: [
          {
            type: "callback",
            value: {
              clarify_id: id,
              free_input: true,
            },
          },
        ],
      });
    }
    return {
      schema: "2.0",
      header: {
        title: { tag: "plain_text", content: "需要你确认" },
        template: "blue",
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 16px 12px",
        elements,
      },
    };
  }
}
