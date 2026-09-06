# BC LLM Bot

一个 **无头（headless）** 的 Bondage Club 机器人客户端，用 **Node.js + TypeScript** 编写，核心是把 LLM 接入机器人角色。

它复用官方客户端的 Socket.IO 协议，但不依赖浏览器 DOM，可作为独立进程运行。

## 功能（当前 MVP）

- 连接服务器、账号登录、可选加入指定房间
- 接收并打印房间聊天（`ChatRoomMessage`）
- 缓存房间内角色状态（`ChatRoomSyncCharacter` / 进出房事件）、跟踪自身坐标（`ChatRoomSyncMapData`）
- **窗口限频器**：14 条 / 1200ms（对齐官方客户端默认）
- **LLM 决策大脑**：被 @ 点名（或开启全量响应）时，调用 OpenAI 兼容接口，输出结构化意图，经白名单校验后执行。支持的意图：
  - `say` / `emote` / `whisper`（私聊，按名字解析成员号）/ `move`（相对位移）/ `none`
- 安全护栏：动作白名单、回复长度上限、移动步长上限、限频、去重

## 快速开始

```bash
npm install

# 1) 复制配置并填入你的账号
cp .env.example .env
# 编辑 .env：至少填 BC_USERNAME、BC_PASSWORD；要接 LLM 再填 LLM_API_KEY

# 2) 运行（开发模式）
npm run dev

# 或编译后运行
npm run build
npm start
```

## 工作流程

```
登录 → (进房) → 等待 ChatRoomMessage
                    │
                    ▼
            是否被点名 / 全量响应?
                    │ 是
                    ▼
        组装上下文（人设 + 房间 + 最近聊天）
                    │
                    ▼
        LLM 输出 JSON 意图 → 白名单校验
                    │
                    ▼
   执行 say / emote / whisper / move
```

## 配置说明（.env）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `BC_USERNAME` / `BC_PASSWORD` | 游戏账号（必填） | — |
| `BC_SERVER_URL` | Socket.IO 服务器地址 | `https://bondage-club-server.herokuapp.com/` |
| `BC_ORIGIN` | 请求 Origin（鉴权用） | `https://www.bondage-europe.com` |
| `BC_PROXY_URL` | 连接服务器的 HTTP 代理地址（大陆网络直连不通时必填，如本机 Clash 混合端口） | — |
| `BC_ROOM_NAME` | 登录后加入的房间名（留空则待在默认房间） | — |
| `BOT_NAME` | 机器人显示名（用于点名检测，留空用登录名） | — |
| `BOT_PERSONA` | 人设 system prompt | 见 .env.example |
| `RESPOND_TO_ALL` | `true` 则响应所有消息，否则只响应点名 | `false` |
| `RESPONSE_COOLDOWN_MS` | 两次回复最小间隔 | `1500` |
| `MAX_REPLY_LENGTH` | 回复最大字数 | `400` |
| `LLM_API_KEY` | LLM API Key（不填则进入 dry-run 干跑模式） | — |
| `LLM_BASE_URL` | OpenAI 兼容接口地址（DeepSeek / Qwen 等） | `https://api.deepseek.com` |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |

## 重要提醒

- **网络与代理**：游戏服务器 `bondage-club-server.herokuapp.com` 在大陆网络下无法直连，需要在 `.env` 里配置 `BC_PROXY_URL`（指向本机代理，如 Clash 的 `http://127.0.0.1:7890` 或 `10086`）。bot 通过该 HTTP 代理以 long-polling 方式连接。
- **账号与合规**：在官方服务器运行机器人可能违反规则、导致封号，也可能打扰真实玩家。请自行评估风险，建议优先在自建 / 私有服务器测试。
- **成人内容**：BC 是成人游戏，RP 内容可能触发云端 LLM 的内容过滤。若被拒绝，请更换内容政策更宽松的模型或改用本地模型。
- **安全**：LLM 只能输出 `say` / `emote` / `whisper` / `move` / `none` 五种动作，其余一律拦截；发消息有间隔与长度限制，避免刷屏。

## 目录结构

```
src/
  config.ts     环境变量加载
  protocol.ts   协议常量与消息类型
  client.ts     无头客户端（连接/登录/收发/状态）
  brain.ts      LLM 决策大脑 + 意图白名单
  index.ts      主入口（事件驱动循环）
```

## 下一步（可扩展）

- 交互动作（`Action` / `Activity` 类型，如 click 动作、束缚机制）与道具更新（`ChatRoomCharacterItemUpdate`）
- 长期记忆：把关键事件摘要持久化，维护人设一致性
- 本地模型接入（Ollama / vLLM）
- 指令通道（如私聊控制台、Telegram 桥接）
