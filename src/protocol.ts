/**
 * Bondage Club 协议的常量与消息类型。
 * 事件名与消息结构对照开源实现：
 *  - bondage-club-bot-core（Python，聊天/账号/房间）
 *  - razor-client（Kotlin，完整网络层重写，动作类消息）
 */

/** 服务器 → 客户端事件名 */
export const S2C = {
  LoginResponse: "LoginResponse",
  LoginQueue: "LoginQueue",
  ForceDisconnect: "ForceDisconnect",
  ChatRoomMessage: "ChatRoomMessage",
  ChatRoomSync: "ChatRoomSync",
  ChatRoomSyncCharacter: "ChatRoomSyncCharacter",
  ChatRoomSyncMemberJoin: "ChatRoomSyncMemberJoin",
  ChatRoomSyncMemberLeave: "ChatRoomSyncMemberLeave",
  ChatRoomSearchResponse: "ChatRoomSearchResponse",
  ChatRoomSearchResult: "ChatRoomSearchResult",
  ChatRoomCreateResponse: "ChatRoomCreateResponse",
  ChatRoomSyncMapData: "ChatRoomSyncMapData",
  ChatRoomSyncPose: "ChatRoomSyncPose",
  ChatRoomSyncItem: "ChatRoomSyncItem",
  /** #78 BCE 客户端"给人穿衣服"用的整包同步通道（server_app.js:1835 ChatRoomSyncSingle，IO.to 全房发）——
   *  BOT 没注册这条路径时，所有通过 BCE 给 BOT 换装的操作都会静默丢失（缓存不更新、记住我的衣服抓不到） */
  ChatRoomSyncSingle: "ChatRoomSyncSingle",
  AccountBeep: "AccountBeep",
  AccountQueryResult: "AccountQueryResult",
} as const;

/** 客户端 → 服务器事件名 */
export const C2S = {
  AccountLogin: "AccountLogin",
  AccountBeep: "AccountBeep",
  AccountQuery: "AccountQuery",
  ChatRoomSearch: "ChatRoomSearch",
  ChatRoomJoin: "ChatRoomJoin",
  ChatRoomLeave: "ChatRoomLeave",
  ChatRoomCreate: "ChatRoomCreate",
  ChatRoomChat: "ChatRoomChat",
  ChatRoomCharacterMapDataUpdate: "ChatRoomCharacterMapDataUpdate",
  ChatRoomCharacterPoseUpdate: "ChatRoomCharacterPoseUpdate",
  ChatRoomCharacterItemUpdate: "ChatRoomCharacterItemUpdate",
  ChatRoomCharacterUpdate: "ChatRoomCharacterUpdate",
  AccountOwnership: "AccountOwnership",
  AccountUpdate: "AccountUpdate",
} as const;

/** 聊天消息类型（发送端） */
export type ChatType = "Chat" | "Whisper" | "Emote";

/** 聊天消息（ChatRoomMessage 事件负载，接收端） */
export interface ChatMessage {
  Type?: string;
  Sender?: number;
  Content?: string;
  Target?: number | null;
  [key: string]: unknown;
}

/** 登录响应（LoginResponse 事件负载） */
export interface LoginResponseData {
  MemberNumber?: number;
  Name?: string;
  [key: string]: unknown;
}

/**
 * 好友 Beep（服务器 AccountBeep 事件负载）。
 * 服务器转发的前提：发送方在接收方的 FriendList / 有所有权关系 / BeepType=Leash（server_app.js AccountBeep）。
 * MemberNumber=发送者、MemberName=发送者名字、BeepType=beep 类型（null/""=普通 Beep, "Leash"=牵绳, "AddFriend"=好友请求等）。
 */
export interface AccountBeepData {
  MemberNumber?: number;
  MemberName?: string;
  ChatRoomSpace?: string;
  ChatRoomName?: string;
  Private?: boolean;
  BeepType?: string | null;
  Message?: string;
  [key: string]: unknown;
}

/**
 * OnlineFriends 好友查询返回的单个好友条目（服务器 AccountQueryResult Result 数组项）。
 * 服务器 AccountQueryGetFriendInfo：Ownership/Submissive/Lover 可见所在房名（含私密房）；
 * 普通 Friend 在私密房只返回 Private:true 不返回房名。ChatRoom 字段仅在线且在房时有值。
 */
export interface FriendInfo {
  Type?: "Submissive" | "Lover" | "Friend";
  MemberNumber?: number;
  MemberName?: string;
  MemberNickname?: string;
  /** 好友所在房间名（不在房/普通好友在私密房时无此字段） */
  ChatRoomName?: string;
  /** 好友所在房间空间（""=女区 "X"=混区） */
  ChatRoomSpace?: string;
  ChatRoomMemberCount?: number;
  ChatRoomLimit?: number;
  /** true=好友在私密房（普通好友看不到房名） */
  Private?: boolean;
  [key: string]: unknown;
}

/** 房间内角色对象 */
export interface Character {
  MemberNumber: number;
  /** 角色会话唯一 ID（= socket.id）。服务器写库（ChatRoomCharacterUpdate）凭此定位目标角色 */
  ID?: string;
  Name?: string;
  Nickname?: string;
  ActivePose?: unknown;
  /** 所有权（账号资料级，ChatRoomSync bundle 下发；主人锁的权限依据） */
  Ownership?: {
    MemberNumber?: number;
    Name?: string;
    Notes?: string;
    Stage?: number;
    Start?: number;
  };
  Appearance?: unknown[];
  [key: string]: unknown;
}

/** 地图坐标 */
export interface MapPosition {
  X: number;
  Y: number;
}

/** 聊天室搜索请求（ChatRoomSearch 事件负载） */
export interface ChatRoomSearchRequest {
  Query: string;
  Space: string; // "" = 女性专属, "X" = 混合, "M" = 男性专属
  Game: string;
  FullRooms: boolean;
  Language: string;
  ShowLocked: boolean;
  SearchDescs: boolean;
  MapTypes: string[];
  Ignore: string[];
}

/** 聊天室搜索结果（ChatRoomSearchResult 事件负载中的单项） */
export interface ChatRoomSearchResult {
  Name: string;
  Description?: string;
  MemberCount?: number;
  MemberLimit?: number;
  Creator?: string;
  CreatorMemberNumber?: number;
  Game?: string;
  Language?: string;
  Space?: string;
  Locked?: boolean;
  MapType?: string;
  /** 房间禁用的互动类别（如 ["Leashing"] = 禁止牵绳）。#16 选房必须排除含 "Leashing" 的房间 */
  BlockCategory?: string[];
  [key: string]: unknown;
}

/** 加入房间后的房间同步（ChatRoomSync 事件负载） */
export interface ChatRoomSyncData {
  Name: string;
  Character?: Character[];
  [key: string]: unknown;
}
