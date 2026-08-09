import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { detectCodeLanguage, decodeTextFile, detectImageMime, type FeishuImageInput, isSupportedImageMime, isSupportedTextFile } from "./attachments.js";
import { buildModelCard, buildResumeCard } from "./cards.js";
import type { ConversationManager } from "./conversation-manager.js";
import { claimFeishuMessage, markFeishuMessage } from "./dedupe-store.js";
import { debugLog } from "./debug.js";
import { loadConfig } from "./config.js";
import {
  clearRuntimeOverrides,
  formatRuntimeConfig,
  getRuntimeOverrides,
  setRuntimeConfig,
} from "./runtime-config.js";
import { conversationKey, conversationLabel, buildPromptWithQuote, getCommandList, normalizeForDedupe, parseBotCommand, parseMessageInput, pruneRecentMap } from "./messages.js";

// /daily 手动触发用的 prompt(和 scheduler 的日报 prompt 一致,但跳过 should_send 检查)
const DAILY_TRIGGER_PROMPT = [
  "日报生成（手动触发）。读 skills/kg-daily-report/SKILL.md 并完整按它执行。",
  "不要运行 should_send.py（手动触发跳过时间检查），直接采集数据并生成。",
].join("");
import { ReplyCard } from "./reply-card.js";
import { PanelCard } from "./panel-card.js";
import type { FeishuBridgeStore } from "./bridge-store.js";
import type { FeishuTransport } from "./transport.js";
import type { FeishuAttachment, FeishuMessage } from "./types.js";

const CONTENT_DEDUPE_TTL_MS = 5_000;

export class FeishuMessageHandler {
  private readonly seen = new Set<string>();
  private readonly recentContent = new Map<string, number>();

  constructor(
    private readonly conversations: ConversationManager,
    private readonly getTransport: () => FeishuTransport | undefined,
    private readonly bridgeStore?: FeishuBridgeStore,
  ) {}

  reset() {
    this.seen.clear();
    this.recentContent.clear();
  }

  /**
   * 素材归档（fire-and-forget）：把收到的图片/文件/音频原样下载，交给
   * 外部归档命令（assetArchiveCmd）落盘到知识库 daily/<date>/assets/。
   * 不 await —— 归档是后台活，不阻塞飞书回复。失败只记日志。
   */
  private archiveAttachments(msg: FeishuMessage, attachments: FeishuAttachment[], cmd: string) {
    const transport = this.getTransport();
    if (!transport) return;
    for (const attachment of attachments) {
      const fileName = attachment.fileName || (attachment.kind === "image" ? "image.png" : "unnamed");
      const type = attachment.kind === "image" ? "image" : "file";
      void (async () => {
        try {
          const resource = await transport.downloadMessageResource(msg.messageId, attachment.fileKey, type);
          if (!resource?.bytes?.length) return;
          const tmpDir = mkdtempSync(join(tmpdir(), "kg-archive-"));
          const tmpFile = join(tmpDir, fileName);
          writeFileSync(tmpFile, resource.bytes);
          const child = spawn("bash", ["-lc", `${cmd} ${JSON.stringify(tmpFile)} ${JSON.stringify(fileName)} --source feishu:${msg.messageId}`], {
            stdio: "ignore",
          });
          child.on("error", (err) => debugLog("feishu.archive.spawn_error", { error: err.message }));
          child.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));
        } catch (error) {
          debugLog("feishu.archive.download_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }
  }

  async handle(msg: FeishuMessage) {
    const transport = this.getTransport();
    if (!transport) return;

    // 用户主动发消息 = 不需要再追日记（标记 replied，避免 30 分钟后再打扰）
    if (msg.messageType === "text" && msg.content) {
      this.markDiaryRepliedIfActive();
    }

    let handledMsg = false;
    try {
      debugLog("feishu.handler.enter", { messageId: msg.messageId, seen: this.seen.has(msg.messageId) });
      if (this.seen.has(msg.messageId)) return;
      if (!(await claimFeishuMessage(msg.messageId))) return;
      debugLog("feishu.handler.claimed_ok", { messageId: msg.messageId });
      this.seen.add(msg.messageId);
      if (this.seen.size > 2000) this.seen.clear();
      handledMsg = true;

      const cfg = loadConfig();
      const parsed = parseMessageInput(msg, transport.getBotOpenId(), {
        parseInteractiveCards: cfg?.parseInteractiveCards !== false,
      });
      let text = parsed.text || "";
      const key = conversationKey(msg);
      this.bridgeStore?.bindConversation(key, msg);

      // 展开引用/回复的父消息（告警卡片场景）
      let quoted: { msgType: string; text: string } | null = null;
      if (cfg?.includeQuotedMessage !== false && (msg.parentId || msg.rootId)) {
        const q = await transport.getQuotedContext(
          msg,
          transport.getBotOpenId(),
          cfg?.quotedMessageMaxChars ?? 8000,
        );
        if (q?.text) {
          quoted = { msgType: q.msgType, text: q.text };
          for (const a of q.attachments || []) parsed.attachments.push(a);
        }
      }

      debugLog("feishu.handler.parsed", {
        messageId: msg.messageId,
        key,
        chatMode: msg.chatMode,
        threadId: msg.threadId || msg.rootId || msg.parentId,
        textLength: text.length,
        source: parsed.source,
        quoted: Boolean(quoted),
        attachments: parsed.attachments.map((item) => ({
          kind: item.kind,
          fileKey: item.fileKey,
          fileName: item.fileName,
        })),
      });

      // 素材归档：配置了 assetArchiveCmd 时,收到的图片/文件/音频原样归档（后台不阻塞）
      if (cfg?.assetArchiveCmd && parsed.attachments.length) {
        this.archiveAttachments(msg, parsed.attachments, cfg.assetArchiveCmd);
      }

      if (!parsed.attachments.length) {
        if (!text && !quoted) {
          await markFeishuMessage(msg.messageId, "ignored");
          return;
        }
        if (text) {
          const handled = await this.handleCommand(msg, key, text);
          if (handled) {
            await markFeishuMessage(msg.messageId, "replied");
            return;
          }
        }
      }

      if (this.isDuplicateContent(msg, key, text, parsed.attachments)) {
        await markFeishuMessage(msg.messageId, "ignored");
        return;
      }

      const model = await this.conversations.getSelectedModel(key);
      const modelSupportsImage = Boolean(model && Array.isArray((model as any).input) && (model as any).input.includes("image"));
      debugLog("feishu.handler.model", {
        messageId: msg.messageId,
        key,
        model: model ? `${(model as any).provider}/${(model as any).id}` : undefined,
        modelSupportsImage,
      });

      const processed = await this.processAttachments(msg, parsed.attachments, modelSupportsImage, Boolean(cfg?.assetArchiveCmd));
      const { imageInputs, fileSections, downloadErrors, skippedImageCount, archivedAssets } = processed;

      // 只有无法喂给 LLM 但已归档的素材（如 mp3）：不报错，友好告知归档中。
      if (archivedAssets.length && !imageInputs.length && !fileSections.length && !text.trim()) {
        await transport.replyText(
          msg.messageId,
          `收到${archivedAssets.length} 份素材（${archivedAssets.join("、")}），已归档，正在处理（录音转文字/文档转 md）。`,  
        );
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      if (skippedImageCount > 0 && imageInputs.length === 0 && !fileSections.length && !text.trim()) {
        await transport.replyText(
          msg.messageId,
          "当前模型不支持图片解析。请先发送 /model 并切换到支持图片的模型后，再重发图片。",
        );
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      if (downloadErrors.length && !imageInputs.length && !fileSections.length && !text.trim()) {
        await transport.replyText(msg.messageId, `没有可处理的内容：${downloadErrors.join("；")}`);
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      const basePrompt = buildPrompt(msg, text, fileSections, imageInputs, skippedImageCount, modelSupportsImage, downloadErrors);
      const prompt = buildPromptWithQuote(basePrompt, quoted);

      // 排队提示：上一条还在处理时，先回一条普通消息告诉用户在排队，
      // 不然静默入队容易让人以为消息丢了。
      if (this.conversations.getStatus(key).hasActiveRun) {
        await this.getTransport()?.replyText(
          msg.messageId,
          "⏳ 上一条还在处理，这条排队中（完成后自动开始）。",
        );
      }

      // 单卡：全程 header；流式参数来自 config/env
      const useStreaming = cfg?.streamingReply !== false;
      const card = new ReplyCard(key, msg.messageId, transport, {
        enabled: useStreaming,
        printFrequencyMs: cfg?.streamPrintFrequencyMs,
        printStep: cfg?.streamPrintStep,
        pushIntervalMs: cfg?.streamPushIntervalMs,
      });
      await card.start();

      // 过程面板：第一张卡展示工具调用 + 推理时间线（默认展开），
      // 完成后第二张卡（上面）流式答案。
      const panelCard = new PanelCard(transport, msg.messageId);
      await panelCard.start();

      await this.conversations.promptWithImages(
        key,
        prompt,
        imageInputs,
        async (reply) => {
          await card.completeWithAnswer(reply || "（无内容）");
        },
        card,
        useStreaming ? (delta) => card.append(delta) : undefined,
        (event) => panelCard.onEvent(event),
      );
      await panelCard.finish();
      await markFeishuMessage(msg.messageId, "replied");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.handler.error", { messageId: msg.messageId, error: message });
      await markFeishuMessage(msg.messageId, "failed", message);
      await this.getTransport()?.replyText(msg.messageId, `Pi error: ${message}`);
    } finally {
      // 只有真正处理过的消息才撤销「正在操作」的表情
      if (handledMsg) {
        await this.getTransport()?.clearReaction(msg.messageId).catch(() => {});
      }
    }
  }

  private async handleCommand(msg: FeishuMessage, key: string, text: string) {
    const command = parseBotCommand(text);
    if (!command) return false;

    const transport = this.getTransport();
    if (!transport) return true;

    if (command.name === "new") {
      await this.conversations.newConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "reload") {
      await this.conversations.reloadConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "compact") {
      await this.conversations.compactConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "session") {
      const info = await this.conversations.getSessionInfo(key);
      if (!info) {
        await transport.replyText(msg.messageId, "无法读取会话信息（可能还没建立会话）。");
        return true;
      }
      const fmtTokens = (n: number | null) => {
        if (n == null) return "—";
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
        return `${n}`;
      };
      const lines = [
        "📇 会话信息",
        "",
        `名称：${info.name || "（未命名）"}`,
        `模型：${info.model || "—"}`,
        `消息数：${info.messages ?? "—"}`,
        `上下文：${info.tokens != null ? `${(info.percent ?? 0).toFixed(1)}%` : "—"} / ${fmtTokens(info.contextWindow)}`,
        `已用：${fmtTokens(info.tokens)} tokens`,
      ];
      if (info.sessionFile) lines.push("", `会话文件：${info.sessionFile}`);
      await transport.replyText(msg.messageId, lines.join("\n"));
      return true;
    }

    if (command.name === "model") {
      const models = await this.conversations.getAvailableModels();
      if (!models.length) {
        await transport.replyText(msg.messageId, "当前没有可用模型。请先在 Pi 里完成模型登录或 API Key 配置。");
        return true;
      }
      const currentModel = await this.conversations.getSelectedModel(key);
      await transport.replyCard(msg.messageId, buildModelCard(key, models, currentModel));
      return true;
    }

    if (command.name === "resume") {
      const page = await this.conversations.listResumeSessions(key, "current", 0);
      await transport.replyCard(msg.messageId, buildResumeCard(page));
      return true;
    }

    if (command.name === "stop") {
      await this.conversations.stopConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "workspace") {
      await this.conversations.switchWorkspace(key, command.path, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "think") {
      await this.conversations.setThinkingLevel(key, command.level || "", async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "cog") {
      // 认知命令：把方法骨架注入当前会话，让 AI 用对应方式处理内容
      const methods: Record<string, string> = {
        think: [
          "用「下钻」方法处理下面内容：每往下一层只回答「为什么会这样」，不是「还有什么」。",
          "每层尽量换一个更底层的框架（社会→心理→生物/物理→逻辑）。",
          "钻到一层点出这层里还没解决的矛盾，那是下一层的入口。",
          "到底标志：同义反复 / 人性硬结构 / 物理定律 / 逻辑本身 / 悖论。浅三层深六七层，自己判断。",
        ].join(" "),
        rank: [
          "用「降维」方法处理下面领域：把整个领域压到 2-3 条「生成现象的线」，",
          "即少数几条底层机制，能解释该领域大部分现象。别列清单，找生成器。",
        ].join(" "),
        plain: [
          "用「白话」方法处理下面概念：用大白话讲到对方能复述给朋友。",
          "优先日常类比，避开术语堆砌；讲完可以用一句话自测能否复述。",
        ].join(" "),
      };
      await transport.replyText(msg.messageId, `⏳ /kg:${command.mode} 处理中…`);
      await this.conversations.prompt(
        key,
        `${methods[command.mode]}\n\n内容：${command.text}`,
        async () => {},
      );
      return true;
    }

    if (command.name === "status") {
      const st = this.conversations.getStatus(key);
      const ctx = await this.conversations.getContextStatus(key);
      const model = await this.conversations.getActualModel(key);
      const formatTokens = (n: number) => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
        return `${n}`;
      };
      const ctxLine = ctx && ctx.tokens !== null && ctx.contextWindow
        ? `${(ctx.percent ?? 0).toFixed(1)}% / ${formatTokens(ctx.contextWindow)} (↑${formatTokens(ctx.tokens ?? 0)} tokens)`
        : "暂无数据（发送一条消息后才会显示）";
      const stateLine = st.hasActiveRun
        ? (st.activeStopped ? "⏹ 已停止" : "🟢 正在生成回复")
        : "⚪ 空闲";
      await transport.replyText(
        msg.messageId,
        [
          "📊 当前状态",
          "",
          `状态: ${stateLine}`,
          `目录: ${st.cwd}`,
          `模型: ${model}`,
          `上下文: ${ctxLine}`,
        ].join("\n"),
      );
      return true;
    }

    if (command.name === "commands") {
      await transport.replyText(msg.messageId, `可用命令：\n${getCommandList()}`);
      return true;
    }

    if (command.name === "daily") {
      // 手动触发日报(和定时器同一注入逻辑)。
      // 直接注入当前会话会让 AI 在当前上下文里跑日报流程。
      await transport.replyText(msg.messageId, "⏳ 开始生成日报（读 SKILL 执行完整流程）…");
      const pKey = conversationKey(msg);
      await this.conversations.prompt(pKey, DAILY_TRIGGER_PROMPT, async () => {});
      return true;
    }

    if (command.name === "config") {
      if (command.clearTarget) {
        const cleared = clearRuntimeOverrides(command.clearTarget);
        if (cleared.ok === false) {
          await transport.replyText(msg.messageId, `❌ ${cleared.error}`);
          return true;
        }
        const cfg = loadConfig();
        await transport.replyText(
          msg.messageId,
          [
            command.clearTarget === "all" ? "已清除全部 runtime overrides" : `已清除 override: ${command.clearTarget}`,
            "",
            cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "配置不可用",
          ].join("\n"),
        );
        return true;
      }
      if (command.key) {
        if (command.value === undefined || command.value === "") {
          await transport.replyText(
            msg.messageId,
            `用法: /config ${command.key} <value>\n或: /config clear ${command.key}`,
          );
          return true;
        }
        const set = setRuntimeConfig(command.key, command.value);
        if (set.ok === false) {
          await transport.replyText(msg.messageId, `❌ ${set.error}`);
          return true;
        }
        const cfg = loadConfig();
        await transport.replyText(
          msg.messageId,
          [
            `✅ 已更新 ${set.key} = ${Array.isArray(set.value) ? set.value.join(", ") : String(set.value)}`,
            "已热更新并落盘（runtime-overrides.json）",
            "",
            cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
          ].filter(Boolean).join("\n"),
        );
        return true;
      }
      const cfg = loadConfig();
      await transport.replyText(
        msg.messageId,
        cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "配置不可用（缺少 FEISHU_APP_ID/SECRET）",
      );
      return true;
    }

    return false;
  }

  private isDuplicateContent(msg: FeishuMessage, key: string, text: string, attachments: Array<{ kind: string; fileKey: string; fileName?: string }>) {
    const now = Date.now();
    const attachmentKey = attachments.map((a) => `${a.kind}:${a.fileKey}:${a.fileName || ""}`).join("|");
    const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text), attachmentKey].join("\u0000");
    const previousContentAt = this.recentContent.get(contentKey);
    if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return true;
    this.recentContent.set(contentKey, now);
    if (this.recentContent.size > 2000) pruneRecentMap(this.recentContent, now, CONTENT_DEDUPE_TTL_MS);
    return false;
  }

  private async processAttachments(
    msg: FeishuMessage,
    attachments: Array<{ kind: "image" | "file"; fileKey: string; fileName?: string }>,
    modelSupportsImage: boolean,
    hasArchiver = false,
  ) {
    const transport = this.getTransport();
    const imageInputs: FeishuImageInput[] = [];
    const fileSections: string[] = [];
    const downloadErrors: string[] = [];
    const archivedAssets: string[] = [];
    let skippedImageCount = 0;

    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        if (!modelSupportsImage) {
          skippedImageCount += 1;
          continue;
        }
        if (!transport) {
          downloadErrors.push("飞书连接不可用，图片无法下载");
          continue;
        }
        try {
          const resource = await withTimeout(
            transport.downloadImage(msg.messageId, attachment.fileKey),
            15000,
            "图片下载超时",
          );
          const mimeType = detectImageMime(resource.bytes, resource.mimeType);
          if (!isSupportedImageMime(mimeType)) {
            downloadErrors.push("图片格式暂不支持（仅支持 png/jpg/webp）");
            continue;
          }
          imageInputs.push({
            type: "image",
            data: resource.bytes.toString("base64"),
            mimeType,
          });
        } catch (error) {
          debugLog("feishu.handler.image_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
          downloadErrors.push(error instanceof Error ? error.message : "图片下载失败");
        }
        continue;
      }

      const fileName = attachment.fileName || "unnamed";
      if (!isSupportedTextFile(fileName)) {
        if (hasArchiver) {
          // 归档器已拿到附件（archiveAttachments 在 parsed 后 fire-and-forget），
          // 这里是“不能喂给 LLM 但能归档”的二进制素材（音频/视频/压缩包等）。
          archivedAssets.push(fileName);
        } else {
          downloadErrors.push(`文件类型不支持：${fileName}`);
        }
        continue;
      }
      if (!transport) {
        downloadErrors.push(`飞书连接不可用，文件无法下载：${fileName}`);
        continue;
      }
      try {
        const resource = await withTimeout(
          transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
          15000,
          `文件下载超时：${fileName}`,
        );
        const decoded = decodeTextFile(fileName, resource.bytes);
        if (!decoded.ok) {
          downloadErrors.push(`文件无法按文本读取：${fileName}`);
          continue;
        }
        const language = detectCodeLanguage(fileName);
        const suffix = decoded.truncated ? "\n[内容过长，已截断]" : "";
        fileSections.push(`[Feishu file: ${fileName}]\n\`\`\`${language}\n${decoded.text}${suffix}\n\`\`\``);
      } catch (error) {
        downloadErrors.push(error instanceof Error ? error.message : `文件下载失败：${fileName}`);
      }
    }

    return { imageInputs, fileSections, downloadErrors, skippedImageCount, archivedAssets };
  }
}

function buildPrompt(
  msg: FeishuMessage,
  text: string,
  fileSections: string[],
  imageInputs: FeishuImageInput[],
  skippedImageCount: number,
  modelSupportsImage: boolean,
  downloadErrors: string[],
) {
  const contentParts: string[] = [];
  if (text.trim()) contentParts.push(text.trim());
  if (fileSections.length) contentParts.push(fileSections.join("\n\n"));
  if (!contentParts.length && imageInputs.length) {
    contentParts.push("请根据图片内容进行分析。");
  }

  if (skippedImageCount > 0 && !modelSupportsImage) {
    contentParts.push("[提示：当前模型不支持图片，本次仅处理文本/文件内容。]");
  }

  if (downloadErrors.length) {
    contentParts.push(`[部分附件未处理：${downloadErrors.join("；")}]`);
  }

  const promptBody = contentParts.join("\n\n").trim();
  return `${conversationLabel(msg)} ${promptBody}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 用户主动发消息 → 若当天有活跃的日记提醒（未回复），标记 replied。
 * 避免 AI 没来得及更新状态时，30 分钟后还追问。
 */
function markDiaryRepliedIfActive(this: unknown): void {
  try {
    const { homedir } = require("node:os") as typeof import("node:os");
    const { readFileSync, writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const statePath = join(homedir(), ".kg-agent-config", "diary-reminder.json");
    let state: { date?: string; sent_count?: number; replied?: boolean } = {};
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {}
    if (state.date && state.sent_count && !state.replied) {
      state.replied = true;
      mkdirSync(join(homedir(), ".kg-agent-config"), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    }
  } catch {}
}
