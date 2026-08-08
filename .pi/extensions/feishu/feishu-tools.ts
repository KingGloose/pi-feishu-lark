/**
 * 子会话专用工具：ask_feishu / search_bilibili。
 *
 * 背景：createAgentSession 的子会话工具列表独立于主进程 extension 注册的工具，
 * 子会话只有默认 19 个（read/bash/edit/write + memory + search 等）。
 * 要让飞书对话里的 AI 能发交互卡、搜 B 站，必须通过 customTools 传入。
 *
 * 这两个工具同时也在主进程 registerTool 注册（保持一致性），
 * 但子会话只认这里 customTools 传入的定义。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug.js";
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

/** search_bilibili：搜 B 站视频，返回完整可点击链接。 */
export function makeSearchBilibiliTool(): ToolDefinition {
  return {
    name: "search_bilibili",
    label: "Search Bilibili Videos",
    description:
      "按关键词搜索 B 站视频，返回含完整可点击链接的结果（标题/BV号/作者/时长/播放量）。\n" +
      "**当用户要教程/方案/推荐，需要附视频佐证时用它**——搜出 1-2 个相关视频附在回答末尾。\n" +
      "链接必须用返回的 url 字段（https://www.bilibili.com/video/<BV号>），不要自己拼、不要只给 BV 号。",
    promptSnippet:
      "Need video evidence for a tutorial/recommendation → search_bilibili returns clickable links; always use the url field.",
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词（取用户问题的核心词）" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 3" })),
    }),
    async execute(_toolCallId, params: { keyword: string; limit?: number }) {
      const keyword = String(params.keyword || "").trim();
      if (!keyword) return textResult("缺少 keyword 参数。");
      const skillsRoot = process.env.KG_WIKI_SKILLS_ROOT || "";
      const searchPy = skillsRoot
        ? `${skillsRoot}/kg-ingest/references/bilibili/search_videos.py`
        : "";
      if (!searchPy || !existsSync(searchPy)) {
        return textResult(
          "找不到 B 站搜索脚本（KG_WIKI_SKILLS_ROOT 未配置或脚本缺失）。可以先给文字教程。",
        );
      }
      const limit = Math.min(5, Math.max(1, Number(params.limit) || 3));
      const python = process.env.KG_VENV ? `${process.env.KG_VENV}/python` : "python3";
      try {
        const r = spawnSync(python, [searchPy, keyword, "--order", "click", "--limit", String(limit)], {
          encoding: "utf8",
          timeout: 25_000,
        });
        if (r.status !== 0) {
          return textResult(`B 站搜索失败：${(r.stderr || "").slice(0, 200) || "非零退出码"}`);
        }
        const arrMatch = r.stdout.match(/\[[\s\S]*\]/);
        if (!arrMatch) return textResult("B 站搜索无结果（或返回格式异常）。");
        const videos = JSON.parse(arrMatch[0]);
        if (!Array.isArray(videos) || !videos.length) {
          return textResult(`「${keyword}」没有搜到相关视频。`);
        }
        const lines = videos.map((v: any, i: number) => {
          const url = v.url || `https://www.bilibili.com/video/${v.bvid}`;
          return `${i + 1}. ${v.title || "（无标题）"}\n   ${url}\n   作者：${v.author || "?"} · ${v.duration || "?"} · ${v.play != null ? `${v.play} 播放` : ""}`;
        });
        return textResult(`搜到 ${videos.length} 个视频：\n${lines.join("\n")}`);
      } catch (error) {
        return textResult(
          `B 站搜索异常：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

/** 子会话要用的自定义工具（customTools 传入） */
export function makeFeishuCustomTools(deps: FeishuCustomToolDeps): ToolDefinition[] {
  return [makeAskFeishuTool(deps), makeSearchBilibiliTool()];
}
