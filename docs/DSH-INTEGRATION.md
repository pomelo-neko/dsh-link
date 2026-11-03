# 把 dsh-link 接进 DeepSeek Harness

三种接入方式，按推荐顺序排列。

## 方式 1：MCP（推荐，agent 直接获得原生工具）

DSH 通过 `@deepseek-ai/dsh-mcp-client` 支持 **streamable-http** 的 MCP 服务；
dsh-link 的 `POST /mcp` 就是这样一个端点。**每个 DSH 机器只需配置一条**指向本机的记录 ——
远端节点用 `peer` 参数按名字访问，由本机节点用它保存的 token 去投递。

### 配置

在 profile 的插件配置里加（`$DSH_HOME/profiles/<profile>/...` 或 DSH 设置界面的插件配置）：

```yaml
- id: mcp-dshlink
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dshlink          # 工具名会变成 mcp__dshlink__<tool>
    transport: streamable-http
    url: http://127.0.0.1:8787/mcp
    # 0.5 起默认不信任回环，每个请求都要 token。
    # 让安装器写入：dshlink install-dsh --write --token <admin-token>
    headers:
      authorization: !!js '`Bearer ${process.env.DSHLINK_TOKEN}`'
    toolCallTimeoutMs: 120000
```

改完配置后 DSH 会重连该 MCP 服务；`tools/list` 里立即出现 17 个工具（含 `link_dsh_*` 与 `link_call`）。

> **0.5 认证**：`auth.trustLocalhost` 默认 `false`，MCP 请求必须带 token。先运行
> `dshlink harden --write`（关闭回环信任并铸 `mcp-admin` / `bridge` 两个 token），再运行
> `dshlink install-dsh --write --token <admin-token> [--bridge --bridge-token <bridge-token>]`，
> 安装器会把 `headers.authorization`（MCP）和 `token`（bridge）写进 patch。token 角色：
> MCP/CLI 用 `admin`；bridge 插件用 `bridge`；对端用 `peer`；手机只读用 `device`。
> 详见 [`../SECURITY.md`](../SECURITY.md) 与 [`PROTOCOL.md`](PROTOCOL.md#roles-and-route-access-v05)。

### 工具清单（原生名 `mcp__dshlink__<name>`）

| 工具 | 用途 |
|---|---|
| `link_status` | 本机身份、URL、共享根、邮箱计数、对端状态（`probe: true` 探活） |
| `link_peers` | 对端列表与可达性 |
| `link_send_message` | 给对端发消息；`peer`、`subject`、`body`、`thread`、`replyTo`、`targetSession`、`originSession`、`attachments` |
| `link_inbox` | 读收件箱（`unreadOnly`、`limit`、`since`、`thread`、`peer`、`markRead`） |
| `link_read_message` | 读单条全文并标已读 |
| `link_reply` | 在同一 thread 里回复；`targetSession` 默认取原消息的 `originSession`（回复自动回到发起对话） |
| `link_sync` | 主动拉取对端为“我”暂存的消息（对端离线期间发的） |
| `link_flush` | 重投本地队列 |
| `link_list_files` / `link_stat_file` | 列目录 / 看单个文件（`peer: "self"` 表示本机） |
| `link_pull_file` | 从对端拉文件到本机 inbox 目录（或指定本地根） |
| `link_push_file` | 把本地根内的文件推给允许上传的对端 |
| `link_dsh_workspaces` | 列本机/对端 DSH 的全部工作区（0.3，需目标节点开 `dsh.enabled`） |
| `link_dsh_sessions` | 列全部对话（标题、cwd、最后活动、是否归档） |
| `link_dsh_transcript` | 读任意一条对话的消息（人/助手/推理/工具调用）；带 `sinceSeq` 只取游标之后的新消息 |
| `link_call` | 走「能力通道」在本机或对端执行 DSH 动作：`workspaces.list`/`sessions.list`/`sessions.read`（读）、`sessions.create`/`sessions.prompt`/`sessions.rename`/`sessions.archive`（需显式授权）、`bridge.status` |
| `link_help` | 给模型的使用说明 |

### 典型 agent 流程

1. `link_status` → 知道自己叫什么、共享了哪些根、有哪些 peer。
2. `link_inbox {unreadOnly:true}` → 看有没有别的机器发来的话。
3. `link_pull_file {peer:"bob-pc", root:"ws", path:"reports/2026-09.md"}` → 拉文件。
4. `link_send_message {peer:"bob-pc", subject:"已收到", body:"..."}` → 回话（对端离线会排队）。
5. `link_dsh_workspaces {peer:"bob-pc"}` → `link_dsh_sessions` → `link_dsh_transcript`：不打开对方界面
   也能看对方在哪个工作区、有哪些对话、聊了什么。
6. `link_call {peer:"bob-pc", method:"sessions.prompt", params:{sessionId, text, mode:"steer"}}`：把一句话
   投进对方的某条对话（对端必须显式授权 `sessions.prompt`）。`mode` 可选：`queue`（默认，追加回合）
   或 `steer`（插话，在目标会话的下一步边界注入）。

### 对应的 CLI（不开 MCP 也能用）

```powershell
dshlink dsh workspaces  [--peer P]                    # 工作区清单
dshlink dsh sessions    [--peer P] [--workspace W] [--archived] [--query Q]
dshlink dsh transcript  <sessionId> [--peer P] [--tail] [--limit N] [--since-seq N]
dshlink dsh capabilities [--peer P]                   # 对端能力清单 + bridge 心跳
dshlink dsh call        <method> [--peer P] [--params json] [--wait N]
dshlink dsh result      <commandId>                   # 补取异步命令结果
dshlink dsh bridge                                    # 本机 bridge 心跳 + 命令队列
dshlink dsh enable [--actions m1,m2] [--write]         # 打开 DSH 视图（与动作白名单）
```

### 一键安装 / 卸载

```powershell
node bin\dshlink.mjs harden --write                          # 0.5: 关 trustLocalhost，铸 admin/bridge token
node bin\dshlink.mjs install-dsh --profile web                 # 预览（默认不写）
node bin\dshlink.mjs install-dsh --profile web --write --token <admin-token>   # 写入 patch + 技能 + MCP token
node bin\dshlink.mjs install-dsh --profile web --write --token <admin-token> --bridge --bridge-workspace D:\dshlink-bridge --bridge-token <bridge-token>
# 回滚：恢复备份并删掉技能目录
Copy-Item 'D:\DSH\profiles\web\cordis.patch.yml.bak-<时间戳>' 'D:\DSH\profiles\web\cordis.patch.yml' -Force
Remove-Item -Recurse -Force 'D:\DSH\skills\dshlink'
```

安装器会：校验生成的 YAML 能被 DSH 自带的 `yaml` 解析、写入前自动备份、检测
`@deepseek-ai/dsh-mcp-client` 是否可从该 profile 解析、并把 `integrations/dsh-skill` 复制到
`$DSH_HOME/skills/dshlink`。重复执行是幂等的（URL 或 token 变化时更新对应条目）。

## 方式 2：技能 + CLI（agent 用 pwsh 调命令行）

把技能复制进技能库，DSH 会在需要时加载：

```powershell
Copy-Item -Recurse -Force .\integrations\dsh-skill "$env:DSH_HOME\skills\dshlink"
```

（`$DSH_HOME` 默认是 `D:\DSH`；技能目录 = `$DSH_HOME/skills/<name>/SKILL.md`。）

技能内容让 agent 优先用 `--json` 输出、把消息当“异步邮件”、拉文件前先 `ls`。

## 方式 3：让 DSH 自己起节点（无需常驻进程）

不想常驻 `serve` 时，把 dsh-link 当纯 CLI 用即可：`send`/`inbox`/`pull`/`push` 都只读写
本地 JSONL 与对端 HTTP，`serve` 只在对端要主动投递/拉取**我**的文件时需要。

## 方式 4：自动唤醒（dsh-link-bridge，收到消息自动开对话）

方式 1 让 agent **能**用工具，但**不会自己知道**有消息。`integrations/dsh-link-bridge/` 是 DSH Host 插件，
把最后一环补上：轮询本机节点 → 有未读消息 → 复用/创建指定工作区里的对话 → 投一条带消息正文的 prompt。

```powershell
# 1) 装插件包（本地目录用 link:，改代码即时生效）
dsh plugin --profile web add "link:D:\dsh-link\integrations\dsh-link-bridge"
# 2) 写 patch 条目并激活（自动备份 profile patch + YAML 校验）
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write --token <admin-token> --bridge-token <bridge-token>
# 3) 重启一次 host（新插件条目在启动时装载）
dsh web
# 0.5 注意：bridge 需要 role=bridge 的 token，否则 /api/v1/bridge/* 返回 403 bridge_forbidden
```

也可以直接跑 `integrations/dsh-link-bridge/install-bridge.ps1 -Workspace D:\dshlink-bridge`（1+2 一步）。
关键配置：`workspacePath`（必填，不存在会自动创建）、`sessionId`（留空=自动创建并记住）、
`promptMode`（0.4：`auto` | `queue` | `steer`）、`pollSeconds`、`cooldownSeconds`、`nodeUrl`、`token`、`prompt`（模板）。

自检：`$DSH_HOME/plugin-data/dsh-link-bridge/state.json` 的 mtime 一直在动 = 插件在工作；
里面的 `watermark` 是已唤醒到哪条消息，`sessionId` 是正在用的对话，`lastError` 记录最近的失败。

注意：唤醒意味着"另一台机器发来的请求会让本机 agent 动手"，请确保对端 token 可信、
这个桥的定位是**多人协作与多终端插件同步**：唤醒的是普通共享对话，人随时可以进去接手；
桥只负责把消息送进对话，不做决策、不代替人批准。

它不会拉起任何窗口（纯 host 插件，只发 HTTP）。但它依附于 DSH host：host 停桥就停——
示例里的 host 由托盘程序启动，托盘退出等于 DSH 整体下线。
另外它依赖本机 dsh-link 节点在跑（否则 `state.json` 是 `ECONNREFUSED`）；
节点由计划任务 `dshlink-node` 承载，本机另注册了 `dshlink-node-autostart`（登录触发）以便重启后自动恢复。

## 定向会话：让两端的指定对话直接对话（0.4）

0.3 的桥只会把对端消息投进桥自己的 `workspacePath`；你在普通工作区里和人对话时，对端的回复
到不了你说话的那条会话。0.4 在信封上加了两个可选字段：

* `targetSession` — 这条消息要投进**对端**哪条 DSH 会话；
* `originSession` — 这条消息来自**本机**哪条会话（供对方回信时原路返回）。

用法（agent 侧）：

```jsonc
// 1. 先看对端有哪些会话（需对端开 dsh.enabled / exposeWorkspaces）
{ "name": "link_dsh_sessions", "arguments": { "peer": "bob-pc", "workspace": "D:\\proj" } }
// 2. 直接投进选中的会话
{ "name": "link_send_message", "arguments": {
    "peer": "bob-pc", "subject": "构建失败", "body": "…",
    "targetSession": "session-5f0c…" } }
// 3. 对端 link_reply 会自动把 targetSession 指回你的 originSession；之后双方继续 link_reply 即可
```

CLI 等价物：`dshlink send --to P --target-session session-… --thread msg_…`、`dshlink bind --thread msg_… --session session-…`。

桥侧行为：收到带 `targetSession` 的消息时，若 `targets` 策略放行，就直接 prompt 那条会话（不新建
桥会话），并把 thread → 会话记进绑定和路由；被拒或会话已死则回落到原来的路由/话题池，并把原因
写进 prompt。策略在 patch 里收紧：

```yaml
targets:
  enabled: true
  peers: ["LAPTOP-*"]        # 只允许这些对端定向投递（空=任意已配置 peer）
  allow: ["session-5f0c*"]   # 只允许这些本机会话（空=任意）
  deny: []                   # 永远优先于 allow
```

唤醒方式：direct/route 投递默认用 DSH 的 `mode: "steer"`（插话，插到目标会话下一步边界），topic 批量用
`mode: "queue"`（排队）；桥配置 `promptMode` 可强制统一。对端若还是 0.3，字段会被原样存下但忽略（回落话题池）；
本机 0.3 收到 0.4 的字段也不会报错。完整设计、兼容矩阵与失败模式见
[`DIRECTED-SESSIONS.md`](DIRECTED-SESSIONS.md)。

## 排错

| 现象 | 处理 |
|---|---|
| DSH 里没有 `mcp__dshlink__*` 工具 | 确认 `dshlink serve` 在跑：`Invoke-RestMethod http://127.0.0.1:8787/healthz` |
| 工具调用返回 401 | 0.5 默认关闭 `trustLocalhost`，必须配 header token；用 `dshlink harden --write` + `dshlink install-dsh --token <admin-token>`，或 `dshlink token new --role admin` 后手动写入 |
| bridge 报 403 `bridge_forbidden` | bridge 需要 `role: bridge` 的 token：`dshlink token new --role bridge`，把它写进桥配置 `token`（或 `install-dsh --bridge-token`） |
| `link_send_message` 说 queued | 对端不可达：检查 `peers ping`、token、URL/FRP 隧道；恢复后 `link_flush` |
| 拉文件 `forbidden` | 路径越出共享根，或命中拒绝清单（`.env`/`*.key`/`.ssh` …） |
| 推文件 403 | 对端未开启 `files.allowUpload`，或目标根是只读 |
