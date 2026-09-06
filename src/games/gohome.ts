import { GameRule, GameRuleContext, GameState, GameTurnResult } from "../game";
import { config } from "../config";
import * as fs from "fs";
import * as path from "path";

// ===========================================================================
// #16 限时回家规则模块（gohome.ts）
// ---------------------------------------------------------------------------
// 玩法（2026-09-04/05 用户定稿）：
//   1.【准备】BOT 按用户设计的束缚套装快照给她重穿 + 全部上无限期主人锁
//      （OwnerPadlock——2026-09-05 23:52 定案：锁不承载时间，限时/惩罚全由 BOT 计时；
//      她本人可自助解开是"BOT 掉线不锁死"的安全兜底）。
//   2.【转场】BOT 抓起牵绳，跨房牵绳（Leash beep 机制）把她牵到热闹房
//      （人数≥4、BlockCategory 不含 Leashing——超时才牵得回来）。
//   3.【布置】BOT 解开并取下牵绳，换上宠物标牌（CustomCollarTag，写求助文字），
//      标牌上专属锁（ExclusivePadlock：除她本人外任何人都能解，她自己解不开）。
//      然后对她说完规则就回家（ljzbot）等着。
//   4.【等待】她向热闹房里的路人求助解开标牌，然后自己走回家。限时默认 30 分钟。
//      - 胜利 = 到家且标牌已解（严格判定）
//      - 超时 = BOT 去她那儿解开标牌、上好牵绳把她牵回来 = 她失败
//   5.【结算】奖惩暂不挂（用户：奖惩先不急）。
//
// 架构说明：本游戏的编排（换房/穿脱道具/牵绳）都在 index.ts 的 orchestrator
// （runGohomeGame / gohomeHandleTimeout 等），因为它需要 client 与 executeIntent；
// 本模块只管：触发口令、状态机字段、超时判定、prompt 状态注入、跨重启落盘。
// ===========================================================================

/** 游戏阶段（编排器驱动流转，落盘跨重启）。consent=规则广播后等她点头同意，点头才动手 */
export type GohomePhase = "consent" | "preparing" | "transferring" | "setup" | "waiting" | "settling";

export interface GohomeState {
  phase: GohomePhase;
  /** 本局开始时间戳(ms) */
  startedAt: number;
  /** 等点头窗口的截止时间戳(ms)；0 = 不在等（点头后/未开局） */
  consentDeadlineAt: number;
  /** 等待期截止时间戳(ms)；0 = 未开始计时（准备/转场/布置阶段） */
  deadlineAt: number;
  /** 限时（分钟） */
  limitMin: number;
  /** 热闹房名（超时 fetch 的目的地） */
  busyRoom: string;
  /** 家（=config.roomName） */
  homeRoom: string;
  /** 标牌上写的求助文字 */
  tagText: string;
  /** 编排器是否正在跑（防 onTimeout 与编排器打架） */
  orchestrating: boolean;
  /** 转场时她是否跟来了（诊断用） */
  followedOk: boolean;
  /** 本局采样区（2026-09-05 用户需求：每局 50/50 随机选一个区，全程只在该区找房。
   *  "" = 女性专属区，"X" = 混合区；未设置（旧档/未开局）= 家所在区（config.roomSpace）。
   *  背景跨区牵引极易失败，所以与家不同区时：开局牵不动她 → 好友 Beep 叫她自己走过来；
   *  收场牵不回她 → 当众宣布 + 摘绳，让她自己走回家。 */
  space?: string;
}

export function makeGohomeState(limitMin: number, homeRoom: string, tagText: string): GohomeState {
  return {
    phase: "consent",
    startedAt: Date.now(),
    consentDeadlineAt: 0,
    deadlineAt: 0,
    limitMin,
    busyRoom: "",
    homeRoom,
    tagText,
    orchestrating: true,
    followedOk: false,
  };
}

// ---------------------------------------------------------------------------
// 跨重启落盘（data/gohome-state.json）
// ---------------------------------------------------------------------------

// 注意两级 ".."：本文件在 src/games/ 子目录，编译后在 dist/games/——
// 只写一级 ".." 会解析到 dist/data/（2026-09-05 实测踩坑：状态存进了 dist，
// npm run build 清空 dist 时整局游戏状态会丢）
const STATE_FILE = path.resolve(__dirname, "..", "..", "data", "gohome-state.json");

export function saveGohomeState(state: GohomeState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), "utf-8");
  } catch (err) {
    console.log(`[gohome] 状态落盘失败: ${(err as Error).message}`);
  }
}

export function loadGohomeState(): GohomeState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as GohomeState;
    if (typeof raw?.phase === "string" && typeof raw?.startedAt === "number") return raw;
    return null;
  } catch {
    return null;
  }
}

export function clearGohomeState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch {
    /* 清不掉也无妨 */
  }
}

// ---------------------------------------------------------------------------
// 惩罚计时持久化（data/gohome-punish.json）—— 2026-09-05 23:52 无限期主人锁方案
// 方案：开局束缚全部上无限期 OwnerPadlock（锁不承载时间），惩罚时长由 BOT 计时，
// 到点 BOT 主动解锁脱下（executePunishRelease）。
// pending=true：收场时她不在场（下线/跑路）欠着，等她下次进 BOT 房间再挂计时/释放；
// pending=false：锁在她身上、计时进行中（跨重启有效，重启后重新挂定时器）。
// ---------------------------------------------------------------------------

export interface GohomePunishState {
  /** 惩罚到期时间戳（ms）——Date.now() >= until 即可释放 */
  until: number;
  /** 当时的失败原因（台词用） */
  reason: "timeout" | "surrender" | "cheat";
  /** 欠下/上锁时间（ms） */
  createdAt: number;
  /** true=她不在场欠着，进房时结算；false=计时进行中 */
  pending: boolean;
}

const PUNISH_FILE = path.resolve(__dirname, "..", "..", "data", "gohome-punish.json");

export function savePunishState(p: GohomePunishState): void {
  try {
    fs.mkdirSync(path.dirname(PUNISH_FILE), { recursive: true });
    fs.writeFileSync(PUNISH_FILE, JSON.stringify(p, null, 1), "utf-8");
  } catch (err) {
    console.log(`[gohome] 惩罚计时落盘失败: ${(err as Error).message}`);
  }
}

export function loadPunishState(): GohomePunishState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(PUNISH_FILE, "utf-8")) as GohomePunishState;
    if (typeof raw?.until === "number" && raw.until > 0) return raw;
    return null;
  } catch {
    return null;
  }
}

export function clearPunishState(): void {
  try {
    if (fs.existsSync(PUNISH_FILE)) fs.unlinkSync(PUNISH_FILE);
  } catch {
    /* 清不掉也无妨 */
  }
}

// ---------------------------------------------------------------------------
// 触发口令 / 结算口令
// ---------------------------------------------------------------------------

/** 开局口令（服务对象说） */
export const GOHOME_TRIGGER_RE = /限时回家|回家游戏|遛我出去|放我出去挑战/;

/** 游戏内认输（= 她失败收场，BOT 去接） */
export const GOHOME_GIVEUP_RE = /不玩了|我认输|我放弃|认输了/;

/** 游戏内问进度 */
export const GOHOME_STATUS_RE = /还剩多久|还有多少时间|现在怎么样|进度/;

/** #69 动态限时的预注入通道（2026-09-06 02:28 实测事故）：
 *  index.ts 在调 handleServeMessage（内部会 tryStart + 广播规则）【之前】就算好限时塞进来，
 *  这样 startAnnouncement 里写的才是真实数字（旧顺序公告先用 15 兜底值、实际后定 12，数字造假）。 */
let pendingGohomeLimitMin: number | null = null;
export function setPendingGohomeLimitMin(n: number): void {
  pendingGohomeLimitMin = n;
}
function takePendingGohomeLimitMin(): number | null {
  const v = pendingGohomeLimitMin;
  pendingGohomeLimitMin = null;
  return v;
}

// ---------------------------------------------------------------------------
// 规则模块（接入 GameManager）
// ---------------------------------------------------------------------------

export const gohomeRule: GameRule = {
  id: "gohome",
  name: "限时回家",

  tryStart(ctx: GameRuleContext): GameState | null {
    // 前置校验（套装/所有权/同房间）在 index.ts 的触发拦截里做过了；
    // 这里只认口令。真正开始计时是【布置】结束、BOT 回家安顿好之后（orchestrator 设置 deadlineAt）。
    if (!GOHOME_TRIGGER_RE.test(ctx.message)) return null;
    const state = makeGohomeState(0, "", ""); // limitMin/homeRoom/tagText 由 index.ts 编排器补齐
    // 2026-09-06 02:28 实测事故修复：index.ts 现在在广播规则【之前】就把动态限时算好塞进来
    // （旧顺序：先广播（用 15 兜底值）→ 再算限时 → 公告数字 15 与实际 12 不符）。
    // 读一次即清，防止残留到下一局。
    (state as GohomeState).limitMin = takePendingGohomeLimitMin() ?? 15; // 兜底值：LLM 决策失败时 index.ts 直接用基线，不会走到这
    console.log(`[gohome] 开局：${ctx.serveName} 说 "${ctx.message.slice(0, 20)}"`);
    return state as unknown as GameState;
  },

  startAnnouncement(state: GameState): string {
    const s = state as unknown as GohomeState;
    // 2026-09-05 21:12 用户实测反馈：规则挤在一大段阅读体验差，用 \n 分段（BC 聊天支持换行）
    return (
      `[限时回家] 好，规矩先说清楚——\n` +
      `\n` +
      `我会把你按我记好的那身束缚穿好、全部上我的主人锁，然后牵着你去一个热闹的房间，` +
      `把牵绳换成一块上了专属锁的宠物标牌——那锁除了你自己，谁都能解开。\n` +
      `\n` +
      `限时 ${s.limitMin} 分钟——这是我看了你最近的战绩定的。**你每连胜一局，我下次就收紧你的时间**；输一局，恢复原样。\n` +
      `**怎么算赢**：向陌生人求助解开封印、**把牌子去掉**、自己走回家。\n` +
      `赢了我不但把这一身提前全解开，还记你一功。\n` +
      `\n` +
      `**输了有三种下场**：\n` +
      `① 超时被我牵回来 → 罚锁 ${config.gohomePunishBaseMin} 分钟\n` +
      `② 中途发**好友 Beep** 认输（打开好友菜单找到我按私聊按钮） → 罚锁 ${config.gohomePunishBaseMin} 分钟**加剩余时间翻倍**（越早认罚越多）\n` +
      `③ 解了锁却把牌子戴在脖子上跑回家 → **作弊**，罚锁同认输**还要看我脸色**\n` +
      `④ 若这局去了另一个区：我 Beep 叫你过去后 ${Math.max(1, Math.round(config.gohomeReunionTimeoutSec / 60))} 分钟内没到 → 按玩满 0 分钟直接认输，罚锁最高档\n` +
      `罚锁的时长我亲自计时，到点我亲手给你解开——别指望锁自己到点开。\n` +
      `\n` +
      `规则就是这些——慢慢看，有疑问尽管问。\n` +
      `看明白了就**点头**：你一点头我就动手，不点头，我一步都不会动。`
    );
  },

  onMessage(ctx: GameRuleContext): GameTurnResult {
    const s = ctx.state as unknown as GohomeState;
    const m = ctx.message;

    // 认输 = 她失败收场
    if (GOHOME_GIVEUP_RE.test(m)) {
      return {
        consumed: true,
        ended: true,
        outcome: "lose",
        reply: `[限时回家] 认输了？好——那这局算你输。待在原地别乱跑，我去接你。`,
        rewardText: "她主动认输：限时回家以失败收场（BOT 去接她回家）",
      };
    }

    // 问进度：报剩余时间（等待期才有意义；其他阶段交给 LLM 自由发挥）
    if (s.deadlineAt > 0 && GOHOME_STATUS_RE.test(m)) {
      const remainMs = s.deadlineAt - ctx.now;
      if (remainMs <= 0) {
        return { consumed: true, ended: false, reply: "[限时回家] 时间已经到了。" };
      }
      const remainMin = Math.ceil(remainMs / 60000);
      return {
        consumed: true,
        ended: false,
        reply: `[限时回家] 还剩 ${remainMin >= 60 ? `${Math.floor(remainMin / 60)} 小时 ${remainMin % 60} 分` : `${remainMin} 分钟`}。`,
      };
    }

    // 其余消息不拦截：她在热闹房跟路人说话 / 跟 BOT 说话，都走正常对话流程
    // （BOT 在家里隔着房间看不到她说什么——这些消息只会在同房间时出现）。
    return { consumed: false, ended: false };
  },

  describeState(ctx: GameRuleContext): string {
    const s = ctx.state as unknown as GohomeState;
    // 等点头阶段：还没开始，她在看规则/提问——提示 LLM 好好解答，别动手
    if (s.phase === "consent") {
      return (
        `限时回家·等她点头同意：规则刚讲完（限时 ${s.limitMin} 分钟，解标牌回家=赢，超时被牵回=输）。` +
        `她点头之后才会开始上束缚——现在她若提问就认真解答，别急着动手，也别重复念规则。`
      );
    }
    const phaseCN: Record<GohomePhase, string> = {
      consent: "等她点头同意（点头才开始）",
      preparing: "准备中（给她穿束缚套装+上主人锁）",
      transferring: "转场中（牵着她在路上/前往热闹房）",
      setup: "布置中（换宠物标牌+上专属锁）",
      waiting: "等待中（她在热闹房求助，BOT 在家等她回来）",
      settling: "结算中",
    };
    let timePart = "";
    if (s.deadlineAt > 0) {
      const remainMs = s.deadlineAt - Date.now();
      if (remainMs > 0) {
        const remainMin = Math.ceil(remainMs / 60000);
        timePart = `，限时还剩 ${remainMin} 分钟`;
      } else {
        timePart = "，限时已到（超时收场）";
      }
    }
    let spacePart = "";
    if (s.space !== undefined && s.space !== config.roomSpace) {
      spacePart = `本局在${s.space === "" ? "女区" : s.space === "X" ? "混区" : s.space}进行（跨区局：牵不动她，需要她自己走）。`;
    }
    return (
      `限时回家进行中：阶段=${phaseCN[s.phase]}${timePart}。${spacePart}` +
      `她需要向路人求助解开脖子上的宠物标牌（专属锁，她自己解不开），然后回 ${s.homeRoom || "家"}。` +
      `到家且已解=她赢；超时=你去 ${s.busyRoom || "她所在的房间"} 接她回来=她输。` +
      `她在等待期随时可以发好友 Beep 主动认输（代码层自动处理，不需要你管）。`
    );
  },

  // 超时轮询：只在"等待期已开始计时 + 编排器不在跑"时判定
  onTimeout(ctx: GameRuleContext): GameTurnResult | null {
    const s = ctx.state as unknown as GohomeState;
    if (s.deadlineAt <= 0) return null; // 还没开始计时
    if (s.orchestrating) return null;   // 编排器在跑（转场/接人流程中），别插手
    if (ctx.now < s.deadlineAt) return null; // 没到点
    return {
      consumed: true,
      ended: true,
      outcome: "lose",
      reply: "",
      rewardText: "限时到了：她没能解开封印回到家——BOT 出发去接她（游戏以她失败收场）",
    };
  },
};
