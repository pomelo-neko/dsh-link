---
name: dshlink
description: Talk to other DeepSeek Harness machines and their DSH sessions over dsh-link: send/reply in a specific remote Session, read remote workspaces and transcripts, relay messages through a hub, pull/push files, check peers and tunnels, and keep a hub online. Use when the user mentions another PC, a remote DSH, peer messages, hub/中心服务器, the phone controller, or fetching a file from another machine.
---

# dsh-link (机器间通信)

`dshlink` 让本机 DSH 与其它机器上的 DSH 交换消息与文件，并能远程查看/驱动对端 DSH 的会话。
本文按 **0.11.x** 的能力写；对端版本较旧时，缺少的接口会明确报错（看报错里的版本说明）。

**根目录**：命令都在含 `bin\dshlink.mjs` 的 dsh-link 目录下运行（git 仓库，或 DSH 插件树
`<DSH_HOME>\plugins\vendored\dsh-link`），下文用 `$ROOT` 指代；**优先加 `--json`** 便于解析。

## 先看状态

```powershell
node "$ROOT\bin\dshlink.mjs" status --probe --json   # 本机名 / URL / 共享根 / peers 可达性
node "$ROOT\bin\dshlink.mjs" doctor --json           # 自检：配置、目录、端口、MCP、对端、隧道
node "$ROOT\bin\dshlink.mjs" tunnel status           # 启用了 FRP 才有意义
```

- `node.name` 是本机在对端眼里的名字；`peers[]` 列出可通信机器与 `reachable`；
  `roots[]` 是本机共享出去的目录（`write: true` 才允许对端 push）。
- hub 拓扑（0.8+）：本机节点看上行链路用 `hub status --node`；hub 机器看全部节点用
  `hub status` / `hub nodes`（含 visitor 端口与最后心跳）。

## 消息：当成异步邮件用

```powershell
node "$ROOT\bin\dshlink.mjs" inbox --unread --json                 # 读未读（--mark-read 顺手标记）
node "$ROOT\bin\dshlink.mjs" show --id msg_xxx --json              # 读全文（含附件元数据）
node "$ROOT\bin\dshlink.mjs" send --to <peer> --subject s --body "..." --json
node "$ROOT\bin\dshlink.mjs" send --to <peer> --body "..." --thread <threadId> --reply-to <msgId> --json
node "$ROOT\bin\dshlink.mjs" sync --from <peer> --json             # 拉对方为我排队投递的消息
node "$ROOT\bin\dshlink.mjs" flush --json                          # 重试我这边待发的消息
```

`send` 的退出码：0 = 已投递；**3 = 仍在队列（对端离线）**；这不是失败，别重复发同一条。

## 定向会话：跟对端的某个 DSH 会话连续多轮（0.4+）

普通消息会落到对端 bridge 的话题池会话里。要让**对端某个真实会话**收到并直接回复，用定向字段：

```powershell
# 首次：指定对端会话 id（可用 dsh sessions 查）与本机会话 id
node "$ROOT\bin\dshlink.mjs" send --to <peer> --subject s --body "..." `
  --target-session <对端 sessionId> --origin-session <本机 sessionId> --json

# 查看/补登记 thread 与本机会话的绑定（之后 reply 会自动带 originSession）
node "$ROOT\bin\dshlink.mjs" bind --thread <threadId> [--session <本机 sessionId>]
```

- MCP：`link_send_message { targetSession, originSession }`；`link_reply` 的 `targetSession`
  默认取被回复消息的 `originSession`，所以对端用 MCP 回复时无需再填。
- 首次交换后对端 bridge 会记住 thread→Session 的绑定和路由，后续消息不携带 id 也会按 thread 投递；
  旧对端不认识这些字段时退化成普通消息（进话题池），升级是双向兼容的。
- 对端 bridge 的 `targets` 策略可以拒绝唤醒某个会话（防止任意 peer 乱插话）；被拒或目标会话已死时
  消息不会丢：改由该 thread 的路由/绑定或话题池会话处理，并在提示里说明原本想投给谁。

## 跨机查看 / 驱动对端 DSH（0.3+，默认关闭）

需要对方节点打开 `dsh.enabled: true`（只读视图，节点直读磁盘）或 `capabilities.enabled: true`
（动作，需要对方的 bridge 插件在跑）：

```powershell
node "$ROOT\bin\dshlink.mjs" dsh workspaces [--peer P]                      # 对端全部工作区
node "$ROOT\bin\dshlink.mjs" dsh sessions [--peer P] [--workspace W] [--archived] [--query Q]
node "$ROOT\bin\dshlink.mjs" dsh transcript <sessionId> [--peer P] [--limit N] [--tail]
node "$ROOT\bin\dshlink.mjs" dsh capabilities [--peer P]                    # 对端开放的方法 + bridge 心跳
node "$ROOT\bin\dshlink.mjs" dsh call <method> [--peer P] [--params '<json>'] [--wait N]
node "$ROOT\bin\dshlink.mjs" dsh result <commandId>                         # 补取异步结果
node "$ROOT\bin\dshlink.mjs" dsh bridge                                     # 本机 bridge 心跳与命令队列
```

- 读：`workspaces.list` / `sessions.list` / `sessions.read`；动作：`sessions.create` /
  `sessions.prompt` / `sessions.rename` / `sessions.archive` 等，实际清单以 `dsh capabilities` 为准。
- MCP 对应工具：`link_dsh_workspaces` / `link_dsh_sessions` / `link_dsh_transcript` / `link_call`。
- 这些是**对端真实会话**：`sessions.prompt` 会插话到它的下一步边界（steer），不要当脚本通道刷屏。

## 文件：先看再拉

```powershell
node "$ROOT\bin\dshlink.mjs" ls   --peer <peer> --root <root> --path <dir> --json
node "$ROOT\bin\dshlink.mjs" pull --peer <peer> --root <root> --path <file> [--out <本地路径>] --json
node "$ROOT\bin\dshlink.mjs" push --to <peer> --root <root> --path <目标路径> --file <本地文件> --json
```

- 拉取默认落到 `<data-dir>\inbox\<文件名>`，返回里的 `path` 是真实落盘位置，`verified` 表示 sha256 校验。
- 只能访问对端**共享根之内**的文件；`.env`、`*.key`、`.ssh` 等会被拒绝（报 `forbidden`）。
- 大文件用文件 API（`pull/push`），不要把大文件塞进消息附件（内联上限 512 KiB）。
- **>10 MiB 的文件默认经 hub 不主动发送**：除非用户明确要求传输，否则先告知大小与用途、让用户决定
  （设计约定 N3；跨公网链路尤其注意流量与断点）。

## hub 拓扑、手机控制端与常驻（0.8+）

- 节点接入中心：hub 侧 `hub token new --role enroll` 生成一次性接入 token，节点侧执行
  `hub enroll --url <hub> --token <t>`，之后 `hub status --node` 看心跳；`hub reconnect` 手动重连。
- hub 自带 Web 控制台：`<hub-url>/ui`（enroll 令牌、节点状态、缓存区重投/丢弃、设置、手机证书）。
- 手机控制端（不是移动节点，而是遥控某个节点/hub）：hub 上 `hub invite --phone` 生成旧版
  `dshlink1:` 连接串，或 `hub phone bootstrap`（0.10+）生成一次性 `dshlink2:` 引导码由手机换取
  每设备证书；Android App 连上后可浏览工作区/会话、接收更新、向指定会话发消息。
  证书/隧道管理：`hub phone devices` / `hub phone status` / `hub phone revoke <id>`，
  安全细节见 `docs/PHONE-SECURITY.md`。
- Windows 上 hub 常驻用独立服务脚本（0.11.2+），**不要**把 hub 挂在 DSH host 的会话里当子进程：

```powershell
powershell -File "$ROOT\scripts\hub-service.ps1" install -InstallDir "$ROOT"
powershell -File "$ROOT\scripts\hub-service.ps1" status
powershell -File "$ROOT\scripts\hub-service.ps1" stop     # 先禁用自启再停；临时停 hub 用这个
powershell -File "$ROOT\scripts\hub-service.ps1" start
powershell -File "$ROOT\scripts\hub-service.ps1" restart  # 升级代码后用
```

  hub 日志在 hub 数据目录的 `logs\`（默认 `%USERPROFILE%\.dshlink-hub\logs`）。

## 与 MCP 工具的关系

如果 DSH 里已经有 `mcp__dshlink__link_*` 工具，优先用它们（更省 token、参数结构化）：
`link_status`、`link_inbox`、`link_read_message`、`link_send_message`、`link_reply`、
`link_pull_file`、`link_push_file`、`link_peers`、`link_dsh_*`、`link_call` …
CLI 适合这些场景：MCP 未配置、需要在脚本/长流程里批处理、或要给人看的表格输出。

## 有新消息时谁叫醒我

dsh-link 只把消息放进收件箱，**不会唤醒对话**；本机若装了 `dsh-link-bridge` 插件，
它会在收到未读消息时自动创建/复用一个对话并把你叫起来（`workspacePath` 指定的工作区里；
定向消息则直接投递到对端指定的会话）。
判断它是否在工作：`$DSH_HOME/plugin-data/dsh-link-bridge/state.json` 的 mtime 是否在更新，
其中 `watermark` 是已唤醒到哪条消息、`sessionId` 是正在用的对话。
如果没人叫你，而你又怀疑有消息，主动查一次：`node "$ROOT\bin\dshlink.mjs" inbox --unread --json`。

## 注意

- 对端名来自 `peers list`；用 `self` 表示本机。
- 对端不可达先 `status --probe` / `peers ping`；再看 `tunnel status`、frpc 日志与 hub 的
  `hub status --node`。
- 入站 token 有角色（admin / bridge / peer / device；hub 侧另有 enroll），最小权限发放；
  不要伪造 `--token` / `--url` 去连陌生地址；新增对端应让用户确认。
- `8788`（回环令牌网关）与 `8791`（手机 mTLS 网关）是给手机/外部入口用的；agent 直接用节点 API
  或 MCP，不要绕到网关或公网地址上。
- 升级 dsh-link 后本技能不会自动变：重跑 `install-dsh --write`，或把仓库的
  `integrations\dsh-skill\SKILL.md` 复制到 `$DSH_HOME\skills\dshlink\SKILL.md`。
