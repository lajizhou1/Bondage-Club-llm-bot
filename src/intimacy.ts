/**
 * #47 亲密度双向情绪系统（2026-09-04）——怒气系统的正面镜像。
 *
 * 设计（用户三项拍板 2026-09-04 22:27）：
 * - 亲密度 = 长期关系，跨重启持久化（data/intimacy.json）；怒气 = 短期情绪，重启清零。
 *   两条轴独立共存：可以"生气但疼她"，也可以"心情好但照样严格"。
 * - 与怒气零数值耦合（不打折、不抵消），只影响台词风格和奖励行为。
 * - 溺爱档"软优先"：她的请求优先答应，但惩罚进行中/她犯错时仍可拒绝。
 *
 * 涨（走 #49 的 LLM 语义 flag 通道，怒气侧已有现成接线）——**对数形增长**（2026-09-04 22:40 用户拍板）：
 *   有效增量 = round(基础值 × 25 / (25 + 当前值))，当前值越高同一种行为涨得越少——
 *   熟络（25）很容易（约 3 次听话就到）、亲密（50）不难（再七八次）、溺爱（75）很难（还要近十次）。
 * - 服从/道歉/执行命令 +10（复用 serve_complied）
 * - 主动撒娇/亲近/夸奖 +8（新 serve_affectionate）
 * - 兑现了承诺 +8（complied 且承诺队列非空时结算）
 * 跌（固定数值，不随档位缩放；只记"伤信任"的行为——2026-09-04 22:40 用户拍板：要挟/纠缠只影响怒气，不动感情账）：
 * - 撒谎被抓包 -25 / 违背承诺 -15
 *
 * 无时间衰减：信任不随时间蒸发，只随行为变化。
 * 只给 LLM 离散标签（生疏/熟络/亲密/溺爱）+ 原因，绝不给数值。
 */

import * as fs from "fs";
import * as path from "path";
import type { MoodLevel } from "./anger";

export type AffectionLevel = "生疏" | "熟络" | "亲密" | "溺爱";

const CAP = 100;

let intimacy = 0;
let lastReason = "";

// ---------------------------------------------------------------------------
// 持久化（跨重启保留——用户拍板：感情不白培养）
// ---------------------------------------------------------------------------

const INTIMACY_FILE = path.resolve(process.cwd(), "data", "intimacy.json");

interface IntimacyFile {
  version: 1;
  value: number;
  updatedAt: string;
}

/** 启动时加载；文件不存在或损坏时从 0 开始（不 crash） */
export function load(): void {
  try {
    if (!fs.existsSync(INTIMACY_FILE)) {
      console.log("[intimacy] no saved file, starting at 0");
      return;
    }
    const raw = JSON.parse(fs.readFileSync(INTIMACY_FILE, "utf-8")) as IntimacyFile;
    intimacy = Math.max(0, Math.min(CAP, Math.round(Number(raw?.value) || 0)));
    console.log(`[intimacy] loaded: ${intimacy} [${affectionLevelOf(intimacy)}] (saved ${raw?.updatedAt})`);
  } catch (err) {
    console.error("[intimacy] load failed, starting at 0:", (err as Error).message);
    intimacy = 0;
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(INTIMACY_FILE), { recursive: true });
    const data: IntimacyFile = { version: 1, value: intimacy, updatedAt: new Date().toISOString() };
    fs.writeFileSync(INTIMACY_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[intimacy] save failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// 数值核心（镜像 anger.ts，但无衰减、无问话计时）
// ---------------------------------------------------------------------------

export function getIntimacy(): number {
  return Math.round(intimacy);
}

export function affectionLevelOf(v: number): AffectionLevel {
  if (v >= 75) return "溺爱";
  if (v >= 50) return "亲密";
  if (v >= 25) return "熟络";
  return "生疏";
}

export function getAffection(): { value: number; level: AffectionLevel; reason: string } {
  const v = Math.round(intimacy);
  return { value: v, level: affectionLevelOf(v), reason: lastReason };
}

export function setIntimacy(value: number, reason: string): void {
  const before = Math.round(intimacy);
  intimacy = Math.max(0, Math.min(CAP, value));
  lastReason = reason;
  const after = Math.round(intimacy);
  console.log(`[intimacy] ${before}→${after} (=set ${reason}) [${affectionLevelOf(after)}]`);
  save();
}

export function addIntimacy(base: number, reason: string): void {
  const before = Math.round(intimacy);
  const beforeLevel = affectionLevelOf(before);
  // 对数形增长：同一种行为，亲密度越高涨得越少（25/(25+当前) 系数）。
  //   实测曲线（听话+10 基础值）：0→10→17→22→26（熟络 3 次达）→…→50 需约 10 次→…→75 需约 20 次。
  //   下限 1：再高也至少 +1，只是极慢——溺爱要长期经营。
  const delta = Math.max(1, Math.round((base * 25) / (25 + intimacy)));
  intimacy = Math.min(CAP, intimacy + delta);
  lastReason = reason;
  const after = Math.round(intimacy);
  if (after !== before) {
    console.log(`[intimacy] ${before}→${after} (+${after - before} ${reason}, 对数系数) [${affectionLevelOf(after)}]`);
    if (affectionLevelOf(after) !== beforeLevel) {
      console.log(`[intimacy] tier change: ${beforeLevel} → ${affectionLevelOf(after)}`);
    }
    save();
  }
}

export function reduceIntimacy(delta: number, reason: string): void {
  const before = Math.round(intimacy);
  const beforeLevel = affectionLevelOf(before);
  intimacy = Math.max(0, intimacy - delta);
  const after = Math.round(intimacy);
  if (after !== before) {
    // 回落不覆盖"原因"（除非档位变了），让 LLM 仍知道刚才为什么亲近
    if (affectionLevelOf(after) !== beforeLevel) lastReason = reason;
    console.log(`[intimacy] ${before}→${after} (-${before - after} ${reason}) [${affectionLevelOf(after)}]`);
    if (affectionLevelOf(after) !== beforeLevel) {
      console.log(`[intimacy] tier change: ${beforeLevel} → ${affectionLevelOf(after)}`);
    }
    save();
  }
}

// ---------------------------------------------------------------------------
// 行为事件（index.ts 接线调用；数值见文件头设计说明）
// ---------------------------------------------------------------------------

/** 她服从/道歉/执行了命令（与怒气 -20 同一 flag 双向记账：气消了 + 心近了） */
export function noteServeComplied(): void {
  addIntimacy(10, "她听话了");
}

/** 她主动撒娇/亲近/夸奖（serve_affectionate） */
export function noteServeAffectionate(): void {
  addIntimacy(8, "她主动亲近你");
}

/** 她兑现了之前的承诺（complied 且承诺队列非空时结算） */
export function notePromiseKept(): void {
  addIntimacy(8, "她兑现了承诺");
}

/** 撒谎被抓包——伤的是信任，比怒气掉得更狠 */
export function noteServeLied(): void {
  reduceIntimacy(25, "她骗了你（信任受损）");
}

/** 违背承诺 */
export function noteBrokePromise(): void {
  reduceIntimacy(15, "她说话不算数");
}

// ---------------------------------------------------------------------------
// 奖励菜单（镜像 punishment.punishMenuFor：代码管"能做什么"，LLM 管"选哪个+说什么"）
// ---------------------------------------------------------------------------

/**
 * 各档位的奖励菜单文案。注入条件（index.ts 控制）：熟络及以上、非暴怒档、非测试模式。
 * 暴怒不宠（气头上亲密度再高也不发菜单——用户设计：怒气与亲密度只共存在台词里）。
 * mood 参数用于亲密档"放松"选项的档位限制提示。
 */
export function rewardMenuFor(level: AffectionLevel, mood: MoodLevel): string {
  switch (level) {
    case "熟络":
      return "口头夸奖（say——具体夸她做对的事，别空泛）、温柔的小玩笑（say）。还没到动手宠她的时候，继续攒";
    case "亲密":
      return "口头夸奖（say）、亲密动作（activity：Pet 摸头 / Kiss 轻吻 / Cuddle 贴贴 / Caress 轻抚 / MassageHands 按摩，要带部位 zone）、满足她的一个小请求、"
        + (mood === "平静"
          ? "主动放松一档束缚（item_adjust loosen_little——只有心情平静时才松，带情绪时管教优先）"
          : "（你正带着情绪，这轮先不松绑——管教优先，宠溺放到气消后）");
    case "溺爱":
      return "以上全部（夸奖 / 亲密动作 / 满足小请求 / 平静时放松一档），另外：主动给她戴她喜欢的东西当奖励（item_put：LeatherArmbinder variant=Strap 单手套、BallGag variant=Normal 口塞——她喜欢这些，是礼物不是惩罚，保持普通松紧千万别拉惩罚难度）、"
        + "给她上她最爱的数字密码锁（item_lock CombinationPadlock combination=6806——她常用的密码，随时能自己解开，纯享受）、当众夸她（say）。"
        + "软优先：她的请求优先答应（平时会逗一逗才给的事，现在大方给），但正在受罚或她犯了错时仍可拒绝——溺爱不是没原则";
    default:
      return "";
  }
}
