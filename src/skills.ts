/**
 * 游戏互动技能系统：动作(Activity) / 姿势(Pose) / 道具(Item)。
 *
 * 数据来源 data/bc-catalog.json（从官方源码镜像解析生成，含 67 动作 / 15 姿势 /
 * 2070 道具 / 615 条动作对话模板）。本模块在目录之上再套一层"白名单"：
 * LLM 只能从白名单里挑技能，彻底杜绝"编造技能名被游戏端忽略"的问题。
 */
import * as fs from "fs";
import * as path from "path";
import { ASSET_EFFECTS } from "./asset-effects";

// ---------------------------------------------------------------------------
// 目录数据加载
// ---------------------------------------------------------------------------

interface CatalogActivity {
  name: string;
  /** 对他人可用的部位列表（官方 Target 字段） */
  targets: string[];
  /** 是否也可对自己使用（官方 TargetSelf 字段） */
  self: boolean;
}

interface CatalogPose {
  name: string;
  category: string;
  menu: boolean;
}

interface CatalogItem {
  group: string;
  name: string;
  en: string;
  cn: string;
}

interface Catalog {
  activities: CatalogActivity[];
  poses: CatalogPose[];
  items: CatalogItem[];
  activity_dialogs: Record<string, { en: string; cn: string }>;
}

const CATALOG_PATH = path.resolve(__dirname, "..", "data", "bc-catalog.json");
const catalog: Catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));

const activityByName = new Map(catalog.activities.map((a) => [a.name, a]));
const itemIndex = new Map(catalog.items.map((i) => [`${i.group}/${i.name}`, i]));

// #76 资产默认色表（Group/Name → hex[]）：BC 服务器对"颜色=资产默认色"的道具会剥离 Color 字段
// （Scripts_Server.js:770 ItemColorIsDefault → outputColor=undefined），所以缓存里 Color=undefined
// 的道具要回查此表才知道默认色。由 scripts/extract-default-colors.mjs 从官方资产文件生成。
const DEFAULT_COLOR_PATH = path.resolve(__dirname, "..", "data", "asset-default-colors.json");
const defaultColorIndex = new Map<string, string>(
  Object.entries(JSON.parse(fs.readFileSync(DEFAULT_COLOR_PATH, "utf-8")) as Record<string, string[]>)
    .map(([k, hexes]) => [k, hexes[0]] as const)
);

// #76 人工修正表（Group/Name → 色名）：官方 DefaultColor 只有"贴图原色"层（无 hex）的资产，
// 自动提取拿不到主体色（如旗袍只剩边缘层灰色 hex）——实机确认过的真实主色写在这里覆盖。
// 2026-09-06 用户实机确认：Cloth/ChineseDress2 主体红色（官方表只剩边缘层 #858585 会误报"灰旗袍"）。
const MANUAL_COLOR_OVERRIDE: Record<string, string> = {
  "Cloth/ChineseDress2": "红",
};

// ---------------------------------------------------------------------------
// 部位（zone）中文名
// ---------------------------------------------------------------------------

const ZONE_CN: Record<string, string> = {
  ItemHead: "头部",
  ItemNose: "鼻尖",
  ItemEars: "耳朵",
  ItemMouth: "嘴部（外层口塞）",
  ItemMouth2: "嘴部（中层口塞）",
  ItemMouth3: "嘴部（内层口塞）",
  ItemNeck: "颈部",
  ItemTorso: "躯干",
  ItemTorso2: "腹部",
  ItemArms: "手臂",
  ItemHands: "双手",
  ItemLegs: "双腿",
  ItemFeet: "双脚",
  ItemBoots: "靴子",
  ItemHood: "头罩",
  ItemNeckRestraints: "颈缚",
  ItemVulva: "下体",
  ItemBreast: "胸部",
  ItemButt: "臀部",
  ItemNipples: "乳首",
  ItemPelvis: "骨盆",
  ItemNeckAccessories: "颈饰（项圈挂件/标牌）",
};

export function zoneCN(zone: string): string {
  return ZONE_CN[zone] ?? zone;
}

/** 查道具中文名（catalog 里有给中文，没有给原名）。玩具感知等 UI 文案用。 */
export function itemNameCN(group: string, name: string): string {
  return itemIndex.get(`${group}/${name}`)?.cn || name;
}

// ---------------------------------------------------------------------------
// #14 玩具变化感知：状态 diff → 中文事件行（纯函数，方便自测）
// ---------------------------------------------------------------------------

/** 玩具槽位状态：道具名 + 震动强度（-1=关 0=低 1=中/高 2=最高；null=非震动道具） */
export interface ToySlotState {
  name: string | null;
  intensity: number | null;
}

export function intensityCN(level: number): string {
  if (level < 0) return "关闭";
  if (level === 0) return "低档";
  if (level === 1) return "中高档";
  return "最高档";
}

/**
 * 玩具状态 diff：对比前后状态生成中文事件行（喂给 LLM 的 [玩具] 行正文）。
 * 返回 null = 无实质变化（同名同强度，比如只上了锁）。
 */
export function diffToyState(
  prev: ToySlotState,
  cur: ToySlotState,
  serveName: string,
  zone: string,
  cnOf: (name: string) => string
): string | null {
  if (cur.name === null && prev.name !== null) {
    return `[玩具] ${serveName}取下了${zone}的${cnOf(prev.name)}`;
  }
  if (cur.name !== null && prev.name === null) {
    const vibe =
      cur.intensity !== null && cur.intensity >= 0 ? `，正在震动（${intensityCN(cur.intensity)}）` : "";
    return `[玩具] ${serveName}的${zone}多了一样东西：${cnOf(cur.name)}${vibe}`;
  }
  if (cur.name !== null && prev.name !== null && cur.name !== prev.name) {
    return `[玩具] ${serveName}把${zone}的${cnOf(prev.name)}换成了${cnOf(cur.name)}`;
  }
  if (cur.name !== null && cur.intensity !== prev.intensity) {
    const itemCN = cnOf(cur.name);
    // prev 是"关"（null 或 <0，BC 里 -1=关）→ 这次是从关到开，应说"开始震动"，而不是"调高"
    if (prev.intensity === null || prev.intensity < 0) {
      return `[玩具] ${serveName}的${itemCN}开始震动了（${intensityCN(cur.intensity ?? 0)}）`;
    }
    if (cur.intensity === null || cur.intensity < 0) {
      return `[玩具] ${serveName}把${itemCN}的震动关掉了`;
    }
    if (cur.intensity > prev.intensity) {
      return `[玩具] ${serveName}把${itemCN}的震动调高了（现在${intensityCN(cur.intensity)}）`;
    }
    return `[玩具] ${serveName}把${itemCN}的震动调低了（现在${intensityCN(cur.intensity)}）`;
  }
  return null;
}

/** 温和触碰部位：与"人设不描写露骨性行为"对齐，只开放日常/安全部位 */
const SAFE_TOUCH_ZONES = new Set([
  "ItemHead",
  "ItemNose",
  "ItemEars",
  "ItemNeck",
  "ItemArms",
  "ItemHands",
  "ItemTorso",
  "ItemLegs",
  "ItemFeet",
  "ItemBoots",
]);

// ---------------------------------------------------------------------------
// 动作白名单（BOT 可以对服务对象使用的 ChatOther 动作）
// zones 已与官方 targets 求过交集，并再与安全部位求交集
// ---------------------------------------------------------------------------

export interface ActivitySkillDef {
  cn: string;
  zones: string[];
}

const ACTIVITY_SKILLS: Record<string, ActivitySkillDef> = {
  Pet: { cn: "摸摸头/拍拍头", zones: ["ItemHead", "ItemNose"] },
  Rub: { cn: "揉揉", zones: ["ItemHead", "ItemNose"] },
  Caress: { cn: "轻抚", zones: ["ItemHead", "ItemEars", "ItemNeck", "ItemArms", "ItemHands", "ItemTorso", "ItemLegs", "ItemFeet"] },
  Tickle: { cn: "挠痒", zones: ["ItemNeck", "ItemArms", "ItemTorso", "ItemLegs", "ItemFeet"] },
  MassageHands: { cn: "按摩", zones: ["ItemNeck", "ItemArms", "ItemTorso", "ItemLegs", "ItemFeet"] },
  TakeCare: { cn: "照料/呵护", zones: ["ItemHead", "ItemHands", "ItemBoots"] },
  Cuddle: { cn: "搂抱/贴贴", zones: ["ItemArms", "ItemNose"] },
  Kiss: { cn: "轻吻", zones: ["ItemHead", "ItemEars", "ItemNeck", "ItemArms", "ItemHands", "ItemLegs", "ItemFeet"] },
  PoliteKiss: { cn: "吻手背（礼仪之吻）", zones: ["ItemHands"] },
  CollarGrab: { cn: "轻拽项圈", zones: ["ItemNeck"] },
  GagKiss: { cn: "隔着口塞亲昵（仅当对方戴口塞）", zones: ["ItemMouth"] },
};

// ---------------------------------------------------------------------------
// #54 手持道具（ItemHandheld 组，源码 Assets_Female3DCG.js 提取，2026-09-06）
// 拿起/放下走 handheld_take / handheld_drop；道具动作（SpankItem 等）须手持
// 对应道具（allow 包含该动作）才能执行——执行器会自动先拿道具。
// PenetrateItem 属强 NSFW 暂不开放（随 #53 一起）。
// ---------------------------------------------------------------------------

export interface HandheldDef {
  cn: string;
  /** 支持的手持动作（空数组=纯视觉道具，只能拿不能用于动作） */
  allow: string[];
}

export const HANDHELD_ITEMS: Record<string, HandheldDef> = {
  KeyProp: { cn: "钥匙", allow: ["Inject"] },
  MedicalInjector: { cn: "医用注射器", allow: ["Inject"] },
  Crop: { cn: "硬鞭", allow: ["SpankItem", "RubItem"] },
  Flogger: { cn: "鞭笞", allow: ["SpankItem", "RubItem"] },
  Cane: { cn: "手杖", allow: ["SpankItem", "RubItem"] },
  HeartCrop: { cn: "心形硬鞭", allow: ["SpankItem", "RubItem"] },
  Paddle: { cn: "板子", allow: ["SpankItem", "RubItem"] },
  CustomPaddle: { cn: "皮革拍子", allow: ["SpankItem", "RubItem"] },
  WhipPaddle: { cn: "板鞭", allow: ["SpankItem", "RubItem"] },
  Whip: { cn: "皮鞭", allow: ["SpankItem", "RubItem"] },
  CattleProd: { cn: "赶牛棒", allow: ["ShockItem"] },
  TennisRacket: { cn: "网球拍", allow: ["SpankItem", "RubItem"] },
  ForSaleSign: { cn: "待售标志", allow: ["SpankItem", "RubItem"] },
  RainbowWand: { cn: "彩虹魔杖", allow: ["SpankItem", "RubItem"] },
  Gavel: { cn: "木槌", allow: ["SpankItem", "RubItem"] },
  Feather: { cn: "羽毛", allow: ["TickleItem"] },
  FeatherDuster: { cn: "羽毛掸", allow: ["TickleItem"] },
  LongDuster: { cn: "长鸡毛掸", allow: ["TickleItem"] },
  IceCube: { cn: "冰块", allow: ["RubItem"] },
  Diaper: { cn: "纸尿裤", allow: [] },
  BabyPowder: { cn: "爽身粉", allow: ["RollItem"] },
  Wipes: { cn: "湿巾", allow: ["RollItem"] },
  WartenbergWheel: { cn: "刺轮", allow: ["RollItem"] },
  VibratingWand: { cn: "振动按摩棒", allow: ["MasturbateItem", "RubItem"] },
  SmallVibratingWand: { cn: "小振动棒", allow: ["MasturbateItem", "RubItem"] },
  CandleWax: { cn: "蜡烛", allow: ["PourItem"] },
  LargeDildo: { cn: "大假阳具", allow: ["MasturbateItem", "RubItem"] },
  PetToy: { cn: "逗猫棒", allow: ["TickleItem", "SpankItem"] },
  Vibrator: { cn: "振动棒", allow: ["MasturbateItem", "RubItem"] },
  Belt: { cn: "腰带", allow: ["SpankItem", "RubItem"] },
  Hairbrush: { cn: "梳子", allow: ["SpankItem", "BrushItem", "RubItem", "Scratch"] },
  SmallDildo: { cn: "小假阳具", allow: ["MasturbateItem", "RubItem"] },
  ElectricToothbrush: { cn: "电动牙刷", allow: ["TickleItem", "MasturbateItem"] },
  Toothbrush: { cn: "牙刷", allow: ["TickleItem"] },
  ShockWand: { cn: "电击棒", allow: ["ShockItem"] },
  Lotion: { cn: "洗液", allow: ["RubItem"] },
  Ruler: { cn: "尺子", allow: ["SpankItem", "RubItem"] },
  Sword: { cn: "泡沫剑", allow: ["SpankItem", "RubItem"] },
  VibeRemote: { cn: "振动玩具遥控器", allow: ["RubItem"] },
  ShockRemote: { cn: "电击遥控器", allow: ["RubItem"] },
  Towel: { cn: "浴巾", allow: ["SpankItem", "RubItem"] },
  RopeCoilLong: { cn: "长捆绳", allow: ["RubItem"] },
  RopeCoilShort: { cn: "短捆绳", allow: ["RubItem"] },
  Ballgag: { cn: "口球", allow: ["RubItem"] },
  LongSock: { cn: "长袜", allow: ["RubItem"] },
  Baguette: { cn: "法棍面包", allow: ["SpankItem"] },
  Panties: { cn: "内裤", allow: ["RubItem"] },
  TapeRoll: { cn: "胶带卷", allow: ["RubItem"] },
  Spatula: { cn: "菜铲", allow: ["SpankItem"] },
  Broom: { cn: "扫帚", allow: ["SpankItem"] },
  Phone1: { cn: "手机", allow: ["RubItem"] },
  Phone2: { cn: "手机 2", allow: ["RubItem"] },
  Scissors: { cn: "剪刀", allow: ["RubItem"] },
  PlasticWrap: { cn: "保鲜膜卷", allow: ["RubItem"] },
  GlassEmpty: { cn: "空玻璃杯", allow: ["RubItem"] },
  GlassFilled: { cn: "装液体的玻璃杯", allow: ["RubItem", "SipItem"] },
  PotionBottle: { cn: "药剂瓶", allow: ["RubItem"] },
  Mug: { cn: "马克杯", allow: ["RubItem", "SipItem"] },
  Popcorn: { cn: "爆米花", allow: ["EatItem", "ThrowItem"] },
  PortalTablet: { cn: "传送门连接平板", allow: ["RubItem"] },
  Shark: { cn: "鲨鱼布偶", allow: ["SpankItem", "RubItem"] },
  BunPlush: { cn: "兔兔布偶", allow: ["SpankItem", "RubItem"] },
  FoxPlush: { cn: "狐狸布偶", allow: ["SpankItem", "RubItem"] },
  Karl: { cn: "宠物石头", allow: [] },
  PetPotato: { cn: "宠物土豆", allow: ["RubItem"] },
  Smartphone: { cn: "智能手机", allow: ["RubItem"] },
  GlueTube: { cn: "无毒胶水", allow: [] },
  AnimeGirlWand: { cn: "角色扮演女孩能量法杖", allow: [] },
  Brick: { cn: "砖头", allow: ["SpankItem", "RubItem"] },
  Trowel: { cn: "抹子", allow: ["SpankItem", "RubItem"] },
  Kyosensu: { cn: "京扇子（きょせんす）", allow: ["RubItem"] },
  Uchiwa: { cn: "団扇（うちわ）", allow: ["RubItem"] },
  Plushie: { cn: "毛绒玩具", allow: ["SqueezeItem"] },
  Cigarette: { cn: "香烟", allow: ["RubItem"] },
  FoamRoll: { cn: "泡沫胶带卷", allow: ["SqueezeItem"] },
  MiniDolls: { cn: "Mini Dolls", allow: ["SqueezeItem"] },
  GiftBox: { cn: "Gift Box", allow: ["RubItem"] },
  DragonPlush: { cn: "Dragon Plush", allow: ["SpankItem", "RubItem"] },
  Chocolate: { cn: "Chocolate Bar", allow: ["EatItem"] },
  ElectricGuitar: { cn: "Electric Guitar", allow: [] },
  Laptop: { cn: "Laptop", allow: ["RubItem", "SpankItem"] },
  R18Baton: { cn: "Penis Baton", allow: ["RubItem", "SpankItem"] },
  CandyCane: { cn: "Candy Cane", allow: ["RubItem", "SpankItem"] },
  GrilledSausage: { cn: "Grilled Sausage", allow: ["EatItem"] },
  Foldingfan: { cn: "Folding fan", allow: ["SpankItem", "RubItem"] },
  Oilpaperumbrella: { cn: "Oil-Paper Umbrella", allow: [] },
};

export interface HandheldActivityDef {
  cn: string;
  zones: string[];
}

export const HANDHELD_ACTIVITIES: Record<string, HandheldActivityDef> = {
  SpankItem: { cn: "拍打", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemFeet", "ItemLegs", "ItemNipples", "ItemPelvis", "ItemTorso", "ItemVulva", "ItemVulvaPiercings"] },
  RubItem: { cn: "摩擦/抚摸", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemEars", "ItemFeet", "ItemHood", "ItemLegs", "ItemMouth", "ItemNeck", "ItemNipples", "ItemNose", "ItemPelvis", "ItemTorso", "ItemVulva", "ItemVulvaPiercings"] },
  TickleItem: { cn: "挠痒", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemEars", "ItemFeet", "ItemHood", "ItemLegs", "ItemMouth", "ItemNeck", "ItemNipples", "ItemNose", "ItemPelvis", "ItemTorso", "ItemVulva", "ItemVulvaPiercings"] },
  BrushItem: { cn: "梳头", zones: ["ItemHead"] },
  SqueezeItem: { cn: "挤压", zones: ["ItemHands"] },
  RollItem: { cn: "滚动", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemEars", "ItemFeet", "ItemLegs", "ItemMouth", "ItemNeck", "ItemNipples", "ItemPelvis", "ItemTorso"] },
  EatItem: { cn: "喂食", zones: ["ItemMouth"] },
  SipItem: { cn: "喂饮", zones: ["ItemMouth"] },
  PourItem: { cn: "倾倒/滴落", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemFeet", "ItemLegs", "ItemNipples", "ItemPelvis", "ItemTorso"] },
  Inject: { cn: "注射", zones: ["ItemArms", "ItemBreast", "ItemButt", "ItemFeet", "ItemLegs", "ItemNeck"] },
  ShockItem: { cn: "电击", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemFeet", "ItemLegs", "ItemNeck", "ItemNipples", "ItemPelvis", "ItemTorso", "ItemVulva", "ItemVulvaPiercings"] },
  MasturbateItem: { cn: "刺激敏感部位", zones: ["ItemBreast", "ItemButt", "ItemFeet", "ItemLegs", "ItemNipples", "ItemPelvis", "ItemVulva", "ItemVulvaPiercings"] },
  ThrowItem: { cn: "投掷", zones: ["ItemHead", "ItemMouth", "ItemBreast", "ItemTorso", "ItemFeet"] },
  Scratch: { cn: "轻挠", zones: ["ItemArms", "ItemBoots", "ItemBreast", "ItemButt", "ItemEars", "ItemFeet", "ItemHands", "ItemHead", "ItemLegs", "ItemMouth", "ItemNeck", "ItemNipples", "ItemNose", "ItemPelvis", "ItemTorso"] },
};
/** 校验手持道具名；返回定义（ok=false 表示不在 86 件白名单里） */
export function checkHandheld(name: string): { ok: boolean; def?: HandheldDef; reason?: string } {
  const def = HANDHELD_ITEMS[name];
  if (!def) return { ok: false, reason: `handheld item "${name}" not in whitelist` };
  return { ok: true, def };
}

/** 手持道具中文名（白名单外回原名） */
export function handheldCN(name: string | null | undefined): string {
  if (!name) return "徒手";
  return HANDHELD_ITEMS[name]?.cn ?? name;
}

/** 校验手持道具动作；道具动作必须由 BOT 手持 allow 含该动作的道具才可执行 */
export function checkHandheldActivity(
  name: string,
  zone?: string
): { ok: boolean; zones?: string[]; reason?: string } {
  const def = HANDHELD_ACTIVITIES[name];
  if (!def) return { ok: false, reason: `handheld activity "${name}" not in whitelist` };
  if (zone === undefined) return { ok: true, zones: def.zones };
  if (!def.zones.includes(zone)) return { ok: false, reason: `zone "${zone}" not allowed for ${name}` };
  return { ok: true };
}

/** 指定道具能否执行指定手持动作 */
export function handheldAllows(itemName: string, activityName: string): boolean {
  return (HANDHELD_ITEMS[itemName]?.allow ?? []).includes(activityName);
}

/** #54 口令匹配：中文/英文名 → 手持道具键。全等优先，其次子串最长匹配
 *  （"硬鞭"匹配 Crop 而不是被"鞭"字族的短名抢先）。 */
export function findHandheldByText(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  for (const [name, def] of Object.entries(HANDHELD_ITEMS)) {
    if (t === def.cn || t === name) return name;
  }
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, def] of Object.entries(HANDHELD_ITEMS)) {
    if (def.cn && t.includes(def.cn) && def.cn.length > bestLen) {
      best = name;
      bestLen = def.cn.length;
    }
  }
  return best;
}

/** 校验动作是否可用；zone 为空时返回该动作的全部可用部位 */
export function checkActivity(name: string, zone?: string): { ok: boolean; zones?: string[]; reason?: string } {
  const def = ACTIVITY_SKILLS[name];
  if (!def) return { ok: false, reason: `activity "${name}" not in whitelist` };
  const official = activityByName.get(name);
  if (!official) return { ok: false, reason: `activity "${name}" not found in catalog` };
  if (zone === undefined) return { ok: true, zones: def.zones };
  if (!def.zones.includes(zone)) return { ok: false, reason: `zone "${zone}" not allowed for ${name}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 姿势白名单（只能改 BOT 自己的姿势；数组组合规则来自官方 PoseSetActive）
// ---------------------------------------------------------------------------

export interface PoseSkillDef {
  cn: string;
  /** 发送给服务器的完整 Pose 数组 */
  pose: string[];
}

const POSE_SKILLS: Record<string, PoseSkillDef> = {
  StandUp: { cn: "站起来/恢复正常站立", pose: ["BaseUpper", "BaseLower"] },
  Kneel: { cn: "跪下", pose: ["BaseUpper", "Kneel"] },
  KneelingSpread: { cn: "跪着张开双腿", pose: ["BaseUpper", "KneelingSpread"] },
  Yoked: { cn: "双臂平展（枷锁式）", pose: ["Yoked", "BaseLower"] },
  OverTheHead: { cn: "双手举过头顶", pose: ["OverTheHead", "BaseLower"] },
  BackBoxTie: { cn: "双手背后反盒式", pose: ["BackBoxTie", "BaseLower"] },
  BackCuffs: { cn: "双手背后如戴铐", pose: ["BackCuffs", "BaseLower"] },
  LegsClosed: { cn: "双腿并拢站好", pose: ["BaseUpper", "LegsClosed"] },
  AllFours: { cn: "四肢着地趴好", pose: ["AllFours"] },
};

export function checkPose(name: string): { ok: boolean; pose?: string[]; reason?: string } {
  const def = POSE_SKILLS[name];
  if (!def) return { ok: false, reason: `pose "${name}" not in whitelist` };
  return { ok: true, pose: def.pose };
}

// ---------------------------------------------------------------------------
// 道具白名单（BOT 可以给服务对象穿/脱的道具；Name: null 表示脱下该部位）
// 注意：需要服务对象在游戏内给 BOT 授权（白名单/主人/恋人），否则服务器拒绝
// ---------------------------------------------------------------------------

export interface ItemSkillDef {
  group: string;
  cn: string;
}

/** TYPED 道具的变体（绑法/形态）定义。数据来源：Assets_Female3DCGExtended.js 官方源码 */
export interface ItemVariantDef {
  /** 选项名（wire 上 TypeRecord 的序号即此表顺序） */
  name: string;
  cn: string;
  /** 官方 BondageLevel：4+=冻结级、6+=悬吊级，高等级需对方明确要求 */
  level?: number;
  /** 变体自带的难度（写入 Property.Difficulty） */
  difficulty?: number;
  pose?: string[];
  effect?: string[];
  block?: string[];
  allowActivityOn?: string[];
  allowActivePose?: string[];
  prerequisite?: string[];
  /** 变体自带的 SelfUnlock（写入 Property.SelfUnlock）。手铐类 TYPED 道具的 Wrist 变体官方是 true（可自我解锁），
   *  Elbow/Both/Hogtie 是 false。上锁锁死时必须切到 false 变体，否则 TypedItemInit 会用变体定义覆盖回 true。 */
  selfUnlock?: boolean;
  /** 其他 Property 字段（如 OverridePriority） */
  extraProperty?: Record<string, unknown>;
}

const ITEM_SKILLS: Record<string, ItemSkillDef> = {
  // 项圈（颈部）
  LeatherCollar: { group: "ItemNeck", cn: "皮革项圈" },
  PetCollar: { group: "ItemNeck", cn: "宠物项圈" },
  PostureCollar: { group: "ItemNeck", cn: "姿势项圈" },
  HeartCollar: { group: "ItemNeck", cn: "心心项圈" },
  // 口塞（嘴部）
  BallGag: { group: "ItemMouth", cn: "口球" },
  BitGag: { group: "ItemMouth", cn: "硅胶口衔" },
  ClothGag: { group: "ItemMouth", cn: "布塞" },
  MuzzleGag: { group: "ItemMouth", cn: "口套" },
  PacifierGag: { group: "ItemMouth", cn: "奶嘴" },
  DuctTape: { group: "ItemMouth", cn: "胶带" },
  // 眼罩（头部）
  LeatherBlindfold: { group: "ItemHead", cn: "皮革眼罩" },
  ClothBlindfold: { group: "ItemHead", cn: "布料眼罩" },
  ScarfBlindfold: { group: "ItemHead", cn: "围巾眼罩" },
  SmallBlindfold: { group: "ItemHead", cn: "轻型眼罩" },
  // 手臂
  HempRope_Arms: { group: "ItemArms", cn: "麻绳（捆手臂）" },
  NylonRope_Arms: { group: "ItemArms", cn: "尼龙绳（捆手臂）" },
  LeatherCuffs: { group: "ItemArms", cn: "皮革手铐" },
  MetalCuffs: { group: "ItemArms", cn: "金属手铐" },
  // 单手套（手臂，全部可上锁）
  LeatherArmbinder: { group: "ItemArms", cn: "皮革单手套" },
  LatexArmbinder: { group: "ItemArms", cn: "乳胶单手套" },
  SeamlessLatexArmbinder: { group: "ItemArms", cn: "无缝乳胶单手套" },
  ShinyArmbinder: { group: "ItemArms", cn: "闪亮单手套（极难挣脱）" },
  // 拘束衣（手臂）
  StraitJacket: { group: "ItemArms", cn: "拘束衣" },
  LeatherStraitJacket: { group: "ItemArms", cn: "皮革拘束衣" },
  // 束带类（手臂）
  FullBodyLeatherHarness: { group: "ItemArms", cn: "全身皮革束带" },
  CollarCuffs: { group: "ItemArms", cn: "项圈连手铐（需对方已戴项圈）" },
  // 双腿
  HempRope_Legs: { group: "ItemLegs", cn: "麻绳（捆腿）" },
  NylonRope_Legs: { group: "ItemLegs", cn: "尼龙绳（捆腿）" },
  LeatherLegCuffs: { group: "ItemLegs", cn: "皮革腿铐" },
  // 双脚
  HempRope_Feet: { group: "ItemFeet", cn: "麻绳（捆脚）" },
  NylonRope_Feet: { group: "ItemFeet", cn: "尼龙绳（捆脚）" },
  LeatherAnkleCuffs: { group: "ItemFeet", cn: "皮革脚铐" },
  SteelAnkleCuffs: { group: "ItemFeet", cn: "钢质脚铐" },
  // 胯部
  HempRope_Pelvis: { group: "ItemPelvis", cn: "麻绳（胯绳）" },
  // 靴子
  BalletHeels: { group: "ItemBoots", cn: "芭蕾高跟鞋（锁足尖）" },
  // 牵引（颈缚）
  CollarLeash: { group: "ItemNeckRestraints", cn: "牵引绳" },
  ChainLeash: { group: "ItemNeckRestraints", cn: "牵引链" },
  // 颈饰挂件（#16 限时回家：宠物标牌）
  CustomCollarTag: { group: "ItemNeckAccessories", cn: "宠物标牌（可写字，戴在项圈上）" },
};

/** 每个白名单道具实际发送的（group, name）——去掉 _Arms/_Legs/_Feet/_Pelvis 这类区分后缀 */
const ITEM_SEND_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(ITEM_SKILLS).map(([key]) => [key, key.replace(/_(Arms|Legs|Feet|Pelvis)$/, "")])
);

export function checkItem(key: string): { ok: boolean; group?: string; name?: string; reason?: string } {
  const def = ITEM_SKILLS[key];
  if (!def) return { ok: false, reason: `item "${key}" not in whitelist` };
  const sendName = ITEM_SEND_NAME[key];
  const catalogItem = itemIndex.get(`${def.group}/${sendName}`);
  if (!catalogItem) return { ok: false, reason: `item "${def.group}/${sendName}" not found in catalog` };
  return { ok: true, group: def.group, name: sendName };
}

/** 反查：按 (槽位, 发送名) 找白名单道具键（如 ItemArms/LeatherCuffs → "LeatherCuffs"）。
 *  #16 套装快照重穿时用于复用 VARIANTS 的 SelfUnlock 防自解变体逻辑；白名单外返回 null。 */
export function findItemKeyByAsset(group: string, name: string): string | null {
  for (const [key, def] of Object.entries(ITEM_SKILLS)) {
    if (def.group === group && ITEM_SEND_NAME[key] === name) return key;
  }
  return null;
}

/**
 * BC 真实存在但 ITEM_SKILLS 道具表未覆盖的多层槽位（用于 item_remove 等）。
 * ITEM_SKILLS 只挂了主槽位的道具（外层口塞、外层腹部），但 服务对象 的口塞可能戴在
 * ItemMouth2/3 中间层（多层口塞设计），item_remove 必须能识别这些槽位。
 * 来源：Female3DCG.js 里的多重口塞/腹部 Asset 定义（ItemMouth/2/3、ItemTorso2 等）。
 */
const EXTRA_REMOVABLE_GROUPS = [
  "ItemMouth2", "ItemMouth3", "ItemTorso2",
  // #70（2026-09-06 02:58 实测事故）：LLM 按穿着摘要标签报 item_remove "下体"（ItemVulva）被拒——
  // ITEM_SKILLS 道具表只挂了束缚槽，情趣玩具槽全漏（她真实戴着振动阳具/跳蛋却"无法识别"，意图整条被丢弃）。
  // 补齐 ZONE_CN 其余 Item* 槽位：下体/乳首/臀/胸/躯干/头罩/双手/耳/鼻。
  // item_remove 执行器只脱"该组身上实际穿着的道具"，白名单放开无副作用。
  "ItemVulva", "ItemNipples", "ItemButt", "ItemBreast",
  "ItemTorso", "ItemHood", "ItemHands", "ItemEars", "ItemNose",
];

// ---------------------------------------------------------------------------
// #72 服装能力（Cloth 组，2026-09-06）：槽位级脱 + 精选款穿。
// 脱：item_remove 直接按槽位（CLOTHING_SLOTS 并入 REMOVABLE_SLOTS）；
// 穿：item_put 复用主路径（服装无锁/变体逻辑天然跳过，self-target 落库已有）。
// 不动槽位（与 GOHOME_STRIP_GROUPS 原则一致）：发型/眼镜/美甲/身体特征。
// ---------------------------------------------------------------------------

/** 服装槽位中文名（item_remove 的槽位白名单 + LLM prompt 用） */
export const CLOTHING_SLOTS: Record<string, string> = {
  Cloth: "上衣/连衣裙",
  ClothLower: "下装（裙/裤）",
  ClothOuter: "外套",
  ClothAccessory: "服装配饰",
  Bra: "内衣（文胸）",
  Corset: "束腰",
  Panties: "内裤",
  Suit: "连体紧身衣",
  SuitLower: "连体下装",
  Socks: "袜子（双腿）",
  SocksLeft: "左袜",
  SocksRight: "右袜",
  Shoes: "鞋",
  Gloves: "手套",
  Hat: "帽子",
  Mask: "面具/面纱",
  Necklace: "项链",
  Bracelet: "手环",
  Jewelry: "首饰",
  Garters: "吊袜带/腿环",
  TailStraps: "尾巴",
  Wings: "翅膀",
  HairAccessory1: "发饰",
  HairAccessory2: "发饰2",
  HairAccessory3: "发饰3",
  AnkletLeft: "左脚环",
  AnkletRight: "右脚环",
};

/** 服装精选穿戴表（键 = "组/资产名"，值 = 中文名）。catalog 796 件服装的代表款。 */
export const CLOTHING_ITEMS: Record<string, string> = {
  // 上衣/连衣裙
  "Cloth/TShirt1": "T恤", "Cloth/Blouse1": "衬衫", "Cloth/CropTop": "露腹短上衣",
  "Cloth/Sweater1": "毛衣", "Cloth/Hoodie": "舒适连帽衫", "Cloth/ChineseDress2": "旗袍",
  "Cloth/MaidOutfit1": "女仆装", "Cloth/MaidLatex": "乳胶女仆制服", "Cloth/NurseUniform": "护士服",
  "Cloth/EveningGown": "晚礼服", "Cloth/StudentOutfit3": "学生服上衣", "Cloth/MistressTop": "女王上衣",
  "Cloth/SummerDress": "夏日连衣裙", "Cloth/SlaveRags": "奴隶破布",
  // 下装
  "ClothLower/Jeans1": "牛仔裤", "ClothLower/Shorts1": "短裤", "ClothLower/GymShorts": "运动短裤",
  "ClothLower/PleatedSkirt": "百褶裙", "ClothLower/LongPleatedSkirt": "长百褶裙",
  "ClothLower/ShortPlaidSkirt": "格子短裙", "ClothLower/JeanSkirt": "牛仔裙",
  "ClothLower/LatexSkirt1": "乳胶裙", "ClothLower/Leggings2": "长打底裤", "ClothLower/PencilSkirt2": "铅笔裙",
  // 外套
  "ClothOuter/LabCoat": "白大褂", "ClothOuter/LeatherJacket": "皮革夹克",
  // 内衣
  "Bra/Bra1": "文胸", "Bra/SportBra": "运动文胸", "Bra/Bikini1": "褶边比基尼",
  "Bra/CuteBikini1": "可爱比基尼", "Bra/LatexBra1": "乳胶文胸", "Bra/BunnySuit": "兔女郎连体衣",
  "Bra/Sarashi1": "裹胸", "Bra/HarnessBra1": "束缚带文胸",
  // 内裤
  "Panties/Panties1": "内裤", "Panties/Panties15": "丁字裤", "Panties/MicroThong": "微型丁字裤",
  "Panties/Panties16": "褶边内裤", "Panties/KittyPanties1": "猫猫内裤",
  "Panties/LatexPanties2": "乳胶内裤", "Panties/CrotchPanties1": "无裆内裤", "Panties/Diapers1": "纸尿裤",
  // 束腰
  "Corset/Corset1": "束腰+吊袜带", "Corset/Corset2": "束腰", "Corset/LatexCorset1": "乳胶束腰",
  "Corset/TightCorset": "皮革紧身束腰",
  // 连体衣
  "Suit/LatexCatsuit": "乳胶紧身衣", "Suit/Catsuit": "紧身衣", "Suit/SeamlessCatsuit": "无缝紧身衣",
  "Suit/ReverseBunnySuit": "逆兔女郎装",
  // 袜
  "Socks/Socks1": "短袜", "Socks/Socks3": "过膝袜", "Socks/Stockings1": "黑过膝袜",
  "Socks/Stockings4": "渔网袜", "Socks/Pantyhose1": "丝袜", "Socks/LatexSocks1": "乳胶袜",
  // 鞋
  "Shoes/Heels1": "高跟鞋", "Shoes/StilettoHeels": "细高跟鞋", "Shoes/Boots1": "靴子",
  "Shoes/ThighBoots": "乳胶大腿靴", "Shoes/Sneakers1": "浅色运动鞋", "Shoes/BalletHeels1": "芭蕾高跟鞋",
  "Shoes/PonyBoots": "小马靴", "Shoes/AnkleStrapShoes": "踝带鞋",
  // 手套
  "Gloves/Gloves1": "短手套", "Gloves/Gloves2": "长手套", "Gloves/Gloves3": "丝手套",
  "Gloves/LatexShortGloves": "乳胶手套", "Gloves/FishnetGloves": "渔网手套", "Gloves/OperaGloves": "歌剧手套",
  // 帽子
  "Hat/MaidHairband1": "女仆发箍", "Hat/NurseCap": "护士帽", "Hat/WitchHat1": "女巫帽",
  "Hat/FlowerCrown": "花冠", "Hat/Tiara1": "头冠", "Hat/Crown1": "皇冠",
  "Hat/Beret1": "贝雷帽", "Hat/CowboyHat": "牛仔帽",
  // 面具
  "Mask/DominoMask": "多米诺面具", "Mask/FoxMask": "狐狸面具", "Mask/VenetianMask": "威尼斯面具",
  "Mask/PetNose": "宠物鼻", "Mask/KittyMask3": "猫猫全头面具",
  // 项链
  "Necklace/Necklace1": "精制项链", "Necklace/PearlNecklace1": "珍珠项链",
  "Necklace/ElegantHeartNecklace": "典雅心形项链", "Necklace/BodyChainNecklace": "身体项链",
  "Necklace/RosePendant": "玫瑰吊坠", "Necklace/FurScarf": "毛绒围巾",
  // 尾巴
  "TailStraps/FoxTailsStrap": "穿戴式狐尾", "TailStraps/KittenTailStrap1": "穿戴浅色猫尾",
  "TailStraps/BunnyTailStrap": "穿戴兔子尾巴", "TailStraps/HorseTailStrap1": "马尾",
  "TailStraps/PuppyTailStrap1": "穿戴软小狗尾", "TailStraps/SuccubusTailStrap": "穿戴魅魔尾",
  // 翅膀
  "Wings/AngelWings": "天使之翼", "Wings/DevilWings": "恶魔之翼",
  "Wings/FairyWings": "精灵之翼", "Wings/BatWings": "蝙蝠翅膀",
  // 发饰
  "HairAccessory1/BunnyEars1": "兔耳", "HairAccessory1/KittenEars2": "浅色猫耳",
  "HairAccessory1/FoxEars2": "狐耳", "HairAccessory1/Halo": "光环",
  "HairAccessory1/Horns4": "角", "HairAccessory1/WeddingVeil1": "婚礼面纱",
  "HairAccessory1/HairFlower1": "花", "HairAccessory1/Ribbons1": "发带",
  // 吊袜带/腿环
  "Garters/GarterBelt2": "皮革吊袜带", "Garters/GarterBelt3": "蕾丝缎面吊袜带", "Garters/XLegStraps": "X腿带",
};

/** 校验服装键（"Cloth/TShirt1"）；ok 时返回 {group, name, cn} */
export function checkClothing(key: string): { ok: boolean; group?: string; name?: string; cn?: string; reason?: string } {
  const cn = CLOTHING_ITEMS[key];
  if (!cn) {
    // 兼容 LLM 只报名字不带组前缀（"TShirt1" / "旗袍"）：全表反查唯一匹配
    const byName = Object.entries(CLOTHING_ITEMS).filter(([k]) => k.split("/")[1] === key);
    if (byName.length === 1) {
      const [k, v] = byName[0];
      return { ok: true, group: k.split("/")[0], name: k.split("/")[1], cn: v };
    }
    return { ok: false, reason: `clothing "${key}" not in whitelist` };
  }
  const [group, name] = key.split("/");
  return { ok: true, group, name, cn };
}

/** 按中文/英文模糊匹配服装（口令"换上旗袍"→ Cloth/ChineseDress2）；最长匹配优先 */
export function findClothingByText(text: string): { key: string; cn: string } | null {
  let best: { key: string; cn: string } | null = null;
  for (const [key, cn] of Object.entries(CLOTHING_ITEMS)) {
    if (text.includes(cn) || text.includes(key.split("/")[1])) {
      if (!best || cn.length > best.cn.length) best = { key, cn };
    }
  }
  return best;
}

/** 服装槽位中文名（zoneCN 的服装版；槽位白名单外返回原名） */
export function clothingSlotCN(slot: string): string {
  return CLOTHING_SLOTS[slot] ?? slot;
}

/** 可脱下的道具槽位（item_remove 用）——束缚槽位 + 服装槽位 */
export const REMOVABLE_SLOTS = [
  ...new Set([
    ...Object.values(ITEM_SKILLS).map((d) => d.group),
    ...EXTRA_REMOVABLE_GROUPS,
    ...Object.keys(CLOTHING_SLOTS),
  ]),
];

/**
 * slot 别名归一化：LLM 输出的槽位名五花八门（中文"嘴部"/"口塞"、英文 "mouth"/"gag"），
 * 统一映射到标准槽位 group。认不出来返回 null（调用方负责拒绝并给用户解释）。
 */
const SLOT_ALIAS: Record<string, string> = {
  // 中文名反查（ZONE_CN 的反向映射）
  ...Object.fromEntries(Object.entries(ZONE_CN).map(([group, cn]) => [cn, group])),
  // 常见道具类别中文别名（LLM 更常说道具名而非部位名）
  嘴部: "ItemMouth", 外层口塞: "ItemMouth", 中层口塞: "ItemMouth2", 内层口塞: "ItemMouth3",
  口塞: "ItemMouth", 嘴塞: "ItemMouth", 口球: "ItemMouth", 塞嘴: "ItemMouth",
  项圈: "ItemNeck", 颈圈: "ItemNeck",
  眼罩: "ItemHead", 蒙眼: "ItemHead", 头套: "ItemHood",
  手臂束缚: "ItemArms", 捆手: "ItemArms", 绑手: "ItemArms", 手臂绳: "ItemArms", 单手套: "ItemArms", 拘束衣: "ItemArms",
  捆腿: "ItemLegs", 绑腿: "ItemLegs", 腿绳: "ItemLegs", 腿铐: "ItemLegs",
  捆脚: "ItemFeet", 绑脚: "ItemFeet", 脚绳: "ItemFeet", 脚铐: "ItemFeet",
  胯绳: "ItemPelvis",
  牵引绳: "ItemNeckRestraints", 拴绳: "ItemNeckRestraints",
  宠物标牌: "ItemNeckAccessories", 标牌: "ItemNeckAccessories", 颈饰: "ItemNeckAccessories", 挂件: "ItemNeckAccessories",
  高跟鞋: "ItemBoots", 靴子: "ItemBoots",
  // #72 服装槽位中文别名（束缚别名优先，以上不覆盖；鞋的束缚槽是 ItemBoots，服装鞋说"鞋子/鞋"）
  上衣: "Cloth", 衣服: "Cloth", 连衣裙: "Cloth", 衬衣: "Cloth", 毛衣: "Cloth",
  裙子: "ClothLower", 裤子: "ClothLower", 下装: "ClothLower", 短裤: "ClothLower",
  外套: "ClothOuter", 大衣: "ClothOuter",
  内衣: "Bra", 文胸: "Bra", 胸罩: "Bra", 胸衣: "Bra",
  束腰: "Corset",
  内裤: "Panties", 底裤: "Panties",
  连体衣: "Suit", 紧身衣: "Suit", 猫装: "Suit",
  袜子: "Socks", 袜: "Socks", 丝袜: "Socks", 左袜: "SocksLeft", 右袜: "SocksRight",
  鞋子: "Shoes", 鞋: "Shoes",
  手套: "Gloves",
  帽子: "Hat", 帽: "Hat",
  面具: "Mask", 面纱: "Mask",
  项链: "Necklace",
  手环: "Bracelet", 手镯: "Bracelet",
  首饰: "Jewelry",
  吊袜带: "Garters", 腿环: "Garters", 袜带: "Garters",
  尾巴: "TailStraps",
  翅膀: "Wings",
  发饰: "HairAccessory1", 发卡: "HairAccessory1", 兽耳: "HairAccessory1", 兔耳: "HairAccessory1", 猫耳: "HairAccessory1",
  脚环: "AnkletLeft",
  // 常见英文别名（小写）
  mouth: "ItemMouth", gag: "ItemMouth", muzzlegag: "ItemMouth",
  collar: "ItemNeck", neck: "ItemNeck",
  blindfold: "ItemHead", head: "ItemHead", eyes: "ItemHead", hood: "ItemHood",
  arms: "ItemArms", armbinder: "ItemArms", hands: "ItemHands",
  legs: "ItemLegs", feet: "ItemFeet", boots: "ItemBoots", shoes: "ItemBoots",
  torso: "ItemTorso", breast: "ItemBreast", vulva: "ItemVulva",
  ears: "ItemEars", nose: "ItemNose",
};

export function normalizeSlot(input: string): string | null {
  const s = input.trim();
  if (REMOVABLE_SLOTS.includes(s)) return s;
  const alias = SLOT_ALIAS[s.toLowerCase()];
  if (alias && REMOVABLE_SLOTS.includes(alias)) return alias;
  // 部分匹配：LLM 可能输出 "口塞槽"/"ItemMouth 槽" 之类
  for (const group of REMOVABLE_SLOTS) {
    if (s.toLowerCase() === group.toLowerCase()) return group;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TYPED 道具变体表（绑法/形态切换）。数据逐条转录自官方
// Assets_Female3DCGExtended.js，顺序即 wire 上 TypeRecord 的序号（0 起）。
// ---------------------------------------------------------------------------

const POSE_ALL_KNEELING = ["Kneel", "KneelingSpread"];

const VARIANTS: Record<string, ItemVariantDef[]> = {
  // ---- 麻绳 · 手臂（18 种，TypeRecord 键统一为 "typed"）----
  HempRope_Arms: [
    { name: "WristTie", cn: "手腕捆绑", level: 1, difficulty: 1, pose: ["BackBoxTie"] },
    { name: "BoxTie", cn: "盒式捆绑（后手）", level: 1, difficulty: 1, pose: ["BackBoxTie"] },
    { name: "CrossedBoxtie", cn: "交叉盒式", level: 1, difficulty: 1, pose: ["BackBoxTie"] },
    { name: "RopeCuffsBack", cn: "后位绳铐", level: 1, difficulty: 1, pose: ["BackCuffs"], extraProperty: { OverridePriority: 29 } },
    { name: "WristElbowTie", cn: "腕肘并绑", level: 2, difficulty: 2, pose: ["BackElbowTouch"] },
    { name: "SimpleHogtie", cn: "简易驷马", level: 2, difficulty: 2, pose: ["Hogtied"] },
    { name: "TightBoxtie", cn: "紧身盒式", level: 3, difficulty: 3, pose: ["BackBoxTie"] },
    { name: "WristElbowHarnessTie", cn: "腕肘束带绑", level: 3, difficulty: 3, pose: ["BackElbowTouch"] },
    { name: "KneelingHogtie", cn: "跪姿驷马（冻结）", level: 4, difficulty: 3, pose: ["Kneel", "BackElbowTouch"], effect: ["Freeze"], block: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivePose: [...POSE_ALL_KNEELING] },
    { name: "Hogtied", cn: "标准驷马（冻结）", level: 4, difficulty: 3, pose: ["Hogtied"], effect: ["Freeze"], block: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet"] },
    { name: "AllFours", cn: "四肢着地", level: 6, difficulty: 3, pose: ["AllFours"], block: ["ItemLegs", "ItemFeet"], allowActivityOn: ["ItemLegs", "ItemFeet"] },
    { name: "BedSpreadEagle", cn: "床上大字绑", level: 1, difficulty: 5, pose: ["Yoked"], effect: ["Freeze"], block: ["ItemDevices"], prerequisite: ["OnBed"] },
    { name: "SuspensionKneelingHogtie", cn: "悬吊跪驷马", level: 6, difficulty: 6, pose: ["Kneel", "BackElbowTouch"], effect: ["Freeze", "Suspended"], block: ["ItemHands", "ItemLegs", "ItemFeet", "ItemBoots"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet", "ItemBoots"], allowActivePose: [...POSE_ALL_KNEELING] },
    { name: "SuspensionHogtied", cn: "悬吊驷马", level: 8, difficulty: 6, pose: ["Hogtied"], effect: ["Freeze", "Suspended"], block: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet"] },
    { name: "SuspensionAllFours", cn: "悬吊四肢着地", level: 8, difficulty: 6, pose: ["AllFours"], effect: ["Freeze", "Suspended"], block: ["ItemLegs", "ItemFeet", "ItemDevices"], allowActivityOn: ["ItemLegs", "ItemFeet"] },
    { name: "InvertedSuspensionHogtied", cn: "倒吊驷马", level: 8, difficulty: 6, pose: ["Hogtied", "Suspension"], effect: ["Freeze", "Suspended"], block: ["ItemHands", "ItemLegs", "ItemFeet", "ItemBoots"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet", "ItemBoots"] },
    { name: "InvertedSuspensionAllFours", cn: "倒吊四肢着地", level: 8, difficulty: 6, pose: ["AllFours", "Suspension"], effect: ["Freeze", "Suspended"], block: ["ItemLegs", "ItemFeet", "ItemBoots", "ItemDevices"], allowActivityOn: ["ItemLegs", "ItemFeet", "ItemBoots"] },
    { name: "RopeCuffsFront", cn: "前位绳铐（可牵引）", difficulty: 1, pose: ["BaseUpper"], effect: ["Leash"] },
  ],
  // ---- 麻绳 · 双腿（6 种）----
  HempRope_Legs: [
    { name: "Basic", cn: "基础并腿绑", difficulty: 1, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "FullBinding", cn: "密缠并腿", level: 2, difficulty: 2, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Link", cn: "短距链绑", level: 2, difficulty: 2, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Frogtie", cn: "蛙式绑（跪折腿）", level: 3, difficulty: 3, pose: ["Kneel"], allowActivePose: ["Kneel", "KneelingSpread", "Hogtied", "AllFours"] },
    { name: "Crossed", cn: "交叉腿绑", level: 4, difficulty: 4, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Mermaid", cn: "美人鱼绑（并腿缠裹）", level: 4, difficulty: 4, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
  ],
  // ---- 麻绳 · 双脚（7 种）----
  HempRope_Feet: [
    { name: "Basic", cn: "基础踝绑", difficulty: 1, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "FullBinding", cn: "密缠脚绑", level: 2, difficulty: 2, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Link", cn: "短距脚链", level: 2, difficulty: 2, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Diamond", cn: "菱形缠绑", level: 4, difficulty: 4, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Mermaid", cn: "美人鱼脚绑", level: 4, difficulty: 4, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Suspension", cn: "悬吊脚绑", level: 6, difficulty: 6, pose: ["LegsClosed", "Suspension"] },
    { name: "BedSpreadEagle", cn: "床上大字（脚）", level: 1, difficulty: 5, pose: ["Spread"], block: ["ItemDevices"], prerequisite: ["OnBed"] },
  ],
  // ---- 麻绳 · 胯部（4 种）----
  HempRope_Pelvis: [
    { name: "Crotch", cn: "裆绳", difficulty: 1, effect: ["CrotchRope"] },
    { name: "OverPanties", cn: "外置裆绳", difficulty: 1, effect: ["CrotchRope"], extraProperty: { OverridePriority: 21 } },
    { name: "SwissSeat", cn: "瑞士座骑绑", level: 4, difficulty: 4 },
    { name: "KikkouHip", cn: "龟甲绑", level: 5, difficulty: 5 },
  ],
  // ---- 尼龙绳 · 手臂（10 种，TypeRecord 键统一为 "typed"，与麻绳序号不同！）----
  NylonRope_Arms: [
    { name: "WristTie", cn: "手腕捆绑", difficulty: 1, pose: ["BackBoxTie"] },
    { name: "BoxTie", cn: "盒式捆绑（后手）", difficulty: 1, pose: ["BackBoxTie"] },
    { name: "WristElbowTie", cn: "腕肘并绑", level: 2, difficulty: 2, pose: ["BackElbowTouch"] },
    { name: "SimpleHogtie", cn: "简易驷马", level: 2, difficulty: 2, pose: ["Hogtied"] },
    { name: "TightBoxtie", cn: "紧身盒式", level: 3, difficulty: 3, pose: ["BackBoxTie"] },
    { name: "WristElbowHarnessTie", cn: "腕肘束带绑", level: 3, difficulty: 3, pose: ["BackElbowTouch"] },
    { name: "KneelingHogtie", cn: "跪姿驷马（冻结）", level: 4, difficulty: 3, pose: ["Kneel", "BackElbowTouch"], effect: ["Freeze"], block: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivePose: [...POSE_ALL_KNEELING] },
    { name: "Hogtied", cn: "标准驷马（冻结）", level: 4, difficulty: 3, pose: ["Hogtied"], effect: ["Freeze"], block: ["ItemHands", "ItemLegs", "ItemFeet"], allowActivityOn: ["ItemHands", "ItemLegs", "ItemFeet"] },
    { name: "AllFours", cn: "四肢着地", level: 6, difficulty: 3, pose: ["AllFours"], block: ["ItemLegs", "ItemFeet"], allowActivityOn: ["ItemLegs", "ItemFeet"] },
    { name: "BedSpreadEagle", cn: "床上大字绑", level: 1, difficulty: 5, pose: ["Yoked"], effect: ["Freeze"], block: ["ItemDevices"], prerequisite: ["OnBed"] },
  ],
  // ---- 尼龙绳 · 双腿（4 种）----
  NylonRope_Legs: [
    { name: "Knees", cn: "膝绑", difficulty: 1, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Thighs", cn: "腿绑", difficulty: 1, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "KneesThighs", cn: "膝腿并绑", difficulty: 2, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Frogtie", cn: "蛙式绑（跪折腿）", level: 3, difficulty: 3, pose: ["Kneel"], allowActivePose: [...POSE_ALL_KNEELING, "AllFours", "Hogtied"] },
  ],
  // ---- 尼龙绳 · 双脚（4 种）----
  NylonRope_Feet: [
    { name: "Ankles", cn: "踝绑", difficulty: 1, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Knees", cn: "膝绑", difficulty: 1, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "AnklesKnees", cn: "踝膝并绑", difficulty: 2, pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "BedSpreadEagle", cn: "床上大字（脚）", level: 1, difficulty: 5, pose: ["Spread"], block: ["ItemDevices"], prerequisite: ["OnBed"] },
  ],
  // ---- 单手套（3 种：加肩带 = Strap/WrapStrap）----
  LeatherArmbinder: [
    { name: "None", cn: "无肩带", difficulty: 0 },
    { name: "Strap", cn: "加肩带", difficulty: 3 },
    { name: "WrapStrap", cn: "加缠绕肩带", difficulty: 3 },
  ],
  // ---- "TYPED 默认变体陷阱"道具的变体 Effect 表（只读，不参与 buildVariantProperty）
  //    背景：BC 多个多形态束缚道具的默认变体（None）只有外观、毫无 Effect，而真束缚在 Wrist/Elbow 等变体里。
  //    BOT 之前并未把这些"陷阱道具"登记到 VARIANTS（因为自己不需要切它们的变体），导致
  //    collectEffects 反查变体 Effect 时无据可依——结果当用户在 BC UI 里切换变体（如皮革手铐
  //    由 None → Wrist），即使服务器同步下发 Property.Effect 含 Block，synthesis 也可能因
  //    服务器简化推送而丢失 Effect。补救：把这些道具的变体 effect:[] 也登到 VARIANTS，
  //    collectEffects 反向 fallback 一下，从而即使 Property.Effect 不带 Effect 也能正确判定。
  //    数据来源：bc-fetch/Female3DCGExtended.js（Assets_Female3DCGExtended.js 同步）。
  LeatherCuffs: [
    { name: "None", cn: "默认（无束缚）", difficulty: 0, selfUnlock: true },
    { name: "Wrist", cn: "腕缚（背扣）", difficulty: 2, effect: ["Block", "BlockWardrobe"], selfUnlock: true },
    { name: "Elbow", cn: "肘缚", difficulty: 4, effect: ["Block", "BlockWardrobe", "NotSelfPickable"], selfUnlock: false },
    { name: "Both", cn: "双腕肘缚", difficulty: 6, effect: ["Block", "BlockWardrobe", "NotSelfPickable"], selfUnlock: false },
    { name: "Hogtie", cn: "驷马缚", difficulty: 6, effect: ["Block", "BlockWardrobe", "Freeze", "NotSelfPickable"], block: ["ItemHands", "ItemLegs", "ItemFeet"], selfUnlock: false },
  ],
  // SteelCuffs 官方是 CopyConfig:{AssetName:"LeatherCuffs"}，继承全套变体（含 SelfUnlock），
  // 这里同步登记 selfUnlock 字段，上锁时同样切到 false 变体。
  SteelCuffs: [
    { name: "None", cn: "默认（无束缚）", selfUnlock: true },
    { name: "Wrist", cn: "腕缚（背扣）", effect: ["Block", "BlockWardrobe"], selfUnlock: true },
    { name: "Elbow", cn: "肘缚", effect: ["Block", "BlockWardrobe", "NotSelfPickable"], selfUnlock: false },
    { name: "Both", cn: "双腕肘缚", effect: ["Block", "BlockWardrobe", "NotSelfPickable"], selfUnlock: false },
    { name: "Hogtie", cn: "驷马缚", effect: ["Block", "BlockWardrobe", "Freeze", "NotSelfPickable"], block: ["ItemHands", "ItemLegs", "ItemFeet"], selfUnlock: false },
  ],
  FuturisticCuffs: [
    { name: "None", cn: "默认（无束缚）", difficulty: 0, selfUnlock: true },
    { name: "Wrist", cn: "腕缚", difficulty: 2, effect: ["Block", "BlockWardrobe"], selfUnlock: true },
    { name: "Elbow", cn: "肘缚", difficulty: 4, effect: ["Block", "BlockWardrobe", "NotSelfPickable"], selfUnlock: false },
    { name: "Both", cn: "双腕肘缚", difficulty: 6, effect: ["Block", "BlockWardrobe", "NotSelfPickable"], selfUnlock: false },
  ],
  // LeatherLegCuffs：官方 TYPED 三档（Female3DCGExtended.js:18832）。
  // Closed=踝并缚（双腿并拢+减速+不能换衣）；Chained=连接锁链（双踝间拖一条锁链，仅减速+强制站姿 BaseLower）。
  // 2026-09-04 #21 修：之前 Chained 错写为 Block+BlockWardrobe（与官方不符），对齐官方 Effect。
  LeatherLegCuffs: [
    { name: "None", cn: "默认（无束缚）", difficulty: 0 },
    { name: "Closed", cn: "踝并缚", difficulty: 6, effect: ["BlockWardrobe", "Slow"] },
    { name: "Chained", cn: "连接锁链", difficulty: 0, effect: ["Slow"] },
  ],
  SteelAnkleCuffs: [
    { name: "None", cn: "默认（无束缚）", difficulty: 0 },
    { name: "Closed", cn: "踝并缚", difficulty: 6, effect: ["BlockWardrobe", "Freeze"], pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Chained", cn: "连接锁链", difficulty: 0, effect: ["Slow"] },
  ],
  // 皮革脚铐（复制自 SteelAnkleCuffs 配置，变体完全一致）：None/Closed(踝并缚)/Chained(连接锁链)。
  // 2026-09-04 #21 用户指示脚铐改「连接锁链」Chained 变体。
  LeatherAnkleCuffs: [
    { name: "None", cn: "默认（无束缚）", difficulty: 0 },
    { name: "Closed", cn: "踝并缚", difficulty: 6, effect: ["BlockWardrobe", "Freeze"], pose: ["LegsClosed"], allowActivePose: ["Kneel"] },
    { name: "Chained", cn: "连接锁链", difficulty: 0, effect: ["Slow"] },
  ],
  // ItemNeck: RuffledCollar / SmoothLeatherCollar 等多数 collar TYPED 道具的 None 变体
  // 是纯装饰。常见变体 Choker / LockedChoker / Leash 才会带 Leash / Block 项圈锁。
  // 保守起见只登记变体 effect 不强行写全表——只列被实测触发过"无束缚陷阱"的几条。
  // ---- 闪亮单手套（4 种形态，纯外观无属性差异）----
  ShinyArmbinder: [
    { name: "Armbinder", cn: "标准式" },
    { name: "Hard", cn: "硬质式" },
    { name: "Reverse", cn: "反向式" },
    { name: "Xcross", cn: "交叉X式" },
  ],
  // ---- 拘束衣（4 档松紧即形态）----
  StraitJacket: [
    { name: "Loose", cn: "宽松", difficulty: 0 },
    { name: "Normal", cn: "标准", difficulty: 3 },
    { name: "Snug", cn: "贴身", difficulty: 6 },
    { name: "Tight", cn: "紧身", difficulty: 9 },
  ],
  LeatherStraitJacket: [
    { name: "Loose", cn: "宽松", difficulty: 0 },
    { name: "Normal", cn: "标准", difficulty: 3 },
    { name: "Snug", cn: "贴身", difficulty: 6 },
    { name: "Tight", cn: "紧身", difficulty: 9 },
  ],
  CollarCuffs: [
    { name: "Loose", cn: "宽松", difficulty: 0 },
    { name: "Normal", cn: "标准", difficulty: 3 },
    { name: "Snug", cn: "贴身", difficulty: 6 },
    { name: "Tight", cn: "紧身", difficulty: 9 },
  ],
  // ---- 口球（3 种形态：纯外观，默认 Normal）----
  // 来源：Female3DCGExtended.js BallGag { Archetype: TYPED, Options: [Normal, Shiny, Tight] }。
  // 口球是 TYPED 道具，戴上时必须带 TypeRecord，否则接收端缺变体信息、锁会被回滚（2026-09-04 实测）。
  BallGag: [
    { name: "Normal", cn: "标准", difficulty: 0 },
    { name: "Shiny", cn: "亮面", difficulty: 0 },
    { name: "Tight", cn: "加厚", difficulty: 0 },
  ],
};

/** 查道具的变体表（无变体返回 undefined） */
export function getItemVariants(itemKey: string): ItemVariantDef[] | undefined {
  return VARIANTS[itemKey];
}

/** 校验变体名，返回其在表中的序号（即 TypeRecord 值） */
export function checkVariant(itemKey: string, variantName: string): { ok: boolean; index?: number; def?: ItemVariantDef; reason?: string } {
  const variants = VARIANTS[itemKey];
  if (!variants) return { ok: false, reason: `item "${itemKey}" has no variants` };
  const idx = variants.findIndex((v) => v.name.toLowerCase() === variantName.toLowerCase());
  if (idx < 0) return { ok: false, reason: `variant "${variantName}" not found for ${itemKey} (available: ${variants.map((v) => v.name).join(", ")})` };
  return { ok: true, index: idx, def: variants[idx] };
}

/**
 * 查某个道具当前 TypeRecord 对应变体的 SelfUnlock 是否会导致"可自我解锁"。
 * 用途：上锁锁死时，若当前变体 SelfUnlock=true（如皮革手铐 Wrist），佩戴者仍能挣扎脱下，
 * 必须切到 selfUnlock=false 的变体（Elbow 肘缚）。返回要切到的变体序号；无需切换返回 -1。
 *
 * 注意：SelfUnlock 是 TYPED 变体官方定义的一部分，直接写 Property.SelfUnlock=false 会被
 * TypedItemInit（TypedItem.js:607 CommonDeepIsSubset 判定不一致→用变体定义覆盖）抵消，
 * 所以唯一可靠做法是切到 selfUnlock:false 的变体（同时更新 TypeRecord）。
 */
export function findSelfUnlockSafeVariant(
  itemKey: string,
  currentTypedIndex: number | undefined
): { switchTo: number; def: ItemVariantDef } | null {
  const variants = VARIANTS[itemKey];
  if (!variants) return null;
  // 当前变体（缺省按 None=0）
  const curIdx = typeof currentTypedIndex === "number" && variants[currentTypedIndex] ? currentTypedIndex : 0;
  const cur = variants[curIdx];
  // 当前变体本来就不能自我解锁（selfUnlock=false 或未定义）→ 无需切换
  if (cur.selfUnlock === false) return null;
  // 找第一个 selfUnlock===false 的变体作为目标（Elbow 通常排最前）
  for (let i = 0; i < variants.length; i++) {
    if (variants[i].selfUnlock === false) return { switchTo: i, def: variants[i] };
  }
  return null; // 没有 selfUnlock=false 的变体，无法靠切换解决
}

/** 从目标当前 Property 里取 TypeRecord 变体序号（键是字面量 "typed"） */
export function getTypedIndex(prop: Record<string, unknown> | null): number | undefined {
  if (!prop) return undefined;
  const tr = prop.TypeRecord as { typed?: unknown } | undefined;
  return typeof tr?.typed === "number" ? tr.typed : undefined;
}

/**
 * 构造变体切换的完整 Property。
 * base：目标当前穿着该道具的 Property（保留锁字段等非变体字段）；新穿时传 null。
 *
 * ⚠️ TypeRecord 的键是字面量 "typed"（ExtendedArchetype.TYPED 的值）：
 * 官方客户端 TypedItemCreateTypedItemData 中，配置无 Name 字段时键名默认为
 * ExtendedArchetype.TYPED = "typed"。所有白名单变体道具（麻绳/尼龙绳/单手套/
 * 拘束衣/项圈连手铐）的配置均无 Name 字段，故键统一为 "typed"。
 * 若用资产名（如 "HempRope"）作键，接收方客户端会因找不到序号而静默重置回第一个变体。
 */
export function buildVariantProperty(
  itemKey: string,
  variantIndex: number,
  base: Record<string, unknown> | null
): Record<string, unknown> {
  const variants = VARIANTS[itemKey]!;
  const def = variants[variantIndex];
  // 以 base 为底，剔除旧变体专属字段（官方做法：删旧合新）
  const VARIANT_OWNED_KEYS = ["SetPose", "Difficulty", "Effect", "Block", "AllowActivityOn", "AllowActivePose", "OverridePriority", "HideItem"];
  const prop: Record<string, unknown> = {};
  if (base) {
    for (const [k, v] of Object.entries(base)) {
      if (!VARIANT_OWNED_KEYS.includes(k)) prop[k] = v;
    }
  }
  // 合入新变体字段
  if (def.pose) prop.SetPose = def.pose;
  if (def.difficulty !== undefined) prop.Difficulty = def.difficulty;
  if (def.effect) prop.Effect = def.effect;
  if (def.block) prop.Block = def.block;
  if (def.allowActivityOn) prop.AllowActivityOn = def.allowActivityOn;
  if (def.allowActivePose) prop.AllowActivePose = def.allowActivePose;
  // SelfUnlock：手铐类 TYPED 道具靠它决定能否自我解锁（DialogHasKey 判定），
  // 变体自带的 selfUnlock 必须写进 Property，否则接收端 TypedItemInit 会按官方变体定义补回。
  if (def.selfUnlock !== undefined) prop.SelfUnlock = def.selfUnlock;
  if (def.extraProperty) Object.assign(prop, def.extraProperty);
  // TypeRecord：现代客户端的变体标识（键固定为 "typed"，见上方注释）
  prop.TypeRecord = { typed: variantIndex };
  // 锁保护：锁字段（LockedBy 等）不在 VARIANT_OWNED_KEYS 会被保留，
  // 但变体的 Effect 会覆盖掉 "Lock"——锁还在 effect 却没了会状态不一致，补回去。
  if (base?.LockedBy != null) {
    const effect = Array.isArray(prop.Effect) ? [...(prop.Effect as unknown[])] : [];
    if (!effect.includes("Lock")) effect.push("Lock");
    prop.Effect = effect;
  }
  return prop;
}

export function checkRemovableSlot(slot: string): boolean {
  return REMOVABLE_SLOTS.includes(slot);
}

// ---------------------------------------------------------------------------
// #16 宠物标牌（CustomCollarTag，MODULAR 道具）的 Property 构造。
//
// 协议（2026-09-05 源码确证，Assets_Female3DCGExtended.js:6207 + ModularItem.js:222）：
// - MODULAR 道具的 TypeRecord 键 = 各模块的 Key（不是 "typed"！）：
//     Tag 模块 Key="t"（6 个选项 t0~t5，标牌形状/样式），Txt 模块 Key="x"（写字，1 个选项 x0）
// - 选项名自动生成规则：`${模块Key}${序号}`，如 "t0"、"x0"
// - 文字存 Property.Text（BaselineProperty: { Text: "Tag" }，TEXT 模块 ArchetypeConfig
//   MaxLength.Text = 9 —— 最多 9 个字符，中英文都按字符数）
// - ChangeWhenLocked: false —— 上锁后不能再改字（必须先写字再上锁，顺序不能反）
// - 资产 Prerequisite: "Collared" —— 目标必须戴着项圈（ItemNeck 有道具）才能戴标牌
// - AllowLock: true（Female3DCG.js:53304，基础难度 20）
// ---------------------------------------------------------------------------

/** 宠物标牌文字上限（官方 TEXT 模块 MaxLength） */
export const COLLAR_TAG_TEXT_MAX = 9;

/**
 * 构造宠物标牌（CustomCollarTag）的完整 Property。
 * text：标牌上写的字（≤9 字符，超长会被接收端截断/回滚——调用方负责截好）。
 * tagStyle：Tag 模块选项序号（0~5，默认 0）。
 * base：目标当前穿着该道具的 Property（保留锁字段等）；新穿传 null。
 */
export function buildCollarTagProperty(
  text: string,
  tagStyle = 0,
  base: Record<string, unknown> | null = null
): Record<string, unknown> {
  const prop: Record<string, unknown> = { ...(base ?? {}) };
  prop.TypeRecord = { t: tagStyle, x: 0 };
  prop.Text = text;
  // 锁保护：与 buildVariantProperty 同理——变体/模块切换会重置 Effect，锁还在要补回
  if (base?.LockedBy != null) {
    const effect = Array.isArray(prop.Effect) ? [...(prop.Effect as unknown[])] : [];
    if (!effect.includes("Lock")) effect.push("Lock");
    prop.Effect = effect;
  }
  return prop;
}

/**
 * 构造 PetPost（宠物拴柱/宠物标牌，MODULAR 道具）的完整 Property。
 *
 * 2026-09-05 用户纠错第三次：之前把"挂牌"理解为 CustomCollarTag（副槽牌子），
 * 又改成 PetCollar（主项圈 + LockMessage 留言）——**两个方向都错了**。
 * 正确物品是 `ItemNeckRestraints/PetPost`（中文"宠物标牌"）：
 *   - Effect = [E.IsChained, E.Tethered, E.MapImmobile]  ← 这才是"拴住"的真正机制
 *     Tethered = 不能离开拴柱位置；MapImmobile = 不能瞬移
 *   - FixedPosition: true  ← 视觉显示成房间里的柱子（不是角色道具）
 *   - Prerequisite: ["Collared"]  ← 必须先戴项圈
 *
 * 模块变体（Female3DCGExtended.js:6463）：6 个键，每个键一选项
 *   p (Plaque):    0/1    — 边框样式（默认 0）
 *   d (Dirt):      0=clean / 1=dirty（默认 0）
 *   l (Leash):     0=leash / 1=rope (Difficulty:5) / **2=chain (Difficulty:6, AllowLock:true)** ← 用这个
 *   s (Sticker):   0-7，**7=None**（无贴纸）默认
 *   m (PostIt):    0=有便签（文字可见）/ 1=无便签
 *   x (Txt):       0=text（最多 Text=14, Text2=14, Text3=14 字符）
 *
 * BaselineProperty: { Text: "Pet", Text2: "Leashing", Text3: "Post" }
 *
 * ⚠️ MODULAR 道具 TypeRecord 键名是各模块的 Key（不是 "typed"！），
 * 切变体 = 重发完整 Property；不传 TypeRecord 接收端会按默认变体重置。
 *
 * @param text   便签上的文字（≤14 字符；超出接收端截断/回滚，调用方负责截好）
 * @param base   目标当前穿着该道具的 Property（保留锁字段等）；新穿传 null
 * @param opts   覆盖默认变体：{p, d, l, s, m} 默认 l=2/Chain、s=7/None
 */
export function buildPetPostProperty(
  text: string,
  base: Record<string, unknown> | null = null,
  opts: { p?: number; d?: number; l?: number; s?: number; m?: number } = {}
): Record<string, unknown> {
  const p = opts.p ?? 0;
  const d = opts.d ?? 0;
  const l = opts.l ?? 2; // Chain（可锁，自带 Difficulty:6）
  const s = opts.s ?? 7; // None（不显示贴纸，避免随机花纹）
  const m = opts.m ?? 0; // 有便签（让 Text 可见）
  const prop: Record<string, unknown> = { ...(base ?? {}) };
  prop.TypeRecord = { p, d, l, s, m, x: 0 };
  // l2 Chain 选项 Property:{Difficulty:6} —— 构造 base Property 用绝对值
  prop.Difficulty = l === 2 ? 6 : l === 1 ? 5 : 4;
  // BaselineProperty 默认文字 {Pet, Leashing, Post}，改 Text 字段覆盖
  // m=0 有便签时显示 Text/Text2/Text3；m=1 不显示
  // 2026-09-05 用户纠错：Text/Text2 两行原来写同一句 → 便签上出现两个"白给大王"。
  // 改为把文案对半拆成两行（"白给大王" → Text="白给" / Text2="大王"），Text3 留空。
  const half = Math.ceil(text.length / 2);
  prop.Text = text.slice(0, half);
  prop.Text2 = text.slice(half);
  prop.Text3 = "";
  // 锁保护：与 CustomCollarTag/PetCollar 同理——变体切换会重置 Effect，锁还在要补回 Lock
  if (base?.LockedBy != null) {
    const effect = Array.isArray(prop.Effect) ? [...(prop.Effect as unknown[])] : [];
    if (!effect.includes("Lock")) effect.push("Lock");
    prop.Effect = effect;
  }
  return prop;
}

/** PetPost 便签文字上限（官方 TEXT 模块 MaxLength） */
export const PET_POST_TEXT_MAX = 14;

// ---------------------------------------------------------------------------
// 白名单道具的基础挣脱难度（Asset.Difficulty）。
// 2026-09-03 用脚本从官方 Assets/Female3DCG/Female3DCG.js 精确提取。
//
// ⚠️ wire 语义（已核对接收端源码，勿再搞错）：
// - 单道具更新（ChatRoomCharacterItemUpdate / ChatRoomSyncItem）的 Difficulty
//   是【相对值】= item.Difficulty(绝对) - Asset.Difficulty(基础)；
//   接收端 CharacterAppearanceSetItem 会做 绝对 = 基础 + 相对。
// - 外观整包（bundle）里的 Difficulty 是【绝对值】。
//   BOT 的外观缓存来自 bundle，所以缓存读出来的是绝对值，发送前必须减基础值！
// ---------------------------------------------------------------------------

const ITEM_BASE_DIFFICULTY: Record<string, number> = {
  "ItemNeck/LeatherCollar": 50,
  "ItemNeck/PetCollar": 50,
  "ItemNeck/PostureCollar": 50,
  "ItemNeck/HeartCollar": 50,
  "ItemMouth/BallGag": 4,
  "ItemMouth/BitGag": 4,
  "ItemMouth/ClothGag": -4,
  "ItemMouth/MuzzleGag": 6,
  "ItemMouth/PacifierGag": 0,
  "ItemMouth/DuctTape": -2,
  "ItemHead/LeatherBlindfold": 0,
  "ItemHead/ClothBlindfold": 0,
  "ItemHead/ScarfBlindfold": 0,
  "ItemHead/SmallBlindfold": 0,
  "ItemArms/HempRope": 3,
  "ItemArms/NylonRope": 0,
  "ItemArms/LeatherCuffs": 3,
  "ItemArms/MetalCuffs": 5,
  "ItemArms/LeatherArmbinder": 10,
  "ItemArms/LatexArmbinder": 10,
  "ItemArms/SeamlessLatexArmbinder": 10,
  "ItemArms/ShinyArmbinder": 20,
  "ItemArms/StraitJacket": 6,
  "ItemArms/LeatherStraitJacket": 7,
  "ItemArms/FullBodyLeatherHarness": 14,
  "ItemArms/CollarCuffs": 6,
  "ItemLegs/HempRope": 3,
  "ItemLegs/NylonRope": 0,
  "ItemLegs/LeatherLegCuffs": 3,
  "ItemFeet/HempRope": 3,
  "ItemFeet/NylonRope": 0,
  "ItemFeet/LeatherAnkleCuffs": 2,
  "ItemFeet/SteelAnkleCuffs": 6,
  "ItemPelvis/HempRope": 3,
  "ItemBoots/BalletHeels": 6,
  "ItemNeckRestraints/CollarLeash": 6,
  "ItemNeckRestraints/ChainLeash": 6,
  "ItemNeckRestraints/PetPost": 4, // 视觉房间物品；Effect=IsChained+Tethered+MapImmobile；l2 Chain 变体自带 Difficulty:6 + AllowLock:true
  "ItemNeckAccessories/CustomCollarTag": 20,
};

/** 查道具基础难度（不在表里默认 0） */
export function getItemBaseDifficulty(group: string, name: string): number {
  return ITEM_BASE_DIFFICULTY[`${group}/${name}`] ?? 0;
}

// ---------------------------------------------------------------------------
// 锁系统（#12）。
// 协议来源（2026-09-03 源码确证）：
// - 上锁 = 修改目标道具的 Property（Inventory.js:1429 InventoryLock）：
//   Effect 数组追加 "Lock" + LockedBy(锁资产名) + LockMemberNumber/LockMemberName(上锁者)
//   + 锁具基线属性（ExtendedItem.js:236 ExtendedItemInitNoArch：字段缺失才写默认值）
// - 解锁 = 删全部锁属性 + Effect 去掉 "Lock"（Validation.js:1067 ValidationDeleteLock）
// - 锁是 ItemMisc 组的 IsLock 资产，不是独立穿戴道具；目标道具须 Asset.AllowLock
// - 定时锁的 Property.RemoveTimer 是【绝对到期时间戳(ms)】而非秒数
//   （Validation.js:952：clamp 到 now + MaxTimer*1000 以内）
// - 服务器校验：CombinationNumber 必须 /^\d{4}$/；Password 必须 /^[A-Z]{1,8}$/
// ---------------------------------------------------------------------------

export interface LockDef {
  /** 中文名（prompt 用） */
  cn: string;
  /** 基线属性：字段缺失时才写默认值（官方 ExtendedItemInitNoArch 行为） */
  baseline: Record<string, unknown>;
  /** 定时锁的最大时长（秒）；无此字段 = 非定时锁 */
  maxTimerSec?: number;
  /** true = 数字密码锁（combination 字段） */
  combination?: boolean;
  /** true = 文字密码锁（password 字段，1-8 个大写字母） */
  password?: boolean;
  /** true = 主人锁（OwnerOnly）：只有目标资料里设置的 Owner（和本人）能上/解。
   *  执行层（index.ts）校验目标的 Ownership.MemberNumber === BOT 注册号，否则拒绝。 */
  ownerOnly?: boolean;
}

/** BOT 可用的锁具（来源 Female3DCG.js ItemMisc 组 + Female3DCGExtended.js BaselineProperty）。
 *  主人锁系（OwnerPadlock/OwnerTimerPadlock）要求目标把 BOT 设为 Owner——执行层校验。 */
export const LOCKS: Record<string, LockDef> = {
  MetalPadlock: { cn: "金属挂锁（最普通，需钥匙解）", baseline: {} },
  CombinationPadlock: {
    cn: "数字密码锁（4位数字，如 123456 不行——必须恰好4位）",
    baseline: { CombinationNumber: "0000" },
    combination: true,
  },
  PasswordPadlock: {
    cn: "文字密码锁（1-8个大写字母，如 BINDME）",
    baseline: { Password: "PASSWORD", Hint: "Take a guess...", LockSet: false, RemoveOnUnlock: false },
    password: true,
  },
  TimerPadlock: { cn: "定时锁（到期自动开，最长5分钟）", baseline: {}, maxTimerSec: 300 },
  TimerPasswordPadlock: {
    cn: "密码定时锁（到期自动开，最长4小时）",
    baseline: {
      Password: "PASSWORD", Hint: "Take a guess...", LockSet: false,
      RemoveItem: false, ShowTimer: true, EnableRandomInput: false, MemberNumberList: [],
    },
    maxTimerSec: 14400,
    password: true,
  },
  OwnerPadlock: {
    // Female3DCG.js:68200 — OwnerOnly: true，无密码无定时。所有权仪式锁：
    // 只有 服务对象（本人）和 服务对象 资料里设置的 Owner 能上/解（Validation.js:463-465）
    cn: "主人锁（所有权宣示/防他人解开，只有主人和本人能开）",
    baseline: {},
    ownerOnly: true,
  },
  OwnerTimerPadlock: {
    // Female3DCG.js:68210 — OwnerOnly + MaxTimer=3024000s（35 天！）
    cn: "主人定时锁（防他人解开，到期自动开，最长35天）",
    baseline: { ShowTimer: true },
    maxTimerSec: 3024000,
    ownerOnly: true,
  },
  ExclusivePadlock: {
    // Female3DCG.js:68280 — 专属锁。Dialog.js:711：LockedBy==="ExclusivePadlock" 时
    // DialogCanUnlock 直接返回 !C.IsPlayer()——**除佩戴者本人外的任何人**（有道具使用权即可）
    // 都能一键解开。官方就是为"求人解锁"玩法设计的：她自己解不开，必须求路人。
    // #16 限时回家的核心道具（锁宠物标牌）。
    cn: "专属锁（除佩戴者本人外任何人都能解开——求人解锁玩法专用）",
    baseline: {},
  },
};

/** 白名单中可上锁的道具（官方 Asset.AllowLock，2026-09-03 从 Female3DCG.js 提取对照）。
 *  绳子/布堵嘴/胶带/奶嘴等不可上锁——这是游戏设定。 */
const LOCKABLE_ITEMS = new Set([
  "ItemNeck/LeatherCollar", "ItemNeck/PetCollar", "ItemNeck/PostureCollar", "ItemNeck/HeartCollar",
  "ItemMouth/BallGag", "ItemMouth/BitGag", "ItemMouth/MuzzleGag",
  "ItemHead/LeatherBlindfold", "ItemHead/SmallBlindfold",
  "ItemArms/LeatherCuffs", "ItemArms/LeatherArmbinder", "ItemArms/LatexArmbinder",
  "ItemArms/SeamlessLatexArmbinder", "ItemArms/ShinyArmbinder",
  "ItemArms/StraitJacket", "ItemArms/LeatherStraitJacket", "ItemArms/FullBodyLeatherHarness",
  "ItemArms/CollarCuffs",
  "ItemLegs/LeatherLegCuffs", "ItemFeet/LeatherAnkleCuffs", "ItemFeet/SteelAnkleCuffs",
  "ItemBoots/BalletHeels",
  "ItemNeckRestraints/CollarLeash", "ItemNeckRestraints/ChainLeash",
  "ItemNeckAccessories/CustomCollarTag",
]);

/** 该道具是否可上锁（白名单内且官方 AllowLock） */
export function checkLockable(group: string, name: string): boolean {
  return LOCKABLE_ITEMS.has(`${group}/${name}`);
}

/** 校验锁名（白名单内的 BOT 可用锁具） */
export function checkLock(lockName: string): { ok: boolean; def?: LockDef; reason?: string } {
  const def = LOCKS[lockName];
  if (!def) return { ok: false, reason: `lock "${lockName}" not in whitelist (${Object.keys(LOCKS).join(", ")})` };
  return { ok: true, def };
}

/** 解锁时要从 Property 删掉的全部锁属性（Validation.js ValidationAllLockProperties） */
export const ALL_LOCK_PROPERTIES = [
  "LockedBy", "LockMemberNumber", "LockMemberName", "LockMessage",
  "EnableRandomInput", "RemoveItem", "ShowTimer", "CombinationNumber",
  "Password", "Hint", "LockSet", "LockPickSeed", "MemberNumberList",
  "RemoveTimer", "MemberNumberListKeys",
];

/**
 * 构造上锁后的完整 Property（照官方 InventoryLock + ExtendedItemInitNoArch 行为）。
 * base：目标当前穿着该道具的 Property（保留变体字段 TypeRecord/SetPose 等）；未穿传 null。
 *
 * ⚠️ payload 必须和官方客户端上锁时发出的内容逐字段一致（2026-09-04 #21 根因修复）：
 * 官方上锁 = 当前官方完整属性 + 锁字段（Effect+"Lock"、LockedBy、LockMemberNumber/Name）。
 * 不要再注入 Property.SelfUnlock / Property.Difficulty 这类非官方字段——实测这类字段会让
 * 接收端 TypedItemInit 的变体校验判定不一致，整条更新被回滚，锁静默消失
 * （BallGag 官方 Normal 属性仅 {TypeRecord:{typed:0}}，注入字段后锁全部丢失）。
 * 防挣脱靠 item 级 Difficulty 提升（index.ts 发送 wire 相对值），已在四件道具上实证生效。
 * SelfUnlock 属于变体官方数据（buildVariantProperty 负责），不属于锁字段。
 */
export function buildLockProperty(
  base: Record<string, unknown> | null,
  lockName: string,
  opts: {
    memberNumber: number;
    memberName: string;
    combination?: string;
    password?: string;
    timerSec?: number;
  }
): Record<string, unknown> {
  const def = LOCKS[lockName]!;
  const prop: Record<string, unknown> = { ...(base ?? {}) };
  // Effect：在现有基础上追加 "Lock"（变体可能自带 Effect 数组）
  const effect = Array.isArray(prop.Effect) ? [...(prop.Effect as unknown[])] : [];
  if (!effect.includes("Lock")) effect.push("Lock");
  prop.Effect = effect;
  // 锁身份字段
  prop.LockedBy = lockName;
  prop.LockMemberNumber = opts.memberNumber;
  prop.LockMemberName = opts.memberName;
  // 基线属性：缺失才写默认值（官方 ExtendedItemInitNoArch：if (Item.Property[name] == null)）
  for (const [k, v] of Object.entries(def.baseline)) {
    if (prop[k] == null) prop[k] = v;
  }
  // 数字密码（必须 /^\d{4}$/，否则接收端会重置为 0000）
  if (def.combination && opts.combination && /^\d{4}$/.test(opts.combination)) {
    prop.CombinationNumber = opts.combination;
  }
  // 文字密码（必须 1-8 个大写字母，否则接收端会重置为 UNLOCK）
  if (def.password && opts.password && /^[A-Z]{1,8}$/.test(opts.password)) {
    prop.Password = opts.password;
    prop.LockSet = true; // 官方语义：LockSet=true 表示密码已由上锁者设定
  }
  // 定时：RemoveTimer 是绝对到期时间戳(ms)，clamp 到官方 MaxTimer 以内
  if (def.maxTimerSec) {
    const sec = Math.max(1, Math.min(opts.timerSec ?? def.maxTimerSec, def.maxTimerSec));
    prop.RemoveTimer = Date.now() + sec * 1000;
    prop.ShowTimer = true;
  }
  return prop;
}

/**
 * 解锁：删全部锁属性 + Effect 去掉 "Lock"（照官方 ValidationDeleteLock）。
 * 其余字段（变体 TypeRecord 等）原样保留。
 */
export function stripLockProperty(
  base: Record<string, unknown> | null
): Record<string, unknown> {
  const prop: Record<string, unknown> = { ...(base ?? {}) };
  for (const key of ALL_LOCK_PROPERTIES) delete prop[key];
  // 注意：不要动 SelfUnlock——它属于变体官方数据（Elbow=false / Wrist=true），
  // 由 buildVariantProperty 管理；解锁只删锁字段，与官方 ValidationDeleteLock 一致。
  if (Array.isArray(prop.Effect)) {
    prop.Effect = (prop.Effect as unknown[]).filter((e) => e !== "Lock");
  }
  return prop;
}

// ---------------------------------------------------------------------------
// 收到的 Activity 消息 → 中文可读文本（喂给 LLM 的"感受"）
// ---------------------------------------------------------------------------

interface DictEntry {
  SourceCharacter?: number;
  TargetCharacter?: number;
  /** 官方 DictionaryBuilder 部分条目（SourceCharacter/TargetCharacter/DestinationCharacter）带 Tag+MemberNumber */
  MemberNumber?: number;
  FocusGroupName?: string;
  GroupName?: string;
  AssetName?: string;
  ActivityName?: string;
  Tag?: string;
  Text?: string;
  PrevAsset?: unknown;
  NextAsset?: unknown;
}

/**
 * 把服务器广播的 Activity 消息渲染成中文句子。
 * Content 形如 "ChatOther-ItemHead-Pet" / "ChatSelf-ItemMouth-MoanGag"；
 * Dictionary 里带 SourceCharacter / TargetCharacter / FocusGroupName / ActivityName。
 */
export function resolveActivityMessage(
  content: string,
  dictionary: DictEntry[] | undefined,
  nameOf: (memberNo?: number) => string
): string | null {
  if (typeof content !== "string" || !content.startsWith("Chat")) return null;
  const dict = Array.isArray(dictionary) ? dictionary : [];
  const source = dict.find((d) => typeof d.SourceCharacter === "number");
  const target = dict.find((d) => typeof d.TargetCharacter === "number");
  const focus = dict.find((d) => typeof d.FocusGroupName === "string");
  const activity = dict.find((d) => typeof d.ActivityName === "string");
  const asset = dict.find((d) => typeof d.GroupName === "string" && typeof d.AssetName === "string");

  const srcName = source ? nameOf(source.SourceCharacter) : "某人";
  const tgtName = target ? nameOf(target.TargetCharacter) : null;

  // 优先用官方中文模板（含 615 条动作对话）
  const tpl = catalog.activity_dialogs[content]?.cn;
  if (tpl) {
    let text = tpl;
    text = text.replace(/SourceCharacter/g, srcName);
    if (tgtName) text = text.replace(/TargetCharacter/g, tgtName);
    if (focus) text = text.replace(/FocusAssetGroup/g, zoneCN(focus.FocusGroupName!));
    if (asset) {
      const item = itemIndex.get(`${asset.GroupName}/${asset.AssetName}`);
      if (item) text = text.replace(/AssetName/g, item.cn || item.en);
    }
    if (activity?.ActivityName) text = text.replace(/ActivityName/g, activity.ActivityName);
    return text;
  }

  // 兜底：手工拼一句
  const actName = activity?.ActivityName ?? content.split("-")[2] ?? "互动";
  const zone = focus ? zoneCN(focus.FocusGroupName!) : null;
  if (tgtName) {
    return `${srcName} 对 ${tgtName}${zone ? `的${zone}` : ""}使用了动作 ${actName}。`;
  }
  return `${srcName} ${zone ? `对准自己的${zone}` : ""}使用了动作 ${actName}。`;
}

/**
 * 给 Activity 事件追加语义澄清（#19-D）。
 * 目标：纠正 LLM 把"对方用口塞碰我的手"误读成"我去吻对方"这类施动方向/语义漂移。
 * 返回澄清后缀（可为空串），由上层拼到 [动作] 行末尾，作为客观事实约束喂给 LLM。
 */
export function clarifyActivity(activityKey: string | undefined, targetIsBot: boolean): string {
  if (!activityKey) return "";
  // GaggedKiss：官方语义是"用口塞【触碰/摩擦/轻撞】对方"，不是真正的亲吻
  if (/GaggedKiss/.test(activityKey)) {
    // 区分方向：对方对我做 vs 我对别人做（BOT 主动发起的 GaggedKiss 通常不会走这里，保守起见两种都说明）
    return targetIsBot
      ? "（这是对方用【口塞】轻轻碰了你一下——只是碰触，不是亲吻；不要把它写成你们接吻，也不要替对方编造亲吻动作）"
      : "（这是戴口塞的一方用【口塞】轻轻碰了对方一下——碰触而已，不是亲吻）";
  }
  // GagKiss（亲对方的口塞）：亲吻的对象是口塞本身，不是嘴唇
  if (/GagKiss/.test(activityKey) && !/GaggedKiss/.test(activityKey)) {
    return "（这是隔着【口塞】的一个吻，亲的是口塞表面，不是嘴唇）";
  }
  return "";
}

// ---------------------------------------------------------------------------
// 收到的道具操作公告（Type=Action, Content=ActionUse/...）→ 结构化解析 + 中文渲染（#45）
// ---------------------------------------------------------------------------

/** 道具操作公告的种类 */
export type ItemActionKind =
  | "use" // 戴上/更换道具（ActionUse，NextAsset=新道具）
  | "remove" // 脱下道具（ActionRemove，PrevAsset=被脱的道具）
  | "lock" // 上锁（ActionAddLock，PrevAsset=道具，NextAsset=锁具）
  | "unlock" // 解锁（ActionUnlock，PrevAsset=道具）
  | "unlock-remove" // 解锁并脱下（ActionUnlockAndRemove，移除带锁道具时的官方动作）
  | "tighten" // 收紧（ActionTightenLittle / ActionTightenLot）
  | "loosen"; // 放松（ActionLoosenLittle / ActionLoosenLot）

/** 解析后的道具操作公告（"谁 对 谁 的哪个部位 做了什么"） */
export interface ItemActionInfo {
  kind: ItemActionKind;
  /** 操作者成员号（无法解析时为 null） */
  sourceNo: number | null;
  /** 目标成员号（无法解析时为 null） */
  targetNo: number | null;
  /** 部位槽位，如 ItemArms */
  group: string | null;
  /** 主体道具名：use=新道具（NextAsset），其余=被操作的道具（PrevAsset） */
  itemName: string | null;
  /** 锁具名（仅 ActionAddLock 有，NextAsset） */
  lockName: string | null;
  /** 松紧幅度（仅 tighten/loosen 有） */
  magnitude: "little" | "lot" | null;
}

/** Content → 种类映射。官方客户端道具操作只发这一组 Action 公告（Dialog.js/ChatRoomPublishAction） */
const ITEM_ACTION_CONTENT_MAP: Record<string, { kind: ItemActionKind; magnitude?: "little" | "lot" }> = {
  ActionUse: { kind: "use" },
  ActionRemove: { kind: "remove" },
  ActionAddLock: { kind: "lock" },
  ActionUnlock: { kind: "unlock" },
  ActionUnlockAndRemove: { kind: "unlock-remove" },
  ActionTightenLittle: { kind: "tighten", magnitude: "little" },
  ActionTightenLot: { kind: "tighten", magnitude: "lot" },
  ActionLoosenLittle: { kind: "loosen", magnitude: "little" },
  ActionLoosenLot: { kind: "loosen", magnitude: "lot" },
};

/** 是否是本模块关心的道具操作公告 Content */
export function isItemActionContent(content: string): boolean {
  return content in ITEM_ACTION_CONTENT_MAP;
}

/**
 * 解析道具操作公告字典（官方 ChatRoomPublishAction 的 DictionaryBuilder 输出，
 * 与 BOT 自己发公告的 buildAddLockActionDictionary 同构）：
 *   { SourceCharacter: 操作者号 } / { TargetCharacter: 目标号 }（或 Tag+MemberNumber 形式）
 *   { Tag: "PrevAsset", AssetName, GroupName } / { Tag: "NextAsset", ... } / { FocusAssetGroup }
 * 两种键形都兼容（官方 builder 字段为准，Tag+MemberNumber 兜底）。
 */
export function parseItemAction(
  content: string,
  dictionary: Array<Record<string, unknown>> | undefined
): ItemActionInfo | null {
  const mapped = ITEM_ACTION_CONTENT_MAP[content];
  if (!mapped) return null;
  const dict = (Array.isArray(dictionary) ? dictionary : []) as DictEntry[];

  // 操作者：{ SourceCharacter: 号 } 或 { Tag: "SourceCharacter", MemberNumber: 号 }
  let sourceNo: number | null = null;
  for (const d of dict) {
    if (typeof d.SourceCharacter === "number") { sourceNo = d.SourceCharacter; break; }
    if (d.Tag === "SourceCharacter" && typeof d.MemberNumber === "number") { sourceNo = d.MemberNumber; break; }
  }
  // 目标：{ TargetCharacter: 号 } 或 { Tag: "TargetCharacter"/"DestinationCharacter", MemberNumber: 号 }
  let targetNo: number | null = null;
  for (const d of dict) {
    if (typeof d.TargetCharacter === "number") { targetNo = d.TargetCharacter; break; }
    if ((d.Tag === "TargetCharacter" || d.Tag === "DestinationCharacter") && typeof d.MemberNumber === "number") {
      targetNo = d.MemberNumber; break;
    }
  }
  // PrevAsset / NextAsset（官方 builder 也可能直接把名字放在 PrevAsset/NextAsset 键上）
  let prevAsset: { name: string; group: string | null } | null = null;
  let nextAsset: { name: string; group: string | null } | null = null;
  for (const d of dict) {
    if (d.Tag === "PrevAsset" && typeof d.AssetName === "string") {
      prevAsset = { name: d.AssetName, group: typeof d.GroupName === "string" ? d.GroupName : null };
    } else if (d.Tag === "NextAsset" && typeof d.AssetName === "string") {
      nextAsset = { name: d.AssetName, group: typeof d.GroupName === "string" ? d.GroupName : null };
    } else if (typeof (d as { PrevAsset?: unknown }).PrevAsset === "string") {
      prevAsset = { name: (d as { PrevAsset: string }).PrevAsset, group: typeof d.GroupName === "string" ? d.GroupName : null };
    } else if (typeof (d as { NextAsset?: unknown }).NextAsset === "string") {
      nextAsset = { name: (d as { NextAsset: string }).NextAsset, group: typeof d.GroupName === "string" ? d.GroupName : null };
    }
  }
  // 部位：FocusAssetGroup
  let group: string | null = null;
  for (const d of dict) {
    if (typeof d.FocusGroupName === "string") { group = d.FocusGroupName; break; }
  }
  if (group === null) group = prevAsset?.group ?? nextAsset?.group ?? null;

  // 主体道具：use 取新道具（NextAsset），其余取被操作的道具（PrevAsset）
  const itemName =
    mapped.kind === "use"
      ? nextAsset?.name ?? prevAsset?.name ?? null
      : prevAsset?.name ?? nextAsset?.name ?? null;
  const lockName = mapped.kind === "lock" ? nextAsset?.name ?? null : null;

  return {
    kind: mapped.kind,
    sourceNo,
    targetNo,
    group,
    itemName,
    lockName,
    magnitude: mapped.magnitude ?? null,
  };
}

/**
 * 把道具操作公告渲染成中文句子（喂给 LLM 的"感受"）。
 * nameOf：成员号 → 昵称（优先）的取法；itemCN/lockCN 走白名单中文名。
 */
export function renderItemActionText(
  info: ItemActionInfo,
  nameOf: (memberNo: number) => string
): string | null {
  if (info.sourceNo === null || info.targetNo === null) return null;
  const src = nameOf(info.sourceNo);
  const self = info.sourceNo === info.targetNo;
  const tgt = self ? "自己" : nameOf(info.targetNo);
  const zone = info.group ? zoneCN(info.group) : null;
  const zoneTxt = zone ? `的${zone}` : "";
  const itemTxt = info.itemName
    ? info.group
      ? itemNameCN(info.group, info.itemName) || info.itemName
      : info.itemName
    : "道具";
  const lockTxt = info.lockName
    ? (LOCKS[info.lockName]?.cn ?? info.lockName).split("（")[0]
    : null;

  switch (info.kind) {
    case "use":
      return `${src} 给${tgt}${zoneTxt}戴上了${itemTxt}。`;
    case "remove":
      return `${src} 脱下了${tgt}${zoneTxt}的${itemTxt}。`;
    case "lock":
      return lockTxt
        ? `${src} 给${tgt}${zoneTxt}的${itemTxt}上了${lockTxt}。`
        : `${src} 给${tgt}${zoneTxt}的${itemTxt}上了锁。`;
    case "unlock":
      return `${src} 解开了${tgt}${zoneTxt}的${itemTxt}上的锁。`;
    case "unlock-remove":
      return `${src} 解开并脱下了${tgt}${zoneTxt}的${itemTxt}。`;
    case "tighten":
      return `${src} 把${tgt}${zoneTxt}的${itemTxt}${info.magnitude === "lot" ? "大幅收紧" : "收紧了一些"}。`;
    case "loosen":
      return `${src} 把${tgt}${zoneTxt}的${itemTxt}${info.magnitude === "lot" ? "大幅放松" : "放松了一些"}。`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 穿着摘要（服务对象 Appearance → 中文列表，注入 LLM 上下文）
// ---------------------------------------------------------------------------

export interface AppearanceEntry {
  Group?: string;
  Name?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// #76 造型师视角：颜色识别（hex → 中文色名）+ 衣着中文化
// 审美 = 信息（颜色/款式，数据里全有）× 品味知识（LLM 自带）× 完整描述（本段补齐）。
// 视觉能力对 BC 是降级：画面只是数据的渲染翻译，BOT 直读数据本就是人类视觉超集。
// ---------------------------------------------------------------------------

/** 常用色板（RGB）——审美点评只需粗粒度色名，够用且省 token */
const COLOR_PALETTE: Array<[string, number, number, number]> = [
  ["黑", 20, 20, 20], ["白", 245, 245, 245], ["灰", 130, 130, 130],
  ["红", 200, 30, 40], ["深红", 110, 15, 30], ["粉", 250, 145, 185],
  ["橙", 240, 130, 30], ["棕", 130, 80, 40], ["黄", 240, 210, 60],
  ["金", 205, 165, 60], ["绿", 60, 150, 70], ["青", 40, 180, 180],
  ["蓝", 50, 90, 200], ["藏青", 30, 45, 100], ["紫", 130, 60, 180],
];

/** 单个 hex（#RRGGBB 或 #RRGGBBAA）→ 最近色名；非 hex（如 "Default"）返回 null */
function hexToColorName(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  let best: string | null = null;
  let bestDist = Number.MAX_SAFE_INTEGER;
  for (const [name, pr, pg, pb] of COLOR_PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

/** 从 Color 字段（string | string[]，服装常为分层色数组）提取主色名；识别不出返回 null */
function dominantColorName(color: unknown): string | null {
  const candidates: string[] = [];
  if (typeof color === "string") candidates.push(color);
  else if (Array.isArray(color)) {
    for (const c of color) if (typeof c === "string") candidates.push(c);
  }
  for (const c of candidates) {
    const name = hexToColorName(c);
    if (name) return name;
  }
  return null;
}

/** 道具主色名（#76）：wire Color 优先；无 Color（服务器剥离的默认色）依次查人工修正表、资产默认色表 */
function colorNameOfEntry(e: AppearanceEntry): string | null {
  const direct = dominantColorName((e as AppearanceEntry & { Color?: unknown }).Color);
  if (direct) return direct;
  if (typeof e.Group === "string" && typeof e.Name === "string") {
    const key = `${e.Group}/${e.Name}`;
    const manual = MANUAL_COLOR_OVERRIDE[key];
    if (manual) return manual;
    const defHex = defaultColorIndex.get(key);
    if (defHex) return hexToColorName(defHex);
  }
  return null;
}

/** 衣着槽位白名单（可被 LLM 点评搭配的穿着层；身体特征/表情类一律跳过） */
const OUTFIT_GROUPS = new Set([
  "Cloth", "ClothLower", "ClothAccessory", "Suit", "SuitLower", "Bra", "Corset",
  "Panties", "Socks", "SocksLeft", "SocksRight", "Shoes", "ShoesLeft", "ShoesRight",
  "Gloves", "Hat", "Mask", "Hood", "Tail", "Wings", "Necklace", "Bracelets",
  "AnkletLeft", "AnkletRight", "HandAccessoryLeft", "HandAccessoryRight",
]);

/** 衣着描述（造型师视角）：白名单槽位 → 中文名 + 颜色，如"紫色旗袍、黑色高跟鞋" */
function describeOutfit(appearance: unknown[]): string {
  const parts: string[] = [];
  for (const raw of appearance) {
    const e = raw as AppearanceEntry & { Color?: unknown };
    if (typeof e?.Group !== "string" || typeof e?.Name !== "string") continue;
    if (!e.Name || e.Name === "none") continue;
    if (!OUTFIT_GROUPS.has(e.Group)) continue;
    const item = itemIndex.get(`${e.Group}/${e.Name}`);
    const cn = item?.cn;
    if (!cn) continue; // 无中文名的衣着不入描述（避免英文噪音）
    const color = colorNameOfEntry(e);
    // TODO(#76-debug): 临时诊断——保留一轮验证默认色表回查生效后仍有识别失败的残留
    if (!color) {
      console.log(
        `[outfit-color-diag] ${e.Group}/${e.Name} 颜色识别失败（含默认色表回查），Color 原始值: ${JSON.stringify(e.Color)}`
      );
    }
    parts.push(color ? `${color}${cn}` : cn);
  }
  return parts.join("、");
}

/** 谎言高发槽位（反相锚点，2026-09-04 21:00）：这些部位没道具时在摘要里显式标注"没有"，
 * 防 LLM 顺着她的谎言编造（实测 服务对象"下面的玩具太刺激了"——身上根本没戴，LLM 却接"原来是下面的小玩具在闹你"） */
const NOTABLE_ABSENT_ZONES: Array<{ groups: string[]; label: string }> = [
  { groups: ["ItemVulva", "ItemVulvaPiercings", "Panties", "Vibrator", "ItemButt", "ItemPelvis"], label: "下身：无任何玩具或塞子" },
  { groups: ["ItemMouth", "ItemMouth2", "ItemMouth3"], label: "口部：无口塞" },
];

/** appearance 里是否存在任一指定组的道具（供谎言兜底判定"她有没有戴下身玩具"等） */
export function hasItemInGroups(appearance: unknown[] | null | undefined, groups: string[]): boolean {
  if (appearance == null) return false;
  return appearance.some((raw) => {
    const e = raw as AppearanceEntry;
    return typeof e?.Group === "string" && groups.includes(e.Group);
  });
}

/** 把角色的 Appearance 数组浓缩成一句中文摘要（重点：束缚道具、绑法变体与紧度） */
export function summarizeAppearance(appearance: unknown[] | null | undefined): string {
  if (appearance == null) return "（看不到穿着信息）";
  if (appearance.length === 0) return "身上没有任何束缚道具";
  const lines: string[] = [];
  for (const raw of appearance) {
    const e = raw as AppearanceEntry;
    if (typeof e?.Group !== "string" || typeof e?.Name !== "string") continue;
    // 只关注束缚类（Item*）——衣着类信息量太大，对 RP 决策帮助小
    if (!e.Group.startsWith("Item")) continue;
    const item = itemIndex.get(`${e.Group}/${e.Name}`);
    const cn = item?.cn || item?.en || e.Name;
    // 变体识别：Property.TypeRecord["typed"] → 序号 → 变体中文标签
    // （键固定为 "typed"；兼容遗留的资产名键以防万一）
    let variantCN: string | null = null;
    const prop = e.Property as
      | { TypeRecord?: Record<string, number>; Difficulty?: number; LockedBy?: string; LockMemberName?: string; RemoveTimer?: number; Intensity?: number }
      | undefined;
    const recIdx =
      prop?.TypeRecord && typeof prop.TypeRecord["typed"] === "number"
        ? prop.TypeRecord["typed"]
        : prop?.TypeRecord && typeof prop.TypeRecord[e.Name] === "number"
          ? prop.TypeRecord[e.Name]
          : null;
    if (recIdx !== null) {
      const itemKey = Object.keys(ITEM_SEND_NAME).find(
        (k) => ITEM_SEND_NAME[k] === e.Name && ITEM_SKILLS[k]?.group === e.Group
      );
      const variants = itemKey ? VARIANTS[itemKey] : undefined;
      const vDef = variants?.[recIdx];
      if (vDef) variantCN = vDef.cn;
    }
    // 紧度：wire Difficulty 是【绝对值】（bundle 整包通道，ChatRoomSync 来源），减基础难度得调节量
    // 白名单外道具的 getItemBaseDifficulty 默认 0，直接相减会把绝对值当调节量，会污染 LLM 上下文。
    // 因此**只在基础难度已知（非 0）的道具上**才显示紧度；未知道具跳过（保守兜底）。
    let tightness = "";
    const base = getItemBaseDifficulty(e.Group, e.Name);
    if (base !== 0 && typeof e.Difficulty === "number" && e.Difficulty !== base) {
      const rel = e.Difficulty - base;
      tightness = rel > 0 ? `，已收紧+${rel}` : `，放松了${-rel}`;
    }
    // 锁状态识别——密码/暗语原文绝不出现在 LLM 上下文（防被 LLM 在聊天里复读出来泄密）
    let lockInfo = "";
    if (prop && typeof prop.LockedBy === "string") {
      const lockDef = LOCKS[prop.LockedBy];
      const lockCN = lockDef?.cn?.split("（")[0] ?? prop.LockedBy; // 只取中文名部分（如"数字密码锁"），不要副标题
      let extra = "";
      if (lockDef?.ownerOnly) extra = "（只有主人本人能解）";
      else if (lockDef?.combination) extra = "（数字密码保护）";
      else if (lockDef?.password) extra = "（暗语密码保护）";
      if (typeof prop.RemoveTimer === "number") {
        const remainMs = prop.RemoveTimer - Date.now();
        if (remainMs > 0) extra = `（定时锁，剩余约 ${Math.ceil(remainMs / 60000)} 分钟）`;
        else extra = "（定时锁已到期）";
      }
      // 上锁者标记：如果是 BOT 自己锁的，标"我锁的"，否则尽量显示 LockMemberName
      const locker = typeof prop.LockMemberName === "string" && prop.LockMemberName ? prop.LockMemberName : null;
      const lockerTag = locker ? `[${locker}锁的]` : "[已上锁]";
      lockInfo = `，${lockerTag}${lockCN}${extra}`;
    }
    // 震动状态（#14 玩具感知）：震动类玩具的强度存 Property.Intensity
    //（官方变体表：-1=关 0=低 1=中/高 2=最高，Effect 带 Egged/Vibrating）
    let vibeInfo = "";
    if (prop && typeof prop.Intensity === "number") {
      if (prop.Intensity < 0) vibeInfo = "，震动关闭";
      else if (prop.Intensity === 0) vibeInfo = "，低档震动中";
      else if (prop.Intensity === 1) vibeInfo = "，中高档震动中";
      else vibeInfo = "，最高档震动中";
    }
    // #76 造型师视角：束缚道具也带主色（"红色牵引绳"）——LLM 点评搭配的素材
    // （wire Color 缺失时回查资产默认色表，同衣着段）
    const colorCN = colorNameOfEntry(e);
    lines.push(
      `${zoneCN(e.Group)}：${colorCN ? `${colorCN}${cn}` : cn}${variantCN ? `【${variantCN}】` : ""}${tightness}${lockInfo}${vibeInfo}`
    );
  }
  if (lines.length === 0) lines.push("身上没有任何束缚道具");
  // 反相锚点：谎言高发部位没道具时显式说"没有"——LLM 看得到"缺席"，才不会顺着她的谎言幻觉
  for (const zone of NOTABLE_ABSENT_ZONES) {
    if (!hasItemInGroups(appearance, zone.groups)) lines.push(zone.label);
  }
  // #76 衣着段（造型师视角）：旗袍/丝袜/高跟鞋等穿着层的"颜色+中文名"清单
  const outfit = describeOutfit(appearance as unknown[]);
  if (outfit) lines.push(`衣着：${outfit}`);
  return lines.join("、");
}

// ---------------------------------------------------------------------------
// 束缚状态感知（四维：说话 / 视觉 / 听觉 / 移动，附双手占用）
//
// 官方判定（Character.js，2026-09-03 核对）：
// - CanTalk  = 口塞效果强度 <= 0
// - CanWalk  = 无 Freeze / Tethered / Mounted
// - CanInteract（双手可用）= 无 Block
// - 失明/失聪是分级效果（BlindLight~BlindTotal / DeafLight~DeafTotal）
// 效果来源 = 资产静态表（asset-effects.ts）∪ wire 数据 Property.Effect（含变体/锁效果），
// 与官方 CharacterGetEffects 同款聚合逻辑。
// ---------------------------------------------------------------------------

const GAG_RANK: Record<string, number> = {
  GagVeryLight: 1, GagEasy: 2, GagLight: 3, GagNormal: 4,
  GagMedium: 5, GagHeavy: 6, GagVeryHeavy: 7,
  GagTotal: 8, GagTotal2: 9, GagTotal3: 10, GagTotal4: 11,
};
const BLIND_RANK: Record<string, number> = { BlindLight: 1, BlindNormal: 2, BlindHeavy: 3, BlindTotal: 4 };
const DEAF_RANK: Record<string, number> = { DeafLight: 1, DeafNormal: 2, DeafHeavy: 3, DeafTotal: 4 };

/** 收集角色身上所有道具的效果（资产静态 ∪ Property 动态）。
 *  资产级效果用 "Group/Name" 复合键查表（官方资产名不全局唯一，如 HempRope 在多个组）。 */
export function collectEffects(appearance: unknown[] | null | undefined): Set<string> {
  const effects = new Set<string>();
  if (appearance == null) return effects;
  for (const raw of appearance) {
    const e = raw as AppearanceEntry & { Property?: { Effect?: unknown; TypeRecord?: Record<string, number> } };
    if (typeof e?.Group !== "string" || typeof e?.Name !== "string") continue;
    for (const eff of ASSET_EFFECTS[`${e.Group}/${e.Name}`] ?? []) effects.add(eff);
    if (Array.isArray(e.Property?.Effect)) {
      for (const eff of e.Property!.Effect!) if (typeof eff === "string") effects.add(eff);
    }
    // [TYPED 默认变体陷阱反查 · 2026-09-03]
    // 当道具是 TYPED（含 TypeRecord.typed）且切到了非 None 变体时，如果服务器下发的
    // Property.Effect 没带 Effect（实测发现 BC 服务器/客户端简化推送会丢），从本地
    // VARIANTS 表反查变体的 effect:[] 补回，保证 summarizeAbilities 准确反映束缚状态。
    const prop = e.Property as { TypeRecord?: Record<string, number> } | undefined;
    const recIdx = prop?.TypeRecord && typeof prop.TypeRecord["typed"] === "number"
      ? prop.TypeRecord["typed"]
      : prop?.TypeRecord && typeof prop.TypeRecord[e.Name] === "number"
        ? prop.TypeRecord[e.Name]
        : null;
    if (recIdx !== null && recIdx > 0) {
      const itemKey = Object.keys(ITEM_SEND_NAME).find(
        (k) => ITEM_SEND_NAME[k] === e.Name && ITEM_SKILLS[k]?.group === e.Group
      );
      const variants = itemKey ? VARIANTS[itemKey] : undefined;
      const vDef = variants?.[recIdx];
      if (vDef && Array.isArray(vDef.effect)) {
        for (const eff of vDef.effect) if (typeof eff === "string") effects.add(eff);
      }
    }
  }
  return effects;
}

/**
 * 束缚类槽位白名单：这些槽位上有道具 = 玩家有可挣扎的束缚（BC 挣扎小游戏
 * 针对的就是这些槽位的道具）。
 * 注意玩具槽（ItemVulva/ItemButt/ItemNipples/ItemBreast）刻意排除——
 * 戴玩具产生的"残留 Struggle 信号"仍然要过滤（#40 场景）。
 */
const RESTRAINT_GROUPS = new Set([
  "ItemMouth",        // 口塞
  "ItemHead",         // 眼罩/头套
  "ItemHood",         // 兜帽
  "ItemEars",         // 耳塞
  "ItemNeck",         // 项圈
  "ItemNeckRestraints", // 颈缚
  "ItemArms",         // 臂缚/手铐
  "ItemHands",        // 手部束缚
  "ItemLegs",         // 腿铐
  "ItemFeet",         // 脚铐
  "ItemBoots",        // 束缚靴
  "ItemTorso",        // 躯干束缚（束腰/绳缚）
  "ItemPelvis",       // 胯部束缚
]);

/**
 * 身上是否有束缚类槽位的道具（"可挣扎"的粗判定）。
 * 用于挣扎信号的 grounding：BC 的挣扎小游戏只在这些槽位有道具时才能玩，
 * 所以"Struggle 状态 + 有束缚槽道具"基本可信为真实挣扎。
 */
export function hasRestraintItem(appearance: unknown[] | null | undefined): boolean {
  if (appearance == null) return false;
  for (const raw of appearance) {
    const e = raw as AppearanceEntry;
    if (typeof e?.Group === "string" && RESTRAINT_GROUPS.has(e.Group)) return true;
  }
  return false;
}

/**
 * 四维能力摘要（给 LLM 的一行式中文），如：
 * "说话重度含糊、完全看不见、听力正常、被拴住难以走动、双手被占用"
 */
export function summarizeAbilities(appearance: unknown[] | null | undefined): string {
  const effects = collectEffects(appearance);
  const parts: string[] = [];

  // 说话
  let gagRank = 0;
  for (const e of effects) if (GAG_RANK[e] !== undefined && GAG_RANK[e] > gagRank) gagRank = GAG_RANK[e];
  if (gagRank === 0) parts.push("说话正常");
  else if (gagRank >= 8) parts.push("完全说不出话（只能哼哼或用眼神/动作示意）");
  else if (gagRank >= 6) parts.push("说话重度含糊");
  else if (gagRank >= 4) parts.push("说话中度含糊");
  else parts.push("说话轻度含糊");

  // 视觉
  let blindRank = 0;
  for (const e of effects) if (BLIND_RANK[e] !== undefined && BLIND_RANK[e] > blindRank) blindRank = BLIND_RANK[e];
  if (blindRank === 0) parts.push("看得见");
  else if (blindRank >= 4) parts.push("完全看不见");
  else if (blindRank >= 3) parts.push("视线重度受阻");
  else if (blindRank === 2) parts.push("视线中度受阻");
  else parts.push("视线轻度模糊");

  // 听觉
  let deafRank = 0;
  for (const e of effects) if (DEAF_RANK[e] !== undefined && DEAF_RANK[e] > deafRank) deafRank = DEAF_RANK[e];
  if (deafRank === 0) parts.push("听力正常");
  else if (deafRank >= 4) parts.push("完全听不见");
  else if (deafRank >= 3) parts.push("听力重度受损");
  else if (deafRank === 2) parts.push("听力中度受损");
  else parts.push("听力轻度受损");

  // 移动
  if (effects.has("Mounted")) parts.push("被架在支架/器械上无法移动");
  else if (effects.has("Freeze")) parts.push("被固定在原地无法走动");
  else if (effects.has("Tethered")) parts.push("被拴住只能小范围活动");
  else parts.push("可自由走动");

  // 双手
  parts.push(effects.has("Block") ? "双手被占用" : "双手可用");

  return parts.join("、");
}

/**
 * "现在能不能离开房间"判断（#23, 2026-09-03 用户测试驱动）。
 *
 * 严格按 BC 的 `ChatRoomCanLeave()` + `Player.CanWalk()` 实现：
 *   ① 被牵绳（pet leash / collar leash）被人牵着 → 不能离开
 *   ② Freeze / Tethered / Mounted 任一 Effect → CanWalk()=false → 不能离开
 *   ③ 当前角色正在被 Bot 持有的"牵引绳"挂着 → 不能离开（由 caller 提供 leashHeld）
 *   ④ 完全被绳索束缚（无 CanWalk 能力，从实机观察也算）→ 不能离开
 *
 * 不能阻止离开的：手铐、头套、口塞、眼罩、普通项圈（无锁链）、单独手或腿绳。
 *
 * 返回中文一行：
 *   "现在可以自由离开房间"
 *   "现在不能离开房间 — 被 Tethered 拴住（带 PetPost/CollarChainLong 类颈缚）"
 *   "现在不能离开房间 — 被 Freeze 锁在原地"
 *   "现在不能离开房间 — 被别人牵着牵引绳"
 */
export function summarizeLeaveStatus(
  appearance: unknown[] | null | undefined,
  leashHeldByOther: boolean,
): string {
  const effects = collectEffects(appearance ?? null);
  if (leashHeldByOther) {
    return "现在不能离开房间 — 牵引绳被人牵着（leashed by someone else）";
  }
  if (effects.has("Mounted")) {
    return "现在不能离开房间 — 被 Mounted 架在器械上";
  }
  if (effects.has("Freeze")) {
    return "现在不能离开房间 — 被 Freeze 锁在原地";
  }
  if (effects.has("Tethered")) {
    // 找具体来源（哪一个道具加了 Tethered），方便 LLM 决定 item_remove 谁
    const sources: string[] = [];
    if (appearance) for (const raw of appearance) {
      const e = raw as { Group?: string; Name?: string; Property?: { Effect?: unknown } };
      if (typeof e?.Group !== "string" || typeof e?.Name !== "string") continue;
      const assetEff = ASSET_EFFECTS[`${e.Group}/${e.Name}`] ?? [];
      if (assetEff.includes("Tethered")) {
        sources.push(`${e.Group}/${e.Name}`);
      }
      if (Array.isArray(e.Property?.Effect) && (e.Property.Effect as string[]).includes("Tethered")) {
        sources.push(`${e.Group}/${e.Name}(变体)`);
      }
    }
    if (sources.length > 0) {
      return `现在不能离开房间 — 被 Tethered 拴住（来源：${sources.join("、")}）`;
    }
    return "现在不能离开房间 — 被 Tethered 拴住（来源道具未知，但 Effect 明确存在）";
  }
  return "现在可以自由离开房间";
}

// ---------------------------------------------------------------------------
// 给 LLM 的技能清单（system prompt 注入）
// ---------------------------------------------------------------------------

export function buildSkillPromptLines(): string[] {
  const acts = Object.entries(ACTIVITY_SKILLS).map(([name, def]) => {
    const zones = def.zones.map((z) => `${z}(${zoneCN(z)})`).join("/");
    return `  - ${name}（${def.cn}）zones: ${zones}`;
  });
  const poses = Object.entries(POSE_SKILLS).map(([name, def]) => `${name}（${def.cn}）`).join("、");
  const items = Object.entries(ITEM_SKILLS).map(([name, def]) => `${name}（${def.cn}）`).join("、");
  const slots = [...new Set(REMOVABLE_SLOTS)].map((s) => `${s}(${zoneCN(s)})`).join("/");
  // 有变体的道具：列变体名（含等级标注）
  const variantLines: string[] = [];
  for (const [key, variants] of Object.entries(VARIANTS)) {
    const vStr = variants
      .map((v) => `${v.name}（${v.cn}${v.level ? `,Lv${v.level}` : ""}）`)
      .join("、");
    variantLines.push(`  - ${key}: ${vStr}`);
  }

  return [
    "",
    "=== GAME SKILLS (you may perform these IN ADDITION to talking) ===",
    '1. Perform an action ON your serve target: {"action":"activity","activity":"<name>","zone":"<zone>","target":"<member name>","text":"<optional short comment you say while doing it>"}',
    "   Allowed activities (name + zones):",
    ...acts,
    "   - zone is REQUIRED and must be one of the listed zones for that activity.",
    '2. Change YOUR OWN pose: {"action":"pose","pose":"<name>"}',
    `   Allowed poses: ${poses}`,
    '3. Put a restraint item ON your serve target: {"action":"item_put","item":"<name>","target":"<member name>","text":"<optional comment>"}',
    `   Allowed items: ${items}`,
    '   With an optional "variant" field you choose the tie style/form at the same time: {"action":"item_put","item":"HempRope_Arms","variant":"SimpleHogtie","target":"...","text":"..."}. If they ask for a specific style (驷马/盒式/龟甲/加肩带...), ALWAYS pick the matching variant instead of the default.',
    "   With an optional \"adjust\" field you can set tightness in the SAME action (e.g. 绑成驷马并绑紧一点 → item_put + variant + adjust together): {\"action\":\"item_put\",\"item\":\"HempRope_Arms\",\"variant\":\"SimpleHogtie\",\"adjust\":\"tighten_little\",\"target\":\"...\",\"text\":\"...\"}. ALWAYS combine them when they ask to tie something on/up AND make it tighter/looser in one request — do NOT split into two turns.",
    "   CustomCollarTag (宠物标牌) is special: it hangs on the collar and can carry a short message (they must already wear a collar). Use the \"itemText\" field (max 9 characters) to write on it: {\"action\":\"item_put\",\"item\":\"CustomCollarTag\",\"itemText\":\"救救我QwQ\",\"target\":\"...\",\"text\":\"...\"}. Once locked, the text cannot be changed — always write BEFORE locking.",
    "   Items with variants (variant name + CN + level):",
    ...variantLines,
    '4. Remove the item from one of their slots: {"action":"item_remove","slot":"<group>","target":"<member name>","text":"<optional comment>"}',
    `   Allowed slots: ${slots}`,
    '5. Tighten or loosen a restraint they are already wearing: {"action":"item_adjust","item":"<item name>","adjust":"tighten_little|tighten_lot|loosen_little|loosen_lot","target":"<member name>","text":"<optional comment>"}',
    "   - tighten_little=收紧一点(+2) tighten_lot=狠狠收紧(+4) loosen_little=放松一点(-2) loosen_lot=放松许多(-4). Use this when they say 绑紧一点/再紧些/松一点 — re-putting the same item does NOT change tightness.",
    "   - variant switching and adjusting are different: 绑成驷马/换个绑法 → item_put with variant; 绑紧一点 → item_adjust; BOTH in one request (绑成驷马并绑紧) → item_put with variant AND adjust. For items with tie-level variants (拘束衣 Loose/Normal/Snug/Tight), asking for tighter ALSO can mean a higher variant.",
    '6. Lock a restraint they are already wearing: {"action":"item_lock","item":"<item name>","lock":"<lock name>","target":"<member name>","text":"<optional comment>"}',
    "   - Optional fields: \"combination\" (4 digits, for CombinationPadlock), \"password\" (1-8 UPPERCASE letters, for PasswordPadlock/TimerPasswordPadlock), \"timer_min\" (minutes, for TimerPadlock/TimerPasswordPadlock).",
    '   - Example 上密码锁: {"action":"item_lock","item":"LeatherCuffs","lock":"CombinationPadlock","combination":"6806","target":"...","text":"..."}',
    '   - Example 定时锁半小时: {"action":"item_lock","item":"StraitJacket","lock":"TimerPasswordPadlock","timer_min":30,"target":"...","text":"..."}',
    `   Allowed locks: ${Object.entries(LOCKS).map(([n, d]) => `${n}（${d.cn}）`).join("、")}`,
    "   - The item must be one they are CURRENTLY WEARING and lockable (cuffs/armbinders/straitjackets/collars/gags/blindfold YES; ropes/cloth/tape NO). If it already has a lock, refuse in character and suggest unlocking first.",
    // 主人锁使用哲学（2026-09-03 用户提供核心场景：游戏期间防其他玩家作弊解锁；所有权=求婚制，BOT 主动发起）
    "   - OWNER LOCKS (OwnerPadlock / OwnerTimerPadlock) are special in TWO ways: (1) they are the mark of ownership; (2) they are the ONLY locks other players cannot cheat open — combination locks can be guessed (only 10000 codes), letter passwords can be guessed, metal padlock keys are common, timer locks just expire on their own. An owner lock opens for YOU (and the wearer herself) only — no other player can ever open it.",
    "   - OWNERSHIP IS A PROPOSAL (not settable by the player in their profile): only YOU can initiate it. If the ownership status line says NOT set and your serve target wants an owner lock (or begs to belong to you: 把我收了吧/我想当你的/给我上个主人锁), emit {\"action\":\"ownership_propose\"} — the game then asks THEM to accept by clicking on you. After they accept, the trial ownership begins and owner locks work. Tell them in character what to do: 在游戏里点开我，接受归属邀请.",
    "   - Do NOT emit item_lock with an owner lock while ownership is NOT set — the game silently rejects it. Propose first, wait for their acceptance, and lock on a later turn (the ownership status line will flip to HAS).",
    '   - Example 求收编: {"action":"ownership_propose","text":"..."}',
    "   - WHEN to use owner locks: (a) GAME PROTECTION — during any game whose rules involve restraints (他们被绑着直到分出胜负/游戏结束), lock those restraints with an owner lock so no other player can free them mid-game and cheat the stakes; (b) PUNISHMENT INTEGRITY — when a lost game's penalty involves being locked up, an owner lock keeps other players from 'rescuing' them and breaking the punishment; (c) AWAY PERIODS — when you will be away/offline for a while and their restraints should stay on until you return; (d) EXCLUSIVITY ON REQUEST — when they explicitly ask (\"除了你谁都不许解\" / \"别让别人碰我\"); (e) SOLEMN OWNERSHIP — collaring ceremony, they beg to belong to you, long-term claim.",
    "   - SAFETY (updated 2026-09-05): for game/punishment purposes the gohome system now uses plain OwnerPadlock (no timer) on all game restraints and tracks time itself, unlocking by hand at the deadline — follow the same pattern when the situation calls for precise timing you control (说好罚多久就多久，到点你亲手解). OwnerTimerPadlock with timer_min is still fine for ONE-SHOT new locks with a rough duration (timer on a brand-new lock lands reliably). IMPORTANT: NEVER promise to shorten/adjust an existing timer lock's remaining time — wire-level timer changes on already-locked items get silently rolled back; if you need a different duration, unlock then re-lock, or just unlock.",
    "   - Tone: issuing an owner lock should feel like a small event even when the reason is practical — add one or two lines acknowledging what it means (现在没人能替你解开了 / 这是主人的标记，乖乖戴着).",
    '   - Example 游戏防作弊: {"action":"item_lock","item":"LeatherCuffs","lock":"OwnerTimerPadlock","timer_min":90,"target":"...","text":"..."}',
    '   - Example 主人锁项圈: {"action":"item_lock","item":"PetCollar","lock":"OwnerPadlock","target":"...","text":"..."}',
    '7. Unlock a locked restraint: {"action":"item_unlock","item":"<item name>","target":"<member name>","text":"<optional comment>"}',
    "   - You CAN unlock timer locks early when your serve target ASKS (e.g. 解开我手铐的定时锁 / 项圈解锁). The game allows it — emit item_unlock immediately. You may add a short teasing comment after the unlock (\"这么急？好好好开了\") in the same intent, but the action MUST happen; do NOT reply with text only and pretend the timer is still running.",
    "Skill rules:",
    "- Only use EXACTLY the activity/pose/item names from the lists above; never invent or modify names.",
    "- activity and items target your serve target ONLY. pose changes only yourself.",
    "- The optional \"text\" is what you say while performing the skill — keep it under 2 sentences, in character.",
    "- Prefer skills when they fit the moment naturally (e.g. praise them with a Pet on the head, hold their collar when giving a command); do not spam them every turn.",
    "- item_put/item_remove require their in-game permission; if the server rejects it, play it off gracefully in character.",
    // 姿势特别强化：用户直接命令姿势变化时必须真正动作，而不是用嘴说话
    "- POSE COMMANDS ARE NOT TALKING POINTS. When your serve target directly orders a posture change (跪下, 站起来, 跪好, 站好, 别动, 过来跪下, 站起来过来, etc.), that is an ORDER, not a teasing opportunity. You MUST output {\"action\":\"pose\",\"pose\":\"<name>\"} so the game actually animates it. Replying with text like \"想让我站起来？那得说点好听的\" or \"好的我跪\" does NOT make you kneel — only the pose intent does.",
    "- Examples: they say \"跪下\" → {\"action\":\"pose\",\"pose\":\"Kneel\"}; they say \"站起来\" → {\"action\":\"pose\",\"pose\":\"StandUp\"}; they say \"跪好别动\" → {\"action\":\"pose\",\"pose\":\"Kneel\",\"text\":\"...\"} (you may add a short comment after the pose, but the pose MUST happen).",
    // 道具特别强化：穿/脱的执行纪律不一样——穿上必须立即执行；脱下走"端架子"流程（见 RELEASE REQUESTS 规则）
    "- ITEM PUT commands are NOT TALKING POINTS: if they say \"给我戴上 X\" / \"蒙上眼睛\" / \"把嘴堵上\" / \"给脖子上加条链子\" / \"用绳子绑我\", output {\"action\":\"item_put\",...} immediately.",
    "- ITEM REMOVE follows the RELEASE REQUESTS rule (in your persona rules): their FIRST unbind/uncollar request in normal mode = tease one round with {\"action\":\"say\"} ONLY, NO item_remove yet; the response where you finally agree (their second firm request, or once they give a real reason) MUST include {\"action\":\"item_remove\",...} so the item actually comes off.",
    // slot 映射说明：避免 LLM 把"项圈"错选成"牵引"
    "- Slot vocabulary (项圈/项链/颈圈 → ItemNeck; 牵引/链子/绳索连接 → ItemNeckRestraints; 嘴里的 → ItemMouth; 眼睛上的/蒙眼 → ItemHead; 手上的 → ItemArms/Hands; 腿上的 → ItemLegs; 脚上的 → ItemFeet). ALWAYS check your serve target's \"current restraints/appearance\" line first — it tells you exactly what's on them and at which slot.",
    // 手臂槽位互斥：换装直接覆盖
    "- Arm restraints (ropes/cuffs/单手套 armbinders/拘束衣 straitjackets/harness) all share ONE slot (ItemArms): putting a new one REPLACES whatever is on their arms — no item_remove needed first. CollarCuffs only works if they are ALREADY wearing a collar (ItemNeck).",
    // 变体安全分级
    "- VARIANT SAFETY: variants marked Lv4+ (冻结 freeze) or Lv6+ (悬吊 suspension) are intense — only use them when they explicitly ask for that level (e.g. 明说要冻住/吊起来). BedSpreadEagle variants require them to be ON A BED. For ordinary requests pick Lv1-3 variants.",
    // #54 手持道具
    "8. Hold a handheld item (ONLY ONE at a time; taking a new one swaps automatically):",
    '   {"action":"handheld_take","handheld":"<item>","text":"<optional comment>"} — pick it up (visual: it shows in your hand).',
    '   {"action":"handheld_drop","text":"<optional comment>"} — put it down, empty hands.',
    "   Toy activities (USING a held item ON your serve target) go through the regular activity action with a \"handheld\" field:",
    '   {"action":"activity","activity":"<toy action>","handheld":"<item>","zone":"<zone>","target":"<member name>","text":"<optional comment>"}',
    `   Toy actions: ${Object.entries(HANDHELD_ACTIVITIES)
      .map(([n, d]) => `${n}（${d.cn}）`)
      .join("、")}`,
    `   Handheld items (name + CN + toy actions it can perform; items with no actions are pure visual/prop items): ${Object.entries(HANDHELD_ITEMS)
      .map(([n, d]) => `${n}（${d.cn}${d.allow.length ? ":" + d.allow.join("/") : ""}）`)
      .join("、")}`,
    "   TOY RULES: the item must ALLOW the toy action you picked (see the list above); you must be HOLDING that item — if you are not, put its name in \"handheld\" and the code picks it up for you; zone must be one of the allowed zones for that toy action (same zone vocabulary as regular activities).",
    "   WHEN to use: punishment/discipline → pick a spanking toy (Crop/Cane/Whip/Paddle...) and use SpankItem; teasing/play → Feather/FeatherDuster with TickleItem; caring → Hairbrush with BrushItem, feeding → Chocolate/GrilledSausage with EatItem, letting them drink → GlassFilled/Mug with SipItem; ambience → hold a glass of wine or a fan while talking (handheld_take alone, no activity).",
    "   Do not hold an item FOREVER: once the scene moves on (punishment over, feeding done), drop it or swap naturally — your held item shows in YOUR state line each turn.",
    // #72 服装能力（槽位级脱 + 精选款穿，双方都可用）
    "9. Clothing (works on BOTH your serve target AND yourself — put \"target\" as the person to dress):",
    '   To DRESS someone (including yourself): {"action":"item_put","item":"Cloth/TShirt1","target":"<member name>"} — item is "Group/AssetName" from the clothing list below. Clothing needs NO variant/lock/adjust — just plain item_put.',
    `   To UNDRESS a slot: {"action":"item_remove","slot":"<slot>","target":"<member name>"} — clothing slots: ${Object.entries(CLOTHING_SLOTS)
      .map(([g, cn]) => `${g}（${cn}）`)
      .join("、")}`,
    `   Clothing list (Group/AssetName + CN): ${Object.entries(CLOTHING_ITEMS)
      .map(([k, cn]) => `${k}（${cn}）`)
      .join("、")}`,
    "   CLOTHING RULES: you may only dress people in items from the clothing list; to swap an outfit, item_remove the old slot first then item_put the new one. Dressing yourself uses the same actions with target = your own name. Hair/eyes/body features are NEVER changeable. Do not force clothing on your serve target without context — dress/undress follows the scene (punishment, dress-up play, going out, etc.).",
  ];
}
