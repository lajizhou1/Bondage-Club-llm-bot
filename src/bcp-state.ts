import { describeActiveRules } from "./bcp-rules";

/**
 * #89 BC+ 第二步「听懂层」——把服务对象客户端**广播出来的** BC+ 公开数据，
 * 翻译成一句句中文，喂给 LLM（brain 的 serveBcpStatus）。
 *
 * ## 数据从哪来
 * BC+ 的 `DataSync` 模块会把「PublicData: true」的模块数据发给同房所有人（`utils/Messaging.ts`
 * 的 SendBCPMessage）。我们已经能收到（client.ts 的 `onBCPMessage` kind="sync"），
 * 这里负责把 payload 归类整理。实锤会收到的：
 *
 * | message | category | 内容 |
 * |---|---|---|
 * | `SettingSync` | (集合) | 进房时全量：`settings{slug→data}`，含合成类 `pet` / `hardcore` |
 * | `CategorySync` | `pet` | 宠物四项粗粒度等级 `{shareStats, levels:{food,water,sleep,affection}}` |
 * | `CategorySync` | 其它 | 该模块数据变化时的增量推送 |
 *
 * ## 为什么要"主动要一次"
 * BC+ 只在**自己进房**时广播全量；BOT 先进房、她后进房才收得到 SettingSync，
 * 反之收不到。但我方可以发一份 `{message:"SettingSync", settings:{}, reply:true}` 给她——
 * 她客户端 `onSettingSync` 见到 `reply===true` 就会**定向回发**一份她自己的全量数据
 * （DataSync.ts:211）。这就是 BC+ 官方的"请给我一份"握手，我们直接借用。
 *
 * ## 注意
 * - 这些数据是**公开广播**：房间里任何 BC+ 用户都能看到，不涉及隐私绕过。
 * - 只翻译我们认识的字段；不认识的一律不猜、不喂 LLM（避免幻觉）。
 * - 成员号转名字由调用方注入（bcp-state 不依赖 client，避免循环引用）。
 */

/** 从 client 侧传入的最小事件形状（避免 import client 造成循环依赖） */
export interface BcpSyncEvent {  kind: "reply" | "sync";
  message?: string;
  payload?: Record<string, unknown>;
  sourceNo: number;
  senderName: string;
}

/** 一个 BC+ 用户在房间里公开出来的状态 */
export interface BcpPeerState {
  memberNo: number;
  name: string;
  /** 对端 BC+ 版本 */
  version: string;
  updatedAt: number;
  /** 宠物四项（BC+ Pet 模块的合成公开数据）。shareStats=false 表示她关掉了共享 */
  pet?: { shareStats: boolean; levels: Record<string, number> };
  /** 她在 BC+ 里**手动指派**的 Co-Owner（副主人）成员号 */
  rolesOwners?: number[];
  /** 她在 BC+ 里**手动指派**的 Mistress（女主人）成员号 */
  rolesMistresses?: number[];
  /** 她建的自定义角色（名字 + 成员号） */
  customRoles?: { name: string; members: number[] }[];
  /** 权限表条目数（谁被允许做什么，几十项，只统计不逐条喂） */
  authorityCount?: number;
  /** 她启用的 BC+ 规矩 id（如 speech.forbidEmotes） */
  activeRules?: string[];
  /**
   * 规矩 id → 「谁加的」成员号（BC+ 广播里每条 active 规矩自带的 `addedBy.member`）。
   * 用途（#90）：精确识别「哪几条规矩是 BOT 加的」——她自己关掉规矩时 BC+ 会 delete addedBy，
   * 所以这个映射里的项必然 active。比本地账本权威（重启/账本丢失也能判对）。
   */
  ruleAddedBy?: Record<string, number>;
  /** 她身上生效的诅咒所在部位（BC+ Curses 的 slot group） */
  activeCurses?: string[];
  /** 正在执行的惩罚 id */
  activePunishments?: string[];
  /** "硬核对他人"开关（合成类 hardcore） */
  hardcoreOthers?: boolean;
  /**
   * 她是否被 BC+ 焊接给了别人（Welding 模块的 `welded === true`）。
   * ⚠️ 不能用"Data 里有键"判断——Welding 的 Data 默认就带 welded/weldOwner/ceremony
   * 等一堆键（Welding.ts Defaults），那样人人都会显示成"已被焊接"。
   */
  welded?: boolean;
  /** 焊主成员号（welded=false 时无意义） */
  weldOwner?: number;
}

/** 宠物四项的中文名（对齐 BC+ PetTypes.ts 的 PET_STATS） */
const PET_LABELS: ReadonlyArray<{ id: string; label: string; need: string }> = [
  { id: "food", label: "食物", need: "该喂她了" },
  { id: "water", label: "水分", need: "该给她喝水" },
  { id: "sleep", label: "睡眠", need: "该哄她睡觉" },
  { id: "affection", label: "亲密", need: "该抱抱/陪她了" },
];

/** 低于这个值就算"需要照顾"（0-100 制；BC+ 用 4-8 小时掉一管） */
const PET_LOW = 40;

const peers = new Map<number, BcpPeerState>();

function ensurePeer(memberNo: number, name: string): BcpPeerState {
  let state = peers.get(memberNo);
  if (!state) {
    state = { memberNo, name, version: "", updatedAt: Date.now() };
    peers.set(memberNo, state);
  }
  if (name) state.name = name;
  return state;
}

function numArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

/** 把一个 category 的数据并进该用户的状态（只认我们认识的字段） */
function applyCategory(state: BcpPeerState, category: string, value: unknown): void {
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== "object") return;
  switch (category) {
    case "pet": {
      const share = v.shareStats === true;
      const raw = (v.levels ?? {}) as Record<string, unknown>;
      const levels: Record<string, number> = {};
      for (const stat of PET_LABELS) {
        const n = raw[stat.id];
        if (typeof n === "number" && Number.isFinite(n)) levels[stat.id] = n;
      }
      state.pet = { shareStats: share, levels };
      break;
    }
    case "roles": {
      state.rolesOwners = numArray(v.owners);
      state.rolesMistresses = numArray(v.mistresses);
      const customs = (v.customRoles ?? {}) as Record<string, unknown>;
      state.customRoles = Object.entries(customs)
        .map(([, c]) => {
          const cObj = (c ?? {}) as Record<string, unknown>;
          return {
            name: typeof cObj.name === "string" ? cObj.name : "",
            members: numArray(cObj.members),
          };
        })
        .filter((c) => c.name.length > 0);
      break;
    }
    case "authority": {
      state.authorityCount = Object.keys(v).length;
      break;
    }
    case "rules": {
      const rules = (v.rules ?? {}) as Record<string, unknown>;
      const active: string[] = [];
      const addedBy: Record<string, number> = {};
      for (const [id, rawRule] of Object.entries(rules)) {
        const r = rawRule as Record<string, unknown> | null;
        if (r?.active !== true) continue;
        active.push(id);
        // addedBy = 谁把这条规矩设成 active 的（BC+ 自己填；她手动设 = 她自己，BOT 远程设 = BOT）
        const ab = r.addedBy as { member?: unknown } | undefined;
        if (ab && typeof ab.member === "number") addedBy[id] = ab.member;
      }
      state.activeRules = active;
      state.ruleAddedBy = addedBy;
      break;
    }
    case "curses": {
      const slots = (v.slots ?? {}) as Record<string, unknown>;
      state.activeCurses = Object.entries(slots)
        .filter(([, s]) => (s as Record<string, unknown> | null)?.active === true)
        .map(([group]) => group);
      break;
    }
    case "punishments": {
      const active = v.active;
      state.activePunishments = active && typeof active === "object" ? Object.keys(active) : [];
      break;
    }
    case "hardcore": {
      state.hardcoreOthers = v.others === true;
      break;
    }
    case "welding": {
      // 只有 welded === true 才是真被焊住（见字段注释：默认 Data 自带一堆键，不能靠"有键"）
      state.welded = v.welded === true;
      state.weldOwner = state.welded && typeof v.weldOwner === "number" ? v.weldOwner : undefined;
      break;
    }
    default:
      // 不认识的 category：不猜、不喂
      break;
  }
}

/**
 * 收一条 BC+ 同步事件，更新对应玩家的状态。
 * @returns 被更新的状态（不是 sync 事件则返回 null）
 */
export function ingestBcpEvent(event: BcpSyncEvent): BcpPeerState | null {
  if (event.kind !== "sync") return null;
  const payload = event.payload;
  if (!payload) return null;
  const state = ensurePeer(event.sourceNo, event.senderName);
  if (typeof payload.version === "string") state.version = payload.version;

  if (event.message === "SettingSync") {
    const settings = payload.settings;
    if (settings && typeof settings === "object") {
      for (const [slug, data] of Object.entries(settings as Record<string, unknown>)) {
        applyCategory(state, slug, data);
      }
    }
    // 别的模块设置视图（SettingsResponse）不走这里
  } else if (event.message === "CategorySync") {
    const category = typeof payload.category === "string" ? payload.category : "";
    if (category) applyCategory(state, category, payload.value);
  } else {
    return state; // 其它协议消息（SettingCommandResult 等）只记账不解析
  }
  state.updatedAt = Date.now();
  return state;
}

/** 取某个玩家的 BC+ 状态（没有则返回 null） */
export function getBcpState(memberNo: number): BcpPeerState | null {
  return peers.get(memberNo) ?? null;
}

/**
 * 把状态翻译成给 LLM 读的中文多行文本（空串 = 没有可用数据，调用方不要注入）。
 *
 * @param resolveName 成员号→显示名（找不到给 `#123456`）
 */
export function describeBcpStatus(
  state: BcpPeerState | null,
  resolveName: (memberNo: number) => string
): string {
  if (!state) return "";
  const lines: string[] = [];

  // 宠物四项：只在共享开启且有数值时出现
  if (state.pet?.shareStats) {
    const parts = PET_LABELS.map((s) => {
      const n = state.pet?.levels[s.id];
      return typeof n === "number" ? `${s.label} ${n}` : null;
    }).filter((x): x is string => x !== null);
    if (parts.length > 0) {
      const low = PET_LABELS.filter((s) => {
        const n = state.pet?.levels[s.id];
        return typeof n === "number" && n < PET_LOW;
      }).map((s) => `${s.label}${s.need}`);
      lines.push(
        `- 宠物四项（0-100，越低越需要照顾）：${parts.join(" / ")}` +
          (low.length > 0 ? `　← 偏低：${low.join("、")}` : "")
      );
    }
  }

  // BC+ 人际关系：她在 BC+ 里手动指派的人
  const ownerNames = (state.rolesOwners ?? []).map((no) => `${resolveName(no)}`);
  const mistressNames = (state.rolesMistresses ?? []).map((no) => `${resolveName(no)}`);
  if (state.rolesOwners !== undefined || state.rolesMistresses !== undefined) {
    lines.push(
      `- 她在 BC+ 里指派的人：副主人（Co-Owner）${ownerNames.length ? ownerNames.join("、") : "无"}；` +
        `女主人（Mistress）${mistressNames.length ? mistressNames.join("、") : "无"}`
    );
    if (state.customRoles && state.customRoles.length > 0) {
      const cr = state.customRoles
        .map((c) => `${c.name}（${c.members.length ? c.members.map((no) => resolveName(no)).join("、") : "无人"}）`)
        .join("、");
      lines.push(`- 她建的自定义角色：${cr}`);
    }
  }

  if (state.activeRules && state.activeRules.length > 0) {
    lines.push(`- 她开着 ${state.activeRules.length} 条 BC+ 规矩：${describeActiveRules(state.activeRules).join("、")}`);
  }
  if (state.activeCurses && state.activeCurses.length > 0) {
    lines.push(`- 她身上有 ${state.activeCurses.length} 处 BC+ 诅咒，锁在：${state.activeCurses.join("、")}`);
  }
  if (state.activePunishments && state.activePunishments.length > 0) {
    lines.push(`- 她正在执行的 BC+ 惩罚 ${state.activePunishments.length} 项：${state.activePunishments.join("、")}`);
  }
  if (state.hardcoreOthers === true) {
    lines.push("- 她的 BC+「硬核对他人」是**开着**的（她会挡掉别人对她的硬核操作）");
  }
  if (state.welded === true) {
    lines.push(
      `- 她身上的限制被**焊接**给别人了（焊主：${
        typeof state.weldOwner === "number" ? resolveName(state.weldOwner) : "不明"
      }）——这是 BC+ 里最重的绑定关系，别人动不了`
    );
  }

  return lines.join("\n");
}
