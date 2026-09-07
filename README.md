# BC LLM Bot

> ⚠️ **成人内容警告（18+）**：本项目对接的目标游戏 Bondage Club 是成人向 BDSM 主题游戏，bot 的人设与交互内容包含成人角色扮演（RP）元素。本项目仅适合成年人使用，请遵守你所在地区的法律与所使用平台的规定。

一个 **无头（headless）** 的 Bondage Club 机器人客户端，用 **Node.js + TypeScript** 编写。核心是把 LLM 接入机器人角色：复用官方客户端的 Socket.IO 协议，但不依赖浏览器 DOM，可作为独立进程 7x24 运行。

## 功能总览

### 基础能力
- 连接服务器、账号登录、搜索/加入房间（支持指定房间名或自动找热闹房）
- 接收房间聊天、缓存角色状态、进房姿势、说话/私聊/表情/移动
- 窗口限频器（对齐官方客户端），防刷屏与长度限制

### LLM 决策大脑
- OpenAI 兼容接口（DeepSeek / Qwen / 本地模型均可），输出结构化意图
- **动作队列**：一次决策最多 3 个动作按序执行（说话、表情、道具、动作链）
- 动作白名单校验：LLM 只能执行白名单内的操作，其余一律拦截

### 一对一服务模式（核心玩法）
- 通过 `SERVE_MEMBER` 指定服务对象，其余玩家默认只礼貌回应
- **人设系统**：`BOT_PERSONA` 完全自定义（默认为通用人格）
- **情绪系统**：怒气阶梯（微恼/恼火/暴怒）、亲密度（生疏→溺爱）、恳求阶梯、冷处理、安全词真拒绝
- **长期记忆**：关键事实持久化，跨重启保持人设一致

### 束缚与道具
- 上锁/解锁、TYPED 多变体道具处理、锁具难度管理
- **手持道具**：86 件道具 + 14 类道具动作（挠痒/拍打/抚摸等）
- **服装系统**：27 个槽位穿脱、110 款精选服装、启动时按存档自动重穿
- 跨房牵引、防挣脱变体、锁具白名单

### 游戏与模式
- **限时回家**：束缚→牵到热闹房挂牌→限时回家，胜负奖惩体系
- 猜数字、24 点等小游戏
- **主动/被动模式**：窗口期内 bot 主动感知、自主决策；平时纯事件驱动
- **集中/扩散模式**：一对一专注 ↔ 社交模式（可跟路人互动，边界可控）

## 快速开始（老手版）

```bash
npm install

# 1) 复制配置并填入你的账号
cp .env.example .env
# 编辑 .env：至少填 BC_USERNAME、BC_PASSWORD、SERVE_MEMBER；要接 LLM 再填 LLM_API_KEY

# 2) 编译并运行
npm run build
npm start
```

## 从零部署（新手版，一步步来）

### 第 0 步：准备三样东西

| 需要什么 | 去哪弄 | 说明 |
|----------|--------|------|
| **Node.js 22+** | https://nodejs.org 下载 LTS 版安装 | 装完在终端输 `node -v` 能出版本号即可 |
| **DeepSeek API Key** | https://platform.deepseek.com 注册 → 充值几块钱 → 创建 API key | bot 的"大脑"。也可以换成任何 OpenAI 兼容接口（Qwen/本地模型） |
| **BC 游戏账号** | https://www.bondage-europe.com 注册 | **强烈建议新注册一个号专用做 bot**——不要用你自己的主号（有封号风险，且两个进程同账号会互相顶下线） |

### 第 1 步：下载代码

```bash
git clone https://github.com/lajizhou1/bc-llm-bot.git
cd bc-llm-bot
npm install
```

（不用 git 的话：GitHub 页面绿色 Code 按钮 → Download ZIP → 解压后在该文件夹里运行 `npm install`）

### 第 2 步：配置 .env

复制 `.env.example` 为 `.env`（Windows 直接复制粘贴改名），然后用记事本打开，**最少填这 4 项**：

```ini
BC_USERNAME=你的bot账号名
BC_PASSWORD=你的bot账号密码
SERVE_MEMBER=服务对象的注册号（bot 只对这个人扮演主人/仆人，其他人只礼貌回应）
LLM_API_KEY=sk-你的DeepSeek密钥
```

怎么查注册号：游戏里点开对方资料卡，名字旁边的 `#数字` 就是。

**大陆网络必须加代理**（游戏服务器被墙）：

```ini
BC_PROXY_URL=http://127.0.0.1:7890
```

端口按你本机代理软件改（Clash 默认 7890，v2rayN 默认 10809）。

### 第 3 步：编译 + 启动

```bash
npm run build
npm start
```

看到这几行日志就是**启动成功**：

```
[bc] login OK: 你的bot名 (#注册号)
[bc] in room: xxx (n members)
[bc] bot is ready. Waiting for messages...
```

bot 会自动进自己的房间（没有就自动创建）。让你的服务对象凭**房名**进房即可。

### 第 4 步：日常开关

- **停止**：终端按 `Ctrl + C`（或直接关窗口）
- **再启动**：不用重新编译，直接 `npm start`
- **改了 .env**：保存后重启 bot 才生效
- ⚠️ **只能跑一个实例**：同一账号开两个进程会互相顶下线。启动前确认上一个已经关了

### 常见问题

| 症状 | 原因与解法 |
|------|-----------|
| 启动卡在连接/登录超时 | 代理没配或端口不对，检查 `BC_PROXY_URL` |
| `login OK` 但马上掉线 | 另一个实例在跑同账号（包括你自己浏览器开的游戏页面用了同一账号） |
| bot 说话很慢（30 秒+）| DeepSeek 高峰期拥堵，属正常；介意可换模型或本地部署 |
| 想换 bot 的性格 | `.env` 里 `BOT_PERSONA`（完全自定义人设）|
| bot 的衣服乱了 | 让服务对象对它说"重穿我的衣服" |

### ⚠️ 隐私提醒

`.env` 里有你的账号密码和 API key，**永远不要**把它提交到 git、截图或发给别人。仓库自带的 `.gitignore` 已默认排除它。

全部配置项说明见 [.env.example](.env.example)（每项均有中文注释）。

## 数据来源与版权声明

- 本项目采用 [MIT 许可证](LICENSE) 开源——可自由使用、修改、分发，需保留版权声明。
- `data/` 目录下的道具目录（bc-catalog）、可锁资产表（lockable-assets）、手持道具表（handheld-*）等数据，**提取自 [Bondage Club 官方开源代码](https://gitgud.io/BondageProjects/Bondage-College)**，仅用于客户端协议兼容，版权归 Bondage Projects 原作者所有。
- 本仓库**不包含 BC 官方源码本体**（官方明确声明代码不可公开再分发）。
- 本项目为个人爱好者项目，与 Bondage Projects 无官方关联。BC 社区存在使用无头 bot 的传统（如 BCX 作者维护的 BotAPI 库），但请在使用时遵守游戏规则、尊重其他玩家。

## 重要提醒

- **网络与代理**：游戏服务器在大陆网络下无法直连，需要在 `.env` 里配置 `BC_PROXY_URL`（指向本机代理，如 Clash 的 `http://127.0.0.1:7890`）。
- **账号与合规**：在官方服务器运行 bot 存在账号风险，请自行评估；建议 bot 只与 consenting 玩家互动，不打扰陌生人。
- **成人内容与模型选择**：BC 是成人游戏，RP 内容可能触发云端 LLM 的内容过滤。若被拒绝，请更换内容政策合适的模型或改用本地模型。
- **安全**：LLM 输出经白名单校验后才执行；`SAFE_WORD` 安全词是代码级兜底（说出即真正拒绝），不依赖 LLM 判断。

## 目录结构

```
src/
  index.ts      主入口（事件驱动循环、各系统集成）
  client.ts     无头客户端（连接/登录/收发/状态同步）
  brain.ts      LLM 决策大脑（意图解析、prompt 组装、动作队列）
  config.ts     环境变量加载
  skills.ts     技能系统（道具/锁具/服装/手持道具表）
  anger.ts      怒气系统
  intimacy.ts   亲密度系统
  memory.ts     长期记忆
  game*.ts      游戏框架与各游戏实现
  outfit.ts     服装与外观
  protocol.ts   协议常量与消息类型
data/           功能数据表（从 BC 开源码提取，见版权声明）
scripts/        工具脚本（数据提取/测试）
```
