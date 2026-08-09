/**
 * 日报 / 伙伴 定时调度器。
 *
 * 运行在 daemon 进程内(pi-feishu-lark 常驻的那个),不依赖主进程。
 *
 * ## 为什么放这里
 *
 * 原来的日报/伙伴定时器在主进程的 extension 里(daily-report.ts / companion.ts),
 * 需要主进程常驻。现在把调度逻辑搬进 daemon:
 *
 *   daemon = 飞书连接 + 所有会话 + 定时器
 *   主进程 = 完全不需要(可以关掉)
 *
 * ## 注入目标:超级agent 会话
 *
 * 日报/伙伴直接在用户的 p2p 私聊会话(超级agent)里跑:
 *   key = `p2p:${open_id}`
 *   open_id 从配置的 report.open_id 读(不硬编码,换应用改配置一处)
 *
 * 用户在超级agent 会话里看日报、追问日报 —— 同一上下文,天然接得上。
 *
 * ## 触发时机
 *
 * 日报: 每天 9:30 触发一次(过了时间点兜底补发到 11:00)
 * 伙伴: 上次触发后随机 30~120 分钟
 *
 * 触发后 AI 自己读 SKILL.md、跑脚本、调 send_report.py 发送,
 * 调度器只负责「到点注入 prompt」,不参与生成和发送。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationManager } from "./conversation-manager.js";
import { debugLog } from "./debug.js";

const CHECK_INTERVAL_MS = 60_000;      // 每分钟检查一次
const DAILY_HOUR = 9;
const DAILY_MINUTE = 30;
const DAILY_DEADLINE_HOUR = 11;        // 过了 11 点当天不再补发
const DIGEST_HOUR = 6;
const DIGEST_MINUTE = 30;              // 每日记忆整理 06:30
const WEEKLY_HOUR = 20;
const WEEKLY_MINUTE = 0;               // 周报朋友来信 周日 20:00
const COMPANION_MIN_MS = 25 * 60_000;  // 伙伴最小间隔 25 分钟
const COMPANION_MAX_MS = 80 * 60_000; // 伙伴最大间隔 80 分钟

// 测试模式：环境变量覆盖触发时间，测完去掉即可恢复正式节奏。
//   KG_SCHED_DAILY_SECS=<秒>    启动后 N 秒触发一次日报
//   KG_SCHED_COMPANION_SECS=<秒> 启动后 N 秒触发一次伙伴
//   KG_SCHED_DIGEST_SECS=<秒>   启动后 N 秒触发一次记忆整理
const TEST_DAILY_SECS = Number(process.env.KG_SCHED_DAILY_SECS || 0);
const TEST_COMPANION_SECS = Number(process.env.KG_SCHED_COMPANION_SECS || 0);
const TEST_DIGEST_SECS = Number(process.env.KG_SCHED_DIGEST_SECS || 0);

const DAILY_PROMPT = [
  "日报时间。读 skills/kg-daily-report/SKILL.md 并完整按它执行。",
  "第一步先跑 should_send.py：退出码 1 就**安静结束**，",
  "不要输出任何东西也不要告诉我原因；退出码 0 才继续生成和推送。",
].join("");

const COMPANION_PROMPT = [
  "伙伴模式检查。读 skills/kg-companion/SKILL.md 并按它执行。",
  "第一步必须先跑 pulse.py --json：",
  "gate.can_talk 是 false 就**安静结束**，不要输出任何东西、",
  "不要解释原因、不要说「暂时没什么要聊的」。",
  "can_talk 是 true 也要自己判断值不值得开口 —— 没料就同样安静结束。",
].join("");

const DIGEST_PROMPT = [
  "每日记忆整理时间。这是内部任务，不需要发消息给用户。",
  "1. 跑 `python3 scripts/lib/storyline_tool.py digest --auto`",
  "2. 读生成的 narrative/episodes/昨天的.md，快速扫一眼昨天发生了什么",
  "3. 判断是否要推进/新建叙事线：",
  "   - 新episode延续已有线 → storyline_tool.py advance <id> <进展>",
  "   - 明显新主题且不归入任何线 → create",
  "   - 不要为琐碎细节建线，克制",
  "4. 结束。不主动发消息，不打扰。",
].join("");

const WEEKLY_PROMPT = [
  "周日到了，写本周的「朋友来信」。读 skills/kg-weekly-report/SKILL.md 并完整按它执行。",
  "这是一封懂他的朋友写的信，不是工作报告。",
  "写完用 send_report.py 发到私聊。",
].join("");

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastDailyDay = "";
  private lastDigestDay = "";
  private lastWeeklyDay = "";
  private lastCompanionAt = 0;
  private nextCompanionGapMs = 0;
  private running = false;
  private readonly startedAt = Date.now();
  private companionTestFired = false;
  private digestTestFired = false;

  constructor(private readonly conversations: ConversationManager) {}

  start() {
    if (this.timer) return;
    this.lastCompanionAt = Date.now();
    this.nextCompanionGapMs = this.randomGap();
    this.timer = setInterval(() => void this.tick().catch(() => {}), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    debugLog("feishu.scheduler.started", {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private randomGap(): number {
    return COMPANION_MIN_MS + Math.floor(Math.random() * (COMPANION_MAX_MS - COMPANION_MIN_MS));
  }

  /** 从配置拿超级agent 的会话 key。没有配置就跳过(不打扰)。 */
  private targetKey(): string | undefined {
    const openId = resolveOpenId();
    if (!openId) {
      debugLog("feishu.scheduler.no_target", {});
      return undefined;
    }
    return `p2p:${openId}`;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      // 本地日期(北京时间,进程时区)
      const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      // ── 测试模式：环境变量指定的秒数后触发（KG_SCHED_*_SECS）──
      const sinceStart = Date.now() - this.startedAt;
      if (TEST_DAILY_SECS > 0 && sinceStart >= TEST_DAILY_SECS * 1000 && this.lastDailyDay !== localDay) {
        this.lastDailyDay = localDay;
        await this.fireDaily();
        return;
      }
      if (TEST_COMPANION_SECS > 0 && sinceStart >= TEST_COMPANION_SECS * 1000 && !this.companionTestFired) {
        this.companionTestFired = true;
        await this.fireCompanion();
        return;
      }
      if (TEST_DIGEST_SECS > 0 && sinceStart >= TEST_DIGEST_SECS * 1000 && !this.digestTestFired) {
        this.digestTestFired = true;
        await this.fireDigest();
        return;
      }

      // ── 日报: 9:30 到 11:00 之间,每天一次 ──
      if (this.lastDailyDay !== localDay) {
        const h = now.getHours();
        const m = now.getMinutes();
        const inWindow = (h === DAILY_HOUR && m >= DAILY_MINUTE) ||
                         (h > DAILY_HOUR && h < DAILY_DEADLINE_HOUR) ||
                         (h === DAILY_DEADLINE_HOUR && m === 0);
        if (inWindow) {
          this.lastDailyDay = localDay;
          await this.fireDaily();
        }
      }

      // ── 每日记忆整理: 06:30,每天一次(内部任务,不打扰用户) ──
      if (this.lastDigestDay !== localDay) {
        const h = now.getHours();
        const m = now.getMinutes();
        if (h === DIGEST_HOUR && m >= DIGEST_MINUTE) {
          this.lastDigestDay = localDay;
          await this.fireDigest();
        }
      }

      // ── 周报朋友来信: 周日 20:00,每周一次 ──
      if (this.lastWeeklyDay !== localDay) {
        const h = now.getHours();
        const m = now.getMinutes();
        if (now.getDay() === 0 && h === WEEKLY_HOUR && m >= WEEKLY_MINUTE) {
          this.lastWeeklyDay = localDay;
          await this.fireWeekly();
        }
      }

      // ── 伙伴: 距上次超过随机间隔 ──
      if (Date.now() - this.lastCompanionAt >= this.nextCompanionGapMs) {
        this.lastCompanionAt = Date.now();
        this.nextCompanionGapMs = this.randomGap();
        await this.fireCompanion();
      }
    } finally {
      this.running = false;
    }
  }

  private async fireDaily() {
    const key = this.targetKey();
    if (!key) return;
    debugLog("feishu.scheduler.daily_fire", { key });
    try {
      // 每次新建干净上下文(日报是独立内容,不需要历史)
      await this.conversations.newConversation(key, async () => {});
      await this.conversations.prompt(key, DAILY_PROMPT, async () => {});
    } catch (e) {
      debugLog("feishu.scheduler.daily_error", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async fireWeekly() {
    const key = this.targetKey();
    if (!key) return;
    debugLog("feishu.scheduler.weekly_fire", { key });
    try {
      await this.conversations.newConversation(key, async () => {});
      await this.conversations.prompt(key, WEEKLY_PROMPT, async () => {});
    } catch (e) {
      debugLog("feishu.scheduler.weekly_error", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async fireDigest() {
    const key = this.targetKey();
    if (!key) return;
    debugLog("feishu.scheduler.digest_fire", { key });
    try {
      // 用干净上下文跑记忆整理（内部任务）
      await this.conversations.newConversation(key, async () => {});
      await this.conversations.prompt(key, DIGEST_PROMPT, async () => {});
    } catch (e) {
      debugLog("feishu.scheduler.digest_error", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async fireCompanion() {
    const key = this.targetKey();
    if (!key) return;
    debugLog("feishu.scheduler.companion_fire", { key });
    try {
      await this.conversations.prompt(key, COMPANION_PROMPT, async () => {});
    } catch (e) {
      debugLog("feishu.scheduler.companion_error", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** 从 kg-wiki-agent 的配置读 report.open_id。 */
function resolveOpenId(): string | undefined {
  // 优先环境变量(agent 脚本注入时方便覆盖)
  if (process.env.KG_REPORT_OPEN_ID) return process.env.KG_REPORT_OPEN_ID;
  // 默认从 ~/.kg-agent-config/config.json 读 report.open_id
  try {
    const cfgPath = join(homedir(), ".kg-agent-config", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const openId = cfg?.report?.open_id;
    if (typeof openId === "string" && openId) return openId;
  } catch {}
  return undefined;
}
