// ===========================================================================
// #16-C 束缚套装快照（outfit.ts）
// ---------------------------------------------------------------------------
// 设计（2026-09-05 用户拍板）：#16 限时回家的束缚由用户亲自设计（变体/颜色等），
// BOT 只负责记住。流程：用户在游戏内亲手给服务对象穿好一身 → 说"记住这身" →
// BOT 把当时的束缚外观（道具+变体+颜色+松紧）存档 → 游戏开局按档原样重穿+统一上锁。
//
// 技术要点：
//  - 快照来源是外观缓存（bundle 语义：Difficulty 为绝对值，Color/Property 原样）
//  - 存档剥离锁字段（ALL_LOCK_PROPERTIES + Effect 里的 "Lock"）——锁由游戏规则
//    统一上（OwnerTimerPadlock 限时+缓冲），不随快照复活旧锁
//  - 重穿不经过 ITEM_SKILLS 白名单：快照条目是用户亲手穿戴的事实数据，
//    天然合法（白名单是给 LLM 随机输出兜底的，不是给用户设计绑的）
//  - 可上锁判定用 data/lockable-assets.json（从官方 Female3DCG.js 全量提取的
//    AllowLock 资产表，611 件——覆盖白名单外的道具如 BitchSuit）
// ===========================================================================
import * as fs from "fs";
import * as path from "path";
import { AppearanceEntry, ALL_LOCK_PROPERTIES } from "./skills";

/** 单件快照条目 */
export interface OutfitEntry {
  /** 槽位，如 ItemArms */
  group: string;
  /** 道具名，如 LeatherCuffs */
  name: string;
  /** 颜色（原样保存：十六进制字符串、"Default"，或多图层道具的每层颜色数组） */
  color?: string | string[];
  /** 绝对难度（bundle 语义；重穿时换算成相对值发 wire） */
  difficulty?: number;
  /** 非锁 Property（TypeRecord/Text/SetPose/Effect 等变体数据 + 图层自定义字段：
   *  OverridePriority/LayerRotation/LayerScaleX/Y/LayerTranslationX/Y 等，Layering.js 确证） */
  property?: Record<string, unknown>;
}

/** 存档文件（含元信息） */
export interface OutfitFile {
  /** 保存时间戳(ms) */
  savedAt: number;
  /** 保存时服务对象身上的束缚条目数 */
  itemCount: number;
  entries: OutfitEntry[];
}

const OUTFIT_DIR = path.resolve(__dirname, "..", "data", "outfits");
const DEFAULT_FILE = path.join(OUTFIT_DIR, "gohome.json");

/** data/lockable-assets.json：Group/Name → 基础难度（值不重要，键存在即可锁） */
let lockableTable: Record<string, number> | null = null;
function lockableAssets(): Record<string, number> {
  if (lockableTable) return lockableTable;
  try {
    lockableTable = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "data", "lockable-assets.json"), "utf-8")
    ) as Record<string, number>;
  } catch {
    lockableTable = {};
  }
  return lockableTable;
}

/** 某道具（任意资产，不限白名单）是否可上锁（官方 AllowLock） */
export function isAssetLockable(group: string, name: string): boolean {
  return `${group}/${name}` in lockableAssets();
}

/** 任意资产的官方基础难度（lockable-assets.json 里带；不在表里的默认 0） */
export function assetBaseDifficulty(group: string, name: string): number {
  return lockableAssets()[`${group}/${name}`] ?? 0;
}

/**
 * 从服务对象外观抓束缚快照：所有 Item* 槽位上的道具（不含衣着）。
 * 剥离锁字段与锁 Effect——锁由游戏规则统一重新上。
 */
export function captureOutfit(appearance: unknown[] | null | undefined): OutfitEntry[] {
  if (appearance == null) return [];
  const entries: OutfitEntry[] = [];
  for (const raw of appearance) {
    const e = raw as AppearanceEntry & { Color?: unknown; Difficulty?: unknown };
    if (typeof e?.Group !== "string" || typeof e?.Name !== "string") continue;
    if (!e.Group.startsWith("Item")) continue;
    const entry: OutfitEntry = { group: e.Group, name: e.Name };
    // Color 两种形态都要存：字符串（单色）或数组（多图层每层一色，Appearance.js:694）。
    // 之前只存字符串——用户在图层界面给不同图层上不同色时会整块丢失（2026-09-05 01:13 用户提醒图层信息后发现的洞）
    if (typeof e.Color === "string" || Array.isArray(e.Color)) entry.color = e.Color;
    if (typeof e.Difficulty === "number") entry.difficulty = e.Difficulty;
    // Property：剥离锁字段 + Effect 去 "Lock"
    if (e.Property && typeof e.Property === "object") {
      const prop: Record<string, unknown> = { ...(e.Property as Record<string, unknown>) };
      for (const k of ALL_LOCK_PROPERTIES) delete prop[k];
      if (Array.isArray(prop.Effect)) {
        prop.Effect = (prop.Effect as unknown[]).filter((x) => x !== "Lock");
        if ((prop.Effect as unknown[]).length === 0) delete prop.Effect;
      }
      if (Object.keys(prop).length > 0) entry.property = prop;
    }
    entries.push(entry);
  }
  return entries;
}

/** 保存套装快照到 data/outfits/gohome.json */
export function saveOutfit(entries: OutfitEntry[]): OutfitFile {
  fs.mkdirSync(OUTFIT_DIR, { recursive: true });
  const file: OutfitFile = { savedAt: Date.now(), itemCount: entries.length, entries };
  fs.writeFileSync(DEFAULT_FILE, JSON.stringify(file, null, 1), "utf-8");
  return file;
}

/** 读取套装快照（不存在返回 null） */
export function loadOutfit(): OutfitFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULT_FILE, "utf-8")) as OutfitFile;
    if (!Array.isArray(raw.entries)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 图层自定义涉及的 Property 字段（Layering.js 确证：优先级/旋转/缩放/位移，资产级+每图层级） */
const LAYERING_PROPERTY_KEYS = [
  "OverridePriority", "Rotation", "LayerRotation",
  "ScaleX", "ScaleY", "LayerScaleX", "LayerScaleY",
  "TranslationX", "TranslationY", "LayerTranslationX", "LayerTranslationY",
];

/** 套装快照的人类可读摘要（确认口令 / 日志用）——含图层自定义与多层颜色的提示 */
export function describeOutfit(outfit: OutfitFile): string {
  const time = new Date(outfit.savedAt).toLocaleString("zh-CN");
  const lines = outfit.entries.map((e) => `${e.group}/${e.name}`);
  const layeredCount = outfit.entries.filter(
    (e) =>
      (Array.isArray(e.color) && e.color.length > 1) ||
      (e.property != null && LAYERING_PROPERTY_KEYS.some((k) => e.property![k] != null))
  ).length;
  const layerNote = layeredCount > 0 ? `，其中 ${layeredCount} 件带图层自定义（层级/每层颜色）` : "";
  return `共 ${outfit.entries.length} 件（${time} 保存）：${lines.join("、")}${layerNote}`;
}
