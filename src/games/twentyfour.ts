import { GameRule, GameRuleContext, GameState, GameTurnResult, RewardAction, GameOutcome } from "../game";
import { GameStateStore } from "../game-state";

// ===========================================================================
// #21 二十四点规则模块
// ---------------------------------------------------------------------------
// 规则（2026-09-04 用户确认）：
//   - 单方答题：每回合发四张牌，考服务对象凑 24 点。答对=服务对象赢该回合，
//     答错/超时=BOT 赢该回合。BOT 不出牌、不答题。
//   - 回合数：基准 10 回合，但 BOT 可动态增加回合，**保证最后一回合是 BOT 赢**
//     （即游戏结束时，最后一回合必须是服务对象答错/超时）。
//   - 限时：从 5 分钟起步。BOT 记住服务对象答题速度，分析能力逐步缩短限时，
//     卡在「既能赢也能输」的临界区间（写入 game-state.json）。
//   - 奖励（服务对象赢整局）：拒绝次数 +1（默认 0，说「我拒绝」消耗一次）。
//   - 惩罚（服务对象输）：渐进式束缚，顺序 脚→腿→眼罩→牵绳→手→嘴，
//     开局全空、逐级叠加。嘴上束缚会导致无法作答（言语不清），所以嘴放最后。
//     · 若在 10 回合内被上到「嘴」束缚 → 游戏直接结束 + 全体已上束缚锁定时锁 15 分钟。
//     · 若最后一回合是 BOT 赢、但服务对象嘴没被束缚 → 也追加全体已上束缚锁定时锁 15 分钟。
//
// 设计原则（对齐项目坑）：
//   - 发牌、判 24 点、回合计数、限时计算全部在代码层，LLM 只主持台词。
//   - 渐进束缚的「道具」与「上锁」都是白名单内的真实技能。
// ===========================================================================

// ---- 二十四点判定算法 ----

/** 发四张牌（1~13，A=1，J/Q/K=11/12/13） */
function dealCards(): number[] {
  const cards: number[] = [];
  for (let i = 0; i < 4; i++) cards.push(1 + Math.floor(Math.random() * 13));
  return cards;
}

/** 判断四张牌是否有解（能否用 + - * / 和括号凑出 24）。回溯 + 枚举两两合并。 */
function hasSolution(nums: number[]): boolean {
  const target = 24;
  const EPS = 1e-9;

  function solve(list: number[]): boolean {
    if (list.length === 1) return Math.abs(list[0] - target) < EPS;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const rest: number[] = [];
        for (let k = 0; k < list.length; k++) {
          if (k !== i && k !== j) rest.push(list[k]);
        }
        const a = list[i], b = list[j];
        const candidates: number[] = [a + b, a - b, b - a, a * b];
        if (Math.abs(b) > EPS) candidates.push(a / b);
        if (Math.abs(a) > EPS) candidates.push(b / a);
        for (const c of candidates) {
          if (solve([...rest, c])) return true;
        }
      }
    }
    return false;
  }

  return solve(nums);
}

/** 发四张「有解」的牌（无解则重发，保证服务对象有机会答对）。
 *  注意：这个函数本身是可靠的——while 重试 + hasSolution 校验能保证发出的牌一定有解。
 *  2026-09-04 曾误以为它失效（发出 A,K,A,A "无解"），实际 A,K,A,A = [1,13,1,1]
 *  有解 (13-1)×(1+1)=24，是 LLM 在主持台词时自己算错、错误宣布无解。
 *  根因在 brain.ts 的 GAME HOSTING prompt 约束不足，已在那里补硬规则；此处逻辑不动。 */
function dealSolvableCards(): number[] {
  let cards = dealCards();
  let guard = 0;
  while (!hasSolution(cards) && guard++ < 1000) cards = dealCards();
  return cards;
}

/** 卡片显示名（用于 prompt / 公告） */
function cardLabel(n: number): string {
  if (n === 1) return "A";
  if (n === 11) return "J";
  if (n === 12) return "Q";
  if (n === 13) return "K";
  return String(n);
}

/**
 * 解析并验证服务对象输入的算式。
 * 规则：只允许数字、+ - * /、括号、空格；四个数字必须恰好等于发的四张牌（各用一次）；
 * 结果必须 = 24（容差内）。
 * 返回 { ok, value }，value 为计算结果（ok=false 时可能是错误信息码）。
 */
function evalExpression(expr: string, cards: number[]): { ok: boolean; value?: number; reason?: string } {
  // 0) 归一化：把中文输入法打出来的全角字符转成半角，避免全角括号/乘除号被误判为非法。
  //    服务对象常打 全角（）×÷，以及全角数字/空格。
  const normalized = expr
    .replace(/[（）]/g, (ch) => (ch === "（" ? "(" : ")"))
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
  // 1) 提取所有数字
  const used = (normalized.match(/\d+/g) ?? []).map(Number);
  // 2) 允许的字符：数字、空白、+ - * / ( ) . 
  if (/[^0-9+\-*/()\s.]/.test(normalized)) {
    return { ok: false, reason: "算式里有非法字符，只能用数字和 + - * / 括号" };
  }
  // 3) 数字必须恰好等于发的四张牌（多重集相等）
  const expected = [...cards].sort((a, b) => a - b);
  const got = [...used].sort((a, b) => a - b);
  if (got.length !== 4 || got.some((v, i) => v !== expected[i])) {
    return { ok: false, reason: "必须恰好使用发到的四张牌（每张一次）" };
  }
  // 4) 安全求值（用 Function 构造，但已通过白名单字符校验）
  try {
    // 用归一化后的表达式求值；已确认只含数字/运算符/括号/空白/小数点
    const value = new Function(`"use strict"; return (${normalized});`)() as number;
    if (typeof value !== "number" || !isFinite(value)) {
      return { ok: false, reason: "算式结果不是有效数字" };
    }
    if (Math.abs(value - 24) < 1e-6) {
      return { ok: true, value: 24 };
    }
    return { ok: false, reason: `结果是 ${value}，不是 24` };
  } catch {
    return { ok: false, reason: "算式格式不对，无法计算" };
  }
}

// ---- 渐进束缚顺序 ----
// 顺序：脚 → 腿 → 眼罩 → 牵绳 → 手 → 嘴（嘴最后，因为嘴上束缚导致无法作答）
type BindStage = "feet" | "legs" | "blindfold" | "leash" | "hands" | "mouth";

const BIND_STAGES: BindStage[] = ["feet", "legs", "blindfold", "leash", "hands", "mouth"];

/** 每个阶段对应的穿戴动作（item_put） */
const BIND_ITEM: Record<BindStage, RewardAction> = {
  // 脚铐（LeatherAnkleCuffs）是 TYPED 道具（复制自 SteelAnkleCuffs 配置）。
  // 2026-09-04 用户指示：改成「连接锁链」变体 Chained（Effect:Slow，双踝间拖一条锁链）。
  feet: { kind: "item_put", item: "LeatherAnkleCuffs", variant: "Chained", desc: "脚铐（连接锁链，拖住她的双脚）" },
  // 腿铐（LeatherLegCuffs）：TYPED 道具，BC 官方变体 None/Closed/Chained。
  // 2026-09-04 用户指示：不指定 variant，戴默认 None 变体（纯装饰，仅外观）。之前尝试过加 variant:"Chained" 但用户回滚。
  legs: { kind: "item_put", item: "LeatherLegCuffs", desc: "腿铐（仅外观）" },
  blindfold: { kind: "item_put", item: "LeatherBlindfold", desc: "眼罩（剥夺她的视野）" },
  leash: { kind: "item_put", item: "CollarLeash", desc: "牵引绳（拴住她的脖颈）" },
  // 手铐（LeatherCuffs）是 TYPED 道具，默认变体 None 是 Effect:[] + SelfUnlock:true（不束缚、不可锁）。
  // 必须指定 Wrist（腕缚背扣，Block+BlockWardrobe）才能真正束缚并可上锁（2026-09-04 实测踩坑）。
  hands: { kind: "item_put", item: "LeatherCuffs", variant: "Wrist", desc: "手铐（锁住她的双手）" },
  // 口球（BallGag）是 TYPED 道具，戴上必须带 TypeRecord，否则缺变体信息、锁被接收端回滚。
  mouth: { kind: "item_put", item: "BallGag", variant: "Normal", desc: "口球（封住她的嘴）" },
};

const BIND_STAGE_CN: Record<BindStage, string> = {
  feet: "脚", legs: "腿", blindfold: "眼罩", leash: "牵绳", hands: "手", mouth: "嘴",
};

// 「全体已上束缚锁定时锁」需要上锁的道具（这些都在可锁白名单 LOCKABLE_ITEMS 内）
const LOCK_ALL_ITEMS: { item: string; cn: string }[] = [
  { item: "LeatherAnkleCuffs", cn: "脚铐" },
  { item: "LeatherLegCuffs", cn: "腿铐" },
  { item: "LeatherBlindfold", cn: "眼罩" },
  { item: "CollarLeash", cn: "牵引绳" },
  { item: "LeatherCuffs", cn: "手铐" },
  { item: "BallGag", cn: "口球" },
];

// ---- 会话状态（挂 GameState）----
interface TFSessionState {
  /** 基准回合数（10）+ 动态增加的回合 */
  totalRounds: number;
  /** 当前进行到第几回合（1 起） */
  round: number;
  /** 当前回合的牌 */
  cards: number[];
  /** 当前回合限时（秒） */
  timeLimitSec: number;
  /** 当前回合开始时间戳 */
  turnStartAt: number;
  /** 已上到的束缚阶段索引（0=还没上，1=已上脚，...6=已上嘴） */
  bindLevel: number;
  /** 本局服务对象答对的回合数 */
  serveWins: number;
  /** 本局 BOT 赢的回合数 */
  botWins: number;
}

const BASE_ROUNDS = 10;
const BASE_TIME_LIMIT_SEC = 5 * 60; // 5 分钟起步
const MIN_TIME_LIMIT_SEC = 20; // 缩短的下限，避免根本来不及
const TIME_DECAY_STEP = 15; // 每缩短一次的步长（秒）

// ---- 动态限时：根据速度分析缩短 ----
function computeTimeLimit(store: GameStateStore): number {
  const sp = store.speed;
  // 没有足够样本 → 用起步限时
  if (sp.samples < 3) return BASE_TIME_LIMIT_SEC;
  // 平均每题耗时（秒）* 安全系数：给 1.8 倍余量，卡在「既能赢又能输」的临界。
  // 加 10 秒缓冲，避免一缩短就必输。
  const target = Math.round(sp.avgSeconds * 1.8 + 10);
  // 夹在 [MIN, BASE] 之间
  return Math.max(MIN_TIME_LIMIT_SEC, Math.min(BASE_TIME_LIMIT_SEC, target));
}

// ---- 动态回合数：保证最后一回合 BOT 赢 ----
// 核心：游戏结束时最后一回合必须是 BOT 赢。
// 若按基准 10 回合打完、但最后一回合是服务对象赢（游戏会以她赢结束），
// 则「追加一个回合」并让这一回合成为 BOT 赢的收尾。
// 实现上：不预先算死总回合数，而是在每一回合结束时判断「是否该收尾」。
//   - 当 round >= BASE_ROUNDS（打到基准回合数之后），若当前回合是服务对象赢，
//     则再延长一回合；若当前回合是 BOT 赢，则在此收尾（最后一回合=BOT 赢）。
//   - 这样自然保证：最后一回合（收尾回合）一定是 BOT 赢。

/** 是否已经到了「可以收尾」的阶段（即 round >= BASE_ROUNDS） */
function canFinish(state: TFSessionState): boolean {
  return state.round >= BASE_ROUNDS;
}

/**
 * 检查服务对象当前外观里是否已有任何 ItemNeck 道具（满足 CollarLeash 等的 Prerequisite="Collared"）。
 * appearance 是只读数组（来自 client.getAppearance），元素形如 { Group, Name, ... }。
 */
function targetHasItemNeck(appearance: ReadonlyArray<unknown> | undefined): boolean {
  if (!appearance) return false;
  for (const raw of appearance) {
    const e = raw as { Group?: string; Name?: string };
    if (e.Group === "ItemNeck" && typeof e.Name === "string" && e.Name.length > 0) return true;
  }
  return false;
}

// ---- 规则模块 ----
export const twentyFourRule: GameRule = {
  id: "twentyfour",
  name: "二十四点",

  // 开局指令：服务对象说「来玩二十四点 / 24点 / 二十一点（口语）」
  tryStart(ctx: GameRuleContext): GameState | null {
    const m = ctx.message;
    if (!/二十四点|24点|二四点|二十一点|凑24|凑二十四/.test(m)) return null;
    const store = new GameStateStore();
    const cards = dealSolvableCards();
    const state: TFSessionState = {
      totalRounds: BASE_ROUNDS,
      round: 1,
      cards,
      timeLimitSec: computeTimeLimit(store),
      turnStartAt: ctx.now,
      bindLevel: 0,
      serveWins: 0,
      botWins: 0,
    };
    console.log(`[24] 开局：${cards.map(cardLabel).join(" ")}，限时 ${state.timeLimitSec}s`);
    return state as unknown as GameState;
  },

  startAnnouncement(state: GameState): string {
    const s = state as unknown as TFSessionState;
    const cards = s.cards.map(cardLabel).join("、");
    const min = Math.floor(s.timeLimitSec / 60);
    const sec = s.timeLimitSec % 60;
    const time = min > 0 ? `${min} 分${sec ? ` ${sec} 秒` : ""}` : `${sec} 秒`;
    return (
      `[二十四点] 牌面：${cards}。用 + - × ÷ 和括号把它们凑成 24。` +
      `本回合限时 ${time}，答对=你赢这一回合，答错或超时=我赢。`
    );
  },

  onMessage(ctx: GameRuleContext): GameTurnResult {
    const s = ctx.state as unknown as TFSessionState;

    // 超时检查
    const elapsed = Math.floor((ctx.now - s.turnStartAt) / 1000);
    if (elapsed >= s.timeLimitSec) {
      // 超时 = BOT 赢该回合
      s.botWins += 1;
      return thisTurnResult(ctx, s, "timeout", null);
    }

    // 尝试解析算式
    const trimmed = ctx.message.trim();
    const evalRes = evalExpression(trimmed, s.cards);

    if (!evalRes.ok) {
      // 答错：记录耗时（惩罚前），BOT 赢
      const store = new GameStateStore();
      store.recordAnswerTime(elapsed);
      s.botWins += 1;
      return thisTurnResult(ctx, s, "wrong", evalRes.reason ?? "答错了");
    }

    // 答对：服务对象赢该回合
    const store = new GameStateStore();
    store.recordAnswerTime(elapsed);
    s.serveWins += 1;
    return thisTurnResult(ctx, s, "correct", null);
  },

  describeState(ctx: GameRuleContext): string {
    const s = ctx.state as unknown as TFSessionState;
    const cards = s.cards.map(cardLabel).join("、");
    const remaining = Math.max(0, s.timeLimitSec - Math.floor((Date.now() - s.turnStartAt) / 1000));
    const bound = s.bindLevel > 0 ? BIND_STAGES.slice(0, s.bindLevel).map((x) => BIND_STAGE_CN[x]).join("→") : "无";
    return (
      `二十四点进行中：第 ${s.round} 回合，牌面 ${cards}，剩余 ${remaining} 秒。` +
      `当前比分 你:${s.serveWins} 我:${s.botWins}。` +
      `已上束缚：${bound}（${s.bindLevel}/6 级）。`
    );
  },

  // 超时轮询：服务对象不发言也照样计时，超时 = BOT 赢该回合
  onTimeout(ctx: GameRuleContext): GameTurnResult | null {
    const s = ctx.state as unknown as TFSessionState;
    const elapsed = Math.floor((ctx.now - s.turnStartAt) / 1000);
    if (elapsed < s.timeLimitSec) return null; // 还没超时
    // 超时 = BOT 赢该回合
    s.botWins += 1;
    // 注意：超时**不**记录答题耗时。超时意味着「她没做出来/限时对她太紧」，
    // 不是「她用了这么久做出来」。若把满时限（如 100s）当速度样本记录，
    // 会拉高 avgSeconds，让 computeTimeLimit 越算越长、限时永远无法收敛。
    // 速度分析只应吸收「答对/答错」时的真实 elapsed（下方 onMessage）。
    return thisTurnResult(ctx, s, "timeout", null);
  },

  settle(outcome: GameOutcome, ctx: GameRuleContext): RewardAction | RewardAction[] | null {
    const store = new GameStateStore();
    // 本游戏服务对象永远赢不了整局（outcome 只会是 lose / abort）。
    // 若未来某机制让它 win，这里仍兜底：拒绝次数 +1（机制保留但本游戏不触发）。
    if (outcome === "win") {
      const tokens = store.grantRefusalToken();
      store.recordGameResult("serve");
      return {
        kind: "none",
        desc: `奖励：拒绝次数 +1（现在共 ${tokens} 次）。说「我拒绝」可消耗一次让我接受你的拒绝。`,
      };
    }
    // 服务对象输：惩罚动作已在 thisTurnResult 里组装（渐进束缚 + 全体锁），这里只记录战绩。
    store.recordGameResult("bot");
    return null;
  },
};

/**
 * 每回合结束时的统一处理：决定是否进入下一回合、是否渐进束缚、是否结算。
 * 这是二十四点的核心状态机。
 */
function thisTurnResult(
  ctx: GameRuleContext,
  s: TFSessionState,
  result: "correct" | "wrong" | "timeout",
  detail: string | null
): GameTurnResult {
  const serveWon = result === "correct";

  // 1) 记录回合胜负
  // （onMessage 里已记录）

  // 2) 渐进束缚推进：只有 BOT 赢的回合才上束缚（服务对象答对不惩罚）
  let boundActions: RewardAction[] = [];
  let mouthTriggered = false;
  if (!serveWon) {
    // BOT 赢 → 上一级束缚
    if (s.bindLevel < BIND_STAGES.length) {
      const stage = BIND_STAGES[s.bindLevel];
      // Prerequisite 兜底：CollarLeash 要求对方脖子上有 ItemNeck 道具。
      // 若还没有，先 item_put 一个皮革项圈满足前置，再 item_put CollarLeash。
      // 这样做可能让"服务对象 脖子上多一条项圈"被 LLM 注意到，但能保证牵绳真正戴上去。
      if (stage === "leash" && !targetHasItemNeck(ctx.serveAppearance)) {
        boundActions.push({
          kind: "item_put",
          item: "LeatherCollar",
          desc: "先给脖颈补一条皮革项圈，作为牵绳的前置",
        });
      }
      boundActions.push(BIND_ITEM[stage]);
      s.bindLevel += 1;
      if (stage === "mouth") mouthTriggered = true;
    }
  }

  // 3) 判断是否结算
  //    结算条件（游戏只会以「服务对象输」结束）：
  //      a. 嘴上束缚触发 → 游戏直接结束（她输）
  //      b. 已到可收尾阶段（round >= BASE_ROUNDS）且本回合是 BOT 赢 → 收尾（最后一回合=BOT 赢，她输）
  //    服务对象赢整局的路径在本游戏不存在。
  const shouldEnd = mouthTriggered || (canFinish(s) && !serveWon);

  if (shouldEnd) {
    // 组装惩罚动作序列：渐进束缚道具（含可能的项圈前置）+ 全体已上束缚上 15 分钟主人锁
    const actions: RewardAction[] = [...boundActions];
    // 全体上锁：给「已上」的束缚上主人锁（bindLevel 之前的所有阶段 + 本次刚上的）
    // 用 OwnerPadlock（无定时）+ BOT 代码层 setTimeout 的原因（2026-09-04 #21 选型，09-05 查证更正注释）：
    //   【旧注释的"Timer 系锁 RemoveTimer:300 → 5 分钟挣扎自动开"是误读，机制已查证如下】
    //   Asset.RemoveTimer:300 只是玩家 UI 上锁时的初始默认时长；BOT wire 发的 Property.RemoveTimer
    //   （绝对 ms）会被接收端原样接受（Validation.js:952 仅 clamp MaxTimer 上限），到点由佩戴者客户端
    //   自动广播 TimerRelease。挣扎与 RemoveTimer 无关；#21 当年滑脱根因是 TYPED 默认变体
    //   SelfUnlock:true（#22/#45 已修）。
    //   继续用 OwnerPadlock 的实际理由：惩罚何时结束由 BOT 说了算（不给倒计时提示，压迫感更强），
    //   OwnerOnly 让 服务对象 无法自己解锁，唯一打开路径是 BOT 主动 item_unlock——24 点惩罚语义更贴合。
    // 15 分钟后由 BOT 端代码层 setTimeout 主动解锁（index.ts item_lock 完成路径注册）。
    // 前提：服务对象 必须已把 BOT 设为 Owner（之前已建立——00:25 实测过 OwnerPadlock 成功），否则 item_lock
    // 在 ownerOnly 校验时被拒绝，BOT 会发"主人锁要等你接受我的归属邀请"提示。
    if (s.bindLevel > 0) {
      for (let i = 0; i < s.bindLevel; i++) {
        const stage = BIND_STAGES[i];
        // 2026-09-04 #48 实测：6 个 item_lock 一次性 push → executeReward 同步循环 → 6 个
        // ChatRoomCharacterItemUpdate 在同一帧送出。BC 的单道具通道是非事务广播，
        // herokuapp 服务端/接收端对同一 Target + 不同 Group 的快速批量 ItemUpdate
        // 似乎有 silenciosa 截断：实测 Payload 全 print 正确（Property.Difficulty=100 +
        // SelfUnlock=false + LockedBy），但 服务对象 客户端上 ItemMouth（口球）/ ItemArms（手铐）
        // 没显示锁且 12 秒内 slipped off，而 ItemFeet/Legs/Head 都生效。
        // 修复：逐条 staggerMs 250ms 间隔，错开发送，绕过"同帧批量互踩"。
        // 第一条立即发，后续每条 prev + 250ms。
        actions.push({
          kind: "item_lock",
          item: BIND_ITEM[stage].item!,
          lock: "OwnerPadlock",
          desc: `给${BIND_STAGE_CN[stage]}上 15 分钟主人锁（15 分钟后自动解开）`,
          staggerMs: i === 0 ? 0 : 250,
        });
      }
    }

    const mouthDesc = mouthTriggered
      ? "你的嘴被口球封住，无法继续作答——游戏直接结束。"
      : "最后一回合我赢，游戏结束。";

    const store = new GameStateStore();
    store.recordGameResult("bot");

    return {
      consumed: true,
      ended: true,
      outcome: "lose",
      reply: mouthDesc + (actions.length ? " 现在追加全体束缚的定时锁惩罚。" : ""),
      rewardText: mouthDesc,
      rewardIntent: actions,
    };
  }

  // 4) 未结算 → 进入下一回合，发新牌
  s.round += 1;
  s.cards = dealSolvableCards();
  s.turnStartAt = ctx.now;
  const store = new GameStateStore();
  s.timeLimitSec = computeTimeLimit(store);

  let reply = "";
  if (serveWon) {
    reply = `答对了，你赢这一回合。`;
  } else {
    reply = detail
      ? `${detail}，这一回合我赢。`
      : `答错了/超时，这一回合我赢。`;
  }
  if (boundActions.length) {
    // 多步（如 leash 前先补项圈）只说最后一步的 desc 当面话，避免一句塞太多
    const last = boundActions[boundActions.length - 1];
    if (last.desc) reply += ` 作为惩罚，给你${last.desc}。`;
  }
  const cards = s.cards.map(cardLabel).join("、");
  const min = Math.floor(s.timeLimitSec / 60);
  const sec = s.timeLimitSec % 60;
  const time = min > 0 ? `${min} 分${sec ? ` ${sec} 秒` : ""}` : `${sec} 秒`;
  reply += ` 下一回合牌面：${cards}，限时 ${time}。`;

  return {
    consumed: true,
    ended: false,
    reply,
    rewardIntent: boundActions.length ? boundActions : undefined,
  };
}
