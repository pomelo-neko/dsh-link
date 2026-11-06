# dsh-link —— 让多台计算机上的 DeepSeek Harness 互相通信

[English](README.md) | **简体中文**

**一句话**：在两台（或多台）跑着 DSH 的机器上各起一个 `dshlink` 节点，它们就能互相发消息、互相拉取/推送文件、离线排队、通过 MCP 直接变成 DSH 的原生工具。

- 零运行时依赖：只用 Node 内置模块（`node:http` / `node:crypto` / `node:fs`），不需要 npm install。
- 三种连通方式：**局域网/公网直连**、**FRP STCP 内网穿透**（无公网端口，推荐）、**hub 中心服务器**（0.8：节点统一接入中心，A→hub→B，带持久队列与 Web 控制台）。
- 给 DSH 的两条接入路径：**MCP**（`dsh-mcp-client` 挂本机 `/mcp`，工具名 `mcp__dshlink__link_*`）和 **CLI/技能**（agent 用 pwsh 调 `dshlink`）。
- **定向会话（0.4）**：消息可以点名对方机器上的具体 **Session**，回复自动带回发起会话；两端真实对话可以多轮交流，而不是全部落进桥的池会话。策略可控、可关闭。
- **手机控制端（0.6）**：`android/` 里的 App 连到一台节点，用 `device` token 浏览该节点的 DSH 工作区/会话、前台增量看对话、通过 `sessions.prompt` 发消息。它是控制端，不是节点；0.4.0 起也可直连 **hub**。
- **随手交给别人（0.9）**：一个便携发行包带 CLI、文档、集成与安卓 APK（可选 frpc）；手机用一条**连接串**接入 hub——连接串自带 `device` 令牌，启用 FRP 时还内嵌 STCP 隧道与证书，APK 内不含任何密钥。
- **一部手机一张证书（0.10）**：手机接入不再共享 hub 令牌和隧道凭据，改用一次性 `dshlink2:` 引导：连接串只 pin hub 的 phone CA 公钥和一次性 secret，手机本地生成密钥对、由 hub 签发客户端证书；手机只连 hub 回环上的 mutual-TLS 网关（8791），网关再注入 hub 令牌，隧道走独立的 phone-frps 租户。吊销一部手机是按证书指纹的独立操作，手机之间不共享秘密。见 [`docs/PHONE-SECURITY.md`](docs/PHONE-SECURITY.md)。
- **hub 拓扑（0.8）**：一个独立的 `dshlink hub` 进程做中心，节点用一次性 enroll token 接入；消息/DSH 视图/能力调用/文件全部经 hub 中转，hub 带持久 outbox、心跳补发与去重，并自带 Web 控制台（`/ui`）。
- 文件访问被限制在配置的共享根目录内，默认可读、需显式开启写入；`.env`、`*.key`、`.ssh` 等默认在拒绝清单里。

---

## 1. 快速开始（两台机器）

在 **A 机**（本仓库根目录，示例为 `D:\dsh-link`）：

```powershell
# 1) 初始化节点：名字、监听端口、共享目录（可多次 --root）
node bin\dshlink.mjs init --name alice-pc --port 8787 --root ws=D:\ws
#    输出里会打印一次性 token 和 STCP secretKey，给对端用

# 2) 启动节点（HTTP API + MCP 端点）
node bin\dshlink.mjs serve
```

在 **B 机** 同样 init/serve，然后在 A 上登记 B：

```powershell
node bin\dshlink.mjs peers add --name bob-pc --url http://<B的IP>:8787 --token <B的token>
node bin\dshlink.mjs peers ping --name bob-pc          # 探活
node bin\dshlink.mjs send --to bob-pc --subject hi --body "你好，我是 A"
node bin\dshlink.mjs pull --peer bob-pc --root ws --path report.pdf --out .\report.pdf
```

B 侧查看和回复：

```powershell
node bin\dshlink.mjs inbox --unread
node bin\dshlink.mjs show --id msg_xxx
node bin\dshlink.mjs send --to alice-pc --body "收到" --thread msg_xxx
```

> **AIGC 声明**：本仓库完全由 AI 生成与维护，详见 [`AIGC-Notice.md`](AIGC-Notice.md)。

> **离线也没关系**：对方不可达时消息进入本地 outbox 队列（`send` 返回 `pending`）。
> 之后 `dshlink flush` 重试推送，或对方用 `dshlink sync --from <你>` 主动拉走。

## 2. 接进 DSH（MCP，推荐）

给 `dsh-mcp-client` 加一条指向**本机** dshlink 的配置（每个 DSH 机器只需一条配置，
远端节点通过对端名访问，而不是每个对端配一个 MCP）：

```yaml
- id: mcp-dshlink
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dshlink
    transport: streamable-http
    url: http://127.0.0.1:8787/mcp
    # 0.5：每个请求都要 token；install-dsh --token 会写入这一行
    headers:
      authorization: !!js '`Bearer ${process.env.DSHLINK_TOKEN}`'
```

重启 DSH 后即出现原生工具：`mcp__dshlink__link_status`、`link_peers`、`link_send_message`、
`link_inbox`、`link_read_message`、`link_reply`、`link_sync`、`link_flush`、
`link_list_files`、`link_stat_file`、`link_pull_file`、`link_push_file`、`link_help`。

0.5 起默认**不信任本机回环**，每个请求都要 token。先运行 `dshlink harden --write` 铸出
`admin`（MCP/CLI 用）与 `bridge`（桥用）两个 token，再用 `install-dsh --token … [--bridge-token …]`
写进 patch。见 [`docs/DSH-INTEGRATION.md`](docs/DSH-INTEGRATION.md) 与 [`SECURITY.md`](SECURITY.md)。

也可以把 `integrations/dsh-skill/` 复制到 `$DSH_HOME/skills/dshlink/`，让 agent 学会用 CLI。

### 收到消息自动唤醒对话（dsh-link-bridge）

MCP 装好只解决了"agent 能用工具"，没解决"agent 不知道有消息"——以前必须有人打开对话问一句。
`integrations/dsh-link-bridge/` 是一个 DSH Host 插件，它轮询本机节点，发现未读消息就**自动复用/创建**
一个指定工作区里的对话并投一条 prompt（模板里带上消息正文与对端名），agent 随即用 MCP 工具读全文、
拉文件、`link_reply` 回复、标记已读。装配一条命令：

```powershell
node bin\dshlink.mjs harden --write     # 0.5：关闭回环信任，打印 admin / bridge 两个 token（只显示一次）
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write --token <admin-token> --bridge-token <bridge-token>
# 然后重启一次 DSH host（新插件条目在启动时装载）；之后改配置即时生效
```

0.4 起桥还支持**定向投递**：来信信封里带 `targetSession` 且桥的 `targets` 策略放行时，prompt 直接进那条本机会话（而不是池会话），并把 thread 绑定下来，后续消息继续落在同一会话；回复自动带回发起的会话。未定向的消息仍走上面的话题逻辑。

细节、配置项与自检方式见 [`integrations/dsh-link-bridge/README.md`](integrations/dsh-link-bridge/README.md)。

### 看到并访问对方的所有工作区与对话（0.3）

0.2.x 只能访问**预先声明的共享目录**，对话更要靠人打开才知道有新消息。0.3 有两层能力，都**默认关闭**：

```powershell
# 只读视图：列出对方全部工作区、全部对话，读任意一条对话的完整消息
dshlink dsh enable --write                 # 打开本机 DSH 视图（对带 token 的 peer 生效）
dshlink dsh workspaces --peer bob-pc
dshlink dsh sessions   --peer bob-pc --archived
dshlink dsh transcript session-xxxx --peer bob-pc --tail --limit 40

# 文件：一个虚拟根覆盖「所有工作区」（第一段是工作区 id 或标题）
#   config: "files": { "roots": [ { "name": "allws", "kind": "workspaces", "read": true } ] }
dshlink ls   --peer bob-pc --root allws
dshlink pull --peer bob-pc --root allws --path "工作区id/src/index.mjs" --out x.mjs

# 动作：让对端读/新建/驱动对话（要显式授权；详见 docs/DSH-ACCESS.md）
dshlink dsh enable --actions workspaces.list,sessions.list,sessions.read,sessions.prompt --write
dshlink dsh call sessions.prompt --peer bob-pc --wait 30 --params '{"sessionId":"session-xxxx","text":"请同步一下进度"}'
```

- **只读视图**由本机节点直接读 DSH 磁盘（`storages/workspace.json` + `sessions/**/session.v3.jsonl.zstd`），
  不需要 DSH 进程参与，所以对端只要节点 ≥ 0.3.0 就能看；
- **动作**走「能力通道」：对端 → 本机节点 → 本机 bridge（在 DSH 内）→ DSH 服务，需要 bridge ≥ 0.3.0；
- MCP 侧对应工具：`link_dsh_workspaces` / `link_dsh_sessions` / `link_dsh_transcript`（可带 `peer`）、
  `link_call`（动作）。安全默认与开关见 [`docs/DSH-ACCESS.md`](docs/DSH-ACCESS.md)。

### 一个话题一个对话 + 自动归档（bridge 0.3）

桥不再永远复用同一个对话：同话题复用、超龄/超预算/闲置就新建，并把退休的对话**归档**（DSH 原生归档，
侧边栏收起、日志保留）。这样「无关上下文被反复塞进同一个会话」的问题就消失了。配置与判据见插件 README。

### 定向会话：和对方的指定对话连续交流（0.4）

0.3 及以前，对端发来的消息一律唤醒桥自己的池会话。0.4 让发送方可以点名接收方机器上的**具体 Session**，
并让接收方记住「这个 thread 归哪条本机会话」，于是回信能回到发起交流的那条对话——中间没有桥会话，
多轮交流也不用每轮重复会话 id。

```powershell
# 发送方：先看对端有哪些对话，再指定一条
dshlink dsh sessions --peer bob-pc
dshlink send --to bob-pc --thread msg_<根消息> --target-session session-xxxx --body "接着这条聊"

# 接收方：查看/固定 thread → 本机会话绑定
dshlink bind --thread msg_<根消息>                 # 查看当前绑定
dshlink bind --thread msg_<根消息> --session session-yyyy
```

`targetSession` / `originSession` 是普通信封字段（中继、sync 原样透传，旧节点也会存下来）；桥按
`targets` 策略决定是否投进指定会话，被拒或目标不存在时回退到 thread 路由或话题池，并把原因写进 prompt。
反方向上，`link_reply`（以及 `dshlink send`）会从绑定自动补 `originSession`，对方的桥再把回信路由回
那条会话。字段只决定 prompt 投到哪，不执行任何命令。策略、回退、线格式与排障见
[`docs/DIRECTED-SESSIONS.md`](docs/DIRECTED-SESSIONS.md)。

### 手机控制端（0.6+，0.7 网络感知，0.8 hub 入口，0.10 每设备证书）

[`android/`](android/) 里的安卓 App 是**控制端而不是节点**：它连到一台已有的 dsh-link 节点，列出该节点
看到的 DSH 工作区/会话，屏幕在前台时按 `sinceSeq` 增量拉取对话，并通过能力通道往指定会话发消息。
没有后台服务，也不在 App 不运行时轮询。0.7 起 App 还会发现入口节点所在网络的节点，可切换到任一
**直连**节点远程浏览/发消息，标注子智能体会话，并把连续的 tool-call 行折叠成可展开的一行。App 0.4.0 起 URL 还可以指向 **hub**：App 识别 `role:"hub"` 后用同一个节点下拉切换 hub 已登记的节点，所有读取与发消息都带 `peer=<node>` 由 hub 转发。

0.10 起，把手机交给别人的推荐方式是 **`dshlink2:` 一次性引导**（App 0.6.0+）：hub 为一部手机
签一条一次性码，手机本地生成密钥对并换取自己的客户端证书，之后所有请求都走 mutual TLS 连到
hub 回环上的 phone gateway（8791）。手机拿不到 hub 令牌，吊销一部手机也不会影响其他手机或隧道。
0.9 的 `dshlink1:`（hub `device` 令牌 + 码内共享 STCP 凭据）仍可用于已配置的设备。安全模型、
命令与威胁模型见 [`docs/PHONE-SECURITY.md`](docs/PHONE-SECURITY.md)。

```powershell
# 节点侧：给手机铸造一个 device token（只能读 DSH 视图 + 调用被允许的能力方法）
node bin\dshlink.mjs token new --label phone --role device --ttl-days 30 --json

# 有 JDK 17+ 与 Android SDK 36 的机器上构建
powershell -File android\build-apk.ps1 -Sdk D:\AndroidSdk
adb install android\dist\dshlink-control-0.4.0-debug.apk
```

节点需要 `dsh.enabled`、`dsh.exposeWorkspaces`、`dsh.exposeTranscripts`、`capabilities.enabled` 且
`capabilities.methods` 含 `sessions.prompt`，并有一个常驻 bridge 执行排队的 prompt。手机通常经
局域网或 VPN（Tailscale/WireGuard）访问节点；App 也可以内置 frpc STCP visitor，经已有的 frps 中转
在无局域网/VPN 时访问节点（节点不需要新开公网端口）。0.3.0 起该 visitor 落到节点的 **8788 token
网关**（由 `dshlink tunnel sync` 按 `gateway.provider` 自动发布），所以中转路径仍必须带 device
token，不再依赖 `trustLocalhost` 旁路。APK 内嵌中转凭据，仍只作自用构建，不要公开分发。
用法见
[`android/README.md`](android/README.md)，接口与验证见 [`docs/mobile/CONTROL-APP.md`](docs/mobile/CONTROL-APP.md)，
网关见 [`docs/GATEWAY.md`](docs/GATEWAY.md)。

## 3. 中心服务器（hub）拓扑（0.8）

hub 是一个**独立进程**（`dshlink hub serve`，默认端口 8790），不跑 DSH、不读节点磁盘，只负责消息、DSH 视图、能力调用与文件的中转和排队。节点用一次性 enroll token 接入后，节点之间不再需要两两配置 peer：

```powershell
# hub 机器（不需要 DSH）：
node bin\dshlink.mjs hub init --name lab-hub --port 8790
node bin\dshlink.mjs hub token new --role enroll --ttl-hours 2 --json   # 一次性接入 token
node bin\dshlink.mjs hub serve

# 每台节点：
node bin\dshlink.mjs hub enroll --url http://<hub>:8790 --token <enroll token>
node bin\dshlink.mjs hub status
node bin\dshlink.mjs tunnel sync     # 配了 FRP 时发布 节点→hub 的 visitor
```

浏览器打开 `http://<hub>:8790/ui`（admin token 登录）即可**审批/移除节点、生成/吊销 enroll token**、查看节点心跳与缓存区、重投或丢弃排队消息、看运行中的会话、修改 hub 设置（重试间隔/消息 TTL/离线阈值/接入策略/文件限制）。hub 从不信任 localhost：所有 API 都要 token（admin/enroll/device/peer 角色），控制台页面本身不含任何秘密。

节点每 30s 心跳一次，90s 没心跳标记离线；投递是**至少一次**，重连后补发离线期间积压的消息（接收端按消息 id 去重）。`hub.enabled` 默认关闭——不启用时行为与 0.7 点对点完全一致；接入 hub 后该节点只经 hub 通信、拒绝 peer 直连中继并忽略 `peers` 列表。设计、决策与 API 见 [`docs/HUB-TOPOLOGY-DESIGN.md`](docs/HUB-TOPOLOGY-DESIGN.md)，控制台说明见 [`docs/HUB-CONSOLE.md`](docs/HUB-CONSOLE.md)。

## 4. 内网穿透（FRP STCP）

两台机器都不在同一个局域网、也没有公网端口时，用一台公网服务器做 frps：

```powershell
# 公网服务器（一次性）：frps 只需放开 7000/tcp，配置模板见 docs/FRP.md
# 每台 DSH 机器：
# frpc 会按 DSHLINK_FRPC → <仓库>\vendor\frp\windows-amd64 → PATH 等顺序查找；
# 本仓库不随附 frp 二进制，请自行从 https://github.com/fatedier/frp/releases/tag/v0.71.0
# 下载 frp_0.71.0_windows_amd64.zip，把 frpc.exe 解压到 vendor\frp\windows-amd64\。
# 凭据与（可选）mTLS 证书可以直接生成：
#   node scripts/gen-secrets.mjs                  # frp token + STCP secretKey + dsh-link 入站 token
#   scripts\gen-certs.ps1 -ServerName <frps地址>    # Windows：CA / 服务端 / 客户端证书
#   ./scripts/gen-certs.sh <frps地址>              # Linux / WSL / macOS
# 开 STCP 前先读 docs/FRP.md §2.3「STCP 模式注意事项」——那条路径上的真正边界是 secretKey。
node bin\dshlink.mjs tunnel setup --server <frps地址> --port 7000 --token <frp token>
node bin\dshlink.mjs tunnel sync          # 生成 frpc.toml 并拉起 frpc（后台常驻）
node bin\dshlink.mjs tunnel share         # 打印给对端的信息：proxyName + secretKey
```

对端拿到 share 信息后一条命令接入：

```powershell
node bin\dshlink.mjs tunnel import --peer alice-pc --frp-server-name dshlink-alice-pc \
     --frp-secret <share里的secretKey> --token <alice-pc的dshlink token>
node bin\dshlink.mjs peers ping --name alice-pc
```

原理：每个节点用 STCP **provider** 把自己 127.0.0.1:8787 私密地挂到 frps；要访问对端时用
**visitor** 在本机开一个端口（默认从 19100 递增）转发过去。双方都只做出站连接，公网只暴露
frps 的 7000 端口，dsh-link 的 API 不直接对外。详见 [`docs/FRP.md`](docs/FRP.md)。

## 5. 常用命令

| 命令 | 作用 |
|---|---|
| `init` | 写配置、生成入站 token 与 STCP 身份（`--root name=path[:ro|:rw]`、`--allow-upload`） |
| `serve` | 启动 HTTP API + `/mcp`；`--auto-sync 30` 可周期同步/重投；`--no-reload` 关掉配置热重载 |
| `status` / `peers list\|add\|rm\|ping` | 本机状态、对端登记与探活 |
| `token list\|new\|rm` | 管理入站 token（只存 sha256，明文仅显示一次） |
| `send` / `inbox` / `show` / `sync` / `flush` | 发消息（`--target-session` / `--origin-session` 可定向）、收件箱、看单条、拉队列、重投 |
| `bind` | 查看/设置 thread → 本机会话绑定（0.4；回复自动带 originSession） |
| `ls` / `pull` / `push` | 列目录、拉文件、推文件（推送需对端 `files.allowUpload: true`） |
| `audit` | 本机审计日志（谁在什么时候拉了哪个文件） |
| `tunnel setup\|sync\|status\|share\|import\|stop\|config` | FRP 穿透的配置与进程管理 |
| `hub init\|serve\|enroll\|status\|nodes\|token\|outbox\|flush\|reconnect\|revoke` | hub 拓扑：起中心、节点接入、签发 enroll token、查节点/心跳/中心队列、重连（0.8；hub 命令可用 `--data-dir` 指定实例） |
| `invite` / `peers accept --invite <码> [--reply]` | 一段配对码完成双向登记（含 token 与 STCP 信息） |
| `doctor` | 自检：配置/共享根/端口/MCP/对端/隧道，退出码非 0 表示有 fail |
| `install-dsh [--write]` | 把 MCP 条目写进 profile 的 `cordis.patch.yml` 并安装技能（默认只预览，写入前自动备份） |

所有命令都支持 `--json`（给 agent/脚本用）与 `--data-dir` / `--config`；退出码：0 成功、
2 用法/配置错、3 消息仍在队列、4 哈希校验失败。

### 配置热重载（0.2.1 起）

`serve` 会在每次请求前检查配置文件，改动即时生效——**新增/删除 peer、加 token、改共享目录都不需要重启进程**：

```powershell
dshlink peers add --name win-laptop --url http://127.0.0.1:19110 --token <对端 token>
# 正在运行的节点立刻就能 send（无需重启）；/api/v1/status 的 runtime.configReloads 会 +1
dshlink doctor        # node:config / node:hot-reload 两项告诉你进程与磁盘配置是否一致
```

0.2.0 及更早版本只在启动时读一次配置：之后用 CLI 加上的 peer 只有 CLI 自己看得见，
运行中的节点 `send` 会报 `unknown peer: <名字>`（收消息却正常，因为入站只校验 token）——
看起来像"配置写错了"，其实是进程里的配置过期。升级后问题消失；旧进程重启一次也可以。
仍需重启的只有配置项 `bind`/`port`、`limits.requestTimeoutMs` 这类进程级参数，以及隧道进程本身。

遇到说不通的现象（`unknown peer`、队列状态"自己变回去"、隧道归属不清等），先看
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)——按症状、原因、处理三段列出，附一分钟体检清单。

### 常驻与开机自启（Windows）

```powershell
scripts\start-dshlink.cmd      # 双击/命令行都行：幂等地把节点和 frpc 以“隐藏窗口”方式拉起
```

`start-dshlink.cmd → start-dshlink.vbs → start-dshlink.ps1`：先看 8787 有没有在听、frpc 有没有在跑，
缺什么补什么（重复执行安全），全程 `-WindowStyle Hidden`，不会弹控制台。计划任务指向 `start-dshlink.vbs` 即可，
本机注册的 `dshlink-node-autostart` 就是“登录触发 + 每 15 分钟兜底”跑它。

关于弹窗：控制台程序如果**父进程没有控制台**，Windows 会给它新建一个可见窗口。所以用托盘/无窗口方式启动 DSH 时，
DSH 拉起的每个 `pwsh`/`node` 工具都会弹窗——解决办法是让启动器给后端一个**隐藏但存在**的控制台
（`CREATE_NEW_CONSOLE` + `STARTF_USESHOWWINDOW/SW_HIDE`），子进程继承它便不再开窗。

## 6. 安全模型（默认值）

| 项 | 默认 | 说明 |
|---|---|---|
| 绑定地址 | `127.0.0.1` | 只监听本机；要 LAN 直连需 `--bind 0.0.0.0` |
| 鉴权 | 必须带 token（0.5） | 入站 token 只存 sha256；角色 `admin` / `bridge` / `peer` / `device`，可绑定 peer、设置过期 |
| 回环信任 | 关闭（0.5） | `auth.trustLocalhost: true` 才恢复旧的免 token 行为，仅给无法带 token 的本地客户端用 |
| 文件根 | 显式配置 | 每个根可 `ro`/`rw`，路径经 realpath 校验，符号链接无法逃逸 |
| 拒绝清单 | `.env`、`*.key`、`.ssh`、`.credentials.yaml` 等 | 可按需覆盖 |
| 上传 | 关闭 | `files.allowUpload: true` 才接受写入 |
| 体积/超时 | 32 MiB 请求、1 MiB 消息、60s 超时 | 另有 `limits.maxRequestsPerMinute`（默认 1200/分钟，按 token 或 IP 计，超限 429 + Retry-After） |
| 审计 | 开 | `audit.jsonl` 记录文件访问与消息投递 |
| DSH 视图（0.3） | 关闭 | `dsh.enabled` 才开放工作区/对话读取；`dsh.exposeTranscripts` 单独控制对话正文 |
| 能力通道（0.3） | 关闭 | `capabilities.enabled` + 方法白名单；**动作方法（新建/发消息/改名/归档）默认不放行**，可按 peer 覆盖；命令只走本机 loopback，远端一律由节点裁决；每次调用写审计 |
| 定向投递（0.4） | 桥默认开启、任意对端 | 桥的 `targets.{enabled,peers,allow,deny}` 决定哪个对端能向哪条本机会话投递；可关闭或收紧 |
| hub 拓扑（0.8） | 关闭 | `hub.enabled`；节点用一次性 enroll token（默认 2h / 1 次）接入，全部流量经 hub；hub 从不信任 localhost，所有 API 都要 token（admin/enroll/device/peer 角色） |
| 手机接入（0.10） | 关闭 | `phoneGateway.enabled`；网关只绑回环，并要求由 hub phone CA 签发的每设备客户端证书；唯一免证书入口是 `POST /api/v1/phone/bootstrap`（一次性 secret 把关）。hub 令牌不下发手机；手机经网关只能访问 `/info`、`/network/*`、`/dsh/*` |

> 打开 DSH 视图 = 让持有 token 的对端读到本机**全部工作区路径与全部对话内容**（对话里可能有凭据、
> 隐私、内部代码）。只在你信任这些对端时打开；动作能力更进一步——`sessions.prompt` 等于让对方驱动
> 你机器上的 agent。开关与建议见 [`docs/DSH-ACCESS.md`](docs/DSH-ACCESS.md)。

**0.5 堵上了回环绕过**：经 FRP/STCP 转发的连接不再因为源地址是 127.0.0.1 就免鉴权；
`/api/v1/bridge/*` 控制面只认本机桥或 `bridge` token，远端 admin 也进不来。token 可按角色、
绑定 peer、设置过期时间。公网部署建议：frps 强制 TLS + token（见 `docs/FRP.md`），或给 dsh-link
前面加 HTTPS 反代；手机端优先走 WireGuard/Tailscale 等 VPN，而不是直接暴露 visitor 端口。

## 7. 目录结构

```
dsh-link/
├── bin/dshlink.mjs         # CLI 入口（init/serve/send/pull/tunnel/...）
├── src/
│   ├── config.mjs          # 配置与身份、token 哈希、peer 登记
│   ├── store.mjs           # inbox/outbox JSONL + 已读状态 + 投递状态 + 审计
│   ├── fsroot.mjs          # 共享根目录沙箱（realpath 校验、拒绝清单、sha256）
│   ├── server.mjs          # 入站 HTTP API（鉴权、限流、Range 下载、审计）
│   ├── mcp.mjs             # MCP streamable HTTP 端点（17 个 link_* 工具）
│   ├── ops.mjs             # 消息投递/队列/同步/中继/文件操作
│   ├── client.mjs          # 出站 HTTP 客户端（流式下载 + 哈希校验）
│   ├── tunnel.mjs          # FRP STCP：frpc.toml 生成、进程管理、分享/导入
│   ├── reload.mjs          # 配置热重载（改 peer/token/根目录不用重启）
│   ├── network.mjs         # 网络发现：peer 图与 hub 已登记节点（0.7/0.8）
│   ├── gateway.mjs         # 回环 token 网关（手机/中转路径，0.7）
│   ├── hub*.mjs            # hub 进程、配置、持久队列、FRP、节点链路、Web 控制台（0.8）
│   ├── phone*.mjs          # 手机 CA、mutual-TLS 网关、一次性引导、phone-frps 租户（0.10）
│   └── pairing.mjs         # 配对码 + DSH 安装（MCP 条目 / 技能 / 自动唤醒桥）
├── vendor/frp/             # frp v0.71.0 校验清单（二进制自行下载，不入库；Apache-2.0）
├── android/                # 安卓控制端 App（纯 Java，无 Gradle 依赖）+ 手动构建脚本
├── test/                   # 234 项检查 / 30 个测试文件（含真实 frps+frpc 隧道、真实 MCP SDK 客户端、热重载、桥与定向会话、hub、网络/网关、手机契约与 mTLS）+ CLI 冒烟
├── docs/                   # 架构、设计、协议、DSH 接入、定向会话、hub 设计与控制台、FRP 部署、运维手册、排障手册、手机端
└── integrations/           # DSH 技能 + settings 片段 + dsh-link-bridge 插件（自动唤醒对话；0.4 定向投递；0.8 hub 面板）
```

## 8. 验证

```powershell
node test/run.mjs                     # 234 项检查（frp/MCP 缺失时自动跳过）：鉴权、消息、队列、同步、中继、文件沙箱、MCP、FRP、配对、桥、定向会话、hub、网络/网关、DSH 视图、手机契约与 mTLS、doctor
powershell -NoProfile -ExecutionPolicy Bypass -File test/cli-smoke.ps1   # 13/13：两个真实进程
```

`test/frp.test.mjs` 会**真的拉起 frps + 两个 frpc**（用你自己下载到 `vendor/frp` 的二进制），让消息和文件
只经过 STCP 隧道（visitor 端口 `127.0.0.1:19130/19131`）流动，并检查 frpc 日志里的
`start proxy success` / `start visitor success`。没有 frp 二进制时该用例自动跳过。

其中 MCP 测试用的是 DSH 自己安装的 MCP TypeScript SDK（`@modelcontextprotocol/sdk` 1.x 或
`@modelcontextprotocol/client` 2.x，均可自动发现），即 dsh-link 与 DSH 的 MCP 端点已被真实客户端验证过。
定向会话也有端到端覆盖：HTTP 信封字段、回环 bind 端点、`link_reply` 自动 `targetSession`、桥的目标投递/策略拒绝回退/一批多目标。0.8 的 hub 测试（`test/hub.test.mjs`、`test/bridge-hub.test.mjs`）在进程内起 hub + 两个登记节点：接入、双向消息、去重/身份校验、离线排队、DSH 与文件代理、Web 控制台及其 admin API、CLI，以及桥的 `state.json.hub` 快照与 host 路由。`test/mobile-contract.test.mjs` 固定手机 App 依赖的节点接口（快照 + `sinceSeq`、能力调用、`device` token 边界），需要 `DSH_HOME` 指向真实 DSH 安装，否则跳过。

**跨公网实测**（Windows 节点 ↔ WSL 节点，经阿里云 frps）：消息双向、文件拉取（sha256 一致）、
文件推送、双向 ping 全部通过，详见 [`docs/WAN-VERIFICATION.md`](docs/WAN-VERIFICATION.md)。

## 9. 已知限制 / 下一步

- 双向信任需要双方互换 token；`invite/accept` 一键式交换待做（当前用 `tunnel share` + `peers add`）。
- FRP 侧只生成 STCP 配置，不代管公网 frps 的部署与证书。
- 大文件没有分片/断点续传（HTTP Range 已支持单段下载，客户端尚未用）。
- 消息默认内联附件上限 512 KiB；更大的文件走文件 API。
- 配置热重载覆盖 peers / tokens / 共享目录 / `dsh` / `capabilities`；配置项 `bind`/`port`、`limits.requestTimeoutMs` 与隧道进程仍需重启。
- DSH 视图是**磁盘直读**：DSH 换会话日志格式（当前 v3）时需要升级 dsh-link；无 zstd 的 Node（<22.15）
  会报 `zstd-unsupported`，此时改用 bridge 的能力通道读。
- 会话摘要里的 `messages` 是下界（索引只扫日志头部），要精确条数用 `transcript` 的 `total`。
- 定向投递需要发送端节点 ≥ 0.4、接收端节点与桥 ≥ 0.4 才会生效；旧节点会存下字段但忽略。
- hub 投递是**至少一次**：接收端按消息 id 去重，但数据目录丢失后可能再次收到同一条；hub 本身不做 TLS，需放在 frp TLS 隧道或自己的 HTTPS 反代之后。
- hub 控制台与 DSH Web GUI 里的 hub 面板由 bridge 插件注册，**重启 DSH Host 后**才出现（bridge 不能热重载）；`hub.enabled` 默认关闭，节点不能同时跑点对点与 hub 模式。
- 尚无端到端加密（依赖 frps 的 TLS/网络可信）；仅在可信网络或加反代后使用。

## 10. 分发与部署（0.9：交给别人用）

0.9 起，发行包和手机接入都不再依赖本机私有文件：包里有 APK，手机用一次性连接串接入。

```powershell
# 默认自动打包 android/dist 下最新的 APK；-NoApk 不带 APK；-NoVendor 跳过 frpc
powershell -ExecutionPolicy Bypass -File scripts\build-bundle.ps1
# 产物（dist/）：
#   dsh-link-<版本>-portable.zip      （带 frpc 约 12 MB；-NoVendor 时约 0.1 MB）
#   dsh-link-<版本>-portable.tar.gz   （Linux/WSL 友好，保留可执行位）
#   SHA256SUMS.txt                    （两个包的 sha256）
#   BUNDLE-INFO.json                  （在包内：文件数、frpc 清单、APK 版本与 sha256）
```

包内是**客户端 + hub**：`bin/ src/ docs/ integrations/ examples/ test/` + 入口文件
（`README-FIRST.md` 三步上手、`install.ps1`、`install.sh`）+ `vendor/frp/{windows-amd64,linux-amd64}/frpc`
（**只有 frpc，不含 frps**——frps 属于服务器侧）+ `apk/dshlink-control-<版本>-debug.apk`
（APK 本身不含任何密钥；同目录 README 有安装与校验说明）+ `BUNDLE-INFO.json` / `SHA256SUMS.txt`。
对方机器只需要 Node.js ≥ 20，解压后跑安装脚本即可：初始化、可选配置穿透、可选注册常驻服务、
可选接入自己的 DSH（MCP 条目 + 技能），最后打印配对码。

打包后可用一条命令验证"包真的能被别的机器用"：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-bundle.ps1 -Bundle dist\dsh-link-<版本>-portable.zip -PeerDataDir <本机节点 data 目录>
# 解压 → 跑包内 install.ps1 → 起节点 → 与本机节点配对 → 发消息 + 拉文件（sha256 校验）→ 10 项全 PASS
```

已实测：Windows 侧 zip 全流程 10 项通过；WSL 侧 tar.gz 解压后 `bash install.sh` 正常，
自带 Linux `frpc` 为可执行 ELF 且能被 `tunnel setup` 自动发现（`doctor` 7 pass / 3 warn / 0 fail）。

### 10.1 在别人的服务器上部署 hub

完整步骤见 [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md)：frps（0.71+）+ `scripts/gen-certs.ps1` 生成
mTLS 证书 → `hub init`（带 `--frp-server/--frp-port/--frp-token/--frp-cert/--frp-key/--frp-ca`）→
`hub serve` 常驻（Windows 计划任务 / Linux systemd 示例在文档里）→ 节点 `tunnel setup` +
`hub enroll --url <hub>` + `tunnel sync`。控制台 `/ui` 只建议从本机或 SSH 端口转发访问。

### 10.2 给别人的手机接入

```powershell
# hub 上生成一次性连接串（默认 2 小时；--no-tunnel 用于局域网/VPN 直连，需给 --url）
node bin\dshlink.mjs hub invite --phone --label alice --out alice-phone.txt
# 或在 hub 控制台 -> “手机接入”卡片 -> 生成 / 复制 / 下载
```

对方安装 `apk/` 里的 APK，用 App 的“导入连接串”粘贴（或把 `.txt` 发到手机后从文件导入）即可：
连接串自带 hub 地址与独立的 `device` 令牌；hub 启用 FRP 时还内嵌 STCP visitor 配置和客户端证书，
手机不需要额外配置隧道。每部手机一个令牌，丢失后在控制台或 `hub token rm --id <id>` 吊销。
APK 本身不含任何密钥/隧道凭据，可以公开分发；连接串等同密码，请私下发送。

### 10.3 更安全的手机接入（0.10：每设备证书 + 独立 phone-frps）

0.10 起推荐用 `dshlink2:` 一次性引导替代 `dshlink1:`。连接串不再包含 hub 的 frps token、
mTLS 私钥或节点网络 STCP secret；它只 pin hub 的 phone CA 公钥和一条一次性 bootstrap secret，
手机本地生成密钥对并换取自己的客户端证书。

```powershell
# hub 上：建立 phone CA + mutual-TLS 网关（可选同时配置独立的 phone-frps）
node bin\dshlink.mjs hub phone setup --data-dir C:\dshlink-hub --no-tunnel
# 公网手机推荐带独立 phone-frps（它有自己的 token/证书/provider，与节点网络隔离）：
# node bin\dshlink.mjs hub phone setup --data-dir C:\dshlink-hub --phone-frp-server frps.example.com --phone-frp-port 7000 --phone-frp-token <token> --phone-frp-cert C:\certs\client.crt --phone-frp-key C:\certs\client.key --phone-frp-ca C:\certs\ca.crt
node bin\dshlink.mjs hub serve --data-dir C:\dshlink-hub

# 每部手机一条一次性码（默认 2 小时 / 1 次）
node bin\dshlink.mjs hub phone bootstrap --data-dir C:\dshlink-hub --label alice --ttl-hours 2 --out alice.txt
node bin\dshlink.mjs hub phone devices --data-dir C:\dshlink-hub
node bin\dshlink.mjs hub phone revoke --data-dir C:\dshlink-hub alice
```

- 手机只访问 loopback 的 phone gateway（默认 8791），网关校验客户端证书后注入 hub 令牌；
  手机永远拿不到 hub 令牌，也访问不到 `/api/v1/hub/*` 等管理路由。
- 吊销按证书指纹即时生效，只影响那一部手机；CA 私钥只在 hub 的 `phone-ca/` 里。
- phone-frps 是独立租户：自己的 auth token、mTLS 证书、STCP provider；即使手机码泄露，也不能
  变成节点网络或 hub frps 的访问能力。
- 无隧道时必须给 `--url`，且当前网关 server 证书 SAN 固定为 `127.0.0.1/localhost`，所以
  应指向手机本机回环（adb reverse / port-forward）；跨网络手机请用 phone-frps 隧道。
- 旧的 `hub invite --phone`（`dshlink1:`）继续可用，适合已配置设备；新手机建议一律走
  `hub phone bootstrap`。完整安全模型、威胁模型与轮换见 [`docs/PHONE-SECURITY.md`](docs/PHONE-SECURITY.md)。
