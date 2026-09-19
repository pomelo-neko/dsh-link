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

# 2) 写配置并激活（本项目的 CLI 会备份 profile patch，然后写入 insert 条目）
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write

# 3) 重启一次 DSH host（新插件条目在启动时装载；之后改配置是热重载）
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
        pollSeconds: 15                      # 轮询间隔（下限 2 秒）
        cooldownSeconds: 30                  # 两批消息之间的最小间隔，防止连环唤醒
        batchLimit: 20                       # 一次最多带多少条消息进 prompt
        maxBodyChars: 1200                   # 每条消息正文截断长度
        agentPreset: ""                      # 可选：新建对话时使用的 agent preset
        token: ""                            # 可选：节点需要鉴权时填 peers token
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
        # ---- 0.3：能力通道（对端可通过本机节点调用本机 DSH）----
        commandSeconds: 5                    # 轮询本机节点的命令队列；0 = 关闭
        commandBatch: 5                      # 每轮最多认领几条命令
```

内置模板占位符：`{{node}}`（本机节点名）、`{{count}}`、`{{peers}}`、`{{lastId}}`、`{{messages}}`。

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
  "commands": { "ticks": 12, "executed": 1, "failed": 0, "lastError": null }   // 0.3 能力通道
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
7. `install-dsh --bridge` 生成的 patch 条目幂等（重复规划内容不变）。
