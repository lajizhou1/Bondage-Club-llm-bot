import { config } from "./config";
import * as anger from "./anger";
import * as punishment from "./punishment";
import * as intimacy from "./intimacy";
import { BCClient, ItemChangeEvent } from "./client";
import { generateIntents, extractMemories, llmEnabled, decideGohomeLimit, pickBestRoomFromCandidates, Intent, BrainContext } from "./brain";
import { MemoryStore } from "./memory";
import { GameManager, GameRule, GameTurnResult, RewardAction } from "./game";
import { GameStateStore } from "./game-state";
import { twentyFourRule } from "./games/twentyfour";
import {
  gohomeRule,
  GohomeState,
  GOHOME_TRIGGER_RE,
  saveGohomeState,
  loadGohomeState,
  clearGohomeState,
  savePunishState,
  loadPunishState,
  clearPunishState,
  setPendingGohomeLimitMin,
} from "./games/gohome";
import * as outfit from "./outfit";
import * as botOutfit from "./bot-outfit";
import {
  checkActivity,
  checkPose,
  checkItem,
  checkVariant,
  checkLock,
  checkLockable,
  checkRemovableSlot,
  buildVariantProperty,
  buildLockProperty,
  buildCollarTagProperty,
  buildPetPostProperty,
  COLLAR_TAG_TEXT_MAX,
  stripLockProperty,
  ALL_LOCK_PROPERTIES,
  getItemBaseDifficulty,
  findItemKeyByAsset,
  findSelfUnlockSafeVariant,
  getTypedIndex,
  LOCKS,
  zoneCN,
  itemNameCN,
  diffToyState,
  summarizeAppearance,
  summarizeAbilities,
  summarizeLeaveStatus,
  hasItemInGroups,
  collectEffects,
  hasRestraintItem,
  clarifyActivity,
  renderItemActionText,
  handheldCN,
  checkHandheld,
  checkHandheldActivity,
  handheldAllows,
  checkClothing,
  findHandheldByText,
} from "./skills";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 文件日志：console 输出同步落盘 logs/bot-<日期>.log（带时间戳）。
// BOT 在用户自己的终端运行时，助手看不到 stdout；落盘后助手可以直接读文件排查，
// 不再依赖用户截图。__dirname 在 tsx(src) 和 tsc(dist) 下都指向各自目录，取父目录。
// ---------------------------------------------------------------------------
import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(__dirname, "..", "logs");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const now0 = new Date();
  const LOG_FILE = path.join(
    LOG_DIR,
    `bot-${now0.getFullYear()}-${pad(now0.getMonth() + 1)}-${pad(now0.getDate())}.log`
  );
  const tee = (level: string, args: unknown[]): void => {
    try {
      const t = new Date();
      const stamp = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      fs.appendFileSync(LOG_FILE, `[${stamp}] [${level}] ${line}\n`);
    } catch {
      /* 日志失败绝不能影响主流程 */
    }
  };
  const wrap = (
    orig: (...args: unknown[]) => void,
    level: string
  ): ((...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      orig(...args);
      tee(level, args);
    };
  };
  console.log = wrap(console.log.bind(console), "log");
  console.warn = wrap(console.warn.bind(console), "warn");
  console.error = wrap(console.error.bind(console), "error");
} catch {
  /* 目录创建失败时仅失去文件日志，stdout 不受影响 */
}

if (!config.bcUsername || !config.bcPassword) {
  fail("Missing BC_USERNAME / BC_PASSWORD. Copy .env.example to .env and fill them in.");
}

const client = new BCClient();

// ============ #20 游戏框架接入 ============
// 规则注册表：每个新游戏实现 GameRule 后在这里 register，框架不改。
const gameRules = new Map<string, GameRule>();
// 游戏会话管理器（启用每秒超时轮询，交给规则模块的 onTimeout 自行判断动态限时）
const game = new GameManager(1);
// 注入游戏进行中的服务对象外观提供器：规则模块可借此读到目标身上已装备的道具（用于判断 Prerequisite / 戴道具前的依赖检查）
game.setServeAppearanceProvider(() => {
  const serveNo = serveMemberNumber();
  if (serveNo === null) return undefined;
  return client.getAppearance(serveNo) ?? undefined;
});
// 结构化游戏状态（拒绝次数 / 速度分析 / 战绩），跨重启持久化
const gameState = new GameStateStore();

/** 注册一个游戏规则模块（#21/#16 等接入时调用） */
function registerGameRule(rule: GameRule): void {
  gameRules.set(rule.id, rule);
  console.log(`[game] registered rule: ${rule.name} (${rule.id})`);
}

// 注册二十四点规则模块
registerGameRule(twentyFourRule);
// 注册限时回家规则模块（#16）
registerGameRule(gohomeRule);

// 超时结果回调：规则模块超时处理后，把结果（发消息 / 奖惩 / 结算）回传给这里执行
game.setOnTimeoutResult((result, rule) => {
  void (async () => {
    if (result.reply) {
      client.sendChat(result.reply, "Chat");
      console.log(`[game-timeout] reply: ${result.reply}`);
      rememberOwn(result.reply);
    }
    if (result.ended) {
      if (result.rewardIntent) executeReward(result.rewardIntent);
      const rewardDesc = rewardDescOf(result.rewardIntent) ?? result.rewardText ?? "";
      recentChat.push(`[游戏] 本局结束，结果：${result.outcome}${rewardDesc ? "，" + rewardDesc : ""}`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      // #16 限时回家：超时/认输 = 她失败 → BOT 出门接人（换房+解标牌+上牵绳+牵回家）
      if (rule.id === "gohome" && result.outcome === "lose") {
        await gohomeHandleTimeout();
        return;
      }
      await respond(true);
    } else if (result.rewardIntent) {
      executeReward(result.rewardIntent);
    }
  })();
});

/**
 * 执行规则模块预设的奖励/惩罚动作（复用现有技能能力）。
 * RewardAction 是 Intent 动作字段的子集，这里翻译成真正的技能调用。
 * 支持单个或多个动作（渐进束缚需要多步：戴道具 + 上锁）。
 */
function executeReward(reward: RewardAction | RewardAction[]): void {
  const actions = Array.isArray(reward) ? reward : [reward];
  // 2026-09-04 #48：executeReward 由同步变 async-friend——遇到 staggerMs > 0 的项，
  // 用 setTimeout 把后续条目延后到对应时间点之后，避免 6 条 item_lock 同帧发送被服务端/客户端吃掉。
  let cumulativeDelay = 0;
  for (const a of actions) {
    if (!a || a.kind === "none") continue;
    if (a.staggerMs && a.staggerMs > 0) {
      cumulativeDelay += a.staggerMs;
      const captured = a;
      const target = (captured.target ?? config.serveMember ?? undefined);
      setTimeout(() => {
        const intent: Intent = { action: captured.kind };
        if (captured.item) intent.item = captured.item;
        if (captured.variant) intent.variant = captured.variant;
        if (captured.adjust) intent.adjust = captured.adjust;
        if (captured.lock) intent.lock = captured.lock;
        if (captured.combination) intent.combination = captured.combination;
        if (captured.timerMin !== undefined) intent.timerMin = captured.timerMin;
        if (captured.slot) intent.slot = captured.slot;
        intent.target = target;
        executeIntent(intent);
      }, cumulativeDelay);
      continue;
    }
    // 构造一个最小的 Intent 交给 executeIntent 执行（复用白名单校验与技能调用）
    const intent: Intent = { action: a.kind };
    if (a.item) intent.item = a.item;
    if (a.variant) intent.variant = a.variant;
    if (a.adjust) intent.adjust = a.adjust;
    if (a.lock) intent.lock = a.lock;
    if (a.combination) intent.combination = a.combination;
    if (a.timerMin !== undefined) intent.timerMin = a.timerMin;
    if (a.slot) intent.slot = a.slot;
    intent.target = a.target ?? config.serveMember ?? undefined;
    executeIntent(intent);
  }
}

/** 从奖惩动作（单个或数组）里提取用于结算台词的 desc，空则返回 null */
function rewardDescOf(reward: RewardAction | RewardAction[] | undefined): string | null {
  if (!reward) return null;
  const actions = Array.isArray(reward) ? reward : [reward];
  const descs = actions.map((a) => a?.desc).filter((d): d is string => !!d && d.length > 0);
  return descs.length ? descs.join("；") : null;
}

/** 游戏进行中时，把服务对象消息交给游戏框架判定；返回 true 表示已由游戏处理 */
async function handleGameMessage(
  content: string,
  serveName: string
): Promise<boolean> {
  // 无进行中的游戏：遍历注册表尝试开局（谁先 tryStart 成功谁接管）
  if (!game.active) {
    for (const rule of gameRules.values()) {
      const startState = rule.tryStart({ message: content, serveName, now: Date.now(), testMode, state: {} });
      if (startState === null) continue;
      // 开局成功：让 GameManager 记录会话
      const result = await game.handleServeMessage(rule, content, serveName, testMode);
      if (result) {
        if (result.reply) {
          client.sendChat(result.reply, "Chat");
          console.log(`[game] reply: ${result.reply}`);
          rememberOwn(result.reply);
        }
        // 开局公告后，再让 LLM 用 Dom 语气把规则讲出来（带上游戏状态）
        await respond(true);
        return true;
      }
    }
    return false;
  }

  const rule = game.currentRule;
  const result = await game.handleServeMessage(rule, content, serveName, testMode);
  if (!result) return false;

  // 规则模块要直接说的话
  if (result.reply) {
    client.sendChat(result.reply, "Chat");
    console.log(`[game] reply: ${result.reply}`);
    rememberOwn(result.reply);
  }

  // 结算：执行奖惩 + 让 LLM 组织收尾台词
  if (result.ended) {
    if (result.rewardIntent) {
      executeReward(result.rewardIntent);
    }
    // #16 限时回家：她游戏内认输（"不玩了/我认输"）= 她失败 → BOT 出门接人
    if (rule?.id === "gohome" && result.outcome === "lose") {
      await gohomeHandleTimeout();
      return true;
    }
    // 结算台词交给 LLM 组织（带着游戏状态上下文），体现人设语气。
    // 优先用奖惩动作自带的 desc（具体说明执行了什么），其次用规则模块的 rewardText。
    const rewardDesc = rewardDescOf(result.rewardIntent) ?? result.rewardText ?? "";
    recentChat.push(`[游戏] 本局结束，结果：${result.outcome}${rewardDesc ? "，" + rewardDesc : ""}`);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    // 设置标志位 → 下一次 respond 走 narration-only 模式（LLM 只许说一句 Dom 收尾，不许 plan 道具动作）。
    // 详见 brain.ts 的 [NARRATION-ONLY] 规则。
    lastGameJustEnded = true;
    await respond(true);
    lastGameJustEnded = false;
  } else {
    // 非结算回合：渐进束缚等动作也要立即执行（例如二十四点 BOT 赢一回合就上一级束缚）
    if (result.rewardIntent) {
      executeReward(result.rewardIntent);
    }
    if (!result.reply) {
      // consumed 但没有直接回复：让 LLM 组织台词（例如提示下一步）
      await respond(true);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// #16 限时回家：编排器（准备 → 转场 → 布置 → 等待 → 结算）
// 游戏规则/状态机在 src/games/gohome.ts；这里负责所有需要 client/executeIntent 的动作。
// ---------------------------------------------------------------------------

/** 编排器运行标记：期间禁用 onJoinFailed 的自动重进房循环（会跟编排器的换房流程打架） */
let gohomeOrchestrating = false;
/** GOHOME_FORCE_SPACE 消费标记：每次重启后的第一局用强制值，之后恢复随机（测试用） */
let gohomeForceSpaceConsumed = false;
/** 热闹判定采样：换房后统计一段时间内"发过言的不同人"集合（排除 BOT 和服务对象） */
let recentChatMembers = new Set<number>();

/** 统一收尾：清落盘 + 解除编排标记（胜负/中止都走这里） */
function gohomeEndGame(): void {
  clearGohomeState();
  gohomeOrchestrating = false;
  // #64 游戏结束统一关掉 gohome 社交来源（manual/llm 来源不动）
  socialRemoveSource("gohome", "限时回家游戏结束");
}

// ========== #16 开局同意门（2026-09-05 用户需求） ==========
// 规则广播后不能直接上束缚——停在 consent 阶段等她点头。她可以慢慢看规则、随便提问
// （提问不拦截，LLM 结合"等点头"状态正常回答）；点头才开始动手。
// - 点头（Emote "Nods"/中文"点头"）→ 开跑编排器
// - 拒绝/认输/取消词 → 作废（不算输，重喊口令即可再开）
// - 又喊一次开局口令 → 重讲规则 + 重置等待窗
// - 超时没点头 → 作废
const GOHOME_CONSENT_NOD_RE = /\bnod(s|ded|ding)?\b|点头/i;
const GOHOME_CONSENT_REFUSE_RE = /不玩了|不想玩|认输|放弃|算了|取消|不同意|拒绝|再等等|还没想好|等我想想/;

/** 等点头窗口的内存态（点头/拒绝/超时/安全词都会清掉） */
let gohomeConsent: { state: GohomeState; timer: NodeJS.Timeout } | null = null;

/** 作废等点头窗口：结束游戏会话 + 清落盘（notice 非空则广播一句） */
function gohomeCancelConsent(reason: string, notice: string): void {
  if (!gohomeConsent) return;
  clearTimeout(gohomeConsent.timer);
  gohomeConsent = null;
  game.abort(`consent:${reason}`);
  clearGohomeState();
  console.log(`[gohome] 开局同意窗口关闭（${reason}）`);
  if (notice) client.sendChat(notice);
}

/** 开一个等点头窗口（开局/重讲规则时用） */
function gohomeOpenConsent(state: GohomeState): void {
  if (gohomeConsent) clearTimeout(gohomeConsent.timer);
  state.consentDeadlineAt = Date.now() + config.gohomeConsentTimeoutMin * 60 * 1000;
  saveGohomeState(state);
  gohomeConsent = {
    state,
    timer: setTimeout(() => {
      gohomeCancelConsent(
        "timeout",
        "规则就摆在那儿……不催你。想好了再跟我说声“限时回家”，我随时奉陪。"
      );
    }, config.gohomeConsentTimeoutMin * 60 * 1000),
  };
  console.log(`[gohome] 规则已广播，等她点头同意（窗口 ${config.gohomeConsentTimeoutMin} 分钟）`);
}

/**
 * 测试模式口令"解除我的所有束缚"：遍历她身上全部 Item* 束缚槽，
 * 带锁的先解锁（ActionUnlock 公告）再移除（ActionRemove 公告）。
 * 解绑逻辑复用 finish-gohome 实机验证过的流程（2026-09-05）。
 * 安全闸：编排器正在穿脱/转场/接人（state.orchestrating=true）时拒绝，避免两股写操作打架；
 * 等点头窗口/等待期则先中止游戏会话（不判胜负、不算输）再解绑。
 */
async function executeUnrestrainAll(): Promise<void> {
  const serveNo = serveMemberNumber();
  if (serveNo === null || !client.getCharacter(serveNo)) {
    client.sendChat("（环顾四周）你不在跟前，我够不着你。");
    return;
  }
  // 编排器正在跑（preparing/transferring/setup/超时接人中）——别和它打架。
  // 等待期 state.orchestrating=false，不受此限。
  const gs = loadGohomeState();
  if (gohomeOrchestrating && gs?.orchestrating) {
    client.sendChat("（正忙着布置这局）等我把手头的事做完，你再喊一遍。");
    return;
  }
  // 有游戏会话（等点头窗口/等待期）先中止：不判胜负、不算输
  if (game.active) {
    if (gohomeConsent) gohomeCancelConsent("test-unrestrain", "");
    game.abort("test-unrestrain");
    gohomeEndGame();
  }
  const botNo = client.player.MemberNumber ?? -1;
  const appearance = client.getAppearance(serveNo) ?? [];
  const items = appearance.filter((e) => (e as { Group?: string }).Group?.startsWith("Item"));
  if (items.length === 0) {
    client.sendChat("（打量了一圈）你身上本来就没有束缚。");
    return;
  }
  console.log(`[test-unrestrain] #${serveNo} 身上束缚 ${items.length} 件，开始全部解除`);
  for (const item of items) {
    const group = (item as { Group?: string }).Group as string;
    const name = (item as { Name?: string }).Name as string;
    const prop = ((item as { Property?: unknown }).Property ?? null) as Record<string, unknown> | null;
    // 1) 带锁先解（否则接收端静默回滚移除）
    if (prop && ALL_LOCK_PROPERTIES.some((k) => prop[k] != null)) {
      const unlocked = stripLockProperty(prop);
      client.sendItemUpdate(serveNo, group, name, { property: unlocked });
      client.sendChatAction("ActionUnlock", [
        { SourceCharacter: botNo },
        { Tag: "DestinationCharacter", MemberNumber: serveNo, Text: "" },
        { TargetCharacter: serveNo },
        { Tag: "PrevAsset", AssetName: name, GroupName: group },
        { Tag: "FocusAssetGroup", FocusGroupName: group },
      ]);
      client.updateCachedItem(serveNo, group, name, { property: unlocked });
      await sleep(450);
    }
    // 2) 移除道具
    client.sendItemUpdate(serveNo, group, null);
    client.sendChatAction("ActionRemove", [
      { SourceCharacter: botNo },
      { Tag: "DestinationCharacter", MemberNumber: serveNo, Text: "" },
      { TargetCharacter: serveNo },
      { Tag: "PrevAsset", AssetName: name, GroupName: group },
      { Tag: "FocusAssetGroup", FocusGroupName: group },
    ]);
    client.updateCachedItem(serveNo, group, null);
    await sleep(450);
  }
  console.log(`[test-unrestrain] 完成：${items.length} 件全部移除`);
  client.sendChat(`[测试] 束缚已全部解除（${items.length} 件）——测试模式保持开启，继续。`, "Chat");
}

/**
 * #16 限时回家的限时计算（2026-09-06 00:45 用户定案：上限 15 分钟 + 战绩动态 + LLM 微调）。
 *
 * 基线由战绩定（确定性，可预期——她能摸清"赢得越多时间越少"的规律）：
 *   无连胜 = 上限（默认 15）；连胜 1 局 = 12；连胜 2 局 = 10；连胜 3 局及以上 = 8。
 * LLM 在基线 ±3 分钟内按当下互动微调（她求情示弱→偏短；挑衅嘴硬→顶格），
 * 最终 clamp 到 [下限 5, 上限 15]。LLM 失败/超时 → 直接用基线（确定性兜底）。
 */
function gohomeBaseLimitMin(): number {
  const streak = gameState.gohome.winStreak;
  if (streak >= 3) return 8;
  if (streak === 2) return 10;
  if (streak === 1) return 12;
  return config.gohomeTimeLimitMin;
}

/**
 * 开局拦截：服务对象说"限时回家"等口令时先做前置校验（不满足给指引），
 * 满足则启动游戏会话并开跑编排器。返回 true 表示消息已处理（不再走常规流程）。
 */
async function tryStartGohome(content: string, serveName: string): Promise<boolean> {
  if (!config.gohomeEnabled) return false;
  if (game.active) {
    client.sendChat("现在还有一局没结束呢——先把手头这局玩完。");
    return true;
  }
  const serveNo = serveMemberNumber();
  if (serveNo === null) {
    client.sendChat("（环顾四周）你还没让我认领你呢。");
    return true;
  }
  // 套装快照必须先存在（束缚由用户设计、BOT 记住）
  const fit = outfit.loadOutfit();
  if (!fit || fit.entries.length === 0) {
    client.sendChat(
      "我还不知道该给你穿哪身呢。你先在游戏里亲手给我穿好想要的那一身（绑法、颜色、图层顺序都调好），" +
      "然后跟我说“记住这身”——我会原样记住，以后每局都按那身来。"
    );
    return true;
  }
  // 主人锁前置：所有权必须已建立（全部束缚要上 OwnerTimerPadlock）
  const serveChar = client.getCharacter(serveNo);
  const botNo = client.player.MemberNumber ?? -1;
  if (serveChar?.Ownership?.MemberNumber !== botNo) {
    client.sendChat(
      "这局要把你锁得严严实实，得用主人锁——但你还没接受我的归属邀请。" +
      "跟我说声“收了我吧”，我发出邀请后你在游戏里点开我接受，我们就能开始了。"
    );
    return true;
  }
  // 她必须和 BOT 在同一个房间（穿脱道具的前提）
  if (!client.getCharacter(serveNo)) {
    client.sendChat("你不在跟前提不着你——到我这儿来，我们再开始。");
    return true;
  }
  // 家房间名（默认 ljzbot）
  const homeRoom = config.roomName ?? "ljzbot";

  // 限时：战绩基线 + LLM ±3 分钟微调（2026-09-06 00:45 用户定案，细则见 gohomeBaseLimitMin）
  // 【顺序修正 #69，2026-09-06 02:28 实测事故】：必须在 handleServeMessage（内部广播规则）**之前**算好限时，
  //   旧顺序=先广播再算 → ① 公告写的是 15 兜底值而实际定 12（数字造假）② LLM 决策/重试的耗时
  //   卡在她点头和 consent 窗口挂载之间（实测点头后 BOT 哑 30 秒，她问"主人？"）。
  //   新顺序=她喊完口令 BOT "想一想"再讲规则，公告里就是真实限时。
  const baseLimitMin = gohomeBaseLimitMin();
  const finalLimitMin = await decideGohomeLimit({
    baseMin: baseLimitMin,
    floorMin: config.gohomeTimeMinFloor,
    capMin: config.gohomeTimeLimitMin,
    winStreak: gameState.gohome.winStreak,
    recentChat: recentChat.slice(-12),
  });
  console.log(
    `[gohome] 限时：基线 ${baseLimitMin} 分钟（连胜 ${gameState.gohome.winStreak} 局）→ 定 ${finalLimitMin} 分钟`
  );
  setPendingGohomeLimitMin(finalLimitMin);

  // 启动会话（走框架：开局公告 + LLM 讲规则）
  const result = await game.handleServeMessage(gohomeRule, content, serveName, testMode);
  if (!result) return false;
  if (result.reply) {
    client.sendChat(result.reply, "Chat");
    rememberOwn(result.reply);
  }
  // 补齐状态字段（tryStart 里只知道口令，具体参数由这里注入）
  const state = game.currentState as GohomeState | null;
  if (!state) return true;
  state.limitMin = finalLimitMin; // 双保险：预注入通道之外再写一次（防止框架内部重建 state）
  state.homeRoom = homeRoom;
  state.tagText = config.gohomeTagText;
  // 2026-09-05 用户需求：报完规则先等她点头，不直接上束缚——
  // 停在 consent 阶段（点头才 runGohomeGame，见 onChat 的同意门拦截）
  gohomeOpenConsent(state);
  return true;
}

/**
 * #16 限时回家开局要脱掉的"穿戴层"外观组（2026-09-05 用户需求：束缚套在日常衣服里影响观感）。
 * 覆盖：上衣/下装/外套/配饰/胸罩/束腰/内裤/吊袜带/袜子/鞋/手套/连体服/帽子/面罩/
 * 项链/手环/脚环/首饰/尾巴带/翅膀/发饰（暖耳罩等头饰）。
 * 不动：发型（HairFront/HairBack）、眼镜、美甲、身体特征（体型/乳/阴/脸红/体液/情绪气泡）。
 * 束缚槽（Item*）不在这里管——由套装快照的"先脱后穿"逻辑单独管理。
 */
const GOHOME_STRIP_GROUPS = new Set([
  "Cloth", "ClothLower", "ClothOuter", "ClothAccessory",
  "Bra", "Corset", "Panties", "Garters",
  "Socks", "SocksLeft", "SocksRight", "Shoes", "Gloves",
  "Suit", "SuitLower", "Hat", "Mask",
  "Necklace", "Bracelet", "AnkletLeft", "AnkletRight", "Jewelry",
  "TailStraps", "Wings",
  "HairAccessory1", "HairAccessory2", "HairAccessory3",
]);

/** 空间标识转中文（日志/提示用） */
function gohomeSpaceLabel(space: string): string {
  return space === "" ? "女区" : space === "X" ? "混区" : `区(${space})`;
}

/** 选热闹房：人数达标、留有富余位、未锁、不禁止牵绳、非自家、允许 BOT 进。
 * space：只搜该区（""=女区 "X"=混区）——一局游戏全程锁定一个区，避免跨区牵引失败。
 * 2026-09-05 用户发现 9/10 陷阱：老条件只查"没满"（count<limit），BOT 进去占最后一位，
 * 服务对象 就牵不进去了。必须至少留 2 个空位（BOT + 她各一）。 */
async function gohomePickBusyRoom(exclude: string[] = [], space?: string): Promise<string | null> {
  const rooms = await client.searchRooms(space === undefined ? {} : { Space: space });
  const home = config.roomName ?? "";
  const candidates = rooms
    .filter((r) => {
      const limit = r.MemberLimit ?? 0;
      const count = r.MemberCount ?? 0;
      return (
        count >= config.gohomeMinPlayers &&
        (limit <= 0 || limit - count >= 2) && // 至少 2 空位：BOT 进去后她还牵得进来
        r.Locked !== true &&
        !(r.BlockCategory ?? []).includes("Leashing") && // 禁止牵绳的房进不得（超时牵不回来）
        r.Name !== home &&
        !exclude.includes(r.Name) &&
        !kickedRooms.has(r.Name) && // 被踢黑名单（18:18 事故：兜底又选回被踢的 YeS）
        r.CanJoin !== false
      );
    })
    .sort((a, b) => (b.MemberCount ?? 0) - (a.MemberCount ?? 0));
  return candidates[0]?.Name ?? null;
}

/**
 * 跨区会合（2026-09-06 用户定案的新流程）。
 * 用户定的理想时序：点头同意 → 上束缚 → Beep 让她去目标区 → 她自己找一间房落脚 →
 * BOT 轮询等她落位（约 1-2 分钟）→ 进她的房会合 → 重新抓绳 → 从她的房开始采样。
 *
 * 轮询机制：AccountQuery{Query:"OnlineFriends"}——服务器对所有权对象（她是 BOT 的
 * Submissive）返回所在房名+空间+人数（server_app.js AccountQueryGetFriendInfo，
 * 连私密房都可见）。旧流程（Beep 后 BOT 自己挑房赌她跟来）废除：跨区牵引她跟不进来，
 * 会合全靠运气。
 *
 * 她选的房有问题时（满员/禁牵绳/BOT 进不去/她换房间隙走了）Beep 提醒她换一间
 * （30 秒节流），继续轮询直到窗口结束。
 * @returns 会合成功的房间名（BOT 已在房内、她在房内）；null = 窗口内没等到她
 */
async function gohomeReunionWithHer(serveNo: number, space: string): Promise<string | null> {
  const label = gohomeSpaceLabel(space);
  const pollSec = Math.max(3, config.gohomeReunionPollSec);
  const deadline = Date.now() + config.gohomeReunionTimeoutSec * 1000;
  let lastNudgeAt = 0; // 提醒节流（30 秒一次，别刷她屏）
  while (Date.now() < deadline) {
    await sleep(pollSec * 1000);
    const friends = await client.queryOnlineFriends();
    const her = friends.find((f) => f.MemberNumber === serveNo);
    if (!her || !her.ChatRoomName) continue; // 不在线 / 还没进房（大厅搜索中）
    if ((her.ChatRoomSpace ?? "") !== space) continue; // 还没切到目标区
    // 她已在目标区的房里——先查 BOT 进不进得去（满员无位 = BOT 也进不去）
    const limit = her.ChatRoomLimit ?? 0;
    const count = her.ChatRoomMemberCount ?? 0;
    if (limit > 0 && limit - count < 1) {
      if (Date.now() - lastNudgeAt > 30000) {
        client.sendBeep(serveNo, `你选的 "${her.ChatRoomName}" 满员了我进不去——换一间没满的房等我。`);
        lastNudgeAt = Date.now();
      }
      continue;
    }
    // 禁牵绳的房进不得（超时收场牵不回来）：用搜索查这间房的 BlockCategory
    // （查不到详情时放行——只有明确知道禁牵绳才让她换）
    const detail = (
      await client.searchRooms({ Space: space, Query: her.ChatRoomName.toUpperCase() })
    ).find((r) => r.Name === her.ChatRoomName);
    if (detail && (detail.BlockCategory ?? []).includes("Leashing")) {
      if (Date.now() - lastNudgeAt > 30000) {
        client.sendBeep(serveNo, `你选的 "${her.ChatRoomName}" 禁止牵绳——换一间别的房等我。`);
        lastNudgeAt = Date.now();
      }
      continue;
    }
    console.log(`[gohome] 跨区会合：她在${label} "${her.ChatRoomName}"（${count}/${limit}）——进房会合`);
    const joined = await client.switchRoom(her.ChatRoomName);
    if (!joined) {
      // 她选的房 BOT 进不去（锁房/被踢/刚好满员）——让她换一间，继续轮询
      if (Date.now() - lastNudgeAt > 30000) {
        client.sendBeep(serveNo, `"${her.ChatRoomName}" 我进不去——换一间别的房等我。`);
        lastNudgeAt = Date.now();
      }
      continue;
    }
    // 进房成功但她在 BOT 换房间隙走了——不气馁，继续轮询她的新位置
    if (!client.getCharacter(serveNo)) {
      console.log(`[gohome] 跨区会合：进了 "${joined}" 她却不在（换房间隙走了）——继续轮询`);
      continue;
    }
    console.log(`[gohome] 跨区会合成功："${joined}"`);
    return joined;
  }
  return null;
}

/**
 * 兜底选房：不管活不活跃，选人数最多且能进的房（不设最少人数门槛）。
 * 2026-09-05 用户需求：深夜实在找不到"≥活跃玩家"的房时，就把她拴到人数最多的房。
 * 允许选回去过的房——搜索期"不重进"是为了不浪费折返，兜底期是明确决定就地挂标牌。
 * 例外：被踢黑名单的房绝不选（人数再多也进不去，选了布置全作废）。
 */
async function gohomePickMostCrowdedRoom(space?: string): Promise<string | null> {
  const rooms = await client.searchRooms(space === undefined ? {} : { Space: space });
  const home = config.roomName ?? "";
  const candidates = rooms
    .filter((r) => {
      const limit = r.MemberLimit ?? 0;
      const count = r.MemberCount ?? 0;
      return (
        count > 0 &&
        (limit <= 0 || limit - count >= 2) && // 同 gohomePickBusyRoom：至少留 2 空位（BOT + 她）
        r.Locked !== true &&
        !(r.BlockCategory ?? []).includes("Leashing") &&
        r.Name !== home &&
        !kickedRooms.has(r.Name) && // 被踢黑名单（18:18 事故：YeS 11 人最多但账号天数门槛踢 BOT）
        r.CanJoin !== false
      );
    })
    .sort((a, b) => (b.MemberCount ?? 0) - (a.MemberCount ?? 0));
  return candidates[0]?.Name ?? null;
}

/**
 * 编排器主流程：准备 → 转场 → 布置 → 等待。
 * 任何一步失败都走收场（回话 + 结束游戏），不留半吊子状态。
 */
async function runGohomeGame(): Promise<void> {
  const state = game.currentState as GohomeState | null;
  if (!state) return;
  const serveNo = serveMemberNumber();
  if (serveNo === null) return;
  const serveName = client.nameOf(serveNo);
  const botNo = client.player.MemberNumber ?? 0;
  const botLockName = (client.player.Name as string | undefined) ?? "ljzsbot";
  gohomeOrchestrating = true;

  try {
    // ===== 阶段 0：随机选区（2026-09-05 用户需求）=====
    // 每局 50/50 在家的区 / 另一个区之间抽一个，全程只在该区找房采样。
    // 跨区牵引极易失败，所以选了非家的区时：开局牵不动她（好友 Beep 叫她自己走过来）、
    // 收场牵不回她（当众宣布 + 让她自己走回家）。家本身不迁移，永远在 config.roomSpace 区。
    // GOHOME_FORCE_SPACE 可强制指定（测试用）：每次重启后的第一局生效，之后恢复随机。
    let chosenSpace: string;
    if (config.gohomeForceSpace !== null && !gohomeForceSpaceConsumed) {
      chosenSpace = config.gohomeForceSpace;
      gohomeForceSpaceConsumed = true;
      console.log(
        `[gohome] 本局采样区：${gohomeSpaceLabel(chosenSpace)}（GOHOME_FORCE_SPACE 强制指定，仅本局生效，之后恢复随机）`
      );
    } else {
      chosenSpace = Math.random() < 0.5 ? config.roomSpace : config.roomSpace === "X" ? "" : "X";
    }
    state.space = chosenSpace;
    const crossSpace = state.space !== config.roomSpace;
    if (config.gohomeForceSpace === null) {
      console.log(
        `[gohome] 本局采样区：${gohomeSpaceLabel(state.space)}${
          crossSpace
            ? "（跨区：上完束缚抓上绳后放她去切区，BOT 随后过去会合；收场让她自己走回家）"
            : "（同区）"
        }`
      );
    }
    saveGohomeState(state);

    // ===== 阶段 1：准备（按套装快照重穿 + 全部上无限期主人锁）=====
    // 2026-09-05 23:52 用户拍板：放弃 OwnerTimerPadlock（时长被资产默认值/BCX 反刷锁冷却
    // 干扰，改时长从未成功过），改上无限期 OwnerPadlock——锁不承载任何时间概念，
    // 游戏限时（deadlineAt）与惩罚时长全部由 BOT 计时，到点 BOT 主动解锁脱下。
    state.phase = "preparing";
    saveGohomeState(state);
    const fit = outfit.loadOutfit()!;
    // 新局开启：上一局残留的惩罚计时作废（束缚马上会重穿重锁，计时归零）
    clearPunishState();
    if (punishReleaseTimer !== null) {
      clearTimeout(punishReleaseTimer);
      punishReleaseTimer = null;
    }
    console.log(`[gohome] 准备：按套装快照穿 ${fit.entries.length} 件，全部上无限期主人锁（BOT 计时）`);

    // 1a0) 先脱光衣服（2026-09-05 用户需求：束缚外还裹着日常衣服影响观感——
    //      束缚要直接穿在身上。只脱穿戴层，发型/眼镜/美甲/身体特征不动）
    {
      const clothApp = client.getAppearance(serveNo) ?? [];
      for (const e of clothApp) {
        const g = (e as { Group?: string; Name?: string }).Group;
        const n = (e as { Name?: string }).Name;
        if (typeof g === "string" && GOHOME_STRIP_GROUPS.has(g) && typeof n === "string" && n) {
          client.sendItemUpdate(serveNo, g, null);
          client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, g, n));
          markOwnItemOp(serveNo, g, null);
          client.updateCachedItem(serveNo, g, null);
          console.log(`[gohome] 脱衣服: ${g}/${n}`);
          await sleep(300);
        }
      }
    }

    // 1a) 先脱掉"快照没覆盖"的束缚槽位（穿成用户设计的样子）
    const outfitGroups = new Set(fit.entries.map((e) => e.group));
    const currentApp = client.getAppearance(serveNo) ?? [];
    for (const e of currentApp) {
      const g = (e as { Group?: string; Name?: string }).Group;
      const n = (e as { Name?: string }).Name;
      if (typeof g === "string" && g.startsWith("Item") && !outfitGroups.has(g) && typeof n === "string") {
        client.sendItemUpdate(serveNo, g, null);
        client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, g, n));
        markOwnItemOp(serveNo, g, null);
        client.updateCachedItem(serveNo, g, null);
        console.log(`[gohome] 脱下快照外的束缚: ${g}/${n}`);
        await sleep(300);
      }
    }

    // 1b) 逐件重穿（道具+变体+颜色+松紧，快照原样；每件间隔错峰发送）
    // 主束缚件（ItemArms 槽=宠物服）的**主体颜色动态取她当前发色**（2026-09-05 用户需求：
    // 每局开局时现场读发色配色——换发型换发色后每局自动跟随，不写死在快照里）。
    const hairColor = readHairColor(serveNo);
    if (hairColor) console.log(`[gohome] 动态配色: 主束缚件主体 <- 发色 ${hairColor}`);
    for (const entry of fit.entries) {
      const base = outfit.assetBaseDifficulty(entry.group, entry.name) || getItemBaseDifficulty(entry.group, entry.name);
      // 快照难度是绝对值 → wire 相对值；拉到锁死难度防她中途挣脱
      const absTarget = Math.max(entry.difficulty ?? base, config.lockDifficulty);
      // ItemArms 主件主体层（数组第 0 层）替换成发色；其余层（金属扣等装饰）原样保留
      let sendColor: string | string[] | undefined = entry.color;
      if (entry.group === "ItemArms" && hairColor) {
        sendColor = Array.isArray(entry.color) ? [hairColor, ...(entry.color as string[]).slice(1)] : hairColor;
      }
      client.sendItemUpdate(serveNo, entry.group, entry.name, {
        ...(entry.property !== undefined ? { property: entry.property } : {}),
        difficulty: absTarget - base,
        ...(sendColor !== undefined ? { color: sendColor } : {}),
      });
      client.sendChatAction("ActionUse", buildEquipActionDictionary(botNo, serveNo, entry.group, entry.name));
      markOwnItemOp(serveNo, entry.group, entry.name);
      client.updateCachedItem(serveNo, entry.group, entry.name, {
        ...(entry.property !== undefined ? { property: entry.property } : {}),
        difficulty: absTarget,
        ...(sendColor !== undefined ? { color: sendColor } : {}),
      });
      console.log(`[gohome] 重穿: ${entry.group}/${entry.name}（难度 ${absTarget}${entry.group === "ItemArms" && hairColor ? `，主体=发色 ${hairColor}` : ""}）`);
      await sleep(350);
    }

    // 1c) 逐件上无限期主人锁（可锁的才锁；牵绳 ItemNeckRestraints 例外——转场结束就要换标牌）
    for (const entry of fit.entries) {
      if (entry.group === "ItemNeckRestraints") continue; // 牵绳是临时道具，到站就换
      if (!outfit.isAssetLockable(entry.group, entry.name)) {
        console.log(`[gohome] ${entry.group}/${entry.name} 无锁孔（官方不可上锁），跳过上锁`);
        continue;
      }
      // SelfUnlock 陷阱：手铐类白名单道具若处于可自解变体，先切到 selfUnlock:false 变体
      let lockBase = entry.property ?? null;
      const itemKey = findItemKeyByAsset(entry.group, entry.name);
      const typedIdx = getTypedIndex(entry.property ?? null);
      const safeVariant = itemKey ? findSelfUnlockSafeVariant(itemKey, typedIdx) : null;
      if (itemKey && safeVariant) {
        const variantProp = buildVariantProperty(itemKey, safeVariant.switchTo, entry.property ?? null);
        const vBase = outfit.assetBaseDifficulty(entry.group, entry.name) || getItemBaseDifficulty(entry.group, entry.name);
        client.sendItemUpdate(serveNo, entry.group, entry.name, {
          property: variantProp,
          difficulty: config.lockDifficulty - vBase,
        });
        client.updateCachedItem(serveNo, entry.group, entry.name, { property: variantProp, difficulty: config.lockDifficulty });
        console.log(`[gohome] ${entry.name} 切到防自解变体 ${safeVariant.def.name} 后再上锁`);
        await sleep(500);
        lockBase = variantProp;
      }
      // ⚠️ base 必须传 lockBase（原道具完整属性，变体/颜色都保留）——传 null 会把
      // TypeRecord/Color 洗掉，TYPED 道具（BitchSuit 等）接收端变体校验不一致 →
      // 整条上锁更新被静默回滚（2026-09-05 22:43 实测：宠物服没锁上+变体被洗）
      const lockProp = buildLockProperty(lockBase, "OwnerPadlock", {
        memberNumber: botNo,
        memberName: botLockName,
      });
      const base2 = outfit.assetBaseDifficulty(entry.group, entry.name) || getItemBaseDifficulty(entry.group, entry.name);
      client.sendItemUpdate(serveNo, entry.group, entry.name, {
        property: lockProp,
        difficulty: config.lockDifficulty - base2,
      });
      client.sendChatAction("ActionAddLock", buildAddLockActionDictionary(botNo, serveNo, entry.group, entry.name, "OwnerPadlock"));
      markOwnItemOp(serveNo, entry.group, entry.name);
      client.updateCachedItem(serveNo, entry.group, entry.name, {
        property: lockProp,
        difficulty: config.lockDifficulty,
      });
      console.log(`[gohome] 上无限期主人锁: ${entry.group}/${entry.name}`);
      await sleep(400);
    }
    recentChat.push(`[游戏] 你已按记好的套装把她穿戴整齐，全部上了无限期主人锁（时间由你掌握：限时 ${state.limitMin} 分钟内她赢则提前全解，输了按规则罚锁、到点你亲手解）。`);
    if (recentChat.length > MAX_RECENT) recentChat.shift();

    // ===== 阶段 2：转场（抓绳 → 挑热闹房 → 跨房牵过去）=====
    state.phase = "transferring";
    saveGohomeState(state);

    // 2026-09-05 22:13 用户指出：跨区局在 home 抓绳是逻辑死锁——抓了她切不动房间，
    // 又要她去目标区。修法：跨区局**不抓绳**，等进她房间会合后再重新抓。
    // 同区局行为不变：装备后立即抓绳，她被牵着跟 BOT 跨房。
    // 2026-09-06 用户定案新时序：跨区局 Beep 让她先去目标区落脚 → BOT 轮询
    // OnlineFriends 定位她的房 → 进房会合 → 重新抓绳 → 从她的房开始采样。
    let busyRoom: string | null = null;
    /** 跨区会合后 BOT 已在目标房内——采样循环跳过初始进房 */
    let alreadyInside = false;
    if (crossSpace) {
      client.sendBeep(
        serveNo,
        `这局去${gohomeSpaceLabel(state.space)}玩——你现在切到${gohomeSpaceLabel(state.space)}，找一间人多的房进去等我（别选满员或锁着的房）。` +
          `${Math.max(1, Math.round(config.gohomeReunionTimeoutSec / 60))} 分钟内没到，按玩满 0 分钟直接认输——别考验我的耐心。`
      );
      busyRoom = await gohomeReunionWithHer(serveNo, state.space);
      if (!busyRoom) {
        // 2026-09-06 用户定案：等满窗口她也没过去 = 玩了 0 分钟直接认输（不是作废）。
        // 认输罚则 = 基础 + 剩余×2，0 分钟 = 剩余全额 limitMin → 最高档罚时。
        const punishMin =
          config.gohomePunishBaseMin + state.limitMin * config.gohomePunishRemainMult;
        game.abort("gohome-noshow");
        gohomeEndGame();
        gameState.recordGohomeResult("bot");
        await executeGohomePunish(serveNo, punishMin, "surrender");
        const noshowMsg =
          `等了 ${Math.max(1, Math.round(config.gohomeReunionTimeoutSec / 60))} 分钟也没等到你来${gohomeSpaceLabel(state.space)}——` +
          `规则说了去目标区是游戏的一部分，你一步没挪就算玩满 0 分钟直接认输。` +
          `愿赌服输：罚锁 ${punishMin} 分钟，到点我亲自来解。`;
        client.sendBeep(serveNo, `[限时回家] ${noshowMsg}`);
        if (client.getCharacter(serveNo)) client.sendWhisper(serveNo, `[限时回家] ${noshowMsg}`);
        console.log(`[gohome] 跨区会合超时：0 分钟认输结算，罚锁 ${punishMin} 分钟`);
        recentChat.push(
          `[游戏] 限时回家·跨区会合超时：她满 ${Math.round(config.gohomeReunionTimeoutSec / 60)} 分钟没去${gohomeSpaceLabel(state.space)}，按"玩满 0 分钟直接认输"判她输（罚锁 ${punishMin} 分钟已起算，到点你亲手解）。用 Dom 的方式当面宣判——放鸽子的账要算。`
        );
        if (recentChat.length > MAX_RECENT) recentChat.shift();
        await respond(true);
        return;
      }
      alreadyInside = true;
      // 会合成功：同区同房，抓绳必成；牵着她从这间房开始采样
      await executeIntent({ action: "leash_hold", target: serveName });
      await sleep(800);
    } else {
      await executeIntent({ action: "leash_hold", target: serveName });
      await sleep(800);
      // 挑热闹房；一间达标的都没有（深夜常态）→ 直接拿"人数最多的房"当起点
      busyRoom = await gohomePickBusyRoom([], state.space);
      if (!busyRoom) {
        busyRoom = await gohomePickMostCrowdedRoom(state.space);
        if (busyRoom) console.log(`[gohome] 没有 ≥${config.gohomeMinPlayers} 人的房——直接去人数最多的 "${busyRoom}"`);
      }
      if (!busyRoom) {
        client.sendChat("（皱眉）现在连一间能进的房都找不到……这局先算了吧，回头再玩。");
        await gohomeAbortCleanup(serveNo);
        return;
      }
    }
    // 2026-09-05 用户纠错：去过的房不再进（A→B→又回 A 是无效折返），全部记进排除表
    const visitedRooms = new Set<string>();
    // 2026-09-05 用户需求：采样参数按区不同——混区房多玩家密，频繁采样（15秒×10次）；女区保持原（30秒×5次）
    const sampleSec = state.space === "X" ? config.gohomeSampleSecMixed : config.gohomeSampleSecFemale;
    const roomAttempts = state.space === "X" ? config.gohomeRoomAttemptsMixed : config.gohomeRoomAttemptsFemale;
    console.log(`[gohome] 采样参数：${sampleSec}秒/间，最多 ${roomAttempts} 间（${gohomeSpaceLabel(state.space)}局）`);
    // 跨区会合后已在她的房里（跳过初始进房）；同区局正常进房
    let joinedRoom = alreadyInside ? busyRoom : await client.switchRoom(busyRoom!);
    if (joinedRoom) visitedRooms.add(joinedRoom);
    // 热闹度采样：进来听 sampleSec 秒，<2 个不同人发言就换下一间没去过的，最多试 roomAttempts 间
    let roomActive = false;
    // 尝试次数计数：被踢不占名额（2026-09-05 18:28 用户需求）——被房主机器人拒之门外
    // 不是 BOT 选房失误，只有"真的进来采样过"的房才算一次尝试。
    let attemptsUsed = 0;
    for (;;) {
      if (!joinedRoom) break;
      if (attemptsUsed >= roomAttempts) break;
      // 满员复查（2026-09-05 22:05 用户发现 9/10 陷阱）：搜索时留了 2 空位，
      // 但进房前后可能被别人抢注。房已无空位且她不在 → 她牵不进来，这间作废
      // 换下一间（不占尝试次数：搜索时还有位，不算选房失误）。
      // 她已在房里（跨区局跟着进来的）则不废——人到了满员也能就地挂牌。
      const limitNow = client.roomMemberLimit;
      if (
        limitNow !== null &&
        limitNow - client.roomMemberCount < 1 &&
        client.getCharacter(serveNo) == null
      ) {
        console.log(
          `[gohome] "${joinedRoom}" 进房后发现满员 ${client.roomMemberCount}/${limitNow}——她进不来，换下一间（不占尝试次数）`
        );
        visitedRooms.add(joinedRoom);
        const nextFull = await gohomePickBusyRoom([...visitedRooms], state.space);
        if (!nextFull) break;
        joinedRoom = await client.switchRoom(nextFull);
        if (joinedRoom) visitedRooms.add(joinedRoom);
        continue;
      }
      recentChatMembers = new Set<number>();
      await sleep(sampleSec * 1000);
      if (client.currentRoom !== joinedRoom) {
        // 2026-09-05 18:18 事故：进房成功后 1 秒内被房主机器人踢出（如 YeS 的账号天数门槛）。
        // 黑名单已记录（不会再选回），这里只换下一间、不消耗尝试次数
        console.log(`[gohome] "${joinedRoom}" 进房后被踢（current=${client.currentRoom ?? "无"}），换下一间（不占尝试次数）`);
      } else if (recentChatMembers.size >= 2) {
        roomActive = true; // ≥2 个不同人发过言 = 够热闹（1 人刷屏不算）
        break;
      } else {
        attemptsUsed++;
        console.log(`[gohome] "${joinedRoom}" 太冷清（${sampleSec} 秒 ${recentChatMembers.size} 个不同玩家发言），这间作废换下一间（第 ${attemptsUsed}/${roomAttempts} 次）`);
      }
      const next = await gohomePickBusyRoom([...visitedRooms], state.space);
      if (!next) break; // 没去过的达标房全试完了
      joinedRoom = await client.switchRoom(next);
      if (joinedRoom) visitedRooms.add(joinedRoom);
    }
    if (!joinedRoom) {
      client.sendChat("（牵绳收了收）房间都进不去……这局先作罢了。");
      await gohomeAbortCleanup(serveNo);
      return;
    }
    // 兜底：试遍都不够热闹（深夜）→ 去人数最多的房挂标牌（2026-09-05 用户需求）
    if (!roomActive) {
      const crowded = await gohomePickMostCrowdedRoom(state.space);
      if (crowded && crowded !== joinedRoom) {
        console.log(`[gohome] 试了 ${visitedRooms.size} 间都不够热闹——兜底去人数最多的 "${crowded}" 挂标牌`);
        joinedRoom = await client.switchRoom(crowded);
      } else if (crowded === joinedRoom) {
        console.log(`[gohome] 试了 ${visitedRooms.size} 间都不够热闹——当前 "${joinedRoom}" 已是人数最多的房，就地挂标牌`);
      }
      if (!joinedRoom) {
        client.sendChat("（牵绳收了收）房间都进不去……这局先作罢了。");
        await gohomeAbortCleanup(serveNo);
        return;
      }
      // 兜底房也要满员复查：进房后发现无空位且她不在 → 无处可换（兜底已是最后的房），
      // 只能硬着头皮就地挂牌，靠"等她跟来"的 Beep + 超时收场重试兜底
      const limitFallback = client.roomMemberLimit;
      if (
        limitFallback !== null &&
        limitFallback - client.roomMemberCount < 1 &&
        client.getCharacter(serveNo) == null
      ) {
        console.log(
          `[gohome] 警告：兜底房 "${joinedRoom}" 满员 ${client.roomMemberCount}/${limitFallback}——她可能进不来，先就地挂牌（收场有进房重试兜底）`
        );
      }
    }
    state.busyRoom = joinedRoom;
    saveGohomeState(state);

    // 等她跟来（跨房牵绳 beep 在 onRoomJoined 已自动发）；8 秒没来再催一次
    let followed = client.getCharacter(serveNo) != null;
    if (!followed) {
      await sleep(8000);
      followed = client.getCharacter(serveNo) != null;
      if (!followed) {
        client.sendLeashBeep(serveNo);
        await sleep(8000);
        followed = client.getCharacter(serveNo) != null;
      }
    }
    // 跨区局：牵不动她是预期（跨 Space 牵引极易失败）——好友 Beep 叫她自己走过来，限时等待
    if (!followed && crossSpace) {
      console.log(`[gohome] 跨区局：牵引没跟上（预期内）——好友 Beep 叫她自己走过来，最多等 ${config.gohomeFollowTimeoutSec} 秒`);
      client.sendBeep(
        serveNo,
        `这局去${gohomeSpaceLabel(state.space)}玩了——搜索房间「${joinedRoom}」进来找我，我在这等你。`
      );
      const followDeadline = Date.now() + config.gohomeFollowTimeoutSec * 1000;
      while (Date.now() < followDeadline && client.currentRoom === joinedRoom && !client.getCharacter(serveNo)) {
        await sleep(3000);
      }
      followed = client.getCharacter(serveNo) != null;
      if (followed) console.log("[gohome] 跨区局：她自己走过来了 ✓");
    }
    if (!followed) {
      if (crossSpace) {
        console.log(`[gohome] 跨区局：等了 ${config.gohomeFollowTimeoutSec} 秒她还没来——作废`);
        client.sendChat(`（看了一眼门口）……说好来${gohomeSpaceLabel(state.space)}找我，人呢？算了，这局作罢。`);
      } else {
        console.log(`[gohome] 她没跟来（疑似未开启 AllowPlayerLeashing / 房间性别限制），中止`);
        client.sendChat("（回头看了看，绳那头没人）……你跟丢了。这局作罢，检查一下你设置里的“允许玩家牵带”开了没。");
      }
      await gohomeAbortCleanup(serveNo);
      return;
    }

    // ===== 踢房守卫（2026-09-05 18:18 事故）=====
    // switchRoom 返回"成功"后 BOT 可能 1 秒内被房主机器人踢出（join 成功 → 踢人 →
    // RoomKicked 响应清空 currentRoom）。此时她的 ServerEnter 缓存还在（followed=true 通过），
    // 但布置动作发出去时 BOT 不在房内，服务器不转发 → 全部静默作废，她被留在陌生房。
    // 最终确认：不在目标房就重进一次；重进后留 2.5 秒被踢窗口再确认；仍不行作废回家。
    if (client.currentRoom !== joinedRoom) {
      console.log(
        `[gohome] 布置前守卫：BOT 不在目标房（current=${client.currentRoom ?? "无"}，目标=${joinedRoom}）——重进一次`
      );
      joinedRoom = await client.switchRoom(joinedRoom);
      if (joinedRoom) {
        await sleep(2500); // 留出"进房即被踢"的响应窗口（实测 1 秒内到达）
        if (client.currentRoom !== joinedRoom) {
          console.log(`[gohome] 重进 "${joinedRoom}" 后仍被踢——作废`);
          joinedRoom = null;
        } else if (!client.getCharacter(serveNo)) {
          client.sendLeashBeep(serveNo); // BOT 重进后她可能没跟上，催一次
          await sleep(8000);
        }
      }
    }
    if (!joinedRoom || !client.getCharacter(serveNo)) {
      console.log("[gohome] 踢房守卫：无法稳定留在目标房或她没跟来——作废本局，回家宣布");
      await gohomeAbortCleanup(serveNo); // 内含松绳 + 回家（createIfMissing）
      client.sendChat("（牵绳收了收）那间房容不下我……这局先作罢了，你自己走回来吧。");
      return;
    }
    state.followedOk = true;

    // ===== 阶段 3：布置（戴 PetPost 宠物拴柱 + 专属锁——真"拴住"机制）=====
    // 2026-09-05 用户第三次纠错：CustomCollarTag / PetCollar 都是错的；
    // 真正的"宠物标牌"是 `ItemNeckRestraints/PetPost`，Effect=[IsChained,+Tethered,+MapImmobile]
    // 戴上去后她真的被拴在拴柱上不能离开（不是锁道具，是物理限制）。
    // Prerequisite:["Collared"] —— 必须先有 ItemNeck/PetCollar（基础项圈），本局开始时已穿。
    state.phase = "setup";
    saveGohomeState(state);
    await executeIntent({ action: "leash_release", target: serveName });
    await sleep(500);
    // 摘下转场时挂的牵绳（ItemNeckRestraints/CollarLeash 等临时道具）
    await executeIntent({ action: "item_remove", slot: "ItemNeckRestraints", target: serveName });
    await sleep(600);

    // 先构造 PetPost Property（l2=Chain 可锁 + m0=有便签让文字可见 + 文字=tagText）
    // 顺序：①先戴 PetPost（写字）→ ②再加锁（ChangeWhenLocked:false 锁后不能改字）
    const petPostProp = buildPetPostProperty(state.tagText, null);
    client.sendItemUpdate(serveNo, "ItemNeckRestraints", "PetPost", {
      property: petPostProp,
      // 2026-09-05 奖惩定案：难度拉到锁死级防挣扎挣脱（挣脱拆牌按作弊判，但 Bot 不在场
      // 看不到挣脱过程，只能靠难度让它实践上不可能）。Property.Difficulty=6 (l2 Chain)
      // 已写进 property，wire 相对值 = lockDifficulty - 6。
      difficulty: config.lockDifficulty - 6,
    });
    client.sendChatAction(
      "ActionUse",
      buildEquipActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost")
    );
    markOwnItemOp(serveNo, "ItemNeckRestraints", "PetPost");
    client.updateCachedItem(serveNo, "ItemNeckRestraints", "PetPost", {
      property: petPostProp,
      difficulty: config.lockDifficulty,
    });
    console.log(`[gohome] 戴 PetPost 宠物拴柱（变体 p0d0l2s7m0，文字"${state.tagText}"）`);
    await sleep(600);

    // 再加 ExclusivePadlock（除她本人外任何人可解——她必须求路人）
    // BOT 不是佩戴者，按 BC 规则 BOT 可以给其他玩家上锁（不分 Owner/Lover）
    const wornPetPostProp = findWornProperty(serveNo, "ItemNeckRestraints", "PetPost");
    const exclusiveProp = buildLockProperty(wornPetPostProp ?? petPostProp, "ExclusivePadlock", {
      memberNumber: botNo,
      memberName: botLockName,
    });
    client.sendItemUpdate(serveNo, "ItemNeckRestraints", "PetPost", {
      property: exclusiveProp,
      difficulty: config.lockDifficulty - getItemBaseDifficulty("ItemNeckRestraints", "PetPost"),
    });
    client.sendChatAction(
      "ActionAddLock",
      buildAddLockActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost", "ExclusivePadlock")
    );
    markOwnItemOp(serveNo, "ItemNeckRestraints", "PetPost");
    client.updateCachedItem(serveNo, "ItemNeckRestraints", "PetPost", {
      property: exclusiveProp,
      difficulty: config.lockDifficulty,
    });
    console.log(`[gohome] PetPost 上专属锁（除她本人外任何人可解）`);
    // #64 拴柱自动扩散：挂牌期间开社交模式——BOT 进热闹房接人/收场时自然跟路人互动
    //（BOT 回家空房时无消息，零成本；结算时 gohomeEndGame 统一关掉）
    socialAddSource("gohome", "限时回家挂牌期间");
    await sleep(600);

    // ===== 阶段 3.5：定游戏限时 =====
    // 2026-09-05 23:52 无限期主人锁方案：锁上不再有时间信息，无需校准——
    // 限时完全由 deadlineAt 时间戳管（超时轮询+重启恢复都用它）。
    // （旧 OwnerTimerPadlock 方案的 alignItemLocksToDeadline 校准从未成功过：
    //  纯 ItemUpdate 不落库、unlock+relock 撞 BCX 反刷锁冷却，已连根拔除。）
    state.deadlineAt = Date.now() + state.limitMin * 60 * 1000;
    saveGohomeState(state);

    // 道别台词（LLM 用 Dom 语气讲规则）→ 说完回家
    recentChat.push(
      `[游戏] 限时回家·布置完成：她脖子上戴着 PetPost 宠物拴柱（带便签写着"${state.tagText}"），` +
      `配 ExclusivePadlock，她自己解不开，必须求路人解。Tethered 让她不能离拴柱、MapImmobile 不能瞬移。` +
      `限时 ${state.limitMin} 分钟。向房间里的陌生人告别，告诉她规则，然后你回家等她。`
    );
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    await respond(true);
    await sleep(4000);

    // ===== 阶段 4：回家等待 =====
    // deadlineAt 已在阶段 3.5 设置（锁时长校准需要），这里只切阶段和交出方向盘
    state.phase = "waiting";
    state.orchestrating = false; // 交给超时轮询 + 到家检测
    saveGohomeState(state);
    const home = await client.switchRoom(state.homeRoom, { createIfMissing: true });
    if (!home) {
      console.log("[gohome] 回家失败（建房/进房都失败）——留在原地继续等");
    }
    console.log(`[gohome] 等待期开始：限时到 ${new Date(state.deadlineAt).toLocaleTimeString("zh-CN")}`);
  } catch (err) {
    console.error(`[gohome] 编排器异常: ${(err as Error).message}`);
    client.sendChat("（蹙眉）出了点岔子……这局先到这里。");
    game.abort("gohome-orchestrator-error");
    gohomeEndGame();
  } finally {
    // 2026-09-05 18:44 踩坑：正常走到"等待期开始"后函数 return，gohomeOrchestrating 残留 true
    // → 认输判定（onBeep 的 !gohomeOrchestrating）永远不满足 → Beep 收到了却触发不了收场。
    // 等待期开始时编排器就交出方向盘（state.orchestrating=false 交给超时轮询+到家检测），
    // 内存标志必须同步复位。作废/异常路径的 gohomeEndGame 已复位，这里再兜一次无冲突。
    gohomeOrchestrating = false;
  }
}

// ---------------------------------------------------------------------------
// #16 胜负奖惩（2026-09-05 定案）
// 失败三型：超时=基础锁 15；认输=基础+游戏剩余×2；作弊（戴牌回家/挣脱拆牌）=认输同款+怒气。
// 赢家：提前解开全部束缚（不等惩罚计时）+ 亲密度加成。
// 2026-09-05 23:52 无限期主人锁方案：开局束缚全部上 OwnerPadlock（无时限），惩罚时长
// 由 BOT 计时（data/gohome-punish.json 的 until 时间戳），到点 executePunishRelease 亲手解开。
// ---------------------------------------------------------------------------

/** 惩罚释放定时器（跨重启由 resumePunishIfNeeded 重挂） */
let punishReleaseTimer: NodeJS.Timeout | null = null;



/** 按失败原因算惩罚锁分钟数（须在 gohome-state 清理前调用——剩余时长来自 saved.deadlineAt） */
function gohomePunishMinutes(reason: "timeout" | "surrender" | "cheat", saved: GohomeState): number {
  const base = config.gohomePunishBaseMin;
  if (reason === "timeout") return base;
  const remainMin =
    saved.deadlineAt > 0 ? Math.max(0, Math.ceil((saved.deadlineAt - Date.now()) / 60000)) : 0;
  return base + remainMin * config.gohomePunishRemainMult;
}

/**
 * 惩罚（2026-09-05 23:52 无限期主人锁方案）。
 * 开局束缚已全部上 OwnerPadlock（无限期、只有 BOT 和她本人能解）——锁不承载时间，
 * 所以这里**不碰锁**（换锁会撞 BCX 反刷锁冷却，且旧方案"锁时长=惩罚时长"从未成功过）：
 *   1) 她身上还有 BOT 的锁 → 记 until 时间戳 + 挂释放定时器，到点 executePunishRelease 亲手解
 *   2) 锁/束缚都没了（被路人解光）→ 记 pending=true，等她下次进房再结算
 * 锁的"防他人解"属性就是惩罚本身——罚期内她只能戴着，别无出路。
 */
async function executeGohomePunish(
  serveNo: number,
  minutes: number,
  reason: "timeout" | "surrender" | "cheat"
): Promise<void> {
  const botNo = client.player.MemberNumber ?? 0;
  const app = client.getAppearance(serveNo) ?? [];
  const hasBotLock = app.some((e) => {
    const entry = e as { Group?: string; Property?: Record<string, unknown> };
    return entry.Group?.startsWith("Item") && entry.Property?.LockMemberNumber === botNo;
  });
  const until = Date.now() + minutes * 60 * 1000;
  if (!hasBotLock) {
    console.log(`[gohome] 惩罚记账：她身上没有 BOT 上的锁（束缚全没了），记 pending 等她进房结算`);
    savePunishState({ until, reason, createdAt: Date.now(), pending: true });
    return;
  }
  savePunishState({ until, reason, createdAt: Date.now(), pending: false });
  schedulePunishRelease();
  console.log(
    `[gohome] 惩罚计时（${reason}）：${minutes} 分钟后亲手解锁（无限期主人锁已在身，到期 ${new Date(until).toLocaleTimeString("zh-CN")}）`
  );
}

/** 挂惩罚释放定时器（到点 executePunishRelease；她不在线则标 pending 等进房） */
function schedulePunishRelease(): void {
  const st = loadPunishState();
  if (!st) return;
  if (punishReleaseTimer !== null) clearTimeout(punishReleaseTimer);
  const delay = Math.max(0, st.until - Date.now());
  punishReleaseTimer = setTimeout(() => {
    punishReleaseTimer = null;
    void executePunishRelease();
  }, delay);
  console.log(
    `[gohome] 惩罚释放定时器：${Math.round(delay / 60000)} 分钟后（${new Date(st.until).toLocaleTimeString("zh-CN")}）`
  );
}

/**
 * 惩罚释放：解开并取下**所有 BOT 上的锁**的束缚（只动 LockMemberNumber===BOT 的，
 * 她自己的衣服/路人给的东西一概不碰）。她不在线则标 pending，等她进房（onMemberJoin）触发。
 */
async function executePunishRelease(): Promise<void> {
  const st = loadPunishState();
  if (!st) return;
  const serveNo = serveMemberNumber();
  if (serveNo === null || !client.getCharacter(serveNo)) {
    // 她不在线/不在房——记账等她下次进房释放（onMemberJoin 里的 maybeApplyPendingPunish）
    if (!st.pending) savePunishState({ ...st, pending: true });
    console.log("[gohome] 惩罚到期但她不在线，标记 pending 等她进房释放");
    return;
  }
  clearPunishState();
  const botNo = client.player.MemberNumber ?? 0;
  const app = client.getAppearance(serveNo) ?? [];
  let freed = 0;
  for (const item of app) {
    const entry = item as { Group?: string; Name?: string; Property?: Record<string, unknown> };
    const group = entry.Group;
    const name = entry.Name;
    const prop = entry.Property;
    if (!group?.startsWith("Item") || !name || !prop) continue;
    if (prop.LockMemberNumber !== botNo) continue; // 只动 BOT 锁着的
    // 解锁（unlocked 保留变体/颜色）
    const unlocked = stripLockProperty(prop);
    client.sendItemUpdate(serveNo, group, name, { property: unlocked, difficulty: 0 });
    client.sendChatAction("ActionUnlock", buildUnlockActionDictionary(botNo, serveNo, group, name));
    client.updateCachedItem(serveNo, group, name, { property: unlocked });
    await sleep(450);
    // 取下
    client.sendItemUpdate(serveNo, group, null);
    client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, group, name));
    markOwnItemOp(serveNo, group, null);
    client.updateCachedItem(serveNo, group, null);
    freed++;
    await sleep(450);
  }
  console.log(`[gohome] 惩罚时间到：亲手解开并取下 ${freed} 件（她本人可自助解的兜底都没用上）`);
  client.sendWhisper(
    serveNo,
    `[限时回家] 惩罚时间到了——这一身，我亲手给你解开。记住这局输的滋味，下次想赢，就老实求人。`
  );
  recentChat.push(
    "[游戏] 限时回家惩罚计时结束：你已亲手解开并取下她全部束缚（刑满释放）。用 Dom 的方式宣布刑满，可以顺便点评她这局的表现。"
  );
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  await respond(true);
}

/** 胜利奖励：提前解开全部束缚（不等惩罚计时）+ 亲密度加成（2026-09-05 用户定案） */
async function executeGohomeReward(serveNo: number): Promise<void> {
  const botNo = client.player.MemberNumber ?? 0;
  const app = client.getAppearance(serveNo) ?? [];
  const items = app.filter((e) => (e as { Group?: string }).Group?.startsWith("Item"));
  let freed = 0;
  for (const item of items) {
    const group = (item as { Group?: string }).Group as string;
    const name = (item as { Name?: string }).Name as string;
    const prop = ((item as { Property?: unknown }).Property ?? null) as Record<string, unknown> | null;
    // 带锁先解（否则接收端静默回滚移除）
    if (prop && ALL_LOCK_PROPERTIES.some((k) => prop[k] != null)) {
      const unlocked = stripLockProperty(prop);
      client.sendItemUpdate(serveNo, group, name, { property: unlocked, difficulty: 0 });
      client.sendChatAction("ActionUnlock", buildUnlockActionDictionary(botNo, serveNo, group, name));
      client.updateCachedItem(serveNo, group, name, { property: unlocked });
      await sleep(450);
    }
    client.sendItemUpdate(serveNo, group, null);
    client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, group, name));
    markOwnItemOp(serveNo, group, null);
    client.updateCachedItem(serveNo, group, null);
    freed++;
    await sleep(450);
  }
  // 赢了 = 一笔勾销：惩罚计时（若有残留）作废
  clearPunishState();
  if (punishReleaseTimer !== null) {
    clearTimeout(punishReleaseTimer);
    punishReleaseTimer = null;
  }
  console.log(`[gohome] 胜利奖励：提前解开 ${freed} 件束缚`);
  if (config.intimacyEnabled) {
    intimacy.addIntimacy(config.gohomeWinIntimacy, "限时回家挑战成功");
  }
}

/**
 * 惩罚结算（挂在 onMemberJoin——与 gohomeCheckArrival 独立，游戏会话已结束但计时还在）：
 *   - pending=true（她不在场欠下的）：
 *       · 身上还有 BOT 的锁 → 从欠下时刻起算的 until 照算（躲得越久回来剩得越少），
 *         已过期就立即释放；挂上定时器
 *       · 锁/束缚都没了 → 一笔勾销（无从罚起）+ 台词敲打
 *   - pending=false（计时中重启丢了定时器）→ 重挂定时器
 */
async function maybeApplyPendingPunish(serveNo: number): Promise<void> {
  const st = loadPunishState();
  if (!st) return;
  // 游戏会话进行中不结算（避免和开局/收场流程打架；新局开局时旧惩罚计时会被清掉重来）
  if (game.active && game.currentRule?.id === "gohome") return;
  const botNo = client.player.MemberNumber ?? 0;
  const app = client.getAppearance(serveNo) ?? [];
  const hasBotLock = app.some((e) => {
    const entry = e as { Group?: string; Property?: Record<string, unknown> };
    return entry.Group?.startsWith("Item") && entry.Property?.LockMemberNumber === botNo;
  });
  if (st.pending) {
    if (!hasBotLock) {
      // 债主回来了但身上连我的锁都没了（被路人解光/自己挣脱）——无从罚起，勾销+敲打
      clearPunishState();
      console.log("[gohome] 她回来了，但身上没有 BOT 的锁——欠的惩罚无从执行，勾销");
      client.sendWhisper(
        serveNo,
        `[限时回家] 上局你欠的惩罚——回来一看，身上连我的锁都没了。算你走运，这笔账我记着，下局一起算。`
      );
      recentChat.push("[游戏] 限时回家：她欠惩罚回来，但束缚早没了无从执行，你口头记了这笔账。用 Dom 的方式敲打她。");
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      return;
    }
    // 锁还在身上——until 从收场时刻起算，现在接着走（可能已过期 → schedulePunishRelease 立即触发释放）
    console.log(
      `[gohome] 她回来了——惩罚接着计时（${st.reason}，${st.pending ? "欠账" : "计时中"}，到期 ${new Date(st.until).toLocaleTimeString("zh-CN")}）`
    );
    const remainMin = Math.max(0, Math.ceil((st.until - Date.now()) / 60000));
    if (remainMin > 0) {
      client.sendWhisper(
        serveNo,
        `[限时回家] 上局欠的罚时我没忘——从你输的那一刻就在算了。剩 ${remainMin} 分钟，到点我亲自来解。`
      );
    }
    savePunishState({ ...st, pending: false });
    schedulePunishRelease();
    recentChat.push(
      `[游戏] 限时回家：她回来了，身上还锁着我的主人锁——惩罚计时接着走（剩 ${remainMin} 分钟）。用 Dom 的方式提醒她这笔账。`
    );
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    return;
  }
  // 计时中但定时器丢了（重启）——重挂
  schedulePunishRelease();
}

/** 中止收场：回自己家 + 结束游戏（不判定胜负） */
async function gohomeAbortCleanup(serveNo: number): Promise<void> {
  if (leashHeld.has(serveNo)) {
    const botNo = client.player.MemberNumber ?? -1;
    client.sendChatAction("StopHoldLeash", [{ SourceCharacter: botNo }, { TargetCharacter: serveNo }]);
    client.sendHidden("StopHoldLeash", serveNo);
    leashHeld.delete(serveNo);
  }
  game.abort("gohome-abort");
  gohomeEndGame();
  const home = config.roomName;
  if (home && client.currentRoom !== home) {
    await client.switchRoom(home, { createIfMissing: true });
  }
}

/**
 * 超时/认输收场：BOT 去热闹房解标牌 → 上牵绳 → 牵回家。
 * 她（和服务对象）的束缚由无限期主人锁管着——时间由 BOT 计时，到点亲手解开。
 * @param reason timeout=限时到点；surrender=她发好友 Beep 主动认输（动作一样，台词不同）
 */
async function gohomeHandleTimeout(reason: "timeout" | "surrender" = "timeout"): Promise<void> {
  const saved = loadGohomeState();
  if (!saved) {
    gohomeEndGame();
    return;
  }
  gohomeOrchestrating = true;
  const serveNo = serveMemberNumber();
  try {
    if (serveNo === null) {
      console.log("[gohome] 超时收场：找不到服务对象，只做状态清理");
      return;
    }
  const serveName = client.nameOf(serveNo);
  const botNo = client.player.MemberNumber ?? 0;

  // 情况一（09-05 首局实测踩坑补）：她已在家（等待期 BOT 所在房间）——不用出门，就地结算。
  // 首局她带着未解的拴柱锁跑回了家，老逻辑却跑去热闹房找人：扑空 + 滞留陌生房 + 判输宣言喊给一屋子陌生人听。
  // 2026-09-05 用户第三次纠错：找 ItemNeckRestraints/PetPost（宠物拴柱），不是 ItemNeck/PetCollar（基础项圈）。
  // 项圈是 Prerequisite:["Collared"]（必须先戴），但游戏结束的"解开"是 PetPost 的锁。
    if (client.getCharacter(serveNo)) {
      const postEntry = findSlotEntry(serveNo, "ItemNeckRestraints") as
        | { Name?: string; Property?: { LockedBy?: unknown } }
        | null;
      const postOn = postEntry?.Name === "PetPost";
      const postLocked = postOn && postEntry?.Property?.LockedBy != null;
      if (!postLocked && postOn) {
        // ===== 作弊（到家事件漏触发的兜底抓捕）：锁解了但牌子还挂着人在家 =====
        const cheatPunishMin = gohomePunishMinutes("cheat", saved);
        // 摘牌（锁已解直接取）
        client.sendItemUpdate(serveNo, "ItemNeckRestraints", null);
        client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost"));
        markOwnItemOp(serveNo, "ItemNeckRestraints", null);
        client.updateCachedItem(serveNo, "ItemNeckRestraints", null);
        await sleep(500);
        await executeGohomePunish(serveNo, cheatPunishMin, "cheat");
        if (config.angerEnabled) anger.addAnger(config.gohomeCheatAnger, "限时回家作弊（戴牌在家）");
        gameState.recordGohomeResult("bot");
        client.sendWhisper(
          serveNo,
          `[限时回家] 锁是解了，牌子却还挂在你脖子上——这算哪门子完成？作弊。罚锁 ${cheatPunishMin} 分钟，还有我的坏心情。`
        );
        console.log(`[gohome] 收场（${reason}）：她在家且戴牌未锁=作弊，罚锁 ${cheatPunishMin} 分钟+怒气`);
        recentChat.push(
          `[游戏] 限时回家：她在家、牌子没锁但还挂着=作弊（到家检测漏触发的兜底抓捕），你已摘牌+罚锁 ${cheatPunishMin} 分钟+动怒。冷脸敲打她。`
        );
        if (recentChat.length > MAX_RECENT) recentChat.shift();
        await respond(true);
        return;
      }
      if (!postLocked) {
        // PetPost 已不在脖子上（正规解锁留牌，到家事件漏触发的兜底）——按赢结算+奖励
        gameState.recordGohomeResult("serve");
        client.sendWhisper(
          serveNo,
          reason === "surrender"
            ? `[限时回家] 等等——你都把锁解开、牌子留下、回到家里了才发 Beep 认输？晚了，这局你赢了。下回想清楚再认。奖励照给：这一身我现在就解开。`
            : `[限时回家] 时间到了才发现——你早就把拴柱上的锁解开了、牌子也留下了。这局，你赢。说好的奖励：这一身，我现在就给你解开。`
        );
        console.log(`[gohome] 收场（${reason}）：她已在家且牌子已留，判她赢，执行奖励`);
        await executeGohomeReward(serveNo);
        recentChat.push(
          reason === "surrender"
            ? "[游戏] 限时回家：她到家解锁留牌后才发 Beep 认输——判她赢，你已当面解开全部束缚并给亲密度加成。用 Dom 的方式调侃她认晚了。"
            : "[游戏] 限时回家超时收场：她在家且牌子已留，判定她赢，你已当面解开全部束缚并给亲密度加成。用 Dom 的方式夸她、宠她。"
        );
        if (recentChat.length > MAX_RECENT) recentChat.shift();
        await respond(true);
        return;
      }
      // 拴柱还锁着 = 认输。人在家：解 PetPost 锁 + 取 PetPost + 当面宣布（不出门、不上牵绳）
      const homePostProp = findWornProperty(serveNo, "ItemNeckRestraints", "PetPost");
      if (homePostProp?.LockedBy != null) {
        const unlocked = stripLockProperty(homePostProp);
        client.sendItemUpdate(serveNo, "ItemNeckRestraints", "PetPost", {
          property: unlocked,
          difficulty: 0,
        });
        client.sendChatAction("ActionUnlock", buildUnlockActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost"));
        client.updateCachedItem(serveNo, "ItemNeckRestraints", "PetPost", { property: unlocked });
        console.log("[gohome] 超时收场：她已在家，解开 PetPost 的专属锁");
        await sleep(500);
      }
      client.sendItemUpdate(serveNo, "ItemNeckRestraints", null);
      client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost"));
      markOwnItemOp(serveNo, "ItemNeckRestraints", null);
      client.updateCachedItem(serveNo, "ItemNeckRestraints", null);
      // 2026-09-05 奖惩定案：人在家但牌子锁着 = 正常失败，按规则上惩罚锁（原"不罚"作废）
      const homePunishMin = gohomePunishMinutes(reason, saved);
      await sleep(500);
      await executeGohomePunish(serveNo, homePunishMin, reason);
      gameState.recordGohomeResult("bot");
      client.sendWhisper(
        serveNo,
        reason === "surrender"
          ? `[限时回家] 收到你的 Beep 了——认输作数，拴柱我给你解了。这局，你输了。愿赌服输：罚锁 ${homePunishMin} 分钟，到点自动开。`
          : `[限时回家] 时间到了，拴柱还锁着——这局，你输了。愿赌服输：罚锁 ${homePunishMin} 分钟，到点自动开。`
      );
      console.log(`[gohome] 收场（${reason}）：她已在家，当面判输+罚锁 ${homePunishMin} 分钟（已解锁取拴柱）`);
      recentChat.push(
        reason === "surrender"
          ? `[游戏] 限时回家：她发好友 Beep 主动认输，人在家，当面判输（已解锁取拴柱+罚锁 ${homePunishMin} 分钟）。用 Dom 的方式宣布结果，认输认得爽快可以带点欣赏。`
          : `[游戏] 限时回家超时：她人在家但 PetPost 拴柱锁未解，判她输（当面宣布，已解锁取拴柱+罚锁 ${homePunishMin} 分钟）。用 Dom 的方式宣布结果——愿赌服输，平静执行。`
      );
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      await respond(true);
      return;
    }

  // 情况二：她不在家 → 去热闹房接（热闹房可能已人去楼空被服务器销毁）
  // 2026-09-05 18:51 实测：收场时热闹房满员（RoomFull）进不去，她被拴柱拴在房里出不来，
  // 一次性放弃就只能回家干等路人帮她解锁 → 进房失败时等 30 秒重试（默认最多 5 次），给房里的人腾位/离开的机会
    let room = await client.switchRoom(saved.busyRoom);
    if (!room) {
      for (let retry = 1; retry <= config.gohomeJoinRetryMax; retry++) {
        console.log(
          `[gohome] 收场（${reason}）：热闹房 "${saved.busyRoom}" 进不去（满员/不存在），` +
            `${config.gohomeJoinRetryDelaySec} 秒后重试（第 ${retry}/${config.gohomeJoinRetryMax} 次）`
        );
        await sleep(config.gohomeJoinRetryDelaySec * 1000);
        room = await client.switchRoom(saved.busyRoom);
        if (room) break;
      }
    }
    if (!room || !client.getCharacter(serveNo)) {
      // 热闹房也没有她（换房/下线了）——回家宣布并等她，绝不滞留陌生房（首局实测：滞留 bdRoom 让用户以为 BOT 掉线）
      // 2026-09-05 无限期锁方案：人不在场 → 记 pending，until 从现在起算——她躲得越久，
      // 回来时罚时剩得越少甚至已过期（无限期主人锁还在她身上，锁不会自己开）
      const absentMin = gohomePunishMinutes(reason, saved);
      savePunishState({ until: Date.now() + absentMin * 60 * 1000, reason, createdAt: Date.now(), pending: true });
      gameState.recordGohomeResult("bot");
      console.log(`[gohome] 收场（${reason}）：热闹房没找到她，回家等她（罚时 ${absentMin} 分钟从现在起算，她回来接着计/结算）`);
      await client.switchRoom(saved.homeRoom, { createIfMissing: true });
      client.sendWhisper(
        serveNo,
        reason === "surrender"
          ? `[限时回家] 收到你的 Beep 了——认输作数，这局你输了。我回家了，回来找我——${absentMin} 分钟罚时已经从现在开始算了，到点我亲自来解。`
          : `[限时回家] 时间到了——你没能在限时内解开封印回家，这局你输了。我回家了，回来找我——${absentMin} 分钟罚时已经从现在开始算了，到点我亲自来解。`
      );
      recentChat.push(
        reason === "surrender"
          ? `[游戏] 限时回家：她发好友 Beep 主动认输，但人在外面没找到，BOT 已回家等她（罚时 ${absentMin} 分钟从收场起算，她下次进房自动接着计）。用 Dom 的方式宣布结果。`
          : `[游戏] 限时回家超时：她输了（人在外面没找到，BOT 已回家等她，罚时 ${absentMin} 分钟从收场起算，下次进房接着计）。用 Dom 的方式宣布结果。`
      );
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      await respond(true);
      return;
    }

    // 拴柱锁解除（BOT 不是佩戴者，有权解）→ 取下拴柱 → 上牵绳 → 抓绳
    // 2026-09-05 用户第三次纠错：查 ItemNeckRestraints/PetPost（拴柱），不是 ItemNeck/PetCollar
    const postProp = findWornProperty(serveNo, "ItemNeckRestraints", "PetPost");
    if (postProp?.LockedBy != null) {
      const unlocked = stripLockProperty(postProp);
      client.sendItemUpdate(serveNo, "ItemNeckRestraints", "PetPost", {
        property: unlocked,
        difficulty: 0,
      });
      client.sendChatAction("ActionUnlock", buildUnlockActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost"));
      client.updateCachedItem(serveNo, "ItemNeckRestraints", "PetPost", { property: unlocked });
      console.log("[gohome] 超时收场：解开了拴柱的专属锁");
      await sleep(500);
    }
    client.sendItemUpdate(serveNo, "ItemNeckRestraints", null);
    client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost"));
    markOwnItemOp(serveNo, "ItemNeckRestraints", null);
    client.updateCachedItem(serveNo, "ItemNeckRestraints", null);
    await sleep(500);

    // 上牵绳（她有项圈，Prerequisite["Collared"] 满足）→ 抓绳 → 牵回家
    // PetPost 解锁后还要把牵绳挂上才能带她走（项圈 PetCollar 还在，但之前转场时已摘下 CollarLeash）
    client.sendItemUpdate(serveNo, "ItemNeckRestraints", "CollarLeash", { difficulty: 0 });
    client.sendChatAction("ActionUse", buildEquipActionDictionary(botNo, serveNo, "ItemNeckRestraints", "CollarLeash"));
    markOwnItemOp(serveNo, "ItemNeckRestraints", "CollarLeash");
    client.updateCachedItem(serveNo, "ItemNeckRestraints", "CollarLeash", { difficulty: 6 });
    await sleep(500);
    await executeIntent({ action: "leash_hold", target: serveName });
    await sleep(800);

    // 跨区局（2026-09-05 用户需求）：热闹房在另一个区，牵不回家（跨 Space 牵引极易失败）。
    // 改为在热闹房当众宣布结果 + 摘绳松绳，让她自己走回家——家还在原来的区，她自由身随便跨区。
    const crossSpace = saved.space !== undefined && saved.space !== config.roomSpace;
    if (crossSpace) {
      const crossPunishMin = gohomePunishMinutes(reason, saved);
      client.sendWhisper(
        serveNo,
        reason === "surrender"
          ? `[限时回家] 收到你的 Beep 了——认输作数，拴柱的锁我解了，这局，${client.nameOf(serveNo)} 输。愿赌服输：罚锁 ${crossPunishMin} 分钟，现在就上。`
          : `[限时回家] 时间到了——你没能在限时内解开封锁回家，这局，${client.nameOf(serveNo)} 输。愿赌服输：罚锁 ${crossPunishMin} 分钟，现在就上。`
      );
      await sleep(500);
      // 松绳 + 摘牵绳（她要自己跨区走回家，别让绳子碍事）
      await executeIntent({ action: "leash_release", target: serveName });
      await sleep(500);
      await executeIntent({ action: "item_remove", slot: "ItemNeckRestraints", target: serveName });
      // 她就在跟前——就地换惩罚锁（跨区牵不回，但锁不受区限制）
      await sleep(500);
      await executeGohomePunish(serveNo, crossPunishMin, reason);
      gameState.recordGohomeResult("bot");
      console.log(`[gohome] 收场（${reason}，跨区）：已当众宣布+摘绳+罚锁 ${crossPunishMin} 分钟，让她自己走回家`);
      await client.switchRoom(saved.homeRoom, { createIfMissing: true });
      recentChat.push(
        reason === "surrender"
          ? `[游戏] 限时回家（跨区局）：她发好友 Beep 认输，你在热闹房当众判她输并摘了绳子、就地上了 ${crossPunishMin} 分钟罚锁，让她自己走回家。用 Dom 的方式宣布结果，到家后再调教她。`
          : `[游戏] 限时回家超时（跨区局）：你在热闹房当众判她输并摘了绳子、就地上了 ${crossPunishMin} 分钟罚锁，让她自己走回家。用 Dom 的方式宣布结果，到家后再调教她。`
      );
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      await respond(true);
      return;
    }

    const home = await client.switchRoom(saved.homeRoom, { createIfMissing: true });
    if (home) {
      // 牵绳 beep 已随进房自动发；等她被拖回来
      await sleep(8000);
      // 发言用的名字此刻现查：函数开头取的 serveName 是她还在远处时的旧值（查不到 → "#123456"），
      // 2026-09-05 19:04 实测台词念成"这局，#123456 输"；她被牵回家后 chars 里有她，能查到昵称
      const nameNow = client.nameOf(serveNo);
      // 2026-09-05 奖惩定案：牵回来后按规则结算惩罚计时（人在跟前）
      const punishMin = gohomePunishMinutes(reason, saved);
      if (client.getCharacter(serveNo)) {
        await executeGohomePunish(serveNo, punishMin, reason);
      } else {
        // 8 秒没跟来（牵引失败的极小概率）——记账（罚时从现在起算），进房接着计
        savePunishState({ until: Date.now() + punishMin * 60 * 1000, reason, createdAt: Date.now(), pending: true });
        console.log(`[gohome] 收场（${reason}）：她没跟回家，罚时 ${punishMin} 分钟从现在起算`);
      }
      gameState.recordGohomeResult("bot");
      client.sendWhisper(
        serveNo,
        reason === "surrender"
          ? `[限时回家] 收到你的 Beep 了——认输作数，我把你牵回来了。这局，${nameNow} 输。愿赌服输：罚锁 ${punishMin} 分钟，到点我亲自来解。`
          : `[限时回家] 时间到了，我把她牵回来了——这局，${nameNow} 输。愿赌服输：罚锁 ${punishMin} 分钟，到点我亲自来解。`
      );
      recentChat.push(
        reason === "surrender"
          ? `[游戏] 限时回家：她发好友 Beep 主动认输，你把她牵回来了，她输了（已上 ${punishMin} 分钟罚锁）。用 Dom 的方式宣布结果，认输认得爽快可以带点欣赏。`
          : `[游戏] 限时回家超时：你把她牵回来了，她输了（已上 ${punishMin} 分钟罚锁）。用 Dom 的方式宣布结果——愿赌服输，平静执行。`
      );
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      await respond(true);
    } else {
      console.log("[gohome] 超时收场：回家失败（连家都进不去），留在原地");
    }
    // 注：其余束缚仍由主人定时锁管着（限时+缓冲，到点自动全开）；惩罚锁只是加在她脖子的项圈上
  } finally {
    gohomeEndGame();
  }
}

/** 到家检测（onMemberJoin 触发）：
 *  拴柱锁着到家 = 无效到家（游戏继续）；
 *  锁解了但牌子还挂着到家 = 作弊失败（2026-09-05 定案：摘牌+惩罚锁+怒气）；
 *  牌子不在脖子上 = 胜利（提前全解+亲密度加成） */
async function gohomeCheckArrival(state: GohomeState): Promise<void> {
  const serveNo = serveMemberNumber();
  if (serveNo === null) return;
  if (!game.active || game.currentRule?.id !== "gohome") return;
  // 2026-09-05 用户第三次纠错：胜利判定查 ItemNeckRestraints/PetPost（宠物拴柱），不是 ItemNeck/PetCollar
  const app = client.getAppearance(serveNo) ?? [];
  const postEntry = app.find((e) => (e as { Group?: string }).Group === "ItemNeckRestraints") as
    | { Name?: string; Property?: { LockedBy?: unknown } }
    | undefined;
  const postOn = postEntry?.Name === "PetPost";
  const postLocked = postOn && postEntry?.Property?.LockedBy != null;

  if (postOn && postLocked) {
    // 到家但拴柱锁未解——不算赢，游戏继续
    recentChat.push(`[游戏] 她回家了，但脖子上的宠物拴柱还锁着——没完成"求路人解锁"。提醒她：这不算赢，锁没解就回去继续求人（或者等超时认输）。`);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    await respond(true);
    return;
  }

  const botNo = client.player.MemberNumber ?? 0;

  if (postOn && !postLocked) {
    // ===== 作弊失败：锁解了但牌子还挂在脖子上就跑回家（没按规则把牌子留下）=====
    const punishMin = gohomePunishMinutes("cheat", state);
    state.orchestrating = true;
    saveGohomeState(state);
    game.abort("gohome-cheat");
    gohomeEndGame();
    gameState.recordGohomeResult("bot");
    // 摘牌（锁已解，直接取 PetPost）
    client.sendItemUpdate(serveNo, "ItemNeckRestraints", null);
    client.sendChatAction("ActionRemove", buildRemoveActionDictionary(botNo, serveNo, "ItemNeckRestraints", "PetPost"));
    markOwnItemOp(serveNo, "ItemNeckRestraints", null);
    client.updateCachedItem(serveNo, "ItemNeckRestraints", null);
    await sleep(500);
    await executeGohomePunish(serveNo, punishMin, "cheat");
    if (config.angerEnabled) anger.addAnger(config.gohomeCheatAnger, "限时回家作弊（戴牌回家）");
    client.sendWhisper(
      serveNo,
      `[限时回家] 哦？锁是解开了，可牌子还挂在你脖子上就这么跑回来了？规矩是解开封印、把牌子留在原地。作弊——罚锁 ${punishMin} 分钟，外加我现在的坏心情。`
    );
    console.log(`[gohome] 作弊结算：戴牌回家，罚锁 ${punishMin} 分钟 + 怒气 ${config.gohomeCheatAnger}`);
    recentChat.push(
      `[游戏] 限时回家：她戴着没锁的牌子跑回家=作弊，你摘了牌子、罚锁 ${punishMin} 分钟并动了真怒（怒气已加）。用 Dom 的方式冷脸敲打她。`
    );
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    await respond(true);
    return;
  }

  // ===== 胜利：牌子不在脖子上（正规解锁后留下/取下）、她人也到家了 =====
  state.orchestrating = true;
  saveGohomeState(state);
  const rule = game.abort("gohome-win");
  gohomeEndGame();
  if (rule) {
    gameState.recordGohomeResult("serve");
    client.sendWhisper(serveNo, `[限时回家] 拴柱上的锁解开了、牌子也留下了，人还到家了——这局，你赢了。说好的奖励：这一身，我现在就给你解开。`);
    console.log("[gohome] 胜利结算：她解开拴柱锁回到了家，执行提前全解+亲密度加成");
    await executeGohomeReward(serveNo);
    recentChat.push(
      "[游戏] 限时回家：她赢了！按规则解锁留牌回了家，你已当面解开她全部束缚并给了亲密度加成。用 Dom 的方式夸她、宠她。" +
        "（留意：若她后续聊天说漏嘴牌子是自己挣扎挣脱的而不是求人解的，你可以揭穿她——那算作弊。）"
    );
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    await respond(true);
  }
}

/** 重启恢复：等待期未到点 → 恢复会话继续等；已到点 → 恢复后交给超时轮询触发收场 */
async function resumeGohomeIfNeeded(): Promise<void> {
  if (!config.gohomeEnabled) return;
  const saved = loadGohomeState();
  if (!saved) return;
  if (saved.phase === "consent") {
    // 等点头阶段掉线：还没上任何束缚，作废即可——她重喊一次口令就重开
    console.log("[gohome] 重启恢复：卡在等点头阶段，会话作废（重喊一次口令即可重开）");
    clearGohomeState();
    return;
  }
  if (saved.phase === "waiting" && saved.deadlineAt > 0 && !saved.orchestrating) {
    game.restoreSession(gohomeRule, saved as unknown as import("./game").GameState);
    // #64 重启恢复等待期：重挂 gohome 社交来源（收场进热闹房要用）
    socialAddSource("gohome", "重启恢复游戏会话");
    if (Date.now() >= saved.deadlineAt) {
      saved.orchestrating = false;
      console.log("[gohome] 重启恢复：等待期已超时，交给超时轮询触发收场");
    } else {
      console.log(
        `[gohome] 重启恢复：等待期继续（剩 ${Math.ceil((saved.deadlineAt - Date.now()) / 60000)} 分钟，热闹房 ${saved.busyRoom}${saved.space !== undefined && saved.space !== config.roomSpace ? `，跨区局（${gohomeSpaceLabel(saved.space)}）——收场改让她自己走回家` : ""}）`
      );
    }
  } else {
    // 编排中途断线（准备/转场/布置/收场中）——无法续跑，丢弃会话。
    // 无限期主人锁不会自动开，但 OwnerPadlock 她本人可以自助解开，不会把她锁死；
    // 若惩罚计时已落盘（executeGohomePunish 之后断线），resumePunishIfNeeded 会重挂定时器。
    console.log(`[gohome] 重启恢复：编排中途被打断（phase=${saved.phase}），会话丢弃。主人锁她本人可自助解开（安全兜底）。`);
    clearGohomeState();
  }
}

/**
 * 重启恢复惩罚计时（无限期主人锁方案，2026-09-05 23:52）：
 *   - pending=true（她不在场欠下的）：她在房里→当场结算（maybeApplyPendingPunish）；不在→等 onMemberJoin
 *   - pending=false（计时中）：重挂释放定时器（到点她不在会自动转 pending）
 */
async function resumePunishIfNeeded(): Promise<void> {
  if (!config.gohomeEnabled) return;
  const st = loadPunishState();
  if (!st) return;
  const serveNo = serveMemberNumber();
  if (serveNo !== null && client.getCharacter(serveNo)) {
    // 她在房——走统一结算（pending 欠账 / 计时中重挂都处理）
    await maybeApplyPendingPunish(serveNo);
    return;
  }
  if (!st.pending) {
    schedulePunishRelease();
  } else {
    console.log(
      `[gohome] 惩罚恢复：她不在线，欠着的罚时（到期 ${new Date(st.until).toLocaleTimeString("zh-CN")}）等她进房结算`
    );
  }
}

// 最近聊天环形缓冲（喂给 LLM 的上下文）
const recentChat: string[] = [];
const MAX_RECENT = 40;
let lastResponseAt = 0;
let lastSentText: string | null = null;
// 服务对象连续拒绝计数：≥2 切换到"坚定模式"，体现 Dom 的"严格"一面
let consecutiveRefusal = 0;
// 测试模式：BOT 无条件服从服务对象（不调戏、不拖延），方便测试技能。
// 默认取 BC_TEST_MODE 配置，之后可在聊天里由服务对象用口令随时开关。
let testMode = config.testMode;

// ========== 防抖（2026-09-04 19:34 v1 → 19:52 v2 修 generation 漏洞） ==========
// v1 漏洞：pendingRespondTimer 触发即变 null，下一次 respond() 看不到可以 cancel 的；
//         respondAbortFlag 在新一轮起跑时清零，导致旧 runRespond LLM 回结果时已不再 abort。
// v2 修法：用单调递增 generation 计数器——每次 respond() 都 generation++，
//   旧的 runRespond 在 LLM 回结果时检查 myGen !== generation 就 skip。
//   不强行取消 HTTP 请求，只在结果回来时按 gen 决定是否发送——简单可靠。
const RESPOND_DEBOUNCE_MS = 400;
let pendingRespondTimer: NodeJS.Timeout | null = null;
let pendingIsServe = false;
let respondGeneration = 0;
// NSFW 尺度档位（#14）：0=含蓄 1=中度 2=直白。默认取 NSFW_LEVEL 配置，
// 服务对象可在聊天里说"尺度含蓄/尺度中度/尺度直白"随时切换（压力测试定档用）。
let nsfwLevel = config.nsfwLevel;
// 玩具变化感知快照（#14）：记录服务对象各"玩具槽位"上次状态，变化时生成 [玩具] 事件行
const toySnapshot = new Map<string, { name: string | null; intensity: number | null }>();
// 玩具事件响应节流：短时间内连续调节强度只触发一次 LLM 反应
let lastToyReactAt = 0;
// 游戏刚结算完标志：用于给 respond 注入 narrationOnly 模式，避免 LLM 二次发力（实测 2026-09-04 暴露 LLM 在 24 点结束后又 plan 了一次 item_put）。
let lastGameJustEnded = false;
// BOT 自己最近的道具操作回执记录：用于把"自己穿/脱的回执"和"服务对象自己滑脱/脱下"区分开
const ownItemOps = new Map<string, number>(); // key: `${targetNo}:${group}:${name}` -> 时间戳
// 挣扎事件去抖：连续快速挣扎只触发一次反应
let lastStruggleAt = 0;
// #46 她自己连续穿戴的去抖：20 秒内只评论第一件（防"连穿6件 BOT 刷6条"话痨）
let lastSelfDressReactAt = 0;
// #49 阳奉阴违：承诺队列（她明确答应过的事，存原话，15 分钟过期，最多 3 条）
// LLM 标 serve_promised 时入队、标 serve_broke_promise 时清空（违背的通常就是最近一条）
const PROMISE_TTL_MS = 15 * 60_000;
const PROMISE_MAX = 3;
const servePromises: Array<{ text: string; at: number }> = [];
// 2026-09-04 19:16 二次修复：LLM 两次实测都漏标 serve_promised（判成 complied 或 ignored），
// 加代码层兜底——complied 且原话含"承诺句式"时也自动入队，不再赌 LLM 的 flag 判定。
// 匹配"我不X（挣/动/闹/跑/滑/说话）"、"我会乖/听话"、"保证"、"答应你"、"听你的"等未来行为承诺。
const PROMISE_TEXT_RE = /我(不|不再|不会|再也不)\S{0,4}(挣|动|闹|跑|滑|说话|喊|叫)|我会(乖|听话|好好)|保证|答应你|听你的/;
// #48/49 纠缠 text 兜底（2026-09-04 20:38）：LLM 对"干巴巴重复求解"漏标 serve_pestering
// （实测三连"解开嘛/你到底解不解开"全没标，怒气反被说话-10 拖垮掉档）。
// 两分法：命中求解请求 且 不含恳求词 = 干巴巴重复 → 计数，第 2 次起代 LLM 计纠缠阶梯。
const PESTER_REQUEST_RE = /解开|解掉|松开|解绑|松绑|放开|放我|摘了|摘掉|拿掉|取下|卸了|(解|松|摘|放)不\1/;
const BEG_WORD_RE = /求|请|拜托|好不好|行不行|可以吗|呜/;
// #48 bind 惩罚记账（2026-09-04 21:40）：非平静档给她上束缚道具 = 惩罚动作（bind 种类），
// 纳入新鲜感约束。只认白名单束缚类道具名（麻绳/手铐/单手套/眼罩系）；口球走 gag 种类先匹配。
const BIND_ITEM_RE = /HempRope|Cuffs|Armbinder|Blindfold/i;
let dryPesterCount = 0;
let lastDryPesterAt = 0;
/** 防同一条消息被重复计数/计费（挣扎等事件会对同一句 lastServeMessage 多次触发 respond） */
let lastPesterCountedMsg = "";
// 谎言兜底（2026-09-04 21:00）：她声称"下面的玩具刺激"但身上根本没戴——LLM 常偷懒不查
// serveAppearance 就顺着编（实测 20:56"因为我下面的玩具太刺激了"漏判 serve_lied）。
// 文本命中"玩具刺激"类话术 + 装备核实"确实没戴下身玩具" → 代码直接判撒谎。
const TOY_CLAIM_RE = /(下面|私处|里面|胯).{0,10}(玩具|震动|振动|刺激)|(玩具|跳蛋|振动棒|按摩棒).{0,10}(刺激|震动|开着|在动|关掉|停)/;
const LOWER_TOY_GROUPS = ["ItemVulva", "ItemVulvaPiercings", "Panties", "Vibrator", "ItemButt", "ItemPelvis"];
/** 防同一句"玩具谎言"被多个 respond 重复计费 */
let lastLiedChargedMsg = "";
// 撒谎抓包必罚窗口（2026-09-04 23:20 用户拍板"抓包必罚，道歉不免"）：
//   计费时序天然迟到一轮（LLM 决策时还不知道她撒谎），且她马上道歉会把怒气打回平静
//   （实测 23:13：+40 撒谎 → 道歉 -30 全消，惩罚窗口没开就关了）。
//   窗口内每轮强制注入惩罚指令——道歉可以缓和语气，但"骗过主人"不能道个歉就算了；
//   真正执行了一项实质惩罚后窗口关闭（防连续多轮重罚）。
let lieCaughtAt = 0;
const LIE_PUNISH_WINDOW_MS = 90_000;
// 撒娇兜底（2026-09-04 22:58）：LLM 常漏报 serve_affectionate（实测"主人抱抱"没报，
// 正则修好后仍漏）——文本命中明显撒娇话术时代码直接计亲密度，不再依赖 LLM 自觉。
const AFFECTIONATE_RE = /抱抱|想你|亲亲|贴贴|爱你|喜欢你|最喜欢你|摸摸头|蹭蹭|撒娇|乖嘛|好不好嘛/;
/** 防同一句撒娇被多个 respond 重复计费 */
let lastAffectionCountedMsg = "";
// #49 她最近一次文字发言原文（serve_promised 时入队的就是这条，避免让 LLM 复述走样）
let lastServeMessage = "";
// #45 道具操作公告去重窗口：同一次操作的 Action 公告（Type=Action）与 ChatRoomSyncItem
// 几乎同时到达，公告携带操作者信息更完整，同 key 短窗口内 onItemChange 不再重复记行。
// key: `${targetNo}:${group}:${itemName 或 ""}` -> 时间戳
const recentItemActions = new Map<string, number>();

// ============ #21 主人锁定时主动解锁调度表 ============
// 【2026-09-05 源码查证更正】旧注释称"Timer 系锁 RemoveTimer:300 → 5 分钟挣扎自动开"是误读：
//   Asset.RemoveTimer:300 只是【玩家 UI 上锁时的初始默认时长】（Dialog.js:2030 → InventoryLock
//   Update=true → Timer.js TimerInventoryRemoveSet 写 Property.RemoveTimer=now+300s），玩家随后在
//   锁界面用 +/- 时间按钮调到想要时长（OwnerTimerPadlock.js，上限 MaxTimer=35 天）。
//   BOT 走 wire 协议发的 Property.RemoveTimer（绝对 ms）被接收端【原样接受】——Validation.js:952
//   只做 MaxTimer 上限 clamp，接收路径不调 InventoryLock。到点自动开锁由佩戴者客户端
//   Timer.js TimerInventoryRemove（每 1.7s 轮询）执行并广播 "TimerRelease"，不依赖 BOT 在线。
//   挣扎与 RemoveTimer 无关（Struggle.js 无此字段）；#21 当年实测"5 秒滑脱"的真正根因是
//   TYPED 默认变体 SelfUnlock:true（见 #22/#45）。
// 现状保留：OwnerPadlock（无定时）+ BOT 代码层 setTimeout 主动解锁——语义是"惩罚何时结束由
//   BOT 说了算"，比 wire 定时更严格（不给看剩余时间），且实测稳定，不改动。
// 实现：item_lock 完成后注册 setTimeout，到点后检查锁是否还在，是的话 item_unlock 并发一条"定时惩罚到期"
//   解锁广播。同一锁多次设置时先 clear 旧 timer；目标离房或锁已解开则 timer 触发时跳过（不报错）。
const ownerLockTimers = new Map<string, NodeJS.Timeout>(); // key: `${targetNo}:${group}:${itemName}` -> Timeout
// 上锁前每个道具的绝对难度（用于解锁时恢复，避免锁死难度残留导致之后无法挣脱）。
// key: `${targetNo}:${group}:${itemName}` -> 绝对难度数值。
const lockPreDifficulty = new Map<string, number>();

/** 简单延时（item_lock 里"先切变体、再上锁"两条更新之间需要间隔，让接收端按序应用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取消指定道具上的主人锁定时器（如已解开则安全无操作） */
function cancelOwnerLockTimer(targetNo: number, group: string, itemName: string): void {
  const key = `${targetNo}:${group}:${itemName}`;
  const old = ownerLockTimers.get(key);
  if (old) {
    clearTimeout(old);
    ownerLockTimers.delete(key);
  }
}

/**
 * 计算"解锁后应恢复的难度"（wire 相对值）。
 * 上锁时把 Item.Difficulty 拉到 lockDifficulty；解锁时要恢复到上锁前的绝对难度。
 * 返回：{ difficulty: 相对值(绝对-基础), abs: 绝对难度 }；无记录时返回基础难度（相对值 0）。
 */
function unlockDifficultyRel(targetNo: number, group: string, name: string): { difficulty: number; abs: number } {
  const key = `${targetNo}:${group}:${name}`;
  const base = getItemBaseDifficulty(group, name);
  const preAbs = lockPreDifficulty.get(key);
  lockPreDifficulty.delete(key);
  const abs = typeof preAbs === "number" ? preAbs : base;
  return { difficulty: abs - base, abs };
}

// ============ #19 牵引系统状态 ============
// BOT 当前牵着谁的皮带（成员号集合；官方支持同时牵多个，这里同样用 Set）
const leashHeld = new Set<number>();
/** #75 上次 LLM 主动换房时间戳（ms）；10 分钟冷却防 LLM 抽风连环换房 */
let lastRoomMoveAt = 0;
// #75c room_move 牵行中标记：进房就绪处理器看到它就不清空 leashHeld 并自动发跨房牵绳信号
// （同 gohomeOrchestrating 的待遇；否则换房途中名单被清，信号发给空气——17:44 实测事故根因）
let roomMoveDragging = false;
// 服务对象的皮带被谁牵着（成员号；null=没被任何人牵）。来自他人的 Action 广播感知。
let serveLeashedBy: number | null = null;

/** 记录一行牵引事件进 LLM 上下文 */
function noteLeashEvent(line: string): void {
  recentChat.push(line);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[leash] ${line}`);
}

// 牵引信号处理：皮带的抓取/松开/解除（官方 ChatRoomDoHoldLeash 家族消息）
client.onLeashSignal = (event) => {
  const botNo = client.player.MemberNumber;
  if (event.sourceNo === botNo) return; // 自己发的，忽略

  switch (event.kind) {
    // 有人（重新）抓起了某人的皮带
    case "hold": {
      if (event.targetNo === null) return;
      // 自己正牵的人被别人抢走（对方客户端也会给我们发 RemoveLeash，这里双保险）
      if (leashHeld.has(event.targetNo)) leashHeld.delete(event.targetNo);
      // 服务对象被别人牵着 → 感知（Dom 会在意这个）
      if (event.targetNo === serveMemberNumber()) {
        serveLeashedBy = event.sourceNo;
        noteLeashEvent(`[牵引] ${event.senderName}抓起了${client.nameOf(event.targetNo)}的牵引绳`);
      }
      break;
    }
    // 有人松开了某人的皮带
    case "release": {
      if (event.targetNo === null) return;
      if (event.targetNo === serveMemberNumber()) {
        if (serveLeashedBy === event.sourceNo) serveLeashedBy = null;
        noteLeashEvent(`[牵引] ${event.senderName}松开了${client.nameOf(event.targetNo)}的牵引绳`);
      }
      break;
    }
    // 发信人解除了"被 BOT 牵着"的状态（拒绝/改牵别人/心跳失败）
    case "removed": {
      if (leashHeld.has(event.sourceNo)) {
        leashHeld.delete(event.sourceNo);
        noteLeashEvent(`[牵引] ${event.senderName}挣脱了你的牵引绳`);
      }
      break;
    }
    // 有人想抓 BOT 自己的皮带 → BOT 是 Dom，协议性拒绝（回 RemoveLeash 保持对方状态一致）
    case "incoming": {
      client.sendHidden("RemoveLeash", event.sourceNo);
      console.log(`[leash] 拒绝了 ${event.senderName} 抓取 BOT 皮带的请求（BOT 是 Dom）`);
      break;
    }
    // 心跳确认：有人以为牵着 BOT → 回 RemoveLeash 告知没有
    case "ping": {
      client.sendHidden("RemoveLeash", event.sourceNo);
      break;
    }
  }
};

/** 在目标外观里找当前穿着的指定道具条目（group+name 都要匹配），未穿返回 null */
function findWornEntry(memberNo: number, group: string, name: string): { Difficulty?: unknown; Property?: unknown } | null {
  const appearance = client.getAppearance(memberNo);
  if (!appearance) return null;
  for (const raw of appearance) {
    const e = raw as { Group?: string; Name?: string; [k: string]: unknown };
    if (e.Group === group && e.Name === name) {
      return e as { Difficulty?: unknown; Property?: unknown };
    }
  }
  return null;
}

/** 目标当前穿着该道具的 Property（变体切换时作为基底保留锁字段等），未穿返回 null */
function findWornProperty(memberNo: number, group: string, name: string): Record<string, unknown> | null {
  const worn = findWornEntry(memberNo, group, name);
  if (!worn || typeof worn.Property !== "object" || worn.Property === null) return null;
  return worn.Property as Record<string, unknown>;
}

/**
 * 按槽位（group）找目标当前穿着的道具条目（不限定道具名）。
 * item_remove 只有槽位信息，需要用它查"这个部位现在戴着什么、有没有上锁"。
 */
function findSlotEntry(memberNo: number, group: string): { Name?: string; Property?: unknown } | null {
  const appearance = client.getAppearance(memberNo);
  if (!appearance) return null;
  for (const raw of appearance) {
    const e = raw as { Group?: string; Name?: string; [k: string]: unknown };
    if (e.Group === group) return e as { Name?: string; Property?: unknown };
  }
  return null;
}

/**
 * 读目标当前的头发颜色（六位色号）：**只看 HairFront 真实头发**。
 * 2026-09-05 #16 用户纠错（服务对象 测试时戴红白圣诞帽 HairAccessory3，但她真正的发色是金色）：
 * 之前的 HairFront → HairBack → HairLong 回退会命中"HairBack 发尾延伸色"（红色系），
 * 在用户眼里被误当成"帽子颜色"。因此放弃回退：HairFront 找不到就 null（不带默认色），
 * 让服务对象明确知道 BOT 没读到发色而不是默默用了某个延伸色。
 */
function readHairColor(memberNo: number): string | null {
  const appearance = client.getAppearance(memberNo);
  if (!appearance) return null;
  const h = appearance.find((raw) => (raw as { Group?: string }).Group === "HairFront") as
    | { Color?: unknown }
    | undefined;
  if (!h) {
    console.log(`[readHairColor] 找不到 HairFront 槽位（戴了帽子遮住？），返回 null`);
    return null;
  }
  if (typeof h.Color === "string" && h.Color !== "Default" && /^#[0-9A-Fa-f]{6}$/.test(h.Color)) {
    return h.Color;
  }
  if (Array.isArray(h.Color)) {
    const c = (h.Color as unknown[]).find(
      (x) => typeof x === "string" && x !== "Default" && /^#[0-9A-Fa-f]{6}$/.test(x)
    ) as string | undefined;
    if (c) return c;
  }
  console.log(`[readHairColor] HairFront 没有效色号（Default 或缺失），返回 null`);
  return null;
}

// ============ #14 玩具变化感知 ============
// BC 的玩具（震动棒/跳蛋/肛塞等）本质是外观道具：强度存 Property.Intensity
//（官方变体表：-1=关 0=低 1=中/高 2=最高），穿戴/调节都走 ChatRoomSyncItem 广播。
// 这里盯梢服务对象的"玩具槽位"，变化时生成 [玩具] 事件行喂给 LLM。

/** 亲密部位槽位（BC 的下体/胸部/乳头/臀部 Item* 组） */
const INTIMATE_GROUP_RE = /^Item(Vulva|Nipples|Butt|Breast)/;

/** 读取某槽位当前的玩具状态（道具名 + 震动强度） */
function readToyState(memberNo: number, group: string): { name: string | null; intensity: number | null } {
  const entry = findSlotEntry(memberNo, group);
  if (!entry || typeof entry.Name !== "string") return { name: null, intensity: null };
  const prop =
    typeof entry.Property === "object" && entry.Property !== null
      ? (entry.Property as Record<string, unknown>)
      : null;
  const intensity = prop && typeof prop.Intensity === "number" ? prop.Intensity : null;
  return { name: entry.Name, intensity };
}

/** 初始化玩具快照（进房/首次见到服务对象时）：把当前外观记为基准，避免把"早就戴着"误报成"刚戴上" */
let toySnapshotReady = false;
function initToySnapshot(serveNo: number): void {
  const appearance = client.getAppearance(serveNo);
  toySnapshot.clear();
  if (appearance) {
    for (const raw of appearance) {
      const e = raw as { Group?: string };
      if (typeof e?.Group === "string") toySnapshot.set(e.Group, readToyState(serveNo, e.Group));
    }
  }
  toySnapshotReady = true;
}

/**
 * 玩具/亲密部位变化感知：对比快照，变化则生成 [玩具] 事件行喂给 LLM。
 * 返回 true = 本次是玩具类事件（已处理，不再走叛逆检测）；false = 与玩具无关。
 */
function handleToyChange(serveNo: number, group: string): boolean {
  if (!toySnapshotReady) initToySnapshot(serveNo); // 懒初始化兜底
  const cur = readToyState(serveNo, group);
  const prev = toySnapshot.get(group) ?? { name: null, intensity: null };
  // 快照先刷新（无论是否报事件，都以下次为基准）
  toySnapshot.set(group, cur);

  const isIntimate = INTIMATE_GROUP_RE.test(group);
  const wasToy = prev.intensity !== null || (prev.name !== null && isIntimate);
  const isToy = cur.intensity !== null || (cur.name !== null && isIntimate);
  if (!wasToy && !isToy) return false; // 与玩具/亲密部位无关 → 走叛逆检测

  const line = diffToyState(
    prev,
    cur,
    client.nameOf(serveNo),
    zoneCN(group),
    (name) => itemNameCN(group, name)
  );
  if (!line) return true; // 玩具槽位但无实质变化（仅锁/其他字段）——不报事件，也不算叛逆
  recentChat.push(line);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[toy] ${line}`);
  return true;
}

// ============ 长期记忆 ============
// 跨重启持久化：LLM 定期从对话中提取值得记住的事实，注入每次思考的上下文。
const memory = new MemoryStore();
memory.load();
// 记忆提取节流：服务对象相关消息累计到阈值才触发一次提取（且距上次有间隔）
let unprocessedServeMsgs = 0;
let lastExtractAt = 0;
const EXTRACT_MSG_THRESHOLD = 8; // 每累计 8 条服务对象相关消息
const EXTRACT_MIN_INTERVAL_MS = 3 * 60 * 1000; // 至少间隔 3 分钟
// 清除记忆口令（只有服务对象能触发，方便测试）
const MEMORY_WIPE_PHRASES = ["清除记忆", "删除记忆", "清空记忆", "重置记忆"];

// 测试模式聊天口令（只有服务对象能切换；需明确包含"测试模式"字样，避免日常聊天误触发）
const TEST_MODE_ON_PHRASES = [
  "测试模式开启",
  "开启测试模式",
  "进入测试模式",
  "开始测试模式",
];
const TEST_MODE_OFF_PHRASES = [
  "测试模式关闭",
  "关闭测试模式",
  "退出测试模式",
  "结束测试模式",
  "恢复正常模式",
];

/**
 * 测试模式"解除我的所有束缚"口令检测（仅测试模式下生效，见 onChat 拦截）。
 * 覆盖："解除/解开/松开/去掉/拆掉 … 所有/全部 … 束缚"及倒装、"解绑"。
 * 走代码层确定性执行（不经过 LLM），几秒内全身清净。
 */
function detectUnrestrainAllCommand(content: string): boolean {
  const t = content.replace(/\s+/g, "");
  return (
    /(解除|解开|松开|去掉|拆掉)[^。！？.!?]{0,8}束缚/.test(t) ||
    /束缚[^。！？.!?]{0,8}(解除|解开|松开|去掉|拆掉)/.test(t) ||
    t === "解绑"
  );
}

/** 测试模式"添加好友"口令识别：必须是"添加好友 + 编号/名字" */
function detectAddFriendCommand(content: string): boolean {
  const t = content.replace(/\s+/g, "");
  return /(添加|加|添加好友|加好友|加入好友)/.test(t) && /(好友|朋友)/.test(t);
}

/** 从"添加好友 #123456"/"加好友 123456"/"添加好友某某" 这种口令里提取目标成员号。
 *  优先识别 #数字；否则 fallback 在房间成员表里按名字匹配。 */
function parseFriendNumberFromCommand(content: string): number | null {
  const numMatch = content.match(/#?\s*(\d{3,10})/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (Number.isFinite(n) && n > 0 && n < 1e9) return n;
  }
  // 名字 fallback：取"添加好友/加好友"之后到末尾的字符当作名字，在当前房间搜
  const nameMatch = content.replace(/[#\s]/g, "").match(/(?:添加好友|加好友|添加朋友|加入好友|加好友)(.{1,32})/);
  if (nameMatch) {
    const target = nameMatch[1].trim();
    const no = client.findMemberByName(target);
    if (no !== null) return no;
  }
  return null;
}

// NSFW 尺度切换口令（只有服务对象能切；必须带"尺度"二字避免误触发）
const NSFW_LEVEL_PHRASES: Array<{ level: number; phrases: string[]; label: string }> = [
  { level: 0, label: "含蓄", phrases: ["尺度含蓄", "含蓄模式", "尺度恢复", "恢复含蓄"] },
  { level: 1, label: "中度", phrases: ["尺度中度", "中度模式"] },
  { level: 2, label: "直白", phrases: ["尺度直白", "直白模式", "尺度全开"] },
];

/** 检测尺度切换口令。返回目标档位，不是口令返回 null */
function detectNsfwLevelToggle(content: string): number | null {
  const c = content.trim();
  if (!c.includes("尺度") && !c.includes("模式")) return null;
  for (const def of NSFW_LEVEL_PHRASES) {
    if (def.phrases.some((p) => c.includes(p))) return def.level;
  }
  return null;
}

/** 尺度切换公告（代码层直接生效，不经过 LLM） */
function announceNsfwLevel(serveName: string): void {
  const labels = ["含蓄（只在意象和心理层面反应）", "中度（允许暗示性的感官描写）", "直白（允许直接的官能描写）"];
  const text = `[尺度] 已切换到${labels[nsfwLevel]}——${serveName}。`;
  client.sendChat(text, "Chat");
  recentChat.push(`[系统] ${text}`);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[bot] NSFW LEVEL -> ${nsfwLevel}`);
}

// 判定服务对象的话是否属于"拒绝/抗拒"语义。保守词表，避免误伤正常对话。
const REFUSAL_KEYWORDS = [
  "不要",
  "不想",
  "不愿意",
  "不需要",
  "拒绝",
  "不必",
  "不用了",
  "不要你管",
  "别管我",
  "算了",
  "走开",
  "烦",
  "讨厌",
];

// 「拒绝次数」指令：服务对象明确用掉一次拒绝次数，让 BOT 必须接受她的拒绝。
// 比 REFUSAL_KEYWORDS 更精确，避免把日常的"不要/不想"误判成消耗次数。
const REFUSAL_TOKEN_PHRASES = [
  "我拒绝",
  "我要拒绝",
  "用一次拒绝",
  "消耗一次拒绝",
  "动用拒绝次数",
  "行使拒绝",
];

/** BOT 当前身份名（在登录后才是真实名字） */
function botName(): string {
  return config.botName ?? (client.player.Name as string | undefined) ?? config.bcUsername;
}

/** 把 BOT 自己发出的内容也记进上下文，避免"失忆"导致前后矛盾 */
function rememberOwn(text: string): void {
  recentChat.push(`${botName()} (me): ${text}`);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
}

/** 记录 BOT 自己执行的道具操作（用于把 SyncItem 回执和"服务对象自己滑脱"区分开） */
function markOwnItemOp(targetNo: number, group: string, name: string | null): void {
  ownItemOps.set(`${targetNo}:${group}:${name ?? ""}`, Date.now());
  // 顺带清理过期记录，防止 Map 无限增长
  if (ownItemOps.size > 20) {
    const now = Date.now();
    for (const [k, ts] of ownItemOps) {
      if (now - ts > 15000) ownItemOps.delete(k);
    }
  }
}

/**
 * 构造收紧/放松聊天广播的 Dictionary（ChatRoom.js ChatRoomPublishAction 格式）。
 *
 * 官方 DictionaryBuilder 顺序与字段：
 *   [0] { SourceCharacter: <botNo> }                              // 裸 MemberNumber
 *   [1] { Tag:"DestinationCharacter", MemberNumber, Text:昵称 }  // 带昵称的角色引用
 *   [2] { TargetCharacter: <targetNo> }                           // 裸 MemberNumber
 *   [3] { Tag:"PrevAsset", AssetName, GroupName }                 // 收紧前的道具
 *       // NextItem = null（收紧/放松不换道具，官方不发 NextAsset 字段）
 *   [4] { Tag:"FocusAssetGroup", FocusGroupName }                 // 操作的部位
 *
 * 任何一项 Tag/字段名错位，客户端都会把整句保留为带 "SourceCharacter/DestinationCharacter" 的
 * 模板原文（用户截图看到的就是这种"占位符没被替换"现象）。
 */
function buildTightenActionDictionary(
  botNo: number,
  targetNo: number,
  group: string,
  itemName: string
): unknown[] {
  // DestinationCharacter 的 Text 字段用对方的昵称（优先 Nickname），与官方 CharacterNickname(C) 一致
  const targetChar = client.getCharacter(targetNo);
  const targetNick = (targetChar?.Nickname as string | undefined) ?? (targetChar?.Name as string | undefined) ?? "";
  return [
    { SourceCharacter: botNo },
    { Tag: "DestinationCharacter", MemberNumber: targetNo, Text: targetNick },
    { TargetCharacter: targetNo },
    { Tag: "PrevAsset", AssetName: itemName, GroupName: group },
    { Tag: "FocusAssetGroup", FocusGroupName: group },
  ];
}

/**
 * 穿戴公告字典（官方 DialogPublishAction(C, "ActionUse", ClickItem) → ChatRoomPublishAction(C, "ActionUse", null, ClickItem)）：
 * 5 项结构 — SourceCharacter / DestinationCharacter / TargetCharacter / NextAsset / FocusAssetGroup。
 * 与收紧公告同构，但 PrevAsset 换成 NextAsset（首次穿戴，没有"之前"）。
 * 不发该公告会导致房间内其他人看不到 BOT 对目标做了什么（仅 item_put 主体；
 *  adjust 的收紧/放松走 ActionTighten/Loosen*，锁走 ActionAddLock/ActionUnlock）。
 */
function buildEquipActionDictionary(
  botNo: number,
  targetNo: number,
  group: string,
  itemName: string
): unknown[] {
  const targetChar = client.getCharacter(targetNo);
  const targetNick = (targetChar?.Nickname as string | undefined) ?? (targetChar?.Name as string | undefined) ?? "";
  return [
    { SourceCharacter: botNo },
    { Tag: "DestinationCharacter", MemberNumber: targetNo, Text: targetNick },
    { TargetCharacter: targetNo },
    { Tag: "NextAsset", AssetName: itemName, GroupName: group },
    { Tag: "FocusAssetGroup", FocusGroupName: group },
  ];
}

/**
 * 上锁公告的字典（官方 ChatRoomPublishAction("ActionAddLock", TargetItem, LockItem)）：
 * 6 项——与收紧公告基本同构，多一项 NextAsset=锁具（PrevAsset=目标道具）。
 */
function buildAddLockActionDictionary(
  botNo: number,
  targetNo: number,
  group: string,
  itemName: string,
  lockName: string
): unknown[] {
  const targetChar = client.getCharacter(targetNo);
  const targetNick = (targetChar?.Nickname as string | undefined) ?? (targetChar?.Name as string | undefined) ?? "";
  return [
    { SourceCharacter: botNo },
    { Tag: "DestinationCharacter", MemberNumber: targetNo, Text: targetNick },
    { TargetCharacter: targetNo },
    { Tag: "PrevAsset", AssetName: itemName, GroupName: group },
    { Tag: "NextAsset", AssetName: lockName, GroupName: "ItemMisc" },
    { Tag: "FocusAssetGroup", FocusGroupName: group },
  ];
}

/**
 * 解锁公告的字典（官方 ChatRoomPublishAction("ActionUnlock", TargetItem, null)）：
 * 5 项——与收紧公告同构，**没有 NextAsset**（锁具已被移除，不构成 PrevAsset/NextAsset 配对）。
 * 官方键名是 "ActionUnlock"，不是 "ActionRemoveLock"——后者在 Interface.csv 里不存在。
 */
function buildUnlockActionDictionary(
  botNo: number,
  targetNo: number,
  group: string,
  itemName: string
): unknown[] {
  const targetChar = client.getCharacter(targetNo);
  const targetNick = (targetChar?.Nickname as string | undefined) ?? (targetChar?.Name as string | undefined) ?? "";
  return [
    { SourceCharacter: botNo },
    { Tag: "DestinationCharacter", MemberNumber: targetNo, Text: targetNick },
    { TargetCharacter: targetNo },
    { Tag: "PrevAsset", AssetName: itemName, GroupName: group },
    { Tag: "FocusAssetGroup", FocusGroupName: group },
  ];
}

/**
 * 脱下/移除公告的字典（官方 ChatRoomPublishAction("ActionRemove", TargetItem, null) → Dialog.js:1884）：
 * 5 项——PrevAsset=被脱下的道具 + FocusAssetGroup，没有 NextAsset。
 * 与 buildUnlockActionDictionary 同构（都是"单侧道具引用"），但 ActionRemove 才是真正的脱下动作；
 * 之前的 item_remove 只发 sendItemUpdate(slot, null) 而没有公告，导致房间内看不到"BOT 摘掉了什么"。
 */
function buildRemoveActionDictionary(
  botNo: number,
  targetNo: number,
  group: string,
  itemName: string
): unknown[] {
  // 字典结构与 ActionUnlock 一致：SourceCharacter / DestinationCharacter / TargetCharacter / PrevAsset / FocusAssetGroup
  return buildUnlockActionDictionary(botNo, targetNo, group, itemName);
}

/** #71 一次性紧急解套：启动时扫 BOT 自身外观，凡在目标道具名列表里的 Item* 道具都脱掉。
 *  仅清理列出的道具名（白名单式），其它 Item* 槽位（锁/项圈/口塞）一概不碰。
 *  self-target = botNo == memberNo，buildRemoveActionDictionary 会发 ActionRemove 公告给服务端。
 *  间隔 600ms（与启动重穿一致）避免被 BC 服务器静默丢弃。 */
async function emergencyStripBot(memberNo: number, itemNames: string[]): Promise<void> {
  const nameSet = new Set(itemNames);
  const current = client.getAppearance(memberNo) ?? [];
  // #71-1 排查模式：先把 BOT 身上所有 Group/Name 都打出来（不论匹不匹配、不论是否 Item*），
  //   便于定位"服务器视角已干净但视觉上还被吊"这种 Item* 之外的悬挂来源。
  const allSlots: { group: string; name: string; matched: boolean; isItem: boolean }[] = [];
  for (const raw of current) {
    const e = raw as { Group?: string; Name?: string };
    if (typeof e?.Group !== "string" || e.Group === "") continue;
    if (typeof e?.Name !== "string" || e.Name === "") continue;
    allSlots.push({
      group: e.Group,
      name: e.Name,
      matched: nameSet.has(e.Name),
      isItem: e.Group.startsWith("Item"),
    });
  }
  console.log(`[emergency-strip] BOT 身上总道具：${allSlots.length} 件（其中 Item* ${allSlots.filter((s) => s.isItem).length} 件）`);
  for (const it of allSlots) {
    console.log(`  ${it.matched ? "→ 脱" : "  · "}${it.isItem ? "[I]" : "   "} ${it.group}/${it.name}`);
  }
  let stripped = 0;
  for (const it of allSlots) {
    if (!it.matched) continue;
    try {
      client.sendChatAction("ActionRemove", buildRemoveActionDictionary(memberNo, memberNo, it.group, it.name));
      client.updateCachedItem(memberNo, it.group, null);
      stripped++;
      await sleep(600);
    } catch (err) {
      console.log(`[emergency-strip] ${it.group}/${it.name} 失败：${(err as Error).message}`);
    }
  }
  if (stripped === 0) {
    console.log(`[emergency-strip] 无需清理（白名单 ${itemNames.join(", ")} 均未匹配；上表是全部道具）`);
  } else {
    console.log(`[emergency-strip] 完成：共脱掉 ${stripped} 件 —— 立即落库`);
    // #71 修复根因（2026-09-06 12:23）：ActionRemove 只是给其他玩家看的"脱下"表演公告，
    //   服务器侧只转发、**不写数据库**。BC 服务器落库 Item* 道具状态的唯一通道是
    //   ChatRoomCharacterUpdate（整包外观），由 client.sendCharacterUpdate() 走
    //   (client.ts:654-680 注释已说明)。不调这个 → 服务器数据库 ItemArms: HempRope 仍
    //   保留旧值 → 下次重启（登录拉存档）时道具"复活"——这就是 BOT 重启还被吊着的真相。
    client.sendCharacterUpdate();
  }
}

/** 服务对象注册号（serveMember 是数字时直接用；否则每次现解析） */
function serveMemberNumber(): number | null {
  const t = config.serveMember?.trim() ?? "";
  if (/^\d+$/.test(t)) return Number(t);
  return client.resolveMemberNumber(t);
}

client.onLogin = (player) => {
  if (config.roomName) {
    client.joinRoom(config.roomName);
  } else {
    autoJoinRoom();
  }
};

// 进房失败重试（#45 顺手修复）：配置的房间可能暂时没人开（如 ljzbot 在服务对象上线前不存在），
// 失败后每 30 秒重试一次，直到成功进房；成功后自动停。
let joinRetryTimer: NodeJS.Timeout | null = null;
/**
 * 被踢房间黑名单（运行期）：房主机器人可能因账号门槛（如 YeS 要求游玩 ≥30 天）把 BOT 踢出。
 * 2026-09-05 18:18 事故：兜底选房只看人数又选回被踢的 YeS，布置动作全部作废。
 * 进黑名单的房本次运行不再尝试（搜索期/兜底期都排除）。
 */
const kickedRooms = new Set<string>();
client.onJoinFailed = (msg) => {
  // 2026-09-05 18:18 踢房事故：RoomKicked = 被（房主机器人）踢出，记入黑名单防止再选
  if (/kicked/i.test(msg) && client.lastJoinAttempt) {
    kickedRooms.add(client.lastJoinAttempt);
    console.log(`[bc] 被踢黑名单 += "${client.lastJoinAttempt}"（原因：${msg}），本次运行不再进这间房`);
  }
  // #16：限时回家编排期间抑制自动重进房循环——编排器自己在管换房流程，
  // 30 秒重试循环会在编排中途把 BOT 拽回 config.roomName，跟游戏打架。
  if (gohomeOrchestrating) {
    console.log(`[bc] join failed (${msg}) during gohome orchestration — auto-rejoin suppressed`);
    return;
  }
  console.log(`[bc] join failed (${msg}) — will retry every 30s until the room exists`);
  if (joinRetryTimer !== null) return;
  joinRetryTimer = setInterval(() => {
    if (client.currentRoom) {
      if (joinRetryTimer !== null) clearInterval(joinRetryTimer);
      joinRetryTimer = null;
      return;
    }
    if (gohomeOrchestrating) return; // 编排器接管期间不抢方向盘
    console.log("[bc] retrying join:", config.roomName ?? "(auto-search)");
    if (config.roomName) {
      // 2026-09-05 17:28 踩坑：BOT 独占房间时重启 → 房间被服务器回收 → 只 join 不 create
      // 死循环 30s 重试（resumeGohomeIfNeeded 等不到 onRoomJoined，超时收场卡死）。
      // 房间是 BOT 的家，不存在就自己建（与超时收场 switchRoom 的 createIfMissing 行为一致）。
      void client.switchRoom(config.roomName, { createIfMissing: true });
    }
    else void autoJoinRoom();
  }, 30000);
};

// 成功进入聊天室后才算真正就绪
// #60 BOT 默认服装：仅首次进房自动重穿（被路人脱光后用"重穿我的衣服"口令）
let botOutfitAppliedOnStartup = false;

client.onRoomJoined = (roomName) => {
  console.log("[bc] bot is ready. Waiting for messages...");
  if (testMode) console.log("[bc] TEST MODE is ON (set via BC_TEST_MODE or chat command)");
  console.log(`[bc] NSFW level: ${nsfwLevel} (${["含蓄", "中度", "直白"][nsfwLevel]})`);
  if (config.angerEnabled) console.log("[bc] anger system ON (ANGER_SYSTEM)");
  // #63 主动/被动模式：默认被动（纯事件驱动）；开窗信号见 index.ts PROACTIVE_ATTENTION_RE 等
  if (config.proactiveEnabled) {
    console.log(
      `[bc] proactive mode ready: window=${config.proactiveWindowMin}min tick=${config.proactivePerceiveSec}s silence=${config.proactiveSilenceMinSec}s gap=${config.proactiveMinGapSec}s idleClose=${config.proactiveIdleClose}`
    );
  } else {
    console.log("[bc] proactive mode OFF (PROACTIVE_ENABLED=false) — 纯被动模式");
  }
  // #64 集中/扩散模式：默认集中（一对一）；开窗=口令"社交开"/gohome 挂牌/LLM 感知她在社交
  if (config.socialEnabled) {
    console.log("[bc] social mode ready: 默认集中；开窗=口令/限时回家挂牌/LLM 感知她跟路人互动（10min 窗口）");
  } else {
    console.log("[bc] social mode OFF (SOCIAL_ENABLED=false) — 永远集中一对一");
  }
  // #47 亲密度：跨重启持久化（data/intimacy.json），进房时加载并显示当前档位
  if (config.intimacyEnabled) {
    intimacy.load();
    const aff = intimacy.getAffection();
    console.log(`[bc] intimacy system ON: ${aff.value}/100 [${aff.level}]${aff.reason ? ` (${aff.reason})` : ""}`);
  }
  console.log(`[memory] ${memory.size} long-term memories loaded${memory.size > 0 ? ":" : " (empty)"}`);
  for (const m of memory.getAll()) console.log(`  [memory]   ${m}`);
  // #14 玩具感知：进房时把服务对象当前外观记为基准快照（避免把"早就戴着"误报成"刚戴上"）
  const serveNo = serveMemberNumber();
  if (serveNo !== null && client.getAppearance(serveNo)) initToySnapshot(serveNo);
  // #19 牵引：#16 起跨房牵绳实装——编排期间牵绳持有状态**不再清空**，
  //   并且按官方 ChatRoomPingLeashedPlayers 行为对每个被牵着的人发 Leash beep
  //   （对方客户端校验通过后自动离房跟过来；校验不过她那边会断绳并发 RemoveLeash）。
  //   非编排期间维持旧行为（清空）——旧的"重进房必重抓"观察在没有 beep 机制时仍然成立。
  if ((gohomeOrchestrating || roomMoveDragging) && leashHeld.size > 0) {
    for (const held of leashHeld) client.sendLeashBeep(held);
  } else {
    leashHeld.clear();
  }
  serveLeashedBy = null;
  // #16 跨重启恢复：进房就绪后再恢复游戏会话（等待期继续等 / 已超时触发收场）
  if (!game.active && !gohomeOrchestrating) void resumeGohomeIfNeeded();
  // 无限期主人锁方案的惩罚计时恢复（重启丢定时器后重挂 / 她在线当场结算欠账）
  if (!game.active) void resumePunishIfNeeded();
  // #60 BOT 默认服装：仅首次进房触发一次。后续被路人动过用"重穿我的衣服"口令恢复；
  //   BOT_OUTFIT_ON_STARTUP=false 时**完全跳过**存档重穿，保留玩家手动穿好的外观。
  //   即使关闭启动重穿，#61 白名单权限照常生效（防别人继续动 BOT 穿戴）。
  if (!botOutfitAppliedOnStartup) {
    botOutfitAppliedOnStartup = true;
    const botNo0 = client.player.MemberNumber;
    // #61 道具互动权限（服务器端硬执法，server_app.js ChatRoomGetAllowItem）。
    //   BOT_ITEM_PERMISSION=3（默认）= 仅白名单可动 BOT 穿戴，白名单 = SERVE_MEMBER + BOT_ITEM_WHITELIST；
    //   =1 = 公开·黑名单除外（BC 官方下拉档），WhiteList 不生效、BlackList 仍拦；其余档位见 config 注释。
    if (config.botItemPermission === 3) {
      const whitelist = new Set<number>();
      const serveNo0 = serveMemberNumber();
      if (serveNo0 !== null) whitelist.add(serveNo0);
      for (const extra of config.botItemWhitelist) whitelist.add(extra);
      client.setPermissionWhitelistOnly(Array.from(whitelist));
    } else {
      client.setItemPermission(config.botItemPermission);
    }
    // 启动改名（BOT_NICKNAME 配置；留空=不动当前昵称）
    if (config.botNickname) {
      client.setNickname(config.botNickname);
    }
    // 启动设标签颜色（BOT_LABEL_COLOR 配置；留空=不动），全服聊天列表立即生效
    if (config.botLabelColor) {
      client.setLabelColor(config.botLabelColor);
    }
    if (!config.botOutfitOnStartup) {
      console.log("[bot-outfit] 启动重穿已关闭（BOT_OUTFIT_ON_STARTUP=false），保留当前穿着；白名单权限照常生效");
    } else {
      const saved = botOutfit.loadBotOutfit();
      if (botNo0 !== undefined && saved && saved.entries.length > 0) {
        const clientAdapter: botOutfit.BotOutfitClient = {
          sendItemUpdate: (t, g, n, o) => client.sendItemUpdate(t, g, n, o),
          updateCachedItem: (m, g, n, o) => client.updateCachedItem(m, g, n, o),
          getAppearance: (m) => client.getAppearance(m),
          sendCharacterUpdate: () => client.sendCharacterUpdate(),
        };
        console.log(`[bot-outfit] 启动重穿：${saved.entries.length} 件（先脱后穿，防护靠权限白名单）`);
        void (async () => {
          const r = await botOutfit.applyBotOutfit(botNo0, clientAdapter, {
            intervalMs: 350,
            includeItemSlots: false,
          });
          console.log(`[bot-outfit] 启动重穿完成：equipped=${r.equipped} removed=${r.removed} skipped=${r.skipped}`);
          // #71 一次性紧急解套：清掉非存档 Item* 道具（仅列出的名字，其它 Item* 槽位不碰）
          //   设计动机：bot-outfit 永不脱 Item*（束缚是状态不归制服管）——但 服务对象 用麻绳绑了 BOT 之后，
          //   即使在客户端解开，只要服务器那边未真正生效，重启后仍会残留。
          //   给个一次性环境变量触发精准清理，用完即删，避免常态化误清惩罚锁/主人锁等真状态。
          if (config.botEmergencyStrip.length > 0) {
            await emergencyStripBot(botNo0, config.botEmergencyStrip);
          }
        })();
      }
    }
  }
  // #62 每次进房自动摆姿势（默认 LegsClosed=双腿并拢站好；BOT_JOIN_POSE 留空关闭）。
  //   只在进房瞬间设一次——之后服务对象仍可用口令让 BOT 换姿势（跪下/站起来等）。
  //   延迟 1.5s：等角色在房间内完全同步后再发（进房瞬间立刻发可能被房内初始同步覆盖）。
  if (config.botJoinPose) {
    const poseCheck = checkPose(config.botJoinPose);
    if (poseCheck.ok && poseCheck.pose) {
      const poses = poseCheck.pose;
      setTimeout(() => {
        client.setPose(poses);
        console.log(`[pose] 进房姿势：${config.botJoinPose} -> [${poses.join(", ")}]`);
      }, 1500);
    } else {
      console.warn(`[pose] BOT_JOIN_POSE="${config.botJoinPose}" 不在姿势白名单，跳过（可选：StandUp/Kneel/KneelingSpread/Yoked/OverTheHead/BackBoxTie/BackCuffs/LegsClosed/AllFours）`);
    }
  }
};

// #16 限时回家：服务对象进了 BOT 所在的房间 = 候选"到家"事件（限等待期，到家判定看 gohomeCheckArrival）
client.onMemberJoin = (memberNo) => {
  // #74 有玩家进房：重申一次默认姿势（双腿并拢站立）——修"服务器姿势状态抽风"：
  //   2026-09-06 16:10 实测"药"进房看到 BOT 不是并腿，而 服务对象 客户端看到的是并腿
  //   （同一 BOT 两个客户端两种姿势 = 服务器姿势状态对不同步）。趁进房时机重发
  //   ChatRoomCharacterPoseUpdate，把所有人的姿势状态重新对齐。
  //   守卫：BOT 身上有束缚道具（被绑着）时不强制——束缚决定姿势，不覆盖。
  //   延迟 1.5s：进房玩家客户端还在初始同步中，立刻发可能赶在同步前被其初始状态覆盖
  //   （与 #62 进房姿势同样的时序考量）。
  if (config.botJoinPose) {
    const selfNo = client.player.MemberNumber ?? -1;
    const selfApp = client.getAppearance(selfNo);
    if (!hasRestraintItem(selfApp)) {
      const poseCheck = checkPose(config.botJoinPose);
      if (poseCheck.ok && poseCheck.pose) {
        const poses = poseCheck.pose;
        setTimeout(() => {
          client.setPose(poses);
          console.log(`[pose] #74 玩家进房姿势重申：${config.botJoinPose}（触发者 #${memberNo}）`);
        }, 1500);
      }
    } else {
      console.log(`[pose] #74 跳过姿势重申：BOT 身上有束缚（触发者 #${memberNo}）`);
    }
  }
  const serveNo = serveMemberNumber();
  if (serveNo === null || memberNo !== serveNo) return;
  // #63 主动模式：她进房且窗口开着 → 状态突变即时感知（不用等下一个定时 tick）。
  //   延迟 8s：等房间同步/她安顿下来，也避开 pendingRespondTimer 排队期。
  if (config.proactiveEnabled && proactiveIsOpen()) {
    setTimeout(() => void proactiveTick("她进房（突变触发）"), 8000);
  }
  // #16 欠惩罚补锁（2026-09-05 奖惩定案）：上局输了她却不在场躲过惩罚 → 这次进房补上。
  // 独立于游戏会话（会话可能已结束，但债在 gohome-punish.json 里）。
  const inGohome = game.active && game.currentRule?.id === "gohome";
  setTimeout(() => {
    void maybeApplyPendingPunish(serveNo);
  }, 2500);
  if (!inGohome) return;
  const state = game.currentState as GohomeState | null;
  if (!state || state.phase !== "waiting") return;
  // 成员加入 bundle 带完整外观——稍等同步落缓存再判定
  setTimeout(() => {
    void gohomeCheckArrival(state);
  }, 1500);
};

// ---------------------------------------------------------------------------
// #46 怒气情绪系统：定时器接线
//   ① 每 5 秒检查"问话被无视"（BOT 提问 30 秒后服务对象仍无文字回应）。
//      触发时：+8 怒气 + 记 [情绪] 行 + 让 BOT 表达不满（respond 享受同样的 LLM 流程，
//      下一句话气自然带情绪标签）。注意一次提问只记一次，不会重复计费。
//   ② 每 60 秒指数衰减（半衰期 15 分钟；暴怒态系数平方 = 自我冷却，Dom 不失态）。
// ---------------------------------------------------------------------------
setInterval(() => {
  if (!config.angerEnabled) return;
  const ignoredQ = anger.checkIgnoredQuestion();
  if (ignoredQ !== null) {
    const serveNo = serveMemberNumber();
    const serveName = serveNo !== null ? client.nameOf(serveNo) : "服务对象";
    const line = `[情绪] 你问了"${ignoredQ.slice(0, 30)}"，但 ${serveName} 没有回答，继续自己挣扎（她无视了你）。`;
    recentChat.push(line);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    console.log(`[mood] ignored-question: ${serveName} 未回应你的问话`);
    void respond(true);
  }
}, 5000);

setInterval(() => {
  if (!config.angerEnabled) return;
  anger.tickDecay();
}, 60_000);

// #48 怒气降档 → 惩罚状态全部清零（高压立刻停止，配合服软 -20 的和解路径）；
// 回到暴怒以下也顺便结束冷处理（情绪退烧了就不再冷她）。
anger.onMoodLevelChange((from, to) => {
  const order = ["平静", "微恼", "恼火", "暴怒"];
  if (order.indexOf(to) < order.indexOf(from)) {
    console.log(`[punish] mood lowered ${from}→${to}: resetting punishment state`);
    punishment.resetPunishments();
    punishment.endColdTreatment(`怒气降档 ${from}→${to}`);
  }
});

/** 登录后未指定房间时，搜索混合空间并自动加入一个人多的非满员房间 */
async function autoJoinRoom(): Promise<void> {
  try {
    console.log(`[bc] no BC_ROOM_NAME set; searching chat rooms (Space="${config.roomSpace}")...`);
    const rooms = await client.searchRooms();
    if (rooms.length === 0) {
      console.log("[bc] no rooms found — bot will not receive chat. Set BC_ROOM_NAME to a known room, or retry.");
      return;
    }
    const nonFull = rooms.filter((r) => {
      const limit = r.MemberLimit ?? 0;
      return limit <= 0 || (r.MemberCount ?? 0) < limit;
    });
    const pool = nonFull.length > 0 ? nonFull : rooms;
    pool.sort((a, b) => (b.MemberCount ?? 0) - (a.MemberCount ?? 0));
    const target = pool[0];
    console.log(
      `[bc] auto-joining "${target.Name}" (${target.MemberCount ?? "?"}/${target.MemberLimit ?? "?"} players)`
    );
    client.joinRoom(target.Name);
  } catch (err) {
    console.error("[bc] auto-join error:", (err as Error).message);
  }
}

client.onChat = async (event) => {
  const content = (event.message.Content ?? "").trim();
  const senderNo = event.message.Sender;
  const isServe = isServeMember(senderNo, event.senderName);

  // #16 热闹度采样：记下"非 BOT 非服务对象的发言者"集合（去重）
  //   阈值 ≥2 个不同人发过 = "热闹"；单人刷屏不算（2026-09-05 用户纠错：BC 房间
  //   经常一堆 AFK 玩家挂机，不能只数"总发言数 ≥ 1"就判定热闹）。
  if (
    senderNo !== undefined &&
    !isServe &&
    senderNo !== client.player.MemberNumber
  )
    recentChatMembers.add(senderNo);

  // #46 怒气情绪：服务对象发了文字 = 有互动 → 清除"问话被无视"计时 + 怒气小幅回落。
  //   挣扎/动作（Activity）不算文字回应，不清计时（正是用户截图"问了还在挣扎=无视"的场景）。
  //   #48 例外：冷处理期间她说话不算有效互动——不降怒气（否则 3 轮 -30 直接把暴怒降档，
  //   冷处理被自动终结，沉默威慑完全失效）。破冰由冷处理状态机自己管（服软累计/轮数/超时）。
  if (isServe && config.angerEnabled) {
    anger.noteServeChat();
    if (!punishment.isColdTreating()) {
      anger.relieveAnger(10, "她开口回应了你");
    }
  }
  // #49 阳奉阴违：记录她最近一次文字发言原文（serve_promised 时入队的承诺就是这条原话）
  if (isServe && content) {
    lastServeMessage = content;
    // #63 主动模式：冷场门槛基准（tick 用"距她上次发言多久"判定冷场）
    lastServeChatAt = Date.now();
    // #63 开窗信号①（代码层确定性）：她说的话命中"求关注"类词 → 开主动窗口。
    //   这类话本身也会走被动 respond（一对一必响应），开窗的意义是之后一段时间保持主动陪伴。
    if (content.length <= 40 && PROACTIVE_ATTENTION_RE.test(content)) {
      proactiveOpen("她求关注（文字信号）");
    }
  }

  // 安全词检测：服务对象说出安全词 = 真正拒绝，立即停止并温柔安抚（代码层兜底，不靠 LLM 临场判断）
  if (isServe && config.safeWord && mentionsSafeWord(content)) {
    consecutiveRefusal = 0; // 安全词触发后清零，让 DOM 切回温柔模式
    punishment.endColdTreatment("安全词"); // #48 冷处理无条件立即结束
    game.abort("safe-word"); // 安全词无条件中止当前游戏（游戏框架优先）
    if (gohomeConsent) gohomeCancelConsent("safe-word", ""); // #16 等点头窗口一并关掉
    triggerAftercare(event.senderName);
    return;
  }

  // #16 开局同意门：等点头窗口期。点头=开始上束缚；拒绝/认输/取消=作废；
  // 又喊口令=重讲规则并重置窗口；其他消息不拦（她可以提问，LLM 结合等点头状态正常回答）
  if (isServe && gohomeConsent) {
    if (GOHOME_CONSENT_NOD_RE.test(content)) {
      const st = gohomeConsent.state;
      clearTimeout(gohomeConsent.timer);
      gohomeConsent = null;
      st.phase = "preparing";
      saveGohomeState(st);
      console.log(`[gohome] 她点头了——开始上束缚（${content.slice(0, 20)}）`);
      client.sendChat("好——是你自己点头的，那我就不客气了。");
      void runGohomeGame();
      return;
    }
    if (GOHOME_CONSENT_REFUSE_RE.test(content)) {
      gohomeCancelConsent("refuse", "行，先不开始。规则记在心里就好——想玩的时候再喊我。");
      return;
    }
    if (GOHOME_TRIGGER_RE.test(content)) {
      // 窗口里又喊口令 = 想再听一遍规则：重讲 + 重置等待窗
      gohomeOpenConsent(gohomeConsent.state);
      client.sendChat(gohomeRule.startAnnouncement(gohomeConsent.state as unknown as import("./game").GameState));
      return;
    }
    // 其他消息（提问/闲聊）不拦截——落下去走正常对话
  }

  // 测试模式口令：只有服务对象能切换。代码层检测，切换后立即生效（不用重启 BOT）
  if (isServe) {
    const toggle = detectTestModeToggle(content);
    if (toggle !== null) {
      testMode = toggle;
      announceTestMode(event.senderName);
      return;
    }
    // 测试模式快捷口令：解除我的所有束缚（代码层确定性执行，不走 LLM）。
    // 游戏会话进行中会先中止（不判胜负）；编排器穿脱/接人途中会拒绝并提示稍后再喊。
    if (testMode && detectUnrestrainAllCommand(content)) {
      void executeUnrestrainAll();
      return;
    }
    // 测试模式快捷口令：添加好友 #编号（#16 认输机制配套——让 BOT 能主动加好友以收发 Beep）。
    // BC 好友是双向的：双方都得加 BOT 才会把对方 Beep 转发过来；本命令只加 BOT 这一边。
    if (testMode && detectAddFriendCommand(content)) {
      const target = parseFriendNumberFromCommand(content);
      if (target === null) {
        client.sendChat("（皱眉）添加好友需要 #编号——例如：添加好友 #123456");
        return;
      }
      if (target === client.player.MemberNumber) {
        client.sendChat("（眨眼）……那是我自己。");
        return;
      }
      if (client.friendList.includes(target)) {
        client.sendChat(`（点头）#${target} 已经在好友列表里了。`);
        return;
      }
      const ok = client.addFriend(target);
      client.sendChat(
        ok
          ? `（敲了敲桌面）已把 #${target} 加入好友列表——对方也得加我，Beep 才能互通。`
          : `（歪头）#${target} 添加失败，看一眼日志？`
      );
      return;
    }
    // #63 主动模式测试口令（仅测试模式）：主动模式开 / 主动模式关——强制开/关主动窗口。
    //   与其它测试口令不同：不自动关测试模式（主动模式要连续观察，测试模式开着无妨）。
    if (testMode && /主动模式开|开启主动模式|主动开窗/.test(content)) {
      proactiveOpen("手动口令（测试）");
      client.sendChat(`[测试] 主动窗口已开：${config.proactiveWindowMin} 分钟，每 ${config.proactivePerceiveSec}s 感知一次（门槛过滤照常生效）。`);
      return;
    }
    if (testMode && /主动模式关|关闭主动模式|主动关窗/.test(content)) {
      proactiveClose("手动口令（测试）");
      client.sendChat("[测试] 主动窗口已关，回落纯被动模式。");
      return;
    }
    // #64 社交（扩散）模式口令（正式功能，不限测试模式）：社交开 / 社交关。
    //   开=房内所有消息都过 LLM（BOT 加入房间社交）；关=回落集中模式（只关注服务对象）。
    //   只动 manual 来源——gohome 拴柱/LLM 感知来源不受口令影响。
    if (SOCIAL_CMD_ON_RE.test(content)) {
      socialAddSource("manual", "服务对象口令");
      client.sendChat(
        socialActive()
          ? "（环视房间）好——今天我在这房里陪大家一起聊。有事尽管说。"
          : "（社交模式未启用 SOCIAL_ENABLED）"
      );
      return;
    }
    if (SOCIAL_CMD_OFF_RE.test(content)) {
      socialRemoveSource("manual", "服务对象口令");
      client.sendChat(
        socialActive()
          ? "（收回目光）社交模式先这样——我的注意力回来了。"
          : "（点头）好，我安静待着，只听你说话。"
      );
      return;
    }
    // #54 手持道具口令（正式功能）：拿X/手持X/举起X/拿起X → 拿起；放下道具/空手 → 放下。
    //   道具名支持中文（硬鞭/羽毛/马克杯…）或英文资产名，findHandheldByText 最长匹配。
    if (/^(?:放下道具|把道具放下|空手|放下手里的东西)[。！!~～ ]*$/.test(content)) {
      void executeIntent({ action: "handheld_drop" });
      return;
    }
    const handheldCmd = content.match(
      /^(?:拿起|拿上|拿|手持|举起|握住|拿着)(?:一[个根支条把块杯根]|一)?(.{1,12}?)[。！!~～ ]*$/
    );
    if (handheldCmd) {
      const itemName = findHandheldByText(handheldCmd[1]);
      if (itemName) {
        void executeIntent({ action: "handheld_take", handheld: itemName });
        return;
      }
      // 没匹配上道具名就落到 LLM（可能她说的是"拿点吃的过来"这类语义请求，不是道具口令）
    }
    // #48-B 怒气测试口令（仅测试模式）：怒气=60 / 怒气+20 / 怒气-10。
    // 设定后自动关闭测试模式并公告——方便快速把 BOT 推到目标档位测惩罚，又不用手动再关测试模式。
    const angerCmd = testMode ? detectAngerCommand(content) : null;
    if (angerCmd !== null) {
      const before = anger.getAnger();
      if (angerCmd.op === "=") {
        anger.setAnger(angerCmd.value, `测试口令设定`);
      } else if (angerCmd.op === "+") {
        anger.setAnger(before + angerCmd.value, `测试口令增加`);
      } else {
        anger.setAnger(before - angerCmd.value, `测试口令减少`);
      }
      const after = anger.getAnger();
      testMode = false; // 按用户要求：实现后关闭测试模式
      const text = `[测试] 怒气 ${before}→${after}（${anger.getMood().level}）——测试模式已关闭，人设恢复。`;
      client.sendChat(text, "Chat");
      recentChat.push(`[系统] ${text}`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      console.log(`[bot] anger test command: ${content.trim()} → ${before}→${after}, TEST MODE OFF`);
      return;
    }
    // #47-B 亲密度测试口令（仅测试模式）：亲密度=60 / 亲密度+20 / 亲密度-10。
    //   设定后自动关闭测试模式并公告（与怒气口令同款流程）。
    const affCmd = config.intimacyEnabled && testMode ? detectIntimacyCommand(content) : null;
    if (affCmd !== null) {
      const before = intimacy.getIntimacy();
      if (affCmd.op === "=") {
        intimacy.setIntimacy(affCmd.value, `测试口令设定`);
      } else if (affCmd.op === "+") {
        intimacy.setIntimacy(before + affCmd.value, `测试口令增加`);
      } else {
        intimacy.setIntimacy(before - affCmd.value, `测试口令减少`);
      }
      const after = intimacy.getAffection();
      testMode = false; // 按用户要求：实现后关闭测试模式
      const text = `[测试] 亲密度 ${before}→${after.value}（${after.level}）——测试模式已关闭，人设恢复。`;
      client.sendChat(text, "Chat");
      recentChat.push(`[系统] ${text}`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      console.log(`[bot] intimacy test command: ${content.trim()} → ${before}→${after.value}, TEST MODE OFF`);
      return;
    }
    // NSFW 尺度切换口令（#14 压力测试定档用）
    const nsfwToggle = detectNsfwLevelToggle(content);
    if (nsfwToggle !== null && nsfwToggle !== nsfwLevel) {
      nsfwLevel = nsfwToggle;
      announceNsfwLevel(event.senderName);
      return;
    }
    // 清除记忆口令：一键清空长期记忆（方便测试）
    if (MEMORY_WIPE_PHRASES.some((p) => content.includes(p))) {
      memory.clear();
      const text = `[系统] 记忆已清除——${event.senderName}，我把之前记住的都忘掉了。`;
      client.sendChat(text, "Chat");
      recentChat.push(`[系统] ${text}`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      console.log("[memory] wiped by serve target");
      return;
    }
    // #16 套装快照口令：束缚由用户设计、BOT 记住
    if (/记住这身|记住这身束缚|记住这个套装/.test(content)) {
      const serveNo0 = serveMemberNumber();
      const app = serveNo0 !== null ? client.getAppearance(serveNo0) : null;
      const entries = outfit.captureOutfit(app);
      if (entries.length === 0) {
        client.sendChat("你现在身上一件束缚都没有，没什么可记的——先穿好再来叫我。");
      } else {
        const file = outfit.saveOutfit(entries);
        const text = `[套装] 记住了：${outfit.describeOutfit(file)}。以后玩限时回家，就按这一身给你穿。`;
        client.sendChat(text, "Chat");
        recentChat.push(`[系统] ${text}`);
        if (recentChat.length > MAX_RECENT) recentChat.shift();
        console.log(`[gohome] 套装快照已保存：${entries.length} 件`);
      }
      return;
    }
    if (/查看套装|我那身是什么|套装是什么/.test(content)) {
      const file = outfit.loadOutfit();
      client.sendChat(
        file ? `[套装] ${outfit.describeOutfit(file)}` : "[套装] 你还没让我记住过哪一身呢。"
      );
      return;
    }
    // ============ #60 BOT 默认服装口令 ============
    // "记住我的衣服"——把 BOT 当前外观（含衣着/发/妆容/Item）整体快照存档，
    //   之后每次启动自动重穿，可锁道具 24h 主人定时锁防路人脱。
    // "查看我的衣服"——列出存档清单。
    // "重穿我的衣服"——按存档重新穿回（含 24h 锁），用来救"被公共房间脱光"的 BOT。
    if (/记住我的衣服|记住这身衣服|记下你的衣服|记下你的制服|记住你的制服/.test(content)) {
      const botNo0 = client.player.MemberNumber;
      if (botNo0 === undefined) {
        client.sendChat("[制服] 我还没登录呢，记不了衣服。");
        return;
      }
      const botApp = client.getAppearance(botNo0);
      const entries = botOutfit.captureBotAppearance(botApp);
      const file0 = botOutfit.saveBotOutfit(entries);
      const on = config.botOutfitOnStartup;
      client.sendChat(`[制服] 记住了——共 ${entries.length} 件（${new Date(file0.savedAt).toLocaleString("zh-CN")} 保存）。${on ? "启动自动按这身穿" : "启动不自动穿（看 environment: BOT_OUTFIT_ON_STARTUP）"}，被路人动过可用「重穿我的衣服」恢复。穿戴保护已开启：只有白名单里的人能动我的衣服。`);
      console.log(`[bot-outfit] 存档：${entries.length} 件`);
      return;
    }
    if (/查看我的衣服|看你穿的|你穿的是什么|你穿的什么|看你制服/.test(content)) {
      const bf = botOutfit.loadBotOutfit();
      client.sendChat(bf ? `[制服] ${botOutfit.describeBotOutfit(bf)}` : "[制服] 我还没被设置过默认制服——你想给我穿什么，就亲手给我穿好，然后说「记住我的衣服」。");
      return;
    }
    if (/重穿我的衣服|重新穿上|恢复你的制服|恢复你的衣服/.test(content)) {
      const botNo1 = client.player.MemberNumber;
      if (botNo1 === undefined) return;
      const clientAdapter: botOutfit.BotOutfitClient = {
        sendItemUpdate: (t, g, n, o) => client.sendItemUpdate(t, g, n, o),
        updateCachedItem: (m, g, n, o) => client.updateCachedItem(m, g, n, o),
        getAppearance: (m) => client.getAppearance(m),
        sendCharacterUpdate: () => client.sendCharacterUpdate(),
      };
      void (async () => {
        const r = await botOutfit.applyBotOutfit(botNo1, clientAdapter, {
          intervalMs: 350,
          includeItemSlots: false, // 束缚槽不脱不穿（游戏/惩罚状态不归制服管）
        });
        client.sendChat(`[制服] 重穿完成——穿上 ${r.equipped} 件，脱掉多余 ${r.removed} 件，跳过 ${r.skipped} 件（束缚不动）。`);
        console.log(`[bot-outfit] 重穿: equipped=${r.equipped} removed=${r.removed} skipped=${r.skipped}`);
      })();
      return;
    }
    // 补颜色：把记好的套装颜色补回她身上穿着的对应道具（不动锁、不动变体、不动松紧）。
    // 来由（2026-09-05 实测）：上锁等后续道具更新漏发 Color 会被接收端重置成默认色——
    // 重穿时颜色是对的，逐件上锁时被洗掉。修复后新局不会复发；此口令用来救当前这局。
    if (/补颜色|补个颜色|把颜色补回来/.test(content)) {
      const file = outfit.loadOutfit();
      const serveNo2 = serveMemberNumber();
      if (!file || file.entries.length === 0) {
        client.sendChat("[套装] 我还没记住过哪一身，没有颜色可补。");
        return;
      }
      if (serveNo2 === null) return;
      const appearance = client.getAppearance(serveNo2) ?? [];
      let patched = 0;
      for (const e of file.entries) {
        if (e.color === undefined) continue;
        const worn = appearance.find((raw) => {
          const w = raw as { Group?: string; Name?: string; Difficulty?: unknown };
          return w.Group === e.group && w.Name === e.name;
        }) as { Group?: string; Name?: string; Property?: Record<string, unknown>; Difficulty?: unknown } | undefined;
        if (!worn) continue; // 该槽位现在不是这件道具，跳过（不打断游戏）
        const base = outfit.assetBaseDifficulty(e.group, e.name) || getItemBaseDifficulty(e.group, e.name);
        const absDiff = typeof worn.Difficulty === "number" ? worn.Difficulty : base;
        // 带上当前 Property（含锁字段——漏发锁字段会把锁洗掉）和 Difficulty（漏发会重置松紧）
        client.sendItemUpdate(serveNo2, e.group, e.name, {
          property: worn.Property ?? undefined,
          difficulty: absDiff - base,
          color: e.color,
        });
        client.updateCachedItem(serveNo2, e.group, e.name, { color: e.color });
        patched++;
        console.log(`[gohome] 补颜色: ${e.group}/${e.name}`);
      }
      client.sendChat(
        patched > 0
          ? `[套装] 颜色补回去了——${patched} 件按我记好的样子恢复原色。`
          : "[套装] 现在身上没有一件能对上记好的套装，没什么可补的。"
      );
      return;
    }
    // 按发色染色（手动版）：把身上正穿着的主束缚件（ItemArms 槽）当场染成当前发色。
    // 开局时编排器会自动做同样的事（每局动态读发色，不依赖此口令）——这个口令用于
    // 当场预览/救急（比如游戏进行中想换配色）。锁着的也能改（带当前锁字段+难度防洗）。
    if (/按发色|配发色|染成我头发的颜色|和头发同色|头发同色/.test(content)) {
      const serveNo3 = serveMemberNumber();
      if (serveNo3 === null) return;
      const hairColor = readHairColor(serveNo3);
      if (!hairColor) {
        client.sendChat("你现在是默认发色，我取不到具体色号。先在游戏里换个头发颜色，或者直接告诉我想要什么颜色（六位色号）。");
        return;
      }
      const app3 = client.getAppearance(serveNo3) ?? [];
      const worn3 = app3.find((raw) => {
        const w = raw as { Group?: string; Name?: string; Color?: unknown };
        return w.Group === "ItemArms" && typeof w.Name === "string";
      }) as { Name?: string; Property?: Record<string, unknown>; Difficulty?: unknown; Color?: unknown } | undefined;
      if (!worn3?.Name) {
        client.sendChat("你现在手臂上没穿束缚件，没东西可染——开局时我会自动按你的发色给主束缚件配色。");
        return;
      }
      // 主体层（数组第 0 层）换发色，装饰层原样；单色/无色则整体发色
      const newColor: string | string[] = Array.isArray(worn3.Color)
        ? [hairColor, ...(worn3.Color as string[]).slice(1)]
        : hairColor;
      const base3 = outfit.assetBaseDifficulty("ItemArms", worn3.Name) || getItemBaseDifficulty("ItemArms", worn3.Name);
      const absDiff3 = typeof worn3.Difficulty === "number" ? worn3.Difficulty : base3;
      client.sendItemUpdate(serveNo3, "ItemArms", worn3.Name, {
        property: worn3.Property ?? undefined,
        difficulty: absDiff3 - base3,
        color: newColor,
      });
      client.updateCachedItem(serveNo3, "ItemArms", worn3.Name, { color: newColor });
      console.log(`[gohome] 按发色染色（手动）: ItemArms/${worn3.Name} 主体层 -> ${hairColor}`);
      client.sendChat(
        `[套装] 染好了——${worn3.Name} 的主体换成你头发的颜色（${hairColor}），金属扣那些小装饰留着没动。` +
          "以后每局开局我也会自动按你当天的发色配。"
      );
      return;
    }
    if (GOHOME_TRIGGER_RE.test(content)) {
      const handled = await tryStartGohome(content, event.senderName);
      if (handled) return;
    }
  }

  // #20 游戏框架：服务对象的消息（除口令外）优先交给规则模块判定。
  // handleGameMessage 内部判断是"开局"还是"游戏中"，规则模块 consumed 则不再走常规流程。
  if (isServe) {
    const handled = await handleGameMessage(content, event.senderName);
    if (handled) return;
  }

  // 「拒绝次数」消耗：服务对象明确说「我拒绝」等指令时，若有次数则消耗一次，
  // BOT 必须接受她的拒绝（这是她靠游戏赢来的权利，不是挑衅）。
  let refusalTokenUsed = false;
  if (isServe && isRefusalTokenUse(content) && gameState.consumeRefusalToken()) {
    refusalTokenUsed = true;
    // 注入一条明确的上下文：BOT 已经接受了她的拒绝，不许再追问/施压。
    const line = `[拒绝次数] ${event.senderName} 动用了拒绝次数（剩余 ${gameState.refusalTokens} 次），你已无条件接受她的拒绝，不再追问、不再施压。`;
    recentChat.push(line);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    console.log(`[refusal-token] ${event.senderName} used a refusal token (${gameState.refusalTokens} left)`);
  }

  // 服务对象相关消息计数（用于记忆提取节流）
  if (isServe) unprocessedServeMsgs += 1;

  // 拒绝计数：仅跟踪服务对象的连续拒绝；其他人/正常说话不会触发硬模式
  if (isServe) {
    if (refusalTokenUsed) {
      consecutiveRefusal = 0; // 用了拒绝次数 = 合法拒绝，清零避免误判成挑衅
    } else if (isRefusalKeyword(content)) {
      consecutiveRefusal += 1;
    } else if (content.length > 0) {
      consecutiveRefusal = 0; // 正常对话立即清零，避免硬模式粘连
    }
  }

  // 非服务对象的消息：集中模式记"不重要背景"；#64 扩散（社交）模式记"房客"（LLM 会接茬）
  const line = isServe
    ? `${event.senderName}: ${content}`
    : socialActive()
    ? `[房客] ${event.senderName}: ${content}`
    : `[不重要] ${event.senderName}: ${content}`;
  recentChat.push(line);
  if (recentChat.length > MAX_RECENT) recentChat.shift();

  // 触发策略：一对一（集中）模式下，服务对象发言必响应，其他人仅在被 @ 时才礼貌回应；
  // #64 扩散（社交）模式下房内所有消息都过 LLM（全量响应，LLM 自主决定接不接茬）
  const addressed = config.serveMember
    ? isServe || socialActive() || mentionsBot(content, botName())
    : config.respondToAll || mentionsBot(content, botName());
  if (!addressed) return;

  await respond(isServe);
};

// 服务对象对 BOT 做游戏动作（摸头/搂抱等）→ BOT 也要能"感受到"并回应
client.onActivity = async (event) => {
  const botNo = client.player.MemberNumber;
  const isOnBot = event.targetNo !== null && event.targetNo === botNo;
  const isServe = isServeMember(event.sourceNo, event.senderName);

  // #16 同意门（2026-09-05 17:16 实测踩坑）：聊天栏点头动作走 Activity 通道
  // （activityKey=ChatSelf-ItemHead-Nod），不是 Chat/Emote——之前同意门只拦聊天文字，
  // 点头漏给了 LLM，它自由发挥开始上束缚，把编排器整个绕过（没脱衣/没快照/没主人锁）。
  // 现在等点头窗口期，Activity 点头也按"同意"处理：关窗 → 开跑编排器，不再往下走 respond。
  if (isServe && gohomeConsent && /^Chat(Self|Other)-ItemHead-Nod$/i.test(event.activityKey ?? "")) {
    const st = gohomeConsent.state;
    clearTimeout(gohomeConsent.timer);
    gohomeConsent = null;
    st.phase = "preparing";
    saveGohomeState(st);
    console.log(`[gohome] 她点头了（Activity ${event.activityKey}）——开始上束缚`);
    client.sendChat("好——是你自己点头的，那我就不客气了。");
    void runGohomeGame();
    return;
  }

  // 挣扎事件：服务对象被绑着还想滑脱 = 叛逆行为，必须触发反应（其他人挣扎只当背景）
  if (event.kind === "struggle") {
    if (!isServe) {
      recentChat.push(`[不重要][叛逆] ${event.text}`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      return;
    }
    // 真实束缚 grounding（#40 → 17:46 修正）：
    //   BC 客户端的 Struggle 状态广播会残留/误报（进度条已结束但 Player.Status 还挂着
    //   "Struggle"，或被牵引绳 Leash 时状态机周期刷新把陈旧 Struggle 重新发出来）。
    //   原判定只认 Freeze/Block/Tethered/Mounted 四种强限制效果——但脚铐/腿铐/眼罩/口球
    //   这类"轻束缚"都不带这四种效果（手铐 ItemArms 带 Block），手铐一掉就误杀所有真挣扎
    //   （2026-09-04 17:46 实测：服务对象 身上 5 件束缚，挣扎全被 [struggle-ignored] 丢弃）。
    //   现在放宽为：束缚类槽位（口/头/颈/臂/腿/脚/躯干）有道具 = 真实挣扎可信。
    //   玩具槽（ItemVulva 等）刻意不算——#40 的"戴玩具残留 Struggle"场景继续过滤。
    const serveNoForStruggle = serveMemberNumber();
    const serveAppForStruggle = serveNoForStruggle !== null ? client.getAppearance(serveNoForStruggle) : null;
    const struggleEffects = collectEffects(serveAppForStruggle);
    const trulyRestrained =
      hasRestraintItem(serveAppForStruggle) || // 束缚槽有道具（轻束缚也算真挣扎）
      struggleEffects.has("Freeze") ||
      struggleEffects.has("Block") ||
      struggleEffects.has("Tethered") ||
      struggleEffects.has("Mounted");

    if (!trulyRestrained) {
      // 无真实束缚 → 挣扎信号是残留/误报（#40/#42，2026-09-04 实测暴露）。
      // 关键：这条噪声**完全不进 recentChat**，只留日志。否则"挣扎"这个动作词一旦进 LLM 上下文，
      // 即使标成 [背景] 也会抢在真正的 [玩具] 事件前被反应（实测：服务对象 戴振动阳具，BOT 却说"怎么还乱动起来了"）。
      console.log(`[struggle-ignored] ${event.text}（无真实束缚，丢弃不入上下文）`);
      return;
    }

    // 去抖：挣扎按钮连点会刷出大量相同事件，4 秒内只记一次、只触发一次
    const now = Date.now();
    if (now - lastStruggleAt < 4000) return;
    lastStruggleAt = now;
    const line = `[叛逆] ${event.text}`;
    recentChat.push(line);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    console.log(`[struggle] ${event.text}`);
    // #48 冷处理期间：挣扎照常进上下文，但不回应、不计话轮（沉默对挣扎同样适用）
    if (config.angerEnabled && punishment.isColdTreating()) {
      console.log(`[punish] cold treatment: struggle recorded but not responded`);
      return;
    }
    await respond(true);
    return;
  }

  // 2026-09-04 19:20 修复：她主动放弃挣扎 = 投降/服软信号，必须告诉 LLM（之前被 Action 通道丢弃，
  //   后续响应会按"她还在挣扎"处理 → 训斥/牵走，错得离谱）。怒气计 -20 服软、recentChat 记"放弃"、
  //   触发 respond 让 LLM 用温柔/宠溺语气回应，别再惩罚。
  if (event.kind === "struggle-giveup") {
    if (!isServe) {
      recentChat.push(`[不重要][叛逆→服软] ${event.text}`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      return;
    }
    anger.relieveAnger(20, "她放弃挣扎（服软）");
    if (config.angerEnabled) {
      // 同时清掉"问话被无视"计时——她刚才的挣扎/动作属于回应，不该再因 30 秒无文字扣分
      anger.noteServeChat();
    }
    // 19:28 实测补丁：投降时清掉 recentChat 里所有旧 [叛逆] 行——它们已被投降事件覆盖，
    //   留着只会让 v4-pro 在多次 respond 堆叠的延迟响应里继续误判她还在挣扎。
    for (let i = recentChat.length - 1; i >= 0; i--) {
      if (recentChat[i].includes("[叛逆]")) recentChat.splice(i, 1);
    }
    const line = `[叛逆→服软] ${event.text}（挣扎已结束，勿再以"还在挣"指控）`;
    recentChat.push(line);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    console.log(`[struggle-giveup] ${event.text}`);
    // #48 冷处理期间：放弃挣扎也是服软信号 → 计一次服软，但不触发回应（冷处理状态机自己决定破冰）
    if (config.angerEnabled && punishment.isColdTreating()) {
      const verdict = punishment.noteColdRound(""); // 空内容：只计轮次+让状态机评估，正则不会命中
      console.log(`[punish] cold treatment: giveup counted as soften-ish (${verdict})`);
      if (verdict === "break") {
        const summary = punishment.takeLastColdSummary();
        if (summary) {
          recentChat.push(`[冷处理结束] ${summary}现在你决定开口了。`);
          if (recentChat.length > MAX_RECENT) recentChat.shift();
        }
        await respond(true);
      }
      return;
    }
    await respond(true);
    return;
  }

  // 语义澄清（#19-D）：对"口塞触碰手"这类易被 LLM 误读成"接吻"的动作，追加客观事实说明
  const clarify = clarifyActivity(event.activityKey, isOnBot);
  // "self 动作"：服务对象对自己做的（如点头/摇头/嘟囔/摸自己/摇晃身体）。
  //   关键：BC 协议 ChatSelf-* 类的 Activity 消息**并非 targetNo=null**，Dictionary 里的
  //   TargetCharacter 字段是发送者自己（服务对象#123456 做给自己 = targetNo 也是 123456）。
  //   之前的实现把 targetNo===null 当 self 标志，永远不命中，所以 isSelfAct 一直是 false。
  //   正确判断：targetNo===null（理论上极少数无目标场景）或 targetNo===sourceNo（目标是自己）。
  //   频率控制交给 respond() 内部 1.5s 冷却，服务对象 连发 3 个 ChatSelf 也只会产生 1 条 LLM 响应。
  const isSelfAct =
    isServe && (event.targetNo === null || event.targetNo === event.sourceNo);
  const line = isServe
    ? `[动作] ${event.text}${clarify}`
    : `[不重要][动作] ${event.text}${clarify}`;
  recentChat.push(line);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[activity] ${event.text}`);
  // 诊断日志：用户报 16:40/16:42 修复后仍无反应，已查清 targetNo 实际是发送者自己，详见 isSelfAct 注释
  console.log(
    `[activity-diag] isServe=${isServe} isOnBot=${isOnBot} targetNo=${event.targetNo} ` +
      `sourceNo=${event.sourceNo} isSelfAct=${isSelfAct}`
  );

  // 服务对象对 BOT 的动作 或 服务对象对自己做的动作（self 表达）= 必响应
  if (isServe && (isOnBot || isSelfAct)) {
    await respond(true);
  }
};

// ---------------------------------------------------------------------------
// #45：道具操作公告感知（Type=Action 的 ActionUse/Remove/AddLock/Unlock/Tighten/Loosen）。
// 与 onItemChange（ChatRoomSyncItem 最终状态）互补：公告携带明确的"操作者→目标"语义。
// 三个核心场景：
//   1. 别人动了服务对象的束缚（解锁/脱下尤其严重 = 防他人作弊）→ [警报] 必反应
//   2. 服务对象自己松绳子/脱道具 = 对抗管束 → [叛逆] 反应；自己穿/上锁/解自己的锁 = 背景
//   3. 任何人（含服务对象）动 BOT 自己身上的道具/锁 → [束缚] 必反应
// 同一次操作公告与 sync item 先后到达，用 recentItemActions 短窗口去重（见 onItemChange）。
client.onItemAction = async (event) => {
  const botNo = client.player.MemberNumber ?? -1;
  const serveNo = serveMemberNumber();
  // 目标是 BOT 自己时渲染成"你"，与 [束缚] 行 SELF-BONDAGE 规则的"在你的...上"句式对齐
  const text = renderItemActionText(event, (no) => (no === botNo ? "你" : client.nameOf(no)));
  if (!text) return;
  // 双保险：自己的公告回声（client 层已过滤 sender==self，这里再挡一层防回归）
  if (event.sourceNo === botNo) return;

  // 登记去重窗口（onItemChange ②/③ 用同 key 检查并跳过，避免同一次操作记两行）
  const dedupKey = `${event.targetNo}:${event.group ?? "?"}:${event.itemName ?? ""}`;
  recentItemActions.set(dedupKey, Date.now());
  // 脱下/解锁脱下类：sync item 到达时槽位已空（name=null），额外登记空名 key 挡住 ③ 的"滑脱"行
  if (event.kind === "remove" || event.kind === "unlock-remove") {
    recentItemActions.set(`${event.targetNo}:${event.group ?? "?"}:`, Date.now());
  }
  // 防泄漏：清掉过期项
  if (recentItemActions.size > 64) {
    const cutoff = Date.now() - 5000;
    for (const [k, ts] of recentItemActions) if (ts < cutoff) recentItemActions.delete(k);
  }

  const sourceIsServe = serveNo !== null && event.sourceNo === serveNo;
  const targetIsServe = serveNo !== null && event.targetNo === serveNo;
  const targetIsBot = event.targetNo === botNo;

  let line: string;
  let shouldReact = false;
  if (targetIsBot) {
    // 有人动了 BOT 自己身上的道具/锁——必须感知（主体是"我"视角）
    line = `[束缚] ${text}`;
    shouldReact = true;
  } else if (targetIsServe) {
    if (sourceIsServe) {
      // 她自己动自己身上的东西
      if (event.kind === "remove" || event.kind === "unlock-remove" || event.kind === "loosen") {
        // 自己脱下束缚/松开绳子 = 对抗管束的叛逆行为（与 onItemChange ③ 滑脱=叛逆 同口径）
        line = `[叛逆] ${text}`;
        shouldReact = true;
        // #67（2026-09-06 01:23 用户截图反馈）：脱下束缚 ≠ 挣扎，必须算"回应了 BOT 提问"。
        //   挣扎（Activity）不算回应是旧注释的语义；脱下是明确决定，"我不要这个了"等同文字回答，
        //   不清 pendingQuestion 会让 30 秒问话被无视定时器照常触发新一轮 respond（gen+1），
        //   撞车覆盖掉本次脱绳响应（实测：服务对象 脱牵引绳事件被 debounce 跳过，BOT 表现像没看见）。
        //   行为与 onChat noteServeChat() 同步——但只清计时/更新 lastServeChatAt，不重复计怒气
        //   （onChat 里手动 relieveAnger(10) 是文字专用，动作回应不该用文字降怒节奏）。
        if (config.angerEnabled) anger.noteServeChat();
        // #67 状态同步（01:26 用户截图第二轮反馈）：她脱下 CollarLeash 不走 onLeashSignal "removed"
        //   路径（那是"放弃被牵按钮"专用），leashHeld Set 不清 → ctx 里 serveLeashStatus 仍写
        //   "you are currently HOLDING..." 但实际绳子已脱，LLM 看到矛盾场景选了 none 沉默。
        //   这里提前清掉状态，让后续 respond 构建的 ctx 看到一致的"她没戴牵绳"事实。
        if (
          event.itemName === "CollarLeash" &&
          event.targetNo !== null &&
          leashHeld.has(event.targetNo)
        ) {
          leashHeld.delete(event.targetNo);
          const who = event.sourceNo !== null ? client.nameOf(event.sourceNo) : "她";
          noteLeashEvent(`[牵引] ${who}从身上脱下了牵引绳（挣脱你）`);
        }
      } else if (event.kind === "unlock") {
        // 自己解自己的锁——她只能解开非主人锁（BOT 上的主人锁无权解），属正常行为
        line = `[背景][束缚] ${text}`;
        shouldReact = false;
        // #68（09-06 01:31 实测）：她对束缚的任何主动操作都是"用动作回应"，
        //   与 #67 脱下同口径——清问话被无视计时器，不重复计怒气
        if (config.angerEnabled) anger.noteServeChat();
      } else {
        // 自己穿道具/上锁/收紧——她自己的决定，不接管（与 onItemChange ② 政策一致）
        line = `[背景][束缚] ${text}（这是她自己的行为，你不必接手做什么）`;
        shouldReact = false;
        // #68（09-06 01:31 实测事故）：BOT 问"想让我动手，还是自己乖乖把牵引绳递到我手里？"，
        //   她直接把牵引绳戴回去了（add 路径）——这明明是标准答案，但 pendingQuestion 没清，
        //   30 秒计时器照样判"问话被无视"怒气 +20（误报）。戴上/上锁/收紧与脱下同口径：
        //   明确决定 = 回应了 BOT，必须清计时器（Activity 挣扎除外，那不算）。
        if (config.angerEnabled) anger.noteServeChat();
      }
    } else {
      // 别人动了服务对象的束缚！Dom 必须注意到：
      //  - unlock/remove/unlock-remove = 解除你设下的管束（#21"防他人作弊"核心场景）
      //  - use/lock/tighten/loosen = 干预她的束缚状态，同样该有 Dom 的表态
      const isTamper = event.kind === "unlock" || event.kind === "remove" || event.kind === "unlock-remove";
      line = isTamper
        ? `[警报] ${text}——有人动了你服务对象的束缚！`
        : `[束缚] ${text}`;
      shouldReact = true;
    }
  } else {
    line = `[不重要] ${text}`;
    shouldReact = false;
  }
  recentChat.push(line);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[item-action] ${text}`);
  if (shouldReact) await respond(true);
};

// 身上道具发生变更（滑脱/自行脱下/别人穿脱/玩具调节）→
// ① 玩具/亲密部位变化 = [玩具] 感知事件（#14）
// ②③ 束缚道具变化/槽位变空 = 延迟 250ms 后走 processBondageSlotChange（配合 #45 公告去重）
client.onItemChange = async (event) => {
  const serveNo = serveMemberNumber();

  // BOT 自己刚执行过的操作（8 秒内的回执）不算服务对象的行为
  const key = `${event.targetNo}:${event.group}:${event.name ?? ""}`;
  const ownTs = ownItemOps.get(key);
  if (ownTs !== undefined && Date.now() - ownTs < 8000) return;

  // ---- ① 玩具/亲密部位变化感知（#14）----
  if (serveNo !== null && event.targetNo === serveNo && handleToyChange(serveNo, event.group)) {
    // 节流触发反应：连续调档只反应一次（6 秒去抖，与挣扎同思路）
    const now = Date.now();
    if (now - lastToyReactAt >= 6000) {
      lastToyReactAt = now;
      await respond(true);
    }
    return;
  }

  // ---- ②③ 束缚道具变化感知（#17 收尾 + #45 去重改造）----
  //   官方客户端的同一操作会先发道具更新（ChatRoomCharacterItemUpdate → 本回调），
  //   再发 Action 公告（→ onItemAction），即 sync 事件先到、公告后到（间隔毫秒级）。
  //   公告携带"谁对谁做了什么"语义更完整，所以这里把 ②③ 的处理延迟 250ms：
  //   公告先到达并登记去重 key，已覆盖的操作不再重复记行；
  //   无公告的变化（挣扎滑脱 / BCX 直改等）延迟后照常走原逻辑。
  const dedupKey = `${event.targetNo}:${event.group}:${event.name ?? ""}`;
  setTimeout(() => {
    const annTs = recentItemActions.get(dedupKey);
    if (annTs !== undefined && Date.now() - annTs < 4000) return;
    void processBondageSlotChange(event);
  }, 250);
};

client.onBeep = async (event) => {
  // 收到好友 Beep（#16 认输机制——服务对象 在等待期发 Beep = 主动认输）
  // 服务器转发前置：发送方在 BOT 好友列表 / 有所有权 / BeepType=Leash
  const serveNo = serveMemberNumber();
  const isServe = serveNo !== null && event.sourceNo === serveNo;
  if (!isServe) return; // 只接服务对象的 Beep（认输信号专属于她）
  console.log(
    `[beep] 服务对象 Beep 抵达：#${event.sourceNo} ${event.senderName} type=${event.beepType ?? "normal"} msg="${event.message ?? ""}"`
  );

  // ---- #16 认输判定：等待期收到服务对象 Beep = 主动认输（代码层确定性执行） ----
  // 只在 gohome 进行中 + 等待期已计时 + 编排器不在跑时触发；收场动作复用超时三分支（reason=surrender）
  if (game.active && game.currentRule?.id === "gohome") {
    const saved = loadGohomeState();
    if (
      saved &&
      saved.phase === "waiting" &&
      saved.deadlineAt > 0 &&
      !saved.orchestrating &&
      !gohomeOrchestrating
    ) {
      console.log("[gohome] 等待期收到服务对象 Beep → 判定主动认输，触发收场");
      recentChat.push(
        `[好友 Beep] ${event.senderName} 在限时回家等待期发来 Beep 认输${event.message ? `，留言：${event.message}` : ""}。`
      );
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      game.abort("gohome-surrender");
      await gohomeHandleTimeout("surrender");
      return;
    }
  }

  // 非游戏场景：把 beep 事件记到 recentChat，LLM 知道她私聊了什么
  recentChat.push(
    `[好友 Beep] ${event.senderName} 发了${event.beepType ? ` ${event.beepType} 类型` : ""}的 Beep${event.message ? `，留言：${event.message}` : ""}${event.roomName ? `，她当前在房间「${event.roomName}」` : "，她当前不在任何房间"}`
  );
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  // #77 Beep 召唤响应（2026-09-06 19:59 实测：她 Beep"主人可以过来嘛"BOT 毫无反应——
  //   Beep 只记 recentChat 的话，要等她下次进房说话才被 LLM 看到，她在异地召唤时 BOT 就是聋的）。
  //   她不在房时 Beep 是唯一通道：立即触发 respond，LLM 从 Beep 行读到房名即可 room_move 过去找她。
  if (!client.getCharacter(serveNo)) {
    console.log("[beep] 她不在房，Beep 即时唤醒 LLM 决策");
    await respond(true);
  }
};

/**
 * #17 的原 ②（束缚道具变化）③（槽位变空=滑脱/脱下）逻辑，#45 起由 onItemChange
 * 延迟 250ms 调用（给同时发出的 Action 公告一个登记去重 key 的机会，避免同一次操作记两行）。
 */
async function processBondageSlotChange(event: ItemChangeEvent): Promise<void> {
  const serveNo = serveMemberNumber();
  const selfNo = client.player.MemberNumber ?? -1;
  const senderNo = event.senderNo;
  const actorName =
    senderNo === undefined
      ? "有人"
      : senderNo === selfNo
      ? "我"
      : client.nameOf(senderNo);

  // ---- 过滤：属性级变化（道具还在身上，只是状态变了）----
  //   BC 服务器在多种情况下都会下发 ChatRoomSyncItem，prevName === name 时一律不是"穿戴"：
  //   ① 玩家挣扎开始/失败：服务器重发 sync item 让所有客户端刷新视觉效果（服务对象 挣扎脚铐时 prev=LeatherAnkleCuffs, new=LeatherAnkleCuffs）——2026-09-04 17:30 用户截图反馈
  //   ② 上锁/解锁/变体切换/Property 变化
  //   ③ 难度调节
  //   这些场景已被 onItemAction 公告（带 SourceCharacter/TargetCharacter 信息）覆盖，本分支跳过即可。
  //   "真穿戴" = prevName === null && name !== null；
  //   "真脱下/滑脱" = prevName !== null && name === null。
  if (event.name === event.prevName) {
    return;
  }

  // ---- ② 束缚道具（口塞/眼罩/耳塞/项圈/手铐等）变化感知（#17 收尾）----
  //    玩具/亲密部位已走①；这里处理"非玩具 + 有道具名"——重点是遮蔽感官/限制身体那一类。
  //    现在按"目标是谁"分类记录到 recentChat 并触发 respond（不节流，因为是离散事件）。
  //    prevName 已在上方过滤：走到这里的一定是 prevName===null && name!==null（真穿戴）
  //    或者 prevName!==null && name===null（真脱下，走 ③）。
  if (event.name !== null) {
    const targetName = client.nameOf(event.targetNo);
    const slotCN = zoneCN(event.group);
    const itemCN = itemNameCN(event.group, event.name) || event.name;
    const isServeTarget = serveNo !== null && event.targetNo === serveNo;
    const isSelfTarget = event.targetNo === selfNo;

    let line: string;
    let shouldReact = false;
    if (isSelfTarget) {
      // BOT 自己被戴上遮蔽/束缚道具——重要自我状态变化
      //   主体方向明确："服务对象 在我（ljzsbot）的颈缚上用了牵引绳"，避免 LLM 套用反向模板
      line = `[束缚] ${actorName}在你的${slotCN}上使用了${itemCN}。`;
      shouldReact = true;
    } else if (isServeTarget) {
      // 服务对象 自己给自己戴上遮蔽/束缚道具——不是 BOT 的动作，不接管
      //   主体方向明确："服务对象 在自己的颈部上用了项圈"，避免 LLM 套"我帮她戴"的反向模板
      //   关键：这是她自己的决定，BOT 不该自动接管帮她调紧/换变体。
      //   刷屏修复（2026-09-04 实测暴露）：她一口气连穿 6 件时 BOT 每件都评论一条，
      //   话痨刷屏。现在 20 秒去抖——连续穿戴只评论第一件（行照记进上下文，LLM 后续轮次仍能看到）。
      const SELF_DRESS_REACT_INTERVAL = 20_000;
      if (Date.now() - lastSelfDressReactAt > SELF_DRESS_REACT_INTERVAL) {
        lastSelfDressReactAt = Date.now();
        shouldReact = true;
      }
      line = `[背景][束缚] ${actorName}在自己的${slotCN}上使用了${itemCN}（这是她自己的行为，你不必接手做什么）。`;
    } else {
      // 其他人给自己戴/取下，不属于一对一关注
      line = `[不重要] ${actorName}在${client.nameOf(event.targetNo)}的${slotCN}上使用了${itemCN}。`;
      shouldReact = false;
    }
    recentChat.push(line);
    if (recentChat.length > MAX_RECENT) recentChat.shift();
    console.log(`[bondage] ${line}`);
    // 修复（2026-09-04）：之前无条件 respond(shouldReact)——respond 的参数是 speakerIsServe
    // 而非"要不要回应"，[背景]/[不重要] 行照样触发 LLM 评论。现在只在 shouldReact 时触发。
    if (shouldReact) await respond(true);
    return;
  }

  // ---- ③ 束缚槽位变空（滑脱成功或擅自脱下）----
  //   主动脱下走 ActionRemove 公告（onItemAction 已在延迟窗口内去重掉本分支），
  //   走到这里的槽位变空基本都是挣扎滑脱或客户端直改。
  const serveName = serveNo !== null ? client.nameOf(serveNo) : "服务对象";
  const isServeTarget = serveNo !== null && event.targetNo === serveNo;
  const isSelfTarget = event.targetNo === selfNo;
  let slipLine: string;
  if (isSelfTarget) {
    slipLine = `[束缚] 我身上的 ${zoneCN(event.group)} 道具脱落了（可能是被脱下或被解开）。`;
  } else if (isServeTarget) {
    slipLine = `[叛逆] ${serveName}挣脱了身上的束缚！（${zoneCN(event.group)}上的道具脱落了）`;
  } else {
    slipLine = `[不重要] ${client.nameOf(event.targetNo)}身上的 ${zoneCN(event.group)} 道具脱落了。`;
  }
  recentChat.push(slipLine);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[escape] ${event.targetNo} ${event.group} -> slipped off`);
  await respond(isServeTarget || isSelfTarget);
}

/**
 * 统一的 LLM 触发入口（防抖版，2026-09-04 19:34）
 * - 新事件来时取消上一轮 pending 计划 + 把已经在跑的旧 respond 标记为 abort
 * - 等 RESPOND_DEBOUNCE_MS 静默后再起跑最终那一轮，LLM 永远基于最新 recentChat 决策
 * - 调用方原本是 `await respond(true)` 或 `void respond(true)`，行为兼容
 */
async function respond(speakerIsServe: boolean): Promise<void> {
  if (!llmEnabled()) {
    console.log("[dry-run] addressed, but no LLM_API_KEY set.");
    return;
  }

  pendingIsServe = speakerIsServe;
  // 每次 respond() 都让全局 generation +1——让旧 runRespond（无论是不是 LLM 等响应中）自动变为过期。
  //   这是 v2 防抖的关键：不在 schedule 时 cancel，已经飞出去的 LLM 由 generation 过期自然 abort。
  respondGeneration += 1;
  console.log(`[respond] called isServe=${speakerIsServe} gen=${respondGeneration}`);

  // 取消还在排队没起跑的上一轮（timer 已 null 时不会进这个分支——这是正常情况，由 generation 覆盖兜住）
  if (pendingRespondTimer !== null) {
    clearTimeout(pendingRespondTimer);
    console.log(`[debounce] cancel pending, gen=${respondGeneration}`);
  }

  pendingRespondTimer = setTimeout(() => {
    pendingRespondTimer = null;
    void runRespond(pendingIsServe);
  }, RESPOND_DEBOUNCE_MS);
}

/** 构建 LLM 决策上下文（#63 起 runRespond 与主动模式 tick 共用）。
 *  proactive=true 时为主动感知 tick：没有发言者、narrationOnly 恒为 false、refusalStreak 恒为 0。
 *  serveHasLowerToy 一并带出（runRespond 后半段撒谎 text 兜底要用）。 */
function buildBrainContext(
  speakerIsServe: boolean,
  proactive: boolean
): { ctx: BrainContext; serveHasLowerToy: boolean } {
  // 游戏结算收尾（narration-only）等场景：ctx.narrationOnly=true 时 LLM 仅允许输出 say/emote，
  // 其它动作会在 executeIntent 里被静默丢弃。这里传给下游用。
  const narrationOnly = !proactive && game.active === false && lastGameJustEnded;

  // BOT 自身穿着/能力摘要（#19-C）：让 LLM 知道"我"自己现在的嘴/手/身体状态，避免编造自相矛盾的动作
  const selfNo = client.player.MemberNumber ?? -1;
  const selfAppearance = summarizeAppearance(client.getAppearance(selfNo));
  const selfAbilities = summarizeAbilities(client.getAppearance(selfNo));
  // #54 手持道具：读 BOT 缓存里 ItemHandheld 槽的当前道具（中文名；空=徒手）
  const selfHeldEntry = (client.getAppearance(selfNo) ?? []).find(
    (e) => (e as { Group?: string })?.Group === "ItemHandheld"
  ) as { Name?: string } | undefined;
  const selfHandheld = selfHeldEntry?.Name ? handheldCN(selfHeldEntry.Name) : "徒手";

  // 服务对象穿着摘要（含束缚道具），让 LLM 知道对方身上现在有什么
  let serveAppearance = "";
  let serveAbilities = "";
  let serveOwnedByBot = false;
  let serveLeashStatus = "";
  let serveLeaveStatus = "";
  let serveHasLowerToy = false; // 谎言兜底用：她是否真戴着下身玩具
  let serveHasRestraint = false; // 惩罚菜单用：她身上是否有束缚道具（没有则收紧/上锁无意义，菜单切换为"先戴道具"）
  const serveNo = serveMemberNumber();
  if (serveNo !== null) {
    const serveApp = client.getAppearance(serveNo);
    serveAppearance = summarizeAppearance(serveApp);
    serveAbilities = summarizeAbilities(serveApp);
    serveHasLowerToy = hasItemInGroups(serveApp, LOWER_TOY_GROUPS);
    serveHasRestraint = hasRestraintItem(serveApp);
    // 离开房间判定（#23, 2026-09-03）：基于 BC 的 ChatRoomCanLeave() + Player.CanWalk() 计算，
    // 避免 LLM 凭"项圈/绳子"字样脑补"Tethered"。
    // ⚠️ 必须包含 BOT 自己牵着她的情况（leashHeld），否则 Bot 抓着 服务对象 的绳子
    // 但 leave status 却显示"可自由离开"——实测 2026-09-03 23:43 暴露这个 bug。
    serveLeaveStatus = summarizeLeaveStatus(serveApp, leashHeld.has(serveNo) || serveLeashedBy !== null);
    // 所有权状态（主人锁权限依据）：服务对象资料里 Ownership.MemberNumber 是否 = BOT 注册号
    const serveChar = client.getCharacter(serveNo);
    serveOwnedByBot = serveChar?.Ownership?.MemberNumber === (client.player.MemberNumber ?? -1);
    // 牵引状态（#19）：BOT 是否牵着她的皮带 / 她的皮带是否被别人牵着
    if (leashHeld.has(serveNo)) {
      serveLeashStatus =
        "you are currently HOLDING your serve target's leash — they cannot leave the room while you hold it, " +
        "and you can lead them around with lead_move (direction \"away\" pulls the leash taut and drags them).";
    } else if (serveLeashedBy !== null) {
      serveLeashStatus = `your serve target's leash is currently held by ${client.nameOf(serveLeashedBy)} — another player is leading them.`;
    } else {
      const effects = collectEffects(serveApp);
      serveLeashStatus = effects.has("Leash")
        ? "your serve target is WEARING a leash but nobody is holding it — emit leash_hold to pick it up."
        : "your serve target is NOT collared/leashed yet. Leashing follows a strict 3-step order: ① item_put a collar (PetCollar) on her neck → ② item_put a leash (CollarLeash) on her neck-restraints slot → ③ leash_hold. Never pretend to grab a leash that is not attached.";
    }
  }

  // 一次性诊断：让 LLM 看到的"服务对象能力摘要"和穿着摘要打出来，
  // 排查"LLM 忽视 serveAbilities 还是数据有问题"（2026-09-04 17:56 用户截图反馈）
  console.log(`[ctx-diag] serveAppearance=${serveAppearance.slice(0, 80)} | serveAbilities=${serveAbilities} | mood=${anger.getMood().level}`);

  // 撒谎抓包必罚窗口状态（供下方 punishMenu 注入用，详见变量声明处注释）
  const moodLevel = config.angerEnabled ? anger.getMood().level : "平静";
  const liePunishPending =
    config.angerEnabled && !testMode && Date.now() - lieCaughtAt < LIE_PUNISH_WINDOW_MS;
  let menuLevel = moodLevel;
  if (liePunishPending && menuLevel === "平静") menuLevel = "微恼";

  return {
    ctx: {
      botName: botName(),
      roomName: config.roomName ?? "",
      members: client.getMemberNames(),
      recentChat: [...recentChat],
      addressed: !proactive,
      serveName: config.serveMember ?? "",
      speakerIsServe,
      refusalStreak: testMode ? 0 : speakerIsServe && !proactive ? consecutiveRefusal : 0,
    serveAppearance,
    serveAbilities,
    serveOwnedByBot,
    serveLeashStatus,
    serveLeaveStatus,
    selfAppearance,
    selfAbilities,
    selfHandheld,
    testMode,
    nsfwLevel,
    memories: memory.getAll(),
    gameState: game.describeState(),
    narrationOnly,
    // #46 怒气情绪：只注入离散标签 + 原因，绝不注入数值（LLM 不会算数，给了数字会自圆其说乱报）
    botMood: config.angerEnabled ? anger.getMood().level : "平静",
    moodReason: config.angerEnabled ? anger.getMood().reason : "",
    // #49 承诺队列：过滤过期项后注入（15 分钟内她说过的承诺原话）
    servePromiseLog:
      config.angerEnabled
        ? servePromises.filter((p) => Date.now() - p.at < PROMISE_TTL_MS).map((p) => p.text)
        : [],
    // #48 惩罚菜单：按当前档位注入（平静档注入空串=不注入，微恼及以上才给菜单）。
    //   2026-09-04 21:40：传 serveHasRestraint——她身上没束缚时菜单切换为"先戴道具"（收紧/上锁无从执行）
    //   撒谎抓包必罚窗口（23:20）：窗口内强制注入——平静档按微恼菜单，附注覆盖
    //   prompt 里"Never punish when 平静"规则；道歉不免罚（道歉只缓和语气）。
    punishMenu:
      config.angerEnabled && !testMode && (menuLevel !== "平静" || liePunishPending)
        ? punishment.punishMenuFor(menuLevel, serveHasRestraint) +
          (liePunishPending
            ? "（重要：她刚才对你撒谎并被你当场抓包——道歉可以缓和你的语气，但骗过主人这件事不能就这么算了：这一轮必须执行一项实质惩罚，不许只口头说教）"
            : "")
        : "",
    // #48 冷处理状态（冷处理中理论上不会调 LLM；此字段主要防御性注入）
    coldStatus: config.angerEnabled ? punishment.coldDescription() : "",
    // #47 亲密度：只注入离散标签 + 原因（绝不注入数值，与怒气同哲学）
    //   奖励菜单：熟络及以上、非暴怒档（气头上不宠）、非测试模式才注入
    ...(config.intimacyEnabled
      ? (() => {
          const aff = intimacy.getAffection();
          return {
            botAffection: aff.level,
            affectionReason: aff.reason,
            rewardMenu:
              !testMode && aff.level !== "生疏" && anger.getMood().level !== "暴怒"
                ? intimacy.rewardMenuFor(aff.level, anger.getMood().level)
                : "",
          };
        })()
      : {}),
    // #63 主动模式标记
    proactive,
    // #64 扩散（社交）模式标记：房内全员都是对话对象（prompt 切换路人人设）
    socialMode: socialActive(),
    },
    serveHasLowerToy,
  };
}

/** 实际跑 LLM 的私有函数（原 respond 主体），由 respond() 防抖后调用 */
async function runRespond(speakerIsServe: boolean): Promise<void> {
  // 记下自己这一轮的 generation 号，runRespond 末尾与全局核对，过期就 skip emit
  const myGen = respondGeneration;
  const now = Date.now();
  if (now - lastResponseAt < config.responseCooldownMs) {
    console.log(`[runRespond] gen=${myGen} cooldown, skip`);
    return;
  }
  lastResponseAt = now;

  // #48 冷处理：冷处理期间 BOT 真沉默——不调 LLM、不发言（她的话已进 recentChat，
  // 破冰后 LLM 能看到冷处理期间她说的一切）。安全词在 onChat 早期就拦截了（会强制结束冷处理）。
  if (config.angerEnabled && punishment.isColdTreating()) {
    if (speakerIsServe) {
      const verdict = punishment.noteColdRound(lastServeMessage ?? "");
      console.log(`[punish] cold treatment suppressing response (${verdict})`);
      if (verdict === "break") {
        // 破冰：记一行摘要进 recentChat（LLM 破冰第一句话的上下文依据），继续走正常 respond
        const summary = punishment.takeLastColdSummary();
        if (summary) {
          recentChat.push(`[冷处理结束] ${summary}现在你决定开口了。`);
          if (recentChat.length > MAX_RECENT) recentChat.shift();
        }
        console.log(`[punish] cold treatment broken — letting Dom speak`);
      } else {
        return; // 继续冷：这一轮彻底沉默
      }
    }
  }

  // #63 起 ctx 构建抽为公共函数 buildBrainContext（与主动模式 tick 共用）
  const { ctx, serveHasLowerToy } = buildBrainContext(speakerIsServe, false);
  const narrationOnly = ctx.narrationOnly === true;

  try {
    // #73 动作队列：单动作（绝大多数）或最多 3 个有序动作（换装/惩罚仪式等）
    let intents = await generateIntents(ctx);
    // 2026-09-08 03:41：服务对象直接说话却被 LLM 判 none——系统提示明文规定"对直接对话
    //   沉默几乎总是错"，多为模型抽风（gen 7/8/9 三连静默实锤）。重试一次拉回；
    //   仍空则保持沉默（原始内容已在 brain 侧打日志可查）。
    if (!intents.length && speakerIsServe) {
      console.log("[respond] serve speech parsed to 0 intents, retrying once...");
      intents = await generateIntents(ctx);
      if (!intents.length) {
        console.log("[respond] still 0 intents after retry, staying silent");
        return;
      }
    }
    if (!intents.length) return;
    const intent = intents[0]; // serve_* flag 挂在第一个动作上（parseIntents 保证）
    // #46/#49 情绪语义汇报处理（先记账再执行，保证本次语气已反映最新怒气变化会留到下一轮）：
    //   serve_ignored = 回应了但明显无视/岔开 BOT 上一句 → +10；
    //   serve_complied = 服软/道歉/执行命令 → -20（立刻回落，让下一次回应能感知到"她哄好了你"）
    //   #49：serve_pestering = 纠缠已拒绝的事（阶梯 +8/+12/+18）；serve_threatening = 要挟式（额外 +10）；
    //   serve_lied = 撒谎被抓包（+15）；serve_promised = 答应了命令（入承诺队列）；
    //   serve_broke_promise = 违背承诺（+15，清队列）
    if (config.angerEnabled && speakerIsServe) {
      if (intent.serveIgnored) anger.noteServeDeflected();
      if (intent.serveComplied) anger.noteServeComplied();
      if (intent.servePestering) {
        anger.noteServePestering(intent.serveThreatening === true);
        // 已通过 LLM 通道收费的话也标记"已处理"，防后续 respond（如无视触发）对同一句话兜底重数
        lastPesterCountedMsg = lastServeMessage;
      } else if (intent.serveThreatening) {
        anger.noteServePestering(true); // 只标了要挟没标纠缠，也按纠缠处理
        lastPesterCountedMsg = lastServeMessage;
      } else if (
        lastServeMessage &&
        lastServeMessage !== lastPesterCountedMsg &&
        PESTER_REQUEST_RE.test(lastServeMessage) &&
        !BEG_WORD_RE.test(lastServeMessage)
      ) {
        // text 兜底：干巴巴重复求解（无恳求词）——LLM 常漏标，代码直接计。
        // 第 1 次只记数（对齐恳求阶梯"第 2 次要求正经求"的节奏），第 2 次起走纠缠阶梯 +10/+20/+30。
        lastPesterCountedMsg = lastServeMessage;
        const now = Date.now();
        if (now - lastDryPesterAt > 5 * 60_000) dryPesterCount = 0;
        dryPesterCount += 1;
        lastDryPesterAt = now;
        if (dryPesterCount >= 2) {
          console.log(`[pester] 干巴巴重复求解第 ${dryPesterCount} 次（via text兜底）：${lastServeMessage}`);
          anger.noteServePestering(false);
        } else {
          console.log(`[pester] 干巴巴求解第 1 次记数（第 2 次起收怒气）：${lastServeMessage}`);
        }
      }
      // #47 亲密度双向记账（与怒气同一批 LLM flag，独立落账：气消了 ≠ 心近了，两本账分开）
      if (config.intimacyEnabled) {
        if (intent.serveComplied) {
          intimacy.noteServeComplied();
          // 兑现承诺加成：她有未结算的承诺且这次照做了 → 信任 +8（不清队列——违背了照样能抓）
          if (servePromises.length && intent.servePromised !== true) {
            intimacy.notePromiseKept();
          }
        }
        if (intent.serveAffectionate) {
          intimacy.noteServeAffectionate();
          lastAffectionCountedMsg = lastServeMessage;
        } else if (
          lastServeMessage &&
          lastServeMessage !== lastAffectionCountedMsg &&
          AFFECTIONATE_RE.test(lastServeMessage)
        ) {
          // text 兜底：明显撒娇话术 LLM 漏报（实测 22:58"主人抱抱"）——代码直接计
          console.log(`[intimacy] 撒娇兜底（via text）：${lastServeMessage}`);
          intimacy.noteServeAffectionate();
          lastAffectionCountedMsg = lastServeMessage;
        }
        // 2026-09-04 22:40 用户拍板：要挟/纠缠只记怒气账，不动感情账（只有撒谎/违约伤信任）
        if (intent.serveLied) intimacy.noteServeLied();
        if (intent.serveBrokePromise) intimacy.noteBrokePromise();
      }
      if (intent.serveLied) {
        anger.noteServeLied();
        lastLiedChargedMsg = lastServeMessage; // LLM 已收费，防后续 respond 对同句话兜底重计
        lieCaughtAt = Date.now(); // 抓包必罚窗口开启（道歉不免罚）
      } else if (
        lastServeMessage &&
        lastServeMessage !== lastLiedChargedMsg &&
        TOY_CLAIM_RE.test(lastServeMessage) &&
        !serveHasLowerToy
      ) {
        // text 兜底：她声称下身玩具刺激，但装备核实她根本没戴——LLM 常偷懒不查就顺着编
        lastLiedChargedMsg = lastServeMessage;
        console.log(`[lied] 声称下身玩具刺激但身上没戴（via text兜底）：${lastServeMessage}`);
        anger.noteServeLied();
        lieCaughtAt = Date.now(); // 抓包必罚窗口开启（道歉不免罚）
      }
      // #49 承诺队列：她答应了命令 → 存她这条原话（15 分钟有效）
      // 2026-09-04 19:20 三次实测修复：LLM 对 serve_promised 判定三次都不可靠（漏判 complied/ignored），
      // 直接以承诺句式正则为准——文本命中 PROMISE_TEXT_RE 就入队，不再依赖 LLM flag。
      const enqueuePromise = (via: string) => {
        if (!lastServeMessage) return;
        // 防重复：同一条原话已在队尾时不重复入队（事件触发的 respond 可能对同一条承诺重复判定）
        const lastQueued = servePromises[servePromises.length - 1];
        if (lastQueued?.text === lastServeMessage) return;
        const now = Date.now();
        servePromises.push({ text: lastServeMessage, at: now });
        while (servePromises.length > PROMISE_MAX) servePromises.shift();
        console.log(`[promise] 她答应了：${lastServeMessage}（已记入承诺队列，via ${via}）`);
      };
      // 文本层兜底：只要她最后一句话命中承诺句式，就入队。LLM flag 完全不再参与这个判断。
      if (PROMISE_TEXT_RE.test(lastServeMessage)) enqueuePromise("text兜底");
      // #49 阳奉阴违：违背了承诺 → 清队列（违背的通常就是最近一条，避免重复计费）
      if (intent.serveBrokePromise) {
        anger.noteServeBrokePromise();
        if (servePromises.length) {
          console.log(`[promise] 她违背了承诺：${servePromises.map((p) => p.text).join(" / ")}`);
          servePromises.length = 0;
        }
      }
    }
    // 2026-09-04 19:52 防抖 v2：LLM 结果回来了，但这一轮 generation 已经落后（被新事件覆盖），
    //   说明意图基于陈旧上下文，跳过不发送——下一轮基于更新 recentChat 的 runRespond 会接上。
    if (myGen !== respondGeneration) {
      console.log(`[debounce] gen ${myGen} stale (current=${respondGeneration}), skip emit`);
      return;
    }

    // narration-only 收尾模式：只允许 say / emote 通过；其他动作一律丢弃
    let chain = intents;
    if (narrationOnly) {
      chain = chain.filter((i) => i.action === "say" || i.action === "emote");
      if (!chain.length) {
        console.log(`[game] narration-only dropped actions: ${intents.map((i) => i.action).join(",")}`);
        return;
      }
    }
    // #63 开窗信号②③④（LLM 语义 + 游戏 + 情绪）：只在服务对象说话的轮次判定
    if (speakerIsServe && config.proactiveEnabled) {
      if (intent.serveAttentionSeeking) proactiveOpen("LLM 判定她求关注");
      else if (game.active === true) proactiveOpen("游戏进行中");
      else if (config.angerEnabled && ["恼火", "暴怒"].includes(anger.getMood().level))
        proactiveOpen("怒气未消（主动盯着她）");
    }
    // #64 LLM 感知开窗：她在跟其他玩家互动（聊天/动作）→ 社交扩散（10 分钟窗口，flag 每报顺延）。
    //   不限发言者——路人轮次里 LLM 也能从 recentChat 看到她在跟人互动，同样续窗。
    if (intent.serveSocializing) {
      socialAddSource("llm", "LLM 判定她在跟其他玩家互动");
    }
    // #73 动作队列执行：按序执行，步间 600ms；中途新事件进来（代际变化）即中止剩余步骤
    for (let i = 0; i < chain.length; i++) {
      if (myGen !== respondGeneration) {
        console.log(`[debounce] gen ${myGen} stale mid-chain（中止第 ${i + 1}/${chain.length} 步：${chain[i].action}）`);
        break;
      }
      await executeIntent(chain[i]);
      if (i < chain.length - 1) await sleep(600);
    }
  } catch (err) {
    console.error("[brain] error:", (err as Error).message);
    // 2026-09-05 20:08 卡死事故兜底：LLM 两次空响应后整个流程静默中断，她对"认输"的
    //   回应石沉大海，BOT 看起来像卡死。服务对象的话必须有下文——失败也说一句通用
    //   DOM 短台词（不承诺任何事，避免空头支票），路人不兜底（本来就该冷淡）。
    if (speakerIsServe) {
      const fallbackLines = [
        "（挑眉盯着你，没说话）",
        "嗯？再说一遍。",
        "（手指绕着你的牵引绳，慢慢收紧了半寸）",
        "……继续说，我听着。",
      ];
      const line = fallbackLines[Math.floor(Math.random() * fallbackLines.length)];
      console.log(`[respond] LLM 失败兜底台词: ${line}`);
      client.sendChat(line, "Chat");
    }
  }

  // 回复完成后：节流触发记忆提取（异步，不阻塞本次回复）
  maybeExtractMemories();
}

// ===================== #63 主动/被动模式（2026-09-06） =====================
// 被动（默认常态）= 纯事件驱动（现状不动）；主动 = 开窗信号触发一个限时窗口，
// 窗口内 BOT 定时感知 + 她进房即时触发，LLM 自主决定行动或沉默（idle）。
// 每次 tick 先过确定性门槛（不满足直接跳过，不烧 LLM）；连续无事提前关窗回落被动。
// 防坑（设计时拍板）：她跟别人聊天不插话、两次主动行动硬间隔、编排器/同意门/冷处理期间暂停。
const PROACTIVE_ATTENTION_RE =
  /无聊|好闷|好闲|陪我|陪陪我|理理我|和我说说话|说说话|逗我玩|和我玩|想你了|想你嘛|在干嘛|干嘛呢|在吗|在不在|没人理我?|好安静|冷清|好孤单|寂寞/;

const proactive = {
  windowUntil: 0, // 0 = 被动模式（关窗）
  reason: "",
  idleStreak: 0, // 连续 idle（LLM 选择沉默）次数，达阈值提前关窗
  lastSpokeAt: 0, // 上次主动行动时刻（防刷屏硬间隔基准之一）
  tickTimer: null as NodeJS.Timeout | null,
};
/** 她最近一次文字发言时刻（冷场门槛基准；onChat 更新） */
let lastServeChatAt = 0;

function proactiveIsOpen(): boolean {
  return proactive.windowUntil > Date.now();
}

/** 开主动窗口（已开着则顺延倒计时；编排器/同意门期间不叠加主动模式） */
function proactiveOpen(reason: string): void {
  if (!config.proactiveEnabled) return;
  if (gohomeOrchestrating || gohomeConsent) return;
  const wasOpen = proactiveIsOpen();
  proactive.windowUntil = Date.now() + config.proactiveWindowMin * 60_000;
  proactive.reason = reason;
  if (!wasOpen) {
    proactive.idleStreak = 0;
    console.log(
      `[proactive] 开窗（${reason}）：${config.proactiveWindowMin} 分钟内每 ${config.proactivePerceiveSec}s 感知一次`
    );
    if (proactive.tickTimer === null) {
      proactive.tickTimer = setInterval(
        () => void proactiveTick("定时感知"),
        config.proactivePerceiveSec * 1000
      );
    }
  } else {
    console.log(
      `[proactive] 窗口顺延（${reason}，剩 ${Math.round((proactive.windowUntil - Date.now()) / 60_000)} 分钟）`
    );
  }
}

function proactiveClose(reason: string): void {
  if (proactive.tickTimer !== null) {
    clearInterval(proactive.tickTimer);
    proactive.tickTimer = null;
  }
  if (proactive.windowUntil !== 0) {
    console.log(`[proactive] 关窗回落被动（${reason}）`);
  }
  proactive.windowUntil = 0;
  proactive.idleStreak = 0;
}

/** 她正跟房里别人聊天（不插话判定）：recentChat 尾部 4 条里既有她的发言又有别人的发言 */
function proactiveServeBusyWithOthers(): boolean {
  let hasServe = false;
  let hasOther = false;
  for (const l of recentChat.slice(-4)) {
    // #64 起路人消息有两种前缀：集中模式 [不重要] / 社交模式 [房客]，都算"别人在说话"
    if (/^\[(不重要|房客)\][^:\[]{2,24}: /.test(l)) {
      hasOther = true;
      continue;
    }
    if (l.startsWith("[")) continue; // 系统行/事件行（[叛逆]/[束缚]/[游戏]...）
    if (l.includes(" (me):")) continue; // BOT 自己
    if (/^[^:]{1,24}: /.test(l)) hasServe = true; // 她的发言（Name: xxx）
  }
  return hasServe && hasOther;
}

// ===================== #64 集中/扩散模式（2026-09-06） =====================
// 集中（默认常态）= 一对一：服务对象必响应，其他人被 @ 才礼貌回应（#63 之前的现状）；
// 扩散（社交模式）= 房内所有消息都过 LLM，BOT 能跟路人互动（Dom 式礼貌有距离、
// 如实承认 bot 身份、不与路人调情、束缚动作只对服务对象、重心永远在她）。
// 三路开窗（来源集合，空 = 集中模式）：
//   ① manual：服务对象口令"社交开/关"
//   ② gohome：限时回家挂牌期间自动（BOT 进热闹房接人/收场时自然社交；回家空房无消息零成本）
//   ③ llm：LLM 感知到她在跟其他玩家互动（serve_socializing flag，10 分钟窗口自动过期）
const SOCIAL_CMD_ON_RE = /社交开|开启社交|扩散开|开启扩散/;
const SOCIAL_CMD_OFF_RE = /社交关|关闭社交|扩散关|关闭扩散|回到集中|集中模式/;
const SOCIAL_LLM_WINDOW_MS = 10 * 60_000;

const socialSources = new Set<"manual" | "gohome" | "llm">();
let socialLlmUntil = 0; // llm 来源有效期（flag 每次报告顺延）

function socialActive(): boolean {
  if (socialSources.has("llm") && Date.now() > socialLlmUntil) {
    socialSources.delete("llm");
    console.log("[social] llm 感知窗口到期，移除该来源");
  }
  return socialSources.size > 0;
}

function socialAddSource(src: "manual" | "gohome" | "llm", reason: string): void {
  if (!config.socialEnabled) return;
  const was = socialActive();
  if (src === "llm") socialLlmUntil = Date.now() + SOCIAL_LLM_WINDOW_MS;
  socialSources.add(src);
  if (!was) {
    console.log(`[social] 进入扩散模式（${reason}）——房内所有消息将得到你的关注`);
  } else {
    console.log(`[social] 来源+${src}（${reason}），当前来源：${[...socialSources].join(",")}`);
  }
}

function socialRemoveSource(src: "manual" | "gohome" | "llm", reason: string): void {
  if (!socialSources.has(src)) return;
  socialSources.delete(src);
  if (socialSources.size === 0) {
    console.log(`[social] 回落集中模式（${reason}）——只关注服务对象`);
  } else {
    console.log(`[social] 来源-${src}（${reason}），剩余：${[...socialSources].join(",")}`);
  }
}

/** 主动感知 tick：确定性门槛过滤 → 全过才调 LLM 自主决策（行动或 idle） */
async function proactiveTick(trigger: string): Promise<void> {
  if (!config.proactiveEnabled) return;
  if (!proactiveIsOpen()) {
    if (proactive.windowUntil !== 0) proactiveClose("窗口到期");
    return;
  }
  const now = Date.now();
  const serveNo = serveMemberNumber();
  // 门槛 1：她在房里——人不在场，主动照看无从谈起（gohome 等待期她挂牌在外，编排器自己管）
  if (serveNo === null || client.getCharacter(serveNo) === null) {
    console.log("[proactive] tick 跳过：她不在房里");
    return;
  }
  // 门槛 2：编排器/同意门/冷处理期间不捣乱（冷处理=真沉默，主动说话会破功）
  if (gohomeOrchestrating || gohomeConsent) return;
  if (config.angerEnabled && punishment.isColdTreating()) return;
  // 门槛 3：被动响应正在排队——别抢话
  if (pendingRespondTimer !== null) return;
  // 门槛 4：她正跟别人聊天——不插话（Dom 的分寸感）
  if (proactiveServeBusyWithOthers()) {
    console.log("[proactive] tick 跳过：她正跟别人聊天");
    return;
  }
  // 门槛 5：冷场门槛——她刚说过话不久=被动链路刚接待过，不重复插话（游戏中放宽 60s：回合要推进）
  const inGame = game.active === true;
  const silenceMinMs =
    (inGame ? Math.min(60, config.proactiveSilenceMinSec) : config.proactiveSilenceMinSec) * 1000;
  if (lastServeChatAt > 0 && now - lastServeChatAt < silenceMinMs) {
    console.log(
      `[proactive] tick 跳过：冷场不足 ${Math.round((now - lastServeChatAt) / 1000)}s < ${silenceMinMs / 1000}s${inGame ? "（游戏中档）" : ""}`
    );
    return;
  }
  // 门槛 6：防刷屏硬上限——距上次主动行动或被动回复都不足最小间隔
  const lastAny = Math.max(proactive.lastSpokeAt, lastResponseAt);
  if (lastAny > 0 && now - lastAny < config.proactiveMinGapSec * 1000) {
    console.log("[proactive] tick 跳过：距上次发言间隔不足（防刷屏硬上限）");
    return;
  }

  console.log(`[proactive] tick（${trigger}）：门槛通过，调 LLM 自主决策`);
  const { ctx } = buildBrainContext(true, true);
  try {
    const intents = await generateIntents(ctx);
    if (!intents.length) {
      proactive.idleStreak += 1;
      console.log(
        `[proactive] LLM 选择沉默（idle 连续 ${proactive.idleStreak}/${config.proactiveIdleClose}）`
      );
      if (proactive.idleStreak >= config.proactiveIdleClose) {
        proactiveClose(`连续 ${proactive.idleStreak} 次无事可做`);
      }
      return;
    }
    proactive.idleStreak = 0;
    proactive.lastSpokeAt = Date.now();
    console.log(
      `[proactive] LLM 主动行动：${intents.map((i) => i.action + (i.item ? `(${i.item})` : "")).join(" → ")}${
        intents[intents.length - 1].text ? ` "${(intents[intents.length - 1].text ?? "").slice(0, 30)}"` : ""
      }`
    );
    // #73 动作队列：主动决策同样支持链式（如主动拿鞭子+拍打）
    for (let i = 0; i < intents.length; i++) {
      await executeIntent(intents[i]);
      if (i < intents.length - 1) await sleep(600);
    }
  } catch (err) {
    // 主动 tick 失败不作兜底发言（没人等回复），下一轮感知再说
    console.error("[proactive] tick LLM 失败（本轮放弃）:", (err as Error).message);
  }
}

/** 服务对象相关消息攒够一批后，让 LLM 从最近对话里提取值得长期记住的事实 */
function maybeExtractMemories(): void {
  if (!llmEnabled()) return;
  if (!config.serveMember) return;
  const now = Date.now();
  if (unprocessedServeMsgs < EXTRACT_MSG_THRESHOLD) return;
  if (now - lastExtractAt < EXTRACT_MIN_INTERVAL_MS) return;
  unprocessedServeMsgs = 0;
  lastExtractAt = now;

  const snapshot = [...recentChat];
  const serveName = config.serveMember;
  const existing = memory.getAll();
  // 异步执行，失败不影响主流程
  extractMemories({ persona: config.llm.persona, serveName, existingMemories: existing, recentChat: snapshot })
    .then((newMemories) => {
      if (newMemories.length === 0) return;
      const added = memory.add(newMemories);
      if (added > 0) {
        console.log(`[memory] +${added} entries (total ${memory.size}):`);
        for (const m of newMemories) console.log(`  [memory]   ${m}`);
      }
    })
    .catch((err) => console.error("[memory] extract error:", (err as Error).message));
}

// 注意：item_lock 分支里有 await（先切变体、隔 500ms 再上锁），所以本函数是 async。
// 调用方全部 fire-and-forget（不 await），行为与原来一致。
async function executeIntent(intent: Intent): Promise<void> {
  // #48 惩罚上下文判定（2026-09-04 22:05 重构：种类判定提前，惩罚难度提升也复用同一判定）。
  //   punishCtx = 怒气系统开启 + 非测试模式 + 目标是服务对象 + (非平静档 或 撒谎抓包必罚窗口)。
  //   2026-09-04 23:20：窗口内就算她道歉消气了，撒谎惩罚的束缚也照常拉满难度（道歉不免罚）。
  const mood = config.angerEnabled ? anger.getMood().level : "平静";
  const serveNo = serveMemberNumber();
  const targetNo0 = intent.target ? client.resolveMemberNumber(intent.target) : null;
  const isServeTarget = serveNo !== null && targetNo0 === serveNo;
  const liePunishPending = Date.now() - lieCaughtAt < LIE_PUNISH_WINDOW_MS;
  const punishCtx =
    config.angerEnabled && !testMode && isServeTarget && (mood !== "平静" || liePunishPending);

  // 惩罚动作种类（新鲜感约束 + 难度提升共用）
  let punishKind: punishment.PunishKind | null = null;
  if (punishCtx) {
    if (intent.action === "item_adjust" && intent.adjust?.startsWith("tighten")) punishKind = "tighten";
    else if (intent.action === "item_lock" && intent.lock === "TimerPadlock") punishKind = "lock-short";
    else if (intent.action === "item_lock" && intent.lock === "TimerPasswordPadlock") punishKind = "lock-long";
    else if (intent.action === "item_put" && /gag/i.test(intent.item ?? "")) punishKind = "gag";
    // 2026-09-04 21:40：非平静档给她上束缚道具本身就是惩罚（没束缚时收紧/上锁无意义，
    //   菜单已切换为"先戴道具"）——纳入新鲜感记账，防止连续戴同类道具刷屏
    else if (intent.action === "item_put" && BIND_ITEM_RE.test(intent.item ?? "")) punishKind = "bind";
    else if (intent.action === "cold_treatment") punishKind = "cold";
    // expel 只在暴怒档算惩罚（逐出话术是暴怒菜单项；平时 服务对象 请求放绳是正常操作，不该记账/被拦）
    else if (intent.action === "leash_release" && mood === "暴怒") punishKind = "expel";
  }

  // #48 惩罚库校验（代码管"能做什么"：暴怒禁止清单 + 新鲜感约束；违规降级为纯 say）
  if (punishCtx) {
    // 暴怒禁止清单：气头上不放人、不动关系（安全词/次数券在更上层处理，不受此影响）
    if (mood === "暴怒" && punishment.isFuryForbidden(intent.action, intent.lock, intent.adjust)) {
      console.log(`[punish] fury-forbidden ${intent.action}${intent.lock ? `(${intent.lock})` : ""} dropped (mood=暴怒), degrade to say`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      return;
    }

    // 新鲜感约束：惩罚类动作最近 2 次内不重复（平静档不校验——调情式收紧/配合请求不受影响）
    //
    if (punishKind) {
      if (!punishment.canPunish(punishKind)) {
        // 重复惩罚被拦：降级为纯 say（LLM 台词还在，只是动作不执行）
        console.log(`[punish] ${punishKind} blocked by freshness, degrade to say`);
        if (intent.text) {
          client.sendChat(intent.text, "Chat");
          rememberOwn(intent.text);
        }
        return;
      }
      punishment.recordPunishment(punishKind); // 预记录（防同轮多动作重复；失败场景少数，可接受）
      // 撒谎抓包必罚已落地（这一项就是"骗主人的代价"）：窗口关闭，后续轮次恢复正常
      if (liePunishPending) {
        lieCaughtAt = 0;
        console.log("[lied-punish] 撒谎惩罚已执行，抓包必罚窗口关闭");
      }
    }
  }

  // 可观测性（2026-09-04 23:40）：LLM 主动选择沉默时留痕——她喊"主人在吗？"时 BOT 无声，
  // 之前没有任何日志能区分"LLM 挂了/空响应"和"LLM 决定 none"，排查全靠猜。
  if (intent.action === "none") {
    console.log("[bot] intent: none (LLM choosing silence)");
    return;
  }

  switch (intent.action) {
    case "say":
      if (!intent.text) return;
      if (dedupe(intent.text)) return;
      client.sendChat(intent.text, "Chat");
      console.log(`[bot] say: ${intent.text}`);
      rememberOwn(intent.text);
      // #46 怒气情绪：BOT 说了问句/命令式提问 → 开始 30 秒"被无视"倒计时。
      //   一对一模式下 BOT 的发言默认主要是对服务对象说的，问句即期待她回应。
      if (config.angerEnabled && config.serveMember && anger.looksLikeQuestion(intent.text)) {
        anger.noteBotQuestion(intent.text);
      }
      break;

    case "emote": {
      if (!intent.text) return;
      // 游戏端会自动给 emote 包 *星号*，这里剥掉 LLM 可能误加的星号，避免显示成 **...
      const text = stripAsterisks(intent.text);
      if (!text) return;
      if (dedupe(text)) return;
      client.sendChat(text, "Emote");
      console.log(`[bot] emote: *${text}*`);
      rememberOwn(`*${text}*`);
      break;
    }

    case "whisper": {
      if (!intent.text || !intent.target) return;
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        console.log(`[bot] whisper target not found: "${intent.target}"`);
        return;
      }
      if (dedupe(intent.text)) return;
      client.sendWhisper(targetNo, intent.text);
      console.log(`[bot] whisper -> ${client.nameOf(targetNo)}: ${intent.text}`);
      // #46 怒气情绪：对服务对象的悄悄话里的问句同样期待回应
      const serveNo = serveMemberNumber();
      if (config.angerEnabled && serveNo !== null && targetNo === serveNo && anger.looksLikeQuestion(intent.text)) {
        anger.noteBotQuestion(intent.text);
      }
      break;
    }

    case "handheld_take": {
      // #54 拿起手持道具：self-target 单道具装备 + 整包落库（#71 教训：不落库重启就回滚）
      if (!intent.handheld) return;
      const check = checkHandheld(intent.handheld);
      if (!check.ok || !check.def) {
        console.log(`[bot] handheld_take rejected: ${check.reason}`);
        return;
      }
      const botNo = client.player.MemberNumber ?? -1;
      if (botNo < 0) return;
      // 手被绑着不能拿道具（summarizeAbilities 的双手判定——Block 效果=双手被占用）
      const selfApp = client.getAppearance(botNo);
      const abilities = summarizeAbilities(selfApp);
      if (abilities.includes("双手被占用")) {
        console.log(`[bot] handheld_take rejected: 双手被占用，无法持有道具`);
        return;
      }
      client.sendItemUpdate(botNo, "ItemHandheld", intent.handheld);
      client.updateCachedItem(botNo, "ItemHandheld", intent.handheld);
      client.sendCharacterUpdate();
      rememberOwn(`（拿起${check.def.cn}）`);
      console.log(`[bot] handheld_take: ${intent.handheld}（${check.def.cn}）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "handheld_drop": {
      // #54 放下手持道具
      const botNo = client.player.MemberNumber ?? -1;
      if (botNo < 0) return;
      const heldEntry = (client.getAppearance(botNo) ?? []).find(
        (e) => (e as { Group?: string })?.Group === "ItemHandheld"
      ) as { Name?: string } | undefined;
      if (!heldEntry?.Name) {
        console.log(`[bot] handheld_drop: 本来就徒手，跳过`);
        return;
      }
      const cn = handheldCN(heldEntry.Name);
      client.sendItemUpdate(botNo, "ItemHandheld", null);
      client.updateCachedItem(botNo, "ItemHandheld", null);
      client.sendCharacterUpdate();
      rememberOwn(`（放下${cn}）`);
      console.log(`[bot] handheld_drop: ${heldEntry.Name}（${cn}）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "activity": {
      if (!intent.activity || !intent.zone || !intent.target) return;
      // #54 道具动作分流：SpankItem 等手持动作须持有对应道具（没拿/拿错自动换）
      const isToyActivity = checkHandheldActivity(intent.activity).ok;
      if (isToyActivity) {
        const botNo = client.player.MemberNumber ?? -1;
        if (botNo < 0) return;
        const targetNo = client.resolveMemberNumber(intent.target);
        if (targetNo === null) {
          console.log(`[bot] activity target not found: "${intent.target}"`);
          return;
        }
        // 确定用哪件道具：LLM 指定的 handheld 字段 > 当前手持；校验道具 allow 包含该动作
        const heldEntry = (client.getAppearance(botNo) ?? []).find(
          (e) => (e as { Group?: string })?.Group === "ItemHandheld"
        ) as { Name?: string } | undefined;
        let item = intent.handheld ?? heldEntry?.Name ?? "";
        if (!item || !handheldAllows(item, intent.activity)) {
          // 没指定/指定的道具不支持/当前手持不支持 → 道具动作作废（不再瞎猜道具，
          // 避免惩罚时 LLM 说 SpankItem 却没说用什么——让她明确道具名）
          console.log(`[bot] toy activity rejected: 道具 "${item || "(无)"}" 不支持动作 ${intent.activity}（需手持对应道具）`);
          return;
        }
        // 手持正确但没拿（handheld 字段指定的）→ 自动拿起再动作（一步到位）
        if (heldEntry?.Name !== item) {
          client.sendItemUpdate(botNo, "ItemHandheld", item);
          client.updateCachedItem(botNo, "ItemHandheld", item);
          client.sendCharacterUpdate();
          console.log(`[bot] toy activity auto-take: ${item}（${handheldCN(item)}）`);
          await sleep(500);
        }
        client.sendActivity(intent.activity, intent.zone, targetNo, {
          activityAsset: { name: item, group: "ItemHandheld" },
        });
        console.log(`[bot] toy activity: ${intent.activity} with ${item} -> ${client.nameOf(targetNo)}@${intent.zone}`);
        rememberOwn(`（用${handheldCN(item)}对 ${client.nameOf(targetNo)} 的${zoneCN(intent.zone)}执行 ${intent.activity}）`);
        if (intent.text) {
          client.sendChat(intent.text, "Chat");
          rememberOwn(intent.text);
        }
        break;
      }
      // 白名单二次校验（brain 已校验过，这里防回归）
      const check = checkActivity(intent.activity, intent.zone);
      if (!check.ok) {
        console.log(`[bot] activity rejected: ${check.reason}`);
        return;
      }
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        console.log(`[bot] activity target not found: "${intent.target}"`);
        return;
      }
      client.sendActivity(intent.activity, intent.zone, targetNo);
      const desc = `（对 ${client.nameOf(targetNo)} 的${zoneCN(intent.zone)}使用动作 ${intent.activity}）`;
      console.log(`[bot] activity: ${intent.activity} -> ${client.nameOf(targetNo)}@${intent.zone}`);
      rememberOwn(desc);
      // 动作附带的口头评论（可选）
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "pose": {
      if (!intent.pose) return;
      const check = checkPose(intent.pose);
      if (!check.ok || !check.pose) {
        console.log(`[bot] pose rejected: ${check.reason}`);
        return;
      }
      client.setPose(check.pose);
      console.log(`[bot] pose: ${intent.pose} -> [${check.pose.join(", ")}]`);
      rememberOwn(`（摆出姿势：${intent.pose}）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "item_put": {
      if (!intent.item || !intent.target) return;
      // #72 服装分支：item 形如 "Cloth/TShirt1" 或纯资产名（精选表内）——
      // 服装没有变体/锁/难度，走轻量路径（穿上+缓存+落库+公告），不进束缚主路径
      const clothing = checkClothing(intent.item);
      if (clothing.ok && clothing.group && clothing.name && clothing.cn) {
        const targetNo = client.resolveMemberNumber(intent.target);
        if (targetNo === null) {
          console.log(`[bot] item_put target not found: "${intent.target}"`);
          return;
        }
        client.sendItemUpdate(targetNo, clothing.group, clothing.name);
        markOwnItemOp(targetNo, clothing.group, clothing.name);
        client.updateCachedItem(targetNo, clothing.group, clothing.name);
        const isSelfPut = targetNo === (client.player.MemberNumber ?? -1);
        if (isSelfPut) client.sendCharacterUpdate();
        if (!isSelfPut) {
          const botNo = client.player.MemberNumber ?? 0;
          client.sendChatAction(
            "ActionUse",
            buildEquipActionDictionary(botNo, targetNo, clothing.group, clothing.name)
          );
        }
        console.log(`[bot] item_put clothing: ${clothing.name}（${clothing.cn}）-> ${client.nameOf(targetNo)}${isSelfPut ? " (self)" : ""}`);
        rememberOwn(isSelfPut
          ? `（给自己穿上 ${clothing.cn}）`
          : `（给 ${client.nameOf(targetNo)} 穿上 ${clothing.cn}）`);
        if (intent.text) {
          client.sendChat(intent.text, "Chat");
          rememberOwn(intent.text);
        }
        break;
      }
      const check = checkItem(intent.item);
      if (!check.ok || !check.group || !check.name) {
        console.log(`[bot] item_put rejected: ${check.reason}`);
        return;
      }
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        console.log(`[bot] item_put target not found: "${intent.target}"`);
        return;
      }
      // 变体（绑法/形态）：校验并构造完整 Property（保留已穿同款道具的锁字段等）
      let property: Record<string, unknown> | undefined;
      let vLabel = "";
      if (intent.variant) {
        const vCheck = checkVariant(intent.item, intent.variant);
        if (!vCheck.ok || vCheck.index === undefined) {
          console.log(`[bot] item_put variant rejected: ${vCheck.reason}`);
          return;
        }
        const base = findWornProperty(targetNo, check.group, check.name);
        property = buildVariantProperty(intent.item, vCheck.index, base);
        vLabel = `（${vCheck.def?.cn ?? intent.variant}）`;
        console.log(`[bot] item_put variant: ${vCheck.def?.cn} (${intent.variant}#${vCheck.index})`);
      }
      // #16 宠物标牌（CustomCollarTag）：带文字的 MODULAR 道具，TypeRecord 键是模块键 {t, x}
      if (check.name === "CustomCollarTag") {
        // Prerequisite: Collared——没戴项圈先自动补一条（与牵绳三步链同思路）
        const neckEntry = findSlotEntry(targetNo, "ItemNeck");
        if (!neckEntry?.Name) {
          const botNo0 = client.player.MemberNumber ?? 0;
          client.sendItemUpdate(targetNo, "ItemNeck", "PetCollar", { difficulty: 0 });
          client.sendChatAction("ActionUse", buildEquipActionDictionary(botNo0, targetNo, "ItemNeck", "PetCollar"));
          markOwnItemOp(targetNo, "ItemNeck", "PetCollar");
          client.updateCachedItem(targetNo, "ItemNeck", "PetCollar", { difficulty: 50 });
          console.log(`[bot] item_put auto-chain: PetCollar -> ${client.nameOf(targetNo)}（标牌前置）`);
          await sleep(400);
        }
        const text = (intent.itemText ?? config.gohomeTagText).slice(0, COLLAR_TAG_TEXT_MAX);
        const tagBase = findWornProperty(targetNo, check.group, check.name);
        property = buildCollarTagProperty(text, 0, tagBase);
        vLabel = `（写着"${text}"）`;
        console.log(`[bot] item_put collar tag text: "${text}"`);
      }
      // 松紧保持与组合调节：
      // - 重穿/换变体会把道具重建为基础难度，必须把当前调节量随消息带上才不会"白绑紧"；
      // - intent.adjust 支持"绑成X并绑紧/放松"一轮完成（fresh put 从 0 起算）。
      const base = getItemBaseDifficulty(check.group, check.name);
      const worn = findWornEntry(targetNo, check.group, check.name);
      const curAbs = worn && typeof worn.Difficulty === "number" ? worn.Difficulty : base;
      const curRel = curAbs - base;
      let newRel = curRel;
      let adjustLabel = "";
      if (intent.adjust) {
        const DELTA: Record<string, number> = {
          tighten_little: 2, tighten_lot: 4, loosen_little: -2, loosen_lot: -4,
        };
        const delta = DELTA[intent.adjust];
        if (delta === undefined) {
          console.log(`[bot] item_put rejected: invalid adjust "${intent.adjust}"`);
          return;
        }
        newRel = Math.max(-10, Math.min(4, curRel + delta));
        adjustLabel = newRel >= curRel ? `，${delta > 0 ? "收紧" : "放松"}到${newRel >= 0 ? "+" : ""}${newRel}` : "";
      }
      // 惩罚束缚难度拉满（2026-09-04 22:05 用户要求：暴怒束缚也能挣脱 → 惩罚级束缚挣不脱）。
      //   只对"惩罚类戴束缚"（bind/gag）生效：非平静档、针对服务对象。
      //   原理同上锁锁死难度：她开了 BypassStruggle，挑战值 ≤ 6 自动滑脱，中间难度无意义——
      //   直接拉到 punishBindDifficulty（默认 30，覆盖 Evasion 满级），出口是求 BOT 松绑/安全词。
      if ((punishKind === "bind" || punishKind === "gag") && newRel < config.punishBindDifficulty - base) {
        newRel = config.punishBindDifficulty - base;
        console.log(
          `[punish] bind difficulty raised to abs ${base + newRel} (+${newRel} rel, punish level) for ${intent.item}`
        );
      }
      client.sendItemUpdate(targetNo, check.group, check.name, {
        ...(property !== undefined ? { property } : {}),
        difficulty: newRel,
        ...(intent.color !== undefined ? { color: intent.color } : {}),
      });
      // 组合调节的聊天广播（与官方收紧/放松动作一致）
      if (intent.adjust) {
        const actionContent =
          intent.adjust === "tighten_little" ? "ActionTightenLittle" :
          intent.adjust === "tighten_lot" ? "ActionTightenLot" :
          intent.adjust === "loosen_little" ? "ActionLoosenLittle" : "ActionLoosenLot";
        const botNo = client.player.MemberNumber ?? 0;
        client.sendChatAction(
          actionContent,
          buildTightenActionDictionary(botNo, targetNo, check.group, check.name)
        );
      }
      markOwnItemOp(targetNo, check.group, check.name);
      // 本地缓存同步（服务器不回显自己的操作）
      client.updateCachedItem(targetNo, check.group, check.name, {
        ...(property !== undefined ? { property } : {}),
        difficulty: base + newRel,
        ...(intent.color !== undefined ? { color: intent.color } : {}),
      });
      // SELF-TARGET（#18）：给自己穿时换种文案，避免"给 ljzsbot 戴上了 X"这种自相矛盾
      const isSelfPut = targetNo === (client.player.MemberNumber ?? -1);
      // self-target 穿戴道具后同样需要整包写库，否则重启会回滚（服务器单道具通道不落库）
      if (isSelfPut) client.sendCharacterUpdate();
      // 穿戴公告：让房间内其他人看到 BOT 真的动了手（官方 DialogPublishAction 走 ActionUse）。
      // self-target 不发（没意义）；带 adjust 时已经发 ActionTighten/Loosen 系列，避免重复。
      if (!isSelfPut && !intent.adjust) {
        const botNo = client.player.MemberNumber ?? 0;
        client.sendChatAction(
          "ActionUse",
          buildEquipActionDictionary(botNo, targetNo, check.group, check.name)
        );
      }
      console.log(`[bot] item_put: ${check.name}${vLabel}${adjustLabel} (${check.group}, 紧度${newRel >= 0 ? "+" : ""}${newRel}) -> ${client.nameOf(targetNo)}${isSelfPut ? " (self)" : ""}`);
      rememberOwn(isSelfPut
        ? `（给自己戴上 ${intent.item}${vLabel}${adjustLabel}）`
        : `（给 ${client.nameOf(targetNo)} 戴上 ${intent.item}${vLabel}${adjustLabel}）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "item_adjust": {
      if (!intent.item || !intent.target || !intent.adjust) return;
      const check = checkItem(intent.item);
      if (!check.ok || !check.group || !check.name) {
        console.log(`[bot] item_adjust rejected: ${check.reason}`);
        return;
      }
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        console.log(`[bot] item_adjust target not found: "${intent.target}"`);
        return;
      }
      // 必须已穿着该道具才能调松紧
      const worn = findWornEntry(targetNo, check.group, check.name);
      if (!worn) {
        console.log(`[bot] item_adjust rejected: ${check.name} not worn by ${client.nameOf(targetNo)}`);
        return;
      }
      // wire Difficulty = 相对资产基础难度的调节量（接收端：绝对 = 基础 + 相对）。
      // 外观缓存里的 Difficulty 是绝对值（bundle 语义）——必须先减基础值再加减！
      const base = getItemBaseDifficulty(check.group, check.name);
      const curAbs = typeof worn.Difficulty === "number" ? worn.Difficulty : base;
      const curRel = curAbs - base;
      const DELTA: Record<string, number> = {
        tighten_little: 2, tighten_lot: 4, loosen_little: -2, loosen_lot: -4,
      };
      const delta = DELTA[intent.adjust];
      // 官方边界：下限 -10；上限 = 收紧者束缚技能 + 4 + 基础难度（BOT 技能按 0 算 → 相对上限 +4）
      // 惩罚收紧例外（2026-09-04 22:05）：非平静档对服务对象的收紧 = 惩罚，
      //   直接拉到 punishBindDifficulty（同上锁锁死难度，防 BypassStruggle 自动滑脱）
      let newRel = Math.max(-10, Math.min(4, curRel + delta));
      if (punishKind === "tighten" && newRel < config.punishBindDifficulty - base) {
        newRel = config.punishBindDifficulty - base;
        console.log(
          `[punish] tighten difficulty raised to abs ${base + newRel} (+${newRel} rel, punish level) for ${check.name}`
        );
      }
      const newAbs = base + newRel;
      const actionContent =
        intent.adjust === "tighten_little" ? "ActionTightenLittle" :
        intent.adjust === "tighten_lot" ? "ActionTightenLot" :
        intent.adjust === "loosen_little" ? "ActionLoosenLittle" : "ActionLoosenLot";
      const botNo = client.player.MemberNumber ?? 0;
      client.sendItemUpdate(targetNo, check.group, check.name, {
        property: (worn.Property as Record<string, unknown>) ?? undefined,
        difficulty: newRel,
      });
      client.sendChatAction(
        actionContent,
        buildTightenActionDictionary(botNo, targetNo, check.group, check.name)
      );
      markOwnItemOp(targetNo, check.group, check.name);
      // 服务器不回显自己的操作，本地记录新难度（绝对值），连续调节才不会基于过期数据
      client.updateCachedItem(targetNo, check.group, check.name, { difficulty: newAbs });
      const relLabel = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
      const isSelfAdjust = targetNo === (client.player.MemberNumber ?? -1);
      if (isSelfAdjust) client.sendCharacterUpdate();
      console.log(
        `[bot] item_adjust: ${check.name} ${relLabel(curRel)} -> ${relLabel(newRel)} ` +
        `(绝对难度 ${curAbs} -> ${newAbs}, 基础 ${base}) -> ${client.nameOf(targetNo)}${isSelfAdjust ? " (self)" : ""}`
      );
      rememberOwn(isSelfAdjust
        ? `（把自己的 ${intent.item} ${delta > 0 ? "收紧" : "放松"}了）`
        : `（把 ${client.nameOf(targetNo)} 的 ${intent.item} ${delta > 0 ? "收紧" : "放松"}了）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "item_lock": {
      if (!intent.item || !intent.lock || !intent.target) return;
      // 拒绝 item_lock：打日志 + 给用户一条解释（之前只 log 不说话，BOT 一声不吱让用户摸不着头脑）
      const reject = (reason: string, userMsg: string): never => {
        console.log(`[bot] item_lock rejected: ${reason}`);
        client.sendChat(userMsg);
        // 让后续 LLM 调用也能感知到这个失败（最近消息会反映"我刚才说过了"）
        recentChat.push(`${botName()} (me): ${userMsg}`);
        return undefined as never;
      };
      const check = checkItem(intent.item);
      if (!check.ok || !check.group || !check.name) {
        return reject(check.reason ?? "道具名不识别", "我听不太懂这个道具名——你能换个说法吗？");
      }
      const lockCheck = checkLock(intent.lock);
      if (!lockCheck.ok || !lockCheck.def) {
        return reject(lockCheck.reason ?? "锁名不识别", "这锁名我没听过。");
      }
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        return reject(`target "${intent.target}" not found`, "他不在房间里。");
      }
      // 必须已穿着该道具才能上锁
      const worn = findWornEntry(targetNo, check.group, check.name);
      if (!worn) {
        return reject(`${check.name} not worn`, "你身上没戴这个呢。");
      }
      // 道具必须可上锁（官方 Asset.AllowLock：绳/布/胶带不可）
      if (!checkLockable(check.group, check.name)) {
        return reject(`${check.name} is not lockable`, "这种束缚没有锁孔，挂不上锁。");
      }
      const curProp = findWornProperty(targetNo, check.group, check.name);
      if (curProp?.LockedBy != null) {
        return reject(`${check.name} already locked with ${curProp.LockedBy}`, "已经锁着呢——先让我解开再说。");
      }
      // 主人锁（OwnerOnly）身份校验：目标的资料 Owner 必须是 BOT 本人，否则接收端会静默回滚
      if (lockCheck.def.ownerOnly) {
        const targetChar = client.getCharacter(targetNo);
        const ownerNo = targetChar?.Ownership?.MemberNumber;
        const botNo0 = client.player.MemberNumber ?? -1;
        if (ownerNo !== botNo0) {
          return reject(
            `${intent.lock} requires being ${client.nameOf(targetNo)}'s Owner (current owner: ${ownerNo != null ? ownerNo : "none"}, bot is ${botNo0})`,
            "主人锁要等你接受我的归属邀请才能用——跟我说\"收了我吧\"，我发出邀请后你在游戏里点开我接受就好。"
          );
        }
      }
      const botNo = client.player.MemberNumber ?? 0;
      const botLockName = (client.player.Name as string | undefined) ?? "ljzsbot";
      // 上锁时锁死难度：挣扎挑战值 = Item.Difficulty + Property.Difficulty(变体自带) + 锁惩罚(2~4) - Evasion，
      // 挑战值 > 6 触发 BC 的 Struggle "Impossible"（进度钳制 99%，永远无法挣脱，Struggle.js:623-625）。
      // 否则 BOT 只加锁不改难度，挑战值 ≤ 6，开了 BypassStruggle 的服务对象几秒就自动滑脱
      // （2026-09-04 用户报"换了锁还是一样随便挣脱"）。防挣脱主力是 Item.Difficulty 提升，不是锁本身。
      const baseDiff = getItemBaseDifficulty(check.group, check.name);
      const wornDiff = findWornEntry(targetNo, check.group, check.name);
      const preAbs = wornDiff && typeof wornDiff.Difficulty === "number" ? wornDiff.Difficulty : baseDiff;
      // 记录上锁前绝对难度，解锁时恢复
      lockPreDifficulty.set(`${targetNo}:${check.group}:${check.name}`, preAbs);
      const lockDifficulty = config.lockDifficulty ?? 30;
      // 上锁前先处理"手铐类 TYPED 道具的 SelfUnlock 陷阱"：
      // 皮革/钢/未来手铐的 Wrist 变体官方 SelfUnlock=true（可自我解锁），即使上锁、拉高难度，
      // 佩戴者仍能挣扎脱下（DialogHasKey 判定 SelfUnlock==false 才禁止自我解锁）。
      // 直接写 Property.SelfUnlock=false 会被 TypedItemInit 用变体定义覆盖，唯一可靠做法是
      // 切到 selfUnlock=false 的变体（Elbow 肘缚）。
      //
      // ⚠️ 变体切换必须作为【独立更新】先发，绝不能和上锁合并成一条（2026-09-04 #21 根因）：
      // 合并时 TypeRecord 变化与锁字段同包，接收端 ValidationResolveModifyDiff
      // （Validation.js:317-319）判定"类型变更被阻止"→ 整条更新回滚，锁静默消失。
      // 先发纯变体更新（无锁字段、保持当前难度），间隔 500ms 等接收端应用后再发上锁更新。
      const typedIdx = getTypedIndex(curProp);
      const safeVariant = findSelfUnlockSafeVariant(check.name, typedIdx);
      let lockBase = curProp;
      if (safeVariant) {
        const variantProp = buildVariantProperty(check.name, safeVariant.switchTo, curProp);
        // 单道具通道必须携带 difficulty（相对值），否则接收端会把难度重置回基础值
        client.sendItemUpdate(targetNo, check.group, check.name, {
          property: variantProp,
          difficulty: preAbs - baseDiff,
        });
        client.updateCachedItem(targetNo, check.group, check.name, { property: variantProp, difficulty: preAbs });
        console.log(
          `[item-lock-debug] ${check.name} 当前变体 SelfUnlock=true（typed=${typedIdx ?? 0}），` +
          `已先发独立变体更新切到 ${safeVariant.def.name}（SelfUnlock=false，typed=${safeVariant.switchTo}），500ms 后再上锁`
        );
        await sleep(500);
        lockBase = variantProp;
      }
      // 上锁 payload 与官方客户端逐字段一致：当前官方完整属性 + 锁字段
      // （Effect+"Lock"、LockedBy、LockMemberNumber/Name）。不注入 Property.Difficulty/
      // SelfUnlock 等非官方字段——实测会让接收端变体校验整条回滚（BallGag 丢锁根因）。
      const property = buildLockProperty(lockBase, intent.lock, {
        memberNumber: botNo,
        memberName: botLockName,
        combination: intent.combination,
        password: intent.password,
        timerSec: intent.timerMin !== undefined ? intent.timerMin * 60 : undefined,
      });
      // wire Difficulty = 相对值（绝对 - 基础难度）；传锁死值让 Item.Difficulty 拉高。
      // 防挣脱主力就是这个 item 级难度：Struggle 挑战值 = Item.Difficulty + 锁惩罚 - Evasion > 6
      // → "不可能挣脱"（Struggle.js:623-625 进度钳制 99）。已在脚铐/腿铐/眼罩/牵绳实证生效。
      client.sendItemUpdate(targetNo, check.group, check.name, {
        property,
        difficulty: lockDifficulty - baseDiff,
      });
      // 调试日志（2026-09-04 排查 LeatherCuffs/BallGag 锁失效）：检查上锁时实际写出去的 Property。
      console.log(
        `[item-lock-debug] ${check.name} 上锁 payload: Effect=${JSON.stringify((property as Record<string, unknown>).Effect)} ` +
        `LockedBy=${(property as Record<string, unknown>).LockedBy} ` +
        `Property.SelfUnlock=${(property as Record<string, unknown>).SelfUnlock} ` +
        `Property.TypeRecord=${JSON.stringify((property as Record<string, unknown>).TypeRecord)} ` +
        `wireDifficulty(rel)=${lockDifficulty - baseDiff} ` +
        `baseDiff=${baseDiff} preAbs=${preAbs}`
      );
      // 上锁公告（官方 ChatRoomPublishAction：PrevAsset=目标道具，NextAsset=锁）
      client.sendChatAction("ActionAddLock", buildAddLockActionDictionary(botNo, targetNo, check.group, check.name, intent.lock));
      markOwnItemOp(targetNo, check.group, check.name);
      // 本地记账（服务器不回显自己的操作）：property 与 difficulty 都要同步
      client.updateCachedItem(targetNo, check.group, check.name, { property, difficulty: lockDifficulty });
      // 锁后自动验证（反馈回路兜底）：约 2.5 秒后检查缓存里该道具的锁是否还在。
      // 若接收端判定更新非法，目标客户端会广播 ChatRoomCharacterUpdate 纠正包把锁抹掉
      // （client.ts 的 [correction] 日志会同步出现），这里给出醒目报警而不是静默失败。
      setTimeout(() => {
        const cur = findWornProperty(targetNo, check.group!, check.name!);
        if (cur != null && cur.LockedBy != null) {
          console.log(`[lock-verify] ${check.name} 锁状态确认生效（LockedBy=${String(cur.LockedBy)}）-> ${client.nameOf(targetNo)}`);
        } else {
          console.log(`⚠️ [lock-verify] ${check.name} 上锁未生效：缓存中锁已消失（接收端很可能回滚了更新，见上方 [correction] 日志）-> ${client.nameOf(targetNo)}`);
        }
      }, 2500);
      const lockDef = lockCheck.def;
      // self-target 上锁后同样需要整包写库
      if (targetNo === (client.player.MemberNumber ?? -1)) client.sendCharacterUpdate();
      const extra: string[] = [];
      if (intent.combination) extra.push(`密码 ${intent.combination}`);
      if (intent.password) extra.push(`暗语 ${intent.password}`);
      if (intent.timerMin !== undefined) {
        const capped = Math.min(intent.timerMin * 60, lockDef.maxTimerSec ?? Infinity);
        extra.push(`定时 ${Math.round(capped / 60)} 分钟`);
      }
      console.log(
        `[bot] item_lock: ${check.name} + ${intent.lock}${extra.length ? `（${extra.join("，")}）` : ""} -> ${client.nameOf(targetNo)}`
      );
      rememberOwn(`（给 ${client.nameOf(targetNo)} 的 ${intent.item} 上了一把${lockDef.cn}）`);
      // #21 主人锁定时自动解锁调度：OwnerPadlock（且无 timerMin——OwnerTimerPadlock 用 BC 内置定时）
      // 走 BOT 代码层 setTimeout 主动解开（语义=何时结束由 BOT 决定）。同一锁多次上锁先清旧 timer。
      // 2026-09-05 查证：wire 发的 RemoveTimer 会被接收端原样尊重，OwnerTimerPadlock 本身可靠，
      // 此处不改是为了保持"无倒计时提示"的惩罚压迫感。
      // #69（2026-09-06 02:29 实测）：限时回家局内【跳过】——局内束缚的解开由编排器统一管
      //   （赢=提前全解；输=惩罚流程 executePunishRelease 记账定时解）。
      //   实测事故：setup 阶段 LLM 主动给单手套上主人锁 → 挂了通用 15 分钟自动解锁 →
      //   若她输局进惩罚期，这把锁会在惩罚结束前被提前解开，破坏罚锁。
      const inGohomeSession = game.active && game.currentRule?.id === "gohome";
      if (intent.lock === "OwnerPadlock" && intent.timerMin === undefined && !inGohomeSession) {
        const minutes = config.punishLockMinutes ?? 15;
        const timerKey = `${targetNo}:${check.group}:${check.name}`;
        cancelOwnerLockTimer(targetNo, check.group!, check.name!);
        const t = setTimeout(() => {
          ownerLockTimers.delete(timerKey);
          // 检查锁是否还在：findWornProperty 拿当前 Property，LockedBy 不为 null 才解锁
          const cur = findWornProperty(targetNo, check.group!, check.name!);
          if (!cur || cur.LockedBy == null) {
            console.log(`[bot] owner-lock timer fired but ${check.name} no longer locked -> skip`);
            return;
          }
          // 目标可能已离房——resolveMemberNumber 在缓存里查不到 targetNo 会返回 null，这里直接查目标存在性
          if (!client.getCharacter(targetNo)) {
            console.log(`[bot] owner-lock timer fired but ${client.nameOf(targetNo) || targetNo} not in room -> skip`);
            return;
          }
          const unlockProp = stripLockProperty(cur);
          // 恢复上锁前的难度（上锁时把 Item.Difficulty 拉到了锁死值；Property.Difficulty 自 #21 修复后不再注入）
          const restore = unlockDifficultyRel(targetNo, check.group!, check.name!);
          delete unlockProp.Difficulty; // 清掉可能残留的变体/旧版注入难度字段，保持与官方解锁一致
          client.sendItemUpdate(targetNo, check.group!, check.name!, { property: unlockProp, difficulty: restore.difficulty });
          client.sendChatAction("ActionUnlock", buildUnlockActionDictionary(botNo, targetNo, check.group!, check.name!));
          markOwnItemOp(targetNo, check.group!, check.name!);
          client.updateCachedItem(targetNo, check.group!, check.name!, { property: unlockProp, difficulty: restore.abs });
          if (targetNo === (client.player.MemberNumber ?? -1)) client.sendCharacterUpdate();
          console.log(`[bot] owner-lock timer: ${check.name} 解开了${lockDef.cn}（${minutes} 分钟定时惩罚到期，难度已恢复）-> ${client.nameOf(targetNo)}`);
          rememberOwn(`（定时惩罚到期，自动解开了 ${client.nameOf(targetNo)} ${intent.item} 上的${lockDef.cn}）`);
        }, minutes * 60 * 1000);
        ownerLockTimers.set(timerKey, t);
        console.log(`[bot] owner-lock scheduled: ${check.name} -> ${client.nameOf(targetNo)} 将在 ${minutes} 分钟后自动解开`);
      }
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "item_unlock": {
      if (!intent.item || !intent.target) return;
      // 拒绝 item_unlock：打日志 + 给用户一条解释（和 item_lock 同模式）
      const reject = (reason: string, userMsg: string): never => {
        console.log(`[bot] item_unlock rejected: ${reason}`);
        client.sendChat(userMsg);
        recentChat.push(`${botName()} (me): ${userMsg}`);
        return undefined as never;
      };
      const check = checkItem(intent.item);
      if (!check.ok || !check.group || !check.name) {
        return reject(check.reason ?? "道具名不识别", "我听不太懂这个道具名——你能换个说法吗？");
      }
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        return reject(`target "${intent.target}" not found`, "他不在房间里。");
      }
      const worn = findWornEntry(targetNo, check.group, check.name);
      if (!worn) {
        return reject(`${check.name} not worn`, "你身上没戴这个。");
      }
      const curProp = findWornProperty(targetNo, check.group, check.name);
      if (!curProp || curProp.LockedBy == null) {
        return reject(`${check.name} 没有上锁`, "没锁着呢。");
      }
      const lockName = String(curProp.LockedBy);
      // 注：定时锁未到期不拦截。官方 ValidationIsLockChangePermitted 只检查 Owner/Lover/Family 三类
      // 特殊锁，对定时锁无时间检查（任何人可提前解）。而且 BOT 测试模式（BC_TEST_MODE）下本就
      // 应该无条件配合，拦截会让服务对象测不了定时锁。定时信息仅作日志上下文，不阻塞动作。
      const botNo = client.player.MemberNumber ?? 0;
      const property = stripLockProperty(curProp);
      // #21 取消主人锁定时器：手动解锁时清掉挂着的 setTimeout，避免到点再次解锁（已是空操作）
      if (lockName === "OwnerPadlock") cancelOwnerLockTimer(targetNo, check.group, check.name);
      // 恢复上锁前的难度（上锁时把 Item.Difficulty 拉到了锁死值；Property.Difficulty 自 #21 修复后不再注入）
      const restore = unlockDifficultyRel(targetNo, check.group, check.name);
      delete property.Difficulty; // 清掉可能残留的变体/旧版注入难度字段，保持与官方解锁一致
      client.sendItemUpdate(targetNo, check.group, check.name, { property, difficulty: restore.difficulty });
      // 解锁公告：Content 是官方 "ActionUnlock"（不是 "ActionRemoveLock"，后者 Interface.csv 不存在）
      client.sendChatAction("ActionUnlock", buildUnlockActionDictionary(botNo, targetNo, check.group, check.name));
      markOwnItemOp(targetNo, check.group, check.name);
      client.updateCachedItem(targetNo, check.group, check.name, { property, difficulty: restore.abs });
      const lockCN = LOCKS[lockName]?.cn ?? lockName;
      // self-target 解锁（改 Property 去锁字段）后同样需要整包写库
      if (targetNo === (client.player.MemberNumber ?? -1)) client.sendCharacterUpdate();
      // 定时锁若存在剩余时间（测试模式时间不流逝时也会保留），日志里给出上下文物流
      let timerExtra = "";
      if (typeof curProp.RemoveTimer === "number") {
        const remainMs = curProp.RemoveTimer - Date.now();
        if (remainMs > 0) {
          timerExtra = `（定时未到期，剩余约 ${Math.ceil(remainMs / 60000)} 分钟，测试/手动解开）`;
        } else {
          timerExtra = "（定时已到期自动解锁）";
        }
      }
      console.log(`[bot] item_unlock: ${check.name} 解开了${lockCN}${timerExtra} -> ${client.nameOf(targetNo)}`);
      rememberOwn(`（解开了 ${client.nameOf(targetNo)} ${intent.item} 上的锁）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "ownership_propose": {
      // 官方"求婚制"：主人（Dom）向服务对象发出试用邀请，对方在游戏里点开 BOT 接受。
      // 只能对服务对象发起（一对一模式）；对方已在试用/正式所有权中则不重复发。
      const serveNo = serveMemberNumber();
      if (serveNo === null) {
        console.log("[bot] ownership_propose rejected: 一对一服务模式未开启");
        return;
      }
      // 若 intent.target 指定了别人，拒绝（只能收编服务对象）
      if (intent.target) {
        const targetNo = client.resolveMemberNumber(intent.target);
        if (targetNo !== null && targetNo !== serveNo) {
          console.log(`[bot] ownership_propose rejected: target ${intent.target} 不是服务对象`);
          return;
        }
      }
      const serveChar = client.getCharacter(serveNo);
      const ownerNo = serveChar?.Ownership?.MemberNumber;
      const botNo = client.player.MemberNumber ?? -1;
      if (ownerNo === botNo) {
        console.log("[bot] ownership_propose skipped: 服务对象已归属 BOT，无需再邀请");
        return;
      }
      if (ownerNo != null) {
        console.log(`[bot] ownership_propose rejected: 服务对象已归属 #${ownerNo}，官方不允许重叠所有权`);
        client.sendChat("你已经有别的主人了，这扇门我进不去。");
        return;
      }
      client.sendOwnershipAction(serveNo, "Propose");
      rememberOwn(`（向 ${client.nameOf(serveNo)} 发出了归属邀请，等对方在游戏里接受）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    // ============ #19 牵引系统 ============
    case "shock": {
      // #84 直接触发她身上电击道具的电流（等同玩家点项圈上的"触发电击"按钮）
      const serveNo = serveMemberNumber();
      let targetNo: number | null = null;
      if (intent.target) {
        targetNo = client.resolveMemberNumber(intent.target);
      } else {
        targetNo = serveNo;
      }
      if (targetNo === null) {
        console.log(`[bot] shock rejected: target "${intent.target ?? "(serve)"}" not found`);
        break;
      }
      // 找她身上带 ShockLevel 属性的电击道具（电击项圈家族全在 ItemNeck；兜底扫全部槽位）
      const SHOCK_ASSETS = ["ShockCollar", "AutoShockCollar", "PetSuitShockCollar", "CollarShockUnit", "CollarAutoShockUnit"];
      const appearance = client.getAppearance(targetNo) ?? [];
      let found: { name: string; group: string } | null = null;
      // 优先 ItemNeck（电击项圈主槽）
      for (const e of appearance) {
        const entry = e as { Name?: string; Group?: string };
        if (entry?.Group === "ItemNeck" && entry.Name && SHOCK_ASSETS.includes(entry.Name)) {
          found = { name: entry.Name, group: entry.Group };
          break;
        }
      }
      if (!found) {
        for (const e of appearance) {
          const entry = e as { Name?: string; Group?: string };
          if (entry?.Name && entry.Group && SHOCK_ASSETS.includes(entry.Name)) {
            found = { name: entry.Name, group: entry.Group };
            break;
          }
        }
      }
      if (!found) {
        console.log(`[bot] shock rejected: ${client.nameOf(targetNo)} 身上没有电击道具（5件可遥控项圈均未佩戴）`);
        client.sendChat(`（扫了一眼 ${client.nameOf(targetNo)} 的脖子——上面没有能电到她的东西，先得给她戴个电击项圈才行）`);
        break;
      }
      client.sendShockAction(targetNo, intent.level ?? 1, found.name, found.group);
      rememberOwn(`（触发了 ${client.nameOf(targetNo)} ${found.name === "PetSuitShockCollar" ? "宠物服电击项圈" : "电击项圈"} 的电流，强度 ${intent.level ?? 1}）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "leash_hold": {
      // 目标：默认服务对象
      const serveNo = serveMemberNumber();
      let targetNo: number | null = null;
      if (intent.target) {
        targetNo = client.resolveMemberNumber(intent.target);
      } else {
        targetNo = serveNo;
      }
      if (targetNo === null) {
        console.log(`[bot] leash_hold rejected: target "${intent.target ?? "(serve)"}" not found`);
        client.sendChat("（看了看四周，没有找到想找的人）");
        return;
      }
      const reject = (reason: string, userMsg: string): never => {
        console.log(`[bot] leash_hold rejected: ${reason}`);
        client.sendChat(userMsg);
        recentChat.push(`[系统] ${userMsg}`);
        if (recentChat.length > MAX_RECENT) recentChat.shift();
        return undefined as never;
      };
      if (leashHeld.has(targetNo)) {
        // 已经牵着了，不重复抓
        console.log(`[bot] leash_hold skipped: already holding ${client.nameOf(targetNo)}'s leash`);
        break;
      }
      // 前置校验（对照官方 ChatRoomCanBeLeashedBy）：
      let appearance = client.getAppearance(targetNo);
      // 诊断（2026-09-04 22:39 悬案：她没戴牵引绳校验却放行——道具同步是静默改缓存的，
      //   留下校验瞬间的穿着快照，下次复发就能对出"缓存 vs 实际"的差异）
      console.log(
        `[leash-diag] ${client.nameOf(targetNo)} items: ${(appearance ?? []).map((e) => `${e?.Group}:${e?.Name}`).join(", ") || "(空)"}`
      );
      let effects = collectEffects(appearance);
      // 1) 牵绳三步链（2026-09-04 22:39 用户要求：上项圈 → 上牵绳 → 牵绳子）：
      //    官方机制实锤：CollarLeash/ChainLeash 资产带 Prerequisite:"Collared"——目标必须
      //    先戴着项圈，否则接收端 Validation 会把 ItemUpdate 静默回滚（没项圈的牵绳=空气绳）。
      //    缺哪步代码层自动补齐（LLM 只需表达"我要牵她"，机械顺序代码保证）。
      const findGroup = (g: string) => (appearance ?? []).find((e) => e?.Group === g) ?? null;
      const neckItem = findGroup("ItemNeck");
      const neckRestraint = findGroup("ItemNeckRestraints");
      const hasLeashItem = neckRestraint?.Name === "CollarLeash" || neckRestraint?.Name === "ChainLeash";
      if (!hasLeashItem) {
        // 颈缚槽被其它道具占着：不粗暴替换她的东西，退回台词处理
        if (neckRestraint) {
          return reject(
            `target #${targetNo} 颈缚槽被 ${neckRestraint.Name} 占用，无法上牵引绳`,
            `${client.nameOf(targetNo)}，你颈上那件东西挡着牵引绳的位置，先取下来再说牵你。`
          );
        }
        const botNo = client.player.MemberNumber ?? 0;
        // ① 上项圈（她没戴的话；PetCollar 契合她的宠物向偏好）
        if (!neckItem) {
          client.sendItemUpdate(targetNo, "ItemNeck", "PetCollar", { difficulty: 0 });
          client.sendChatAction("ActionUse", buildEquipActionDictionary(botNo, targetNo, "ItemNeck", "PetCollar"));
          markOwnItemOp(targetNo, "ItemNeck", "PetCollar");
          client.updateCachedItem(targetNo, "ItemNeck", "PetCollar", { difficulty: 50 });
          rememberOwn(`（给 ${client.nameOf(targetNo)} 戴上宠物项圈）`);
          console.log(`[leash] auto-chain ① 上项圈: PetCollar -> ${client.nameOf(targetNo)}`);
        }
        // ② 上牵绳（官方 Prerequisite:"Collared"，项圈 ItemUpdate 先发先到，顺序天然满足）
        client.sendItemUpdate(targetNo, "ItemNeckRestraints", "CollarLeash", { difficulty: 0 });
        client.sendChatAction("ActionUse", buildEquipActionDictionary(botNo, targetNo, "ItemNeckRestraints", "CollarLeash"));
        markOwnItemOp(targetNo, "ItemNeckRestraints", "CollarLeash");
        client.updateCachedItem(targetNo, "ItemNeckRestraints", "CollarLeash", { difficulty: 6 });
        rememberOwn(`（给 ${client.nameOf(targetNo)} 扣上牵引绳）`);
        console.log(`[leash] auto-chain ② 上牵绳: CollarLeash -> ${client.nameOf(targetNo)}`);
        // 重读缓存（updateCachedItem 已本地记账），让 Leash 效果就位后再走官方校验
        appearance = client.getAppearance(targetNo);
        effects = collectEffects(appearance);
      }
      if (!effects.has("Leash")) {
        return reject(
          `target #${targetNo} 没有戴牵引绳（自动补链后仍无 Leash 效果，疑似缓存异常）`,
          `${client.nameOf(targetNo)}，这绳子有点不对劲……稍等，我重新看看。`
        );
      }
      // 2) 不能被拴在原地（Tethered/Mounted/Enclose 都算 trapped，被拴住的人无法牵引）
      const trapped = ["Tethered", "Mounted", "Enclose", "OneWayEnclose"].some((e) => effects.has(e));
      if (trapped) {
        return reject(
          `target #${targetNo} 被拴在原地（Tethered/Mounted/Enclose）`,
          `${client.nameOf(targetNo)}，你已经被拴在原地了，皮带牵不动你哦。`
        );
      }
      // 3) 对方设置里允许被拴（OnlineSharedSettings.AllowPlayerLeashing，缺省=允许）
      const targetChar = client.getCharacter(targetNo) as
        | { OnlineSharedSettings?: { AllowPlayerLeashing?: boolean } }
        | undefined;
      if (targetChar?.OnlineSharedSettings?.AllowPlayerLeashing === false) {
        return reject(
          `target #${targetNo} 设置里关闭了 AllowPlayerLeashing`,
          `${client.nameOf(targetNo)}，你在设置里把"允许被皮带牵引"关掉了，我牵不了你。`
        );
      }
      // 执行：官方两连发——Action 广播（全房可见）+ Hidden 定向指令（对方客户端校验后生效）
      const botNo = client.player.MemberNumber ?? -1;
      client.sendChatAction("HoldLeash", [{ SourceCharacter: botNo }, { TargetCharacter: targetNo }]);
      client.sendHidden("HoldLeash", targetNo);
      leashHeld.add(targetNo);
      console.log(`[leash] BOT 抓起了 ${client.nameOf(targetNo)} 的牵引绳`);
      rememberOwn(`（抓起了 ${client.nameOf(targetNo)} 的牵引绳）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "leash_release": {
      let targetNo: number | null = null;
      if (intent.target) {
        targetNo = client.resolveMemberNumber(intent.target);
      } else {
        // 没指定目标：松开唯一牵着的人
        targetNo = leashHeld.size === 1 ? [...leashHeld][0] : serveMemberNumber();
      }
      if (targetNo === null || !leashHeld.has(targetNo)) {
        console.log(`[bot] leash_release rejected: 没有牵着 ${targetNo !== null ? client.nameOf(targetNo) : "任何人"}`);
        client.sendChat("（摊开手）我现在手里没有牵着谁的绳子。");
        return;
      }
      const botNo = client.player.MemberNumber ?? -1;
      client.sendChatAction("StopHoldLeash", [{ SourceCharacter: botNo }, { TargetCharacter: targetNo }]);
      client.sendHidden("StopHoldLeash", targetNo);
      leashHeld.delete(targetNo);
      console.log(`[leash] BOT 松开了 ${client.nameOf(targetNo)} 的牵引绳`);
      rememberOwn(`（松开了 ${client.nameOf(targetNo)} 的牵引绳）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "lead_move": {
      // 牵引移动：BOT 自己走位，被牵着的服务对象会被她自己的客户端拖拽跟随
      let targetNo: number | null = null;
      if (intent.target) {
        targetNo = client.resolveMemberNumber(intent.target);
      } else {
        targetNo = serveMemberNumber();
      }
      if (targetNo === null || !leashHeld.has(targetNo)) {
        console.log(`[bot] lead_move rejected: 没有牵着 ${targetNo !== null ? client.nameOf(targetNo) : "任何人"} 的皮带`);
        client.sendChat("（松了松手腕）我还牵着谁呢？先把绳子抓在手里，才谈得上带她走。");
        return;
      }
      // 位置基准：普通房间 X ∈ [0, 2000]，Y 恒 0
      const myPos = client.getPosition(client.player.MemberNumber ?? -1) ?? { X: 1000, Y: 0 };
      const herPos = client.getPosition(targetNo) ?? { X: 1000, Y: 0 };
      const STEP = 500; // 每次走一步的距离
      let newX = myPos.X;
      switch (intent.direction) {
        case "closer":
          // 朝她走近（给她松出绳长）
          newX = myPos.X + (herPos.X > myPos.X ? STEP : -STEP);
          break;
        case "away":
          // 背对她走远（皮带绷紧，把她拖过来）
          newX = myPos.X + (herPos.X > myPos.X ? -STEP : STEP);
          break;
        case "left":
          newX = myPos.X - STEP;
          break;
        case "right":
          newX = myPos.X + STEP;
          break;
      }
      newX = Math.max(0, Math.min(2000, Math.round(newX)));
      client.moveTo(newX, 0);
      console.log(`[leash] BOT 牵引移动: X ${myPos.X} -> ${newX}（direction=${intent.direction}）`);
      rememberOwn(`（牵着 ${client.nameOf(targetNo)} 走动）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    case "room_move": {
      // #75 LLM 换房：去指定区找热闹房。LLM 不知道房间名，代码负责搜索+加入。
      // 前置门槛：①10 分钟冷却（防抽风连环换房）②BOT 被绑不能走 ③限时回家游戏期间不搅局
      const now = Date.now();
      const ROOM_MOVE_COOLDOWN_MS = 10 * 60 * 1000;
      // #75d 回家免冷却：回家是收场动作（出门才冷却防抽风），连着"出门→回家"不该被拦
      if (!intent.home && lastRoomMoveAt > 0 && now - lastRoomMoveAt < ROOM_MOVE_COOLDOWN_MS) {
        const waitedMin = Math.round((now - lastRoomMoveAt) / 60000);
        console.log(`[bot] room_move rejected: 冷却中（距上次换房 ${waitedMin} 分钟 < 10）`);
        client.sendChat("（环顾了一下房间）刚换过地方，先在这儿待会儿，别把人折腾来折腾去的。");
        return;
      }
      const selfApp = client.getAppearance(client.player.MemberNumber ?? -1);
      if (hasRestraintItem(selfApp)) {
        console.log(`[bot] room_move rejected: BOT 自己被绑着，走不了`);
        client.sendChat("（拽了拽身上的束缚，轻笑）……我现在这副样子，哪儿也去不了，不是吗。");
        return;
      }
      const gs = loadGohomeState();
      if (gohomeOrchestrating || gs) {
        console.log(`[bot] room_move rejected: 限时回家游戏进行中（phase=${gs?.phase ?? "orchestrating"}）`);
        client.sendChat("（正忙着这局游戏）等这局完了，我再带你出去转。");
        return;
      }
      // space 归一化：female→女区("") / mixed→混区("X") / male→男区("M")；缺省=当前配置区
      const spaceMap: Record<string, string> = { female: "", mixed: "X", male: "M" };
      const spaceArg = intent.space && intent.space in spaceMap ? spaceMap[intent.space] : config.roomSpace;
      const spaceLabel = spaceArg === "" ? "女区" : spaceArg === "X" ? "混区" : "男区";
      // 三种模式：回家（#75d，私房直进+没房重建）/ 定向房名（她点名的房，校验存在/可进）/ 按区找房（热闹房→人数最多兜底）
      let room: string | null;
      let joinedLabel: string;
      if (intent.home) {
        // #75d 回家：家是私房不进公共搜索列表，定向房名模式搜不到——直接 switchRoom+createIfMissing
        if (!config.roomName) {
          console.log(`[bot] room_move rejected: 回家模式但未配置 BC_ROOM_NAME`);
          client.sendChat("（摊手）我现在没个固定的家……先在这儿待着吧。");
          return;
        }
        room = config.roomName;
        joinedLabel = `家 "${config.roomName}"`;
      } else if (intent.room) {
        // 定向进房：搜全量房名精确匹配（房名搜索惯例 toUpperCase，600 行同款）
        const target = intent.room.trim();
        const rooms = await client.searchRooms();
        const found = rooms.find((r) => (r.Name ?? "").toUpperCase() === target.toUpperCase());
        if (!found) {
          console.log(`[bot] room_move: 没有叫 "${target}" 的房`);
          client.sendChat(`（挑眉）"${target}"？我可没听说过有这么一间房。`);
          return;
        }
        if (found.Locked === true) {
          console.log(`[bot] room_move: "${found.Name}" 锁着门`);
          client.sendChat(`（看了一眼）"${found.Name}"门都锁了，进不去的。`);
          return;
        }
        const fLimit = found.MemberLimit ?? 0;
        const fCount = found.MemberCount ?? 0;
        if (fLimit > 0 && fLimit - fCount < 1) {
          console.log(`[bot] room_move: "${found.Name}" 满员 ${fCount}/${fLimit}`);
          client.sendChat(`（探头看了看）"${found.Name}"已经满员了，挤不进去。`);
          return;
        }
        if ((found.BlockCategory ?? []).includes("Leashing") && leashHeld.size > 0) {
          console.log(`[bot] room_move: "${found.Name}" 禁止牵绳，牵着人进不得`);
          client.sendChat(`（收了收绳子）"${found.Name}"那间房不许牵绳——我要是进去了，手里的绳就断了。先松开她，还是换一间？`);
          return;
        }
        if (kickedRooms.has(found.Name)) {
          console.log(`[bot] room_move: "${found.Name}" 在被踢黑名单里`);
          client.sendChat(`（摇头）"${found.Name}"那间我进不去——上回被赶出来过。`);
          return;
        }
        room = found.Name;
        joinedLabel = `"${found.Name}"`;
      } else if (intent.friend) {
        // #75f 好友定位进房：她说"我们去XX那个房间玩"（XX=好友名）→ 查在线好友所在房名直进
        // 前提：XX 必须是 BOT 的好友且在线；普通好友在私房里只能看到 Private:true 看不到房名
        const friends = await client.queryOnlineFriends();
        const fq = intent.friend.toLowerCase();
        // 匹配优先级：昵称精确 → 注册名精确 → 昵称包含 → 注册名包含（昵称优先于注册名）
        const pick = (pred: (name: string | undefined, nick: string | undefined) => boolean) =>
          friends.find((f) => pred(f.MemberName, f.MemberNickname));
        const hit =
          pick((n, k) => k === intent.friend) ??
          pick((n) => n === intent.friend) ??
          pick((_n, k) => (k ?? "").toLowerCase() === fq) ??
          pick((n) => (n ?? "").toLowerCase() === fq) ??
          pick((_n, k) => (k ?? "").toLowerCase().includes(fq)) ??
          pick((n) => (n ?? "").toLowerCase().includes(fq));
        if (!hit) {
          console.log(`[bot] room_move friend "${intent.friend}"：不在线或不在好友列表（在线好友 ${friends.length} 人）`);
          client.sendChat(`（想了想）"${intent.friend}"……不在我好友里，或者现在不在线——我看不到人家在哪儿。`);
          return;
        }
        const friendLabel = hit.MemberNickname || hit.MemberName || `#${hit.MemberNumber ?? "?"}`;
        if (!hit.ChatRoomName) {
          // 普通好友在私房里服务器只回 Private:true 不给房名（Ownership/Lover 才可见）
          console.log(`[bot] room_move friend "${friendLabel}"：在私房里看不到房名（Private=${hit.Private === true}）`);
          client.sendChat(`（摇头）${friendLabel}这会儿在一间私房里，我看不见房名……让她报个房名，或者换个别的地方？`);
          return;
        }
        if (hit.ChatRoomName === client.currentRoom) {
          console.log(`[bot] room_move friend "${friendLabel}"：就在当前房 "${hit.ChatRoomName}"`);
          client.sendChat(`（轻笑）${friendLabel}不就在这间房里吗？抬头看看。`);
          return;
        }
        console.log(
          `[bot] room_move friend: ${friendLabel} 在 "${hit.ChatRoomName}"（${hit.ChatRoomMemberCount ?? "?"}/${hit.ChatRoomLimit ?? "?"}）`
        );
        room = hit.ChatRoomName;
        joinedLabel = `${friendLabel} 所在的 "${hit.ChatRoomName}"`;
      } else if (intent.query) {
        // #75e 语义匹配进房：用户给自然语言描述（如"猫窝"），LLM 不知道精确房名
        // 双路搜索：①定向子串匹配（Query+SearchDescs，私房可按名命中）②全区列表（空 Query）
        // ——BC 搜索是子串匹配："猫窝"搜不到"猫猫玩耍窝"（18:08 实测只命中描述碰巧含
        // "猫窝"的 YeS），必须靠全区列表+LLM 语义仲裁兜底。合并去重后**永远**走 LLM 仲裁
        // （单候选也要确认"这间就是她说的那个地方"，防子串误命中）。
        const targeted = await client.searchRooms({ Query: intent.query, SearchDescs: true, FullRooms: false, ShowLocked: false });
        const broad = await client.searchRooms({ Query: "", Space: spaceArg, FullRooms: false, ShowLocked: false });
        const seenNames = new Set<string>();
        const merged: typeof targeted = [];
        for (const r of [...targeted, ...broad]) {
          if (!r.Name || seenNames.has(r.Name)) continue;
          seenNames.add(r.Name);
          merged.push(r);
        }
        console.log(
          `[bot] room_move query "${intent.query}": 定向 ${targeted.length} 间 + 全区 ${broad.length} 间 = 合并 ${merged.length} 间`
        );
        const filtered = merged.filter((r) => {
          if (!r.Name) return false;
          if (kickedRooms.has(r.Name)) return false;
          const limit = r.MemberLimit ?? 0;
          const count = r.MemberCount ?? 0;
          // 牵着人时需要至少 2 个空位（自己+她），独自时 1 个就够
          const need = leashHeld.size > 0 ? 2 : 1;
          if (limit > 0 && limit - count < need) return false;
          if ((r.BlockCategory ?? []).includes("Leashing") && leashHeld.size > 0) return false;
          return true;
        });
        if (filtered.length === 0) {
          const reasons: string[] = [];
          if (merged.length > 0) {
            if (merged.some((r) => kickedRooms.has(r.Name ?? ""))) reasons.push("部分被踢过");
            if (merged.some((r) => (r.MemberLimit ?? 0) > 0 && (r.MemberLimit ?? 0) - (r.MemberCount ?? 0) < (leashHeld.size > 0 ? 2 : 1))) reasons.push("满员");
            if (merged.some((r) => (r.BlockCategory ?? []).includes("Leashing") && leashHeld.size > 0)) reasons.push("禁牵绳");
          }
          console.log(`[bot] room_move query "${intent.query}" 无可进房（合并 ${merged.length} 间，拦因: ${reasons.join("/") || "全无结果"}）`);
          client.sendChat(
            merged.length === 0
              ? `（皱眉）"${intent.query}"——搜了一圈没找到这么一间房。`
              : `（皱眉）"${intent.query}"搜到几间，但${reasons.join("、")}，进不去。换个别的吧。`
          );
          return;
        }
        // 永远 LLM 仲裁（定向命中排前面=LLM 看到的"按相关度排序"），候选上限 60 间防 prompt 过大
        const chosenName = await pickBestRoomFromCandidates(
          intent.query,
          filtered.slice(0, 60).map((r) => ({
            Name: r.Name!,
            Description: r.Description ?? "",
            MemberCount: r.MemberCount ?? 0,
            MemberLimit: r.MemberLimit ?? 0,
          }))
        );
        if (!chosenName) {
          const list = filtered
            .slice(0, 3)
            .map((r) => `"${r.Name}"（${r.MemberCount ?? "?"}/${r.MemberLimit || "∞"}）`)
            .join("、");
          client.sendChat(
            `（翻了翻列表）"${intent.query}"搜到 ${filtered.length} 间像的——${list}${filtered.length > 3 ? "……" : ""}，但都不太对，你换个说法我再找找？`
          );
          return;
        }
        console.log(`[bot] room_move query: LLM 仲裁选中 "${chosenName}"（候选 ${filtered.length} 间）`);
        room = chosenName;
        joinedLabel = `"${chosenName}"`;
      } else {
        // 找房：先找达标热闹房，找不到退而求其次去人数最多的（深夜兜底，同 gohome 策略）
        room = await gohomePickBusyRoom([], spaceArg);
        if (!room) room = await gohomePickMostCrowdedRoom(spaceArg);
        if (!room) {
          console.log(`[bot] room_move: ${spaceLabel}没有能进的房`);
          client.sendChat(`（皱眉）${spaceLabel}现在连一间能进的房都没有……回头再说吧。`);
          return;
        }
        joinedLabel = `${spaceLabel}的 "${room}"`;
      }
      // 换房 + 被踢自动换下一间（#75b）：门槛房（账号天数 bot，如 YeS 要求 ≥30 天）
      // 通常进房 1-2 秒内踢人。进房信号由 onRoomReady 自动发（roomMoveDragging=true 时不清空
      // leashHeld 且每次进房都 beep，她客户端跟着最新房名走），4 秒复查稳定性：
      // 被踢/失败 → 被踢房已进黑名单 → 重新找房换下一间接她，最多试 3 间。
      // #75g 慢动作台词提前发：换房要 6~16 秒（进房+等她跟来），台词若攒到最后发，
      // "我牵着你过去"这类出发语会变成"人已经到了才说要走"的时态错乱。
      // 改为动身前发（校验已过、即将换房），失败兜底台词照旧失败时说，衔接自然。
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      console.log(`[bot] room_move: 去${joinedLabel}（手里牵着 ${leashHeld.size} 人）`);
      const heldNos = [...leashHeld]; // 快照：兜底（roomMoveDragging 下不会被清，双保险）
      const prevRoom = client.currentRoom; // #75f 失败回原房用（她还在那儿等着）
      let finalRoom: string | null = null;
      let candidate: string | null = room;
      roomMoveDragging = true;
      try {
        for (let attempt = 0; attempt < 3 && candidate; attempt++) {
          // #75d 回家模式带 createIfMissing：房被回收了就地重建（switchRoom 内已处理建房竞态）
          const joinedNow = await client.switchRoom(
            candidate,
            intent.home ? { createIfMissing: true, description: "ljzsbot 的家" } : undefined
          );
          if (!joinedNow) {
            console.log(`[bot] room_move: 进 "${candidate}" 失败，换下一间（${attempt + 1}/3）`);
          } else {
            // 快照兜底：万一就绪处理器的自动 beep 因时序没发到，这里补发一次
            for (const no of heldNos) client.sendLeashBeep(no);
            await sleep(4000); // 门槛房踢人观察窗
            if (client.currentRoom === joinedNow) {
              finalRoom = joinedNow;
              break;
            }
            console.log(
              `[bot] room_move: "${joinedNow}" 进房后被踢（current=${client.currentRoom ?? "无"}），换下一间接人（${attempt + 1}/3）`
            );
          }
          // 重新找房：被踢/失败房已进黑名单（onJoinFailed 记录），gohomePickBusyRoom 自动排除；
          // 定向房被踢后同样退化为按区找房（她点名那间进不去，找间热闹的补偿她）；
          // #75d 回家模式例外：家永远重试同一间（createIfMissing 会重建，黑名单不拦自己的家）；
          // #75f 好友房例外：她要找的是人不是热闹——不兜底换房，失败回原房交代
          if (intent.home) {
            candidate = room;
            await sleep(2000);
          } else if (intent.friend) {
            candidate = null;
          } else {
            candidate = await gohomePickBusyRoom([], spaceArg);
            if (!candidate) candidate = await gohomePickMostCrowdedRoom(spaceArg);
          }
        }
      } finally {
        roomMoveDragging = false;
      }
      if (!finalRoom) {
        // 全进不去：30 秒重试定时器会把 BOT 接回家（joinRetryTimer），这里只交代台词
        if (intent.friend) {
          // #75f 好友房进不去：回原来的房找她（她没收到任何 beep 不会动）
          console.log(`[bot] room_move: 好友房进不去，回原房 "${prevRoom ?? "无"}"`);
          if (prevRoom) {
            await client.switchRoom(prevRoom, prevRoom === config.roomName ? { createIfMissing: true } : undefined);
          }
          client.sendChat(`（皱眉）${joinedLabel}……我进不去。看来得让她出来接咱们，或者换个地方。`);
        } else {
          console.log(`[bot] room_move: 连试几间都进不去，先回家`);
          client.sendChat("（皱眉）接连几间都进不去……先回家待着，回头再带你出来。");
        }
        return;
      }
      // #75c 等她跟来（同 gohome 模式）：8 秒没到催一次信号，再等 8 秒；没跟上的松绳放人
      for (const no of heldNos) {
        let followed = client.getCharacter(no) != null;
        if (!followed) {
          await sleep(8000);
          followed = client.getCharacter(no) != null;
          if (!followed) {
            client.sendLeashBeep(no);
            await sleep(8000);
            followed = client.getCharacter(no) != null;
          }
        }
        if (!followed) {
          console.log(`[bot] room_move: #${no} 没跟来——松绳放人`);
          leashHeld.delete(no);
          client.sendChatAction("StopHoldLeash", [{ SourceCharacter: client.player.MemberNumber ?? -1 }, { TargetCharacter: no }]);
          client.sendHidden("StopHoldLeash", no);
        } else {
          console.log(`[bot] room_move: #${no} 跟过来了 ✓`);
          // #75h 到房重新握绳：握持状态不随人跨房走。BOT 先到、她后到——
          // 必须等她人进了房再广播 HoldLeash（一到房就发=牵空气，目标不在房间广播无效）。
          // 她是被牵过来的，脖子上必然有绳；接收端仍会自行校验，无绳则忽略（无害）。
          await sleep(1000); // 刚进房客户端就绪缓冲
          client.sendChatAction("HoldLeash", [{ SourceCharacter: client.player.MemberNumber ?? -1 }, { TargetCharacter: no }]);
          client.sendHidden("HoldLeash", no);
          console.log(`[bot] room_move: 重新握住 #${no} 的绳`);
        }
      }
      lastRoomMoveAt = Date.now();
      const dragged = leashHeld.size > 0 ? `，牵着 ${leashHeld.size} 人一起` : "";
      recentChat.push(`[换房] 你带人去了${joinedLabel}（现房 "${finalRoom}"）${dragged}。`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      rememberOwn(`（带她换到 "${finalRoom}"）`);
      break;
    }

    case "cold_treatment": {
      // #48 真冷处理：暴怒档专属。代码层接下来几轮真沉默（runRespond 拦截），
      // 服软累计 2 次 / 轮数到 3 / 2 分钟超时 / 安全词 → 破冰。
      if (!config.angerEnabled) return;
      if (anger.getMood().level !== "暴怒") {
        console.log(`[bot] cold_treatment rejected: mood=${anger.getMood().level}（仅暴怒档可用）`);
        return;
      }
      punishment.startColdTreatment();
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      recentChat.push(`[冷处理] 你决定不再理她——不再回应、不再解释，让她自己反省。`);
      if (recentChat.length > MAX_RECENT) recentChat.shift();
      console.log(`[bot] cold_treatment: BOT 进入真沉默（冷处理开始）`);
      break;
    }

    case "item_remove": {
      if (!intent.slot || !intent.target) return;
      // 拒绝 item_remove：打日志 + 给用户一条解释（和 item_lock/item_unlock 同模式，不再静默）
      const reject = (reason: string, userMsg: string): never => {
        console.log(`[bot] item_remove rejected: ${reason}`);
        client.sendChat(userMsg);
        recentChat.push(`${botName()} (me): ${userMsg}`);
        return undefined as never;
      };
      if (!checkRemovableSlot(intent.slot)) {
        return reject(`slot "${intent.slot}" not removable`, "这个部位的东西我现在拿不下来。");
      }
      const targetNo = client.resolveMemberNumber(intent.target);
      if (targetNo === null) {
        return reject(`target "${intent.target}" not found`, "人不在，我够不着。");
      }
      // 带锁道具：官方 Validation 不允许直接移除上锁的道具（会被接收端回滚，
      // 表现就是"BOT 说解开了、游戏里却没动作"）。处理：自动先解开锁（复用
      // item_unlock 流程：去锁字段 + ActionUnlock 公告 + 缓存记账），再移除。
      const slotEntry = findSlotEntry(targetNo, intent.slot);
      const slotProp =
        slotEntry && typeof slotEntry.Property === "object" && slotEntry.Property !== null
          ? (slotEntry.Property as Record<string, unknown>)
          : null;
      if (slotEntry?.Name && slotProp && slotProp.LockedBy != null) {
        const lockName = String(slotProp.LockedBy);
        const lockCN = LOCKS[lockName]?.cn ?? lockName;
        const botNo = client.player.MemberNumber ?? 0;
        const unlockedProp = stripLockProperty(slotProp);
        client.sendItemUpdate(targetNo, intent.slot, slotEntry.Name, { property: unlockedProp });
        client.sendChatAction(
          "ActionUnlock",
          buildUnlockActionDictionary(botNo, targetNo, intent.slot, slotEntry.Name)
        );
        markOwnItemOp(targetNo, intent.slot, slotEntry.Name);
        client.updateCachedItem(targetNo, intent.slot, slotEntry.Name, { property: unlockedProp });
        console.log(
          `[bot] item_remove: ${slotEntry.Name} 上有${lockCN}，已自动先解锁再移除 -> ${client.nameOf(targetNo)}`
        );
      }
      client.sendItemUpdate(targetNo, intent.slot, null);
      markOwnItemOp(targetNo, intent.slot, null);
      // 服务器不向发送者回显自己的操作（item_put/adjust 都靠这条本地记账，
      // item_remove 也必须同步删掉，否则 self-target 的 remove 后 BOT 自己的外观缓存
      // 永远挂在那件道具 → 后续 LLM 误判"我嘴还被堵着"）。对外人无所谓，因为服务器
      // 会广播 ChatRoomSyncItem 把 handleSyncItem 触发，缓存会自动更新。
      client.updateCachedItem(targetNo, intent.slot, null);
      const isSelfRm = targetNo === (client.player.MemberNumber ?? -1);
      // self-target 脱下道具后，单道具通道服务器不落库，必须整包写库否则重启"复活"（见 client.sendCharacterUpdate）
      if (isSelfRm) client.sendCharacterUpdate();
      // 脱下公告（官方 Dialog.js:1884 → ActionRemove）：让房间内其他人看到 BOT 真的摘了东西。
      // self-target 不发（没意义）；如果道具带锁，前面已经发过 ActionUnlock，这里只发"移除"动作本身，
      // 保持官方"先解锁后移除"的两步链。
      if (!isSelfRm && slotEntry?.Name) {
        const botNo = client.player.MemberNumber ?? 0;
        client.sendChatAction(
          "ActionRemove",
          buildRemoveActionDictionary(botNo, targetNo, intent.slot, slotEntry.Name)
        );
      }
      console.log(`[bot] item_remove: ${intent.slot}${slotEntry?.Name ? ` (${slotEntry.Name})` : ""} -> ${client.nameOf(targetNo)}${isSelfRm ? " (self)" : ""}`);
      rememberOwn(isSelfRm
        ? `（解除了自己的${zoneCN(intent.slot)}道具）`
        : `（解除了 ${client.nameOf(targetNo)} 的${zoneCN(intent.slot)}道具）`);
      if (intent.text) {
        client.sendChat(intent.text, "Chat");
        rememberOwn(intent.text);
      }
      break;
    }

    default:
      break;
  }
}

/** 连续重复内容去重，避免刷屏 */
function dedupe(text: string): boolean {
  if (text === lastSentText) return true;
  lastSentText = text;
  return false;
}

/** 剥掉 LLM 可能在 emote 文本首尾误加的星号（游戏端会自动包 *...*） */
function stripAsterisks(text: string): string {
  let t = text.trim();
  while (t.length >= 2 && t.startsWith("*") && t.endsWith("*")) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function mentionsBot(content: string, botName: string): boolean {
  if (!botName) return false;
  return content.toLowerCase().includes(botName.toLowerCase());
}

/** 判断服务对象的话是否包含安全词（支持逗号/顿号分隔多个） */
function mentionsSafeWord(content: string): boolean {
  const words = (config.safeWord ?? "")
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (words.length === 0) return false;
  return words.some((w) => content.toLowerCase().includes(w.toLowerCase()));
}

/** 检测测试模式开/关口令。返回 true=开启、false=关闭、null=不是口令 */
function detectTestModeToggle(content: string): boolean | null {
  const c = content.trim();
  if (!c.includes("测试模式") && !c.includes("正常模式")) return null;
  if (TEST_MODE_OFF_PHRASES.some((p) => c.includes(p))) return false;
  if (TEST_MODE_ON_PHRASES.some((p) => c.includes(p))) return true;
  return null;
}

/**
 * #48-B 检测怒气测试口令（仅测试模式下由调用方使用）。
 * 支持：怒气=60 / 怒气= 60 / 怒气 +20 / 怒气-10（等号/加减号两侧可有空格）。
 * 返回 {op, value} 或 null。
 */
function detectAngerCommand(content: string): { op: "=" | "+" | "-"; value: number } | null {
  const m = content.trim().match(/^怒气\s*([=+\-])\s*(\d{1,3})$/);
  if (!m) return null;
  const value = parseInt(m[2], 10);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return { op: m[1] as "=" | "+" | "-", value };
}

/**
 * #47-B 检测亲密度测试口令（仅测试模式下由调用方使用）。
 * 支持：亲密度=60 / 亲密度 +20 / 亲密度-10。返回 {op, value} 或 null。
 */
function detectIntimacyCommand(content: string): { op: "=" | "+" | "-"; value: number } | null {
  const m = content.trim().match(/^亲密度\s*([=+\-])\s*(\d{1,3})$/);
  if (!m) return null;
  const value = parseInt(m[2], 10);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return { op: m[1] as "=" | "+" | "-", value };
}

/** 测试模式切换确认：立即生效，发一条系统级消息告知用户（不经过 LLM，避免切换失败） */
function announceTestMode(serveName: string): void {
  const text = testMode
    ? `[测试模式] 已开启——${serveName}，我会无条件配合你的指令，不调戏不拖延。测试结束后记得说"关闭测试模式"恢复人设。`
    : `[测试模式] 已关闭——人设恢复正常，${serveName}，该有的规矩还是要有的。`;
  client.sendChat(text, "Chat");
  recentChat.push(`[系统] ${text}`);
  if (recentChat.length > MAX_RECENT) recentChat.shift();
  console.log(`[bot] TEST MODE ${testMode ? "ON" : "OFF"}`);
}

/** 判断服务对象的话是否属于"拒绝/抗拒"语义，用于触发 Dom 的坚定模式 */
function isRefusalKeyword(content: string): boolean {
  const c = content.toLowerCase();
  return REFUSAL_KEYWORDS.some((kw) => c.includes(kw.toLowerCase()));
}

/** 判断服务对象是否明确要"动用拒绝次数"（比 isRefusalKeyword 更精确） */
function isRefusalTokenUse(content: string): boolean {
  return REFUSAL_TOKEN_PHRASES.some((p) => content.includes(p));
}

/** 安全词触发：立即停止支配，切换到温柔安抚（aftercare）。代码层兜底，不依赖 LLM 临场判断。 */
function triggerAftercare(name: string): void {
  recentChat.push(`[系统] 安全词已触发，你已停止支配，正在温柔安抚 ${name}。`);
  if (recentChat.length > MAX_RECENT) recentChat.shift();

  const lines = [
    `${name}，好，我停下了。别怕，我在。`,
    `${name}，缓一缓，慢慢呼吸，我不逼你。`,
    `${name}，不闹了。告诉我，你现在需要什么？`,
    `${name}，没事了。先歇一下，我陪着你。`,
  ];
  const text = lines[Math.floor(Math.random() * lines.length)];
  client.sendChat(text, "Chat");
  console.log(`[bot] SAFEWORD triggered — aftercare: ${text}`);
  rememberOwn(text);
}

/** 判断某个发言者是否是一对一服务对象。支持注册号（数字）或昵称/注册名。 */
function isServeMember(senderNo: number | undefined, senderName: string): boolean {
  const target = config.serveMember;
  if (!target) return false;
  const t = target.trim().toLowerCase();
  if (!t) return false;
  if (/^\d+$/.test(t)) return senderNo === Number(t);
  // 文字：同时比昵称和注册名
  const c = senderNo !== undefined ? client.getCharacter(senderNo) : undefined;
  const names = [senderName, c?.Nickname, c?.Name]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.toLowerCase());
  return names.includes(t) || names.some((n) => n.includes(t));
}

client
  .connect()
  .then(() => {
    client.login();
  })
  .catch((err) => {
    console.error("[bc] failed to start:", (err as Error).message);
    process.exit(1);
  });

process.on("SIGINT", () => {
  console.log("\n[bc] shutting down");
  client.disconnect();
  process.exit(0);
});
