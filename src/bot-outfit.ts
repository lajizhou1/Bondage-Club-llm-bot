// ===========================================================================
// #60 BOT 默认服装系统（bot-outfit.ts）
// ---------------------------------------------------------------------------
// 设计（2026-09-05 用户拍板，#61 修正）：给 BOT 设计一身固定制服。
// 流程：用户在游戏里亲手给 BOT 穿好 → 说"记住我的衣服" → BOT 存档 →
//   启动时自动重穿；被路人动过时说"重穿我的衣服"。
//
// 防护（#61 用户拍板，取代上锁方案）：衣服/服饰道具不上锁——防别人乱动靠
//   **道具互动权限白名单**（ItemPermission=3，服务器端硬执法，见 client.ts
//   setPermissionWhitelistOnly）。白名单里只有服务对象（服务对象），其他玩家
//   连道具操作都发不过来，比锁干净。
//
// 与 outfit.ts（#16 限时回家束缚套装）的区别：
//   - outfit.ts 只抓 Item* 槽位（束缚道具），剥离锁字段，专为游戏规则服务
//   - bot-outfit 抓全部槽位（含 Cloth/Bra/Panties/Hair/...），专为 BOT 自用
//
// 注意点：
//   - 默认穿时不碰 Item* 槽（避免给自己上束缚影响功能），includeItemSlots=true 时才穿
//   - 装备走单道具通道（self-target），相对难度 = abs - assetBaseDifficulty
// ===========================================================================
import * as fs from "fs";
import * as path from "path";
import { AppearanceEntry } from "./skills";
import { assetBaseDifficulty } from "./outfit";

/** 单件外观条目（含所有槽位：Item 系/Cloth 系/Hair/Eyes/...） */
export interface BotOutfitEntry {
  group: string;
  name: string;
  color?: string | string[];
  difficulty?: number;
  property?: Record<string, unknown>;
}

/** 存档文件 */
export interface BotOutfitFile {
  savedAt: number;
  itemCount: number;
  entries: BotOutfitEntry[];
}

const BOT_OUTFIT_DIR = path.resolve(__dirname, "..", "data", "outfits");

/** 存档文件路径。
 *  09-05 事故教训：测试脚本曾直接操作真实存档路径，delete 把线上存档（"高冷DOM"）
 *  覆盖/删除过。现支持 BOT_OUTFIT_FILE 环境变量注入独立路径——测试脚本设临时
 *  文件，与真实存档彻底隔离（惰性求值：import 后设 env 也能生效）。 */
function outfitFile(): string {
  return process.env.BOT_OUTFIT_FILE
    ? path.resolve(process.env.BOT_OUTFIT_FILE)
    : path.join(BOT_OUTFIT_DIR, "bot.json");
}

/** 抓指定成员当前外观的所有槽位（含衣着/发/眼/妆容/Item），完整保存（含 Property）。
 *  09-05 修复：跳过 Name 为空字符串的"空槽位"条目（bundle 下发的空槽会混进存档，
 *  重穿时对空名发更新是无效调用，还污染"查看我的衣服"清单）。 */
export function captureBotAppearance(appearance: unknown[] | null | undefined): BotOutfitEntry[] {
  if (appearance == null) return [];
  const entries: BotOutfitEntry[] = [];
  for (const raw of appearance) {
    const e = raw as AppearanceEntry & { Color?: unknown; Difficulty?: unknown };
    if (typeof e?.Group !== "string" || typeof e?.Name !== "string") continue;
    if (e.Name === "") continue; // 空槽位不进存档
    const entry: BotOutfitEntry = { group: e.Group, name: e.Name };
    if (typeof e.Color === "string" || Array.isArray(e.Color)) entry.color = e.Color;
    if (typeof e.Difficulty === "number") entry.difficulty = e.Difficulty;
    if (e.Property && typeof e.Property === "object") {
      entry.property = { ...(e.Property as Record<string, unknown>) };
    }
    entries.push(entry);
  }
  return entries;
}

/** 保存到 data/outfits/bot.json（可用 BOT_OUTFIT_FILE 覆盖） */
export function saveBotOutfit(entries: BotOutfitEntry[]): BotOutfitFile {
  const file = outfitFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data: BotOutfitFile = { savedAt: Date.now(), itemCount: entries.length, entries };
  fs.writeFileSync(file, JSON.stringify(data, null, 1), "utf-8");
  return data;
}

/** 读取存档（不存在返回 null） */
export function loadBotOutfit(): BotOutfitFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(outfitFile(), "utf-8")) as BotOutfitFile;
    if (!Array.isArray(raw.entries)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 删除存档（重置用） */
export function deleteBotOutfit(): void {
  try {
    fs.unlinkSync(outfitFile());
  } catch {
    /* 文件本来就不存在 */
  }
}

/** 人类可读摘要 */
export function describeBotOutfit(outfit: BotOutfitFile): string {
  const time = new Date(outfit.savedAt).toLocaleString("zh-CN");
  const lines = outfit.entries.map((e) => `${e.group}/${e.name}`);
  return `共 ${outfit.entries.length} 件（${time} 保存）：${lines.join("、")}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 客户端操作的最小接口（避免直接依赖 Client 类造成循环引用） */
export interface BotOutfitClient {
  sendItemUpdate(
    targetNo: number,
    group: string,
    name: string | null,
    opts?: { property?: Record<string, unknown> | null; difficulty?: number; color?: string | string[] }
  ): void;
  updateCachedItem(
    memberNo: number,
    group: string,
    name: string | null,
    opts?: { property?: Record<string, unknown>; difficulty?: number; color?: string | string[] }
  ): void;
  /** 读取成员当前外观（重穿 diff 用：找出"存档外/被换掉"的道具先脱掉） */
  getAppearance(memberNo: number): unknown[] | null;
  /** #71 修复：把更新后的 BOT 外观整包发回服务器落库（client.ts:654-680）。
   *  不调这个，服装类重穿也只是表演公告，重启拉存档会"复活"。 */
  sendCharacterUpdate(): void;
}

/** 把存档按顺序穿到指定成员身上（纯重穿，不上锁——防护靠 ItemPermission 白名单）。
 *
 *  09-05 修复"只加不减"：旧版只把存档道具逐件穿上，别人后来加的/换的不会被脱掉，
 *  "重穿"后多余道具还在（用户实测：重穿 3 次都没恢复，只能自己开衣柜删）。
 *  新流程 = 先脱后穿：
 *    脱：当前穿着的道具里——①存档覆盖的槽位但道具名不同（换了 → 先脱再穿存档版）
 *        ②存档没有的**服装类**槽位（别人后来加的帽子/围巾等 → 恢复原样）
 *        Item* 束缚槽**永不脱**（束缚是游戏/惩罚状态，不归制服管）；
 *        同槽同名的直接穿上存档版覆盖（被改色/改属性也能纠正回来）。
 *    穿：存档全部条目（跳过空名防御）。
 *  返回统计：equipped（穿上）/ removed（脱掉）/ skipped（跳过） */
export async function applyBotOutfit(
  memberNo: number,
  client: BotOutfitClient,
  opts: {
    intervalMs?: number;
    includeItemSlots?: boolean; // 默认 false（不让 BOT 启动时自动穿束缚影响功能）
  } = {}
): Promise<{ equipped: number; removed: number; skipped: number }> {
  const file = loadBotOutfit();
  if (!file) return { equipped: 0, removed: 0, skipped: 0 };
  const intervalMs = opts.intervalMs ?? 350;
  let equipped = 0,
    removed = 0,
    skipped = 0;

  // 存档槽位 → 道具名（只含本次要穿的范围：includeItemSlots=false 时不含 Item*）
  const savedByGroup = new Map<string, string>();
  for (const entry of file.entries) {
    if (!entry.name) {
      skipped++; // 空名防御（旧存档可能混有空槽位条目）
      continue;
    }
    if (!opts.includeItemSlots && entry.group.startsWith("Item")) {
      skipped++;
      continue;
    }
    savedByGroup.set(entry.group, entry.name);
  }

  // ── 第一轮：脱（只脱服装类；束缚 Item* 永不脱）────────────────────────
  const current = client.getAppearance(memberNo) ?? [];
  for (const raw of current) {
    const e = raw as AppearanceEntry;
    if (typeof e?.Group !== "string") continue;
    if (e.Group.startsWith("Item")) continue; // 束缚不碰
    if (typeof e?.Name !== "string" || e.Name === "") continue; // 空槽位跳过
    const savedName = savedByGroup.get(e.Group);
    if (savedName === e.Name) continue; // 同槽同名——第二轮穿上存档版覆盖即可
    // 存档没有该槽位（savedName===undefined，别人后加的）或槽位被换成了别的道具 → 脱
    try {
      client.sendItemUpdate(memberNo, e.Group, null);
      client.updateCachedItem(memberNo, e.Group, null);
      removed++;
    } catch {
      skipped++;
    }
    await sleep(intervalMs);
  }

  // ── 第二轮：穿（存档全部）─────────────────────────────────────────────
  for (const entry of file.entries) {
    if (!entry.name) continue; // 空名防御
    if (!opts.includeItemSlots && entry.group.startsWith("Item")) continue; // 上面已计入 skipped
    const base = assetBaseDifficulty(entry.group, entry.name);
    const absTarget = entry.difficulty ?? base;
    try {
      client.sendItemUpdate(memberNo, entry.group, entry.name, {
        ...(entry.property !== undefined ? { property: entry.property } : {}),
        difficulty: absTarget - base,
        ...(entry.color !== undefined ? { color: entry.color } : {}),
      });
      client.updateCachedItem(memberNo, entry.group, entry.name, {
        ...(entry.property !== undefined ? { property: entry.property } : {}),
        difficulty: absTarget,
        ...(entry.color !== undefined ? { color: entry.color } : {}),
      });
      equipped++;
    } catch {
      skipped++;
    }
    await sleep(intervalMs);
  }
  // #71 修复（2026-09-06 12:25）：服装类脱穿循环完成后立即落库。
  //   与 emergencyStripBot 同一根因：单道具操作只走 ChatRoomCharacterItemUpdate 转发给
  //   其他人，不写服务器数据库；唯一落库通道是 ChatRoomCharacterUpdate（整包外观）。
  //   不调这个 → 用户档案里"被路人动过的服装"永远清不掉，重启拉存档会被复活。
  client.sendCharacterUpdate();
  return { equipped, removed, skipped };
}