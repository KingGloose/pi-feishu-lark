/**
 * 子会话专用工具：ask_feishu（交互澄清卡）。
 *
 * 背景：createAgentSession 的子会话工具列表独立于主进程 extension 注册的工具，
 * 子会话只有默认 19 个（read/bash/edit/write + memory + search 等）。
 * 要让飞书对话里的 AI 能发交互卡，必须通过 customTools 传入。
 *
 * B 站搜索不在这里 —— 那是「跑一个 python 脚本」的事，AI 用 bash 就能做，
 * 规范写在 kg-wiki-agent/AGENTS.md（禁止编 BV 号 + 必须给完整链接）。
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ClarifyManager, ClarifyOption } from "./clarify.js";
import type { FeishuBridgeStore } from "./bridge-store.js";

export type FeishuCustomToolDeps = {
  clarify: ClarifyManager;
  bridgeStore: FeishuBridgeStore;
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** ask_feishu：发选择卡等用户在飞书点选。AI 的「询问」= 一次工具调用。 */
export function makeAskFeishuTool(deps: FeishuCustomToolDeps): ToolDefinition {
  return {
    name: "ask_feishu",
    label: "Ask Feishu User (interactive card)",
    description:
      "向飞书用户发送一张交互选择卡（按钮），等待用户点选后返回其选择。\n" +
      "**当你需要用户做选择/确认时用它**——比如「要沉淀成知识页吗」「选 A 还是 B」\n" +
      "「好多了还是还那样」。不要自己构造卡片 JSON，用这个工具。\n" +
      "仅当对话通过飞书远程进行时使用；本机 TUI 会话请改用 questionnaire。",
    promptSnippet:
      "Need the Feishu user to pick/confirm → ask_feishu sends an interactive button card and waits for their tap.",
    parameters: Type.Object({
      question: Type.String({ description: "要澄清的问题" }),
      choices: Type.Array(Type.String({ description: "选项（纯文本，最多 6 个）" }), {
        description: "选项列表",
      }),
    }),
    async execute(_toolCallId, params: { question: string; choices: string[] }) {
      if (deps.clarify.hasPending) {
        return textResult("已有等待中的澄清请求，先处理完那个。");
      }
      const chatId = deps.bridgeStore.latestChatId();
      if (!chatId) {
        return textResult("没有活跃的飞书聊天（还没收到过消息）。");
      }
      const choices = (params.choices || []).slice(0, 6);
      if (!params.question || !choices.length) {
        return textResult("缺少 question 或 choices 参数。");
      }
      const options: ClarifyOption[] = choices.map((c, i) => ({
        value: String(i + 1),
        label: c,
      }));
      try {
        const choice = await deps.clarify.ask(chatId, params.question, options, 300_000);
        const label = options.find((o) => o.value === choice)?.label ?? choice;
        return textResult(`用户选择：${label}（${choice}）`);
      } catch (error) {
        return textResult(
          `澄清未完成：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function makeFeishuCustomTools(deps: FeishuCustomToolDeps): ToolDefinition[] {
  return [makeAskFeishuTool(deps)];
}
