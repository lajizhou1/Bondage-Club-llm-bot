// 从官方 Female3DCG.js 提取全部 AllowLock 资产 → data/lockable-assets.json
// 用途：#16 套装快照重穿任意道具时，判断哪些道具可以上主人定时锁。
// 用法：node scripts/extract_lockable_assets.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", ".reference", "bc-fetch", "Female3DCG.js"),
  "utf-8"
);
const start = src.indexOf("var AssetFemale3DCG = [");
const closeIdx = src.indexOf("\n];", start);
const arraySrc = src.slice(src.indexOf("[", start), closeIdx + 2);

// 常量桩（与 extract_base_difficulty.js 同款）
const stub = new Proxy(function () {}, {
  get: () => stub,
  apply: () => ({}),
  construct: () => ({}),
});
globalThis.PoseType = new Proxy({}, { get: () => "DEFAULT" });
for (const k of ["AssetPoseMapping", "AssetBodyPoseMapping", "AssetArmsPoseMapping", "AssetLegsPoseMapping", "AssetFeetPoseMapping", "AssetTorsoPoseMapping"])
  globalThis[k] = stub;
for (const k of ["E", "CommonChatTags", "ExtendedArchetype", "AnimationType", "VibratorMode"])
  globalThis[k] = stub;
globalThis.AssetMalePantiesList = [];
globalThis.AssetMaleChasityCagesList = [];
for (const k of ["PoseAllKneeling", "PoseAllStanding", "PoseAllSuspended"])
  globalThis[k] = [];
globalThis.AssetUpperOverflowAlpha = [];
globalThis.AssetLowerOverflowAlpha = [];

const assets = eval(arraySrc); // 组对象数组，每组 { Group, Asset: [...] }

// 全部 AllowLock: true 的资产 → { "Group/Name": Difficulty }
// 注意：数组元素是【组对象】，单个资产挂在组对象的 .Asset 数组里。
const out = {};
let count = 0;
for (const group of assets) {
  if (!group || typeof group.Group !== "string" || !Array.isArray(group.Asset)) continue;
  for (const a of group.Asset) {
    if (a && a.Name && a.AllowLock === true) {
      out[`${group.Group}/${a.Name}`] = typeof a.Difficulty === "number" ? a.Difficulty : 0;
      count++;
    }
  }
}
const dest = path.join(__dirname, "..", "data", "lockable-assets.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 1), "utf-8");
console.log(`extracted ${count} lockable assets -> ${dest}`);
