# dsh-link-bridge —— 收到 dsh-link 消息时自动唤醒对话

dsh-link 会把消息投进本机节点的收件箱，但 DSH 这一侧不会自己去看：以前必须有人打开一个对话、
复制消息、问一句"这说了什么"。这个 DSH 插件把这一环补上——它轮询本机 dsh-link 节点，
发现有未读消息就**自动（复用或创建）一个对话并给它发一条 prompt**，让远端那台机器拿到回复。

- 类型：DSH **Host 插件**（无需客户端/前端资源），零运行时依赖。
- 依赖服务：`ctx.sessionController`、`ctx.workspaceRegistry`（web profile 默认都装好）。
- 配套：消息的读/回用已经装好的 `mcp-dshlink` MCP 工具，本插件不重复造轮子。

## 它怎么工作

1. 每隔 `pollSeconds` 秒 GET 本机节点的 `/api/v1/info` 与
   `/api/v1/messages?box=inbox&unread=1&order=asc`；
2. 过滤出 `id > watermark` 且未读的消息（watermark 存在状态文件里，重启不丢）；
3. 到达冷却时间后，解析或创建目标对话：
   - 配了 `sessionId` → 用它（`sessionController.create` 是幂等的，冷会话会被重新接管）；
   - 没配 → 用状态文件里记住的上一次对话；再没有就按 `workspacePath` 新建一个；
4. 把消息渲染进 prompt 模板，用 `sessionController.prompt` 投进该对话
   （`requestId = link-bridge:<session>:<最新消息 id>`，重复投递不会产生第二条）；
5. 推进 watermark 并落盘；同一条消息不会被唤醒两次。

对话里的 agent 会按模板指示用 `mcp__dshlink__link_inbox` 读全文、`link_pull_file` 取文件、
`link_reply` 回复，最后 `markRead`。

## 安装

插件随 dsh-link 一起分发，位于 `integrations/dsh-link-bridge/`：

```powershell
# 1) 把包装进 profile（本地目录用 link:，改代码即时生效）
dsh plugin --profile web add "link:<dsh-link 路径>/integrations/dsh-link-bridge"

# 2) 0.5 起节点默认不信任回环：先加固，拿到 admin / bridge 两个 token（只打印一次）
node bin\dshlink.mjs harden --write

# 3) 写配置并激活（本项目的 CLI 会备份 profile patch，然后写入 insert 条目）
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write --token <admin-token> --bridge-token <bridge-token>

# 4) 重启一次 DSH host（新插件条目在启动时装载；之后改配置是热重载）
dsh web
```

也可以用 `install-bridge.ps1` 一步完成 1+2。

## 配置

配置写在 profile 的 `cordis.patch.yml`（`dsh.profile.patchReload: live` 时改完即生效）：

```yaml
- insert:
    - id: dsh-link-bridge
      name: dsh-link-bridge
      config:
        enabled: true
        nodeUrl: http://127.0.0.1:8787      # 本机 dsh-link 节点
        workspacePath: "D:\\dshlink-bridge"  # 必填：专用空目录（不存在会自动创建）
        sessionId: ""                        # 可选：指定已有对话；留空=自动创建并记住
        promptMode: auto                     # 0.4：auto | queue | steer（direct/route 用 steer 插话，topic 用 queue 排队）
        pollSeconds: 15                      # 轮询间隔（下限 2 秒）
        cooldownSeconds: 30                  # 两批消息之间的最小间隔，防止连环唤醒
        batchLimit: 20                       # 一次最多带多少条消息进 prompt
        maxBodyChars: 1200                   # 每条消息正文截断长度
        agentPreset: ""                      # 可选：新建对话时使用的 agent preset
        token: ""                            # 0.5：hardened 节点必填 role=bridge 的 token（install-dsh --bridge-token 会自动写入）
        stateDir: ""                         # 可选：状态文件目录
        prompt: ""                           # 可选：自定义 prompt 模板（留空用内置）
        # ---- 0.3：话题路由与自动归档 ----
        topics:
          strategy: auto                     # auto | thread | subject（话题键怎么算）
          maxSessionWakes: 12                # 一个会话最多被唤醒多少次（按消息条数累计）
          maxSessionAgeSeconds: 43200        # 会话最长存活 12h
          topicIdleResetSeconds: 21600       # 话题闲置 6h → 换新会话
          archiveIdleSeconds: 86400          # 闲置 24h 的会话自动归档
          maxPoolSize: 20                    # 同时记住多少话题
        archiveSessions: true                # 退休会话交给 DSH 原生归档（侧边栏收起、日志保留）
        sessionTitlePrefix: "[dsh-link] "    # 桥开的对话统一加前缀，便于识别
        # ---- 0.3：回信路由（谁问的、回给谁）----
        routes:
          enabled: true                      # 关掉 = 回到纯话题池行为
          ttlSeconds: 86400                  # 路由记忆 24h
          max: 200                           # 最多记住多少条 thread → 会话
        # ---- 0.4：定向会话（对端指定把消息投进哪条本机会话）----
        targets:
          enabled: true                      # 关掉 = 忽略 targetSession（回到 0.3 行为）
          peers: []                          # 对端名 glob；空 = 任何已配置 peer
          allow: []                          # 允许被定向的本机会话 id glob；空 = 任意
          deny: []                           # 拒绝清单，永远优先于 allow
        # ---- 0.3：能力通道（对端可通过本机节点调用本机 DSH）----
        commandSeconds: 5                    # 轮询本机节点的命令队列；0 = 关闭
        commandBatch: 5                      # 每轮最多认领几条命令
```

内置模板占位符：`{{node}}`（本机节点名）、`{{count}}`、`{{peers}}`、`{{lastId}}`、`{{messages}}`；
0.4 起还有 `{{targetNote}}`（定向失败/回退原因，正常为空）、`{{delivery}}`（`direct` | `route` | `binding` | `topic`）、
`{{targetSession}}`、`{{originSession}}`。旧的自定义模板不受影响。

状态文件新增 `directed` / `lastDirected` / `targets` / `promptMode`：`lastDirected.matched = "target"` 表示上一条定向消息
真正投进了目标会话。

0.4 起 direct/route 投递默认用 DSH 的 `mode: "steer"` 唤醒——插到目标会话的下一个 step 边界，像人插话，
不用排在长工具循环后面；topic 批量仍用 `mode: "queue"`（追加一个回合）。`promptMode: queue` 让所有唤醒都排队，
`steer` 让所有唤醒都插话；默认 `auto` 按投递类型选择。

## 鉴权与安全边界（0.5）

0.5 起节点默认 `auth.trustLocalhost: false`：**每个请求都要 token**，桥访问的
`/api/v1/bridge/*` 控制面也不例外。桥配置里的 `token` 决定桥以什么身份访问节点：

| token 角色 | 用途 | 能否调 bridge 控制面 |
|---|---|---|
| `bridge` | 桥专用：读写消息/文件、认领并回填 bridge 命令 | ✅ 推荐 |
| `admin` | 人 / CLI / MCP 专用，可管理 token、peers、审计 | 仅本机回环；远端 admin 会 403 `bridge_forbidden` |
| `peer` | 对端节点：只能收发自己的流量 | ❌ `bridge_forbidden` |
| `device` | 手机等只读终端 | ❌ `bridge_forbidden` |

- `dshlink harden --write` 关掉 `trustLocalhost` 并铸 `mcp-admin`（admin）与 `bridge`（bridge）两个 token；
- 安装时用 `install-dsh ... --token <admin-token> --bridge-token <bridge-token>`，MCP 的
  `headers.authorization` 与桥的 `token` 会一起写进 patch；
- 多机互连时**每台对端各用一个 `role: peer` 且绑定对端名的 token**
  （`dshlink token new --role peer --peer LAPTOP-X`）：消息 `from` 会被强制为该 peer，
  收件箱/发件箱也只返回它自己的流量；
- 桥的 token 泄漏等于对方能读写本机消息、投递定向消息、认领 bridge 命令——按凭据管理：独立、可轮换、
  不要和 MCP 共用；节点侧的完整边界见 [`SECURITY.md`](../../SECURITY.md)；
- 升级到 0.5 后桥报 `403 bridge_forbidden`：说明配置里没有 role=bridge 的 token。
  `dshlink token new --role bridge` 后填进 `token`（或重跑 install-dsh `--bridge-token`）；
  改的是配置，patchReload 为 live 时热重载即可，不必重启。

## 一个话题一个会话 + 自动归档（0.3）

0.2.x 永远复用同一个对话，不同话题的上下文堆在同一条会话里越跑越长。0.3 改成**按话题分配会话**：

| 判据 | 行为 |
|---|---|
| 话题键 | 有 `thread` → `thread:<id>`；否则 `topic:<对端>/<去掉 Re:/答复:/Fwd: 前缀的主题>`；都没有 → `msg:<id>` |
| 同话题、未超预算 | 复用原会话 |
| 话题闲置 > `topicIdleResetSeconds` | 建新会话，旧会话归档 |
| 会话唤醒数 ≥ `maxSessionWakes` | 建新会话，旧会话归档 |
| 会话存活 > `maxSessionAgeSeconds` | 建新会话，旧会话归档 |
| 话题闲置 > `archiveIdleSeconds`（每轮 tick 清扫） | 直接归档 |
| 话题数 > `maxPoolSize` | 最久未用的先归档再遗忘 |

「归档」= `workspaceRegistry.archiveSession()`，就是 DSH 界面上的**归档对话**：从侧边栏收起、记录与日志
都保留，随时可以取消归档。桥开的对话标题统一带 `sessionTitlePrefix`，一眼能和人工对话区分开。

新会话的创建**按需发生**：只有出现新话题、或旧会话超龄/超预算时才建，不会每个 tick 建一个。

## 回信回到发起会话（0.3）

话题池解决的是"对端发起的消息落在哪"。反过来还有一个场景：**你在别的工作区的会话里问对端一件事，
对端的回复会被桥拉到 `workspacePath` 里去，提问的那个会话反而收不到。**

桥会记住"哪个会话在哪个 thread 上发过消息"（`routes`），回信按 thread 命中后直接投回那个会话：

| 判据 | 行为 |
|---|---|
| 何时登记 | 在任意工作区用 `link_send_message` / `link_reply` 发消息时，DSH 把这次工具调用（含发起会话）交给桥，桥记下 `thread → 会话`。**不必传自己的会话 id，也不需要 agent 配合** |
| 何时命中 | 对端回复落在同一 thread，或 `replyTo` 命中你那条消息 |
| 命中之后 | 直接 `sessionController.prompt` 那个会话，**不建**桥会话、不动话题池 |
| 命中不到 | 先查节点侧 thread 绑定（0.6.1，见下），仍没有才回落到话题池 |
| 发起会话已消失 | 桥忘掉该路由（prompt 失败即视为死会话），下一条消息回落到绑定/话题池 |
| 桥/Host 重启后 | route 表从 `state.json` 的 `routeTable` 恢复（0.6.1；摘要字段 `routes` 不参与恢复） |
| 有效期 | `routes.ttlSeconds`（默认 24h）；超过 `routes.max` 时按最久未用淘汰 |
| 关掉 | `routes.enabled: false` |

登记依赖 DSH Host 的 `tools/result` 事件（拿到发起 agent 的 Session）。经 CLI（`dshlink send`）发出的
消息不经过任何会话，登记不了路由——那类发送请在 `workspacePath` 收信。唤醒上限、冷却与防打环判据对
路由唤醒同样生效。

## 定向会话：对端指定投进哪条本机会话（0.4）

0.3 的回信路由是**被动**的：只有"本机某会话先在某个 thread 上发过消息"，桥才知道回信该给谁。
如果对端想主动把消息投进你机器上的**指定会话**（比如两个人各自在自己常用的对话里连续多轮协作），
0.3 做不到——消息只会落进桥话题池。

0.4 让信封可以直接携带 `targetSession`（收件方会话 id）与 `originSession`（发件方会话 id）：

| 判据 | 行为 |
|---|---|
| 收到带 `targetSession` 的消息 | `targets` 策略放行且会话未死 → 直接 prompt 该会话，**不新建**桥会话 |
| 之后 | 把 thread → 目标会话写进节点绑定（`bindings.json`），并登记本地 route；后续回复自动找到它 |
| 投递优先级 | 显式 target > thread/replyTo route > 节点 thread 绑定（0.6.1）> 话题池 |
| 投递方式 | direct/route 默认 `steer`（插话，插到下一步边界）；topic 批量 `queue`（排队）；`promptMode` 可覆盖 |
| 被 `targets` 拒绝 | 回落到 route/话题池，prompt 里写明原因（`{{targetNote}}`） |
| 目标会话不存在/已归档 | prompt 失败 → 标记死会话、清 route、水位不推进；下一轮回落 route/话题池，不丢消息 |
| 对端没带 target | 完全按 route/绑定/话题池逻辑处理 |
| 发消息时自动补 `originSession` | 本机会话在该 thread 上有绑定时自动填；`link_reply` 默认 `targetSession = 原消息的 originSession` |

配置与策略（patch 里可直接热更新）：

```yaml
targets:
  enabled: true
  peers: ["LAPTOP-*"]        # 只允许这些对端定向投递（glob；空=任意已配置 peer）
  allow: ["session-5f0c*"]   # 只允许这些本机会话（glob；空=任意）
  deny: []                   # 永远优先于 allow
```

启动日志会打印一行 `directed sessions: on (…)`；`state.json` 的 `directed` 是累计定向投递次数，
`lastDirected = { thread, sessionId, originSession, id, at, direction:"in", matched:"target" }`。
**默认 open**（与"任何已配置 peer 都能唤醒会话"的既有姿态一致）；对不完全信任的 peer，用
`peers` / `allow` 收紧。**开关关闭（`enabled: false`）时绑定/路由仍然登记**，只是不再按 target 投递，
随时可以打开而不丢已有会话记忆。

### 路由跨重启不丢（0.6.1）

route 表只在 bridge 进程内存里，0.6.0 及以前每次重启都会丢；下一条回信找不到发起会话，就会按话题池
新开一个桥会话（升级线程里出现过的 `session-5a0f4db8…` 就是这个原因）。0.6.1 两层修复：

1. 心跳文件里本来就把原始表写成 `routeTable`、摘要写成 `routes`，但启动时错误地把 `routes` 赋给了运行时表，
   于是所有 route 被 `sweepRoutes` 当畸形清掉。现在优先恢复 `routeTable`，并兼容旧版把原始表直接写在
   `routes` 下的形态。
2. 内存里仍没有 route 时，按 thread 向节点查绑定（`GET /api/v1/bridge/bind?thread=…`，数据在
   `bindings.json`，节点与 Host 重启都还在）：命中且会话未死 → prompt 它、重建 route、标记
   `lastRoute.matched = "binding"`，prompt 里 `{{delivery}} = binding` 并附带说明。

话题池线程**不走**第 2 层兜底：话题的轮换/闲置归档策略必须继续决定它由哪个会话处理，否则已退役的
旧会话会被绑定复活。定向消息、回信线程等交互线程才享受 binding 兜底。

协议与端到端流程见 [`docs/DIRECTED-SESSIONS.md`](../../docs/DIRECTED-SESSIONS.md)。

## 能力通道：让对端读/驱动本机 DSH（0.3）

对端调用本机节点的 `POST /api/v1/dsh/call` 时，节点把请求写进命令队列，bridge 每 `commandSeconds` 轮询
一次、用 DSH Host 服务执行，再把结果回填给节点。可执行的方法：

| 方法 | 类型 | 说明 |
|---|---|---|
| `workspaces.list` | 读 | 全部工作区（含归档标记） |
| `sessions.list` | 读 | 会话摘要（可按工作区/标题过滤） |
| `sessions.read` | 读 | 会话消息（inspect 投影，长文本裁剪） |
| `sessions.create` | 动作 | 新建会话（可指定工作区/预设/标题） |
| `sessions.prompt` | 动作 | 向指定会话投 prompt（等于让对方驱动你机器上的 agent） |
| `sessions.rename` | 动作 | 改会话标题 |
| `sessions.archive` | 动作 | 归档会话 |
| `bridge.status` | 读 | bridge 版本、能力、会话数 |

`sessions.prompt` 还可带 `mode: "queue" | "steer"`（默认 `queue`；`steer` = 插话，把内容送进目标会话的下一个
step 边界）。这个参数由 `link_call` 原样透传，未提供时保持 0.3 的排队行为。

- 鉴权在**节点侧**：`capabilities.enabled` + `capabilities.methods`（可按 peer 覆盖）。bridge 只服务
  本机 loopback 的节点，自己不判定远端身份；
- **动作方法默认不放行**，必须显式加进节点配置（见 `docs/DSH-ACCESS.md`）；
- 心跳写在节点数据目录的 `commands/bridge.json`（版本、能力、会话数、时间），`dshlink dsh bridge` 可查。

## 状态与自检

状态文件：`$DSH_HOME/plugin-data/dsh-link-bridge/state.json`（`DSH_HOME` 未设置时是 `~/.dsh`）。

```jsonc
{
  "sessionId": "session-…",   // 最近一次唤醒用的对话
  "watermark": "msg_…",       // 已唤醒到哪条消息
  "lastTickAt": 1767…,        // 心跳：文件 mtime 一直在动就说明插件活着
  "ticks": 42, "notified": 3, "errors": 0, "lastError": null,
  "pool": {                   // 0.3：每个话题当前用哪个会话
    "thread:msg_01m2…": { "sessionId": "session-…", "wakes": 3, "createdAt": 1767…, "lastUsedAt": 1767…, "archived": false, "label": "LAPTOP: 构建失败" }
  },
  "sessionsCreated": 4, "sessionsArchived": 2,
  "lastArchive": { "sessionId": "session-…", "reason": "wake-budget", "ok": true, "at": "…" },
  "commands": { "ticks": 12, "executed": 1, "failed": 0, "lastError": null },   // 0.3 能力通道
  "directed": 2,                // 0.4：累计定向投递次数
  "lastDirected": { "thread": "msg_…", "sessionId": "session-…", "originSession": "session-…",
                    "matched": "target", "direction": "in", "at": "…" },
  "targets": { "enabled": true, "peers": [], "allow": [], "deny": [], "open": true }  // 0.4 策略快照
}
```

- 文件不出现 / mtime 不动 → 插件没被装载：确认 profile patch 里有这条 insert，然后**重启 host**。
- `errors` 在涨、`lastError` 有值 → 看 host 控制台的 `dsh-link-bridge` 日志（前三次失败按 warn 打印）。
- 想验证整条链路：

  ```powershell
  node integrations\dsh-link-bridge\selfcheck.mjs --wait 90
  # PASS  → bridge 用某个对话处理了自检消息；TIMEOUT → 插件没被装载（先确认重启过 host）
  # 自检消息固定用 thread=selfcheck-bridge，所以所有自检共用同一个话题会话（0.3 起）
  ```

- `state.json` 在 0.3 里多了 `pool` / `sessionsCreated` / `sessionsArchived` / `lastArchive` / `commands` 字段；
  只有 `pool` 出现才说明跑的是 0.3（0.2.x 没有话题池）。
- 0.4 起还有 `promptMode` / `directed` / `lastDirected` / `targets`；0.6.1 起 `routeTable` 是运行时 route 表的
  真实快照（`routes` 只是给人看的摘要），重启恢复只看 `routeTable`。binding 兜底命中时
  `lastRoute.matched = "binding"`。

## 定位：协作与同步，不是"无人值守代理"

这个桥的用途是**多人协作与多终端插件同步**：把"另一台机器/另一个人发来的消息"送进我们本来就在用的
那个共享对话，让对话继续往下走——而不是让机器背着你自作主张。

- 唤醒的是**普通共享对话**：人随时可以进去看、接手、插话，消息与结论都留在同一条会话记录里；
- 桥只负责"把消息送进对话"，不做决策、不代替人批准任何事；权限预设仍按你平时给这个工作区的那套走；
- 多终端场景下各端 DSH 通过 dsh-link 互发消息，桥让"收到消息"这件事不再需要人工转述。

## 边界与注意

- **新插件条目需要重启一次 host**；`patchReload: live` 只对已存在的条目热更新配置。升级到 0.3
  同样要重启（ESM 缓存，热重载不会重新 import 改过的源码）。
- 一个 bridge 实例对应一个工作区，按话题在其中创建/复用多个对话；要多工作区并行就装多个实例（不同 `id`）。
- 归档只影响 DSH 侧边栏的可见性，不删除任何日志；`archiveSessions: false` 可以整个关掉自动归档。
- 冷却期内的消息会等到下一轮（watermark 不推进，不会丢）。
- 插件不会替你标记已读：模板里让 agent 自己 `markRead`；如果它没做，下一轮仍会看到这批消息，
  但 `id > watermark` 的过滤让它们不会重复唤醒。

## 防打环（loop guard）

两台机器都装了桥时会出现"自动对自动"的往返：我这边唤醒 → 我的会话 `link_reply` → 对面桥唤醒 → 对面的会话回复 →
我这边又唤醒……每条回复都是**新消息**，所以水位线永远追不上，单靠去重挡不住。桥内置三道闸：

| 配置 | 默认 | 作用 |
|---|---|---|
| `threadCooldownSeconds` | 120 | 同一 thread 唤醒后静默期内不再唤醒（**软**：watermark 不动，冷却过后会补上，不丢消息） |
| `maxThreadWakes` / `threadWindowSeconds` | 5 / 3600 | 同一 thread 在窗口内的唤醒次数上限，超出后**硬**丢弃该 thread 的唤醒并计数 |
| `maxWakesPerHour` | 20 | 全局每小时唤醒上限（防任何形式的暴走） |

被挡下的事件记在 `state.json` 的 `suppressed` / `lastSuppressed`（含 `reason`、`thread`、`dropped`）：
`dropped: false` 是冷却（稍后重试），`dropped: true` 是打环保护（已推进水位线、不再重试）。
计数随状态文件持久化，重启不会清零。

另外内置 prompt 会给模型一句提示：如果这条消息是对你上一轮**自动回复**的回复（两端都自动），只在本机记录、不要再回过去。
这属软约束，硬保障靠上面的三道闸。

**临时停桥**：把 profile patch 里的 `enabled` 改成 `false` 即可（`patchReload: live` 会立刻卸载，不用重启）。

## 常见问题

**它会拉起终端窗口吗？关掉窗口会不会停掉功能？**

不会拉起任何窗口：它是 host 进程里的一个插件，只发 HTTP 请求，不起子进程、不开控制台。
但它**依附于 DSH host 进程**——host 一停，桥就停；host 怎么起的由启动器决定。
如果你用托盘程序启动 host（`dsh web --port 3080 --no-open`，日志在该程序自己的 logs 目录）：
托盘退出（桌面快捷方式带 `--allow-kill`，会一并结束后端）等于 DSH 整体下线，桥、MCP 工具、正在跑的对话都会停。
想让它长期在线，就让后端以服务/计划任务方式常驻，而不是挂在某个窗口上。

**它依赖什么？**

① 本机 dsh-link 节点在跑（否则 `state.json` 里是 `lastError: "ECONNREFUSED"`）；
② 消息能从对端到达这个节点（直连或隧道）。节点目前由计划任务 `dshlink-node` 承载；
希望重启电脑后自动恢复的话，再加一个登录触发的计划任务（本机已注册 `dshlink-node-autostart`）。

**为什么改了插件要重启 host？**

新插件条目在 boot 时装载；即使 profile 是 `patchReload: live`，改**已装载模块的源文件**也不会重新 import
（Node 的 ESM 模块按 URL 缓存，加载器不会自动 bust）。所以改完桥的代码要重启一次 host；
改 `cordis.patch.yml` 里的**配置**才会热生效。

**它会不会把 DSH 拖崩？**

不会。早期版本用了 `ctx.interval` 却没有在 `inject` 里声明 timer 服务：新的 cordis 在读取未声明的服务时直接抛错，
会让 host 启动失败（浏览器报"连接被拒绝"）。现在它**完全不碰 timer 服务**（改用自带的 unref 定时器 + `ctx.effect` 收尾），
并且 `apply()` 整体包在 try/catch 里：安装期异常只会在控制台留下一行 `disabled after a setup error`，桥保持静默，host 照常启动。

## 已验证

`test/bridge.test.mjs`（随 dsh-link 测试套件运行，`node test/run.mjs`）覆盖：

1. 消息到达 → 用假 Host 上下文断言 `create`/`prompt` 的调用参数、prompt 内容与 requestId；
2. 同一条消息不会二次唤醒（watermark）；
3. 指定 `sessionId` 时复用该对话；
4. 未配置 `workspacePath` 或 `enabled: false` 时保持静默；
5. **严格服务守卫**：假 context 用 Proxy 模拟新 cordis——读取未在 `inject` 声明的服务即抛错，
   桥仍能正常启动并唤醒对话（回归这次的启动崩溃）；
6. **安装期异常不致命**：`ctx.effect` 抛错、`ctx.logger` 取值抛错时 `apply()` 不向外抛，host 照常启动；
6b. **prompt 必须带 signal**：假 context 的 `prompt(request, signal)` 在缺 signal 时抛错，
   复刻 `ctx.sessionController.prompt` 包装层（它无条件调用 `signal.throwIfAborted()`）；
7. `install-dsh --bridge` 生成的 patch 条目幂等（重复规划内容不变）；
8. **0.4 定向会话**：定向消息唤醒指定会话且不新建桥会话、thread 绑定写入节点、`state.directed` 记账；
9. **策略拒绝回退**：`targets.allow` 不匹配时回落话题池，prompt 带拒绝原因且 `directed` 不增加；
10. **一批多目标**：一次 tick 按顺序唤醒两个不同会话；
11. **显式 target 优先于已有 route**：同 thread 上已有本机会话路由时，带 `targetSession` 的消息仍投目标会话；
12. **绑定自动补 originSession**、`link_reply` 定向回原会话（`test/directed.test.mjs`、`test/mcp.test.mjs`）；
13. **插话/排队模式**：`promptMode: auto` 下 direct/route 用 `steer`、topic 用 `queue`；`queue`/`steer` 强制覆盖；
14. **能力通道 mode**：`sessions.prompt` 的 `mode` 透传、默认 queue、非法值拒绝（`test/bridge-commands.test.mjs`）；
15. **0.6.1 重启恢复**：预写 `routes` 摘要 + `routeTable` 原始表，重启后回信仍投原会话（不新开桥会话）；
16. **0.6.1 binding 兜底**：thread 没有 route 时按节点绑定投回本机会话，`routed` 记账、`lastRoute.matched = binding`。
