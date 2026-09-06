// 一次性脚本：从 BC 官方资产文件提取 DefaultColor 表 → data/asset-default-colors.json
// 背景：BC 服务器对默认色道具剥离 Color 字段（Scripts_Server.js:770 ItemColorIsDefault → undefined），
// BOT 缓存里 Color=undefined 意味着"该道具用资产默认色"，需要此表回查。
// 用法：node scripts/extract-default-colors.mjs（在项目根目录执行）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  {
    path: join(root, ".reference", "bc-official", "Assets_Female3DCG.js"),
    varName: "AssetFemale3DCG",
  },
  {
    path: join(root, ".reference", "bc-official", "Assets_Female3DCGExtended.js"),
    varName: "AssetFemale3DCGExtended",
  },
];

const result = {};
let groupCount = 0;
let assetCount = 0;
let withColor = 0;

for (const f of files) {
  const code = readFileSync(f.path, "utf8");
  // Proxy 兜底：资产文件引用了 BC 客户端全局（PoseType/ModularItemChatSetting 等），
  // 未定义标识符一律给空对象 Proxy，让纯数据部分顺利执行完。
  const stub = new Proxy(function stub() {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
    apply: () => stub,
    construct: () => stub,
  });
  const sandbox = new Proxy(
    {},
    {
      has: () => true,
      get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : stub),
      set: (t, k, v) => ((t[k] = v), true),
    }
  );
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: f.path });
  } catch (e) {
    console.error(`[warn] ${f.path} 执行报错（部分数据可能缺失）: ${e.message}`);
  }
  const groups = sandbox[f.varName];
  const hexRe = /^#?[0-9a-f]{6}$/i;
  const addAsset = (group, name, def) => {
    if (typeof group !== "string" || typeof name !== "string" || !Array.isArray(def)) return;
    assetCount++;
    const hexes = def.filter((c) => typeof c === "string" && hexRe.test(c));
    if (hexes.length > 0) {
      result[`${group}/${name}`] = hexes;
      withColor++;
    }
  };
  if (Array.isArray(groups)) {
    // 主资产文件：[{Group, Asset: [{Name, DefaultColor}]}]
    for (const g of groups) {
      if (!g || typeof g.Group !== "string" || !Array.isArray(g.Asset)) continue;
      groupCount++;
      for (const a of g.Asset) addAsset(g.Group, a?.Name, a?.DefaultColor);
    }
  } else if (groups && typeof groups === "object") {
    // Extended 文件：{Group: {AssetName: {DefaultColor}}}
    for (const gName of Object.keys(groups)) {
      const g = groups[gName];
      if (!g || typeof g !== "object") continue;
      groupCount++;
      for (const aName of Object.keys(g)) addAsset(gName, aName, g[aName]?.DefaultColor);
    }
  } else {
    console.error(`[error] ${f.varName} 结构不认识，跳过`);
    continue;
  }
}

const out = join(root, "data", "asset-default-colors.json");
writeFileSync(out, JSON.stringify(result, null, 1), "utf8");
console.log(`组 ${groupCount} 个 / 资产 ${assetCount} 条 / 含 hex 默认色 ${withColor} 条 → ${out}`);
console.log(`抽查 Cloth/ChineseDress2 = ${JSON.stringify(result["Cloth/ChineseDress2"])}`);
console.log(`抽查 ClothOuter/LeatherJacket = ${JSON.stringify(result["ClothOuter/LeatherJacket"])}`);
