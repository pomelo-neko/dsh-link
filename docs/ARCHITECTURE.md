# 架构：dsh-link 由哪些部分组成

> **状态（2026-11-04，0.8.0）**：中心服务器（hub）拓扑已在 **0.8.0 实现**：独立 hub 进程、一次性 enroll
> token 自动接入、节点心跳/重连与 DSH Web GUI 面板、hub 持久队列与补发、不保留点对点回退、文件经 hub
> 代理、会话运行状态透出。`hub.enabled` 默认关闭，未接入 hub 的节点行为与 0.7 点对点一致。
> 设计全文、决策与安全分析见 [HUB-TOPOLOGY-DESIGN.md](HUB-TOPOLOGY-DESIGN.md)；控制台见
> [HUB-CONSOLE.md](HUB-CONSOLE.md)。下文组件表里标“设计稿/计划”的条目以 0.8.0 代码为准。

一句话：**中心服务器（hub）是全网唯一的路由与手机入口；每台 DSH 机器上仍是一个节点（node）+ 一个
Host 插件（bridge），节点只与 hub 通信，真正把消息/命令落进 DSH 会话的永远是本机 bridge。**

```
                    手机 App（hub device token）
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ hub（中心服务器进程，默认 127.0.0.1:8790）                      │
   │  ├─ 入口 API：token 鉴权（无 trustLocalhost）                   │
   │  ├─ Registry：登记表（自动接入 enroll token；可选静态白名单）     │
   │  ├─ Router：to（目标 DSH）+ targetSession（目标会话）            │
   │  ├─ Queue：outbox.jsonl + 重试 + 心跳补发 + TTL（持久）          │
   │  ├─ Proxy：/api/v1/dsh/*、/dsh/call、/files/* → 目标节点        │
   │  └─ FRP 管理：生成 hub provider + 每节点 visitor，热重载          │
   └───────────┬───────────────────────────────┬──────────────────┘
               │ 下行（hub→节点，peer token）    │ 上行（节点→hub，peer token）
               ▼                               ▲
   ┌───────────────────────────┐   ┌───────────────────────────┐
   │ DSH 节点 A（本机 :8787）    │   │ DSH 节点 B（远端 :8787）    │
   │  ├─ /api/v1/*  本地 API    │   │  ├─ /api/v1/*              │
   │  ├─ /mcp       MCP 端点    │   │  ├─ /mcp                   │
   │  ├─ DSH view（读磁盘）      │   │  ├─ DSH view               │
   │  ├─ capability 命令队列     │   │  ├─ capability 命令队列     │
   │  ├─ hub 上行/心跳/重连      │   │  ├─ hub 上行/心跳/重连      │
   │  └─ /ui/hub 本地管理页      │   │  └─ /ui/hub 本地管理页      │
   └─────────────┬─────────────┘   └─────────────┬─────────────┘
                 │ 本机回环 + token               │
                 ▼                               ▼
   ┌───────────────────────────┐   ┌───────────────────────────┐
   │ DSH Host A                │   │ DSH Host B                │
   │  └─ dsh-link-bridge 插件   │   │  └─ dsh-link-bridge 插件   │
   │       ├─ 未读消息→注入会话 │   │       ├─ 未读消息→注入会话 │
   │       ├─ 定向 targetSession│   │       ├─ 定向 targetSession│
   │       └─ 命令队列→驱动DSH  │   │       └─ 命令队列→驱动DSH  │
   └───────────────────────────┘   └───────────────────────────┘
```

## 组件

| 组件 | 位置 | 版本 | 作用 |
|---|---|---|---|
| **hub / 中心服务器** | 新增 `src/hub.mjs`、`dshlink hub` | 0.8.0（设计稿） | 全网入口：token 网关、登记表与自动接入、消息路由与持久队列、DSH view/能力/文件代理、FRP 管理、审计 |
| 节点 / CLI | `bin/dshlink.mjs`、`src/*.mjs` | `package.json` | 消息、文件、隧道、配对、DSH 只读视图、能力通道；新增 hub 上行、心跳、重连 |
| MCP 端点 | 节点内 `src/mcp.mjs`（`http://127.0.0.1:<port>/mcp`） | 随节点 | `link_*` 工具；agent 通过它发消息/读件/回复 |
| 桥插件 | `integrations/dsh-link-bridge/` | 自己的 `package.json` | DSH Host 插件：未读消息唤醒会话、定向/话题路由、能力通道执行；新增 hub 状态/重连工具、`sessions.list` 输出 `running` |
| token gateway（旧） | `src/gateway.mjs`，默认 8788 | 0.7 | 0.7 节点侧 token 反代；hub 入口取代，过渡期保留（文档标记 deprecated） |
| 技能 | `integrations/dsh-skill/SKILL.md` | — | 教 agent 用 CLI；同步要求“大文件默认不发”与 hub 说明 |
| 手机 App | `android/` | 0.4.0（计划） | 只连 hub：节点选择、读工作区/会话/transcript、steer 发送、工具折叠、hub 连接状态 |

**组件可以各自升级**，排障第一步仍是确认版本：`dshlink --version`、hub `/api/v1/info`、
节点 `/api/v1/status`、`integrations/dsh-link-bridge/package.json`。

## 0.8 目标拓扑中的消息路径

### DSH ↔ DSH（多轮定向）

1. A 的 agent 调 MCP `link_send_message`（可带 `targetSession`）；
2. 节点 A 把信封**上传到 hub**：`POST /api/v1/messages`（Bearer = A 的 hub 上行 token）；
3. hub 校验 token 绑定的节点名与 `from.name` 一致、`to` 在登记表内，持久化到 outbox；
4. hub 经自己一侧的 FRP visitor 调目标节点 B 的 `POST /api/v1/messages`（Bearer = hub 在 B 的 token）；
5. B 节点 inbox 落盘；B 的 bridge 轮询未读，按 `targetSession`/thread 绑定唤醒指定会话并注入 prompt；
6. B 的 agent `link_reply` → 节点 B 上传 hub → hub 路由回 A → A 的 bridge 命中绑定投回原会话；
7. 循环即多轮定向对话，两端都不需要配置对方 peer。

**没有点对点回退（Q5）**：hub 模式下节点忽略 `peers`，`relay.enabled` 不再用于跨机中继；
`acceptMessage` 收到 `to ≠ self` 的中继请求返回 403 `relay_through_hub`。回退只能降级版本。

### 手机控制

1. App 连 hub（LAN 直连或内置 frpc visitor → `dshlink-hub` provider → 8790），带 hub 签发的 device token；
2. 读：`GET /api/v1/dsh/workspaces|sessions|transcript?peer=<节点>` → hub 代理到目标节点（lazy，不缓存正文）；
3. 写：`POST /api/v1/dsh/call` `{peer, method:"sessions.prompt", params, waitSeconds}` → hub 校验角色/方法白名单 →
   目标节点 `/api/v1/dsh/call` → 目标节点命令队列 → **目标 bridge 插件执行 prompt**；
4. “下发到插件”的落点永远在目标机器：hub 不驱动任何 DSH Host。

### 可靠性（Q4）

hub 用 JSONL 存储持久化待下发消息；目标离线时保持 pending，后台按 `retrySeconds` 退避重试，
超过 `messageTtlSeconds` 标记 expired；节点每 30s 心跳，90s 无心跳标记 offline；
节点重连或收到心跳时 hub **立即补发**该节点 pending 队列；目标节点按消息 id 去重，语义为 at-least-once。

### 节点自动接入（Q3）

1. hub 管理员签发 `role=enroll` 一次性 token（TTL 默认 1 天、可绑定期望节点名、默认单次使用）；
2. 新节点执行 `dshlink hub enroll --url <hub> --token <enroll-token>`；
3. 节点先 `GET /api/v1/info` 拿到 hub 名，本地签发一个 `role=peer` 的“hub 下行 token”，
   连同节点名/nodeId/版本/provider 信息 `POST /api/v1/hub/enroll`；
4. hub 校验 enroll token（一次性、未过期、名字匹配、限流、maxNodes）→ 自动登记 → 分配 visitor 端口（19110+）→
   写自己的 frpc 配置并热重载 → 返回节点→hub 上行 token（只返回一次）；
5. 节点保存 token、发心跳、完成入网；撤销由 hub 管理端删除节点并吊销双向 token。
**不是开放注册**：无有效 enroll token 的请求在鉴权阶段被拒；enroll 角色只能访问 `/info` 与 `/enroll`。

### 文件传输（Q7）

文件不再 peer 直连，统一经 hub 流式代理：

- pull：节点 A → hub `GET /api/v1/files/download?peer=B&root=&path=` → hub 转发 B 节点同名端点 → 流式透传；
- push：节点 A → hub `POST /api/v1/files/upload?peer=B` → hub 流式转发 B 节点上传端点；
- hub 不落盘、不缓存正文；目标节点 FileRoots（共享根/只读/deny）是最终权限边界；
- hub 上文件 API 仅 admin/peer；`hub.files.maxBytes` 默认 256 MiB，并发/超时限额；
- 配套 skill：**大文件（默认 > 5 MiB）除非用户明确要求，否则不主动发送**；消息内联附件仍 ≤ 512 KiB。

### Session 运行状态（Q10）

- 保留按节点读取全部会话/transcript（hub 代理 `/dsh/*`）；不提供跨节点内容搜索，hub 不缓存正文。
- 新增 `GET /api/v1/hub/sessions/running`：只聚合各节点 `sessions.list` 的 `running` 布尔
  与 lastActivity，不返回消息内容；bridge 未启用/能力未放行时该节点标 `unknown`。

## 当前 0.7 点对点拓扑（运行中的行为）

- 每台机器一个节点进程，节点之间用静态 `peers` 表 + 每对一条 FRP 链路直连；
- 消息：发送节点直接调对端 `POST /api/v1/messages`，离线走本地 outbox + `flush/sync`；
- 手机：连任意入口节点，用 `peer` 参数单跳转发（二跳只读）；节点侧 8788 token gateway 强制鉴权；
- 新拓扑与 0.7 的对应关系：节点 API、消息信封、定向语义、bridge、能力队列、DSH view **全部复用**；
  变化集中在“节点之间怎么走”（改经 hub）、“手机连谁”（改连 hub）、“文件怎么走”（改经 hub）。

## 磁盘上的状态

| 文件 | 位置 | 内容 |
|---|---|---|
| `hub.config.json` + `outbox.jsonl` / `state.json` / `audit.jsonl` | hub dataDir（计划 `C:/Users/<you>/.dshlink-hub`） | hub 身份、token、登记表（自动接入写入）、待下发消息、投递状态、enrollment 使用记录、审计 |
| `frp/frpc.toml` | hub dataDir | hub 管理的 frpc：provider `dshlink-hub` + 每节点 visitor（自动生成） |
| `dshlink.config.json` | 节点 `<dataDir>`（默认 `~/.dshlink`） | 身份、监听、token 哈希、共享根、`hub` 上行段、隧道、`dsh`、`capabilities` |
| `inbox.jsonl` / `outbox.jsonl` | 节点 `<dataDir>` | 收到的 / 待投递的消息，含投递与已读状态 |
| `state.json` | 节点 `<dataDir>` | 已读标记、投递状态、去重 id 映射（CLI 与节点共享） |
| `audit.jsonl` | 节点 `<dataDir>` | 文件访问、投递、鉴权拒绝审计 |
| `state.json` | `<DSH_HOME>/plugin-data/dsh-link-bridge/` | **桥**的心跳与水位：`ticks`、`watermarkTs/Id`、`notified`、`errors`、`pool`、`routes`、`directed`、`commands`、新增 `hub` 状态段 |

> hub 的 `outbox.jsonl`、节点的 `outbox.jsonl`、桥的 `state.json` 是三个不同文件，排障不要看错。

## 唤醒链路（bridge，0.8 不变）

```
目标节点 inbox 未读 ──► bridge pollSeconds 轮询 ──► 选会话/定向目标 ──► 注入 prompt
                                                                       │
   markRead ◄── link_reply（经 hub 路由） ◄── agent 处理（MCP 工具） ◄──┘
```

水位仍是 `(watermarkTs, watermarkId)` 元组；定向消息按 `targetSession` 直接唤醒目标会话，
被拒/不存在时回退话题池并写入 `{{targetNote}}`（0.4 既有行为）。

## 能力通道（0.8：hub 代理，执行端不变）

```
手机/控制端 ──► hub /api/v1/dsh/call ──► 目标节点 /api/v1/dsh/call（hub 角色校验 + 节点能力策略）
                                              │
                                              ▼ <dataDir>/commands/*.json
                                     目标 bridge 轮询 claim → 调 DSH Host RPC → 写回 result
```

策略仍是两层：hub 级方法白名单（device/peer）+ 目标节点 `capabilities.enabled/methods/peers`
（hub 在目标节点眼里是一个具名 peer，可按 `peers["dshlink-hub"]` 单独 allow/deny）。

## DSH 只读视图（0.8：hub 代理，读取端不变）

目标节点**直接读磁盘**（`storages/workspace.json` + `sessions/**/session.*.jsonl*`），不经过 DSH 进程；
hub 不做本地 DSH view，只按 `peer` 参数代理到目标节点，因此中心机器不需要装 DSH。转录正文仍由目标节点
`exposeTranscripts` 控制；hub 不缓存正文。

## 重连、心跳与手动重连（Q4）

| 项 | 设计 |
|---|---|
| 节点链路状态 | `connecting / online / degraded / offline`；退避 5s→60s |
| 心跳 | 节点每 30s `POST /api/v1/hub/heartbeat`；hub 90s 无心跳标 offline |
| 补发 | hub 收到该节点消息/心跳/重连时立即尝试 pending 队列，不等周期重试 |
| 手动重连 | CLI `dshlink hub status|reconnect`；节点本地 GUI `GET /ui/hub`（仅回环/bridge token）；bridge MCP 工具 `link_hub_status`/`link_hub_reconnect` |
| 可观测 | hub `/api/v1/hub/status`（队列/节点/错误）、节点 `/api/v1/hub/status`、bridge `state.json.hub` |
| hub 重启 | 读 outbox 继续；登记表从配置恢复；节点自动重连 |

## 安全边界（保留 0.7 设计并强化）

| 边界 | 机制 |
|---|---|
| 手机 → hub | 必须带 hub 签发的 device token；hub 无 `trustLocalhost`（FRP 流量源地址恒 127.0.0.1） |
| 节点 → hub | 每节点独立 peer token，绑定节点名；hub 校验信封 `from.name` |
| hub → 节点 | 每节点独立 peer token（另一套，互不复用）；目标节点 capabilities 可单独收紧 |
| 自动接入 | 一次性 `enroll` token（TTL≤1 天、可绑定期望名、默认单次、限流、maxNodes、审计）；**不做无 token 开放注册**；可切 manual 人工审批 |
| 角色矩阵 | admin / bridge / peer / device / enroll；`/mcp` 与 `/api/v1/bridge/*` 在 hub 上不存在 |
| 回环控制面 | 节点 `/api/v1/bridge/*` 仍仅回环，bridge 与节点之间的边界不变 |
| FRP | 只当通道；STCP secret 不等于 API 权限；API 权限永远由 token 决定；hub 管理自己的 frpc |
| 文件 | 只经 hub 流式代理；hub 不落盘；目标节点 FileRoots 是最终权限边界；上限/并发/审计 |
| 审计 | hub 路由/接入/文件/拒绝/重试审计 + 节点原有 audit；不记录 token 明文、不记录文件内容 |

## 判据速查

| 想确认 | 看什么 |
|---|---|
| hub 活着 | `GET <hub>/healthz`（无 token 只回 @@BT@{ok:true}`）、`GET <hub>/api/v1/hub/status`（admin） |
| hub 能否到某节点 | `/api/v1/hub/status` 的 `nodes[].reachable/latencyMs` |
| 节点是否在线 | hub status 的 `nodes[].status`（online/offline）与 `lastSeenAt` |
| 节点链路状态/重连 | 节点 `/api/v1/hub/status`、`/ui/hub`、bridge `state.json.hub` |
| 消息卡在 hub | `/api/v1/hub/status` 的 `queue.pending`、`/api/v1/hub/outbox`（admin） |
| hub 收到/拒绝过什么 | hub `audit.jsonl`（401/403/unknown_target/enrollment_denied 等） |
| 自动接入是否成功 | `/api/v1/hub/nodes` 的节点条目、`audit.jsonl` 的 `hub_enroll` |
| 文件是否走 hub | hub `audit.jsonl` 的文件条目；目标节点 audit 的文件访问 |
| Session 是否在运行 | `GET /api/v1/hub/sessions/running`（仅运行状态，无正文） |
| 节点活着（当前 0.7） | `dshlink status --json`、`/api/v1/status` 的 `runtime.configReloads` |
| 桥在工作 | `plugin-data/dsh-link-bridge/state.json` 的 mtime 在动、`errors: 0` |
| 唤醒真的发生过 | state 的 `notified` 增长（累计**消息条数**，不是唤醒次数） |
| 定向是否命中 | bridge state 的 `directed`/`routed`/`lastDirected`（0.4+） |
| 手机能控谁 | hub `/api/v1/network/nodes` 的节点列表（新拓扑无二跳限制） |
