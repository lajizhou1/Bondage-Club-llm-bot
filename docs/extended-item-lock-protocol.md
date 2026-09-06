# BC 扩展道具（变体/松紧）与锁系统 — 协议调研报告

> Task #9 产出 · 2026-09-03
> 来源：官方服务器源码 `Ben987/Bondage-Club-Server/app.js` + 客户端源码镜像 `awdrrawd/Bondage-College-Mirror`（bondageclub 分支，昨日仍在同步）
> 本地源码快照：`.reference/bc-fetch/`（含行号引用）

---

## 0. 一句话总结

**服务器是"哑巴中继"，真正的执法者是每个玩家自己的客户端（Validation.js）。**
BOT 发的消息只要格式与官方客户端一致，就能通过所有人客户端的本地校验。

---

## 1. 消息通道（已实证）

### 发送：`ChatRoomCharacterItemUpdate`
官方客户端构造处：`ChatRoom.js:3602`（`function ChatRoomCharacterItemUpdate(C, Group)`）

```json
{
  "Target": 123456,
  "Group": "ItemArms",
  "Name": "HempRope",
  "Color": "Default",
  "Difficulty": 0,
  "Property": { "...": "整个 Property 对象原样发送" },
  "Craft": null
}
```

### 服务器处理：`app.js:1954`
只做三件事，**完全不校验 Property 内容**：
1. 检查 `Target` 是数字、`Group` 是字符串
2. 检查发送者未被封禁、对目标有道具使用权（`ChatRoomGetAllowItem`）
3. 原样广播 `ChatRoomSyncItem { Source, Item }` 给房间里**除发送者以外**的所有人

⚠️ 发送者收不到自己的回执（与我们 ownItemOps 机制吻合）。
⚠️ 注释明说 "does not update the database"——ItemUpdate 只改房间内实时状态，落库由目标玩家自己同步外观时完成。

### 接收：`ChatRoom.js:5444`（`function ChatRoomSyncItem`）
每个客户端收到后：
1. `ValidationResolveAppearanceDiff` 本地校验（见 §5）
2. 不合法 → **回滚并广播"纠正"更新**（我们的修改会被打回）
3. 合法 → `wornItem.Property = item.Property`（**直接采用我们发的 Property，不会重新推导**）

---

## 2. TYPED 变体（绳子绑法等）

### 存储格式（关键！）
现代客户端用 **`Property.TypeRecord`**，遗留的 `Property.Type` 字符串仍兼容（`ExtendedItemTypeToRecord` 按选项名找序号转换）。

> ⚠️ **TypeRecord 的键名不是资产名，而是字面量 `"typed"`**（2026-09-03 实测踩坑修正）：
> `TypedItem.js` 的 `TypedItemCreateTypedItemData` 中，配置无 `Name` 字段时键名取
> `ExtendedArchetype.TYPED` = `"typed"`（`Assets_Female3DCGExtended.js:20`）。
> 麻绳/尼龙绳/单手套/拘束衣/项圈连手铐等白名单 TYPED 道具配置均无 `Name` 字段。
> 若误用资产名作键（如 `{"HempRope": 9}`），接收方客户端 `TypedItemInit` 找不到序号，
> 会**静默重置回第 0 个选项**（普通手腕捆绑），消息不报错但变体不生效。

```json
{ "TypeRecord": { "typed": 1 } }
```
= 第 2 个选项（0 起）= BoxTie。

### HempRope（ItemArms 手臂组）选项表（0 起）
| # | 名称 | BondageLevel | 姿势 | 变体难度 | 备注 |
|---|------|----|------|----|------|
| 0 | WristTie | 1 | BackBoxTie | 1 | |
| 1 | BoxTie | 1 | BackBoxTie | 1 | NPC 默认 |
| 2 | CrossedBoxtie | 1 | BackBoxTie | 1 | |
| 3 | RopeCuffsBack | 1 | BackCuffs | 1 | |
| 4 | WristElbowTie | 2 | BackElbowTouch | 2 | |
| 5 | SimpleHogtie | 2 | Hogtied | 2 | |
| 6 | TightBoxtie | 3 | BackBoxTie | 3 | |
| 7 | WristElbowHarnessTie | 3 | BackElbowTouch | 3 | |
| 8 | KneelingHogtie | 4 | Kneel+BackElbowTouch | 3 | 冻结+屏蔽手脚 |
| 9 | Hogtied | 4 | Hogtied | 3 | 冻结+屏蔽手脚 |
| 10 | AllFours | 6 | AllFours | 3 | |
| 11 | BedSpreadEagle | 1 | Yoked | 5 | 前提：在床上 |
| 12 | SuspensionKneelingHogtie | 6 | Kneel+BackElbowTouch | 6 | 悬吊，可调高度 |
| 13 | SuspensionHogtied | 8 | Hogtied | 6 | 悬吊 |
| 14 | SuspensionAllFours | 8 | AllFours | 6 | 悬吊 |

（ItemLegs/ItemFeet 组的 HempRope 是另一套选项：Basic/FullBinding/Link/Frogtie/Crossed/Mermaid）

### 切换变体的消息
- `Name` 不变（还是 HempRope），`Property` = 旧 Property **合并**新选项的 Property 字段（SetPose / AllowActivePose / Difficulty / Effect / Block / AllowActivityOn）+ 更新 TypeRecord
- 接收端直接采用我们发的 Property（`ChatRoom.js:5474`），所以要**把官方客户端会合并的字段一起带上**，最稳妥的做法：以读取到的当前 Property 为底，删旧选项专属字段、合新选项字段、改 TypeRecord
- BondageLevel 技能检查：仅本地玩家施加时强制；远程源只跑宽松的 `TypedItemValidateOption`（`ExtendedItem.js:1411`）——BOT 理论上不受限，但为公平性可自行遵守

---

## 3. 松紧调节（Tighten / Loosen）

来源：`TightenLoosenItem.js`（全文件 151 行，已完整解读）

- **本质：修改 `item.Difficulty`**（绝对值语义：`TightenLoosenItem.js` 中 `item.Difficulty ??= item.Asset.Difficulty` 铁证）
- HempRope 基础难度 = **3**（`Female3DCG.js` 四个绳槽均如此；BOT 白名单全部道具的基础难度已提取进 `src/skills.ts` 的 `ITEM_BASE_DIFFICULTY` 表）
- 调节幅度：小 ±2，大 ±4
- 下限：**-10**（固定，`TightenLoosenItemMinimumDifficulty`）
- 上限：施加者 Bondage 技能等级 + 4 + 资产基础难度（官方公式 `TightenLoosenItemLoad`；BOT 技能按 0 算 → 相对值上限 **+4**）
- 官方客户端调节后发的是 **`ChatRoomCharacterUpdate` 整包**（携带改过的 `item.Difficulty`），并同发聊天动作广播。

### wire Difficulty 双通道语义（✅ 已从源码完全确证，取代早先"实测校准"的存疑）

**两条通道的 Difficulty 语义不同，绝不能混用：**

| 通道 | 消息 | Difficulty 语义 | 证据 |
|------|------|----------------|------|
| 单道具更新 | `ChatRoomCharacterItemUpdate`（发）→ 服务器转 `ChatRoomSyncItem`（收） | **相对值** = `item.Difficulty - Asset.Difficulty` | 发送端 `ChatRoom.js:3587` 明确做减法；接收端 `CharacterAppearanceSetItem`（`Appearance.js:1158`）做 `绝对 = ItemAsset.Difficulty + DifficultyFactor` 加回来 |
| 外观整包 | `ChatRoomSync` / `ChatRoomCharacterUpdate`（bundle） | **绝对值**（`ServerBundledItemFromAppearanceItem` 原样存 `item.Difficulty`，falsy 时省略字段） | `Server.js:765` |

**推论（BOT 实现已遵循）：**
1. BOT 的外观缓存来自 bundle → 缓存里读到的是**绝对值**；走单道具通道发送前必须 `相对 = 缓存绝对 - 基础难度`，否则会超调/反向。
2. `handleSyncItem` 收到他人单道具更新时，wire 相对值要 `+ 基础难度` 换算成绝对值再入缓存，防止污染。
3. 服务器把 `ChatRoomSyncItem` 广播给房间其他人但**不含发送者自己**（`socket.to(room)`）→ BOT 自己的修改不会回显，必须本地记账（`client.updateCachedItem`）。
4. 官方切变体走 `ChatRoomCharacterUpdate` 整包，**整包会带上未变的 item.Difficulty → 官方切变体保留紧度**；BOT 走单道具通道，若不带 Difficulty，接收端会把道具重建为基础难度 → **重穿/换变体必须显式携带当前调节量**，否则紧度被清零（这正是"绑成驷马并绑紧后查看却没变化"的主因）。

### 双层难度结构（Struggle.js:763 `StruggleStrengthGetDifficulty`）

总挣脱难度 = **`item.Difficulty`（道具级，绝对值，收紧/放松调的是它）** + **`Property.Difficulty`（属性级，变体自带）**。

- 变体的额外难度存在 `Property.Difficulty`（如 `Female3DCGExtended.js` 中 HempRope 各绑法变体配置），BOT 的 VARIANTS 表已转录该字段。
- 所以"绑成驷马后挣脱更难"来自变体的 Property.Difficulty，与"绑紧一点"调的 item.Difficulty 是两个独立层。

### 接收端校验（防止难度被打回）

`ChatRoomSyncItem` → `ValidationResolveAppearanceDiff`（modify diff）→ 若 `ValidationCanAddItem` 为 false，难度会被打回原值（`Validation.js:334-338`）；通过后 `CharacterAppearanceSetItem` 应用相对难度。校验通过的前提下 Difficulty 可自由修改。

---

## 4. 锁系统

### 概念
锁是 `ItemMisc` 组的 `IsLock` 资产，**不是独立穿戴的道具**。上锁 = 修改目标道具的 Property。

### 上锁的 Property 变化（`Inventory.js:1429 InventoryLock`）
```json
{
  "Effect": ["...原有...", "Lock"],
  "LockedBy": "MetalPadlock",
  "LockMemberNumber": 258939,
  "LockMemberName": "ljzsbot",
  "...锁专属基线属性（见下表）": ""
}
```

### 常用锁具与专属属性（BaselineProperty）
| 锁 | 专属属性 | 说明 |
|----|---------|------|
| MetalPadlock | 无 | 最普通，钥匙 MetalPadlockKey 解 |
| TimerPadlock | RemoveTimer/ShowTimer | 定时锁，到期自动解锁，**MaxTimer=300 秒**（试验锁） |
| TimerPasswordPadlock | Password/Hint/LockSet/RemoveItem/ShowTimer/EnableRandomInput/MemberNumberList | 密码+定时，**MaxTimer=14400 秒（4 小时）** |
| CombinationPadlock | CombinationNumber | 4 位数字密码锁（`/^\d{4}$/`） |
| PasswordPadlock | Password/Hint/LockSet/RemoveOnUnlock | 文字密码锁（**必须 1-8 个大写字母** `/^[A-Z]{1,8}$/`，数字密码只能走 CombinationPadlock） |
| HighSecurityPadlock | MemberNumberListKeys | 高安全锁 |
| OwnerPadlock | 无 | **主人锁**：所有权仪式锁，无密码无定时，仅 Owner 本人（和穿戴者自己）能上/解。**BOT 已开放（#12 后续）**，前置条件见下节 |
| OwnerTimerPadlock | RemoveTimer/ShowTimer | **主人定时锁**：到期自动开，**MaxTimer=3024000 秒（35 天）**，其余同 OwnerPadlock |
| MistressPadlock | — | 仅 Mistress |
| LoversPadlock / LoversTimerPadlock | — | 仅 Lover（LoversTimerPadlock MaxTimer=604800 秒=1 周） |

### 主人锁（OwnerPadlock / OwnerTimerPadlock）机制（✅ 2026-09-03 源码确证 + BOT 已实装）

**权限判定链**（Validation.js:463 `ValidationIsLockChangePermitted` + Character.js:466/474）：
```
fromOwner = 目标.IsOwnedByMemberNumber(操作者注册号) || fromSelf
IsOwnedByMemberNumber(n) = (Ownership.MemberNumber === n)
→ Owner 锁：只有"目标资料里设置的 Owner"和"目标自己"能上/解；其他人（含上锁者无身份）发送的修改会被目标客户端静默回滚
```

**Ownership 是账号资料级字段**（非房间状态）：
- 服务对象 要先在游戏资料里把 ljzsbot（258939）设为 Owner，BOT 才能上/解主人锁；
- 房间同步数据里能看到：`ChatRoomSync` bundle 的角色对象含 `Ownership: { MemberNumber, Name, Notes, Stage, Start }`（server_app.js:1602）——BOT 用它判断"我是不是服务对象的 Owner"；
- 所有权建立走 `AccountOwnership` 流程（试用 7 天 → 正式，server_app.js:85 OwnershipDelay=604800000ms）。

**BOT 实装**（2026-09-03）：
- `skills.ts`：LOCKS 表加 OwnerPadlock / OwnerTimerPadlock（`ownerOnly: true` 标记）；
- `brain.ts`：BrainContext 加 `serveOwnedByBot`，user prompt 注入所有权状态行；
- `index.ts`：item_lock 执行层校验 `目标.Ownership.MemberNumber === BOT 注册号`，不满足直接拒绝（日志提示"对方需先在资料里把 BOT 设为主人"）——这是执法兜底，prompt 层引导之外防止 LLM 误发被静默回滚；
- prompt 教学（2026-09-03 用户提供核心场景后更新）：主人锁的**双重价值** = 所有权仪式 + **唯一防他人作弊的锁**——
  - (a) **游戏保护**：游戏规则涉及束缚时（被绑着直到分出胜负），其他玩家能解开一切普通锁（数字密码只有 1 万种可猜、字母密码可猜、金属锁钥匙是通用道具、定时锁等时间到就行），主人锁是唯一"其他玩家永远解不开"的锁；
  - (b) **惩罚完整性**：输了游戏的锁人惩罚，防止其他玩家中途"救人"破坏惩罚；
  - (c) **无人看管时段**：BOT 暂离/下线期间束缚应保持原状；
  - (d) **专属保护请求**：服务对象主动说"除了你谁都不许解"；
  - (e) **所有权仪式**：项圈宣示/长期归属（保留原有场景）；
  - **安全守则**：游戏/惩罚/看管用途优先用 OwnerTimerPadlock（timer = 预计时长 + 充足缓冲，如 30 分钟游戏设 90 分钟），防止 BOT 意外掉线把人锁死；纯 OwnerPadlock（无定时）仅用于项圈仪式——上了解不了，直到 BOT 亲手开。

**解锁语义**：BOT 是 Owner 时可直接解（含未到期的 OwnerTimerPadlock——`remove && fromOwner` 同样放行，Validation.js:463 无时间检查）。

### ⚠️ RemoveTimer 语义（✅ 2026-09-05 源码全链路确证，推翻"5 分钟挣扎自开"旧误读）
- Property 里的 `RemoveTimer` 是**绝对到期时间戳（毫秒）**，不是剩余秒数；
- 服务器（接收端 Validation.js:952）clamp：`RemoveTimer` 超过 `now + MaxTimer*1000` 时打回到上限（容差 5 秒）；
- 资产上的 `RemoveTimer: 300`（Female3DCG.js）只是**玩家 UI 上锁时的初始默认时长**（Dialog.js:2030 → InventoryLock Update=true → Timer.js:166 TimerInventoryRemoveSet 写 `Property.RemoveTimer = now+300s`），玩家随后可在锁界面用 +/- 按钮加减时长（OwnerTimerPadlock.js，上限 MaxTimer）；
- **BOT wire 路径不受默认值影响**：接收端只做 MaxTimer 上限 clamp，BOT 发的 `Property.RemoveTimer` 原样保留（接收路径不调 InventoryLock；Validation.js:409 的 `InventoryLock(...,false)` 仅是非法变更回滚）；
- **到期自动开锁由佩戴者客户端执行**：Timer.js:81 TimerInventoryRemove 每 1.7s 轮询自己身上的到期锁 → ValidationDeleteLock + 广播 `TimerRelease`/`TimerReleaseMany`——**不依赖上锁者在线**（BOT 掉线锁也会到点自动开，是天然防锁死兜底）；
- **挣扎与 RemoveTimer 无关**（Struggle.js 无此字段）；挣扎能否脱出走道具难度判定；
- OwnerTimerPadlock MaxTimer=3024000 秒（5 周）、LoversTimerPadlock=604800（1 周）、MistressTimerPadlock=14400。

### 基线属性的合并语义（✅ ExtendedItem.js:236 ExtendedItemInitNoArch）
`InventoryLock` 调 `InventoryItemMisc<Lock>Init` → `ExtendedItemInitNoArch`：**字段缺失（== null）时才写默认值**，已有值不覆盖。BOT 的 `buildLockProperty` 已照此实现。

### 前提条件
目标道具必须 `AllowLock: true`（或 `AllowLockType` 允许当前 TypeRecord 的变体）——`Inventory.js:1409`。
**绳索（HempRope 等）没有 AllowLock，不能上锁**；项圈/手铐/单手套/拘束衣等可以。

### 上锁/解锁的完整流程（官方客户端）
1. 修改 Property（如上）
2. 发 `ChatRoomCharacterItemUpdate`（携带新 Property）
3. 发聊天广播（`Dialog.js:2032` + `ChatRoom.js:3547`）：
   - 上锁：`ChatRoomChat { Content: "ActionAddLock", Type: "Action", Dictionary: [...source, dest, target, PrevAsset(目标道具), NextAsset(锁), FocusAssetGroup] }`
   - 解锁：Content 为 **"ActionUnlock"**（主动解与挣扎解通用；#12 实测确证——"ActionRemoveLock" 在 Interface.csv 不存在，广播会显示 MISSING TEXT）；定时锁到期自动开则是佩戴者客户端广播 "TimerRelease"（Timer.js:133）

### 解锁 = 反向操作
删 `LockedBy` + 全部锁专属属性 + Effect 去掉 "Lock"。

---

## 5. 校验规则（Validation.js — BOT 的行为边界）

接收方客户端对 ItemUpdate 跑 `ValidationResolveAppearanceDiff`：

1. **fromSelf 永远合法**（目标自己发的）
2. 道具被目标 block/limit 且来源无豁免 → 拒绝
3. **锁相关**（`Validation.js:370`）：
   - 普通锁（Metal/Timer/Combination/Password/HighSecurity）：有道具使用权即可上/换/解 ✅ BOT 可用
   - Owner/Mistress/Lover/Family 锁：对应身份才能操作 ❌
   - `LockedBy/LockMemberNumber/LockMemberName/LockMessage` 不可被无锁权限者修改
   - `Password/CombinationNumber/RemoveTimer/Hint/ShowTimer/EnableRandomInput/LockSet/LockPickSeed/MemberNumberList`（受限属性）只有锁权限者能改
4. **Difficulty / Color / Property 字段**：来源有"添加该道具"权限时可改（服务对象 已授权 BOT 用道具 ✅）

---

## 6. BOT 实现要点（交给 #10 / #12）

1. `client.ts`：`sendItemUpdate` 扩展支持 `property` 与 `difficulty` 参数；新增 `sendChatAction(content, dictionary)` 发 Action 类聊天
2. 读外观：`Property.TypeRecord["typed"]` 判当前变体；`Property.LockedBy` 判锁
3. 变体切换：以当前 Property 为底，按选项表合并新字段 + 改 TypeRecord，整体重发
4. 松紧：Difficulty 相对值 ±2/±4，clamp 到 [-10, 技能+4]；**实测校准相对/绝对语义**
5. 上锁：完整 Property（含 Effect/LockedBy/LockMemberNumber/Name + 锁基线属性）+ ActionAddLock 广播
6. 解锁：清锁字段 + 去掉 Effect 的 "Lock" + ActionRemoveLock 广播
7. 推荐锁具：MetalPadlock（无脑）、CombinationPadlock（密码 123456 正好有伏笔）、TimerPadlock（定时）
8. 注意：服务对象 的 block/limit 列表若加了对应道具/类型会被拒——测试时留意

## 7. 遗留不确定点（实现时验证）

- [x] ~~wire Difficulty 的绝对/相对语义~~ ✅ 已从源码确证：单道具通道 = 相对值，bundle 整包 = 绝对值（详见第 3 章"双通道语义"）
- [x] ~~BOT 账号的 Bondage 技能等级~~ ✅ 已按保守值处理：BOT 技能按 0 算，相对上限 clamp +4
- [x] ~~TimerPadlock 的 RemoveTimer 单位确认（秒）~~ ✅ 已确证：Property.RemoveTimer = **绝对到期时间戳(ms)**，非秒数；clamp 到 now + MaxTimer*1000（见第 4 章）
- [ ] 变体切换的聊天广播格式（DialogPrefix.Chat 如 "RopeBondageSet"）——低优先级，不影响功能
- [ ] 定时锁到期后的自动解锁回执格式（服务器下发什么消息）——首次实测定时锁时观察
