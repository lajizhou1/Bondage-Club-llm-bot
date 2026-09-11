import { io, Socket } from "socket.io-client";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  S2C,
  C2S,
  ChatMessage,
  LoginResponseData,
  Character,
  MapPosition,
  ChatType,
  ChatRoomSearchRequest,
  ChatRoomSearchResult,
  ChatRoomSyncData,
  FriendInfo,
} from "./protocol";
import { config } from "./config";
import {
  resolveActivityMessage,
  AppearanceEntry,
  getItemBaseDifficulty,
  isItemActionContent,
  parseItemAction,
  ItemActionInfo,
  collectEffects,
} from "./skills";
import { AccountBeepData } from "./protocol";

export interface ChatEvent {
  message: ChatMessage;
  senderName: string;
}

/** 收到他人 Activity（游戏动作）消息时的事件：text 为渲染好的中文句子 */
export interface ActivityEvent {
  /** 渲染后的中文描述，如 "服务对象轻抚BOT的手臂." */
  text: string;
  /** 动作执行者成员号 */
  sourceNo: number;
  /** 动作目标成员号（自身动作无目标） */
  targetNo: number | null;
  senderName: string;
  /** 事件类型：activity=普通游戏动作；struggle=挣扎（想滑脱束缚的叛逆信号）；struggle-giveup=主动放弃挣扎（投降/服软信号） */
  kind?: "activity" | "struggle" | "struggle-giveup";
  /** 原始 Activity 内容（如 "ChatOther-ItemHands-GaggedKiss"），供上层做施动方向/语义澄清（#19-D） */
  activityKey?: string;
}

/**
 * #89 BC+（Seles84/bc-plus）协议消息事件。
 *
 * BC+ 的跨玩家功能全部走隐藏消息：{Type:"Hidden", Content:"BCP", Dictionary:<普通对象>}。
 * BC+ 源码注释实锤：服务器会校验**数组**格式的字典条目并剔除自定义项，但对**普通对象**字典
 * 在 Hidden 消息上原样透传（BCX 用的同一机制）——所以任何客户端（含我们的 BOT）都能收发。
 *
 * 它的"回执"则走另一条路：{Type:"Activity", Content:"BCPAction",
 *   Dictionary:[{Tag:'MISSING TEXT IN "ActivityDictionary.csv": BCPAction', Text:"<渲染文本>"}]}
 * 靠 BC 的"找不到模板就把 Text 当整条消息"兜底，把文字直显给接收方（不受口塞影响、不查字典）。
 */
export interface BcpMessageEvent {
  /** reply=BC+ 对指令的定向回执（耳语 !bcp 的回复）；sync=BC+ 广播/定向的协议消息本体 */
  kind: "reply" | "sync";
  /** 纯文本内容（reply 是渲染好的整句；sync 是消息摘要） */
  text: string;
  sourceNo: number;
  senderName: string;
  /** sync 专用：BC+ 协议 message 字段（SettingSync / CommandInvokeResult / ContractOffer ...） */
  message?: string;
  /** sync 专用：原始消息体（普通对象） */
  payload?: Record<string, unknown>;
}

/** 身上道具发生变更（穿上/脱下/滑脱）时的事件（含 BOT 自己操作的回执，由上层过滤） */
export interface ItemChangeEvent {
  /** 被变更的角色成员号 */
  targetNo: number;
  /** 部位槽位，如 ItemArms */
  group: string;
  /** 新道具名；null 表示该部位被脱下/滑脱 */
  name: string | null;
  /**
   * 变更前的道具名（与 name 对比即可判定"真穿戴 / 真脱下 / 仅属性变化"）。
   * null 表示该槽位原本是空的。
   *
   * 为什么需要这个字段：BC 服务器在多种情况下都会下发 ChatRoomSyncItem——
   * ① 真的穿上/脱下（prevName↔name 一空一有）
   * ② 玩家挣扎开始/失败（服务器重发 sync item 让所有客户端刷新视觉效果，prevName===name）
   * ③ 上锁/解锁/变体切换/Property 变化（prevName===name）
   * ④ 难度调节（prevName===name）
   * 仅有 ① 是"穿戴/脱下"语义，②③④ 都属于"该道具还在身上但状态变了"，
   * 这种情况应该走 onItemAction 公告感知，不能误判为"新穿上"（用户 2026-09-04 17:30 截图反馈）。
   */
  prevName: string | null;
  /** 操作的发起者 MemberNumber（来自 BC ChatRoomCharacterItemUpdate 的 Source 字段）。
   *  = targetNo：自己给自己戴/取
   *  = 别的 No：被他人戴
   *  undefined：仅当 BC 数据包异常缺失 Source 时出现（罕见） */
  senderNo?: number;
}

/** 牵引系统信号（#19）：皮带的抓起/松开/解除/心跳定向消息 */
export interface LeashSignalEvent {
  /**
   * hold=有人抓起了目标的皮带（Action 广播，来源→目标）
   * release=有人松开了目标的皮带（Action 广播）
   * removed=发信人解除了对 BOT 的皮带从属（Hidden 定向给 BOT：目标拒绝/改牵别人/心跳失效）
   * incoming=有人想抓 BOT 自己的皮带（Hidden 定向给 BOT，BOT 是 Dom 不接受）
   * ping=持有者在确认 BOT 是否仍被牵着（Hidden 定向给 BOT）
   */
  kind: "hold" | "release" | "removed" | "incoming" | "ping";
  /** 信号来源成员号 */
  sourceNo: number;
  /** 信号目标成员号（Action 广播从 Dictionary 取；定向消息即发信人操作的对象） */
  targetNo: number | null;
  senderName: string;
}

/** 收到好友 Beep 时的事件（#16 认输机制靠这个） */
export interface BeepEvent {
  /** Beep 发送者成员号 */
  sourceNo: number;
  /** Beep 发送者名字（服务器附带的发送时名字，可能与现在昵称不同） */
  senderName: string;
  /** BeepType：null/""=普通 Beep；"Leash"=牵绳（服务器免友校验）；其他自定义字串原样转发 */
  beepType: string | null;
  /** Beep 自带的 Message 字段（普通 Beep 才有内容） */
  message: string | null;
  /** 发送者所在房间名（私房时服务器返回 null）；用于判断她是否已在 ljzbot */
  roomName: string | null;
  /** 发送者所在房间是否为私房 */
  roomPrivate: boolean;
}

/** BC 客户端在玩家聚焦/失焦聊天框、切换频道时广播的占位内容，不是真实对话 */
const CHAT_PLACEHOLDERS = new Set(["Talk", "null", "Typing..."]);

/** 窗口限频器：最多 maxPerWindow 条 / windowMs（与 razor-client 默认一致）。 */
class RateLimiter {
  private tokens: number;
  private readonly queue: Array<[string, unknown]> = [];

  constructor(
    private readonly emit: (event: string, data: unknown) => void,
    private readonly maxPerWindow = 14,
    private readonly windowMs = 1200,
  ) {
    this.tokens = this.maxPerWindow;
    setInterval(() => {
      this.tokens = this.maxPerWindow;
      this.drain();
    }, this.windowMs);
    setInterval(() => this.drain(), 100);
  }

  send(event: string, data: unknown): void {
    this.queue.push([event, data]);
    this.drain();
  }

  clear(): void {
    this.queue.length = 0;
  }

  private drain(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      const [event, data] = this.queue.shift()!;
      this.tokens -= 1;
      this.emit(event, data);
    }
  }
}

/**
 * 无头 BC 客户端：只复用 Socket.IO 协议，不依赖浏览器 DOM。
 * 负责连接、登录、进房、收发聊天、移动/姿势，并缓存房间内角色状态与自身位置。
 */
export class BCClient {
  private socket: Socket;
  private limiter: RateLimiter;
  private _player: LoginResponseData = {};
  private _loggedIn = false;
  private _autoRelogin = false;
  private _connected = false;
  private characters = new Map<number, Character>();
  private _selfPos: MapPosition | null = null;
  /** 全房间成员位置缓存（MemberNumber → {X, Y}），牵引系统用 */
  private positions = new Map<number, MapPosition>();
  private pendingSearches: Array<(rooms: ChatRoomSearchResult[]) => void> = [];
  /** OnlineFriends 查询的待响应队列（AccountQueryResult 到达时按 FIFO 派发） */
  private pendingFriendQueries: Array<(friends: FriendInfo[]) => void> = [];
  private _currentRoom: string | null = null;
  /** 当前房人数上限（ChatRoomSync.Limit；取不到为 null = 未知，不做满员判定） */
  private _roomLimit: number | null = null;
  /** 最近一次尝试加入的房间名（onJoinFailed 时用于识别被哪间房拒/踢） */
  lastJoinAttempt: string | null = null;

  onChat?: (event: ChatEvent) => void;
  onActivity?: (event: ActivityEvent) => void;
  /** #89 收到 BC+ 协议消息或其回执（需她客户端装了 BC+；BOT 侧只解析不执行） */
  onBCPMessage?: (event: BcpMessageEvent) => void;
  onItemChange?: (event: ItemChangeEvent) => void;
  /**
   * 收到好友 Beep 时触发（服务器 AccountBeep 事件，前提：发送方在 BOT 好友列表 / 有所有权 / BeepType=Leash）。
   * 数据含发送者编号、名字、所在房（私房时为 null）、BeepType（null=普通、Leash=牵绳等）。
   * BOT 当前不回复只派发——上层按需用 sendBeep 回应。
   */
  onBeep?: (event: BeepEvent) => void;
  /** #45：收到别人的道具操作公告（Type=Action 的 ActionUse/Remove/AddLock/Unlock/Tighten/Loosen） */
  onItemAction?: (event: ItemActionInfo) => void;
  onLeashSignal?: (event: LeashSignalEvent) => void;
  onLogin?: (player: LoginResponseData) => void;
  onDisconnect?: (reason: string) => void;
  onRoomJoined?: (roomName: string) => void;
  /** 进房失败（房间不存在/已满等）——上层可据此安排重试 */
  onJoinFailed?: (msg: string) => void;
  /** #16：有成员进入当前房间（含被牵绳拖进来的服务对象——到家判定的信号源） */
  onMemberJoin?: (memberNo: number) => void;

  constructor() {
    // 通过 HTTP 代理连接（如本机 Clash 混合端口），否则在大陆网络下无法直连游戏服务器。
    const proxyAgent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;

    this.socket = io(config.serverUrl, {
      // websocket 优先（持久连接 + 心跳保活，比 polling 更抗代理线路抖动），失败自动回退 polling。
      transports: ["websocket", "polling"],
      transportOptions: {
        websocket: {
          extraHeaders: {
            Origin: config.origin,
            "User-Agent": config.userAgent,
          },
          agent: proxyAgent,
        },
        polling: {
          extraHeaders: {
            Origin: config.origin,
            "User-Agent": config.userAgent,
          },
          agent: proxyAgent,
        },
      },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    this.limiter = new RateLimiter((event, data) => this.socket.emit(event, data));

    this.socket.on("connect", () => {
      this._connected = true;
      const transport = (this.socket.io as unknown as { engine?: { transport?: { name?: string } } })?.engine?.transport?.name ?? "?";
      console.log(`[bc] connected to server (transport=${transport})`);
      // 断线重连后自动重新登录（登录成功会触发 onLogin → 重新进房）
      if (this._autoRelogin) {
        console.log("[bc] reconnected — re-logging in...");
        this.login();
      }
    });
    this.socket.on("connect_error", (err) => {
      console.error("[bc] connect error:", err.message);
    });
    this.socket.on("disconnect", (reason) => {
      this._connected = false;
      this._loggedIn = false;
      this.limiter.clear();
      console.log("[bc] disconnected:", reason);
      this.onDisconnect?.(reason);
    });

    this.socket.on(S2C.LoginResponse, (data: LoginResponseData) => this.handleLoginResponse(data));
    this.socket.on(S2C.LoginQueue, (data: unknown) => console.log("[bc] login queue:", data));
    this.socket.on(S2C.ForceDisconnect, (data: unknown) => {
      console.log("[bc] forced disconnect:", data);
      this._loggedIn = false;
      this.socket.disconnect();
    });
    this.socket.on(S2C.ChatRoomMessage, (data: ChatMessage) => this.handleChatMessage(data));
    this.socket.on(S2C.ChatRoomSyncCharacter, (data: { Character?: Character[] | Character }) =>
      this.handleSyncCharacter(data)
    );
    this.socket.on(S2C.ChatRoomSyncMemberJoin, (data: { Character?: Character }) => this.handleMemberJoin(data));
    this.socket.on(S2C.ChatRoomSyncMemberLeave, (data: { SourceMemberNumber?: number }) => this.handleMemberLeave(data));
    this.socket.on(S2C.ChatRoomSearchResponse, (data: unknown) => this.handleJoinResponse(data));
    this.socket.on(S2C.ChatRoomSearchResult, (data: unknown) => this.handleSearchResult(data));
    this.socket.on(S2C.ChatRoomSync, (data: ChatRoomSyncData) => this.handleRoomSync(data));
    this.socket.on(S2C.ChatRoomSyncMapData, (data: { MemberNumber?: number; MapData?: unknown }) =>
      this.handleMapData(data)
    );
    // 道具变更回执（自己或别人身上的道具穿上/脱下都会广播）
    this.socket.on(S2C.ChatRoomSyncItem, (data: unknown) => this.handleSyncItem(data));
    // #78 BCE 客户端"给人穿衣服"用的整包同步通道：服务器 ChatRoomCharacterUpdate 调用
    //   ChatRoomSyncSingle 全房广播（server_app.js:1835）。载荷结构同 ChatRoomSyncCharacter
    //   （{ SourceMemberNumber, Character: ... }），复用 handleSyncCharacter 整包覆盖缓存 + 日志回滚检测。
    //   之前漏注册这条路径时，BCE 给 BOT 换装会被静默吃掉——"记住我的衣服"抓不到新装。
    this.socket.on(
      S2C.ChatRoomSyncSingle,
      (data: { Character?: Character | Character[]; SourceMemberNumber?: number }) =>
        this.handleSyncCharacter(data)
    );
    this.socket.on(S2C.AccountBeep, (data: AccountBeepData) => this.handleBeep(data));
    this.socket.on(S2C.AccountQueryResult, (data: unknown) => this.handleAccountQueryResult(data));
  }

  get connected(): boolean {
    return this._connected;
  }

  get loggedIn(): boolean {
    return this._loggedIn;
  }

  get player(): LoginResponseData {
    return this._player;
  }

  get selfPos(): MapPosition | null {
    return this._selfPos;
  }

  get currentRoom(): string | null {
    return this._currentRoom;
  }

  /** 当前房人数上限（未知为 null）——#16 选房满员判定用 */
  get roomMemberLimit(): number | null {
    return this._roomLimit;
  }

  /** 当前房实时人数（含自己）——#16 选房满员判定用 */
  get roomMemberCount(): number {
    return this.characters.size;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.connected) return resolve();
      this.socket.once("connect", () => resolve());
      this.socket.connect();
    });
  }

  login(): void {
    console.log("[bc] logging in as:", config.bcUsername);
    // 标记"发起过登录"：之后断线重连会自动重试登录（含登录响应丢失的情况）。
    this._autoRelogin = true;
    this.limiter.send(C2S.AccountLogin, {
      AccountName: config.bcUsername,
      Password: config.bcPassword,
    });
  }

  joinRoom(name: string): void {
    console.log("[bc] joining room:", name);
    this.lastJoinAttempt = name; // 2026-09-05 18:18 踢房事故：onJoinFailed 时据此识别被哪间房拒/踢
    this.limiter.send(C2S.ChatRoomJoin, { Name: name });
  }

  /**
   * #16 离开当前房间（ChatRoomLeave）。服务器无响应包，清空本地房间状态即可。
   * 注意：空房会被服务器销毁（server_app.js ChatRoomRemove）——"家"房间人走光就没了，
   * 回去时要走 joinOrCreateRoom。
   */
  leaveRoom(): void {
    console.log("[bc] leaving room:", this._currentRoom ?? "(none)");
    this._currentRoom = null;
    this._roomLimit = null;
    this.limiter.send(C2S.ChatRoomLeave, {});
  }

  /**
   * #16 创建房间（ChatRoomCreate）。创建成功即自动进入该房间。
   * 与 joinRoom 的区别：用于"家"房间被服务器销毁后重建（空房即毁机制）。
   * 返回错误信息（如 "RoomAlreadyExist"），成功返回 null。
   */
  createRoom(name: string, description = "ljzsbot 的家", background = "Private"): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("(timeout)"), 10000);
      this.socket.once(S2C.ChatRoomCreateResponse, (data: unknown) => {
        clearTimeout(timer);
        const msg = typeof data === "string" ? data : JSON.stringify(data);
        console.log(`[bc] create room "${name}": ${msg}`);
        // 服务器成功响应是 "ChatRoomCreated"（server_app.js:1395），且建房即入房（自动 ChatRoomSync）
        resolve(msg === "ChatRoomCreated" ? null : msg);
      });
      this.limiter.send(C2S.ChatRoomCreate, {
        Name: name,
        Description: description,
        Background: background,
        // 2026-09-05 用户要求：可见性默认非公众——不进公共房间搜索列表；
        // 访问权限保持公众（知道房间名即可加入，服务对象 输入 ljzbot 照常能进）
        Private: true,
        Space: config.roomSpace,
        Language: "",
        Admin: [],
        Ban: [],
        Whitelist: [],
        Limit: 10,
        BlockCategory: [],
      });
    });
  }

  /**
   * #16 异步进房：发 ChatRoomJoin 后等 ChatRoomSync（成功）或失败响应/超时。
   * 成功返回房间名；失败（不存在/已满/超时）返回 null。
   */
  joinRoomAsync(name: string, timeoutMs = 12000): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (room: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onRoomJoined = prevOnRoomJoined;
        this.onJoinFailed = prevOnJoinFailed;
        resolve(room);
      };
      // 暂存并包装现有回调（进房成功的钩子逻辑在 index.ts，这里要兼顾）
      const prevOnRoomJoined = this.onRoomJoined;
      const prevOnJoinFailed = this.onJoinFailed;
      this.onRoomJoined = (roomName) => {
        prevOnRoomJoined?.(roomName);
        finish(roomName);
      };
      this.onJoinFailed = (msg) => {
        prevOnJoinFailed?.(msg);
        finish(null);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.joinRoom(name);
    });
  }

  /**
   * #16 换房一条龙：离房 → 稍等 → 进房（房间不存在则先建房再进）。
   * 跨房牵绳的关键前置：BOT 进新房收到 ChatRoomSync 后要立即对被牵列表发
   * Leash beep（见 pingLeashedPlayers，由 index.ts 的 onRoomJoined 钩子触发）。
   */
  async switchRoom(name: string, opts?: { createIfMissing?: boolean; description?: string }): Promise<string | null> {
    this.leaveRoom();
    await new Promise((r) => setTimeout(r, 600));
    let room = await this.joinRoomAsync(name);
    if (room === null && opts?.createIfMissing) {
      const err = await this.createRoom(name, opts.description);
      if (err === null) {
        // 建房响应先到、真正入房的 ChatRoomSync 稍后才到（2026-09-05 05:57 实测竞态：
        // createRoom 成功但 _currentRoom 还是 null → switchRoom 误报"回家失败"，
        // 而 BOT 其实 1 秒后就 in room 了）→ 轮询等 sync 落地（最多 5 秒）
        for (let i = 0; i < 25 && this._currentRoom !== name; i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
        room = this._currentRoom === name ? this._currentRoom : null;
        if (room === null) {
          console.log(`[bc] create room ok but room sync not received (current="${this._currentRoom}")`);
        }
      }
    }
    return room;
  }

  /**
   * #16 跨房牵绳信号（源码确证 ChatRoom.js:5673 ChatRoomPingLeashedPlayers）：
   * BOT 换房后对每个被牵着的人发 AccountBeep{BeepType:"Leash"} + PingHoldLeash 定向指令。
   * 服务器对 Leash beep 免好友校验（server_app.js:1055），并附上 BOT 当前房名转发；
   * 对方客户端 ServerHandleLeashBeep 校验通过后自动离房+跟入 BOT 的房间。
   */
  sendLeashBeep(targetMemberNumber: number): void {
    this.limiter.send(C2S.AccountBeep, { MemberNumber: targetMemberNumber, BeepType: "Leash" });
    this.sendHidden("PingHoldLeash", targetMemberNumber);
    console.log(`[leash] 跨房牵绳信号 -> #${targetMemberNumber}（AccountBeep Leash + PingHoldLeash）`);
  }

  /**
   * 通用 Beep 发送（普通 Beep：服务器只对好友/所有权/Leash 类型放行）。
   * @param message 可选留言内容（仅好友间普通 Beep 才有；Leash/AddFriend 等语义型不要带）
   * @param beepType 默认 null=普通 Beep，"Leash" 等专有类型请走对应专用方法
   */
  sendBeep(targetMemberNumber: number, message: string | null = null, beepType: string | null = null): void {
    const payload: Record<string, unknown> = { MemberNumber: targetMemberNumber };
    if (beepType) payload.BeepType = beepType;
    if (message) payload.Message = message;
    this.limiter.send(C2S.AccountBeep, payload);
    console.log(`[beep] -> #${targetMemberNumber} (type=${beepType ?? "normal"}) ${message ?? ""}`);
  }

  /**
   * 服务器 AccountBeep 入口（服务器只在发送方在 BOT 好友列表 / 有所有权 / BeepType=Leash 时才转发）。
   * 委派给 onBeep 回调，让上层（index.ts）按业务语义解释（如 服务对象 发 Beep = 限时回家认输）。
   */
  private handleBeep(data: AccountBeepData): void {
    const sourceNo = typeof data.MemberNumber === "number" ? data.MemberNumber : 0;
    if (sourceNo === 0) return; // 无效包
    if (sourceNo === this._player.MemberNumber) return; // 服务器把自己发的 beep 也回传一份，丢弃
    const evt: BeepEvent = {
      sourceNo,
      senderName: typeof data.MemberName === "string" ? data.MemberName : `#${sourceNo}`,
      beepType: typeof data.BeepType === "string" ? data.BeepType : null,
      message: typeof data.Message === "string" ? data.Message : null,
      roomName: typeof data.ChatRoomName === "string" ? data.ChatRoomName : null,
      roomPrivate: data.Private === true,
    };
    console.log(
      `[beep] <- #${evt.sourceNo} ${evt.senderName} (type=${evt.beepType ?? "normal"}) msg="${evt.message ?? ""}" from=${evt.roomName ?? "(hidden)"}${evt.roomPrivate ? "[private]" : ""}`
    );
    this.onBeep?.(evt);
  }

  /**
   * 服务器 AccountQueryResult 入口。只处理 Query="OnlineFriends" 的响应
   * （BOT 只发这一种查询）；按 FIFO 派发给 pendingFriendQueries。
   */
  private handleAccountQueryResult(data: unknown): void {
    const obj = data as { Query?: string; Result?: unknown };
    if (obj?.Query !== "OnlineFriends") return;
    const friends = Array.isArray(obj.Result) ? (obj.Result as FriendInfo[]) : [];
    while (this.pendingFriendQueries.length > 0) {
      const resolve = this.pendingFriendQueries.shift()!;
      resolve(friends);
    }
  }

  /**
   * 把指定成员号加入 BOT 自己的 FriendList（BC 好友是双向的：双方都得加）。
   * 实现：AccountUpdate{ FriendList: [...existing, targetNumber] }，服务器直接合并不需要对方回应。
   * 注意：服务器转发 Beep 的前置条件之一是「对方好友列表里有你」——所以双方必须都执行一次本接口（或对方用 BC GUI 加）。
   * @returns true=已发送请求；false=已在好友列表/参数非法
   */
  addFriend(memberNumber: number): boolean {
    if (typeof memberNumber !== "number" || memberNumber <= 0) return false;
    if (memberNumber === this._player.MemberNumber) return false;
    const current = Array.isArray(this._player.FriendList)
      ? (this._player.FriendList as number[]).filter((n) => typeof n === "number")
      : [];
    if (current.includes(memberNumber)) {
      console.log(`[friend] #${memberNumber} 已在 FriendList，跳过`);
      return false;
    }
    const merged = [...current, memberNumber];
    this.limiter.send(C2S.AccountUpdate, { FriendList: merged });
    this._player.FriendList = merged;
    console.log(`[friend] 已加 #${memberNumber} 为好友，新 FriendList=[${merged.join(", ")}]`);
    return true;
  }

  /** 当前 BOT 好友列表快照（只读副本） */
  get friendList(): number[] {
    const list = this._player.FriendList;
    return Array.isArray(list) ? [...(list as number[])] : [];
  }

  /**
   * 搜索聊天室。BC 登录后不在任何房间，必须先搜索、再加入。
   * 默认按混合空间（Space="X"）搜索，可传参覆盖。
   */
  searchRooms(overrides: Partial<ChatRoomSearchRequest> = {}): Promise<ChatRoomSearchResult[]> {
    const req: ChatRoomSearchRequest = {
      Query: "",
      Space: config.roomSpace,
      Game: "",
      FullRooms: false,
      Language: "",
      ShowLocked: true,
      SearchDescs: false,
      MapTypes: [],
      Ignore: [],
      ...overrides,
    };
    return new Promise((resolve) => {
      this.pendingSearches.push(resolve);
      this.limiter.send(C2S.ChatRoomSearch, req);
      // 超时保护：8 秒无结果按空列表处理
      setTimeout(() => {
        const idx = this.pendingSearches.indexOf(resolve);
        if (idx >= 0) {
          this.pendingSearches.splice(idx, 1);
          resolve([]);
        }
      }, 8000);
    });
  }

  /**
   * 查询在线好友列表（AccountQuery{Query:"OnlineFriends"}）。
   * 服务器返回所有在线好友/恋人/被拥有的账号 + 所在房间名/空间/人数（server_app.js
   * AccountQueryGetFriendInfo：Ownership（Submissive）与 Lover 连私密房都可见房名；
   * 普通 Friend 在私密房只返回 Private:true）。#16 跨区会合轮询用：定位她在哪个房。
   */
  queryOnlineFriends(): Promise<FriendInfo[]> {
    return new Promise((resolve) => {
      this.pendingFriendQueries.push(resolve);
      this.limiter.send(C2S.AccountQuery, { Query: "OnlineFriends" });
      // 超时保护：8 秒无结果按空列表处理
      setTimeout(() => {
        const idx = this.pendingFriendQueries.indexOf(resolve);
        if (idx >= 0) {
          this.pendingFriendQueries.splice(idx, 1);
          resolve([]);
        }
      }, 8000);
    });
  }

  /** 发公屏聊天 / 表情 */
  sendChat(text: string, type: ChatType = "Chat"): void {
    this.limiter.send(C2S.ChatRoomChat, { Content: text, Type: type, Target: null });
  }

  /** 私聊指定成员号 */
  sendWhisper(targetMemberNumber: number, text: string): void {
    this.limiter.send(C2S.ChatRoomChat, { Content: text, Type: "Whisper", Target: targetMemberNumber });
  }

  /**
   * 定向系统指令（Type=Hidden）：只发给目标一人，服务器原样中继。
   * 官方用它传 HoldLeash/StopHoldLeash/RemoveLeash 等游戏指令，接收方客户端自行校验执行。
   */
  sendHidden(content: string, targetMemberNumber: number): void {
    this.limiter.send(C2S.ChatRoomChat, { Content: content, Type: "Hidden", Target: targetMemberNumber });
  }

  /**
   * #89 BC+ 耳语指令：`!bcp <command> [argument]`。
   *
   * 关键点（BC+ 源码 `modules/Commands.ts` 注释原话）：发送方**不需要**装 BC+——
   * "works even when the sender does not run BC+"。目标客户端（装了 BC+、且 BOT 在其
   * Authority 里够权限）校验后用定向 Activity 回执结果。
   *
   * 权限无需额外配置：BC+ 的 commands.use 默认门槛是 Mistress，而"我的 BC Owner"是最高级
   * （derivedList(BCOwner) = [Player.Ownership.MemberNumber]）——BOT 是她的 Owner → 天然有权。
   * 前提：她在同一房间（BC+ 用 FindCharacterInRoom 校验发送者）；被黑名单/幽灵名单阻断除外。
   */
  sendBCPWhisper(targetMemberNumber: number, command: string, argument = ""): void {
    const arg = argument.trim();
    const text = arg ? `!bcp ${command} ${arg}` : `!bcp ${command}`;
    this.sendWhisper(targetMemberNumber, text);
    console.log(`[bcp] 耳语指令 -> #${targetMemberNumber}（${this.nameOf(targetMemberNumber)}）：${text}`);
  }

  /**
   * #89 BC+ 协议消息本体（第二层能力预留：远程规则/诅咒/契约等）。
   *
   * Dictionary 必须是**普通对象**（不能是数组）——服务器只对数组条目做 schema 校验并剔除自定义项，
   * 对象字典在 Hidden 消息上原样透传。
   *
   * @param target 缺省=全房广播；给成员号=只发给该人（BC+ 的 SendBCPMessage 同款）
   */
  sendBCPMessage(message: Record<string, unknown>, target?: number): void {
    console.log(`[bcp] 协议消息 -> ${target === undefined ? "全房" : `#${target}`}：${String(message.message)}`);
    this.limiter.send(C2S.ChatRoomChat, {
      Type: "Hidden",
      Content: "BCP",
      Dictionary: message,
      Target: target ?? null,
    });
  }

  /** 移动到地图绝对坐标 */
  moveTo(x: number, y: number): void {
    this.limiter.send(C2S.ChatRoomCharacterMapDataUpdate, { Pos: { X: x, Y: y } });
  }

  /** 设置姿势（姿势名列表，如 ["Kneel"]） */
  setPose(poses: string[]): void {
    this.limiter.send(C2S.ChatRoomCharacterPoseUpdate, { Pose: poses });
  }

  /**
   * 执行游戏动作（Activity）。对别人用 ChatOther 前缀（带 TargetCharacter 与部位），
   * 对自己用 ChatSelf 前缀。格式对照官方 Activity.js ActivityRun。
   * activityAsset：手持道具类动作（RubItem/SpankItem/MasturbateItem…）必须带——官方
   *   ActivityRun（Scripts_Activity.js:896）会把发送方 ItemHandheld 的道具打包成
   *   {Tag:"ActivityAsset",AssetName,GroupName} 条目，接收端用它替换聊天行模板里的
   *   ActivityAsset 占位符。不带就显示原文 "ActivityAsset"（2026-09-08 实机截图实锤）。
   */
  sendActivity(
    name: string,
    zone: string,
    targetNo: number | null,
    opts?: { activityAsset?: { name: string; group: string } }
  ): void {
    const prefix = targetNo === null ? "ChatSelf" : "ChatOther";
    const dictionary: Array<Record<string, unknown>> = [
      { SourceCharacter: this._player.MemberNumber },
    ];
    if (targetNo !== null) {
      dictionary.push({ TargetCharacter: targetNo });
      dictionary.push({ Tag: "FocusAssetGroup", FocusGroupName: zone });
    }
    if (opts?.activityAsset) {
      dictionary.push({
        Tag: "ActivityAsset",
        AssetName: opts.activityAsset.name,
        GroupName: opts.activityAsset.group,
      });
    }
    dictionary.push({ ActivityName: name });
    this.limiter.send(C2S.ChatRoomChat, {
      Content: `${prefix}-${zone}-${name}`,
      Type: "Activity",
      Dictionary: dictionary,
    });
  }

  /**
   * 给目标穿/脱道具（ChatRoomCharacterItemUpdate）。
   * name 为 null 表示脱下该部位上的道具。需要目标在游戏内给 BOT 授权。
   * color：道具颜色——字符串（十六进制或 "Default"）或数组（多图层道具每层一色，
   *   #16 用户图层自定义后 Color 常为数组形态，Appearance.js:694 ItemGetColor）。
   */
  sendItemUpdate(
    targetNo: number,
    group: string,
    name: string | null,
    opts?: { property?: Record<string, unknown> | null; difficulty?: number; color?: string | string[] }
  ): void {
    // #16 修复（2026-09-05 实测踩坑）：接收端（服务对象 的客户端）对漏发 Color 的道具更新会把颜色
    // 重置为默认——Server.js:752 ServerBundledItemToAppearanceItem 用 item.Color（undefined）
    // 构造新道具 → ChatRoom.js:5468 CharacterAppearanceSetItem 按默认色重穿。
    // 后续"同一件道具"的修改（上锁/切变体/调松紧）若不带 Color，重穿时设好的自定义颜色
    // 就会被洗掉。规则：修改同款道具且未显式指定颜色 → 自动带上缓存里该槽位的当前颜色；
    // 换穿不同道具不自动带（旧道具的颜色数组长度对新资产可能无意义，会出怪色）。
    let color = opts?.color;
    if (color === undefined && name !== null) {
      const cached = this.characters.get(targetNo);
      const entry = (Array.isArray(cached?.Appearance) ? (cached!.Appearance as AppearanceEntry[]) : [])
        .find((e) => e?.Group === group);
      const cachedColor = entry?.Color;
      if (entry?.Name === name && (typeof cachedColor === "string" || Array.isArray(cachedColor))) {
        color = cachedColor;
      }
    }
    this.limiter.send(C2S.ChatRoomCharacterItemUpdate, {
      Target: targetNo,
      Group: group,
      Name: name,
      ...(opts?.property !== undefined ? { Property: opts.property } : {}),
      ...(opts?.difficulty !== undefined ? { Difficulty: opts.difficulty } : {}),
      ...(color !== undefined ? { Color: color } : {}),
    });
  }

  /**
   * 把 BOT 自己的完整外观整包发回服务器（ChatRoomCharacterUpdate）——这是唯一能写服务器
   * 数据库存档的通道。单道具操作（ChatRoomCharacterItemUpdate）服务器只转发给其他人、
   * 不落库，导致 BOT 无头客户端"脱/穿"后数据库仍保留旧状态，重启（重新登录拉存档）时
   * 道具会"复活"。凡 BOT 对自己做过道具增删（尤其脱下束缚），都要调本方法持久化，
   * 否则下次重启身上又会冒出绳子/口塞等。
   */
  sendCharacterUpdate(): void {
    const selfNo = this._player.MemberNumber;
    if (typeof selfNo !== "number") return;
    const selfChar = this.characters.get(selfNo);
    if (!selfChar) return;
    const id = typeof selfChar.ID === "string" && selfChar.ID !== "" ? selfChar.ID : null;
    if (!id) {
      console.log("[bc][persist] skip ChatRoomCharacterUpdate: 拿不到自己的 Character.ID");
      return;
    }
    const appearance = Array.isArray(selfChar.Appearance) ? selfChar.Appearance : [];
    this.limiter.send(C2S.ChatRoomCharacterUpdate, {
      ID: id,
      Appearance: appearance,
      ...(selfChar.ActivePose !== undefined ? { ActivePose: selfChar.ActivePose } : {}),
    });
    console.log(
      `[bc][persist] ChatRoomCharacterUpdate 已发送（写库）：BOT 外观 ${appearance.length} 项`
    );
  }

  /**
   * 所有权动作（AccountOwnership）。官方"求婚制"四步：
   * Propose(BOT→服务对象发出试用邀请) → 服务对象在游戏里点开 BOT 接受 → 试用期(Stage 0)，
   * 试用期内 Ownership.MemberNumber 已写入 → 主人锁可用。
   * Release = BOT 主动放弃所有权；Break 仅服务对象自己可用。
   */
  sendOwnershipAction(
    memberNumber: number,
    action: "Propose" | "Release"
  ): void {
    this.limiter.send(C2S.AccountOwnership, {
      MemberNumber: memberNumber,
      Action: action,
    });
    console.log(`[ownership] ${action} → #${memberNumber}`);
  }

  /** 直接设置道具互动权限档位（0-4，语义见 server_app.js ChatRoomGetAllowItem）：
   *  0=所有人（黑名单都不拦） 1=公开·黑名单除外 2=支配者+白名单+恋人 3=仅白名单+恋人 4=仅恋人。
   *  供 BOT_ITEM_PERMISSION 非 3 档使用；WhiteList/BlackList 名单不动。 */
  setItemPermission(level: number): void {
    const labels = ["所有人", "公开·黑名单除外", "支配者+白名单+恋人", "仅白名单+恋人", "仅恋人"];
    const v = Math.max(0, Math.min(4, Math.floor(level)));
    this.limiter.send(C2S.AccountUpdate, { ItemPermission: v });
    this._player.ItemPermission = v;
    console.log(`[permission] ItemPermission=${v}（${labels[v]}）`);
  }

  /** 改自己的昵称（全服显示，优先于注册名）。
   *  服务器校验（Scripts_Server.js:18）：1-20 字符，Unicode 字母/数字/空格/引号/连字符——中文合法。 */
  setNickname(nickname: string): void {
    if (!/^[\p{L}\p{Nd}\p{Z}'\-]{1,20}$/u.test(nickname)) {
      console.warn(`[nickname] "${nickname}" 不符合服务器规则（1-20 字符，仅字母/数字/空格/引号/连字符），跳过改名`);
      return;
    }

    this.limiter.send(C2S.AccountUpdate, { Nickname: nickname });
    this._player.Nickname = nickname;
    console.log(`[nickname] Nickname 已设置：${nickname}`);
  }

  /** 改角色标签颜色（在聊天列表的头顶/聊天消息里的角色名旁显示）。
   *  服务器校验（Scripts_Server.js:1423）：通过 CommonIsColor 验证，不合法回退 #ffffff。
   *  BC 不接受 8 位 hex（带 alpha），只接受 #xxxxxx 6 位十六进制。 */
  setLabelColor(color: string): void {
    // 兼容 .env 写 #D5D633 时被 dotenv 误当注释，主动包了引号进来；剥掉外壳
    const raw = color.trim().replace(/^["']|["']$/g, "");
    const hex = raw.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
      console.warn(`[label-color] "${color}" 不符合 #xxxxxx 6 位 hex 格式，跳过`);
      return;
    }
    this.limiter.send(C2S.AccountUpdate, { LabelColor: hex });
    this._player.LabelColor = hex;
    console.log(`[label-color] LabelColor 已设置：${hex}`);
  }

  /** 设置角色描述（BIO，资料页第一屏）。
   *  走 AccountUpdate.Description，官方上限 10000 字符
   *  （OnlineProfile.js OnlineProfileTextDescMaxLen），纯文本支持换行。
   *  官方保存时会 trim，这里保持一致。 */
  setDescription(text: string): void {
    const desc = text.trim();
    if (!desc) {
      console.warn("[description] 内容为空，跳过设置");
      return;
    }
    if (desc.length > 10000) {
      console.warn(`[description] 长度 ${desc.length} 超过 10000 字符上限，跳过设置`);
      return;
    }
    this.limiter.send(C2S.AccountUpdate, { Description: desc });
    this._player.Description = desc;
    console.log(`[description] Description 已设置（${desc.length} 字符）`);
  }


  /**
   * 直接触发目标身上电击道具的电流（#84）。
   * 照抄官方 PropertyShockPublishAction（Property.js:193）的消息格式——玩家点她项圈上
   * "触发电击"按钮发的就是这条：Content=TriggerShock<level>，Type=Action，
   * Dictionary 带 DestinationCharacterName + AssetName(项圈) + ShockIntensity + FocusAssetGroup。
   * 接收端只看消息内容，不校验发送者是否持有遥控器（服务器哑巴中继，执法在接收端）。
   */
  sendShockAction(targetNo: number, level: number, assetName: string, group: string): void {
    const clampedLevel = Math.max(1, Math.min(3, Math.floor(level)));
    const nickname = this.nameOf(targetNo) ?? String(targetNo);
    const dictionary: Array<Record<string, unknown>> = [
      { Tag: "DestinationCharacterName", MemberNumber: targetNo, Text: nickname },
      { Tag: "AssetName", AssetName: assetName, GroupName: group },
      { ShockIntensity: clampedLevel * 1.5 },
      { Tag: "FocusAssetGroup", FocusGroupName: group },
    ];
    this.limiter.send(C2S.ChatRoomChat, {
      Content: `TriggerShock${clampedLevel}`,
      Type: "Action",
      Dictionary: dictionary,
    });
    console.log(`[shock] TriggerShock${clampedLevel} -> ${nickname}（${assetName}@${group}）`);
  }

  /**
   * 道具互动权限白名单保护（#61，服务器端硬执法）：
   * ItemPermission=3 = 仅白名单/恋人可对 BOT 使用道具（server_app.js ChatRoomGetAllowItem）。
   * WhiteList 提交是整体替换 → 先读登录数据里的现有名单合并，防止覆盖丢人。
   * 自己（Source==Target）和 Owner 天然放行，无需加入名单。
   */
  setPermissionWhitelistOnly(extraWhitelist: number[]): void {
    const current = Array.isArray(this._player.WhiteList)
      ? (this._player.WhiteList as number[]).filter((n) => typeof n === "number")
      : [];
    const merged = Array.from(new Set([...current, ...extraWhitelist]));
    this.limiter.send(C2S.AccountUpdate, {
      ItemPermission: 3,
      WhiteList: merged,
    });
    // 本地记账（服务器也会应答 AccountUpdate 结果，这里乐观更新便于后续再合并）
    this._player.WhiteList = merged;
    this._player.ItemPermission = 3;
    console.log(
      `[permission] ItemPermission=3（仅白名单可动 BOT 道具），WhiteList=[${merged.join(", ")}]`
    );
  }

  /** BOT 当前的道具互动权限（0=所有人 1=除黑名单 2=支配者+白名单 3=仅白名单 4=仅恋人） */
  get botItemPermission(): number | undefined {
    const v = this._player.ItemPermission;
    return typeof v === "number" ? v : undefined;
  }

  /**
   * Action 公告回声追踪：发出的每条 Action 公告登记在案，
   * 服务器广播回来（自己也会收到）就销账；3 秒没收到说明服务器没转发（被校验拒绝），
   * 打印警告帮助定位"公告消失"问题（区分：服务器吞了 vs 接收方客户端不渲染）。
   */
  private pendingActionEcho = new Map<string, { count: number; timer: NodeJS.Timeout }>();

  /** 发 Action 类聊天广播（如 ActionTightenLittle / ActionAddLock），让房间里其他人看到动作 */
  sendChatAction(content: string, dictionary: unknown[]): void {
    console.log(`[action-send] ${content}（等待服务器广播回声确认…）`);
    const pending = this.pendingActionEcho.get(content);
    if (pending) {
      pending.count += 1;
      clearTimeout(pending.timer);
      pending.timer = this.armEchoTimeout(content);
    } else {
      this.pendingActionEcho.set(content, { count: 1, timer: this.armEchoTimeout(content) });
    }
    this.limiter.send(C2S.ChatRoomChat, {
      Content: content,
      Type: "Action",
      Dictionary: dictionary,
      Target: null,
    });
  }

  /** 3 秒内没收到该 Action 的广播回声 → 判定服务器未转发 */
  private armEchoTimeout(content: string): NodeJS.Timeout {
    return setTimeout(() => {
      const pending = this.pendingActionEcho.get(content);
      if (pending && pending.count > 0) {
        console.warn(
          `[action-missing] ${content} 发出后 3 秒内未收到服务器广播回声——` +
            `服务器没有转发这条公告（疑似被服务器端校验拒绝），` +
            `房间里任何人都看不到它。需要对照官方客户端的真实发送内容排查字典/Content。`
        );
        pending.count = 0;
        this.pendingActionEcho.delete(content);
      }
    }, 3000);
  }

  /** 收到自己发出的 Action 广播回声：服务器确认转发 */
  private confirmActionEcho(content: string): void {
    const pending = this.pendingActionEcho.get(content);
    if (!pending) return;
    pending.count -= 1;
    console.log(`[action-echo] ${content} 已被服务器广播（房间内其他客户端应能收到）`);
    if (pending.count <= 0) {
      clearTimeout(pending.timer);
      this.pendingActionEcho.delete(content);
    }
  }

  /** 取角色穿着（Appearance 数组），用于生成穿着摘要 */
  getAppearance(memberNumber: number): AppearanceEntry[] | null {
    const c = this.characters.get(memberNumber);
    return Array.isArray(c?.Appearance) ? (c!.Appearance as AppearanceEntry[]) : null;
  }

  getCharacter(memberNumber: number): Character | undefined {
    return this.characters.get(memberNumber);
  }

  /** 取角色的显示名：昵称（Nickname）优先于注册名（Name） */
  private displayName(c?: Character | null): string | null {
    if (!c) return null;
    return c.Nickname || c.Name || null;
  }

  /** 按名字（忽略大小写）解析成员号；昵称优先；未找到返回 null。
   *  支持多种格式：纯名字、"服务对象"、"#123456"、"服务对象#123456"、"123456"、"服务对象 #123456"、
   *  以及 SELF-TARGET 关键字 "(me)" / "me" / "myself" / "自己" → BOT 自己。
   */
  resolveMemberNumber(name: string): number | null {
    const raw = name.trim();
    if (!raw) return null;

    // 0) SELF-TARGET 字面量：让 BOT 能给自己穿/脱/调道具（#18）
    const lowered = raw.toLowerCase();
    if (lowered === "(me)" || lowered === "me" || lowered === "myself" || lowered === "自己" || lowered === "我") {
      return this._player.MemberNumber as number;
    }

    // 1) 任意位置含 #数字 → 直接按成员号查（处理 LLM 输出 members 列表里的 "服务对象#123456" 格式）
    const numMatch = raw.match(/#?(\d+)/);
    if (numMatch) {
      const no = Number(numMatch[1]);
      if (this.characters.has(no)) return no;
      // 自己的号（可能 characters 还没缓存自己）
      if (no === this._player.MemberNumber) return no;
    }

    // 2) 剥掉 # 后缀再按名字匹配（处理 "服务对象#123456" 当成 "服务对象" 来匹配）
    const stripped = raw.replace(/#.*$/, "").trim().toLowerCase();
    if (!stripped) return null;

    const selfName = (this._player.Name as string | undefined)?.toLowerCase();
    if (selfName && (selfName === stripped || selfName.includes(stripped))) {
      return this._player.MemberNumber as number;
    }
    for (const [no, c] of this.characters.entries()) {
      const display = this.displayName(c)?.toLowerCase();
      const regName = c.Name?.toLowerCase();
      if ((display && (display === stripped || display.includes(stripped))) ||
          (regName && (regName === stripped || regName.includes(stripped)))) return no;
    }
    return null;
  }

  /** 房间内已知成员（含自己），返回名字列表；优先用昵称。格式：别人为 "昵称#注册号"，自己为 "名字 (me)" */
  getMemberNames(): string[] {
    const names: string[] = [];
    const selfChar = this.characters.get(this._player.MemberNumber as number);
    const self = this.displayName(selfChar) || (this._player.Name as string | undefined);
    if (self) names.push(`${self} (me)`);
    for (const c of this.characters.values()) {
      if (c.MemberNumber === this._player.MemberNumber) continue;
      names.push(`${this.displayName(c) ?? `#${c.MemberNumber}`}#${c.MemberNumber}`);
    }
    return names;
  }

  nameOf(memberNumber?: number): string {
    if (memberNumber === undefined) return "unknown";
    if (memberNumber === this._player.MemberNumber) {
      return this.displayName(this.characters.get(memberNumber)) || (this._player.Name as string) || "self";
    }
    return this.displayName(this.characters.get(memberNumber)) ?? `#${memberNumber}`;
  }

  /** 该成员是否在当前房间（BC+ 指令要求发送者与目标同房，否则它直接无视） */
  isMemberInRoom(memberNumber: number): boolean {
    return this.characters.has(memberNumber);
  }

  /** 按名字在当前房间成员里查找成员号（不区分大小写；找不到返回 null）。不含 BOT 自己。 */
  findMemberByName(name: string): number | null {
    const target = name.trim();
    if (!target) return null;
    const selfNo = this._player.MemberNumber;
    for (const [no, ch] of this.characters) {
      if (no === selfNo) continue;
      const n = (ch.Name ?? "").trim();
      if (n === target || n.toLowerCase() === target.toLowerCase()) return no;
    }
    return null;
  }

  private handleLoginResponse(data: LoginResponseData): void {
    if (data && typeof data.MemberNumber === "number") {
      this._player = data;
      this._loggedIn = true;
      console.log("[bc] login OK:", data.Name, `(#${data.MemberNumber})`);
      this.onLogin?.(data);
    } else {
      this._loggedIn = false;
      console.log("[bc] login failed:", JSON.stringify(data));
    }
  }

  private handleChatMessage(data: ChatMessage): void {
    const senderName = this.nameOf(data.Sender);
    const type = data.Type ?? "Chat";
    const raw = data.Content ?? "";
    const prefix = type === "Whisper" ? "[whisper]" : type === "Emote" ? "*" : "";
    console.log(`[chat] type=${type} ${prefix}${senderName}: ${raw}`);
    if (data.Sender === this._player.MemberNumber) {
      // 自己发出的消息回声：Action 公告用于确认服务器确实转发了（诊断"公告消失"用）
      if (type === "Action") this.confirmActionEcho(String(raw));
      return;
    }

    // #89 BC+ 指令回执（Type=Activity, Content="BCPAction"）：BC+ 用"MISSING 文本兜底"技巧——
    //   Dictionary 首项的 Tag 故意指向一个不存在的模板键，BC 找不到模板就把 Text 当整条消息直接渲染。
    //   必须拦在下面的通用 Activity 分支之前，否则会被当成普通游戏动作（解析不出模板→静默丢弃）。
    if (type === "Activity" && raw === "BCPAction") {
      const dict = Array.isArray(data.Dictionary) ? (data.Dictionary as Array<Record<string, unknown>>) : [];
      // 优先取 Tag 指向 BCPAction 兜底键的那条（BC+ 固定把渲染文本放这里），取不到再退第一条带 Text 的
      const entry =
        dict.find((d) => d && typeof d.Text === "string" && String(d.Tag ?? "").includes("BCPAction")) ??
        dict.find((d) => d && typeof d.Text === "string");
      const text = typeof entry?.Text === "string" ? entry.Text : "";
      if (text) {
        console.log(`[bcp] 回执 <- ${senderName}：${text}`);
        this.onBCPMessage?.({
          kind: "reply",
          text,
          sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
          senderName,
        });
      } else {
        console.log("[bcp] 收到 BCPAction 但 Dictionary 里没有 Text，忽略");
      }
      return;
    }

    // #89 BC+ 协议消息本体（Type=Hidden, Content="BCP"，Dictionary 是普通对象）
    if (type === "Hidden" && raw === "BCP") {
      const dict = data.Dictionary as unknown;
      if (dict && typeof dict === "object" && !Array.isArray(dict)) {
        const payload = dict as Record<string, unknown>;
        const message = typeof payload.message === "string" ? payload.message : "(unknown)";
        const text =
          typeof payload.text === "string" ? String(payload.text) : JSON.stringify(payload).slice(0, 300);
        console.log(`[bcp] 协议消息 <- ${senderName}：message=${message} ${text}`);
        this.onBCPMessage?.({
          kind: "sync",
          message,
          text,
          payload,
          sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
          senderName,
        });
      } else {
        // BC+ 之外还有别的客户端用 Hidden+BCP？对象字典才对，数组说明不是 BC+
        console.log("[bcp] 收到 Content=BCP 的 Hidden 消息，但 Dictionary 不是普通对象（非 BC+ 协议），忽略");
      }
      return;
    }

    // 游戏动作消息（Type=Activity）：渲染成中文句子交给上层"感受"，不再直接丢弃
    if (type === "Activity") {
      const dict = Array.isArray(data.Dictionary) ? (data.Dictionary as Array<Record<string, unknown>>) : undefined;
      const text = resolveActivityMessage(typeof raw === "string" ? raw : "", dict, (no) => this.nameOf(no));
      const sourceNo = typeof data.Sender === "number" ? data.Sender : -1;
      const targetEntry = dict?.find((d) => typeof d.TargetCharacter === "number");
      const targetNo = typeof targetEntry?.TargetCharacter === "number" ? targetEntry.TargetCharacter : null;
      if (text) {
        this.onActivity?.({ text, sourceNo, targetNo, senderName, activityKey: String(raw) });
      }
      return;
    }

    // 挣扎广播（Type=Action, Content=ActionStruggle）：角色在被束缚时试图滑脱，是"叛逆"信号
    if (type === "Action" && raw === "ActionStruggle") {
      this.onActivity?.({
        text: `${senderName}挣扎着想要滑脱身上的束缚`,
        sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
        targetNo: null,
        senderName,
        kind: "struggle",
      });
      return;
    }

    // 牵引信号（#19）：皮带抓起/松开走 Action 广播（Dictionary 里带目标），
    // RemoveLeash/PingHoldLeash/别人对 BOT 的 HoldLeash 走 Hidden 定向（Target 字段是接收人=BOT）
    if (type === "Action" && (raw === "HoldLeash" || raw === "StopHoldLeash")) {
      const dict = Array.isArray(data.Dictionary) ? (data.Dictionary as Array<Record<string, unknown>>) : undefined;
      const targetEntry = dict?.find((d) => typeof d.TargetCharacter === "number");
      const targetNo = typeof targetEntry?.TargetCharacter === "number" ? targetEntry.TargetCharacter : null;
      this.onLeashSignal?.({
        kind: raw === "HoldLeash" ? "hold" : "release",
        sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
        targetNo,
        senderName,
      });
      return;
    }
    if (type === "Hidden" && (raw === "RemoveLeash" || raw === "PingHoldLeash" || raw === "HoldLeash")) {
      // 定向消息：Target 就是 BOT 自己（服务器只把定向消息发给目标）
      this.onLeashSignal?.({
        kind: raw === "RemoveLeash" ? "removed" : raw === "PingHoldLeash" ? "ping" : "incoming",
        sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
        targetNo: typeof data.Target === "number" ? data.Target : null,
        senderName,
      });
      return;
    }

    // 道具操作公告（#45）：别人穿/脱/锁/解/调松紧道具时官方客户端广播这些 Action 公告，
    // 字典里带完整的"谁对谁的哪个部位做了什么"（比 ChatRoomSyncItem 的最终状态更明确，
    // 尤其能感知"别人动了服务对象的束缚"和"服务对象自己松绳子/脱道具"）。
    if (type === "Action" && isItemActionContent(raw)) {
      const dict = Array.isArray(data.Dictionary) ? (data.Dictionary as Array<Record<string, unknown>>) : undefined;
      const info = parseItemAction(raw, dict);
      if (info) this.onItemAction?.(info);
      return;
    }

    // 只把真正的对话喂给大脑；忽略 Hidden/Status 等系统类消息。
    if (!["Chat", "Whisper", "Emote"].includes(type)) {
      // 例外：BC 的挣扎信号走的是 Status 通道（ChatRoom.js:2518 客户端 ChatRoomStatusUpdate("Struggle")，
      // 服务器原样转发 Content）。不能把所有 Status 一律丢，否则被绑者反复按挣扎按钮时 Dom 没有任何反应。
      if (type === "Status" && raw === "Struggle") {
        const senderNo = typeof data.Sender === "number" ? data.Sender : -1;
        // 启发式过滤（2026-09-04 23:43 用户截图反馈"服务对象 使用道具时误触发挣扎通知"）：
        //   BC 的 Status 通道是通用的——"Struggle" 这个 Content 也被非挣扎事件复用
        //   （如玩家对道具的普通操作广播）。之前不查 Sender 身上状态直接喂 LLM，
        //   导致她根本没挣扎却收到"她在挣扎"的假信号。
        //   现在：只在 Sender 身上真有束缚（Effect 含 Restrict/Block/Hide/Gag 等）时当真挣扎。
        //   Action+Content=ActionStruggle 那条（真挣扎事件）独立保留互不影响。
        const senderApp = this.characters.get(senderNo)?.Appearance ?? null;
        const senderEffects = collectEffects(Array.isArray(senderApp) ? senderApp : []);
        const RESTRICT_EFFECTS = new Set([
          "Block", "Hide", "HideRestraint", "HideAll", "HideBody",
          "OneArmRestricted", "BothArmsRestricted", "Prone", "Kneel",
        ]);
        const realStruggle = Array.from(senderEffects).some(
          (e) => RESTRICT_EFFECTS.has(e) || /^(Gag|Egged|Frozen|Tied|BlockWardrobe)/i.test(e)
        );
        console.log(
          `[struggle-debug] type=Status sender=${senderNo} effects=${[...senderEffects].join(",") || "(none)"} ` +
          `realStruggle=${realStruggle}`
        );
        if (!realStruggle) return;
        this.onActivity?.({
          text: `${senderName}挣扎着想要滑脱身上的束缚`,
          sourceNo: senderNo,
          targetNo: null,
          senderName,
          kind: "struggle",
        });
        return;
      }
      // 2026-09-04 19:20 修复：投降信号（ChatRoomStruggleGiveUp，Type=Action）走和 Struggle 一样的路。
      //   之前完全被"ignoring non-conversation"丢掉，LLM 看不到她放弃了，下一条响应就会误判她还在挣扎
      //   （实测：服务对象 说"我不挣扎了"+立即放弃 → BOT 训斥"刚说完就又想挣脱"+牵走，错得离谱）。
      if (type === "Action" && raw === "ChatRoomStruggleGiveUp") {
        this.onActivity?.({
          text: `${senderName}放弃了挣扎`,
          sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
          targetNo: null,
          senderName,
          kind: "struggle-giveup",
        });
        return;
      }
      // 2026-09-04 23:56 修复：挣扎正式开始信号（ChatRoomStruggleStart，Type=Action）。
      //   实测挣扎项圈时序：多次 Status=Struggle（伴随信号，真假难辨已被过滤器全吞）→
      //   Action=ChatRoomStruggleStart（真挣扎开始的正式广播）→ GiveUp。
      //   之前 Start 没有处理器被丢弃，导致 BOT 只看得到"放弃"看不到"开始"——
      //   她挣扎的几十秒里 BOT 是瞎的，直接跳到安抚阶段，跳过了挣扎期的训斥互动。
      if (type === "Action" && raw === "ChatRoomStruggleStart") {
        this.onActivity?.({
          text: `${senderName}开始挣扎，想要挣脱身上的束缚`,
          sourceNo: typeof data.Sender === "number" ? data.Sender : -1,
          targetNo: null,
          senderName,
          kind: "struggle",
        });
        return;
      }
      console.log(`[chat] ignoring non-conversation message (type=${type})`);
      return;
    }
    // 忽略空内容
    const content = typeof raw === "string" ? raw.trim() : "";
    if (content === "") {
      console.log("[chat] ignoring empty content");
      return;
    }
    // 忽略打字/频道切换等状态占位词（如 "Talk"/"null"）
    if (CHAT_PLACEHOLDERS.has(content)) {
      console.log(`[chat] ignoring status placeholder: "${content}"`);
      return;
    }
    this.onChat?.({ message: data, senderName });
  }

  private handleSyncCharacter(data: { Character?: Character[] | Character }): void {
    const chars = Array.isArray(data.Character) ? data.Character : data.Character ? [data.Character] : [];
    for (const c of chars) {
      if (c && typeof c.MemberNumber === "number") {
        const prev = this.characters.get(c.MemberNumber);
        // 整包覆盖缓存前对比锁相关字段：接收端（目标客户端）判定我们的道具更新非法时，
        // 会广播 ChatRoomCharacterUpdate 纠正包（Validation.js -> ChatRoom.js:5495-5497），
        // 表现为"刚上的锁/拉高的难度在整包里消失"。这种回滚以前完全静默，是 #21
        // （BallGag/LeatherCuffs 锁失效却毫无日志痕迹）的观测盲点，这里补日志。
        if (prev) this.logAppearanceCorrection(prev, c);
        this.characters.set(c.MemberNumber, c);
      }
    }
  }

  /**
   * 对比整包更新前后 Appearance 的锁/难度字段，打出回滚信号日志。
   * 只报"锁消失"和"难度被压回"两类（新增锁由 BOT 自己记账，不在此报）。
   */
  private logAppearanceCorrection(prev: Character, next: Character): void {
    const prevApp = Array.isArray(prev.Appearance) ? prev.Appearance : [];
    const nextApp = Array.isArray(next.Appearance) ? next.Appearance : [];
    interface AppEntry { Group?: string; Name?: string; Difficulty?: unknown; Property?: Record<string, unknown> }
    const nextByGroup = new Map<string, AppEntry>();
    for (const raw of nextApp) {
      const e = raw as AppEntry | null;
      if (e && typeof e.Group === "string") nextByGroup.set(e.Group, e);
    }
    for (const raw of prevApp) {
      const p = raw as AppEntry | null;
      if (!p || typeof p.Group !== "string" || typeof p.Name !== "string") continue;
      const n = nextByGroup.get(p.Group);
      const pProp = p.Property ?? {};
      const nProp = n?.Property ?? {};
      const wasLocked = pProp.LockedBy != null;
      const stillLocked = n != null && n.Name === p.Name && nProp.LockedBy != null;
      if (wasLocked && !stillLocked) {
        console.log(
          `[correction] ${prev.MemberNumber} ${p.Group}/${p.Name}: 锁状态被整包覆盖消失` +
          `（LockedBy=${String(pProp.LockedBy)} -> 无）——若非正常解锁，即接收端回滚了我们的上锁`
        );
      }
      if (
        typeof p.Difficulty === "number" && n && n.Name === p.Name &&
        typeof n.Difficulty === "number" && n.Difficulty < p.Difficulty - 1
      ) {
        console.log(
          `[correction] ${prev.MemberNumber} ${p.Group}/${p.Name}: 难度被整包压回 ${p.Difficulty} -> ${n.Difficulty}`
        );
      }
    }
  }

  private handleMemberJoin(data: { Character?: Character }): void {
    const c = data.Character;
    if (c && typeof c.MemberNumber === "number") {
      this.characters.set(c.MemberNumber, c);
      // #16：成员进房事件上报（限时回家——她到家判定的信号源）
      if (c.MemberNumber !== this._player.MemberNumber) {
        this.onMemberJoin?.(c.MemberNumber);
      }
    }
  }

  private handleMemberLeave(data: { SourceMemberNumber?: number }): void {
    if (typeof data.SourceMemberNumber === "number") this.characters.delete(data.SourceMemberNumber);
  }

  private handleMapData(data: { MemberNumber?: number; MapData?: unknown }): void {
    if (typeof data.MemberNumber !== "number") return;
    // 服务器中继格式：{ MemberNumber, MapData: { Pos: {X, Y}, PrivateState } }
    // （旧代码读 MapData.X 是错的——Pos 再嵌一层，导致 selfPos 永远是 null）
    const md = data.MapData as { Pos?: { X?: unknown; Y?: unknown } } | undefined;
    if (md && typeof md.Pos?.X === "number" && typeof md.Pos?.Y === "number") {
      this.positions.set(data.MemberNumber, { X: md.Pos.X, Y: md.Pos.Y });
      if (data.MemberNumber === this._player.MemberNumber) this._selfPos = { X: md.Pos.X, Y: md.Pos.Y };
    }
  }

  /** 查成员当前位置（进房 bundle 或位置更新缓存），未知返回 null */
  getPosition(memberNumber: number): { X: number; Y: number } | null {
    const fromCache = this.positions.get(memberNumber);
    if (fromCache) return fromCache;
    if (this._selfPos && memberNumber === this._player.MemberNumber) return this._selfPos;
    // 兜底：进房 bundle 的角色数据里带 MapData
    const c = this.characters.get(memberNumber) as { MapData?: { Pos?: { X?: unknown; Y?: unknown } } } | undefined;
    if (c?.MapData?.Pos && typeof c.MapData.Pos.X === "number" && typeof c.MapData.Pos.Y === "number") {
      return { X: c.MapData.Pos.X, Y: c.MapData.Pos.Y };
    }
    return null;
  }

  /** 道具变更回执：更新本地角色的 Appearance 缓存，保证穿着摘要不过期；并通知上层（滑脱检测） */
  private handleSyncItem(data: unknown): void {
    // 服务器下发结构是 { Source: int, Item: { Target, Group, Name, Property, Difficulty, ... } }，
    // Target/Group/Name 都藏在 data.Item 里（不是顶层），之前读顶层导致永远 return、事件从未触发。
    const raw = data as {
      Source?: number;
      Item?: {
        Target?: number; Group?: string; Name?: string | null;
        Property?: Record<string, unknown>; Difficulty?: number; Color?: string | string[];
      };
    } | null;
    const d = raw?.Item;
    if (!d || typeof d.Target !== "number" || typeof d.Group !== "string") return;
    const c = this.characters.get(d.Target);
    if (!c) return;
    // 重要：必须在 patchAppearance 之前取旧道具名——上层用 prevName vs name 判定"真穿戴/属性级变化"
    //   ②③④（挣扎 sync 校正 / 上锁 / 变体切换 / 难度调节）下 prevName === name，
    //   这种情况不该被当成"新穿上"（2026-09-04 17:30 用户截图反馈：服务对象 挣扎脚铐时 BOT 误以为"穿上了脚铐"）。
    const prevName = (c.Appearance as AppearanceEntry[] | undefined)?.find((e) => e?.Group === d.Group)?.Name ?? null;
    // 注意：ChatRoomSyncItem 里的 Difficulty 是相对值（相对资产基础难度），
    // 而外观缓存（bundle 语义）存绝对值，这里必须换算
    const absDifficulty =
      d.Name != null && typeof d.Difficulty === "number"
        ? getItemBaseDifficulty(d.Group, d.Name) + d.Difficulty
        : undefined;
    this.patchAppearance(c, d.Group, d.Name ?? null, d.Property, absDifficulty, typeof d.Color === "string" || Array.isArray(d.Color) ? d.Color : undefined);
    // 道具变更日志（2026-09-04 22:39 排查"无牵引绳却通过牵绳校验"悬案时补：
    //   之前完全静默，缓存何时被谁改成什么样无从查证）
    console.log(
      `[item-sync] #${d.Target} ${d.Group}: ${prevName ?? "(无)"} -> ${d.Name ?? "(脱下)"} (by #${raw?.Source ?? "?"})`
    );
    // 广播给上层：BOT 自己操作的回执和服务对象自己滑脱/脱下的变更都会到这里，由上层区分
    this.onItemChange?.({ targetNo: d.Target, group: d.Group, name: d.Name ?? null, prevName, senderNo: raw?.Source });
  }

  /** 就地更新某角色外观缓存里的一个槽位（Name=null 表示移除）。Property/Difficulty/Color 可选。 */
  private patchAppearance(
    c: Character,
    group: string,
    name: string | null,
    property?: Record<string, unknown>,
    difficulty?: number,
    color?: string | string[]
  ): void {
    const appearance = Array.isArray(c.Appearance) ? [...(c.Appearance as AppearanceEntry[])] : [];
    const idx = appearance.findIndex((e) => e?.Group === group);
    if (name == null) {
      if (idx >= 0) appearance.splice(idx, 1);
    } else {
      const patch: AppearanceEntry & { Property?: Record<string, unknown>; Difficulty?: number; Color?: string | string[] } = {
        ...(idx >= 0 ? appearance[idx] : {}),
        Group: group,
        Name: name,
      };
      if (property !== undefined) patch.Property = property;
      if (difficulty !== undefined) patch.Difficulty = difficulty;
      if (color !== undefined) patch.Color = color;
      if (idx >= 0) appearance[idx] = patch;
      else appearance.push(patch);
    }
    c.Appearance = appearance;
  }

  /**
   * 本地记录 BOT 自己发出的道具修改（服务器不把 ChatRoomSyncItem 回显给发送者，
   * 缓存若不自行更新，连续调节松紧 / 换变体时会基于过期数据计算）。
   * difficulty 传【绝对值】（bundle 语义），内部不做换算。
   */
  updateCachedItem(
    memberNo: number,
    group: string,
    name: string | null,
    opts?: { property?: Record<string, unknown>; difficulty?: number; color?: string | string[] }
  ): void {
    const c = this.characters.get(memberNo);
    if (!c) return;
    this.patchAppearance(c, group, name, opts?.property, opts?.difficulty, opts?.color);
  }

  private handleSearchResult(data: unknown): void {
    const rooms = Array.isArray(data) ? (data as ChatRoomSearchResult[]) : [];
    const cb = this.pendingSearches.shift();
    if (cb) cb(rooms);
  }

  private handleJoinResponse(data: unknown): void {
    // 成功时服务器回字符串 "JoinedRoom"，失败回错误信息字符串。
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    if (msg === "JoinedRoom") {
      console.log("[bc] join request accepted");
    } else {
      console.log("[bc] join failed:", msg);
      // 2026-09-05 18:18 踢房事故：join 成功后也可能被房主机器人踢出（服务器回 RoomKicked
      // 的 join 响应）。此时 BOT 实际已不在任何房——清掉残留的 _currentRoom，
      // 否则编排器误以为还在房里，布置动作全部无效（服务器不转发非房内消息）。
      this._currentRoom = null;
      this.onJoinFailed?.(msg);
    }
  }

  private handleRoomSync(data: ChatRoomSyncData): void {
    if (!data || typeof data.Name !== "string") return;
    this._currentRoom = data.Name;
    // 房间人数上限（BC 服务器在 ChatRoomSync 里带房间设置；字段缺失/类型不对就置 null 不判定）
    const limit = (data as { Limit?: unknown }).Limit;
    this._roomLimit = typeof limit === "number" && limit > 0 ? limit : null;
    // 重置房间内成员缓存（除自己），再按同步列表重建
    const chars = Array.isArray(data.Character) ? data.Character : [];
    this.characters.clear();
    for (const c of chars) {
      if (c && typeof c.MemberNumber === "number") {
        this.characters.set(c.MemberNumber, c);
      }
    }
    console.log(`[bc] in room: ${data.Name} (${chars.length} members)`);
    console.log(
      `[bc] members: ${chars
        .map((c) => `${c.Nickname || c.Name || "?"}#${c.MemberNumber}`)
        .join(", ")}`
    );
    // 临时诊断：打印每个角色（含 BOT 自己）身上的道具，定位"重启后 BOT 身上冒出束缚"的来源
    for (const c of chars) {
      const items = (Array.isArray(c.Appearance) ? c.Appearance : [])
        .filter((a: any) => a && a.Name)
        .map((a: any) => `${a.Group}:${a.Name}`)
        .join(", ");
      console.log(
        `[bc][diag-appearance] ${c.Nickname || c.Name || "?"}#${c.MemberNumber} => ${items || "(empty)"}`
      );
    }
    this.onRoomJoined?.(data.Name);
  }

  disconnect(): void {
    this.socket.disconnect();
  }
}
