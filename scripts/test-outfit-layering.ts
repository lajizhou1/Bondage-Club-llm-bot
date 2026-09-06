// #16 图层快照冒烟测试（2026-09-05 01:13 用户提醒图层信息后补）
// 验证：① 图层 Property 字段（OverridePriority/LayerScaleX/...）随快照保留
//       ② 数组颜色（多图层每层一色）随快照保留（之前只存字符串会丢）
//       ③ 上锁合并（buildLockProperty）不冲掉图层字段
//       ④ describeOutfit 能提示图层自定义
//       ⑤ 切变体（buildVariantProperty）按官方语义替换 OverridePriority（记录行为，不算 bug）
import { captureOutfit, describeOutfit, OutfitFile } from "../src/outfit";
import { buildLockProperty, buildVariantProperty } from "../src/skills";

const appearance = [
  {
    Group: "ItemArms",
    Name: "LeatherCuffs",
    Color: ["#FF0000", "#00FF00"], // 数组颜色：两个图层不同色
    Difficulty: 12,
    Property: {
      TypeRecord: { typed: 1 },
      Effect: ["Block"],
      // 图层自定义（Layering.js 确证的 11 个字段形态示例）
      OverridePriority: { Layer1: 5 },
      LayerScaleX: { Layer1: 1.5 },
      TranslationY: 10,
      // 锁字段：快照必须剥离
      LockedBy: "MetalPadlock",
      LockMemberNumber: 123,
      RemoveTimer: Date.now() + 60000,
    },
  },
  {
    Group: "ItemNeckRestraints",
    Name: "CollarLeash",
    Color: "Default",
    Property: { OverridePriority: 42 }, // 资产级整数形态
  },
  { Group: "Cloth", Name: " Shirt" }, // 衣着：不该进快照
];

const entries = captureOutfit(appearance as any);
console.log("== 快照条目数（应为 2，衣着排除）==", entries.length);

const cuffs = entries.find((e) => e.name === "LeatherCuffs")!;
console.log("== 数组颜色保留 ==", JSON.stringify(cuffs.color));
if (JSON.stringify(cuffs.color) !== JSON.stringify(["#FF0000", "#00FF00"])) throw new Error("数组颜色丢失！");
if (cuffs.property?.OverridePriority === undefined) throw new Error("OverridePriority 丢失！");
if (cuffs.property?.LayerScaleX === undefined) throw new Error("LayerScaleX 丢失！");
if (cuffs.property?.TranslationY !== 10) throw new Error("TranslationY 丢失！");
if (cuffs.property?.LockedBy !== undefined) throw new Error("锁字段未剥离！");
if (cuffs.property?.RemoveTimer !== undefined) throw new Error("RemoveTimer 未剥离！");
if ((cuffs.property?.Effect as string[]).includes("Lock")) throw new Error("Lock Effect 未剥离！");
console.log("== 图层字段全数保留，锁字段全数剥离 ==");

const leash = entries.find((e) => e.name === "CollarLeash")!;
if (leash.property?.OverridePriority !== 42) throw new Error("资产级 OverridePriority 丢失！");

// 上锁合并：图层字段必须在锁字段之下存活
const locked = buildLockProperty(cuffs.property ?? null, "OwnerTimerPadlock", {
  memberNumber: 258939,
  memberName: "ljzsbot",
  timerSec: 5400,
});
if (locked.OverridePriority === undefined) throw new Error("上锁后 OverridePriority 丢失！");
if (locked.LayerScaleX === undefined) throw new Error("上锁后 LayerScaleX 丢失！");
if (locked.LockedBy !== "OwnerTimerPadlock") throw new Error("锁字段未写入！");
console.log("== 上锁后图层字段存活 ==", JSON.stringify(locked.OverridePriority));

// 切变体：官方语义=变体自带 OverridePriority 替换用户的（记录行为）
const variant = buildVariantProperty("LeatherCuffs", 2, cuffs.property ?? null);
console.log(
  "== 切变体后 OverridePriority（官方删旧合新，预期被变体定义替换或删除）==",
  JSON.stringify(variant.OverridePriority)
);
if (variant.LayerScaleX === undefined) console.log("   （注意：LayerScaleX 不在变体自有键里，保留 =", JSON.stringify(variant.LayerScaleX), "）");

// 摘要提示
const file: OutfitFile = { savedAt: Date.now(), itemCount: entries.length, entries };
console.log("== describeOutfit ==", describeOutfit(file));

console.log("\n全部断言通过 ✅");
