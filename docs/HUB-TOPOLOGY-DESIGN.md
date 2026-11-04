# 中心服务器（hub）拓扑设计

> 状态：**设计稿 v2**（2026-11-04，目标版本 0.8.0）。已按用户 2026-11-04 的决策更新：
> Q3 自动审批（一次性接入令牌）、Q4 持久缓存 + 节点重连 + 手动重连 GUI、Q5 不保留点对点回退、
> Q7 文件经 hub 代理、Q10 不提供全局内容搜索（仅可看 Session 是否在运行）；其余采用推荐值。
> **代码尚未实现**，当前运行 0.7.0 点对点拓扑。
>
> 2026-11-04 追加拍板（m06440）：**N2 = 插件 GUI 集成进现有 dsh-link-bridge 插件、显示在 DSH Web GUI**
> （不单独做节点页）；**N3 = 大文件阈值 10 MiB**；**N4 = enroll token 默认 TTL 2 小时**；N1/N5/N6 按建议值。
>
> 相关文档：[ARCHITECTURE.md](ARCHITECTURE.md)、[GATEWAY.md](GATEWAY.md)、[PROTOCOL.md](PROTOCOL.md)、
> [DIRECTED-SESSIONS.md](DIRECTED-SESSIONS.md)、[mobile/CONTROL-APP.md](mobile/CONTROL-APP.md)。

## 0. 摘要

- 在本机（DESKTOP-NODE-A）新增独立进程 **「dshlink hub」**（默认 127.0.0.1:8790，独立配置/数据目录），
  作为全网**唯一**的 DSH 互通路由与**唯一**手机入口。
- 节点之间**不再保留点对点消息通道**：所有跨节点操作（消息、DSH 读取、能力调用、文件）统一经 hub。
- 跨 DSH 消息：发送方节点 → hub `POST /api/v1/messages` → hub 识别目标 DSH（`to`）与目标 Session
  （`targetSession`）→ 目标节点 inbox → 目标 bridge 插件注入会话。回复原路反向，多轮成立。
- 手机只连 hub：LAN 直连或内置 frpc visitor → `dshlink-hub` provider；读/写全部经 hub 代理。
- **自动接入**：hub 管理员签发一次性、短期、可绑定节点名的 **enroll token**；新节点执行
  `dshlink hub enroll` 自动完成注册、双向 token 交换、FRP visitor 生成（hub 管理自己的 frpc），
  无需手工编辑 hub 配置。
- **可靠性**：hub 持久 outbox；目标离线时消息留在缓存，节点定期重连/心跳，恢复后 hub 立即补发；
  节点与 bridge 都提供手动重连入口。
- **安全设计保留并强化**：token 角色矩阵、peer token 绑定身份、无 trustLocalhost、hub 不暴露
  `/mcp` 与 `/api/v1/bridge/*`、能力白名单、审计、限流、静态能力边界。自动审批**不等于开放注册**。

## 1. 背景与目标

### 1.1 当前 0.7 点对点拓扑

```
   A 机节点 8787 ◄────── HTTP + token (peer) ──────► B 机节点 8787
      ▲  ▲                                              ▲  ▲
      │  └── (STCP provider/visitor，每对 peer 各一条) ──┘  │
      │                                                    │
   A 的 bridge / agent                              B 的 bridge / agent
```

| 能力 | 现状 | 位置 |
|---|---|---|
| 节点 HTTP API | 8787，`/api/v1/*` + `/mcp` + `/api/v1/bridge/*` | `src/server.mjs` |
| 节点鉴权 | token 角色 + 回环信任（0.5 起默认 false） | `src/server.mjs:106-110`、`src/config.mjs:123-135` |
| peer 表 | 静态 `peers[]`（名字/URL 或 STCP/token） | `src/config.mjs:197-260` |
| 消息投递 | 节点直接调对端 `/api/v1/messages`，或 `sync` 拉取 | `src/ops.mjs:113-145`、`:334-350` |
| 文件传输 | 节点直接 pull/push 对端（roots 策略在目标节点） | `src/ops.mjs:275-331`、`src/server.mjs:294-356` |
| 跨机拓扑发现 | 递归问 peer，depth=2、maxNodes=20 | `src/network.mjs:6-17`、`:269-279` |
| 手机控制 | 连一个入口节点，`peer` 参数单跳转发 | `src/ops.mjs:394-532` |
| 节点 token 网关 | 8788 强制 token 反代 8787，device 白名单 | `src/gateway.mjs` |

### 1.2 0.7 拓扑的局限

1. **配置 O(N²)**：每台 DSH 都要配置其余所有 peer；每台还要为每个 peer 维护 FRP visitor 与 secret。
2. **手机只能连一个入口节点**：入口节点单跳转发，二跳节点只能看不能控。
3. **可靠性分散**：每个发送节点自己维护 outbox/pending，离线状态散落在各机器，没有全局视图。
4. **入站面随节点数增长**：每台机器都要对 peer 暴露 API + provider。
5. **权限签发分散**：手机 device token 由入口节点签发，换入口就要换 token。
6. **多轮对话可观测性差**：一条对话跨越两台机器，只能在两边 audit 里拼。
7. **文件传输多通道**：文件直连对端，与消息通道分离，管理/审计/权限难以统一（用户 Q7 明确要统一）。

### 1.3 用户要求与已确认决策

> 原文（m06326）：更换拓扑结构。在本机部署一个中心服务器，frp 仍然作为通道穿透，不同 dsh 之间的交流通路统一为
> “上传到中心服务器-中心服务器识别需要下发的目标 dsh 和目标 session-下发信息到插件-插件执行发送任务等”。
> 手机控制端通过直连中心服务器的方式进行控制，可以直接向中心服务器上传对应控制信息（和 dsh 互相交流路线一致）。
> 同步更新 docs/ARCHITECTURE.md。保留当前拓扑结构的安全设计。

| 编号 | 需求/决策 | 设计落点 |
|---|---|---|
| R1 | 本机部署中心服务器 | §2.3、§6.6 独立进程 `dshlink hub`，本机常驻 |
| R2 | FRP 仍是穿透通道 | §2.3、§6.4 hub 管理自己的 frpc：发布 provider + 每节点 visitor |
| R3 | DSH↔DSH 统一走中心 | §3.1 节点无点对点消息通道 |
| R4 | 中心识别目标 DSH 与 Session | §5.5 `to` + `targetSession` 路由 |
| R5 | 下发到插件、插件执行 | §3.1/§3.2 目标节点 inbox/命令队列 → 目标 bridge |
| R6 | 手机直连中心、同一条路 | §3.2/§3.3 手机只连 hub |
| R7 | 保留现有安全设计 | §7 全量映射 + 强化 |
| R8 | 同步 ARCHITECTURE.md | 已重写 |
| **Q3** | **自动审批接入**（避免每加节点改配置）+ 评估公网审批入口攻击风险 | §3.6、§4-D5、§7.3：一次性 enroll token + 自动审批 + 限流/审计/名字唯一；**不做无令牌开放注册** |
| **Q4** | hub 持久缓存；节点定期重连 hub；插件 GUI 手动重连（**N2：DSH Web GUI**）；hub 收到节点消息/心跳后再次下发；离线目标进缓存等待上线 | §3.5、§6.5、§7：outbox 持久化 + heartbeat + 立即补发 + 重连退避 + GUI/CLI/MCP 重连入口 |
| **Q5** | **不保留点对点回退** | §4-D11：hub 模式下 peer 消息/中继/文件直连全部停用；回退只能降级版本 |
| **Q7** | **文件经 hub 代理**；保留 peer 路径会导致信道过多；改 skill 要求大文件默认不发（**N3：10 MiB**）；后续可接其他传输 | §3.7、§4-D8、§5.4/§5.6、§6：hub 流式文件代理；skill 默认阈值 10 MiB；预留 transport 适配 |
| **Q10** | 不提供全局内容搜索；全局监控仅限 Session 是否在运行 | §3.8、§4-D13、§5.4：保留按节点会话列表/转录；hub 只聚合 `running` 布尔，不索引正文 |
| Q1/Q2/Q6/Q8/Q9 | 采用推荐值：独立进程；hub 只绑回环 + FRP；device token 默认全节点 + 可选白名单；本机 DSH 作为普通节点注册；端口 8790/18790/19110+ | §4、§6 |

### 1.4 设计原则

1. **中心只做路由/排队/代理/鉴权，不做 DSH 逻辑**：hub 不读 DSH 磁盘、不跑 agent、不执行 prompt；
   DSH 相关执行永远落在目标机器的 bridge 插件。
2. **复用现有协议与代码**：消息信封、targetSession/originSession、能力命令队列、DSH view、
   token 体系、bridge 全部沿用；新增 hub 层与文件代理。
3. **静态信任 + 人工发 token**：参与者相互认识、权限管理靠人；自动审批只自动化“注册动作”，
   令牌仍由人签发。
4. **单信道**：hub 是节点间唯一通路；不允许旁路（无 peer 回退、无文件直连、无节点间 MCP 直连）。
5. **默认安全、最小暴露**：hub 默认只绑回环并只通过 FRP；入口全部 token；`/mcp` 与 bridge 控制面永不上 hub。
6. **可运维**：队列、节点在线状态、重连、审计都有明确观测点；节点可手动重连。

## 2. 新拓扑总览

### 2.1 逻辑架构

```
                         ┌──────────────────────────────────────────────────┐
                         │                 Hub（中心服务器）                  │
                         │  dshlink hub @ 127.0.0.1:8790                     │
                         │                                                  │
   手机 App ──HTTP/token─►│  ├─ 入口 API（token 网关，永不 trustLocalhost）     │
   (device token)        │  ├─ Registry  节点登记表（自动接入 + 白名单）        │
                         │  ├─ Router    to(目标DSH) + targetSession 路由      │
                         │  ├─ Queue     outbox.jsonl + 重试/心跳补发（持久）   │
                         │  ├─ Proxy     /dsh/*、/dsh/call、/files/* → 目标节点 │
                         │  ├─ FRP 管理  生成 hub provider + 每节点 visitor     │
                         │  └─ Audit     路由/投递/接入/拒绝审计                │
                         └───────┬───────────────────────────────┬──────────┘
                                 │ 下行（hub→节点，peer token）    │ 上行（节点→hub，peer token）
                                 ▼                               ▲
                    ┌────────────────────────┐      ┌────────────────────────┐
                    │ DSH 节点 B（LAPTOP）    │      │ DSH 节点 A（DESKTOP）   │
                    │  node 8787             │      │  node 8787             │
                    │  ├─ inbox/outbox       │      │  ├─ inbox/outbox       │
                    │  ├─ DSH view（读磁盘）  │      │  ├─ DSH view           │
                    │  ├─ capability 命令队列 │      │  └─ capability 命令队列 │
                    │  ├─ hub 上行/心跳/重连  │      │  ├─ hub 上行/心跳/重连  │
                    │  └─ bridge 插件 ────────┼──────┼─► bridge 插件          │
                    │        └─► 指定 Session │      │        └─► 指定 Session │
                    └────────────────────────┘      └────────────────────────┘
```

要点：

- **一个中心、多条支线**：hub 与每个 DSH 节点之间只有一条逻辑链路（上行 token + 下行 token），
  节点之间没有任何直连路径。
- **hub 不执行 DSH**：消息/命令进入目标节点后，仍由目标机器的 bridge 插件执行。
- **手机与 DSH 消息同路径**：手机控制请求与 DSH 上行消息都走 hub token 入口，只是端点/角色不同。
- **hub 管理 FRP**：hub 进程根据登记表生成自己的 frpc 配置（provider `dshlink-hub` + 每节点 visitor），
  自动接入时无需手工编辑 hub 的 FRP 文件；节点侧由 `tunnel sync` 自动生成 provider 与到 hub 的 visitor。
- 兼容说明：FRP 管理可关闭（`hub.frp.enabled=false`），此时退化为静态登记 + 手工 visitor（见 §6.4）。

### 2.2 组件职责

| 组件 | 位置 | 版本 | 新拓扑职责 |
|---|---|---|---|
| **Hub / CLI** | 新增 `src/hub.mjs`、`dshlink hub` 子命令 | 0.8.0 | 入口、token 网关、节点注册/自动接入、消息路由与持久队列、DSH/文件代理、FRP 管理、审计 |
| **DSH 节点** | `src/*.mjs`、`bin/dshlink.mjs` | 0.8.0 | 本机 API 不变；新增 hub 上行、心跳、重连、hub 代理路由；hub 模式下停用 peer 直连/中继 |
| **Bridge 插件** | `integrations/dsh-link-bridge/` | 0.8.0 | 仍是唯一执行者；新增 hub 状态透出、手动重连入口；`sessions.list` 输出 `running`；**N2：client half 在 DSH Web GUI 的 Settings 页渲染 hub 状态/重连按钮** |
| **手机 App** | `android/` | 0.4.0 | 只连 hub；节点选择=hub 登记表；控制/读取走 hub；隧道模板指向 hub provider |
| **FRP** | 外部 frps + hub 管理的 frpc + 节点 frpc | 不变 | 纯通道：hub 发布 provider；节点/手机 visitor 接入；hub 为每个节点生成 visitor |

### 2.3 部署与 FRP 穿透

```
                              ┌───────────────────────────┐
                              │ frps（公网，TLS）           │
                              └──▲───────▲───────────▲────┘
        provider dshlink-hub     │       │ provider  │ provider
        (localPort 8790)         │       │ dshlink-  │ dshlink-*
                                 │       │ laptop    │ (每台 DSH 一个)
                 visitor to-hub  │       │           │
        ┌────────────────────────┴──┐ ┌──┴───────────────────────┐
        │ DESKTOP（hub 所在机器）     │ │ LAPTOP（DSH 节点）         │
        │  dshlink hub 127.0.0.1:8790│ │  node 8787                │
        │  node 8787（本机 DSH）      │ │  bridge 插件               │
        │  hub-managed frpc:         │ │  frpc:                    │
        │   provider dshlink-hub→8790│ │   provider dshlink-laptop │
        │   visitor to-laptop        │ │     → 8787                │
        │     → 127.0.0.1:19110      │ │   visitor to-hub          │
        └────────────────────────────┘ │     → 127.0.0.1:18790     │
                                       └───────────────────────────┘
   手机 App：内置 frpc visitor to-hub → frps → provider dshlink-hub → 8790
              URL = http://127.0.0.1:18790（隧道模式）或 LAN http://<hub-LAN-IP>:8790
              无论哪种方式都必须带 hub device token
```

链路约定：

| 链路 | 谁发起 | FRP 角色 | 用途 |
|---|---|---|---|
| 节点 → hub | 节点 frpc | visitor `to-hub` | 节点上行消息、心跳、enroll、文件/DSH 请求的结果 |
| hub → 节点 | hub 管理的 frpc | visitor `to-<node>`（自动生成，端口从 19110 起分配） | hub 投递消息、调用目标节点 `/dsh/*`、`/dsh/call`、`/files/*` |
| 手机 → hub | 手机内置 frpc | visitor `to-hub` | 手机控制/读取 |
| hub 自身入口 | hub 管理的 frpc | provider `dshlink-hub` → 8790 | 所有 visitor 的落点 |

- 自动接入时，hub 根据节点上报的 provider 信息（serverName + secretKey）追加 visitor 并热重载自己的 frpc；
  节点侧 `tunnel sync` 检测到 `hub.enabled` 后，除原有 provider 外自动追加到 hub 的 visitor（端口 18790）。
- FRP secret 只代表“能进隧道”，API 权限完全由 token 决定（与 0.7 结论一致）。

### 2.4 与 0.7 的对照

| 维度 | 0.7（当前运行） | 新拓扑 |
|---|---|---|
| 节点互通 | 静态 peer 两两直连 | 全部经 hub，节点无直连通道 |
| peer 配置 | 每台 N-1 条 | 取消；节点只有 hub 上行配置 |
| 手机入口 | 任意节点（单跳转发） | 只有 hub |
| 手机可控范围 | 入口节点直连 peer，二跳只读 | hub 登记表内全部 DSH |
| 新节点加入 | 每台机器改 peer + 发 token + FRP | 一枚 enroll token + `dshlink hub enroll` 自动完成（hub 侧 FRP 自动生成） |
| 消息可靠性 | 各发送节点自管 outbox | hub 统一持久队列 + 心跳补发 |
| 文件传输 | 节点间直接 pull/push | hub 流式代理，统一鉴权/审计/限额 |
| 权限签发 | 各入口节点自签 device token | hub 统一签发 |
| 审计 | 各节点 audit | hub 路由/接入审计 + 节点原有 audit |
| 回退 | — | 无点对点回退；只能版本降级（迁移期 hub.enabled=false） |
| 兼容 | — | 旧节点/旧 APK/8788 gateway 在 0.8 部署前保留；hub 模式启用后不再使用 |

## 3. 数据流

### 3.1 DSH ↔ DSH 定向消息（多轮协作）

```
① A 的 agent 调 MCP link_send_message({peer:"B", targetSession:"session-S_B", thread, body})
        │
        ▼
② 节点 A sendMessage → buildMessage（保留 targetSession/originSession/thread/replyTo）
        │  hub.enabled=true：deliver 不再直连 peer，改为：
        ▼
③ POST <hub>/api/v1/messages   （Bearer = A 的 hub 上行 token, role=peer, peer=A）
        │
        ▼
④ hub：鉴权（token.peer === envelope.from.name）→ 校验 to=B 已注册 → 持久化 outbox → 立即下发
        ▼
⑤ hub → B 节点（经 hub 管理的 visitor，Bearer = 节点 B 签发给 hub 的 peer token）
   POST /api/v1/messages，信封原样（含 targetSession）
        ▼
⑥ B 节点 acceptMessage → inbox.jsonl → 返回 delivered（重复 id 幂等）
        ▼
⑦ B 的 bridge tick 发现未读定向消息 → 按 targetSession 唤醒/复用 session-S_B → 注入 prompt
   （线程绑定 thread→session-S_B，0.4 既有逻辑）
        ▼
⑧ B 的 agent 调 link_reply → 节点 B sendMessage（to=A, thread 保持, targetSession 默认 originSession）
        │  同样走 hub 上行 → hub 路由回 A 节点 → A bridge 命中绑定 → session-S_A
        ▼
⑨ 循环 ①-⑧ = 多轮定向对话；两端不需要配置对方 peer。
```

- hub 不解析/不改写消息体，只校验身份与目标并原样转发。
- 目标识别两段：`to` 定位 DSH，`targetSession` 定位会话；会话是否存在由目标节点/bridge 判定。
- 节点 A 本地 outbox 仍记录 `delivery.state`（hub 已持久化即视为 accepted），hub 侧队列负责最终送达。

### 3.2 手机控制 DSH（发 prompt）

```
手机 App ── POST <hub>/api/v1/dsh/call ──► hub（Bearer=device token）
   body: {peer:"B", method:"sessions.prompt",
          params:{sessionId:"session-S_B", text:"...", mode:"queue"|"steer"},
          waitSeconds:30}
        │
        ▼ hub：device 角色 → 节点白名单（可选）→ hub 方法白名单
        │      → 转发 B 节点 POST /api/v1/dsh/call（Bearer = hub 在 B 的 peer token）
        ▼
B 节点 capabilities.authorizeCall → 写入 <B dataDir>/commands/*.json
        ▼
B 的 bridge 插件 claim → 在 DSH Host 内执行 sessions.prompt → 写回 result
        ▼
hub 等待（≤waitSeconds）→ {status:"done", result} 或 {status:"pending", commandId}
手机：done 显示结果；pending 显示“已提交 · 由 B 处理”，可后续查询
```

“下发到插件”的落点：hub 从不直接驱动 DSH Host；命令进入目标节点的命令队列，
目标机器上的 bridge 插件是执行者。

### 3.3 手机读取（工作区 / 会话 / transcript）

```
GET <hub>/api/v1/dsh/workspaces?peer=B
GET <hub>/api/v1/dsh/sessions?peer=B&workspace=...
GET <hub>/api/v1/dsh/sessions/:id/transcript?peer=B&sinceSeq=...
        ▼
hub：device token → 查登记表 → 转发到 B 节点同名路径（带 hub peer token）
        ▼
B 节点读磁盘 DSH view（不经过 DSH 进程）→ 原样返回
```

- 读取是 lazy 的：hub 不缓存 transcript 正文，只缓存节点可达性/版本。
- 无 `peer` 的请求默认落到 `hub.defaultNode`（兼容旧 App 首连）；App 0.4.0 显式带 `peer`。

### 3.4 会话管理（create / rename / archive）

与 §3.2 相同：`POST /api/v1/dsh/call` + `peer`。授权两层：
hub 角色/方法/节点白名单；目标节点 `capabilities.enabled/methods/peers[hub].allow/deny`。

### 3.5 离线队列、心跳与重连（Q4）

```
节点启动/断线恢复：
  ├─ 连接状态 connecting → 每 5s 重试，退避到 60s；成功后 hub 标记 online
  ├─ 心跳：每 30s POST <hub>/api/v1/hub/heartbeat（Bearer=节点上行 token）
  └─ 手动重连：CLI / 节点本地 GUI / bridge MCP 工具 → 立即重试并上传心跳

hub 收到节点消息或心跳时：
  ├─ 若该节点有待下发队列 → 立即尝试补发（不等周期重试）
  └─ 更新 lastSeenAt；超过 90s 无心跳 → 标记 offline，队列继续保留

消息投递：
  ├─ 目标 online：立即下发 → delivered
  ├─ 目标 offline/失败：outbox pending，按 retrySeconds 退避重试
  └─ 超过 messageTtlSeconds（默认 7 天）→ expired + 审计告警
```

- 语义：**at-least-once**；目标节点按消息 id 去重。
- hub 重启后读取 outbox 继续；节点重启后自动重连并补发本地未上传成功的 outbox。
- 节点侧 outbox 只在“hub 返回接受”后标记 delivered；hub 不可达时保持 pending 并重试（auto-sync）。
- 状态可见：hub `/api/v1/hub/status` 的 queue/nodes；节点 `/api/v1/hub/status`（本地）与 GUI。

### 3.6 节点自动接入（enrollment，Q3）

```
① 管理员在 hub 上签发一次性接入令牌：
   dshlink token new --config hub.config.json --role enroll --label laptop           --ttl-hours 2 --peer LAPTOP-PEER-B        # peer = 期望的节点名（可选绑定）；TTL 默认 2h
        │  把令牌通过安全渠道交给新节点操作者
        ▼
② 新节点执行（一次性）：
   dshlink hub enroll --url http://127.0.0.1:18790 --token <enroll-token>
        │
        ├─ GET <hub>/api/v1/info（enroll 角色允许）拿到 hub 名字/版本
        ├─ 本地生成一个 role=peer、peer=<hub 名> 的 token（供 hub 下行调用本节点）
        ├─ 读取本机 tunnel provider 信息（serverName + secretKey）
        └─ POST <hub>/api/v1/hub/enroll
              body: {name, nodeId, softwareVersion,
                     provider:{serverName, secretKey},
                     hubToken:<本机生成的下行 token 明文>}
        ▼
③ hub 校验 enroll token（一次性、未过期、名字匹配、maxNodes、速率限制）
        ├─ 自动审批：写入 nodes[]（active）、分配 visitor 端口（19110+）、
        │   写 hub 的 frpc 配置、热重载 frpc
        └─ 返回 {hub:{name,version}, token:<节点→hub 上行 token>, node:{name}}
        ▼
④ 节点保存返回的上行 token（加密/哈希落盘）、标记 enrolled、写 hub 状态
        ▼
⑤ 节点 heartbeat → hub 确认可达 → 正式加入网络；
   撤销：hub 管理端 DELETE /api/v1/hub/nodes/:name → 移除 visitor + 吊销上行 token
```

- 两种模式：`hub.enrollment.mode="token"`（默认，自动审批）与 `"manual"`（管理员审批后才激活）。
- **不是开放注册**：没有有效 enroll token 的请求在鉴权阶段就被拒；enroll 角色除了 `/api/v1/info`
  与 `/api/v1/hub/enroll` 不能访问任何其它端点。
- hub 的 FRP 管理可关闭：`hub.frp.enabled=false` 时 enroll 仍自动登记节点，但返回
  `downlinkUrlRequired:true`，由管理员手工加 visitor 并补 `nodes[].url`（静态模式，见 §6.4）。

### 3.7 文件传输（hub 代理，Q7）

```
pull（从远端节点拉文件）：
  node A MCP/CLI link_pull_file(peer=B, root, path)
    → 节点 A（hub 模式）请求 hub：GET <hub>/api/v1/files/download?peer=B&root=...&path=...
    → hub：peer token 鉴权 → 查登记表 → 转发 B 节点 GET /api/v1/files/download
    → B 节点 FileRoots 校验（共享根/只读/deny 名单）→ 流式字节
    → hub 流式透传（Range/长度/哈希头保留）→ 节点 A 落盘 → sha256 校验
push（推文件到远端节点）：
  node A → hub POST /api/v1/files/upload?peer=B&root=...&path=...
    → hub 流式接收 → 转发 B 节点 POST /api/v1/files/upload（Bearer=hub 在 B 的 token）
    → B 节点 FileRoots 写策略校验 → 落盘 → 返回结果
```

- hub 只做流式代理，不落盘文件、不缓存正文；目标节点的共享根/只读/deny 策略是最终权限边界。
- 鉴权：hub 上文件 API 仅 admin/peer（保持 0.7 文件角色；device 不开放文件）。
- 限额：`hub.files.maxBytes`（默认 256 MiB）、`hub.files.maxConcurrent`、请求超时；超限 413。
- 默认不主动发送大文件：**超过 10 MiB（N3）的文件，除非用户明确要求，agent/skill 不主动经 hub 传输**；
  消息内联附件仍保持 512 KiB 上限。大型文件优先提示用户改用外部/离线通道。
- 审计：hub 记录 peer/root/path/size/hash/sha256 结果与耗时，不记录文件内容。
- 未来替代：`hub.files.transport` 预留 `external` 适配（对象存储/局域网直传），本期只实现 `hub`。

### 3.8 Session 运行状态（Q10）

- **保留**：按节点读取工作区/会话列表/transcript（hub 代理）与 0.7 完全一致，手机仍能看到该节点全部会话。
- **不提供**：跨节点内容搜索/全文索引；hub 不缓存 transcript。
- **新增（仅运行状态）**：hub `GET /api/v1/hub/sessions/running` 聚合各节点
  `sessions.list`（bridge 能力通道）中的 `running` 布尔与 lastActivity；来源不可用时标 `unknown`。
  不提供消息内容、不提供搜索。
- bridge 的 `sessions.list` 输出增加 `running`（DSH `SessionListEntry` 本就提供该字段）。

## 4. 关键设计决策

### D1：hub 是独立进程
独立 port/dataDir/token；重启 hub 不影响各机 DSH；故障域隔离。备选（并入节点）不选。

### D2：下行用“hub 调节点”（hub 管理 visitor），不做节点长轮询
复用节点 API/DSH view/能力通道/文件 API；同步请求低延迟；节点无需新增长轮询协议。
代价：hub 侧为每节点生成 visitor（由 hub 自动生成，见 D5/D6）。备选 H2（节点长轮询 hub 领任务）列为后续演进。

### D3：消息信封不改
沿用 0.4 信封；hub 只路由。bridge 的定向/回复/去重/水位全部复用。

### D4：hub 持久队列 + 心跳补发（at-least-once）
hub 落盘 outbox；目标离线进缓存；节点心跳/重连触发立即补发；TTL 过期审计。

### D5：自动接入 = 一次性 enroll token + 自动审批（不是开放注册）
- 管理员签发 `role=enroll` token：默认一次性、**TTL 2 小时（N4）**、可绑定期望节点名、可限 maxNodes。
- 新节点用 `dshlink hub enroll` 交给 hub；hub 鉴权后自动登记、交换双向 token、生成 FRP visitor。
- 安全评估见 §7.3；高安全场景可切 `enrollment.mode="manual"` 人工审批。
- 备选“完全开放注册”（任何人可 POST enroll）**明确不做**。

### D6：FRP 双链路，hub 管理自己的 frpc
hub 进程生成并维护自己的 frpc 配置（provider `dshlink-hub` + 每节点 visitor），热重载；
节点侧 `tunnel sync` 生成 provider + 到 hub 的 visitor；手机侧内置 visitor。frps 不动。
`hub.frp.enabled=false` 时退回手工 visitor（静态模式）。

### D7：手机只连 hub
统一入口/token/可观测；可控节点=登记表全集；与 DSH 消息同一 HTTP 路径。旧 8788 gateway 仅迁移期保留。

### D8：文件经 hub 流式代理（不再 peer 直连）
统一鉴权/审计/限额；hub 不落盘；目标节点 FileRoots 是最终权限边界。
配套：`integrations/dsh-skill/SKILL.md` 明确“**>10 MiB（N3）的文件除非用户明确要求，默认不发送**”；
消息内联附件保持 512 KiB 上限；后续可接外部传输适配。

### D9：中心不跑 DSH、不读 DSH 磁盘
只代理；本机 DSH 由本机节点注册为普通节点。

### D10：token 体系复用
沿用角色/哈希/吊销/TTL；新增 `enroll` 角色（只用于接入）。节点→hub 与 hub→节点是两套 token，
分别签发/吊销，单向泄露不影响反向。

### D11：不保留点对点回退（Q5）
hub 模式启用后：
- 节点不再使用 `peers` 发消息/同步/文件/DSH 调用；
- `acceptMessage` 收到 `to ≠ self` 的中继请求 → 403 `relay_through_hub`；
- `relay.enabled` 在 hub 模式下无意义；
- 配置不再提供 `fallbackPeers`；迁移期只能通过降级版本回退（不是运行时开关）。

### D12：节点重连与手动重连入口（Q4）
- 节点维护 hub 链路状态机：`connecting/online/degraded/offline`；指数退避 5s→60s。
- 心跳 30s；hub 90s 无心跳标记 offline；恢复后立即补发。
- 手动重连入口：
  1) CLI `dshlink hub status|reconnect`；
  2) DSH Web GUI 插件（N2）：dsh-link-bridge 的 client half 在 Settings → dsh-link 显示 hub 状态、最后错误、待发队列，并提供「重新连接」按钮；
  3) bridge 插件 MCP 工具 `link_hub_status` / `link_hub_reconnect`（走节点回环控制面）；
  4) bridge state.json 增加 `hub` 段（状态/最后心跳/最后错误），供运维排查。
  5) 节点本地 `GET /ui/hub` 作为无 DSH Web GUI 时的备选（仅回环/bridge token）。

### D13：全局监控仅 Session 运行状态（Q10）
不做全文搜索/跨节点内容监控；仅聚合 `running`。见 §3.8。

### 4.9 备选：节点长轮询 hub（H2）
节点不再发布 provider、不暴露入站 API，通过长轮询/长连接领任务；优点是零入站、NAT 友好；
缺点是新增连接协议/请求复用/文件流/背压，节点侧改动大。本期不选，保留为阶段 6 演进。

## 5. Hub API 设计

### 5.1 通用约定
- 前缀 `/api/v1/*`；JSON；认证 `Authorization: Bearer` / `X-DSHLink-Token`。
- 所有端点（除 `/healthz` 匿名、enroll 端点用 enroll token）都必须有效 token。
- **无 trustLocalhost 选项**：FRP 隧道源地址恒 127.0.0.1，所有请求必须 token。
- 节点身份：role=peer 的 token 绑定 `peer`；hub 校验消息 `from.name === token.peer`。
- 请求体上限默认 2 MiB（文件流代理例外，用流式上限）；错误 JSON 统一。
- 幂等：消息按 `id`；enroll 按 `nodeId`+`name`。

### 5.2 角色矩阵

| 端点 | admin | peer（DSH 节点） | device（手机） | enroll（接入中） | 匿名 |
|---|---|---|---|---|---|
| `GET /healthz` | ✓ | ✓ | ✓ | ✓ | ✓（只回 {ok:true}） |
| `GET /api/v1/info` | ✓ | ✓ | ✓ | ✓（限名字/版本） | ✗ |
| `GET /api/v1/network/nodes` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `GET /api/v1/dsh/*` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `POST /api/v1/dsh/call` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `GET /api/v1/dsh/call/:id` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `POST /api/v1/messages` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `GET /api/v1/files/*` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `POST /api/v1/files/upload` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `POST /api/v1/hub/enroll` | ✗ | ✗ | ✗ | ✓（单次） | ✗ |
| `POST /api/v1/hub/heartbeat` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `POST /api/v1/hub/reconnect` | ✓ | ✓ | ✗ | ✗ | ✗（节点侧端点） |
| `GET /api/v1/hub/status` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `GET /api/v1/hub/nodes` / DELETE node | ✓ | ✗ | ✗ | ✗ | ✗ |
| `GET /api/v1/hub/outbox` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `GET /api/v1/hub/sessions/running` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `/mcp`、`/api/v1/bridge/*` | ✗ | ✗ | ✗ | ✗ | ✗（不存在） |

### 5.3 端点清单

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/healthz` | 存活探测（匿名只回 ok，不含版本） |
| GET | `/api/v1/info` | hub 身份/版本/能力（App 连接校验） |
| GET | `/api/v1/network/nodes` | 登记表节点 + 可达性（不返回 URL/token） |
| GET | `/api/v1/dsh/workspaces|sessions|sessions/:id|transcript?peer=` | 代理目标节点 DSH view |
| GET | `/api/v1/dsh/capabilities?peer=` | 代理能力信息 |
| POST | `/api/v1/dsh/call` | 能力调用（body.peer 定目标） |
| GET | `/api/v1/dsh/call/:id?peer=` | 查询远端命令结果 |
| POST | `/api/v1/messages` | DSH 上行消息 |
| GET/POST | `/api/v1/files[/stat|/hash|/download|/upload]?peer=` | 文件流式代理 |
| POST | `/api/v1/hub/enroll` | 节点自动接入（enroll token） |
| POST | `/api/v1/hub/heartbeat` | 节点心跳/在线注册 |
| GET | `/api/v1/hub/status` | 队列/节点/连接/错误（admin） |
| GET | `/api/v1/hub/nodes` | 登记表详情（admin，脱敏） |
| DELETE | `/api/v1/hub/nodes/:name` | 移除节点 + 吊销 token + 删 visitor（admin） |
| GET | `/api/v1/hub/outbox` | 待下发队列（admin，诊断/分页） |
| GET | `/api/v1/hub/sessions/running` | 聚合 Session 运行状态（不返回正文） |
| GET/POST | `/api/v1/hub/tokens`；DELETE `/api/v1/hub/tokens/:id` | 接入令牌管理（admin；明文只在创建时返回一次） |
| GET | `/api/v1/hub/config` | 当前设置 + 控制台 URL（admin，脱敏） |
| PATCH | `/api/v1/hub/settings` | 修改白名单设置（admin，立即生效并写回配置） |
| POST | `/api/v1/hub/flush`；POST/DELETE `/api/v1/hub/outbox/:id[/retry]` | 缓存区重投/丢弃（admin） |
| GET | `/ui`（匿名）；`/` → 302 `/ui` | hub 自带 Web 控制台（单页，登录后同源调上面的 admin API） |
| GET | `/api/v1/audit` | 最近审计（admin） |
| POST | `/ui/hub/...` / `/api/v1/hub/reconnect`（节点侧） | 节点本地 GUI/手动重连（非 hub 端点） |

不提供：`/mcp`、`/api/v1/bridge/*`、`/api/v1/peers`、节点间直连端点。

### 5.4 关键端点详细

#### GET /api/v1/info
```
{
  "name": "dshlink-hub", "nodeId": "hub_01...", "version": "0.8.0",
  "softwareVersion": "0.8.0",
  "hub": { "name": "dshlink-hub", "nodes": 2, "defaultNode": "DESKTOP-NODE-A",
           "enrollment": { "mode": "token", "autoApprove": true } },
  "dsh": { "enabled": true, "workspaces": true, "transcripts": true },
  "capabilities": { "enabled": true, "methods": ["sessions.prompt"] }
}
```

#### POST /api/v1/hub/enroll
请求（Bearer = enroll token）：
```
{
  "name": "LAPTOP-PEER-B",
  "nodeId": "node_01...",
  "softwareVersion": "0.8.0",
  "provider": { "serverName": "dshlink-laptop", "secretKey": "<节点 provider secret>" },
  "hubToken": "<节点签发给 hub 的下行 peer token 明文>",
  "downlinkUrl": null
}
```
成功：
```
{ "hub": { "name": "dshlink-hub", "version": "0.8.0" },
  "node": { "name": "LAPTOP-PEER-B", "status": "active",
            "downlinkUrl": "http://127.0.0.1:19110" },
  "token": "<节点→hub 的上行 peer token，仅返回一次>",
  "enrollment": { "id": "enr_...", "approvedAt": "..." } }
```
错误：`401 unauthorized`、`403 enrollment_denied`（token 被用完/名字不匹配）、
`409 node_exists`、`429 rate_limited`、`507 max_nodes`、`400 bad_request`。

#### POST /api/v1/hub/heartbeat
```
{ "node": "LAPTOP-PEER-B", "softwareVersion": "0.8.0",
  "uptimeSeconds": 123, "queue": { "pending": 0 }, "links": { "hub": "online" } }
→ { "ok": true, "serverTime": "...", "pendingDeliveries": 2, "flushed": 2 }
```
心跳还会触发 hub 对该节点 pending 队列的立即补发。

#### GET /api/v1/hub/status
```
{ "hub": { "name": "dshlink-hub", "version": "0.8.0", "startedAt": "..." },
  "nodes": [ { "name": "LAPTOP-PEER-B", "status": "online", "reachable": true,
               "latencyMs": 12, "lastSeenAt": "...", "lastError": null,
               "queue": { "pending": 0 } } ],
  "queue": { "pending": 0, "delivered": 128, "failed": 0, "expired": 0 },
  "enrollment": { "mode": "token", "active": 2, "maxNodes": 32 },
  "lastRoute": { "messageId": "...", "from": "...", "to": "...", "targetSession": "...", "at": "..." } }
```

#### GET /api/v1/hub/sessions/running
```
{
  "count": 3,
  "sessions": [
    { "peer": "LAPTOP-PEER-B", "sessionId": "session-...", "title": "...",
      "workspaceId": "workspace-...", "running": true, "updatedAt": "..." },
    { "peer": "DESKTOP-NODE-A", "sessionId": "session-...", "running": false,
      "updatedAt": "..." }
  ],
  "sources": { "LAPTOP-PEER-B": "capability", "DESKTOP-NODE-A": "capability" }
}
```
- 只返回运行状态元数据，不含消息正文；来源为节点能力通道 `sessions.list`（DSH 的 `SessionListEntry.running`）。
- bridge 未启用/能力未放行 → 该节点标 `"source":"unknown"`，不影响会话列表/转录读取。

#### 文件代理端点
- `GET /api/v1/files?peer=&root=&path=&limit=` → 目标节点目录列表
- `GET /api/v1/files/stat|hash?peer=&root=&path=`
- `GET /api/v1/files/download?peer=&root=&path=` → 流式字节，保留 Range/Content-Length/sha256 头
- `POST /api/v1/files/upload?peer=&root=&path=` → 流式转发到目标节点
- 目标节点返回的 403/404/413 原样映射；hub 审计记录字节数与结果。

### 5.5 路由算法
```
on POST /messages(record, auth):
  token = verifyToken(...)                       // 失败 401
  if token.role not in [admin, peer]: 403
  if token.role == peer and record.from.name != token.peer: 403 identity_mismatch
  if record.to not in registry: 404 unknown_target
  if record.to == record.from.name: 409 self_loop
  if already stored id: return duplicate
  store.append('outbox', record); setDelivery(pending)
  node = registry[record.to]
  if node.status != 'online' or not node.url:
      audit('hub_queued_offline'); return 200 {state:'pending'}
  try: client(node).deliverMessage(record); setDelivery(delivered)
  catch: setDelivery(pending,error); audit('hub_delivery_failed')
  return 200 {state:'delivered'|'pending'}
```
后台：每 retrySeconds 重试 pending；收到心跳/重连时立即补发该节点队列；超过 TTL 标记 expired。

### 5.6 enroll 流程与 FRP 自动生成
```
hub.enrollment:
  verify enroll token (role=enroll, expiresAt, used count)
  expected_name = token.peer; if expected_name and != name: 403 enrollment_denied
  if name/nodeId exists: 409 (或返回已有记录给幂等重试)
  if active nodes >= maxNodes: 507
  node = { name, nodeId, provider, hubTokenHash, status:'active', enrolledAt, lastSeenAt }
  allocate downlinkPort = frp.visitorPortBase + seq
  write hub frpc TOML: provider + visitor to-<node>
  reload frpc (admin /api/reload 或 restart)
  issue uplink token (role=peer, peer=name) — 只返回一次
  audit('hub_enroll', name, tokenId)
```

### 5.7 错误码
| code | HTTP | 场景 |
|---|---|---|
| unauthorized | 401 | 缺/无效/过期 token |
| role_forbidden | 403 | 角色不允许该端点/节点 |
| identity_mismatch | 403 | peer token 与 from.name 不符 |
| enrollment_denied | 403 | enroll token 无效/已用/名字不匹配/模式禁止 |
| node_exists | 409 | 节点名或 nodeId 已注册 |
| unknown_target | 404 | to/peer 不在登记表 |
| self_loop | 409 | to == from.name |
| method_not_allowed | 403 | hub 能力白名单未放行 |
| too_large / queue_full | 413 / 429 | 大小/队列超限 |
| rate_limited | 429 | enroll/heartbeat 速率限制 |
| max_nodes | 507 | 登记节点超上限 |
| upstream_unreachable / timeout | 502 / 504 | 目标节点不可达/超时 |
| relay_through_hub | 403 | 节点收到非本机消息且企图 peer 中继 |
| not_enrolled | 403 | 节点未完成 enroll 就调用 hub |
| internal_error | 500 | 未预期错误 |

### 5.8 与节点 API 兼容 / App 0.4.0
- App 0.3.0 不改也能连 hub（隧道 URL 改 18790、token 换 hub device token）；0.4.0 建议：
  1) 隧道模板 serverName `dshlink-phone` → `dshlink-hub`，URL 18788→18790；
  2) 文案“8788 网关”→“中心服务器”；
  3) 首连显式选中第一个节点并带 `peer` 拉工作区；
  4) 远端 pending 支持按 `peer` 轮询 `/dsh/call/:id?peer=`；
  5) 可选展示 Session running 标记与 hub 连接状态。

### 5.9 Web 控制台（0.8 实现补充）

用户要求（m06926）：hub 要能向人提供 enroll token 并做状态监控，还要能查看缓存区、管理其他 hub 设置。实现选择**hub 进程自带单页控制台**而不是独立 GUI 进程：

- 零依赖、零构建：一个 HTML 文件（\`src/hubui.mjs\` 的 \`HUB_UI_HTML\`）由 hub 直接服务，升级不引入前端工具链；
- 同源：页面只调 \`/api/v1/hub/*\`，不新增跨域面；
- 无秘密页面：\`/ui\` 是登录页，HTML 里没有令牌/数据，所有接口仍要 admin token（hub 从不 trustLocalhost）；
- 与 CLI 一致：页面上的每个按钮都是 CLI 已有端点的封装，没有隐藏写路径；每次写操作进 \`audit.jsonl\`。

页面分区（详见 [HUB-CONSOLE.md](HUB-CONSOLE.md)）：状态卡（在线节点/待投递/运行时长/STCP）+ 节点表（批准/移除）+ 接入令牌（生成/吊销，明文一次）+ 缓存区 outbox（重投/丢弃）+ 运行中会话聚合 + 设置表单（白名单键，dirty 保护）+ 审计最近 50 条。登录态存 \`localStorage\`（\`dshlink-hub-token\`），5s 轮询、\`document.hidden\` 暂停。

安全：CSP \`default-src 'self'; connect-src 'self'; frame-ancestors 'none'\`，favicon 用 data URI（避免 /favicon.ico 404），列表/配置接口不返回 hash、明文或 frp secretKey。

验证：\`test/hub.test.mjs\` 的 web console 测试覆盖页面/CSP/匿名 401/device 403/令牌一次性明文/配置脱敏/设置落盘/outbox 重投与丢弃；另用无头 Edge + CDP 对真实 hub 进程跑了 18 项端到端断言全通过（登录、生成 enroll token、enroll 假节点、造 pending、重投、丢弃（含 confirm 对话框）、修改设置、吊销令牌、审计、退出登录、零 JS 异常/零 console error/零失败资源），截图见 \`docs/images/hub-console.png\`。


## 6. 配置设计

### 6.1 Hub 配置（示例）
```
{
  "name": "dshlink-hub",
  "dataDir": "C:/Users/<you>/.dshlink-hub",
  "auth": { "trustLocalhost": false, "tokens": [] },
  "hub": {
    "enabled": true,
    "bind": "127.0.0.1",
    "port": 8790,
    "defaultNode": "DESKTOP-NODE-A",
    "retrySeconds": 15,
    "messageTtlSeconds": 604800,
    "maxPendingPerTarget": 500,
    "requestTimeoutMs": 15000,
    "heartbeatSeconds": 30,
    "offlineAfterSeconds": 90,
    "networkCacheSeconds": 10,
    "enrollment": {
      "enabled": true,
      "mode": "token",
      "autoApprove": true,
      "maxNodes": 32,
      "maxUsesPerToken": 1,
      "rateLimitPerMinute": 6
    },
    "files": { "enabled": true, "maxBytes": 268435456, "maxConcurrent": 4,
               "transport": "hub" },
    "frp": { "enabled": true, "frpcPath": null,
             "configPath": "<dataDir>/frp/frpc.toml", "adminPort": 7401,
             "visitorPortBase": 19110 },
    "provider": { "name": "dshlink-hub", "secretKey": null }
  },
  "nodes": [],
  "capabilities": { "enabled": true,
    "methods": ["sessions.list", "sessions.read", "sessions.prompt"] }
}
```
| 字段 | 说明 |
|---|---|
| `hub.defaultNode` | 无 peer 参数的默认节点 |
| `hub.enrollment` | 自动接入策略；`mode:"manual"` 时 enroll 后需管理员审批 |
| `hub.frp` | hub 管理自己的 frpc；`enabled:false` 退回静态模式（手工 visitor + nodes[].url） |
| `hub.files` | 文件代理开关/上限/并发/传输适配（`transport:"hub"`） |
| `hub.provider` | hub 入口 provider（名字/secret） |
| `nodes[]` | 静态登记（auto enroll 后写入；也可手工预置）；含 name/url/token 及元数据 |

### 6.2 DSH 节点配置新增段
```
"hub": {
  "enabled": true,
  "url": "http://127.0.0.1:18790",
  "token": "<hub 签发给本节点的上行 peer token>",
  "enrollment": {
    "token": "<一次性 enroll token，仅首次接入用>",
    "autoEnroll": true
  },
  "timeoutMs": 15000,
  "heartbeatSeconds": 30,
  "reconnect": { "minSeconds": 5, "maxSeconds": 60 },
  "peersIgnored": true
}
```
- `enabled=false` 默认：行为与 0.7 完全一致（迁移期）。
- `enabled=true`：消息/DSH/能力/文件全部经 hub；`peers` 忽略（日志警告）；`acceptMessage` 对非本机消息拒绝中继。
- `enrollment.token` 首次运行后被清除/标记已用；`hub.token` 由 enroll 返回后写入。

### 6.3 token 规划
| token | 签发处 | role | peer 绑定 | 用途 |
|---|---|---|---|---|
| hub enroll token | hub | `enroll` | 期望节点名（可选） | 一次性接入 |
| hub device token | hub | `device` | —（可选 nodes 白名单） | 手机 |
| hub admin token | hub | `admin` | — | 运维/队列/审计 |
| 节点 A 上行 token | hub（enroll 时签发） | `peer` | `A` | 节点 A → hub |
| 节点 A 下行 token | 节点 A（enroll 时本机签发） | `peer` | `dshlink-hub` | hub → 节点 A |
| 节点 B 同上 | hub / B | `peer` | `B` / `dshlink-hub` | 双向 |

方向隔离：上行 token 泄露不能调用节点本地 API；下行 token 泄露不能向 hub 上传消息；可分别吊销。

### 6.4 FRP 配置与两种模式
**自动模式（默认，hub.frp.enabled=true）**：hub 生成自己的 frpc 配置：
```
# hub provider（所有 visitor 的落点）
[[proxies]]
name = "dshlink-hub"
type = "stcp"
secretKey = "<hub-provider-secret>"
localIP = "127.0.0.1"
localPort = 8790

# 每个登记节点一条（enroll 时自动追加；端口从 19110 起分配）
[[visitors]]
name = "to-laptop"
type = "stcp"
serverName = "dshlink-laptop"
secretKey = "<laptop-provider-secret>"
bindAddr = "127.0.0.1"
bindPort = 19110
```
节点侧 `tunnel sync` 生成：
```
[[proxies]]
name = "dshlink-laptop"
type = "stcp"
secretKey = "<laptop-provider-secret>"
localIP = "127.0.0.1"
localPort = 8787

[[visitors]]
name = "to-hub"
type = "stcp"
serverName = "dshlink-hub"
secretKey = "<hub-provider-secret>"
bindAddr = "127.0.0.1"
bindPort = 18790
```
**静态模式（hub.frp.enabled=false）**：管理员手工维护 hub 的 frpc（provider + 每节点 visitor），
enroll 响应返回 `downlinkUrlRequired:true`，管理员把 visitor 端口写回 hub 配置 `nodes[].url`；
适合已有集中 FRP 管理的环境。

### 6.5 接入操作示例（一次性）
```
# hub 侧（管理员）
dshlink token new --config C:/Users/example/.dshlink-hub/hub.config.json   --role enroll --label laptop --ttl-days 1 --peer LAPTOP-PEER-B

# 新节点（操作者拿到一次性 token）
dshlink hub enroll --url http://127.0.0.1:18790 --token <enroll-token>
# 自动完成：登记、双向 token、FRP visitor、心跳；CLI 打印 hub 名/节点名/连接状态

# 验证
dshlink hub status
dshlink hub reconnect       # 手动重连（插件 GUI 同功能，见 §6.6）
```

### 6.6 启动、常驻与插件 GUI
- hub 启动：`node bin/dshlink.mjs hub --config <hub.config.json>`；Windows 计划任务常驻（同节点）。
- 健康检查：`/healthz`（匿名）、`/api/v1/info`（token）、`/api/v1/hub/status`（admin）。
- **DSH Web GUI 插件面板（N2，主入口）**：把 GUI 合进现有 `dsh-link-bridge` 插件，不单独做节点页。
  - host half（节点插件进程）新增 `GET /api/v1/hub/status` 与 `POST /api/v1/hub/reconnect` 到
    DSH webServer（同源 3080），仅回环可用/由 DSH 页面调用；host half 用节点配置里的 nodeUrl + token
    代理到节点回环控制面，浏览器永远看不到节点 token。
  - client half（`lib/client.js`，`dsh.client` 声明）通过 `ctx.slots.inject("settings.section")`
    在 **Settings → dsh-link** 渲染：hub URL、链路状态（connecting/online/degraded/offline）、
    最后心跳、最后错误、本地待发队列、待补发数，以及「重新连接」按钮（POST）。
  - 面板每 5s 轮询 status；页面不可见时暂停；重连后立即刷新。DSH 未启用/节点未配置 hub 时显示
    “hub 未启用（当前为 0.7 点对点模式）”，按钮禁用。
- bridge 插件：state.json 增加 `hub` 段；MCP 工具 `link_hub_status`/`link_hub_reconnect`
  供 agent 排查/手动重连（调用节点回环控制面）。
- 节点本地 `GET /ui/hub` 作为无 DSH Web GUI 时的备用页（仅回环/bridge token），与主面板同一数据源。
- 若 DSH Web GUI 版本不含 client 插件能力，桥插件仍能启动（client half 只是可选声明）。

## 7. 安全设计（保留并强化）

### 7.1 信任边界
| 边界 | 信任内容 | 机制 |
|---|---|---|
| 手机 → hub | 只信任 device token | hub 入口 verifyToken；无 trustLocalhost |
| 节点 → hub | 只信任 peer token 且绑定节点名 | 上行 token；enroll token 仅接入 |
| hub → 节点 | hub 是可信 broker | 每节点独立下行 token + capabilities.peers[hub] 策略 |
| 节点 ↔ 本地 bridge | 只回环 + bridge token | 0.7 原样 |
| FRP | 只当通道 | STCP secret + TLS；API 权限永远由 token 决定 |

### 7.2 保留项映射（0.7 → 0.8）
| 0.7 安全设计 | 0.8 实现 |
|---|---|
| TOKEN_ROLES / token 哈希 / TTL / 吊销 | 复用；新增 enroll 角色 |
| peer token 绑定 peer 名 | 上行 token 绑定节点名；hub 校验 from.name；下行 token 绑定 hub 名 |
| `/mcp`、`/api/v1/bridge/*` 不对外 | hub 不注册这些路由；节点侧仍 requireBridge |
| gateway 不回落 trustLocalhost | hub 无 trustLocalhost 选项 |
| capabilities 方法白名单 + peers allow/deny | hub 方法白名单 + 目标节点 capabilities 双重校验 |
| 静态 peer 白名单 | 静态 nodes 登记表 + enroll token 门槛 |
| 审计 | hub 路由/接入/文件/拒绝审计 + 节点原 audit |
| 限流/大小限制 | hub 入口限流；消息/文件/队列上限 |
| 文件根白名单/只读 | 目标节点 FileRoots 仍是最终权限边界；hub 只代理 |
| 客户端看不到 token | /info、/network/nodes、/hub/nodes 不返回 token |
| 回环信任 | hub 不信任；节点建议 trustLocalhost=false |

### 7.3 自动审批的安全分析（回答 Q3）
**结论：完全开放的自动审批（任何人可注册）会显著扩大攻击面，不能做；一次性 enroll token + 自动审批可行，但需要配套限制。**

完全开放注册的风险：
1. **伪造节点/消息注入**：攻击者注册为 peer 后可向任意已注册节点发定向消息，目标 DSH 会被唤醒并处理
   攻击者内容（提示注入/社工/诱导泄露）。
2. **数据外泄**：通过消息让目标 agent 回信（thread 回复自动带回），可套取会话内容/文件。
3. **资源耗尽**：伪造大量节点/心跳、塞满登记表与审计/磁盘，DoS hub 与下游节点。
4. **名字抢注/冒充**：抢注期望名字，使真实节点无法加入或消息被误导。
5. **能力调用**：若 hub 方法白名单包含只读 DSH 方法，注册节点可拉取 DSH 工作区/会话列表。
6. **审计污染/追踪困难**。

enroll token 方案的残余风险与缓解：
| 风险 | 缓解 |
|---|---|
| enroll token 被窃取（外带/截图） | 一次性、TTL 默认 2 小时（N4）、可绑定期望节点名、使用后立即失效；泄露可审计追溯；必要时切 manual 模式 |
| 公网扫描/暴力尝试 | token 为 32 字节随机；hub 限流（默认 6 次/分钟/token+全局）；失败审计与告警；FRP STCP secret 再加一层“能进隧道”门槛 |
| 恶意节点用合法 token 注册 | 名字/nodeId 唯一；maxNodes 上限；注册即审计；管理员可 DELETE 节点并吊销所有 token |
| 注册节点越权读 | enroll 角色只能 `/info` 与 `/hub/enroll`；注册后被登记为 peer，能力受目标节点 capabilities 与 hub 白名单双重限制 |
| 注册节点向会话注入消息 | 这是 peer 的正常能力；通过“谁发 token 谁负责”的人工信任模型 + 审计 + 可撤销控制；高安全部署可关 autoApprove 改人工审批 |
| hub FRP 配置被恶意节点污染 | visitor 只使用节点上报的 provider 信息；hub 只追加不能覆盖；写前校验名字/端口范围；配置变更审计 |
| token/secret 传输被监听 | FRP STCP 默认 useEncryption + TLS 到 frps；hub 入口可加 HTTPS（若直接暴露 LAN）；token 仅一次性明文出现在 enroll 请求 |
| 节点侧下行 token 泄露 | 只影响该节点；可单独重发（re-enroll）并吊销旧 token |

**建议默认**：`enrollment.mode="token" + autoApprove=true + maxUsesPerToken=1 + TTL=2 小时（N4） + 期望名字绑定`；
提供 `manual` 模式给高安全场景。**不提供“无 token 自动注册”开关**，避免误配置把中心变成开放注册点。

### 7.4 文件代理风险
- 路径穿越/越权：hub 只透传 `peer` 名字，真实 root/path 校验在目标节点 FileRoots（0.7 已有 deny/共享根策略）。
- SSRF：hub 只访问登记表内节点的 URL，绝不接受客户端传 URL。
- 大文件/慢连接：流式 + 上限 + 并发限制 + 超时；hub 不落盘，避免磁盘被写满。
- 审计：记录 peer/root/path/size/sha256/成败，不记录内容。
- 传输成本：公网转发昂贵 → skill 默认不主动发大文件；预留外部传输适配。

### 7.5 新增风险与缓解（汇总）
| 风险 | 缓解 |
|---|---|
| hub 单点 | 本地 DSH 不受影响；队列落盘；快速重启；状态可观测 |
| hub 被攻破 | 最小权限、仅回环+FRP、配置 ACL、token 轮换、审计告警；高风险场景 manual 审批 + device 节点白名单 |
| 节点冒充 | token 绑定 + from.name 校验 + enroll 期望名 |
| 重放 | 消息 id 幂等 + bridge requestId/水位 |
| 队列打爆 | maxPendingPerTarget / TTL / 429 / 巡检 |
| FRP 配置误连 | hub provider/secret + 上行 token 双重；启动自检 |
| GUI 暴露 | 仅回环/bridge token，不进 hub 路由，不开放公网 |

### 7.6 加固清单
1. hub 配置 ACL 仅当前用户可读（含节点下行 token/secret）。
2. hub 默认 bind 127.0.0.1；LAN 直连需显式配置 + 防火墙 + token。
3. 节点 trustLocalhost=false；hub 无此选项。
4. 目标节点对 `capabilities.peers["dshlink-hub"]` 收紧 allow。
5. device token 一人一 token + TTL + 可吊销；可选节点白名单。
6. enroll token 一次性、短期、绑定期望节点名；发放走安全渠道。
7. 定期轮换 hub/节点 FRP provider secret。
8. 监控 hub status/audit（401/403/enrollment_denied/queue failed/expired）。
9. 备份 hub.config.json + outbox.jsonl。
10. 不使用「无 token 自动注册」；manual 模式用于高安全部署。

## 8. 可用性与运维
| 场景 | 行为 |
|---|---|
| hub 挂 | 本地 DSH 正常；节点上行 pending 并重连；手机不可用 |
| 某节点挂 | hub 队列 pending；节点恢复/心跳后立即补发；hub status 可见 |
| hub 重启 | 读 outbox 继续；登记表从配置恢复；节点自动重连 |
| 重复消息 | 目标 inbox 按 id 去重；bridge requestId/水位防重复唤醒 |
| 配置热重载 | token/nodes/enrollment 策略热重载；端口/bind 需重启 |
| 观测 | hub /hub/status、audit.jsonl、节点 /hub/status + /ui/hub、bridge state.hub |

## 9. 迁移与实施计划

### 9.1 阶段表
| 阶段 | 内容 | 交付物 | 验收 | 估时 |
|---|---|---|---|---|
| 0 | 设计 v2（本轮） | 本文 + ARCHITECTURE 更新 | 用户审阅通过 | 本轮 |
| 1 | hub 核心 | `src/hub.mjs`、hub config、CLI `hub`、`test/hub.test.mjs` | 鉴权矩阵/路由/队列/心跳/审计单测；本机双测试节点 e2e | 4–5 人日 |
| 2 | 自动接入 + FRP 管理 | enroll token/角色、enroll 端点、hub frpc 生成与热重载、节点 `hub enroll` | 新节点加入无需改 hub 配置；撤销节点生效；安全用例（重放/名字冲突/限流） | 2–3 人日 |
| 3 | 节点单信道 + 重连 + 文件代理 | 节点 hub 路由（消息/DSH/能力/文件）、心跳/重连状态机、**DSH Web GUI 面板（N2）**/MCP/CLI、peer 直连停用、skill 更新 | A↔B 多轮定向；离线排队/重连补发；文件双向；旧 peer 路径拒绝；面板可重连 | 3–4 人日 |
| 4 | 手机 hub 模式 + 运行状态 | App 0.4.0、隧道模板、节点选择、hub 连接状态、running 标记 | 模拟器/真机：连 hub、切节点、读转录、steer 发送、重连 | 2–3 人日 |
| 5 | 文档/发布 | ARCHITECTURE/HUB/PROTOCOL/OPERATIONS/TROUBLESHOOTING/CHANGELOG、0.8.0、tag | 全量测试、部署核对、用户验收 | 1–2 人日 |
| 6（可选） | H2 长轮询、外部文件传输 | 按需 | — | 后续 |

合计约 **12–17 人日**（不含可选阶段）。

### 9.2 兼容性与回滚
- 0.8 节点 `hub.enabled` 默认 false：升级本身不改变行为。
- 一旦启用 hub 模式，**不提供运行时回退到 peer 直连**（Q5）；只能降级版本或临时把节点摘出 hub。
- 旧 APK/旧 8788 gateway 在 0.8 部署前保留；hub 上线并验证后再切换手机 URL/token。
- 0.7 端点在 hub.enabled=false 期间继续工作；hub 模式启用后 peer 端点不再被节点用于跨机通信。

### 9.3 需要用户确认/操作
1. 本机 hub 端口 8790、数据目录、FRP provider 名/密钥。
2. LAPTOP 升级 0.8.0 并重启节点与（如需要）DSH Host 才能加载新 bridge 代码。
3. 手机安装 0.4.0 APK + 新 hub device token。
4. 是否允许 hub 自动管理自己的 frpc 配置（默认允许）；若不允许则走静态模式。
5. 确认“不保留点对点回退”带来的迁移窗口安排（先升级两端，再切 hub）。

## 10. 决策记录与剩余问题

### 10.1 已确认
| # | 决策 |
|---|---|
| Q1 | hub 独立进程 |
| Q2 | hub 只绑 127.0.0.1 + FRP（LAN 直连可选） |
| Q3 | 自动审批：一次性 enroll token；非开放注册；保留 manual 模式 |
| Q4 | hub 持久缓存 + 节点定期重连/心跳 + 手动重连（DSH Web GUI/CLI/MCP）+ 恢复后立即补发 |
| Q5 | 不保留点对点回退 |
| Q6 | device token 默认全节点，可选节点白名单 |
| Q7 | 文件经 hub 代理；skill 默认不发大文件；预留外部传输 |
| Q8 | 本机 DSH 作为普通节点注册 |
| Q9 | 端口 8790 / 18790 / 19110+ |
| Q10 | 不做全局内容搜索；全局监控仅 Session 运行状态 |

### 10.2 待确认（新增）
| # | 问题 | 建议默认 |
|---|---|---|
| N1 | hub 自动管理自己的 frpc 配置是否可接受（写配置 + reload 自己的 frpc 进程）？ | 已接受（自动模式）；否则静态模式 |
| **N2** | “插件 GUI”的形态？ | **已拍板：集成进现有 dsh-link-bridge 插件的 client half，显示在 DSH Web GUI Settings 页**；节点本地 `/ui/hub` 仅作备用 |
| **N3** | “大文件默认不发”的阈值？ | **已拍板：10 MiB**；超过需用户明确要求；附件仍 ≤ 512 KiB |
| **N4** | enroll token 默认 TTL/次数？ | **已拍板：TTL 2 小时、单次使用** |
| N5 | 运行状态聚合需要 bridge 能力通道启用；bridge 未启用的节点显示 unknown 是否可接受？ | 已接受 |
| N6 | 是否保留 0.7 的节点 8788 gateway 代码一个版本？ | 已接受：保留代码但文档标记 deprecated，0.9 再删 |

## 11. 附录

### A. 消息线格式（hub 转发前后一致）
```
{
  "id": "msg_01...",
  "ts": "2026-11-04T12:00:00.000Z",
  "from": { "nodeId": "node_...", "name": "DESKTOP-NODE-A", "url": "http://..." },
  "to": "LAPTOP-PEER-B",
  "thread": "msg_01...",
  "replyTo": null,
  "kind": "message",
  "subject": "继续 stage-2",
  "body": "…",
  "attachments": [],
  "targetSession": "session-...",
  "originSession": "session-..."
}
```

### B. Hub 数据目录
| 文件 | 内容 |
|---|---|
| `hub.config.json` | hub 身份/token/nodes/enrollment/frp/files 策略 |
| `nodes.json`（或 config.nodes） | 登记表（自动 enroll 写入；含下行 token 哈希/加密） |
| `inbox.jsonl`/`outbox.jsonl` | 收到/待下发消息（幂等、投递状态） |
| `state.json` | 已读/投递状态、enrollment 使用记录、节点在线状态 |
| `audit.jsonl` | 路由/接入/文件/拒绝/重试审计 |
| `frp/frpc.toml` | hub 管理的 frpc 配置（provider + visitors） |

### C. 代码位置索引
| 主题 | 位置 |
|---|---|
| 节点鉴权/角色 | `src/server.mjs:14-17`、`:106-110`、`src/config.mjs:123-135` |
| token 结构/签发 | `src/config.mjs:197-260`、`:332-407` |
| token 网关参照 | `src/gateway.mjs:24`、`:122-177` |
| 消息投递/上行改造点 | `src/ops.mjs:113-145`、`:334-350` |
| 文件 API | `src/server.mjs:294-356`、`src/ops.mjs:275-331`、`src/client.mjs:76-115` |
| DSH view/能力代理 | `src/ops.mjs:394-532` |
| 拓扑发现形状 | `src/network.mjs:6-17`、`:269-279` |
| 能力策略 | `src/capabilities.mjs:19-39`、`:99-140` |
| bridge 定向投递 | `integrations/dsh-link-bridge/lib/index.js:607-830` |
| bridge 会话列表（running 来源） | `integrations/dsh-link-bridge/lib/dshops.js:402-437`；DSH 字段 `SessionListEntry.running` |
| 手机入口/节点选择 | `android/.../MainActivity.java:141-297`、`NodeState.java:42-97` |
| 隧道 provider 生成 | `src/tunnel.mjs:69-140`、`:232-248` |
| hub 核心（HTTP/路由/代理） | `src/hub.mjs` |
| hub 配置与令牌 | `src/hubconfig.mjs` |
| hub 持久队列/登记表/缓存 | `src/hubstore.mjs` |
| hub 自己的 frpc（provider + visitors） | `src/hubfrp.mjs` |
| 节点上行（enroll/心跳/投递/重连） | `src/hublink.mjs` |
| hub Web 控制台页面 | `src/hubui.mjs:1`（`/ui` + `/api/v1/hub/tokens|config|settings|flush|outbox` 在 `src/hub.mjs`） |
| bridge hub 面板/state.hub 快照 | `integrations/dsh-link-bridge/lib/hub.js`、`lib/client.js` |
| skill 文档 | `integrations/dsh-skill/SKILL.md` |

### D. 术语
| 术语 | 含义 |
|---|---|
| hub / 中心服务器 | 本机常驻 `dshlink hub` 进程，唯一消息路由与手机入口 |
| DSH 节点 / node | 每台机器上的 dsh-link 节点（8787） |
| bridge / 插件 | DSH Host 内的 `dsh-link-bridge`，执行注入/驱动 |
| enroll token | 一次性接入令牌（role=enroll），自动审批用 |
| 上行 token | 节点 → hub（peer 绑定节点名） |
| 下行 token | hub → 节点（peer 绑定 hub 名） |
| 心跳 | 节点每 30s 上报在线状态 |
| 定向消息 | 信封带 `targetSession` 的消息 |
