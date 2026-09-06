// 冒烟测试：bot-outfit.ts 的 capture/save/load/apply 闭环
// 09-05 v3（事故后重写）：通过 BOT_OUTFIT_FILE 注入**独立临时文件**，
// 与真实存档 data/outfits/bot.json 彻底隔离——本脚本永远不会碰线上档。
// （v2 的"开头备份/结尾还原"方案有漏洞：断言失败走 catch+process.exit 会跳过还原，
//  已实际把 服务对象 的"高冷DOM"档弄丢过一次，教训深刻。）
import * as os from "os";
import * as path from "path";

// 必须在 import bot-outfit 之前……不用：路径是惰性求值的，import 后设 env 也生效
process.env.BOT_OUTFIT_FILE = path.join(os.tmpdir(), "bc-bot-outfit-test.json");

import * as botOutfit from "../src/bot-outfit";

const TMP = process.env.BOT_OUTFIT_FILE;

// 1) capture：从一段模拟外观抓出所有槽位（含 2 个空槽位 + 1 个无 Group 的脏数据）
const fakeAppearance = [
  { Group: "ArmsLeft", Name: "" }, // 空槽位 → 不进存档
  { Group: "ArmsRight", Name: "" }, // 空槽位 → 不进存档
  { Group: "HairFront", Name: "HairFront9", Color: "#8B4513", Property: { Color: "Brown" } },
  { Group: "HairBack", Name: "HairBack1", Color: "#8B4513" },
  { Group: "Cloth", Name: "MaidLatex", Color: ["#FFFFFF", "#000000"], Difficulty: 5 },
  { Group: "ClothLower", Name: "MaidLatexSkirt", Color: "#000000" },
  { Group: "ItemNeck", Name: "PetCollar", Property: { Type: "leather" } },
  { Group: "ItemArms", Name: "LeatherCuffs", Property: { Effect: ["Lock"], LockedBy: "OwnerPadlock" } }, // 锁字段应保留
  { Group: "HairAccessory1", Name: "MaidHeadband" },
  { Name: "NoGroup" }, // 脏数据 → 跳过
];
const captured = botOutfit.captureBotAppearance(fakeAppearance);
console.log(`[test] capture 抓到 ${captured.length} 条`);
if (captured.length !== 7) throw new Error(`应抓 7 条（9 项 - 2 空槽 - 1 脏数据），实抓 ${captured.length}`);
if (captured.some((e) => !e.name)) throw new Error("存档不应含空名字条目");
if (captured[2].color !== undefined && !Array.isArray(captured[2].color)) throw new Error("数组颜色应保留为数组");
if (captured[2].difficulty !== 5) throw new Error("Difficulty 应保留为 5");
if (captured[5].property?.LockedBy !== "OwnerPadlock") throw new Error("锁字段应原样保留（不剥离）");
console.log("[test] capture 字段检查通过（空槽位已过滤/数组颜色/难度/锁字段）");

// 2) save + load 闭环
const file = botOutfit.saveBotOutfit(captured);
const loaded = botOutfit.loadBotOutfit();
if (!loaded) throw new Error("load 应返回存档");
if (loaded.entries.length !== captured.length) throw new Error("load 条目数与 save 不一致");
if (loaded.savedAt !== file.savedAt) throw new Error("savedAt 不一致");
console.log(`[test] save/load 闭环通过（${loaded.itemCount} 件，路径=${TMP}）`);

// 3) describe
const desc = botOutfit.describeBotOutfit(loaded);
console.log(`[test] describe: ${desc}`);

// 4) apply 模拟：mock 客户端记录调用
const sent: Array<{ t: number; g: string; n: string | null; opts?: unknown }> = [];
const cached: Array<{ m: number; g: string; n: string | null; opts?: unknown }> = [];
// 模拟 BOT 当前外观：制服被换 + 路人加了帽子 + 束缚一件 + 同款在穿一件
const currentAppearance = [
  { Group: "Cloth", Name: "OtherDress" }, // 存档是 MaidLatex → 应先脱再穿
  { Group: "Blush", Name: "Blush" }, // 存档没有的服装槽（路人加的）→ 应脱
  { Group: "ItemNeck", Name: "SomeRestraint" }, // 束缚 → 永不脱
  { Group: "HairBack", Name: "HairBack1" }, // 与存档同名 → 不脱，直接穿存档版覆盖
];
const mockClient: botOutfit.BotOutfitClient = {
  sendItemUpdate: (t, g, n, opts) => { sent.push({ t, g, n, opts }); },
  updateCachedItem: (m, g, n, opts) => { cached.push({ m, g, n, opts }); },
  getAppearance: () => currentAppearance,
};

(async () => {
  // 第一轮：默认跳过 Item* 槽（不让 BOT 自启束缚），先脱后穿
  const r = await botOutfit.applyBotOutfit(258939, mockClient, {
    intervalMs: 0,
    includeItemSlots: false,
  });
  console.log(`[test] apply(无Item槽): ${JSON.stringify(r)}`);
  if (r.equipped !== 5) throw new Error(`非 Item* 应穿 5 件，实穿 ${r.equipped}`); // 7-2(ItemNeck,ItemArms)
  if (r.skipped !== 2) throw new Error(`应跳 2 件 Item*，实跳 ${r.skipped}`);
  if (r.removed !== 2) throw new Error(`应脱 2 件（OtherDress 换装 + Blush 路人加的），实脱 ${r.removed}`);

  // 脱的语义检查
  const removedCloth = sent.find((s) => s.g === "Cloth" && s.n === null);
  if (!removedCloth) throw new Error("被换掉的 Cloth/OtherDress 应先脱（sendItemUpdate name=null）");
  const removedBlush = sent.find((s) => s.g === "Blush" && s.n === null);
  if (!removedBlush) throw new Error("存档外的 Blush 应被脱掉");
  const removedRestraint = sent.find((s) => s.g === "ItemNeck" && s.n === null);
  if (removedRestraint) throw new Error("束缚 ItemNeck 绝不能被脱");

  // 纯重穿：Property 应原样透传，不得新增锁字段
  const clothSend = sent.find((s) => s.g === "Cloth" && s.n === "MaidLatex");
  if (!clothSend) throw new Error("MaidLatex 应已发送");
  const clothOpts = clothSend.opts as { property?: Record<string, unknown>; color?: string | string[] };
  if (Array.isArray(clothOpts.color) && clothOpts.color.length !== 2) throw new Error("数组颜色应原样发送");
  const hairSend = sent.find((s) => s.g === "HairFront" && s.n === "HairFront9");
  if (!hairSend) throw new Error("HairFront9 应已发送");
  const hairProp = (hairSend.opts as { property?: Record<string, unknown> }).property;
  if (hairProp?.LockedBy !== undefined) throw new Error("纯重穿不应新增锁字段");
  if (hairProp?.Color !== "Brown") throw new Error("Property 应原样透传");
  console.log("[test] 先脱后穿语义正确：换装先脱/路人加的脱掉/束缚不动/Property 透传");

  // 第二轮：includeItemSlots=true → 全部 7 件都穿（束缚也穿，但"脱"仍然只脱服装）
  sent.length = 0;
  cached.length = 0;
  const r2 = await botOutfit.applyBotOutfit(258939, mockClient, {
    intervalMs: 0,
    includeItemSlots: true,
  });
  console.log(`[test] apply(含Item槽): ${JSON.stringify(r2)}`);
  if (r2.equipped !== 7) throw new Error(`全开应穿 7 件，实穿 ${r2.equipped}`);
  if (r2.skipped !== 0) throw new Error(`全开应跳 0 件，实跳 ${r2.skipped}`);
  if (r2.removed !== 2) throw new Error(`全开也应只脱服装 2 件（束缚仍不脱），实脱 ${r2.removed}`);
  const cuffsSend = sent.find((s) => s.g === "ItemArms" && s.n === "LeatherCuffs");
  if (!cuffsSend) throw new Error("LeatherCuffs 应已发送");
  const cuffsProp = (cuffsSend.opts as { property?: Record<string, unknown> }).property;
  if (cuffsProp?.LockedBy !== "OwnerPadlock") throw new Error("存档里原有的锁字段应原样保留（不被剥离也不被改写）");
  console.log("[test] 含束缚模式正确：全穿、束缚锁字段保留");

  // 5) deleteBotOutfit（删的是临时文件，与真实存档无关）
  botOutfit.deleteBotOutfit();
  const after = botOutfit.loadBotOutfit();
  if (after !== null) throw new Error("delete 后 load 应返回 null");
  console.log("[test] delete/load null 通过（临时文件）");

  console.log("\n✅ bot-outfit 冒烟测试全部通过（v3 临时文件隔离版）");
})()
  .catch((e) => {
    console.error("❌ 测试失败：", e);
    process.exitCode = 1; // 不用 process.exit()：让 finally 有机会清理
  })
  .finally(() => {
    // 无论成败都清掉临时文件（真实存档全程未被触碰）
    try {
      require("fs").unlinkSync(TMP);
    } catch {
      /* 已不存在 */
    }
    console.log("[test] 临时文件已清理，真实存档未受影响");
  });
