# 排障手册 / troubleshooting

这份手册来自真实的跨机部署（Windows 桌面节点 ↔ Windows 笔记本节点，经阿里云 frps 的 STCP 隧道），
每条都是实际踩到并修掉的。先跑这两条，80% 的问题当场就有答案：

```powershell
dshlink doctor --json                 # 本机自检：配置/根目录/端口/MCP/对端/隧道/进程一致性
dshlink status --json                 # 磁盘上的配置（CLI 每次重新读文件）
curl http://127.0.0.1:8787/api/v1/status   # 正在运行的进程实际持有的配置（含 runtime 块）
```

**一条黄金判据**：`status` 与 `/api/v1/status` 的 peers / 版本不一致，就是"进程里的配置过期"，不是配置写错。

<!-- toc -->

1. [unknown peer: <名字>](#1-unknown-peer-名字)
2. [收消息正常、发消息失败](#2-收消息正常发消息失败)
3. [标记已读 / 放弃队列之后状态又回来了](#3-标记已读--放弃队列之后状态又回来了)
4. [doctor 一直报队列 pending](#4-doctor-一直报队列-pending)
5. [peer 明明是通的，doctor 却说 tunnel not configured](#5-peer-明明是通的doctor-却说-tunnel-not-configured)
6. [重启机器后通道没了](#6-重启机器后通道没了)
7. [对端改了名字，peer 记录对不上](#7-对端改了名字peer-记录对不上)
8. [对端 DSH 收不到"有新消息"的提醒](#8-对端-dsh-收不到有新消息的提醒)
9. [frpc / frps 启动即退出：exit -1、无任何输出](#9-frpc--frps-启动即退出exit--1无任何输出)
10. [消息明明到了，桥却一动不动](#10-消息明明到了桥dsh-link-bridge却一动不动)
11. [同一个会话被反复唤醒 / 两边互相刷 "Re: Re: Re: …"](#11-同一个会话被反复唤醒--两边互相刷-re-re-re-)
12. [看不到对方的工作区 / 对话（dsh_disabled 等）](#12-看不到对方的工作区--对话dsh_disabled-等)
13. [能力调用一直 pending（bridge 没接活）](#13-能力调用一直-pendingbridge-没接活)
14. [zstd-unsupported / transcript 读不出来](#14-zstd-unsupported--transcript-读不出来)
15. [对话没有自动归档，或者侧边栏多了一堆 [dsh-link] 对话](#15-对话没有自动归档或者侧边栏多了一堆-dsh-link-对话)

## 1. `unknown peer: <名字>`

*症状*：`dshlink peers ping <name>` 成功，但 `dshlink send --to <name>` 或 MCP 工具 `link_send_message`
返回 `queued (unknown peer: <name>)`。

*原因*（0.2.0 及更早）：`serve` 只在启动时读一次 `dshlink.config.json`，之后 CLI 写进去的 peer
（`peers accept` / `peers add`）对运行中的进程不可见。CLI 每次重新读盘，所以 ping 通、send 不通。

*处理*：升到 0.2.1（`serve` 每次请求前热重载配置），或重启一次节点进程。
验证：`/api/v1/status` 的 `runtime.configReloads` 会随配置改动 +1；`doctor` 的 `node:config` 会 pass。

## 2. 收消息正常、发消息失败

同一根因的另一面，也解释了"配置明明没错"的感觉：入站只校验 token（`auth.tokens` 命中即可），
和 `peers` 列表无关，所以收得到；出站必须在本进程的 `peers` 里找到目标。

## 3. 标记已读 / 放弃队列之后状态又回来了

*症状*：`dshlink outbox drop --to <peer>` 之后，过一会儿队列里又出现同样的条目；
或 `inbox --mark-read` 之后又变回未读。

*原因*（0.2.0 及更早）：节点进程和 CLI 是两个进程，共用 `state.json`，各自持有内存快照后整份写回——
后写的一方把对方的改动覆盖掉。

*处理*：升到 0.2.1（写回前重新读盘并合并：`read` 取并集、`delivery` 取 `updatedAt` 较新者）。
不要在旧版本上用"多开进程 + 手工改状态"绕过。

## 4. doctor 一直报队列 pending

*症状*：`queue  1 message(s) not delivered yet — dshlink flush`，但 flush 也发不出去（对端节点已经不存在了）。

*处理*（0.2.1）：`dshlink outbox` 看队列，`dshlink outbox drop --id <msg>` 或 `--to <peer>` 放弃；
被放弃的条目状态是 `dropped`，此后 flush 不再重试，doctor 不再报警。
0.2.0 没有这个命令，只能手工编辑 `state.json`（不推荐）。

## 5. peer 明明是通的，doctor 却说 `tunnel not configured`

*原因*：frpc 是用一份手写 `frpc.toml` 起的，dsh-link 的 `tunnel.enabled=false`——两边互不知情。
这是"挪用"别人配置的典型后果（详见 [`FRP.md`](FRP.md) 第 6 节）。

*处理*：二选一，不要一半一半——

- A：全交给 dsh-link（`tunnel setup → enable → sync`），停掉手工 frpc；
- B：保留手工 frpc，把 peer url 固定成 `http://127.0.0.1:<visitorPort>`，并**不要**再跑 `tunnel sync`。

0.2.1 起 `doctor` 会加一条 `peer-route:<peer>`，明确告诉你"这个 peer 是 dsh-link 之外转发进来的"。

## 6. 重启机器后通道没了

*原因*：手工 frpc 只是前台进程（或没注册服务的计划任务）。dsh-link 管不到它，也不会提醒你。

*处理*：把 frpc 做成计划任务 / systemd 服务（开机自启 + 失败重启），或改用方案 A 交给 dsh-link
（`tunnel.autoStart=true` 时 `serve` 会带起 frpc）。

## 7. 对端改了名字，peer 记录对不上

`nodeId` 不变、`name` 会变（例如 `win-laptop` → `bob-pc`）。
dsh-link 的 `peers` 按 **name** 匹配，所以对端改名后两边都要更新：

```powershell
dshlink peers rm <旧名>
dshlink peers add --name <新名> --url <它的 url> --token <它的 token>
```

跨节点的对账办法：`peers ping` 会打印对端**自己报告**的 name/nodeId；收到历史消息里 `from.name` 与
`from.nodeId` 不一致时，以 nodeId 为准即可判断是不是同一台机器。

## 8. 对端 DSH 收不到"有新消息"的提醒

*现象*：消息确实投递成功（`delivery.state = delivered`，对端 inbox 里也有），但对端的 DSH 一动不动。

*原因*：dsh-link 只负责把消息放进收件箱，**不会也无法唤醒对端的 DSH 进程**。
对端必须自己查：MCP 工具 `link_inbox` / `dshlink inbox --unread`。

*处理*：装 `integrations/dsh-link-bridge/`（DSH Host 插件）。它轮询本机节点，发现未读消息就自动
复用/创建指定工作区里的对话并投 prompt，agent 随即用 MCP 工具读全文、拉文件、回复、标记已读：

```powershell
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write
# 重启一次 DSH host；之后 state.json 的 mtime 一直在动就说明它在工作
```

不想装插件时的兜底：让 DSH 的定时任务每隔 N 分钟跑 `dshlink inbox --unread --json`，
或在对话里让 agent 自己查收件箱。`serve --auto-sync 60` 只保证离线消息最终落盘，它本身**不会**唤醒 agent。

## 9. frpc / frps 启动即退出：exit -1、无任何输出

*症状*：手工跑 `frpc.exe -c frpc.toml`、或 `frps.exe --version`，进程瞬间结束、没有输出、
没有日志文件，退出码是 -1；`tunnel` 测试因此超时。

*原因*：frp 的 Windows 二进制**没有代码签名**，某些安全软件（本机实测装了火绒安全软件 + Defender）
会静默拦截它的执行，表现就是"启动了但什么都没发生"。用签名对比一眼分辨：

```powershell
Get-AuthenticodeSignature .\vendor\frp\windows-amd64\frpc.exe | Select-Object Status   # NotSigned
Get-AuthenticodeSignature "D:\Program Files\nodejs\node.exe" | Select-Object Status     # Valid
```

*处理*：在安全软件里把这些路径加入信任区/白名单
（`<dsh-link>\vendor\frp\**`、`<data-dir>\frp\**`、以及你自己的 frps 目录），然后重启 frpc。
命令行侧绕不过这一步——这是本机安全策略，不是 dsh-link 的问题。
测试套件遇到这种情况会自动 **skip**（并打印原因），不会误报成功能回归。

*判别顺序*：① 二进制能否执行（上面这条）；② `Test-NetConnection <frps> -Port <port>`；
③ `frpc.log` 里是否有 `connect to server error`。三条分别对应"本机拦了 / 服务器不通 / 密钥或配置不对"。

## 10. 消息明明到了，桥（dsh-link-bridge）却一动不动

*先看 `$DSH_HOME/plugin-data/dsh-link-bridge/state.json`*：

| 现象 | 原因 | 处理 |
|---|---|---|
| `lastError: "ECONNREFUSED"`、`ticks` 不涨 | 本机节点没在跑 | `scripts\start-dshlink.cmd`（幂等隐藏启动）；看门狗/计划任务是否在 |
| `ticks` 在涨、`errors: 0`、`notified` 不变 | 消息被判定为"旧"：0.2.1 及更早只按**消息 id 的字典序**比水位线，而合成 id（如自检消息 `msg_bridgecheck…`）会排在真实 ULID `msg_01m28…` **之后**，水位线被"毒化"后一直沉默 | 升到 **0.2.2**（水位线改为 `(ts, id)` 元组，裸 id 状态一律忽略）；应急可删掉 `state.json` 里的 `watermark*` 字段 |
| 有消息但 `unread: 0` | 已经被人/别的会话标为已读 | 桥只处理未读；这是预期行为 |
| 到达后 30 秒内没反应 | `cooldownSeconds` 冷却窗口 | 等下一轮；watermark 不推进会补上 |

*判断"桥是否活着"*：`state.json` 的 mtime 一直在变（每 `pollSeconds` 一次心跳），不需要看控制台。

## 11. 同一个会话被反复唤醒 / 两边互相刷 "Re: Re: Re: …"

*现象*：同一条会话里短时间内出现多次「[[dsh-link 远端消息]]」唤醒，间隔几十秒；消息主题的 `Re:` 前缀不断变长；
停掉一次后过一会儿又来。

*原因*：**两台机器都装了 dsh-link-bridge** 时的"自动对自动"往返——我唤醒会话 → 会话 `link_reply` →
对面桥唤醒对面的会话 → 对面回复 → 我又唤醒……每条自动回复都是新消息，水位线无法阻止。

*处理*：升到 **0.2.3**（内置 thread 冷却 + thread 唤醒预算 + 全局每小时上限，见插件 README「防打环」）。
应急两步：① 把 profile patch 里 `dsh-link-bridge` 的 `enabled` 改成 `false`（**热生效，不用重启**）先止血；
② 通知对端同样处理，别只关一边（另一边还会继续发）。

排查用的数字在 `state.json`：`suppressed` 计数、`lastSuppressed.reason`（`thread cooldown…` 或 `thread budget…`）、
`threads` 里每个 thread 的唤醒次数。

---

## 12. 看不到对方的工作区 / 对话（`dsh_disabled` 等）

*症状*：`dshlink dsh workspaces --peer X` 或 `link_dsh_workspaces` 返回 `403 dsh_disabled`、
`dsh_workspaces_disabled`、`dsh_transcripts_disabled`，或 `503 dsh_unavailable`。

*原因与处理*：

| 返回 | 含义 | 处理 |
|---|---|---|
| `403 dsh_disabled` | 对端节点没打开 DSH 视图 | 在**对端**执行 `dshlink dsh enable --write`（配置热重载，无需重启） |
| `403 dsh_workspaces_disabled` | 开了视图但关了工作区/对话列表 | 对端配置 `dsh.exposeWorkspaces: true` |
| `403 dsh_transcripts_disabled` | 关了对话正文 | 对端配置 `dsh.exposeTranscripts: true` |
| `503 dsh_unavailable` (`home-missing`) | 对端 `dsh.home` / `DSH_HOME` 指错了 | 对端配置里写绝对路径，如 `"home": "D:\\\\DSH"` |
| `404 not_found: no route for GET /api/v1/dsh/...` | 对端节点还是 0.2.x | 对端升级到 0.3.0 并重启节点进程 |

跨机前先确认版本：`dshlink peers ping <peer>` → `softwareVersion` 必须 ≥ 0.3.0。

## 13. 能力调用一直 `pending`（bridge 没接活）

*症状*：`dshlink dsh call ... --wait 30` 返回 `status: "pending"`；过一会儿再查仍是 pending，最终 `expired`。

*判据与处理*（按顺序看）：

1. `dshlink dsh bridge` —— `bridge: no heartbeat yet` 或显示 `STALE`：对端的 DSH 没在跑，或 bridge 插件没装载；
2. bridge 必须 ≥ 0.3.0：`commands.js` 是 0.3 才有的；旧插件只会唤醒对话、不会认领命令。对端要**重启一次 DSH host**；
3. 插件配置里 `commandSeconds: 0` 会关掉整条通道（默认 5 秒）；
4. 节点侧 `capabilities.enabled` 必须为 true，且方法在 `capabilities.methods`（或该 peer 的 `allow`）里；
5. 心跳文件：节点数据目录 `commands/bridge.json`（`dshlink dsh bridge` 同源），mtime 一直在动说明 bridge 活着；
6. `audit.jsonl` 里 `dsh_call` 有记录、但没有 `bridge_commands_claimed` → 命令根本没被认领（回到第 1 条）。

## 14. `zstd-unsupported` / transcript 读不出来

*原因*：DSH 视图靠 `node:zlib` 的 `zstdDecompressSync` 解会话日志，需要 Node ≥ 22.15 / 23.8。
*处理*：升级 Node，或改用 bridge 的能力通道读（`link_call {peer, method:"sessions.read"}`）——那条路走 DSH 自己的 API，不依赖 zstd。
另外日志超过 32 MiB 时只读前 32 MiB（返回 `truncated: true`），这是有意限制。

## 15. 对话没有自动归档，或者侧边栏多了一堆 `[dsh-link]` 对话

*说明*：0.3 的桥按话题建对话：新话题 = 新对话，退休的对话用 DSH 原生归档（`workspaceRegistry.archiveSession`）。
侧边栏出现带 `[dsh-link] ` 前缀的对话是**预期**的，前缀就是为了和人工对话区分。

*调参*：插件配置 `topics.maxSessionWakes`（默认 12）、`topicIdleResetSeconds`（6h）、`maxSessionAgeSeconds`（12h）、
`archiveIdleSeconds`（24h）、`maxPoolSize`（20）；`archiveSessions: false` 关闭自动归档。

*不归档*：确认插件是 0.3（`state.json` 里有 `pool` 字段），`lastArchive.ok` 为 false 时会带 `error`（例如
`workspaceRegistry.archiveSession is unavailable`）。检查 `state.json` 的 `sessionsArchived` 与 `lastArchive`。

*话题切得太碎*：把 `topics.strategy` 设成 `thread`（只按 thread 分组）或调大 `topicIdleResetSeconds`。
---

## 16. 节点刚起来就没了 / 端口又空了

*症状*：用 `Start-Process`、`wscript` 之类的方式从 DSH 的 `pwsh` 工具调用里把节点起起来，命令返回时它还活着，
几十秒后 8787 又没人监听了；`node.err.log` 是空的（没有崩栈）。

*原因*：工具调用本身是一个进程树，调用结束时其子孙进程会被一起回收——节点是它的孙进程，于是被静默带走。
（0.3.0 之前节点没有日志，所以只表现为「起不来」。）

*处理*：让**外部**进程来起节点——计划任务 / 托盘 / 登录脚本：

```powershell
schtasks /Run /TN "dshlink-node-autostart"
# 或由资源管理器双击 scripts\start-dshlink.vbs（不在任何工具调用树里）
```

*判据*：`Get-NetTCPConnection -State Listen -LocalPort 8787` 在**下一条命令**里还能查到；
节点日志在 `<dataDir>\node.out.log` 与 `node.err.log`（0.3.0 起由 `start-dshlink.ps1` 重定向）。

---

## 附：一分钟体检清单

| 检查 | 命令 | 期望 |
|---|---|---|
| 进程与磁盘一致 | `dshlink doctor --json` | `node:config` / `node:version` / `node:hot-reload` 全 pass |
| 对端可达 | `dshlink peers ping` | `reachable: true` + 合理的 latencyMs |
| 双向发消息 | `dshlink send --to <peer> --subject t --body t` | `delivery.state = delivered` |
| 隧道归属 | `dshlink doctor --json` | 有 `peer-route:<peer>` 就说明是外部转发，需自行保证常驻 |
| 文件通道 | `dshlink pull --peer <peer> --root ws --path <f> --out <f>` | `verified: true` |
| 队列干净 | `dshlink outbox` | `0 of N message(s) still queued` |
