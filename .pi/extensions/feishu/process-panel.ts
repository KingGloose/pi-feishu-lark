/**
 * 思考过程面板：把工具调用 + 推理轮次渲染成一张可折叠卡（collapsible_panel）。
 *
 * 思路移植自 pi-feishu-bridge 的 tool-tracker + card-renderer：
 * - 工具步骤状态机（running / success / error），参数脱敏 + 人类可读格式化
 * - 推理轮次按出现顺序与工具交替排成时间线
 * - 默认折叠，用户可展开查看过程
 *
 * 渲染目标：飞书 interactive 卡（1.0 schema），支持 div / lark_md / collapsible_panel。
 */

// ───────────────────────────────────────────── 脱敏

const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|cookie|credential|bearer/i;
const SECRET_VALUE =
  /(authorization\s*[:=]\s*|bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      result[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE, "$1[redacted]").slice(0, 500);
  return value;
}

function clip(text: string, limit: number): string {
  const oneLine = text.replace(/\r\n/g, "\n").replace(/[\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function shortenPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function pathOf(args: Record<string, unknown>): string {
  const raw = args.path ?? args.file_path ?? args.filePath ?? "";
  return shortenPath(String(raw || ""));
}

/** 工具参数 → 人类可读一行（bash 显示命令、read/write 显示路径） */
export function formatToolDetail(name: string, args: unknown, detailLimit = 500): string {
  try {
    const clean = sanitize(args);
    if (typeof clean === "string") return clip(clean, detailLimit);
    const obj = asRecord(clean);
    if (!obj) return clip(JSON.stringify(clean), detailLimit);

    const tool = name.toLowerCase();
    switch (tool) {
      case "bash":
      case "shell":
      case "run": {
        const cmd = String(obj.command ?? obj.cmd ?? "").trim();
        return clip(cmd || JSON.stringify(obj), detailLimit);
      }
      case "read": {
        const path = pathOf(obj);
        const offset = obj.offset;
        const limit = obj.limit;
        if (offset !== undefined || limit !== undefined) {
          const start = offset ?? 1;
          const end = limit !== undefined ? Number(start) + Number(limit) - 1 : "";
          return clip(`${path}:${start}${end !== "" ? `-${end}` : ""}`, detailLimit);
        }
        return clip(path || JSON.stringify(obj), detailLimit);
      }
      case "write":
      case "edit": {
        return clip(pathOf(obj) || JSON.stringify(obj), detailLimit);
      }
      case "grep":
      case "rg": {
        const pattern = String(obj.pattern ?? obj.query ?? "");
        const path = pathOf(obj) || String(obj.path ?? ".");
        return clip(`${pattern ? `/${pattern}/` : ""} ${path}`.trim() || JSON.stringify(obj), detailLimit);
      }
      case "find":
      case "ls": {
        const path = pathOf(obj) || String(obj.path ?? ".");
        const pattern = obj.pattern != null ? String(obj.pattern) : "";
        return clip(pattern ? `${path} ${pattern}` : path, detailLimit);
      }
      default: {
        if (typeof obj.command === "string" && obj.command.trim()) {
          return clip(String(obj.command), detailLimit);
        }
        if (pathOf(obj)) return clip(pathOf(obj), detailLimit);
        const pairs: string[] = [];
        for (const [key, item] of Object.entries(obj).slice(0, 6)) {
          if (item == null) continue;
          if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
            pairs.push(`${key}=${item}`);
          } else {
            pairs.push(`${key}=…`);
          }
        }
        return clip(pairs.join(" ") || JSON.stringify(obj), detailLimit);
      }
    }
  } catch {
    return clip(String(args), detailLimit);
  }
}

/** 工具返回 → 最有用的文本一行 */
export function formatToolOutput(result: unknown, outputLimit = 800): string {
  try {
    const clean = sanitize(result);
    if (typeof clean === "string") return clip(clean, outputLimit);
    if (clean == null) return "";
    const obj = asRecord(clean);
    if (obj) {
      if (typeof obj.text === "string") return clip(obj.text, outputLimit);
      if (typeof obj.output === "string") return clip(obj.output, outputLimit);
      if (typeof obj.message === "string") return clip(obj.message, outputLimit);
      if (typeof obj.error === "string") return clip(obj.error, outputLimit);
      const content = obj.content;
      if (typeof content === "string") return clip(content, outputLimit);
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === "string" && item.trim()) return clip(item, outputLimit);
          if (item && typeof item === "object") {
            const text = (item as any).text;
            if (typeof text === "string" && text.trim()) return clip(text, outputLimit);
          }
        }
      }
    }
    return clip(JSON.stringify(clean), outputLimit);
  } catch {
    return clip(String(result), outputLimit);
  }
}

// ───────────────────────────────────────────── 状态机

export type ToolStatus = "running" | "success" | "error";

export interface ToolStep {
  toolCallId: string;
  name: string;
  status: ToolStatus;
  detail: string;
  output: string;
  startedAt: number;
  elapsedMs: number;
}

export class ProcessPanel {
  /** 时间线：推理轮次与工具交替出现 */
  private events: Array<
    | { type: "thinking"; index: number }
    | { type: "tool"; toolCallId: string }
  > = [];
  private thinkingRounds: string[] = [];
  private currentThinking = "";
  private tools = new Map<string, ToolStep>();
  private toolOrder: string[] = [];
  private startTime = Date.now();

  // 渲染参数
  private readonly detailLimit: number;
  private readonly outputLimit: number;
  private readonly reasoningLimit: number;
  private readonly maxToolSteps: number;
  private readonly maxThinkingRounds: number;

  constructor(options?: {
    detailLimit?: number;
    outputLimit?: number;
    reasoningLimit?: number;
    maxToolSteps?: number;
    maxThinkingRounds?: number;
  }) {
    this.detailLimit = options?.detailLimit ?? 500;
    this.outputLimit = options?.outputLimit ?? 800;
    this.reasoningLimit = options?.reasoningLimit ?? 1500;
    this.maxToolSteps = options?.maxToolSteps ?? 20;
    this.maxThinkingRounds = options?.maxThinkingRounds ?? 20;
  }

  /** 事件入口：session.subscribe 的事件喂进来 */
  onEvent(event: any): boolean {
    if (!event || typeof event !== "object") return false;
    switch (event.type) {
      case "tool_execution_start": {
        const id = String(event.toolCallId || "");
        if (!id) return false;
        this.startTool(id, String(event.toolName || "tool"), event.args);
        return true;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId || "");
        if (!id || !this.tools.has(id)) return false;
        this.updateTool(id, event.partialResult);
        return true;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId || "");
        if (!id || !this.tools.has(id)) return false;
        this.endTool(id, event.result, Boolean(event.isError));
        return true;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent;
        // 推理/思考文本（非正式回答）→ 计入当前推理轮
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string" && ame.delta) {
          this.appendThinking(ame.delta);
          return true;
        }
        return false;
      }
      case "thinking_flush": {
        this.finishThinking();
        return true;
      }
      default:
        return false;
    }
  }

  private startTool(id: string, name: string, args: unknown) {
    if (!this.tools.has(id)) {
      this.toolOrder.push(id);
      this.events.push({ type: "tool", toolCallId: id });
    }
    this.tools.set(id, {
      toolCallId: id,
      name,
      status: "running",
      detail: formatToolDetail(name, args, this.detailLimit),
      output: "",
      startedAt: Date.now(),
      elapsedMs: 0,
    });
  }

  private updateTool(id: string, result: unknown) {
    const step = this.tools.get(id);
    if (!step) return;
    const output = formatToolOutput(result, this.outputLimit);
    if (output) step.output = output;
  }

  private endTool(id: string, result: unknown, isError: boolean) {
    const step = this.tools.get(id);
    if (!step) return;
    step.status = isError ? "error" : "success";
    step.elapsedMs = Date.now() - step.startedAt;
    const output = formatToolOutput(result, this.outputLimit);
    if (output) step.output = output;
  }

  private appendThinking(delta: string) {
    this.currentThinking += delta;
    if (this.currentThinking.length > this.reasoningLimit * 2) {
      // 防止无限累积；渲染时仍会截断
      this.currentThinking = this.currentThinking.slice(0, this.reasoningLimit * 2);
    }
  }

  /** 一轮推理结束（text_delta 之后） */
  finishThinking() {
    if (!this.currentThinking.trim()) return;
    this.thinkingRounds.push(this.currentThinking.trim());
    this.events.push({ type: "thinking", index: this.thinkingRounds.length - 1 });
    this.currentThinking = "";
  }

  get isDirty(): boolean {
    return true; // 调用方自行决定节流
  }

  hasContent(): boolean {
    return this.thinkingRounds.length > 0 || this.currentThinking.trim().length > 0 || this.toolOrder.length > 0;
  }

  /** 渲染成 collapsible_panel 元素 */
  render(expanded = true): Record<string, unknown> {
    const children: Record<string, unknown>[] = [];
    const visibleTools = new Set(this.toolOrder.slice(-this.maxToolSteps));
    const thinkingStart = Math.max(0, this.thinkingRounds.length - this.maxThinkingRounds);

    const hiddenTools = this.toolOrder.length - visibleTools.size;
    if (hiddenTools > 0) {
      children.push(notationLine(`⚡ 早期 ${hiddenTools} 个工具步骤已折叠`));
    }
    if (thinkingStart > 0) {
      children.push(notationLine(`💭 早期 ${thinkingStart} 轮推理已折叠`));
    }

    for (const ev of this.events) {
      if (ev.type === "thinking") {
        if (ev.index < thinkingStart) continue;
        const body = this.thinkingRounds[ev.index] ?? "";
        children.push(...buildThinkingElements(ev.index + 1, body, this.reasoningLimit));
      } else if (ev.type === "tool") {
        if (!visibleTools.has(ev.toolCallId)) continue;
        const step = this.tools.get(ev.toolCallId);
        if (step) children.push(...buildToolElements(step, this.detailLimit, this.outputLimit));
      }
    }

    if (this.currentThinking.trim()) {
      children.push(
        ...buildThinkingElements(this.thinkingRounds.length + 1, this.currentThinking.trim(), this.reasoningLimit),
      );
    }

    if (children.length === 0) {
      children.push(notationLine("正在处理…"));
    }

    const toolCount = this.toolOrder.length;
    const rounds = this.thinkingRounds.length + (this.currentThinking.trim() ? 1 : 0);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    return {
      tag: "collapsible_panel",
      expanded,
      header: {
        title: {
          tag: "plain_text",
          content: `Agent loop · ${rounds} 轮推理 · ${toolCount} 个工具 · ${elapsed}s`,
          text_size: "notation",
        },
      },
      border: { color: "grey", corner_radius: "5px" },
      vertical_spacing: "4px",
      padding: "8px 8px 8px 8px",
      elements: children,
    };
  }
}

// ───────────────────────────────────────────── 渲染辅助

function notationLine(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content }, text_size: "notation" };
}

function mdTitle(content: string, color?: string): Record<string, unknown> {
  return {
    tag: "div",
    text: { tag: "lark_md", content },
    ...(color ? { text_color: color } : {}),
  };
}

function mdIndented(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content }, text_indent: "0em" };
}

function statusIcon(status: ToolStatus): string {
  return status === "running" ? "🔄" : status === "success" ? "✓" : "✗";
}

function statusColor(status: ToolStatus): string {
  return status === "error" ? "red" : status === "running" ? "grey" : "green";
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

function truncate(text: string, limit: number, ellipsis = true): string {
  if (text.length <= limit) return text;
  return ellipsis ? `${text.slice(0, limit)}…` : text.slice(0, limit);
}

function buildToolElements(
  step: ToolStep,
  detailLimit: number,
  outputLimit: number,
): Record<string, unknown>[] {
  const elapsed = step.elapsedMs ? ` · ${(step.elapsedMs / 1000).toFixed(1)}s` : "";
  const out: Record<string, unknown>[] = [
    mdTitle(`${statusIcon(step.status)} ${escapeMd(step.name)}${elapsed}`, statusColor(step.status)),
  ];
  if (step.detail.trim()) {
    out.push(mdIndented(truncate(step.detail, detailLimit, true)));
  }
  if (step.output.trim()) {
    out.push(mdIndented(truncate(step.output, outputLimit, true)));
  }
  return out;
}

function buildThinkingElements(
  index: number,
  text: string,
  reasoningLimit: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [mdTitle(`💭 推理 ${index}`)];
  if (text.trim()) {
    out.push(mdIndented(truncate(text, reasoningLimit, true)));
  }
  return out;
}
