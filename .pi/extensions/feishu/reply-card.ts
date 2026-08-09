/**
 * 回复呈现：
 * - 默认 CardKit streaming_mode：客户端逐字打印（print_step=1）
 * - 关闭流式时：先「回复中」卡，结束一次写入全文
 * - 不展示工具/阶段过程
 */
import { randomUUID } from "node:crypto";
import {
  buildReplyCard,
  defaultFinalNote,
  type ReplyCardStatus,
} from "./card-builder.js";
import { CardKitStream } from "./cardkit-stream.js";
import { loadConfig } from "./config.js";
import { debugLog } from "./debug.js";

export type { ReplyCardStatus } from "./card-builder.js";
export {
  buildReplyCard,
  parseStopTaskActionValue,
  STOP_ACTION,
} from "./card-builder.js";

export type ReplyCardSink = {
  readonly runId: string;
  updateFromEvent(event: unknown): void;
  stopImmediately(note?: string): Promise<void>;
  finish(status: Exclude<ReplyCardStatus, "running" | "inactive">, note?: string): Promise<void>;
  append(delta: string): void;
  ensureFinal(text: string): void;
  /** 记录本次调用的 token 用量（可选，用于卡片底部注记） */
  setUsage?(usage: { input?: number; output?: number; cacheRead?: number; reasoning?: number } | null): void;
  /** 记录本次调用的 pi 会话 id（可选，用于卡片标注是哪个会话） */
  setSessionId?(sessionId: string): void;
};

export type ReplyCardStreamOptions = {
  enabled?: boolean;
  /** CardKit 客户端打印间隔 ms（默认 50） */
  printFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  printStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
};

type ReplyCardTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
  replyPlainText?(messageId: string, text: string): Promise<string | undefined>;
  updateText?(messageId: string, text: string): Promise<void>;
  /** 记录本 bot 出站消息，供 groupAlsoOnReply */
  rememberOutboundMessageId?(messageId: string): void;
};

function resolveStreamOptions(override?: ReplyCardStreamOptions) {
  const cfg = loadConfig();
  return {
    enabled: override?.enabled ?? cfg?.streamingReply !== false,
    printFrequencyMs: Math.max(
      20,
      override?.printFrequencyMs
        ?? parseEnvInt("FEISHU_STREAM_PRINT_FREQUENCY_MS")
        ?? cfg?.streamPrintFrequencyMs
        ?? 50,
    ),
    printStep: Math.max(
      1,
      override?.printStep
        ?? parseEnvInt("FEISHU_STREAM_PRINT_STEP")
        ?? cfg?.streamPrintStep
        ?? 1,
    ),
    pushIntervalMs: Math.max(
      50,
      override?.pushIntervalMs
        ?? parseEnvInt("FEISHU_STREAM_PUSH_INTERVAL_MS")
        ?? cfg?.streamPushIntervalMs
        ?? 120,
    ),
  };
}

function parseEnvInt(name: string): number | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export class ReplyCard implements ReplyCardSink {
  readonly runId = randomUUID();
  private status: ReplyCardStatus = "running";
  private body = "";
  private note: string | undefined;
  private readonly startedAt = Date.now();
  private usage: { input?: number; output?: number; cacheRead?: number; reasoning?: number } | null = null;
  private sessionId: string | undefined;
  private cardkits: CardKitStream[] = [];
  private fallbackCardId: string | undefined;
  private readonly streamOpts: ReturnType<typeof resolveStreamOptions>;
  private readonly key: string;
  private readonly replyToMessageId: string;
  private readonly transport: ReplyCardTransport;
  /** 长回答续卡：超过单卡上限自动开下一张卡 */
  private readonly maxBodyChars: number;

  constructor(
    key: string,
    replyToMessageId: string,
    transport: ReplyCardTransport,
    streamOptions?: ReplyCardStreamOptions,
  ) {
    this.key = key;
    this.replyToMessageId = replyToMessageId;
    this.transport = transport;
    this.streamOpts = resolveStreamOptions(streamOptions);
    this.maxBodyChars = Math.max(
      2000,
      loadConfig()?.streamMaxBodyChars ?? 12000,
    );
  }

  get messageId() {
    return this.fallbackCardId;
  }

  /** 记录本次调用的 token 用量（由 conversation-manager 在完成时传入）。 */
  setUsage(usage: { input?: number; output?: number; cacheRead?: number; reasoning?: number } | null) {
    this.usage = usage;
  }

  /** 记录本次调用的 pi 会话 id（由 conversation-manager 在拿到 session 后传入）。 */
  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 生成卡片底部注记：耗时 + token + 会话id。 */
  private buildFinalNote(): string | undefined {
    const sec = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    const fmt = (n?: number) => (n ? `${(n / 1000).toFixed(1)}k` : "-");
    const parts: string[] = [`⏱ ${sec} 秒`];
    if (this.usage && (this.usage.input != null || this.usage.output != null)) {
      parts.push(`↑${fmt(this.usage.input)} ↓${fmt(this.usage.output)}`);
      if (this.usage.cacheRead) parts.push(`缓存读 ${fmt(this.usage.cacheRead)}`);
    }
    // 会话id：完整展示，方便在 /resume 或 TUI 里精确定位。
    if (this.sessionId) parts.push(`会话 ${this.sessionId}`);
    return parts.join(" · ");
  }

  async start() {
    const cfg = loadConfig();
    if (this.streamOpts.enabled && cfg?.appId && cfg?.appSecret) {
      this.cardkits.push(this.newCardKit());
      debugLog("feishu.reply_card.cardkit_ready", {
        key: this.key,
        runId: this.runId,
        ...this.streamOpts,
      });
      return;
    }

    // 非流式：先出「回复中」占位卡
    this.fallbackCardId = await this.transport.replyCard(
      this.replyToMessageId,
      buildReplyCard({
        key: this.key,
        runId: this.runId,
        status: "running",
        body: "",
      }),
    );
    debugLog("feishu.reply_card.started_static", {
      key: this.key,
      runId: this.runId,
      cardMessageId: this.fallbackCardId,
    });
  }

  updateFromEvent(_event: unknown) {
    // 不展示过程
  }

  append(delta: string) {
    if (this.status !== "running" || !delta) return;
    this.body += delta;
    // 长回答续卡：当前卡内容超限 → 关掉当前卡，开下一张继续
    if (this.cardkits.length > 0 && this.body.length > this.maxBodyChars) {
      const over = this.body.length - this.maxBodyChars;
      if (over > 2000) {
        // 超出的足够多才续卡（避免频繁开关卡）
        const current = this.cardkits[this.cardkits.length - 1];
        void current?.close(this.body.slice(0, this.maxBodyChars), "done")
          .catch(() => {});
        this.cardkits.push(this.newCardKit());
        this.body = this.body.slice(this.maxBodyChars);
        debugLog("feishu.reply_card.rollover", {
          key: this.key,
          cardIndex: this.cardkits.length,
        });
      }
    }
    const current = this.cardkits[this.cardkits.length - 1];
    current?.append(delta);
  }

  /** 新建一张 CardKit 流式卡（续卡复用） */
  private newCardKit(): CardKitStream {
    const cfg = loadConfig()!;
    return new CardKitStream(
      cfg.appId!,
      cfg.appSecret!,
      cfg.domain === "lark" ? "lark" : "feishu",
      this.replyToMessageId,
      async (text) => {
        // CardKit 失败：先尝试普通最终卡片，再失败则纯文本必达。
        try {
          const id = await this.transport.replyCard(
            this.replyToMessageId,
            buildReplyCard({
              key: this.key,
              runId: this.runId,
              status: "done",
              body: text,
            }),
          );
          this.fallbackCardId = id;
        } catch (cardError) {
          debugLog("feishu.reply_card.fallback_static_failed", {
            error: cardError instanceof Error ? cardError.message : String(cardError),
          });
          try {
            await this.transport.replyPlainText?.(this.replyToMessageId, text);
          } catch (textError) {
            debugLog("feishu.reply_card.fallback_text_failed", {
              error: textError instanceof Error ? textError.message : String(textError),
            });
          }
        }
      },
      {
        printFrequencyMs: this.streamOpts.printFrequencyMs,
        printStep: this.streamOpts.printStep,
        pushIntervalMs: this.streamOpts.pushIntervalMs,
        conversationKey: this.key,
        runId: this.runId,
        onOutboundMessageId: (id) => this.transport.rememberOutboundMessageId?.(id),
      },
    );
  }

  ensureFinal(text: string) {
    if (!text) return;
    if (!this.body.trim() || text.length >= this.body.length) this.body = text;
    for (const ck of this.cardkits) ck.ensureFinal(text);
  }

  async stopImmediately(note = "已停止") {
    await this.finishFinal("stopped", note);
  }

  async finish(status: Exclude<ReplyCardStatus, "running" | "inactive">, note?: string) {
    await this.finishFinal(status, note);
  }

  async completeWithAnswer(answer: string) {
    // 空 answer（模型只调工具没输出文本）：保留已流式内容，不覆盖
    const finalText = answer?.trim()
      ? answer
      : (this.body?.trim() ? this.body : "（没有生成内容，可能是模型只执行了工具调用）");
    this.ensureFinal(finalText);
    await this.finishFinal("done", this.buildFinalNote());
  }

  private async finishFinal(
    status: Exclude<ReplyCardStatus, "running" | "inactive">,
    note: string | undefined,
  ) {
    if (this.status !== "running") return;
    this.status = status;
    this.note = note ?? defaultFinalNote(status);

    if (this.cardkits.length > 0) {
      // 关闭所有卡：最后一张传完整 body + note，前面的传各自截断内容
      const lastIdx = this.cardkits.length - 1;
      for (let i = 0; i < lastIdx; i += 1) {
        await this.cardkits[i].close(undefined, status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done")
          .catch(() => {});
      }
      const last = this.cardkits[lastIdx];
      const finalStatus = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done";
      await last.close(
        // 最后一张卡的内容：续卡模式下 body 是最后一段；非续卡是全文
        this.body,
        finalStatus,
        // 只有单卡时才显示完整 note（耗时/token），多卡时第一张已带
        this.cardkits.length === 1 ? this.note : this.note,
      );
      return;
    }

    // 静态卡路径
    if (this.fallbackCardId) {
      try {
        await this.transport.updateCard(
          this.fallbackCardId,
          buildReplyCard({
            key: this.key,
            runId: this.runId,
            status,
            // done 也显示 note（耗时/token）—— 之前强制 undefined 丢掉了注记
            note: this.note,
            body: this.body,
          }),
        );
      } catch (error) {
        debugLog("feishu.reply_card.static_final_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
