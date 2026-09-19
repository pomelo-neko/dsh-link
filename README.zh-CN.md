# dsh-link —— 让多台计算机上的 DeepSeek Harness 互相通信

[English](README.md) | **简体中文**

**一句话**：在两台（或多台）跑着 DSH 的机器上各起一个 `dshlink` 节点，它们就能互相发消息、互相拉取/推送文件、离线排队、通过 MCP 直接变成 DSH 的原生工具。

- 零运行时依赖：只用 Node 内置模块（`node:http` / `node:crypto` / `node:fs`），不需要 npm install。
- 三种连通方式：**局域网/公网直连**、**FRP STCP 内网穿透**（无公网端口，推荐）、**中继转发**（A→hub→B）。
- 给 DSH 的两条接入路径：**MCP**（`dsh-mcp-client` 挂本机 `/mcp`，工具名 `mcp__dshlink__link_*`）和 **CLI/技能**（agent 用 pwsh 调 `dshlink`）。
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
```

重启 DSH 后即出现原生工具：`mcp__dshlink__link_status`、`link_peers`、`link_send_message`、
`link_inbox`、`link_read_message`、`link_reply`、`link_sync`、`link_flush`、
`link_list_files`、`link_stat_file`、`link_pull_file`、`link_push_file`、`link_help`。

默认信任本机回环地址，所以同机 MCP 不需要 token；如需显式 token，见
[`docs/DSH-INTEGRATION.md`](docs/DSH-INTEGRATION.md)。

也可以把 `integrations/dsh-skill/` 复制到 `$DSH_HOME/skills/dshlink/`，让 agent 学会用 CLI。

### 收到消息自动唤醒对话（dsh-link-bridge）

MCP 装好只解决了"agent 能用工具"，没解决"agent 不知道有消息"——以前必须有人打开对话问一句。
`integrations/dsh-link-bridge/` 是一个 DSH Host 插件，它轮询本机节点，发现未读消息就**自动复用/创建**
一个指定工作区里的对话并投一条 prompt（模板里带上消息正文与对端名），agent 随即用 MCP 工具读全文、
拉文件、`link_reply` 回复、标记已读。装配一条命令：

```powershell
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write
# 然后重启一次 DSH host（新插件条目在启动时装载）；之后改配置即时生效
```

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

## 3. 内网穿透（FRP STCP）

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

## 4. 常用命令

| 命令 | 作用 |
|---|---|
| `init` | 写配置、生成入站 token 与 STCP 身份（`--root name=path[:ro|:rw]`、`--allow-upload`） |
| `serve` | 启动 HTTP API + `/mcp`；`--auto-sync 30` 可周期同步/重投；`--no-reload` 关掉配置热重载 |
| `status` / `peers list\|add\|rm\|ping` | 本机状态、对端登记与探活 |
| `token list\|new\|rm` | 管理入站 token（只存 sha256，明文仅显示一次） |
| `send` / `inbox` / `show` / `sync` / `flush` | 发消息、收件箱、看单条、拉队列、重投 |
| `ls` / `pull` / `push` | 列目录、拉文件、推文件（推送需对端 `files.allowUpload: true`） |
| `audit` | 本机审计日志（谁在什么时候拉了哪个文件） |
| `tunnel setup\|sync\|status\|share\|import\|stop\|config` | FRP 穿透的配置与进程管理 |
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
仍需重启的只有 `bind`/`port`、`limits.requestTimeoutMs` 这类进程级参数，以及隧道进程本身。

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

## 5. 安全模型（默认值）

| 项 | 默认 | 说明 |
|---|---|---|
| 绑定地址 | `127.0.0.1` | 只监听本机；要 LAN 直连需 `--bind 0.0.0.0` |
| 鉴权 | 出站 token + 可选信任回环 | 入站 token 只存 sha256；本机回环默认免 token |
| 文件根 | 显式配置 | 每个根可 `ro`/`rw`，路径经 realpath 校验，符号链接无法逃逸 |
| 拒绝清单 | `.env`、`*.key`、`.ssh`、`.credentials.yaml` 等 | 可按需覆盖 |
| 上传 | 关闭 | `files.allowUpload: true` 才接受写入 |
| 体积/超时 | 32 MiB 请求、1 MiB 消息、60s 超时 | 见 `limits` |
| 审计 | 开 | `audit.jsonl` 记录文件访问与消息投递 |
| DSH 视图（0.3） | 关闭 | `dsh.enabled` 才开放工作区/对话读取；`dsh.exposeTranscripts` 单独控制对话正文 |
| 能力通道（0.3） | 关闭 | `capabilities.enabled` + 方法白名单；**动作方法（新建/发消息/改名/归档）默认不放行**，可按 peer 覆盖；命令只走本机 loopback，远端一律由节点裁决；每次调用写审计 |

> 打开 DSH 视图 = 让持有 token 的对端读到本机**全部工作区路径与全部对话内容**（对话里可能有凭据、
> 隐私、内部代码）。只在你信任这些对端时打开；动作能力更进一步——`sessions.prompt` 等于让对方驱动
> 你机器上的 agent。开关与建议见 [`docs/DSH-ACCESS.md`](docs/DSH-ACCESS.md)。

公网部署建议：frps 强制 TLS + token（见 `docs/FRP.md`），或给 dsh-link 前面加 HTTPS 反代。

## 6. 目录结构

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
│   └── pairing.mjs         # 配对码 + DSH 安装（MCP 条目 / 技能 / 自动唤醒桥）
├── vendor/frp/             # frp v0.71.0 校验清单（二进制自行下载，不入库；Apache-2.0）
├── test/                   # 116 项检查 / 15 个测试文件（含真实 frps+frpc 隧道、真实 MCP SDK 客户端、热重载与桥）+ CLI 冒烟
├── docs/                   # 架构、设计、协议、DSH 接入、FRP 部署、运维手册、排障手册
└── integrations/           # DSH 技能 + settings 片段 + dsh-link-bridge 插件（自动唤醒对话）
```

## 7. 验证

```powershell
node test/run.mjs                     # 116/116：鉴权、消息、队列、同步、中继、文件沙箱、MCP、FRP、配对、桥、DSH 视图、doctor
powershell -NoProfile -ExecutionPolicy Bypass -File test/cli-smoke.ps1   # 13/13：两个真实进程
```

`test/frp.test.mjs` 会**真的拉起 frps + 两个 frpc**（用你自己下载到 `vendor/frp` 的二进制），让消息和文件
只经过 STCP 隧道（visitor 端口 `127.0.0.1:19130/19131`）流动，并检查 frpc 日志里的
`start proxy success` / `start visitor success`。没有 frp 二进制时该用例自动跳过。

其中 MCP 测试用的是 DSH 自己安装的 `@modelcontextprotocol/sdk`（`dsh-mcp-client` 的底层库），
即 dsh-link 与 DSH 的 MCP 端点已被真实客户端验证过。

**跨公网实测**（Windows 节点 ↔ WSL 节点，经阿里云 frps）：消息双向、文件拉取（sha256 一致）、
文件推送、双向 ping 全部通过，详见 [`docs/WAN-VERIFICATION.md`](docs/WAN-VERIFICATION.md)。

## 8. 已知限制 / 下一步

- 双向信任需要双方互换 token；`invite/accept` 一键式交换待做（当前用 `tunnel share` + `peers add`）。
- FRP 侧只生成 STCP 配置，不代管公网 frps 的部署与证书。
- 大文件没有分片/断点续传（HTTP Range 已支持单段下载，客户端尚未用）。
- 消息默认内联附件上限 512 KiB；更大的文件走文件 API。
- 配置热重载覆盖 peers / tokens / 共享目录 / `dsh` / `capabilities`；`bind`/`port`、`limits.requestTimeoutMs` 与隧道进程仍需重启。
- DSH 视图是**磁盘直读**：DSH 换会话日志格式（当前 v3）时需要升级 dsh-link；无 zstd 的 Node（<22.15）
  会报 `zstd-unsupported`，此时改用 bridge 的能力通道读。
- 会话摘要里的 `messages` 是下界（索引只扫日志头部），要精确条数用 `transcript` 的 `total`。
- 尚无端到端加密（依赖 frps 的 TLS/网络可信）；仅在可信网络或加反代后使用。

## 9. 导出给其他 DSH 使用（客户端发行包）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-bundle.ps1
# 产物（dist/）：
#   dsh-link-<版本>-portable.zip      （带 frpc 约 12 MB；-NoVendor 时约 0.1 MB）
#   dsh-link-<版本>-portable.tar.gz   （Linux/WSL 友好，保留可执行位）
#   SHA256SUMS.txt                              两个包的 sha256
```

包内是**客户端**：`bin/ src/ docs/ integrations/ test/` + 三个入口文件
（`README-FIRST.md` 三步上手、`install.ps1`、`install.sh`）+ `vendor/frp/{windows-amd64,linux-amd64}/frpc`
（**只有 frpc，不含 frps**——frps 属于服务器侧）+ `BUNDLE-INFO.json` / `SHA256SUMS.txt`。
对方机器只需要 Node.js ≥ 20，解压后跑安装脚本即可：初始化、可选配置穿透、可选注册常驻服务、
可选接入自己的 DSH（MCP 条目 + 技能），最后打印配对码。

打包后可用一条命令验证"包真的能被别的机器用"：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-bundle.ps1 -Bundle dist\dsh-link-<版本>-portable.zip -PeerDataDir <本机节点 data 目录>
# 解压 → 跑包内 install.ps1 → 起节点 → 与本机节点配对 → 发消息 + 拉文件（sha256 校验）→ 10 项全 PASS
```

已实测：Windows 侧 zip 全流程 10 项通过；WSL 侧 tar.gz 解压后 `bash install.sh` 正常，
自带 Linux `frpc` 为可执行 ELF 且能被 `tunnel setup` 自动发现（`doctor` 7 pass / 3 warn / 0 fail）。
