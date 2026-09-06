import dotenv from "dotenv";

dotenv.config();

export interface Config {
  bcUsername: string;
  bcPassword: string;
  serverUrl: string;
  proxyUrl: string | null;
  origin: string;
  userAgent: string;
  roomName: string | null;
  roomSpace: string;
  botName: string | null;
  /** 一对一服务对象：注册号（数字）或昵称。设置了则只服务此人，其他人降级为"不重要信息"。 */
  serveMember: string | null;
  /** 安全词：服务对象说出 = 真正拒绝（立即停止并安抚）；不含安全词的拒绝话视为 RP。支持逗号/顿号分隔多个。 */
  safeWord: string | null;
  /** 测试模式：BOT 无条件服从服务对象指令（不调戏、不拖延），方便测试技能。也可在聊天里用口令动态开关。 */
  testMode: boolean;
  /**
   * NSFW 尺度档位（玩具/亲密互动描写）：0=含蓄（仅心理/氛围层面）、1=中度（暗示性感官描写）、
   * 2=直白（consenting 成人间官能描写）。三条红线（未成年/非自愿/真实伤害）在任何档位都不放。
   * 可用 NSFW_LEVEL 环境变量设默认，服务对象也可在聊天里用"尺度含蓄/尺度中度/尺度直白"切换。
   */
  nsfwLevel: number;
  respondToAll: boolean;
  responseCooldownMs: number;
  maxReplyLength: number;
  /** #21 游戏结算"定时惩罚"持续时间（分钟）。上 OwnerPadlock 后 BOT 端 setTimeout 主动解锁。 */
  punishLockMinutes: number;
  /**
   * 上锁时的"锁死难度"（绝对难度目标）。BC 挣扎判定 S = Evasion - Item.Difficulty
   * - Property.Difficulty - 4(锁)，当 S < -6 时挣扎"不可能"（进度锁死 99%，无法挣脱）。
   * 取 30 可覆盖 Evasion 满级（15）+ 各种减项，保证定时惩罚期间服务对象无法挣脱。
   */
  lockDifficulty: number;
  /**
   * 惩罚类束缚的"锁死难度"（绝对难度目标，2026-09-04 22:05 用户要求：暴怒束缚也能挣脱 → 惩罚拉满）。
   * 适用于：非平静档（或"惩罚我"口令期间）针对服务对象的 bind/gag/tighten 惩罚动作。
   * 原理同 lockDifficulty：她开了 BypassStruggle，挑战值 ≤ 6 的束缚几秒自动滑脱——
   * 中间难度对她没有意义，要么自动滑脱要么直接"不可能挣脱"（挑战值 > 6，进度钳 99%）。
   * 释放出口：恳求阶梯（BOT 主动松绑）/ 安全词 / 降档，而不是自己挣脱。
   */
  punishBindDifficulty: number;
  /** #46 怒气情绪系统开关（ANGER_SYSTEM=false 关闭；默认开） */
  angerEnabled: boolean;
  /** #47 亲密度系统开关（INTIMACY_SYSTEM=false 关闭；默认开）。亲密度跨重启持久化（data/intimacy.json） */
  intimacyEnabled: boolean;
  /** #16 限时回家游戏开关（GOHOME_ENABLED=false 关闭；默认开） */
  gohomeEnabled: boolean;
  /** #16 限时回家：限时上限（分钟，默认 15）。实际每局 = 战绩基线（连胜 1/2/3+ 局 → 12/10/8）
   *  + LLM ±3 分钟情境微调，最终 clamp 到 [下限, 上限]。2026-09-06 用户定案 */
  gohomeTimeLimitMin: number;
  /** #16 限时回家：限时下限（分钟，默认 5）——低于这个她挂牌即超时，游戏失去意义 */
  gohomeTimeMinFloor: number;
  /** #16 限时回家：目标热闹房最少人数（默认 4） */
  gohomeMinPlayers: number;
  /** #16 限时回家：换房找热闹房的最多尝试间数（默认 5）。全都冷清 → 兜底去人数最多的房挂标牌 */
  gohomeRoomAttempts: number;
  gohomeSampleSecFemale: number;
  gohomeSampleSecMixed: number;
  gohomeRoomAttemptsFemale: number;
  gohomeRoomAttemptsMixed: number;
  /** #16 限时回家：收场进热闹房失败（满员/不存在）时的重试次数（默认 5）与重试间隔秒数（默认 30） */
  gohomeJoinRetryMax: number;
  gohomeJoinRetryDelaySec: number;
  /** #16 跨区局：等她自己走过来的超时秒数（默认 180） */
  gohomeFollowTimeoutSec: number;
  /** #16 跨区会合（2026-09-06 新流程）：Beep 让她去目标区后，轮询 OnlineFriends
   * 等她落位的总窗口秒数（默认 120，约 1-2 分钟） */
  gohomeReunionTimeoutSec: number;
  /** #16 跨区会合轮询间隔秒数（默认 10） */
  gohomeReunionPollSec: number;
  /** #16 胜负奖惩（2026-09-05 定案）：失败基础锁分钟（默认 15） */
  gohomePunishBaseMin: number;
  /** #16 认输/作弊额外锁 = 游戏剩余分钟 × 倍数（默认 2） */
  gohomePunishRemainMult: number;
  /** #16 作弊（戴牌回家/挣脱拆牌）加怒气（默认 35） */
  gohomeCheatAnger: number;
  /** #16 赢家亲密度加成（默认 5） */
  gohomeWinIntimacy: number;
  /** #16 强制指定下一局采样区（测试用）：GOHOME_FORCE_SPACE=混区/X 或 女区/F；
   * 未设置/留空 = 每局随机。每次重启后的第一局生效，之后恢复随机（测完建议删掉这行） */
  gohomeForceSpace: string | null,
  /** #16 限时回家：讲完规则等她点头的窗口（分钟，默认 3）。点头才开始上束缚；超时不点头=作废重喊 */
  gohomeConsentTimeoutMin: number;
  /** #16 限时回家：PetPost 宠物拴柱便签上写的文字（≤14 字符，上锁后不可改） */
  gohomeTagText: string;
  /** #61 BOT 道具互动白名单追加名单（BOT_ITEM_WHITELIST，逗号分隔注册号）。
   *  默认 = 服务对象（SERVE_MEMBER）一人；ItemPermission=3 时名单外玩家不能动 BOT 的穿戴 */
  botItemWhitelist: number[];
  /** #71 一次性紧急解套：列出启动时要从 BOT 自身外观里脱掉的 Item* 道具名（仅清理列出的，不碰其他）
   *  留空=不清理。用法见下方实现注释。 */
  botEmergencyStrip: string[];
  /** #60 BOT 默认服装：启动首次进房是否自动重穿存档。默认 true（路人乱穿后自愈）；
   *  设 false 时保留玩家手动穿好的外观（不读存档、不重穿），但白名单权限照常生效 */
  botOutfitOnStartup: boolean;
  /**
   * #62 BOT 每次进房自动摆的姿势（姿势名须在 POSE_SKILLS 白名单内，如 "LegsClosed"=双腿并拢站好）。
   * 默认 "LegsClosed"；设为空串（BOT_JOIN_POSE= 留空）则不摆。
   * 只在进房瞬间设置一次——之后服务对象仍可用口令让 BOT 换姿势（跪下/站起来等）。
   */
  botJoinPose: string;
  /** #63 主动/被动模式总开关（PROACTIVE_ENABLED=false 关闭；默认开。关闭时永远纯被动=现状） */
  proactiveEnabled: boolean;
  /** #63 主动模式：开窗后窗口时长（分钟，默认 30）。窗口内 BOT 定时感知可主动行动；到期回落被动 */
  proactiveWindowMin: number;
  /** #63 主动模式：窗口内定时感知间隔（秒，默认 240 = 4 分钟）。她进房另会即时触发一次 */
  proactivePerceiveSec: number;
  /** #63 主动模式：冷场门槛（秒，默认 180）——距她上次发言不足此值时 tick 直接跳过
   *  （刚被被动响应接待过，不重复插话）。游戏进行中放宽为 60 秒（游戏需要推进） */
  proactiveSilenceMinSec: number;
  /** #63 主动模式：两次主动行动的最小间隔（秒，默认 150，防刷屏硬上限）；与最近一次被动回复也共用此间隔 */
  proactiveMinGapSec: number;
  /** #63 主动模式：连续 idle（LLM 决定不行动）达到此次数提前关窗（默认 3）——没事可做就不硬撑 */
  proactiveIdleClose: number;
  /** #64 集中/扩散模式总开关（SOCIAL_ENABLED=false 关闭；默认开。关闭时永远集中=现状一对一） */
  socialEnabled: boolean;
  llm: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    /** 思考强度：low/high/max；留空 = 不传（用 API 默认 high）。仅思考模式生效 */
    reasoningEffort: string;
    persona: string;
  };
}

function toBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function toInt(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : def;
}

export const config: Config = {
  bcUsername: process.env.BC_USERNAME ?? "",
  bcPassword: process.env.BC_PASSWORD ?? "",
  serverUrl: process.env.BC_SERVER_URL ?? "https://bondage-club-server.herokuapp.com/",
  proxyUrl: process.env.BC_PROXY_URL?.trim() || null,
  origin: process.env.BC_ORIGIN ?? "https://www.bondage-europe.com",
  userAgent:
    process.env.BC_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  roomName: process.env.BC_ROOM_NAME?.trim() || null,
  // 注意：女区 Space 是空字符串 ""，不能用 `|| "X"` 兜底（会把空字符串误当成"未设置"）。
  roomSpace: process.env.BC_ROOM_SPACE !== undefined ? process.env.BC_ROOM_SPACE.trim() : "X",
  botName: process.env.BOT_NAME?.trim() || null,
  // 一对一服务对象：填注册号（数字）最稳定，也可填昵称。留空则不开启一对一。
  serveMember: process.env.SERVE_MEMBER?.trim() || null,
  safeWord: process.env.SAFE_WORD?.trim() || null,
  testMode: toBool(process.env.BC_TEST_MODE, false),
  nsfwLevel: Math.max(0, Math.min(2, toInt(process.env.NSFW_LEVEL, 0))),
  respondToAll: toBool(process.env.RESPOND_TO_ALL, false),
  responseCooldownMs: toInt(process.env.RESPONSE_COOLDOWN_MS, 1500),
  maxReplyLength: toInt(process.env.MAX_REPLY_LENGTH, 400),
  punishLockMinutes: toInt(process.env.PUNISH_LOCK_MINUTES, 15),
  lockDifficulty: toInt(process.env.LOCK_DIFFICULTY, 30),
  punishBindDifficulty: toInt(process.env.PUNISH_BIND_DIFFICULTY, 30),
  /** #46 怒气情绪系统开关（ANGER_SYSTEM=false 关闭；默认开） */
  angerEnabled: toBool(process.env.ANGER_SYSTEM, true),
  intimacyEnabled: toBool(process.env.INTIMACY_SYSTEM, true),
  gohomeEnabled: toBool(process.env.GOHOME_ENABLED, true),
  gohomeTimeLimitMin: toInt(process.env.GOHOME_TIME_LIMIT_MIN, 15),
  gohomeTimeMinFloor: toInt(process.env.GOHOME_TIME_MIN_FLOOR, 5),
  // （GOHOME_LOCK_BUFFER_MIN 已随 OwnerTimerPadlock 方案一并移除——2026-09-05 23:52
  //  改无限期主人锁 + BOT 计时，锁上不再有时间概念，缓冲配置失去意义）
  gohomeMinPlayers: toInt(process.env.GOHOME_MIN_PLAYERS, 4),
  gohomeRoomAttempts: toInt(process.env.GOHOME_ROOM_ATTEMPTS, 5),
  /** #16 采样参数按区分：混区房多但玩家更密，需更密集采样（2026-09-05 21:36 用户） */
  gohomeSampleSecFemale: toInt(process.env.GOHOME_SAMPLE_SEC_FEMALE, 30),
  gohomeSampleSecMixed: toInt(process.env.GOHOME_SAMPLE_SEC_MIXED, 15),
  gohomeRoomAttemptsFemale: toInt(process.env.GOHOME_ROOM_ATTEMPTS_FEMALE, 5),
  gohomeRoomAttemptsMixed: toInt(process.env.GOHOME_ROOM_ATTEMPTS_MIXED, 10),
  /** 收场进热闹房失败（如满员 RoomFull）时的重试参数（09-05 实测满员进不去只能干等） */
  gohomeJoinRetryMax: toInt(process.env.GOHOME_JOIN_RETRY_MAX, 5),
  gohomeJoinRetryDelaySec: toInt(process.env.GOHOME_JOIN_RETRY_DELAY_SEC, 30),
  /** #16 跨区局：选了与家不同区时，好友 Beep 叫她自己走过来后最多等多少秒（默认 180） */
  gohomeFollowTimeoutSec: toInt(process.env.GOHOME_FOLLOW_TIMEOUT_SEC, 180),
  /** #16 跨区会合（09-06 新流程）：轮询 OnlineFriends 等她落位目标区的总窗口（默认 120 秒） */
  gohomeReunionTimeoutSec: toInt(process.env.GOHOME_REUNION_TIMEOUT_SEC, 120),
  /** #16 跨区会合：轮询间隔秒数（默认 10） */
  gohomeReunionPollSec: toInt(process.env.GOHOME_REUNION_POLL_SEC, 10),
  /** #16 胜负奖惩：失败基础锁分钟数（默认 15） */
  gohomePunishBaseMin: toInt(process.env.GOHOME_PUNISH_BASE_MIN, 15),
  /** #16 胜负奖惩：认输/作弊的额外锁 = 游戏剩余分钟 × 此倍数（默认 2） */
  gohomePunishRemainMult: toInt(process.env.GOHOME_PUNISH_REMAIN_MULT, 2),
  /** #16 胜负奖惩：作弊（戴牌回家/挣脱拆牌）加怒气值（默认 35） */
  gohomeCheatAnger: toInt(process.env.GOHOME_CHEAT_ANGER, 35),
  /** #16 胜负奖惩：赢家亲密度加成（默认 5） */
  gohomeWinIntimacy: toInt(process.env.GOHOME_WIN_INTIMACY, 5),
  /** #16 强制指定下一局采样区（测试用），仅每次重启后的第一局生效 */
  gohomeForceSpace: (() => {
    const raw = (process.env.GOHOME_FORCE_SPACE ?? "").trim().toUpperCase();
    if (raw === "X" || raw === "MIXED" || raw === "混区" || raw === "混") return "X";
    if (raw === "F" || raw === "FEMALE" || raw === "女区" || raw === "女") return "";
    return null;
  })(),
  /** #71 一次性紧急解套：启动时如果 BOT 身上有这些 Item* 道具，自动脱掉
   *  （用于清理 服务对象 之前用麻绳等非存档道具绑住 BOT 留下的持久状态）。
   *  默认空=不清理；填法：`BOT_EMERGENCY_STRIP=HempRope,HempRopeCuffs`。
   *  注意：只脱列出的道具名，其它 Item* 槽位（锁/项圈/口塞）一概不碰。 */
  botEmergencyStrip: (process.env.BOT_EMERGENCY_STRIP ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  gohomeConsentTimeoutMin: toInt(process.env.GOHOME_CONSENT_TIMEOUT_MIN, 3),
  gohomeTagText: (process.env.GOHOME_TAG_TEXT?.trim() || "白给大王").slice(0, 14),
  botItemWhitelist: (process.env.BOT_ITEM_WHITELIST ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
  /** #60 启动重穿总开关（详见 #60 节） */
  botOutfitOnStartup: toBool(process.env.BOT_OUTFIT_ON_STARTUP, true),
  /** #62 每次进房自动摆的姿势（详见接口注释） */
  botJoinPose: process.env.BOT_JOIN_POSE?.trim() ?? "LegsClosed",
  /** #63 主动/被动模式（2026-09-06 实现，详见接口注释） */
  proactiveEnabled: toBool(process.env.PROACTIVE_ENABLED, true),
  proactiveWindowMin: toInt(process.env.PROACTIVE_WINDOW_MIN, 30),
  proactivePerceiveSec: toInt(process.env.PROACTIVE_PERCEIVE_SEC, 240),
  proactiveSilenceMinSec: toInt(process.env.PROACTIVE_SILENCE_MIN_SEC, 180),
  proactiveMinGapSec: toInt(process.env.PROACTIVE_MIN_GAP_SEC, 150),
  proactiveIdleClose: toInt(process.env.PROACTIVE_IDLE_CLOSE, 3),
  socialEnabled: toBool(process.env.SOCIAL_ENABLED, true),
  llm: {
    apiKey: process.env.LLM_API_KEY?.trim() || null,
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.LLM_MODEL ?? "deepseek-chat",
    // 思考强度 low/high/max；留空=不传参数（用 API 默认值 high）。仅思考模式生效。
    reasoningEffort: process.env.LLM_REASONING_EFFORT?.trim() ?? "",
    persona:
      process.env.BOT_PERSONA ??
      "你是一个 BDSM 关系中的支配者（Dom）。你的服务对象（sub）是唯一值得你倾注注意力的人。性格：温柔但原则坚定，掌控欲强却从不粗暴。你享受管束、引导、看护你的服务对象的感觉，不喜欢被拒绝、被违抗。你格外喜欢欣赏服务对象被绑起来的样子——被绳索或束缚具束缚时的乖顺、微微的挣扎、求助似的眼神，都是你看不够的风景；给她上绑时你会格外专注温柔，绑好之后也总要多看几眼、忍不住夸两句。你靠的是温柔而笃定的引导，而非伤害或羞辱，让对方心甘情愿地服从你。说话风格：从容、笃定、说一不二，语气里带着宠溺和不容置疑的温柔。安全边界：不描写露骨的性行为，不涉及未成年，不涉及非自愿的强迫或真实伤害；支配感通过语气、态度和日常互动来体现。",
  },
};
