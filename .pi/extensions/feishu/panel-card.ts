/**
 * 过程面板卡：发送第一张「工具+推理」时间线卡，完成后可折叠。
 *
 * 与 CardKit 答案卡分工：
 *   - 第一张卡（本类）：过程面板，collapsible_panel，默认展开
 *   - 第二张卡（ReplyCard/CardKit）：流式答案
 *
 * 流程：
 *   1. start()：立即发一张「正在处理…」面板卡
 *   2. onEvent()：工具/推理事件喂进来 → 节流 PATCH 更新卡
 *   3. finish()：最终 PATCH（完成状态）
 */
import { debugLog } from "./debug.js";
import { ProcessPanel } from "./process-panel.js";
import type { FeishuTransport } from "./transport.js";

const PANEL_REFRESH_MS = 800; // 面板更新节流

export class PanelCard {
  private panel = new ProcessPanel();
  private cardMessageId: string | null = null;
  private lastRendered = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly transport: FeishuTransport,
    private readonly replyToMessageId: string,
  ) {}

  /** 发送第一张面板卡 */
  async start(): Promise<void> {
    try {
      const card = this.buildCard(true);
      this.cardMessageId = await this.transport.replyCard(this.replyToMessageId, card);
      debugLog("feishu.panel.started", { cardMessageId: this.cardMessageId });
    } catch (error) {
      debugLog("feishu.panel.start_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.cardMessageId = null;
    }
  }

  /** 工具/推理事件入口（conversation-manager 转发） */
  onEvent(event: unknown) {
    if (this.closed) return;
    const changed = this.panel.onEvent(event);
    if (!changed) return;
    this.scheduleRefresh();
  }

  /** 完成：最终更新一次面板卡（保留可折叠的最终态） */
  async finish(): Promise<void> {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    if (!this.cardMessageId) return;
    try {
      await this.transport.updateCard(this.cardMessageId, this.buildCard(false));
      debugLog("feishu.panel.finished", { cardMessageId: this.cardMessageId });
    } catch (error) {
      debugLog("feishu.panel.finish_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 生成面板卡 JSON：面板 + 底部提示「回答见下一条」 */
  private buildCard(expanded: boolean): object {
    const panel = this.panel.render(expanded);
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "🧠 处理中…" },
        template: "blue",
      },
      elements: [
        panel,
        { tag: "hr" },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "⏳ 思考过程中，回答将在完成后发送。",
          },
          text_size: "notation",
        },
      ],
    };
  }

  private scheduleRefresh() {
    if (this.closed || !this.cardMessageId) return;
    const now = Date.now();
    const wait = Math.max(0, PANEL_REFRESH_MS - (now - this.lastRendered));
    if (wait === 0) {
      void this.refresh();
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.refresh();
    }, wait);
  }

  private async refresh() {
    if (this.closed || !this.cardMessageId) return;
    this.lastRendered = Date.now();
    try {
      await this.transport.updateCard(this.cardMessageId, this.buildCard(true));
    } catch (error) {
      debugLog("feishu.panel.refresh_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
