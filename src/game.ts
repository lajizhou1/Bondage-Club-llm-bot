// ===========================================================================
// #20 通用游戏框架
// ---------------------------------------------------------------------------
// 目标：BOT 与服务对象玩"规则游戏"（二十四点 / 限时回家 / 未来新游戏）的公共基础设施。
// 核心验收标准：每个新游戏只写自己的规则模块（实现 GameRule 接口）接入，**不改框架代码**。
//
// 框架职责：
//  1. 会话状态机：idle → active → 结算（win/lose/draw/abort）→ 回到 idle；
//     同一时间只允许一个游戏会话。
//  2. 消息拦截：游戏进行中，服务对象的消息优先交给规则模块判定（答题/指令），
//     判定结果回传给 index.ts 组织 LLM 台词，或由规则模块直接给出文本。
//  3. 状态注入：把游戏状态（规则要点/当前回合/比分/剩余时间）注入每轮 prompt。
//  4. 奖惩钩子：胜负结算后执行奖励/惩罚（复用 item_put/item_adjust/item_lock 等 skill），
//     内容由规则模块预设，或交给 LLM 决定。
//  5. 超时与强退：回合超时判定；安全词/拒绝/中止口令立即终止游戏。
//  6. 代码层规则执行：算术/计时/判定一律在代码层做（不靠 LLM 心算），LLM 只负责台词。
//
// 设计原则（对齐本项目反复踩过的坑）：
//  - 确定性计算优先于 LLM 推理（发牌、判 24 点、计时都在代码层）。
//  - 游戏状态注入 prompt 用明确标签，避免 LLM 被旧对话带偏。
//  - 安全词优先级最高：一旦触发，无条件中止游戏并走 aftercare。
// ===========================================================================

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 游戏会话状态 */
export type GamePhase = "idle" | "active" | "ended";

/** 单局结果 */
export type GameOutcome = "win" | "lose" | "draw" | "abort";

/**
 * 规则模块处理一条服务对象消息后返回的"判定结果"。
 * 框架据此决定：继续游戏 / 结算 / 交给 LLM 组织台词 / 什么都不做。
 */
export interface GameTurnResult {
  /**
   * 这条消息是否被规则模块"吃掉"了（即它属于游戏内答题/指令，不再走常规对话流程）。
   * true = 消息已由规则模块处理，index.ts 不要把它当普通聊天再次触发 respond。
   */
  consumed: boolean;
  /**
   * 规则模块想让 BOT 说的话（可直接发送，也可由 index.ts 交给 LLM 润色）。
   * 若非空，index.ts 直接用它；若空但 consumed=true，则走 LLM 组织台词。
   */
  reply?: string;
  /** 本回合结束后游戏是否结算 */
  ended: boolean;
  /** 结算结果（ended=true 时有效） */
  outcome?: GameOutcome;
  /** 结算时规则模块想附加的奖励/惩罚说明（喂给 LLM 或直接执行） */
  rewardText?: string;
  /** 结算时规则模块预设的奖励/惩罚动作（复用现有 Intent 动作字段，由 index.ts 执行）。
   *  支持单个或多个（渐进束缚等需要多步：戴道具 + 上锁）。 */
  rewardIntent?: RewardAction | RewardAction[];
}

/**
 * 奖励/惩罚动作（复用现有技能能力的最小描述）。
 * index.ts 把它翻译成真正的技能调用（item_put / item_adjust / item_lock / item_remove）。
 *
 * 规则模块通常不必手拼字段——用 RewardCatalog 里的预设模板（见下方），
 * 或从 RewardCatalog.get(name) 拿到现成的动作对象即可。
 */
export interface RewardAction {
  kind: "item_put" | "item_adjust" | "item_lock" | "item_unlock" | "item_remove" | "none";
  item?: string; // item_put / item_adjust / item_lock / item_remove 用
  variant?: string; // item_put 变体
  adjust?: string; // item_adjust 方向 / item_put 组合调节
  lock?: string; // item_lock 锁具
  combination?: string; // item_lock 数字密码（4 位，CombinationPadlock 用）
  timerMin?: number; // item_lock 定时时长（分钟）
  slot?: string; // item_remove 槽位
  /** 目标：默认服务对象；"(me)" 表示 BOT 自己 */
  target?: string;
  /**
   * 奖惩的「人话说明」（喂给 LLM 组织结算台词的提示，非强制）。
   * 例如「惩罚：口球 + 数字密码锁」——LLM 据此用 Dom 语气宣布惩罚内容。
   */
  desc?: string;
  /**
   * 在执行本条之前等多久（毫秒）。
   * 作用：让批量发的 `item_lock` / `item_put` 不要在同一帧里挤掉对方（BC 的单道具通道广播是非事务的，
   * 同帧多条 ItemUpdate 服务端/接收端可能丢失最后几条——2026-09-04 #48 实测 6 条锁里面 ItemMouth /
   * ItemArms 不生效）。
   * 默认 0，立即执行；非 0 时 executeReward 会按顺序 await sleep。
   */
  staggerMs?: number;
}

// ---------------------------------------------------------------------------
// 奖惩动作库（RewardCatalog）
// ---------------------------------------------------------------------------
// 设计目标：让规则模块（二十四点 / 限时回家 / 未来新游戏）引用「中文名」就能拿到
// 一个填好全部字段、可被 index.ts 直接执行的动作，不必重复拼 item/lock/timerMin，
// 也避免拼错道具名 / 锁名 / 目标（本项目曾多次踩过「拼错字段导致接收端静默回滚」的坑）。
//
// 分层原则（对齐人设方向里反复强调的安全边界）：
//  - 「轻罚」= 可自行解开的短时玩具（口球、眼罩、定时锁、松紧调节）——保留支配感，不剥夺自主权。
//  - 「中罚」= 需要求助才能解开的束缚（单手套 + 密码锁、脚铐 + 定时锁）——有管教意味，但仍可脱身。
//  - 「重罚」= 需 BOT 亲手解开的长时间束缚（拘束衣、长时间定时锁）——强烈支配，但永远可喊安全词终止。
//  - 绝不预设任何「不可解/永久」动作；安全词始终凌驾于一切奖惩之上。
// ---------------------------------------------------------------------------

/** 奖励动作的预设模板（奖励一般「减负」，即松绑 / 摘下 / 放松） */
const REWARD_PRESETS: Record<string, RewardAction> = {
  // —— 奖励（减负方向）——
  "奖励·松开束缚": {
    kind: "item_adjust", adjust: "loosen_little",
    desc: "奖励：把束缚放松一点（体贴的奖赏）",
  },
  "奖励·摘下口塞": {
    kind: "item_remove", slot: "ItemMouth",
    desc: "奖励：取下她的口塞，让她能开口说话",
  },
  "奖励·摘下眼罩": {
    kind: "item_remove", slot: "ItemHead",
    desc: "奖励：摘下眼罩，让她重见光明",
  },
  "奖励·解开锁": {
    kind: "item_unlock", item: "LeatherCollar",
    desc: "奖励：解开项圈上的锁，放她一点自由",
  },
};

/** 惩罚动作的预设模板（惩罚一般「加负」，即上道具 / 上锁 / 收紧） */
const PUNISH_PRESETS: Record<string, RewardAction> = {
  // —— 轻罚（可自行解开的短时玩具）——
  "轻罚·口球": {
    kind: "item_put", item: "BallGag",
    desc: "惩罚：给她戴上一个口球（让她安静一会儿）",
  },
  "轻罚·眼罩": {
    kind: "item_put", item: "LeatherBlindfold",
    desc: "惩罚：给她戴上眼罩，剥夺视野",
  },
  "轻罚·定时锁项圈": {
    kind: "item_lock", item: "LeatherCollar", lock: "TimerPasswordPadlock", timerMin: 15,
    desc: "惩罚：给项圈上 15 分钟的定时锁",
  },
  "轻罚·定时锁脚铐": {
    kind: "item_lock", item: "LeatherAnkleCuffs", lock: "TimerPasswordPadlock", timerMin: 15,
    desc: "惩罚：给脚铐上 15 分钟的定时锁，限制她走动",
  },
  "轻罚·收紧绳缚": {
    kind: "item_adjust", adjust: "tighten_little",
    desc: "惩罚：把身上的绳缚收紧一点",
  },

  // —— 中罚（需求助才能脱身）——
  "中罚·单手套": {
    kind: "item_put", item: "LeatherArmbinder",
    desc: "惩罚：把她的双手收进皮革单手套，短时间内挣脱不开",
  },
  "中罚·单手套收紧": {
    kind: "item_put", item: "LeatherArmbinder", adjust: "tighten_little",
    desc: "惩罚：给她套上单手套并收紧，双手被牢牢锁住",
  },
  "中罚·密码锁口球": {
    kind: "item_lock", item: "BallGag", lock: "CombinationPadlock", combination: "6806",
    desc: "惩罚：给口球上数字密码锁（密码 6806），让她说不出话也解不开",
  },
  "中罚·密码锁脚铐": {
    kind: "item_lock", item: "LeatherAnkleCuffs", lock: "CombinationPadlock", combination: "6806",
    desc: "惩罚：给脚铐上数字密码锁，锁住她的行动",
  },
  "中罚·收紧绳缚": {
    kind: "item_adjust", adjust: "tighten_lot",
    desc: "惩罚：把束缚大大收紧",
  },

  // —— 重罚（需 BOT 亲手解）——
  "重罚·拘束衣": {
    kind: "item_put", item: "StraitJacket",
    desc: "惩罚：把她套进拘束衣，动弹不得",
  },
  "重罚·长时间定时锁": {
    kind: "item_lock", item: "LeatherCollar", lock: "TimerPasswordPadlock", timerMin: 60,
    desc: "惩罚：给项圈上 1 小时的定时锁，只有时间到了才能解开",
  },
  "重罚·驷马缚": {
    kind: "item_put", item: "HempRope_Arms", variant: "SimpleHogtie", adjust: "tighten_little",
    desc: "惩罚：用麻绳把她绑成驷马，再收紧一点",
  },
};

/**
 * 奖惩动作库：把中文动作名解析成可直接执行的 RewardAction。
 * 规则模块在 settle() / onTimeout() 里调用，例如：
 *   RewardCatalog.get("轻罚·口球") → RewardAction
 * 找不到时返回 null（规则模块应回退到「无奖惩」）。
 */
export const RewardCatalog = {
  /** 按中文名取预设动作（奖励 + 惩罚都支持） */
  get(name: string): RewardAction | null {
    return REWARD_PRESETS[name] ?? PUNISH_PRESETS[name] ?? null;
  },
  /** 列出全部预设动作名（调试 / 注入 prompt 用） */
  list(): { name: string; desc: string }[] {
    const out: { name: string; desc: string }[] = [];
    for (const [name, a] of Object.entries(REWARD_PRESETS)) out.push({ name, desc: a.desc ?? name });
    for (const [name, a] of Object.entries(PUNISH_PRESETS)) out.push({ name, desc: a.desc ?? name });
    return out;
  },
};

/** 规则模块需要感知的上下文（由 index.ts 每轮构造后传入） */
export interface GameRuleContext {
  /** 服务对象本轮发言原文（trim 后） */
  message: string;
  /** 服务对象显示名 */
  serveName: string;
  /** 当前时间戳（ms），用于计时 */
  now: number;
  /** 游戏是否处于测试模式（测试模式下规则可放宽/配合） */
  testMode: boolean;
  /** 规则模块可自由使用的会话数据（持久到本局结束） */
  state: GameState;
  /** 服务对象当前外观（含装备道具）。规则模块可读 Prerequisite/已穿依赖，例如戴 CollarLeash 前确认目标有 ItemNeck */
  serveAppearance?: ReadonlyArray<unknown>;
}

/** 单局游戏的可变状态（规则模块自定义字段挂在这里） */
export type GameState = Record<string, unknown>;

/**
 * 一个可接入框架的规则模块。
 * 每个新游戏实现这个接口即可，框架代码不改。
 */
export interface GameRule {
  /** 游戏唯一标识（如 "twentyfour" / "gohome"），用于日志和去重 */
  readonly id: string;
  /** 游戏显示名（中文），用于公告和 prompt 注入 */
  readonly name: string;
  /**
   * 尝试开局。返回 null 表示这条消息不是开局指令（或已拒绝开局）。
   * 返回非空则代表本局开始，返回值是开局后的状态（如发好的牌）。
   */
  tryStart(ctx: GameRuleContext): GameState | null;
  /**
   * 处理游戏进行中的一条服务对象消息，返回判定结果。
   * 框架保证只在 active 阶段调用。
   */
  onMessage(ctx: GameRuleContext): GameTurnResult;
  /**
   * 生成注入 prompt 的"当前游戏状态"文本（规则要点/回合/比分/剩余时间）。
   * 仅在 active 阶段调用。
   */
  describeState(ctx: GameRuleContext): string;
  /** 游戏内开局的公告文本（BOT 直接发送），可空串表示不公告 */
  startAnnouncement(state: GameState): string;
  /**
   * 结算时的奖惩处理。返回要执行的奖励/惩罚动作（可空表示无奖惩）。
   * 可返回单个或多个动作（渐进束缚需要多步）。
   * 框架在 ended 时调用一次。
   */
  settle?(outcome: GameOutcome, ctx: GameRuleContext): RewardAction | RewardAction[] | null;
  /**
   * 回合超时处理（框架每秒轮询一次，仅当构造时启用了超时轮询）。
   * 规则模块自行判断「当前回合是否超时」：
   *   - 返回 null = 尚未超时（继续等）；
   *   - 返回 GameTurnResult = 超时已处理（可能结算，也可能只是推进回合）。
   * 这允许每个游戏拥有自己的动态限时（例如二十四点按速度分析缩短限时）。
   */
  onTimeout?(ctx: GameRuleContext): GameTurnResult | null;
}

// ---------------------------------------------------------------------------
// 框架实现：游戏会话管理器
// ---------------------------------------------------------------------------

/** 一个正在进行的游戏会话 */
interface ActiveSession {
  rule: GameRule;
  state: GameState;
  startedAt: number;
  /** 最后一轮开始时间（用于回合超时） */
  lastTurnAt: number;
  /** 已超时标记（避免重复触发） */
  timedOut: boolean;
}

export class GameManager {
  private session: ActiveSession | null = null;
  /** 是否启用超时轮询（每秒一次，交给规则模块的 onTimeout 自行判断） */
  private pollEnabled: boolean;
  /** 超时检查定时器 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 超时结果回调（由 index.ts 注册）：规则模块超时处理结果由此回传执行。
   *  #16 起带规则模块参数——不同游戏的超时收场（如限时回家要出门接人）由 index.ts 分别处理。 */
  private onTimeoutResult: ((r: GameTurnResult, rule: GameRule) => void) | null = null;

  constructor(pollEverySec = 0) {
    this.pollEnabled = pollEverySec > 0;
    if (this.pollEnabled) {
      this.timer = setInterval(() => this.checkTimeout(), pollEverySec * 1000);
      this.timer.unref?.();
    }
  }

  /**
   * #16 跨重启恢复会话：直接把规则模块+状态装回管理器（不走 tryStart）。
   * 用于限时回家这类"游戏进行中 BOT 重启"的场景——状态由规则模块自行落盘，
   * 重启后由 index.ts 读回并调用本方法恢复计时/等待。
   */
  restoreSession(rule: GameRule, state: GameState): void {
    if (this.session) return; // 已有会话不覆盖
    this.session = { rule, state, startedAt: Date.now(), lastTurnAt: Date.now(), timedOut: false };
    console.log(`[game] restored session: ${rule.name} (${rule.id})`);
  }

  /** 注册超时结果回调（index.ts 调用，用于执行规则模块的超时处理结果） */
  setOnTimeoutResult(cb: (r: GameTurnResult, rule: GameRule) => void): void {
    this.onTimeoutResult = cb;
  }

  /** 当前是否有游戏在进行 */
  get active(): boolean {
    return this.session !== null;
  }

  /** 当前进行的规则模块（无则 null） */
  get currentRule(): GameRule | null {
    return this.session?.rule ?? null;
  }

  /** 当前会话状态（无则 null） */
  get currentState(): GameState | null {
    return this.session?.state ?? null;
  }

  /** 当前会话的规则上下文（规则模块超时判定用，无会话返回 null） */
  get currentContext(): GameRuleContext | null {
    if (!this.session) return null;
    return {
      message: "",
      serveName: "",
      now: Date.now(),
      testMode: false,
      state: this.session.state,
    };
  }

  /**
   * 供 index.ts 在 onChat 里调用：把服务对象的消息先交给游戏框架。
   * 返回 null 表示"消息与游戏无关，走常规流程"；
   * 返回 GameTurnResult 表示"消息已被游戏处理"。
   */
  async handleServeMessage(
    rule: GameRule | null,
    message: string,
    serveName: string,
    testMode: boolean
  ): Promise<GameTurnResult | null> {
    const now = Date.now();

    // 1) 没有进行中的游戏，且传入了规则模块 → 尝试开局
    if (this.session === null) {
      if (!rule) return null;
      const ctx: GameRuleContext = { message, serveName, now, testMode, state: {}, serveAppearance: this.currentServeAppearance() };
      const startState = rule.tryStart(ctx);
      if (startState === null) return null; // 不是开局指令，走常规流程
      this.session = { rule, state: startState, startedAt: now, lastTurnAt: now, timedOut: false };
      const announcement = rule.startAnnouncement(startState);
      console.log(`[game] started: ${rule.name} (${rule.id})`);
      return { consumed: true, reply: announcement || undefined, ended: false };
    }

    // 2) 有进行中的游戏 → 交给规则模块判定
    const s = this.session;
    const ctx: GameRuleContext = { message, serveName, now, testMode, state: s.state, serveAppearance: this.currentServeAppearance() };
    s.lastTurnAt = now;
    const result = s.rule.onMessage(ctx);

    // 3) 结算处理
    if (result.ended) {
      const outcome = result.outcome ?? "abort";
      let reward: RewardAction | RewardAction[] | null = null;
      if (s.rule.settle && outcome !== "abort") {
        reward = s.rule.settle(outcome, ctx);
      }
      this.session = null; // 结束会话（先清，避免重入）
      console.log(`[game] ended: ${s.rule.name} -> ${outcome}`);
      return {
        consumed: true,
        reply: result.reply,
        ended: true,
        outcome,
        rewardText: result.rewardText,
        rewardIntent: reward ?? result.rewardIntent ?? undefined,
      };
    }

    return result;
  }

  /** 供 index.ts 注入 prompt 用：当前游戏状态文本（无游戏返回空串） */
  describeState(): string {
    if (!this.session) return "";
    const s = this.session;
    return s.rule.describeState({ message: "", serveName: "", now: Date.now(), testMode: false, state: s.state });
  }

  /** 强制中止当前游戏（安全词 / 中止口令 / BOT 掉线等） */
  abort(reason: string): GameRule | null {
    if (!this.session) return null;
    const rule = this.session.rule;
    console.log(`[game] aborted: ${rule.name} (${reason})`);
    this.session = null;
    return rule;
  }

  /**
   * 注入「当前服务对象外观」提供器，规则模块可借此读到目标身上的道具（用于判断 prerequisite / 戴道具前的依赖检查）。
   * 由 index.ts 在游戏进行期间注册（每次游戏消息前可实时刷新）。
   */
  setServeAppearanceProvider(fn: () => ReadonlyArray<unknown> | undefined): void {
    this.serveAppearanceProvider = fn;
  }

  private serveAppearanceProvider: (() => ReadonlyArray<unknown> | undefined) | null = null;

  /** 当前 GameRuleContext 里需要的 serveAppearance 抓取 */
  private currentServeAppearance(): ReadonlyArray<unknown> | undefined {
    return this.serveAppearanceProvider ? this.serveAppearanceProvider() : undefined;
  }

  /** 回合超时轮询（每秒一次）：交给规则模块自行判断是否超时 */
  private checkTimeout(): void {
    if (!this.session || !this.pollEnabled) return;
    const s = this.session;
    if (!s.rule.onTimeout) return;
    const ctx: GameRuleContext = { message: "", serveName: "", now: Date.now(), testMode: false, state: s.state, serveAppearance: this.currentServeAppearance() };
    const result = s.rule.onTimeout(ctx);
    if (result === null) return; // 尚未超时
    // 规则模块判定超时 → 可能推进回合或结算
    if (result.ended) {
      // 结算：先结算奖惩，再清会话
      const outcome = result.outcome ?? "abort";
      let reward: RewardAction | RewardAction[] | null = null;
      if (s.rule.settle && outcome !== "abort") {
        reward = s.rule.settle(outcome, ctx);
      }
      this.session = null;
      console.log(`[game] timed-out and ended: ${s.rule.name} -> ${outcome}`);
      const finalResult: GameTurnResult = {
        ...result,
        ended: true,
        outcome,
        rewardIntent: reward ?? result.rewardIntent ?? undefined,
      };
      this.onTimeoutResult?.(finalResult, s.rule);
    } else {
      // 非结算（例如超时推进到下一回合）：原样回传
      this.onTimeoutResult?.(result, s.rule);
    }
  }

  /** 停止定时器（进程退出时调用） */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
