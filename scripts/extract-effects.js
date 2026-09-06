// 从官方 Female3DCG.js 提取资产级 Effect 表（"Group/Name" -> effects）
// 用法：node scripts/extract-effects.js
// 输出：src/asset-effects.ts
//
// 文件结构（tab 缩进，2026-09-03 核对）：
//   顶层数组
//     { Group: "ItemArms", ...        ← 组对象，2 tab 属性
//       Asset: [
//         { Name: "NylonRope",        ← 资产对象 3 tab `{`，4 tab 属性
//           Effect: [E.Block, ...],   ← 资产级 Effect（4 tab，可能跨多行）
//           Layer: [{ Name: "Rope" }] ← Layer 对象 5+ tab，忽略
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, ".reference/bc-fetch/Female3DCG.js"), "utf8");
const lines = src.split("\n");

const WANTED = new Set([
  "GagVeryLight", "GagEasy", "GagLight", "GagNormal", "GagMedium", "GagHeavy", "GagVeryHeavy", "GagTotal", "GagTotal2", "GagTotal3", "GagTotal4",
  "BlindLight", "BlindNormal", "BlindHeavy", "BlindTotal",
  "DeafLight", "DeafNormal", "DeafHeavy", "DeafTotal",
  "Freeze", "Tethered", "Mounted", "Block",
]);

const TAB = "\t";
const groupRe = new RegExp(`^${TAB}${TAB}Group: "([\\w]+)",`);
const assetOpenRe = new RegExp(`^${TAB}${TAB}${TAB}\\{`);
const assetNameRe = new RegExp(`^${TAB}${TAB}${TAB}${TAB}Name: "([\\w]+)",`);
const effectOpenRe = new RegExp(`^${TAB}${TAB}${TAB}${TAB}Effect: \\[`);
const effectCloseRe = /^\]/;

const result = {};
let currentGroup = null;
let currentAsset = null; // 当前资产名（4 tab Name 匹配过）
let inAssetBlock = false;
let inEffectLines = null; // 收集多行 Effect 的缓冲

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (inEffectLines !== null) {
    inEffectLines.push(line);
    // 多行 Effect 的闭合行：去掉 4 tab 前缀后以 ] 开头
    if (effectCloseRe.test(line.replace(new RegExp(`^${TAB}${TAB}${TAB}${TAB}`), ""))) {
      flushEffect(inEffectLines.join(" "));
      inEffectLines = null;
    }
    continue;
  }
  const g = line.match(groupRe);
  if (g) { currentGroup = g[1]; currentAsset = null; inAssetBlock = false; continue; }
  if (assetOpenRe.test(line)) { inAssetBlock = true; currentAsset = null; continue; }
  if (inAssetBlock) {
    const n = line.match(assetNameRe);
    if (n) { currentAsset = n[1]; continue; }
    if (effectOpenRe.test(line)) {
      // 单行闭合：行尾以 ] 或 ], 结束
      if (/],?\s*$/.test(line)) {
        flushEffect(line);
      } else {
        inEffectLines = [line]; // 多行 Effect，等闭合行
      }
    }
  }
}

function flushEffect(raw) {
  const effects = raw.match(/\[([^\]]*)\]/)?.[1] ?? "";
  const wanted = effects.split(",").map((s) => s.trim().replace(/^E\./, "").replace(/,$/, "")).filter((e) => WANTED.has(e));
  if (wanted.length === 0 || !currentAsset || !currentGroup) return;
  const key = `${currentGroup}/${currentAsset}`;
  if (!result[key]) result[key] = [];
  for (const w of wanted) if (!result[key].includes(w)) result[key].push(w);
}

const entries = Object.entries(result).sort((a, b) => a[0].localeCompare(b[0]));
const tsLines = entries.map(([k, v]) => "  " + JSON.stringify(k) + ": [" + v.map((x) => JSON.stringify(x)).join(", ") + "],");
const ts =
  "// 从官方 Assets/Female3DCG/Female3DCG.js 提取的资产级 Effect 静态表（scripts/extract-effects.js 生成）。\n" +
  "// 键是 Group/Name（资产名不全局唯一，必须带组名）。只含四维感知关心的效果：\n" +
  "// 口塞/失明/失聪/移动限制/双手占用。\n" +
  "// ⚠️ 变体级 Effect（如绳子绑法自带的 Freeze）不在此表——它们经官方流程切变体后\n" +
  "// 会写进 wire 数据的 Property.Effect，运行时与下表合并（CharacterGetEffects 同款逻辑）。\n" +
  "export const ASSET_EFFECTS: Record<string, string[]> = {\n" + tsLines.join("\n") + "\n};\n";
writeFileSync(join(root, "src/asset-effects.ts"), ts);
console.log(`提取了 ${entries.length} 条（Group/Name 键）：`);
for (const [k, v] of entries) console.log(`  ${k}: ${v.join(", ")}`);
