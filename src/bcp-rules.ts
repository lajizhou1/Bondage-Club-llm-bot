/**
 * #89 BC+ 第三步「深度层」——规矩（Rules）白名单。
 *
 * BC+ 的 Rules 模块管的是「她本人能做什么」。她被下了一条规矩之后，
 * **她自己的客户端**会真的去拦（比如打不出私聊、发不出表情），
 * 不是 BOT 在这边表演。
 *
 * ## 通路
 * BOT 发 `{message:"RuleCommand", action, rule, value}`（定向给她），
 * 她的 Rules 模块校验五道门后生效，然后：
 *   ① 回一条 `RuleCommandResult {ok, rule, reason?}` 给 BOT
 *   ② 把新的 rules 数据定向回广播给 BOT（Rules 是 PublicData 模块）
 * 所以「下发 → 确认 → 状态核对」是天然闭环，不需要额外做验证。
 *
 * ## 分档（本文件的核心）
 * 67 条规矩里，有一部分是「约束她怎么说话」，另一部分是「拿走她的能力」，
 * 后者下错了会真的让她玩不下去。所以：
 *   - A 档：只约束表达/姿态。LLM 可自主下发，口令也可用。
 *   - C 档：会限制自由或拿走能力（锁昵称/剥夺视觉/不许离开房间/不许分手…）。
 *           **只能靠口令显式下发，LLM 不许自主决定**，且需要二次确认。
 *   - X 档：永不开放。
 *
 * ## 三条硬红线
 * 1. `settings.safeword` 永不开放——BOT 不许碰她的安全词设置（对应项目里
 *    「安全词＝真拒绝」的原则，代码层兜底）。
 * 2. `protect.hardcore` 永不开放——硬核模式下她被绑住就没法自救。
 * 3. BOT 只能「加规矩」和「撤自己加的规矩」，不许靠这些规矩把她焊死。
 *    她本人随时能在 BC+ 面板里手动关掉，这是天然的安全网。
 */

export type RuleTier = "A" | "C" | "X";

export interface BcpRuleDef {
  /** BC+ 的规矩 id，必须与她客户端注册表里的完全一致 */
  id: string;
  /** 中文名（BOT 说话时用这个，不许在角色里说英文 id） */
  zh: string;
  tier: RuleTier;
  /**
   * 允许 LLM 在自然对话里自主下发。
   * 只给 A 档里最适合调教场景的一小批——清单太长会稀释 prompt。
   */
  llmAuto?: boolean;
  /** 给 LLM 看的一句话说明（只在 llmAuto 时进 prompt） */
  note?: string;
}

/**
 * 67 条规矩全表。
 * 顺序 = BC+ 面板里的展示顺序（对齐 src/rules/index.ts 的 RULE_DEFINITIONS）。
 */
export const BCP_RULES: readonly BcpRuleDef[] = [
  // ── 姿态与身体（A 档：只改姿势，随时可站回来）
  { id: "body.forceKneel", zh: "强制跪着", tier: "A", llmAuto: true, note: "她站着就会被迫跪下——最直接的「让她摆正位置」" },
  { id: "body.forcedPosition", zh: "强制固定姿势", tier: "A", note: "配合「固定哪个姿势」的参数使用，参数需在面板里设" },
  { id: "body.controlOrgasms", zh: "控制高潮", tier: "C" },
  { id: "body.secretOrgasms", zh: "隐藏兴奋度", tier: "A", note: "她看不到自己的兴奋度，只有你能看到" },

  // ── 控制（C 档：动她的身份与自由）
  { id: "control.difficulty", zh: "不许改难度", tier: "A", note: "锁住逃脱难度，她不能自己调低" },
  { id: "control.activities", zh: "不许使用动作", tier: "A" },
  { id: "control.emoticon", zh: "不许换表情", tier: "A" },
  { id: "control.leash", zh: "限制谁能牵她", tier: "C" },
  { id: "control.nickname", zh: "锁住她的昵称", tier: "C" },
  { id: "control.profile", zh: "锁住她的简介", tier: "C" },

  // ── 说话方式（A 档：最安全，也最像「被管着」）
  { id: "speech.dollTalk", zh: "只能玩偶腔说话", tier: "A", llmAuto: true, note: "她说话会变成布偶腔调" },
  { id: "speech.faltering", zh: "说话必须结巴", tier: "A", note: "她说话会变成结结巴巴" },
  { id: "speech.restrainedSpeech", zh: "束缚腔说话", tier: "A", note: "她说话会像被捆着一样含糊" },
  { id: "speech.forbidWhisper", zh: "不许私聊", tier: "A", llmAuto: true, note: "她没法再对别人耳语——独占感最强的一条" },
  { id: "speech.forbidOOC", zh: "不许说 OOC", tier: "A", note: "她不能在括号里跳出角色说话" },
  { id: "speech.gaggedOOC", zh: "堵嘴时不许 OOC", tier: "A", note: "被堵嘴时连括号话都说不出" },
  { id: "speech.forbidShouting", zh: "不许大喊", tier: "A", note: "她没法用大喊吸引全场注意" },
  { id: "speech.forbidEmotes", zh: "不许用表情动作", tier: "A", llmAuto: true, note: "她发不出表情动作" },
  { id: "speech.forbiddenWords", zh: "禁用词", tier: "C", note: "词表需在面板里设，BOT 只开关" },
  { id: "speech.mandatoryWords", zh: "必须说的话", tier: "C", note: "每次发言必须带上指定词，词表需在面板里设" },
  { id: "speech.wordReplace", zh: "词语替换", tier: "C", note: "把她说的某个词自动换成别的，词表需在面板里设" },

  // ── 社交（A 档为主）
  { id: "social.greetRoom", zh: "进房必须打招呼", tier: "A", llmAuto: true, note: "她进任何房间都得先问好，否则被记违规" },
  { id: "social.farewell", zh: "离开必须道别", tier: "A", note: "她离开房间前必须先说再见" },
  { id: "social.forbidBeepMessages", zh: "不许发 Beep 消息", tier: "A" },
  { id: "social.forbidBeeps", zh: "不许发 Beep", tier: "A", note: "她没法用 Beep 叫人" },
  { id: "social.friendListChanges", zh: "不许改好友列表", tier: "C" },
  { id: "other.listenToMyVoice", zh: "只听我的", tier: "A", llmAuto: true, note: "她必须优先听你说话，忽视别人" },
  { id: "other.summon", zh: "随叫随到", tier: "A", llmAuto: true, note: "你随时可以召唤她" },
  { id: "chat.forbidLeaving", zh: "不许离开房间", tier: "C" },

  // ── 宠物（A 档）
  { id: "pet.speech", zh: "像宠物一样说话", tier: "A", llmAuto: true, note: "她只能用宠物腔说话" },
  { id: "pet.hearing", zh: "宠物听觉", tier: "A" },

  // ── 保护（C 档：锁关系，属于长期承诺，慎用）
  { id: "protect.ownerChanges", zh: "不许换主人", tier: "C" },
  { id: "protect.newLovers", zh: "不许加新恋人", tier: "C" },
  { id: "protect.breakup", zh: "不许分手", tier: "C" },
  { id: "protect.newSubs", zh: "不许收新奴", tier: "C" },
  { id: "protect.disowning", zh: "不许解除主奴关系", tier: "C" },
  { id: "protect.hardcore", zh: "硬核模式", tier: "X" },
  { id: "protect.blacklist", zh: "不许拉黑", tier: "C" },
  { id: "protect.whitelist", zh: "不许加白名单", tier: "C" },

  // ── 行动（C 档）
  { id: "body.afkBehavior", zh: "挂机时的行为", tier: "A" },
  { id: "rooms.create", zh: "不许建房", tier: "C" },
  { id: "rooms.entry", zh: "限制进房", tier: "C" },
  { id: "rooms.adminUI", zh: "看不见时禁用房间管理", tier: "A" },

  // ── 感官（C 档：剥夺，影响体验最重）
  { id: "sensory.sound", zh: "剥夺听觉", tier: "C" },
  { id: "sensory.hearingWhitelist", zh: "只有白名单能对她说", tier: "C" },
  { id: "sensory.sight", zh: "剥夺视觉", tier: "C" },
  { id: "sensory.seeingWhitelist", zh: "只有白名单她看得见", tier: "C" },

  // ── 强制 BC 设置（C 档：动的是她的游戏设置）
  { id: "settings.itemPermission", zh: "锁住道具权限", tier: "C" },
  { id: "settings.lockpickingSelf", zh: "锁住自己开锁", tier: "C" },
  { id: "settings.spRooms", zh: "锁住单人房设置", tier: "C" },
  // 红线：安全词永远不会出现在这里，见文件头注释
  { id: "settings.safeword", zh: "安全词设置", tier: "X" },
  { id: "settings.arousalMeter", zh: "锁住兴奋度表显示", tier: "C" },
  { id: "settings.arousalStutter", zh: "锁住兴奋结巴", tier: "C" },
  { id: "settings.vibeModes", zh: "锁住振动模式", tier: "C" },
  { id: "settings.afkBubble", zh: "锁住挂机气泡", tier: "C" },
  { id: "settings.bodyMod", zh: "锁住身体改造权限", tier: "C" },
  { id: "settings.cosplayChange", zh: "锁住装扮切换", tier: "C" },
  { id: "settings.sensdep", zh: "锁住感官剥夺设置", tier: "C" },
  { id: "settings.hideNonAdjacent", zh: "锁住隐藏非相邻玩家", tier: "C" },
  { id: "settings.blindRoomGarbling", zh: "锁住失明时房间杂音", tier: "C" },
  { id: "settings.relogKeepsRestraints", zh: "锁住重登保留束缚", tier: "C" },
  { id: "settings.leashedRoomChange", zh: "锁住被牵换房", tier: "C" },
  { id: "settings.roomRejoin", zh: "锁住重进房间", tier: "C" },
  { id: "settings.plugVibeEvents", zh: "锁住插具事件", tier: "C" },
  { id: "settings.tintEffects", zh: "锁住染色效果", tier: "C" },
  { id: "settings.blurEffects", zh: "锁住模糊效果", tier: "C" },
  { id: "settings.upsideDownView", zh: "锁住倒立视角", tier: "C" },
];

/** BOT 能下发的动作（值都是布尔，结构最简单、最不容易翻车） */
export const BCP_RULE_ACTIONS = ["setActive", "setEnforce", "setLog", "setAnnounce"] as const;
export type BcpRuleAction = (typeof BCP_RULE_ACTIONS)[number];

/** 每个动作的中文说法，用于日志与台词 */
export const BCP_RULE_ACTION_LABELS: Record<BcpRuleAction, string> = {
  setActive: "启停",
  setEnforce: "强制拦截",
  setLog: "记录违规",
  setAnnounce: "公开通报",
};

const RULE_BY_ID = new Map(BCP_RULES.map((r) => [r.id, r]));
const RULE_BY_ZH = new Map(BCP_RULES.map((r) => [r.zh, r]));

/**
 * 把一个用户/LLM 给的写法解析成规矩。
 * 认：完整 id（大小写不敏感）、中文名、以及"去掉前缀的点号写法"（如 forbidWhisper）。
 */
export function findBcpRule(key: string): BcpRuleDef | undefined {
  const raw = key.trim();
  if (raw.length === 0) return undefined;
  const lower = raw.toLocaleLowerCase();

  const exact = RULE_BY_ID.get(raw) ?? RULE_BY_ID.get(lower);
  if (exact) return exact;

  const zh = RULE_BY_ZH.get(raw);
  if (zh) return zh;

  // 只写后段（"forbidWhisper" / "kneel"）时唯一命中才认，歧义就不猜
  const suffix = BCP_RULES.filter((r) => r.id.toLocaleLowerCase().endsWith(`.${lower}`));
  if (suffix.length === 1) return suffix[0];

  return undefined;
}

export function bcpRuleTier(rule: BcpRuleDef): RuleTier {
  return rule.tier;
}

/** LLM 能不能自主下发这条规矩 */
export function llmMayApplyRule(rule: BcpRuleDef): boolean {
  return rule.tier === "A" && rule.llmAuto === true;
}

/**
 * 喂给 LLM 的规矩清单（只列可自主下发的）。
 * 刻意保持短——清单越长，模型越容易乱选。
 */
export function llmRuleCatalog(): string {
  return BCP_RULES.filter(llmMayApplyRule)
    .map((r) => `  - ${r.id}（${r.zh}）：${r.note ?? ""}`)
    .join("\n");
}

/** 她当前已开启的规矩 id → 中文名（认不出的原样保留） */
export function describeActiveRules(ids: readonly string[]): string[] {
  return ids.map((id) => {
    const def = RULE_BY_ID.get(id);
    return def ? `${def.zh}（${id}）` : id;
  });
}

/** 口令里给用户看的清单：按档分组，只列中文名 */
export function ruleCatalogForHumans(): string {
  const a = BCP_RULES.filter((r) => r.tier === "A").map((r) => r.zh);
  const c = BCP_RULES.filter((r) => r.tier === "C").map((r) => r.zh);
  return `安全档（可直接下）：${a.join(" / ")}\n重度档（需确认）：${c.join(" / ")}`;
}

/** 全部合法 id（供日志与自检） */
export function allBcpRuleIds(): string[] {
  return BCP_RULES.map((r) => r.id);
}
