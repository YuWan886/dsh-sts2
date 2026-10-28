# dsh-sts2

让 **dsh（DeepSeek Harness）** 直接接管《杀戮尖塔 2》：读取完整局面、出牌、选路、拿奖励、逛商店、处理事件，并能自己连续玩到本局结束。

本仓库是独立的 dsh 插件（npm 包 `dsh-sts2`）。游戏側的桥接由 **AiTeammate** Mod 提供：

- Mod 仓库：`MiniMods/gameplay/AiTeammate`（开发文档见 `docs/dsh-agent-bridge.md`）
- 插件通过 `127.0.0.1` 上的行 JSON TCP 协议与游戏通信，不经过公网。

## 功能

| 工具 | 作用 |
|---|---|
| `sts2_state` | 当前阶段、角色、血量、金币、遗物、药水、手牌、敌人意图、可选项、状态 token |
| `sts2_wait` | 阻塞到游戏需要输入（或状态变化），是自动对局的主循环 |
| `sts2_read` | 按需深读牌堆、遗物、药水、角色、整局、地图、牌组统计、单卡 |
| `sts2_screenshot` | 截取游戏画面（需游戏内开启截图 + 视觉模型） |
| `sts2_play_card` | 按手牌索引或卡名出牌（可指定目标） |
| `sts2_use_potion` | 使用药水 |
| `sts2_end_turn` | 结束回合 |
| `sts2_choose` | 地图节点 / 奖励 / 卡牌奖励 / 单选 / 遗物 / 篝火 / 事件 / 商店 |
| `sts2_select_cards` | 卡牌选择界面（删牌、升级、变化、附魔、战斗内选牌） |
| `sts2_proceed` | 继续 / 离开 / 跳过 / 开宝箱 / 结束界面 |
| `sts2_autoplay` | 开启/关闭自动接管：插件会在游戏等待输入时主动唤醒 agent |

`sts2_autoplay` 是插件独有的能力：它通过 `ctx.agents` 在 agent 空闲时排队一条带当前状态的续玩消息，所以 dsh 不需要玩家每个回合手动说“继续”。

## 前置条件

1. **dsh** ≥ `0.1.5-rc.1`（本插件按该版本的插件 API 编写）。
2. **Slay the Spire 2** + **AiTeammate** Mod（启用外部 Agent 桥接）。
3. Node.js ≥ 22（dsh 自带即可）。

## 安装

```sh
# 安装到 web profile（默认的 dsh web / desktop 界面）
# dsh profile 的 pnpm-workspace 把 profile 自己作为 workspace 根，所以需要 -w
dsh plugin --profile web add -w dsh-sts2

# 如果使用别的 profile 名，替换 web
dsh plugin --profile <name> add -w dsh-sts2
```

重启 dsh。启动日志或 `dsh --profile web --dump-config` 中应能看到 `dsh-sts2` 这一层。

> 升级：`dsh plugin --profile web add -w dsh-sts2@latest`；卸载：`dsh plugin --profile web remove dsh-sts2`。

## 游戏内设置

打开 **设置 → 模组设置 → AI 队友 → 外部 Agent（dsh）**：

1. 打开 **启用外部 Agent 桥接**。
2. 确认 **桥接端口** 与插件配置一致（默认 `26333`）。
3. 可选：填写 **访问 token**，并在插件配置里填相同的值。
4. 打开 **允许外部 Agent 操作游戏**（只想读状态的话可以关闭）。
5. **不要同时开启「AI 独自爬塔」**：外部 Agent 与内置 AI 互斥。

开一局**单人模式**（外部 Agent 的动作目前只支持单人）。

## 使用

在 dsh 里说：

> 你来玩这局《杀戮尖塔 2》。先调用 `sts2_autoplay` 打开自动接管，然后一直玩到本局结束。

之后 dsh 会自己循环：`sts2_wait` → 读状态 → 出牌/选择 → 再等待；战斗、地图、奖励、商店、篝火、事件、宝箱全部由它处理。

想收回控制权：

- 让 dsh 调用 `sts2_autoplay { "enabled": false }`；或
- 关闭游戏内的外部 Agent 开关。

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

## 本地开发

```sh
# 把一个 checkout 直接链进 profile（推荐，peer 依赖由 dsh 安装解析）
dsh plugin --profile web add -w /absolute/path/to/dsh-sts2-plugin
dsh --profile web --dump-config   # 应出现 # == dsh-sts2 层

# 单元测试（协议客户端，无需 dsh 依赖）
npm test
```

> `--patch` overlay 也能加载本地 `index.js`，但要求模块解析能找到 `@deepseek-ai/dsh-*` peer；从独立 checkout 使用时更容易踩坑，优先用上面的 link 方式。

## 排障

| 现象 | 处理 |
|---|---|
| `Could not connect to the game bridge` | 游戏没开、桥接开关没开、端口不一致 |
| `Unauthorized` | 游戏内 token 与插件 `token` 不一致 |
| `Actions are singleplayer-only` | 当前是多人模式；v1 只支持单人 |
| `solo_climb` | 关闭「AI 独自爬塔」 |
| 工具列表里没有 `sts2_*` | 插件没装进当前 profile，或 dsh 没重启 |
| 卡在某个 Mod 自定义界面 | 该界面暂不支持，手动处理后继续 |

## 安全

- 只连接 `127.0.0.1`，游戏侧也只监听回环地址。
- 可选 token；不填时本机任意进程都可连接。
- 插件只能调用游戏动作，不能读写文件或执行系统命令。
- 自动接管期间 dsh 会持续消耗模型 token；随时可用 `sts2_autoplay` 关闭。

## License

MIT
