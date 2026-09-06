// 从官方 Female3DCG.js 提取白名单道具的 (Group, Name, Difficulty, AllowTighten)
// 用法：node scripts/extract_base_difficulty.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", ".reference", "bc-fetch", "Female3DCG.js"),
  "utf-8"
);
// 只取 var AssetFemale3DCG = [ ... ]; 数组部分（589 行起到 PoseFemale3DCG 前）
const start = src.indexOf("var AssetFemale3DCG = [");
const closeIdx = src.indexOf("\n];", start);
const arraySrc = src.slice(src.indexOf("[", start), closeIdx + 2);

// 常量桩：资产数组里引用了外部常量，用 Proxy 兜底展开（...展开为空对象）
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

const assets = eval(arraySrc); // 纯数据数组

// 白名单道具（发送名）
const whitelist = [
  "LeatherCollar", "PetCollar", "PostureCollar", "HeartCollar",
  "BallGag", "BitGag", "ClothGag", "MuzzleGag", "PacifierGag", "DuctTape",
  "LeatherBlindfold", "ClothBlindfold", "ScarfBlindfold", "SmallBlindfold",
  "HempRope", "NylonRope",
  "LeatherCuffs", "MetalCuffs",
  "LeatherArmbinder", "LatexArmbinder", "SeamlessLatexArmbinder", "ShinyArmbinder",
  "StraitJacket", "LeatherStraitJacket", "FullBodyLeatherHarness", "CollarCuffs",
  "LeatherLegCuffs", "LeatherAnkleCuffs", "SteelAnkleCuffs",
  "BalletHeels", "CollarLeash", "ChainLeash",
];

for (const name of whitelist) {
  const hits = assets
    .filter((a) => a && a.Name === name)
    .map((a) => `${a.Group}: diff=${a.Difficulty ?? 0} lock=${!!a.AllowLock} tighten=${!!a.AllowTighten}`);
  console.log(name, "->", hits.length ? hits.join(" | ") : "NOT FOUND");
}
