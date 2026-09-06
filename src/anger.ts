/**
 * #46 怒气情绪系统（MVP，2026-09-04 用户设计）
 *
 * 场景：BOT 作为 Dom 问服务对象"说，想要什么"，服务对象无视继续挣扎 —— 对人类而言
 * 这是冷暴力。BOT 需要能感知"被无视（≠被拒绝）"，并随怒气积累升级反应：
 * 语气加重 → 冷硬动作说话 → 硬惩罚。
 *
 * 设计约束（详见任务 #46 描述）：
 * - 怒气 0-95 封顶（不给 LLM 数值，只给离散标签：平静/微恼/恼火/暴怒）；
 * - 半衰期 15 分钟指数衰减；暴怒态（>=75）衰减加倍 = Dom 的"自我冷却"，不失态；
 * - "被无视"= 问话 30 秒无文字回应（挣扎/动作不算回应）→ +20；
 * - "被拒绝"（说不要/停）≠ 无视，不涨怒气（走原有 RP 分支）；
 * - 岔开话题（LLM 判定）= +10；服软/道歉/执行命令 = -20；正常发言互动 = -10；
 * - #49 扩展：纠缠讨价还价 = 阶梯 +10/+20/+30（5 分钟窗口累积，要挟式额外 +40）；
 *   撒谎被抓包 = +40；阳奉阴违（违背承诺）= +40；
 * - 一次提问最多记一次无视，不重复计费；
 * - 内存态：重启重置（不过夜记仇）；
 * - 怒气只影响语气和 item 级动作，绝不触发 ownership 变更（关系层与情绪层隔离）。
 */

export type MoodLevel = "平静" | "微恼" | "恼火" | "暴怒";

/** 怒气上限（不到 100：封顶后 LLM 行为会彻底失控，95 留缓冲） */
const CAP = 95;
/** 每分钟衰减系数：0.955^15 ≈ 0.5（半衰期 15 分钟） */
const DECAY_PER_MIN = 0.955;
/** 问话被无视的判定窗口（毫秒）：提问后 30 秒无文字回应 = 无视 */
const IGNORE_WINDOW_MS = 30_000;

let anger = 0;
let lastReason = "";
/** BOT 最近一次"问话/命令式提问"，用于无视判定；服务对象一发话即清除 */
let pendingQuestion: { text: string; askedAt: number } | null = null;
/** 服务对象最近一次发文字的时间（Chat/Whisper；挣扎/动作不算） */
let lastServeChatAt = 0;

export function getAnger(): number {
  return Math.round(anger);
}

export function moodLevelOf(a: number): MoodLevel {
  if (a >= 75) return "暴怒";
  if (a >= 50) return "恼火";
  if (a >= 25) return "微恼";
  return "平静";
}

export function getMood(): { anger: number; level: MoodLevel; reason: string } {
  const a = Math.round(anger);
  return { anger: a, level: moodLevelOf(a), reason: lastReason };
}

/** BOT 说了带问句/命令式提问的话 → 开始无视倒计时 */
export function noteBotQuestion(text: string): void {
  pendingQuestion = { text, askedAt: Date.now() };
}

/** 服务对象发了文字（Chat/Whisper）→ 清除无视计时 */
export function noteServeChat(): void {
  lastServeChatAt = Date.now();
  pendingQuestion = null;
}

export function addAnger(delta: number, reason: string): void {
  const before = Math.round(anger);
  anger = Math.min(CAP, anger + delta);
  lastReason = reason;
  const after = Math.round(anger);
  if (after !== before) {
    console.log(`[mood] anger ${before}→${after} (+${after - before} ${reason}) [${moodLevelOf(after)}]`);
    fireLevelChange(moodLevelOf(before), moodLevelOf(after));
  }
}

export function relieveAnger(delta: number, reason: string): void {
  const before = Math.round(anger);
  anger = Math.max(0, anger - delta);
  const after = Math.round(anger);
  if (after !== before) {
    // 回落不覆盖"原因"（除非等级变了），让 LLM 仍知道刚才为什么生气
    if (moodLevelOf(after) !== moodLevelOf(before)) lastReason = reason;
    console.log(`[mood] anger ${before}→${after} (-${before - after} ${reason}) [${moodLevelOf(after)}]`);
    fireLevelChange(moodLevelOf(before), moodLevelOf(after));
  }
}

// ---------------------------------------------------------------------------
// #48：档位变化回调（index.ts 注册 → 降档时清惩罚状态/结束冷处理）
// ---------------------------------------------------------------------------

type LevelChangeCb = (from: MoodLevel, to: MoodLevel) => void;
let levelChangeCb: LevelChangeCb | null = null;

export function onMoodLevelChange(cb: LevelChangeCb): void {
  levelChangeCb = cb;
}

function fireLevelChange(from: MoodLevel, to: MoodLevel): void {
  if (from !== to && levelChangeCb) levelChangeCb(from, to);
}

/**
 * #48-B 测试口令：直接设定怒气值（仅测试模式，由 index.ts 调用；
 * 执行后 index.ts 负责关闭测试模式并公告）。
 */
export function setAnger(value: number, reason: string): void {
  const before = Math.round(anger);
  anger = Math.max(0, Math.min(CAP, value));
  lastReason = reason;
  const after = Math.round(anger);
  console.log(`[mood] anger ${before}→${after} (=set ${reason}) [${moodLevelOf(after)}]`);
  fireLevelChange(moodLevelOf(before), moodLevelOf(after));
}

/** LLM 语义判定：服务对象回了话，但明显岔开/无视 BOT 的上一句 → +10 */
export function noteServeDeflected(): void {
  addAnger(10, "回应里岔开话题（LLM 判定）");
}

/** LLM 语义判定：服软/道歉/执行命令 → -20 */
export function noteServeComplied(): void {
  relieveAnger(20, "她服软/道歉/执行了命令");
}

// ---------------------------------------------------------------------------
// #49 三种新触发（纠缠要挟 / 撒谎被抓包 / 阳奉阴违）
// ---------------------------------------------------------------------------

/** 纠缠计数器窗口：5 分钟内重复纠缠才累积，超时清零重新起算 */
const PESTER_WINDOW_MS = 5 * 60_000;
/** 纠缠阶梯：第 1/2/3+ 次的怒气增量（2026-09-04 19:04 用户调参：加重惩罚力度） */
const PESTER_LADDER = [10, 20, 30];
let pesterCount = 0;
let lastPesterAt = 0;

/**
 * LLM 语义判定：她重复讨价还价（纠缠求解开束缚等 BOT 已拒绝的事）。
 * 5 分钟窗口内阶梯式累积：+10 / +20 / +30。要挟式表达额外 +40。
 */
export function noteServePestering(threatening: boolean): void {
  const now = Date.now();
  if (now - lastPesterAt > PESTER_WINDOW_MS) pesterCount = 0;
  pesterCount += 1;
  lastPesterAt = now;
  const step = PESTER_LADDER[Math.min(pesterCount - 1, PESTER_LADDER.length - 1)];
  const reason = `纠缠讨价还价（第 ${pesterCount} 次${threatening ? "，带要挟" : ""}）`;
  addAnger(step + (threatening ? 40 : 0), reason);
  // 纠缠同时也是一种"有回应"，清除问话无视计时，避免同一行为双重计费
  pendingQuestion = null;
}

/** LLM 语义判定：她说的话与 BOT 已知状态矛盾（撒谎被抓包）→ +40（欺骗比无视更重） */
export function noteServeLied(): void {
  addAnger(40, "撒谎被抓包（说法与已知状态矛盾）");
}

/** LLM 语义判定：违背了明确答应过的事（阳奉阴违）→ +40 */
export function noteServeBrokePromise(): void {
  addAnger(40, "阳奉阴违（违背了答应过的事）");
}

/** 每 60 秒调用：指数衰减；暴怒态系数平方 = 自我冷却 */
export function tickDecay(): void {
  if (anger <= 0) {
    anger = 0;
    return;
  }
  const before = Math.round(anger);
  const factor = anger >= 75 ? DECAY_PER_MIN * DECAY_PER_MIN : DECAY_PER_MIN;
  anger = anger * factor;
  if (anger < 1) anger = 0;
  const after = Math.round(anger);
  if (after !== before && moodLevelOf(after) !== moodLevelOf(before)) {
    console.log(`[mood] anger decayed ${before}→${after} [${moodLevelOf(after)}]`);
    fireLevelChange(moodLevelOf(before), moodLevelOf(after));
  }
}

/**
 * 每 5 秒调用：检查"问话被无视"。
 * 返回被无视的问话文本（触发方应记 [情绪] 行并让 BOT 表达不满），无事件返回 null。
 * 一次提问最多记一次无视（记完即清），不会反复计费。
 */
export function checkIgnoredQuestion(): string | null {
  if (!pendingQuestion) return null;
  const now = Date.now();
  // 服务对象在提问之后发过文字 → 不算无视
  if (lastServeChatAt > pendingQuestion.askedAt) {
    pendingQuestion = null;
    return null;
  }
  if (now - pendingQuestion.askedAt < IGNORE_WINDOW_MS) return null;
  const q = pendingQuestion.text;
  pendingQuestion = null;
  addAnger(20, "问话被无视（30 秒无回应）");
  return q;
}

/** 重置（测试用 / 手动清怒气） */
export function resetAnger(): void {
  anger = 0;
  lastReason = "";
  pendingQuestion = null;
}

/**
 * 判断 BOT 的发言是否是"问话/命令式提问"（触发无视倒计时的条件）。
 * 覆盖：疑问句结尾 + 命令式让对方开口的话术。
 */
const QUESTION_RE = /[?？]\s*$|说，|说！|告诉我|回答我|说清楚|说说看|想要什么|为什么呢/;
export function looksLikeQuestion(text: string): boolean {
  return QUESTION_RE.test(text.trim());
}
