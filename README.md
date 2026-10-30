# dsh-sts2

让 **dsh（DeepSeek Harness）** 直接接管《杀戮尖塔 2》：读取完整局面、出牌、选路、拿奖励、逛商店、处理事件，并能自己连续玩到本局结束。

本仓库是独立的 dsh 插件（npm 包 `dsh-sts2`）。游戏侧的桥接由 **AiTeammate** Mod 提供：

- Mod 仓库：[YuWan886/AiTeammate](https://github.com/YuWan886/AiTeammate)（[开发文档](https://github.com/YuWan886/AiTeammate/blob/main/docs/dsh-agent-bridge.md)）
- 插件通过 `127.0.0.1` 上的行 JSON TCP 协议与游戏通信，不经过公网。

## 功能

| 工具 | 作用 |
|---|---|
| `sts2_status` | 连接自检：返回 CONNECTED / NOT CONNECTED、端点、是否允许操作、当前局进度 |
| `sts2_state` | 当前阶段、角色、血量、金币、遗物、药水、手牌、敌人意图、可选项、状态 token |
| `sts2_wait` | 阻塞到游戏需要输入（或状态变化），是自动对局的主循环 |
| `sts2_read` | 按需深读牌堆、遗物、药水、角色、整局、地图、牌组统计、单卡 |
| `sts2_screenshot` | 截取游戏画面（需游戏内开启截图 + 视觉模型） |
| `sts2_decide` | 回答 `phase=ai_decision` 里挂起的决策（`decision.prompt` / `decision.options` 给出要求的 JSON）。既包括 `controlled.kind=ai` 时 AI 玩家的决策，也包括 `kind=local` 时本地玩家的 `hand_select` 选牌 |
| `sts2_start_run` | 从主菜单开一局新的单人游戏（角色 / 进阶 / 种子） |
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
| `sts2_choose` | 地图节点 / 奖励 / 卡牌奖励 / 单选 / 遗物 / 篝火 / 事件 / 商店 / 选包 / 水晶球 |
| `sts2_select_cards` | 卡牌选择界面（删牌、升级、变化、附魔、战斗内选牌） |
| `sts2_proceed` | 继续 / 离开 / 跳过 / 开宝箱 / 确认选包 / 关闭水晶球 / 结束界面 |
| `sts2_autoplay` | 开启/关闭自动接管：插件会在游戏等待输入时主动唤醒 agent |

`sts2_autoplay` 是插件独有的能力：它通过 `ctx.agents` 在 agent 空闲时排队一条带当前状态的续玩消息，所以 dsh 不需要玩家每个回合手动说“继续”。

### 两种接管方式

游戏侧按「这一局由谁在玩」自动切换，快照里的 `controlled.kind` 会写清楚：

| `controlled.kind` | 场景 | dsh 怎么玩 |
|---|---|---|
| `local` | 普通单人局；多人局里没有 AI 队友时 | 用 `sts2_play_card` / `sts2_choose` / `sts2_proceed` 等 UI 动作直接打；需要从手牌选牌（例如升级）时不会弹原版 UI，而是挂一个 `kind=hand_select` 决策，用 `sts2_decide {"indices":[...]}` 回答 |
| `ai` | 「AI 独自爬塔」开启；多人局里有 AI 队友 | 内置 AI 的决策改由 dsh 给出：`phase=ai_decision` 时用 `sts2_decide` 回答，mod 负责执行 |

两种模式下 `sts2_wait` + `sts2_autoplay` 的循环完全一样；`sts2_state` 的 `notes` 会提示当前该用哪一类工具。


## 前置条件

1. **dsh** ≥ `0.1.5-rc.1`（本插件按该版本的插件 API 编写）。
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
- **给 AI 当大脑**：开「AI 独自爬塔」，或开一局带 AI 队友的多人局。dsh 一连上，内置 AI 的决策就交给 dsh（`sts2_decide`），mod 只保留执行与同步。

## 使用

在 dsh 里说：

> 你来玩这局《杀戮尖塔 2》。先调用 `sts2_autoplay` 打开自动接管，然后一直玩到本局结束。

之后 dsh 会自己循环：`sts2_wait` → 读状态 → 出牌/选择/回答决策 → 再等待；战斗、地图、奖励、商店、篝火、事件、宝箱全部由它处理。

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
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 游戏桥接地址，只支持本机 |
| `port` | `26333` | 与游戏内设置一致 |
| `token` | `''` | 可选的请求 token |
| `autoPlayPollMs` | `700` | 自动接管的轮询间隔 |
| `requestTimeoutMs` | `60000` | 单次桥接请求超时 |

修改配置后 dsh 会热重载插件（HMR）。

## 工作原理

```
dsh 进程
  dsh-sts2 插件
    ├─ ctx.tools.register(sts2_*)
    ├─ TCP 客户端 ── 127.0.0.1:<port> ──> AiTeammate Mod
    └─ autoplay 定时器 → ctx.agents.followup()
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
