/**
 * #48 阶梯惩罚库（2026-09-04）
 *
 * 设计原则（对齐用户拍板的三项决策 + 今日实战教训）：
 * - 惩罚菜单按怒气档位分三档；暴怒含长时锁（TimerPasswordPadlock ≤4h——wire 定时可靠，
 *   2026-09-05 查证：RemoveTimer 资产字段只是 UI 默认初始时长，BOT 发的时长接收端原样尊重；
 *   到点由佩戴者客户端自动开锁，天然防"锁死人"，是安全特性）。
 * - 新鲜感约束 = **最近 2 次**惩罚动作内不重复（不是"相邻"——19:42 事故是收紧→牵绳→收紧，
 *   相邻不同拦不住，最近 2 次内不重复才能拦住）。
 * - 暴怒禁止清单：气头上不做关系级/心软动作（解 OwnerLock / ownership / 逐出是唯一允许的"放"）。
 * - 真冷处理：暴怒档 LLM 可输出 cold_treatment 动作 → 代码层真沉默 N 轮（不调 LLM），
 *   服软累计 2 次 / 轮数到 / 超时 / 安全词 → 破冰。
 * - 怒气降档 = 惩罚状态全部清零（高压立刻停止，配合服软 -20 的和解路径）。
 *
 * 分层：代码管"能做什么"（菜单+约束+禁止清单），LLM 管"选哪个+说什么"。
 */

import type { MoodLevel } from "./anger";

/** 惩罚动作种类（新鲜感约束的粒度） */
export type PunishKind =
  | "bind" // 上束缚（item_put 束缚道具——她身上没东西时，这是其他惩罚的前提）
  | "tighten" // 收紧（item_adjust tighten 方向）
  | "lock-short" // 短时锁（TimerPadlock 5min 级）
  | "lock-long" // 长时锁（TimerPasswordPadlock ≤4h）
  | "gag" // 禁言（口球 item_put）
  | "cold" // 冷处理（cold_treatment）
  | "expel"; // 逐出话术（放绳 + 让她走）

/** 最近 N 条惩罚记录（新鲜感窗口 = 最近 2 次内不重复） */
const FRESHNESS_WINDOW = 2;
const recentPunishments: PunishKind[] = [];

/** 记录一次已执行的惩罚动作（executeIntent 执行成功后调用） */
export function recordPunishment(kind: PunishKind): void {
  recentPunishments.push(kind);
  while (recentPunishments.length > 4) recentPunishments.shift();
  console.log(`[punish] recorded: ${kind} (recent: ${recentPunishments.join(" -> ")})`);
}

/** 新鲜感校验：该种类惩罚最近 2 次内没被用过才允许 */
export function canPunish(kind: PunishKind): boolean {
  const lastN = recentPunishments.slice(-FRESHNESS_WINDOW);
  if (lastN.includes(kind)) {
    console.log(`[punish] ${kind} blocked by freshness (recent: ${recentPunishments.join(" -> ")})`);
    return false;
  }
  return true;
}

/** 怒气降档时清空惩罚记录（高压停止，惩罚预算归零） */
export function resetPunishments(): void {
  if (recentPunishments.length) {
    console.log(`[punish] reset (mood lowered): cleared ${recentPunishments.join(", ")}`);
  }
  recentPunishments.length = 0;
}

// ---------------------------------------------------------------------------
// 惩罚菜单（注入 prompt：LLM 只能从当前档位的菜单里挑惩罚）
// ---------------------------------------------------------------------------

/**
 * 各档位惩罚菜单文案（给 LLM 的"能做什么"清单）。
 * hasRestraint = 服务对象当前身上是否有束缚道具——
 *   2026-09-04 21:40 用户指出：没束缚时"收紧/上锁"全是空话，菜单必须先给"戴道具"选项。
 *   道具推荐只列白名单内的（TYPED 道具必须带 variant，否则接收方静默回滚到无效变体）。
 */
export function punishMenuFor(level: MoodLevel, hasRestraint: boolean): string {
  if (!hasRestraint) {
    // 她身上没有任何束缚——收紧/上锁无从执行，第一惩罚选项是"给她戴上"
    switch (level) {
      case "微恼":
        return "她身上现在没有任何束缚道具——收紧和上锁都无从执行。可用：口头警告（纯 say），或直接给她戴上轻度束缚（item_put：LeatherCuffs variant=Wrist 腕缚、或 LeatherBlindfold 眼罩）作为惩罚的起点";
      case "恼火":
        return "她身上现在没有任何束缚道具——收紧和上锁都无从执行。可用：口头最后通牒（say）、或给她上束缚作为惩罚（item_put：BallGag variant=Normal 禁言、HempRope_Arms 绑手、LeatherCuffs variant=Wrist、或 LeatherArmbinder variant=Strap 单手套加肩带）。只能选一样。戴上后扬言她再犯就上锁/收紧";
      case "暴怒":
        return "她身上现在没有任何束缚道具——长时锁无从执行。可用：给她上重束缚（item_put：LeatherArmbinder variant=Strap 单手套加肩带、LeatherCuffs variant=Hogtie 驷马缚、或 HempRope_Arms + 麻绳），台词里直说『下次再犯就锁上』——道具是下一步上锁的本钱；或真冷处理（cold_treatment）；或逐出话术（leash_release + 明确让她自己走）。暴怒时绝不心软：不解锁、不松绑、不哄——除非她喊安全词";
      default:
        return "（平静档：无惩罚可用。用宠溺和引导对待她的小调皮即可）";
    }
  }
  switch (level) {
    case "微恼":
      return "口头警告（纯 say，点明她的错误并给出警告）或收紧一档（item_adjust tighten_little）";
    case "恼火":
      return "口头最后通牒（『这是最后一次警告』式，say）、收紧大档（item_adjust tighten_lot）、短时惩罚锁（item_lock TimerPadlock timerMin=5）、禁言（item_put BallGag variant=Normal——她再吵就用嘴球让她安静）、或给她再加一件束缚（item_put 束缚类道具， escalation 升级）。只能选一样，不可叠加";
    case "暴怒":
      return "执行预告过的惩罚，不再解释：长时惩罚锁（item_lock TimerPasswordPadlock timerMin≤240，须给 password）、给她上重束缚（item_put：LeatherArmbinder variant=Strap / LeatherCuffs variant=Hogtie——之后随时可锁）、真冷处理（输出 cold_treatment 动作——接下来几轮你会真的沉默不理她，直到她服软或时间到）、或逐出话术（leash_release + 明确让她自己走）。暴怒时绝不心软：不解锁、不松绑、不哄——除非她喊安全词";
    default:
      return "（平静档：无惩罚可用。用宠溺和引导对待她的小调皮即可）";
  }
}

// ---------------------------------------------------------------------------
// 暴怒禁止清单（执行层硬校验）
// ---------------------------------------------------------------------------

/**
 * 暴怒档禁止动作校验。
 * 返回 true = 该动作在暴怒档被禁止（执行层应静默降级为纯 say）。
 * 禁止内容：解任何锁 / 移除道具 / 放松紧度 / ownership 动作——"绝不心软"的代码层兜底。
 *   2026-09-04 21:10 实测缺口：暴怒 84 时 LLM（看到的是微恼旧档）走死锁阀 item_remove
 *   解开了惩罚锁的单手套——死锁阀是 prompt 级规则，代码层只认安全词/次数券这些更高层的出口。
 * 安全词与拒绝次数券在更上层处理（安全词直接 triggerAftercare，不走 executeIntent 校验），
 * 因此不受此清单影响。
 */
export function isFuryForbidden(action: string, lock?: string, adjust?: string): boolean {
  if (action === "ownership_propose") return true; // 情绪上头不做关系级决定
  if (action === "item_unlock") return true; // 暴怒不解任何锁（含 OwnerLock；定时锁等到期或降档后解）
  if (action === "item_remove") return true; // 暴怒不松绑（item_remove 的自动解锁路径也一并堵住）
  if (action === "item_adjust" && adjust && adjust.startsWith("loosen")) return true; // 暴怒不放松紧度
  return false;
}

// ---------------------------------------------------------------------------
// 冷处理状态机（暴怒档真沉默）
// ---------------------------------------------------------------------------

const COLD_MAX_ROUNDS = 3; // 她最多被冷 3 轮发言
const COLD_TIMEOUT_MS = 2 * 60_000; // 或 2 分钟，先到为准
const COLD_SOFTEN_THRESHOLD = 2; // 累计服软 2 次 → 提前破冰

/** 服软检测正则（冷处理中不调 LLM，用确定性文本匹配） */
const COLD_SOFTEN_RE = /对不起|抱歉|我错|别生气|原谅|我服|听你的|我乖|不敢了|投降|别不理|求你|我听话|不闹了|安静了|乖了/;

let coldState: { startedAt: number; rounds: number; softened: number } | null = null;
/** 最近一次冷处理的破冰摘要（破冰后注入 recentChat，让 LLM 知道刚才发生了什么） */
let lastColdSummary = "";

/** 进入冷处理（executeIntent 处理 cold_treatment 动作时调用） */
export function startColdTreatment(): void {
  coldState = { startedAt: Date.now(), rounds: 0, softened: 0 };
  console.log(`[punish] cold treatment STARTED (max ${COLD_MAX_ROUNDS} rounds or ${COLD_TIMEOUT_MS / 1000}s)`);
}

export function isColdTreating(): boolean {
  return coldState !== null;
}

/**
 * 冷处理期间她发了一次言。
 * 返回 "continue"（继续冷）/ "break"（破冰，调用方应触发 respond 让 BOT 开口）。
 */
export function noteColdRound(content: string): "continue" | "break" {
  if (!coldState) return "break";
  coldState.rounds += 1;
  const elapsed = Date.now() - coldState.startedAt;

  // 服软累计（不限连续——冷处理里她插科打诨一句再服软也算累计）
  if (COLD_SOFTEN_RE.test(content)) {
    coldState.softened += 1;
    console.log(`[punish] cold soften ${coldState.softened}/${COLD_SOFTEN_THRESHOLD}: "${content.slice(0, 30)}"`);
    if (coldState.softened >= COLD_SOFTEN_THRESHOLD) {
      endColdTreatment("她累计服软 2 次");
      return "break";
    }
  }

  if (coldState.rounds >= COLD_MAX_ROUNDS || elapsed >= COLD_TIMEOUT_MS) {
    endColdTreatment(coldState.rounds >= COLD_MAX_ROUNDS ? "轮数到" : "时间到");
    return "break";
  }
  console.log(`[punish] cold round ${coldState.rounds}/${COLD_MAX_ROUNDS} (soften ${coldState.softened}/${COLD_SOFTEN_THRESHOLD})`);
  return "continue";
}

/** 结束冷处理（破冰/怒气降档/安全词/BOT 重启均会触发） */
export function endColdTreatment(reason: string): void {
  if (coldState) {
    const secs = Math.round((Date.now() - coldState.startedAt) / 1000);
    console.log(`[punish] cold treatment ENDED (${reason}; lasted ${secs}s, ${coldState.rounds} rounds)`);
    lastColdSummary = `你对她冷处理了 ${secs} 秒，期间她说了 ${coldState.rounds} 轮话、服软 ${coldState.softened} 次（结束原因：${reason}）。`;
  }
  coldState = null;
}

/** 取走最近一次冷处理的破冰摘要（读后清空，避免重复注入） */
export function takeLastColdSummary(): string {
  const s = lastColdSummary;
  lastColdSummary = "";
  return s;
}

/** 冷处理状态描述（注入 prompt，让破冰后的 LLM 知道刚才发生了什么） */
export function coldDescription(): string {
  if (!coldState) return "";
  const elapsed = Math.round((Date.now() - coldState.startedAt) / 1000);
  return `你正在对她冷处理中（已沉默 ${elapsed} 秒 / 她说了 ${coldState.rounds} 轮话 / 服软 ${coldState.softened}/${COLD_SOFTEN_THRESHOLD} 次）。冷处理期间你不回应、不解释——让她自己反省。`;
}
