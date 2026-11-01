# dsh-sts2

让 **dsh（DeepSeek Harness）** 直接接管《杀戮尖塔 2》：读取完整局面、出牌、选路、拿奖励、逛商店、处理事件，并能自己连续玩到本局结束。

本仓库是独立的 dsh 插件（npm 包 `dsh-sts2`）。游戏侧的桥接由 **AiTeammate** Mod 提供：

- Mod 仓库：[YuWan886/STS2-AiTeammate](https://github.com/YuWan886/STS2-AiTeammate)（[开发文档](https://github.com/YuWan886/STS2-AiTeammate/blob/main/docs/dsh-agent-bridge.md)）
- 插件通过 `127.0.0.1` 上的行 JSON TCP 协议与游戏通信，不经过公网。

## 功能

| 工具 | 作用 |
|---|---|
| `sts2_status` | 连接自检：返回 CONNECTED / NOT CONNECTED、端点、是否允许操作、当前局进度 |
| `sts2_state` | 当前阶段、角色、血量、金币、遗物、药水、手牌、敌人意图、可选项、状态 token |
| `sts2_wait` | 阻塞到游戏需要输入（或状态变化），是自动对局的主循环 |
| `sts2_read` | 按需深读牌堆、遗物、药水、角色、整局、地图、牌组统计、单卡 |
| `sts2_set_nickname` | 修改 AI 队友的显示昵称（名牌、聊天、提示词同步更新；传空字符串恢复人格名；只读模式也可用） |
| `sts2_screenshot` | 截取游戏画面（需游戏内开启截图 + 视觉模型） |
| `sts2_decide` | 回答 `phase=ai_decision` 里挂起的决策（`decision.prompt` / `decision.options` 给出要求的 JSON）。既包括 `controlled.kind=ai` 时 AI 玩家的决策，也包括 `kind=local` 时本地玩家的 `hand_select` 选牌 |
| `sts2_chat_send` | 在游戏聊天面板里发言；用 `reply_to` 回答玩家消息（`seq` 来自插件自动注入的 `<sts2_chat>` 块），`directives` 可记录战术指令，`nickname` 可改 AI 昵称 |
| `sts2_start_run` | 从干净的主菜单开一局游戏：`mode` 选 `standard`（普通局，可带角色 / 进阶 / 种子 / `modifiers`）、`custom`（自己的种子 / 进阶 / 角色 + `modifiers`）、`daily`（今日每日挑战：用游戏时间服务器取日期，种子 `dd_MM_yyyy_1p`，角色 / 进阶固定，游戏规则摇 2 好 1 坏 modifier；忽略 `character` / `ascension` / `seed` / `modifiers`） |
| `sts2_host` | 从干净的主菜单开一个多人大厅：`mode` = `standard` / `daily` / `custom`。daily / custom 大厅会自动加入 AI 队友并置为准备，标准大厅则在 `options` 里给出「加入 AI 队友」选项；开好后用 `sts2_choose` 选角 / 勾 modifier / 开始，`sts2_proceed` 退回 |
| `sts2_continue_run` | 读取存档继续 |
| `sts2_pause` | 打开暂停菜单（单人爬塔/AI 队友模式下同时挂起自动化） |
| `sts2_resume` | 关闭暂停菜单并恢复 |
| `sts2_save` | 立即保存当前存档（单人 / 主机；客户端会被拒绝） |
| `sts2_quit_to_menu` | 存档并返回主菜单 |
| `sts2_abandon` | 放弃当前局并返回主菜单（删除当前存档；仅单人 / 主机） |
| `sts2_play_card` | 按手牌索引或卡名出牌（可指定目标；`controlled.kind=local` 时可用） |
| `sts2_use_potion` | 使用药水（`AnyTime` 药水战斗外也能用） |
| `sts2_discard_potion` | 丢弃药水 |
| `sts2_end_turn` | 结束回合 |
| `sts2_choose` | 地图节点 / 奖励 / 卡牌奖励 / 单选 / 遗物 / 篝火 / 事件 / 商店 / 选包 / 水晶球 / 选目标（`phase=target_select`，如休息处 MEND；最后一个索引取消）/ 主菜单与子菜单按钮 / 选角按钮 / 「加入 AI 队友」 / 自定义 modifier 勾选 / 大厅的 Embark·返回 |
| `sts2_select_cards` | 卡牌选择界面（删牌、升级、变化、附魔、战斗内选牌） |
| `sts2_proceed` | 继续 / 离开 / 跳过 / 开宝箱 / 确认选包 / 关闭水晶球 / 结束界面 / 退出当前菜单或大厅（返回按钮或栈弹出） |
| `sts2_autoplay` | 开启/关闭自动接管：插件会在游戏等待输入时主动唤醒 agent（只在局内生效） |
| `sts2_handoff` | 把这一局交给一个新对话：本对话停手，插件新建对话并把接管提示词发进去 |

`sts2_autoplay` 是插件独有的能力：它通过 `ctx.agents` 在 agent 空闲时排队一条带当前状态的续玩消息，所以 dsh 不需要玩家每个回合手动说“继续”。

### 菜单 / 大厅

主菜单、子菜单和三种开局大厅现在都能直接操作，`sts2_state` 用 `phase` 区分：

| `phase` | 界面 | 说明 |
|---|---|---|
| `menu` | 主菜单或任意非大厅子菜单 | `menu.screen` = `main` / `solo` / `multiplayer` / `host` / `join_friend` / `other`；根菜单还带 `characters`、`can_continue`、`can_start_daily`、`can_start_custom`、`modes`、`modifiers`、`max_ascension`、`save` |
| `char_select` | 标准（普通对局）的角色选择大厅 | 带 `menu.lobby` |
| `daily_lobby` | 每日挑战大厅 | 带 `menu.lobby`，含 `daily_time` |
| `custom_lobby` | 自定义对局大厅 | 带 `menu.lobby` |

`menu.lobby` = `{mode, host, singleplayer, players[], local, ai_in_lobby, can_begin, ascension, seed, daily_time}`，`players[]` 里每人带 `name` / `character` / `character_id` / `ready` / `is_ai` / `is_local`。快照的 `options[]` 会列出当前界面所有可点条目（`kind` = `button` / `character` / `modifier` / `ai_join` / `ai_remove`），用 `sts2_choose {index}` 按下去，`sts2_proceed` 退回上一层。弹出模态框时快照不可操作（`blocked_by="modal"`），先按掉它。

三种模式都要在**干净的主菜单**（`phase=menu`、`menu.screen="main"`）上发起：

| 模式 | 怎么开 | 说明 |
|---|---|---|
| `standard` | `sts2_host` 开多人大厅，或 `sts2_start_run` 直接单人开局（可带 `modifiers`） | 原版角色选择界面；大厅不会自动加 AI 队友，`options` 里会出现「加入 AI 队友」选项 |
| `daily` | `sts2_host {"mode":"daily"}` 或 `sts2_start_run {"mode":"daily"}` | 每日挑战：日期取自**游戏的时间服务器**，种子 `dd_MM_yyyy_1p`，角色 / 进阶固定，modifier 由每日规则摇出 **2 好 1 坏**；`character` / `ascension` / `seed` / `modifiers` 全部忽略 |
| `custom` | `sts2_host {"mode":"custom"}` 或 `sts2_start_run {"mode":"custom", ...}` | 自己指定种子 / 进阶 / 角色，再用 `modifiers`（id 或名字，如 `["Draft","Flight"]`，见 `menu.modifiers`）挑规则；大厅里可以勾选 modifier |

`daily` / `custom` 大厅会自动加入 AI 队友并置为准备，所以只有一个主机也能开始；`standard` 大厅把这步留给玩家（或按「加入 AI 队友」选项）。

### 两种接管方式

游戏侧按「这一局由谁在玩」自动切换，快照里的 `controlled.kind` 会写清楚：

| `controlled.kind` | 场景 | dsh 怎么玩 |
|---|---|---|
| `local` | 普通单人局；多人局里没有 AI 队友时 | 用 `sts2_play_card` / `sts2_choose` / `sts2_proceed` 等 UI 动作直接打；需要从手牌选牌（例如升级）时不会弹原版 UI，而是挂一个 `kind=hand_select` 决策，用 `sts2_decide {"indices":[...]}` 回答 |
| `ai` | 「AI 独自爬塔」开启；多人局里有 AI 队友 | 内置 AI 的决策改由 dsh 给出：`phase=ai_decision` 时用 `sts2_decide` 回答，mod 负责执行 |

两种模式下 `sts2_wait` + `sts2_autoplay` 的循环完全一样；`sts2_state` 的 `notes` 会提示当前该用哪一类工具。

### 游戏内聊天

开着 dsh 玩的时候，游戏聊天面板里的玩家发言由 **dsh 回复**，而不是 mod 自带的后端：

- 插件在 `sts2_autoplay` 开启（或自动接管创建了新对话）后开始轮询 `sts2_chat_poll`，把玩家发言以 `<sts2_chat>` 消息注入当前对话；
- 模型需要调用 `sts2_chat_send` 才能让玩家看到回复（只在对话里打字玩家看不到）；
- 聊天里的战术要求会进入 dsh 的对话上下文，同时 mod 会把它附在后续决策提示词里，所以“先打左边”之类的话会实际影响出牌；
- 插件没在轮询（旧版插件 / 没绑定对话）时，mod 自动回到自带后端；dsh 超时或断开也会回退，聊天不会卡住。


## 前置条件

1. **dsh** ≥ `0.2.1-rc.5`（本插件按该版本的插件 API 编写，`engines.dsh` 限定为 `0.2.x`）。
2. **Slay the Spire 2** + **AiTeammate** Mod（启用外部 Agent 桥接）。
3. Node.js ≥ 22（dsh 自带即可）。

## 安装

### 桌面端（dsh desktop）

桌面端由 Electron 应用管理 `desktop` profile，命令行不能直接改它。在应用内 **设置 → 插件** 里安装本插件：

- 从 npm 安装：包名 `dsh-sts2`；
- 从本地目录安装：选 `dsh-sts2` 的仓库目录。

安装后重启应用。插件加载约 1.5 秒后会主动探测一次游戏桥接，所以只要游戏已开并启用了桥接，游戏侧设置页立刻就能看到“已连接 1 个 dsh 客户端”。若此时游戏没开，插件会在第一次调用 `sts2_*` 工具时再连接。

### 命令行（web / headless profile）

```sh
# 安装到 web profile
# dsh profile 的 pnpm-workspace 把 profile 自己作为 workspace 根，所以需要 -w
dsh plugin --profile web add -w dsh-sts2

# 如果使用别的 profile 名，替换 web
dsh plugin --profile <name> add -w dsh-sts2
```

重启 dsh。启动日志或 `dsh --profile web --dump-config` 中应能看到 `dsh-sts2` 这一层。

> 升级：`dsh plugin --profile web add -w dsh-sts2@latest`；卸载：`dsh plugin --profile web remove dsh-sts2`。

## 确认是否连上游戏

三种方式，任选：

1. **问 dsh**：在对话里说“sts2 连上了吗？”，它会调用 `sts2_status` 并给出结论与排查清单。
2. **看游戏里的设置页**：设置 → 模组设置 → AI 队友 → 外部 Agent（dsh）的状态行会显示 `运行中：127.0.0.1:26333 — 已连接 N 个 dsh 客户端`。没有客户端时显示“尚无 dsh 连接”。
3. **看游戏日志**：连接/断开时模组会写 `[Agent] client connected/disconnected`。

连接是**懒连接 + 启动探测**：插件加载后先主动连一次，失败则在首次调用 `sts2_*` 工具时再连。所以刚启动、游戏还没开时，游戏侧显示“尚无 dsh 连接”是正常的；打开游戏并启用桥接后，重启 dsh 或随便调用一次工具即可连上。

## dsh 设置页：端口与 token

插件带一个**浏览器半区**（`lib/client.js`），它把卡片注册进 dsh 插件页的 `plugins.row.config` 槽，键为 `dsh-sts2#sts2`：

- 位置：**侧边栏「插件」 → 已安装插件里的 `dsh-sts2` → `sts2` 行 → 配置**。
- 卡片显示当前端点（`host:port`），下面可直接改 **host / 端口 / token** 并保存。
- 表单来自插件自己导出的 `Config`：`host`、`port`、`token` 声明为 `volatile()`，因此可以**改完立即生效**，插件按新端点重连；`autoPlayPollMs`、`requestTimeoutMs` 不是 volatile，改动需要重启 dsh 才会应用。
- 写入落在 profile 的 `cordis.patch.yml`（用户层），`- id: sts2` 的 `config` 仍是基线层，不会被改掉。
- 连接状态不在卡片里：dsh 0.2.x 的设置命名空间只能由插件自己的 `Config` 派生，没有额外的状态通道，所以请看游戏内设置页（见上一节）。

> **升级或首次装上浏览器半区后必须重启 dsh**：客户端 bundle 只在应用启动时扫描并组合进 `window.__DSH_BOOT__`，不重启就看不到卡片。
>
> 卡片里“设置未就绪”的含义是 Host 还没提供 `sts2` 设置表单（`Config` 没有生效或插件没加载）。

## 游戏内设置

打开 **设置 → 模组设置 → AI 队友 → 外部 Agent（dsh）**：

1. 打开 **启用外部 Agent 桥接**。
2. 确认 **桥接端口** 与插件配置一致（默认 `26333`）。
3. 可选：填写 **访问 token**，并在插件配置里填相同的值。
4. 打开 **允许外部 Agent 操作游戏**（只想读状态的话可以关闭）。

然后按想要的玩法选一局：

- **自己玩**：开一局普通单人游戏（也可以让 dsh 用 `sts2_start_run` / `sts2_continue_run` 开局、续档），多人局里没有 AI 队友时 dsh 打你那份。
- **给 AI 当大脑**：开「AI 独自爬塔」，或开一局带 AI 队友的多人局（dsh 也能用 `sts2_host` 自己开大厅，`daily` / `custom` 大厅会自动带上 AI 队友）。dsh 一连上，内置 AI 的决策就交给 dsh（`sts2_decide`），mod 只保留执行与同步。

## 使用

在 dsh 里说：

> 你来玩这局《杀戮尖塔 2》。先调用 `sts2_autoplay` 打开自动接管，然后一直玩到本局结束。

之后 dsh 会自己循环：`sts2_wait` → 读状态 → 出牌/选择/回答决策 → 再等待；战斗、地图、奖励、商店、篝火、事件、宝箱全部由它处理。

### 不用再手动开口（自动接管）

开着 dsh 的前提下，多人局里一出现 AI 队友，插件会自己把这一局接过来：

1. 游戏侧在「有 AI 队友、且这段时间没人在驱动」时，通过 `sts2_takeover` 发出邀请（入局后约 30 秒才开始邀请，留给手动接管的窗口）；
2. 插件每 4 秒轮询一次，认领后**在 dsh 里新建一个普通对话**（cwd = 游戏内设置里的工作区），把首条提示词作为用户消息发进去；
3. 新对话就像你自己点「新建对话」一样：出现在侧边栏、能实时看、随时能接手打字。

因此不再需要先在 dsh 里开个对话说「来玩杀戮尖塔2」。mod 不负责启动 dsh：没有开着的 dsh，就没有人认领这个邀请。

**同一时刻只有一个对话在驱动这一局。** 插件里只有一个 `autoplay` 循环，谁最后调用 `sts2_autoplay` 谁就是司机：

- 循环还在正常打的时候，插件不会去认领邀请（游戏侧这时也会回 `already_driving`，认领只会白烧一次机会——每局最多 3 次、每次 60 秒）。
- 循环哑了（模型卡住 / 对话被关掉 / 已经打完这一局）时，邀请就变成**交接**：插件先新建对话，再停掉旧的循环，所以不会有两个对话同时操作游戏。
- 离开对局（回到主菜单、游戏结束、没有进行中的局）会立刻停掉循环。否则它会在主菜单里空转轮询，让游戏一直以为「有人在驱动」，下一局的邀请（以及「dsh 静默回退」）就都不会触发。
- `sts2_autoplay` 只在局内生效：在主菜单调用会直接返回「没有进行中的局」，让你先 `sts2_start_run` / `sts2_host` / `sts2_continue_run`。

想换一个干净的新对话继续玩，让 dsh 调用：

```json
// sts2_handoff
{}
```

它会让本对话停手，并让插件马上认领这一局、新建对话把接管提示词发进去；认领还没来得及（游戏要求约 15 秒安静）时会如实告诉你，后台继续重试。

想收回控制权：

- 让 dsh 调用 `sts2_autoplay { "enabled": false }`；或
- 关闭游戏内的外部 Agent 开关（AI 会立刻退回内置后端）。

## 配置

插件配置位于 dsh profile 的 `cordis.patch.yml`（安装 bundle 后自动插入）。可以在 profile 的 `cordis.patch.yml` 中覆盖整行 `config`：

```yaml
- id: sts2
  name: 'dsh-sts2'
  config:
    host: '127.0.0.1'
    port: 26333
    token: ''
    autoPlayPollMs: 700
    requestTimeoutMs: 60000
    autoTakeover: true
    takeoverPollMs: 4000
    takeoverCwd: ''
    chatPollMs: 1000
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 游戏桥接地址，只支持本机 |
| `port` | `26333` | 与游戏内设置一致 |
| `token` | `''` | 可选的请求 token |
| `autoPlayPollMs` | `700` | 自动接管的轮询间隔 |
| `requestTimeoutMs` | `60000` | 单次桥接请求超时 |
| `autoTakeover` | `true` | AI 队友入局时自动新建对话接管 |
| `takeoverPollMs` | `4000` | 邀请轮询间隔 |
| `takeoverCwd` | `''` | 覆盖新对话的工作区（留空则用游戏内设置的工作区） |
| `chatPollMs` | `1000` | 聊天中继的轮询间隔（插件只用它决定何时发起下一轮长轮询） |

修改配置后 dsh 会热重载插件（HMR）。

## 工作原理

```
dsh 进程
  dsh-sts2 插件
    ├─ ctx.tools.register(sts2_*)
    ├─ TCP 客户端 ── 127.0.0.1:<port> ──> AiTeammate Mod
    ├─ autoplay 定时器 → ctx.agents.followup()
    └─ chat 定时器 → sts2_chat_poll → ctx.agents.followup() → sts2_chat_send
```

协议（行分隔 JSON，UTF-8）：

```text
→ {"id":1,"token":"optional","call":"sts2_state","args":{}}
← {"id":1,"ok":true,"result":{"text":"{...snapshot json...}"}}
← {"id":1,"ok":false,"error":"No run is in progress."}
```

游戏侧的快照包含 `phase`、`actionable`、`token` 和按界面生成的 `options`；`sts2_wait` 在 `actionable && token != after_token` 时返回。


## 安全

- 只连接 `127.0.0.1`，游戏侧也只监听回环地址。
- 可选 token；不填时本机任意进程都可连接。
- 插件只能调用游戏动作，不能读写文件或执行系统命令。
- 自动接管期间 dsh 会持续消耗模型 token；随时可用 `sts2_autoplay` 关闭。

## License

MIT
