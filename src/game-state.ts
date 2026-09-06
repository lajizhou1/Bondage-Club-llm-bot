import * as fs from "fs";
import * as path from "path";

/**
 * 结构化游戏状态存储（跨重启持久化）。
 *
 * 与 memory.ts 的区别：
 *  - memory.ts 存的是「自由文本事实」（LLM 提取，中文句子，注入 prompt）。
 *  - 本模块存的是「结构化数值状态」（代码直接读改写），例如：
 *      · 拒绝次数（服务对象赢了二十四点后 +1，说「我拒绝」消耗一次）
 *      · 速度能力分析（BOT 记录她答题速度，动态缩短限时）
 *      · 二十四点的历史战绩（连赢/连输，用于微调回合数与限时）
 *  这类数据不该混进 LLM 的文本记忆里，会被提取逻辑污染或截断。
 */

export interface SpeedProfile {
  /** 累计完成的回合数（样本量） */
  samples: number;
  /** 平均每题耗时（秒），累计均值 */
  avgSeconds: number;
  /** 最快单题耗时（秒） */
  fastestSeconds: number;
  /** 最慢单题耗时（秒） */
  slowestSeconds: number;
}

export interface TwentyFourStats {
  /** 历史局数 */
  gamesPlayed: number;
  /** 服务对象累计赢的回合数 */
  serveWins: number;
  /** BOT 累计赢的回合数 */
  botWins: number;
  /** 当前连赢/连输（正=服务对象连赢，负=BOT连赢，0=无） */
  streak: number;
}

export interface GohomeStats {
  /** 历史局数 */
  gamesPlayed: number;
  /** 她赢（限时内解锁回家）的局数 */
  serveWins: number;
  /** BOT 赢（超时/认输/作弊/放鸽子）的局数 */
  botWins: number;
  /** 她当前连胜局数（输了清零）——动态限时用：赢得越多限时越短 */
  winStreak: number;
}

export interface GameStateData {
  version: 1;
  /** 服务对象的「拒绝次数」（赢二十四点 +1，说「我拒绝」消耗一次） */
  refusalTokens: number;
  /** 二十四点答题速度分析（用于动态缩短限时） */
  speed: SpeedProfile;
  /** 二十四点战绩（用于微调回合数与限时） */
  twentyfour: TwentyFourStats;
  /** 限时回家战绩（2026-09-06 独立：此前混记进 twentyfour 污染了数据；
   *  动态限时用——她连胜越多，下局限时基线越短） */
  gohome: GohomeStats;
}

const DEFAULTS: GameStateData = {
  version: 1,
  refusalTokens: 0,
  speed: { samples: 0, avgSeconds: 0, fastestSeconds: 0, slowestSeconds: 0 },
  twentyfour: { gamesPlayed: 0, serveWins: 0, botWins: 0, streak: 0 },
  gohome: { gamesPlayed: 0, serveWins: 0, botWins: 0, winStreak: 0 },
};

export class GameStateStore {
  private data: GameStateData;
  private file = path.resolve(process.cwd(), "data", "game-state.json");

  constructor() {
    this.data = this.load();
  }

  private load(): GameStateData {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<GameStateData>;
        return {
          ...DEFAULTS,
          ...raw,
      speed: { ...DEFAULTS.speed, ...(raw.speed ?? {}) },
      twentyfour: { ...DEFAULTS.twentyfour, ...(raw.twentyfour ?? {}) },
      gohome: { ...DEFAULTS.gohome, ...(raw.gohome ?? {}) },
        };
      }
    } catch (err) {
      console.error("[game-state] failed to load, using defaults:", (err as Error).message);
    }
    return structuredClone(DEFAULTS);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("[game-state] failed to save:", (err as Error).message);
    }
  }

  // ---- 拒绝次数 ----

  get refusalTokens(): number {
    return this.data.refusalTokens;
  }

  /** 拒绝次数 +1（服务对象赢二十四点后调用） */
  grantRefusalToken(): number {
    this.data.refusalTokens += 1;
    this.save();
    return this.data.refusalTokens;
  }

  /**
   * 尝试消耗一次拒绝次数（服务对象说「我拒绝」时调用）。
   * 返回 true=成功消耗（BOT 必须接受拒绝），false=没有次数可消耗。
   */
  consumeRefusalToken(): boolean {
    if (this.data.refusalTokens <= 0) return false;
    this.data.refusalTokens -= 1;
    this.save();
    return true;
  }

  // ---- 速度分析 ----

  get speed(): SpeedProfile {
    return this.data.speed;
  }

  /** 记录一次答题耗时（秒），更新累计均值与极值 */
  recordAnswerTime(seconds: number): void {
    const s = this.data.speed;
    if (s.samples === 0) {
      s.avgSeconds = seconds;
      s.fastestSeconds = seconds;
      s.slowestSeconds = seconds;
    } else {
      s.avgSeconds = (s.avgSeconds * s.samples + seconds) / (s.samples + 1);
      s.fastestSeconds = Math.min(s.fastestSeconds, seconds);
      s.slowestSeconds = Math.max(s.slowestSeconds, seconds);
    }
    s.samples += 1;
    this.save();
  }

  // ---- 二十四点战绩 ----

  get twentyfour(): TwentyFourStats {
    return this.data.twentyfour;
  }

  /** 记录一局结束（outcome: 服务对象 win / bot win） */
  recordGameResult(outcome: "serve" | "bot"): void {
    const t = this.data.twentyfour;
    t.gamesPlayed += 1;
    if (outcome === "serve") {
      t.serveWins += 1;
      t.streak = t.streak >= 0 ? t.streak + 1 : 1;
    } else {
      t.botWins += 1;
      t.streak = t.streak <= 0 ? t.streak - 1 : -1;
    }
    this.save();
  }

  /** 记录单回合胜负（不结算整局，仅累计回合胜负数） */
  recordRound(outcome: "serve" | "bot"): void {
    if (outcome === "serve") this.data.twentyfour.serveWins += 1;
    else this.data.twentyfour.botWins += 1;
    this.save();
  }

  // ---- 限时回家战绩（2026-09-06 独立命名空间） ----

  get gohome(): GohomeStats {
    return this.data.gohome;
  }

  /**
   * 记录一局限时回家的胜负（win=她限时内回家 / bot=超时、认输、作弊、放鸽子）。
   * ⚠️ 只在正式结算时调用——consent 拒绝、作废局不算。
   */
  recordGohomeResult(outcome: "serve" | "bot"): void {
    const g = this.data.gohome;
    g.gamesPlayed += 1;
    if (outcome === "serve") {
      g.serveWins += 1;
      g.winStreak += 1;
    } else {
      g.botWins += 1;
      g.winStreak = 0; // 输了连胜清零，限时基线回满
    }
    this.save();
  }

  /** 调试/清空：重置全部游戏状态 */
  reset(): void {
    this.data = structuredClone(DEFAULTS);
    this.save();
  }
}
