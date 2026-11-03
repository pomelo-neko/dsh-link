# dsh-link 移动端控制软件（Android）可行性方案

| 项 | 内容 |
|---|---|
| 版本 | v0.2（可行性研究稿 + 0.6.0 实现状态） |
| 日期 | 2026-11-02（v0.1）；2026-11-03 更新 |
| 基线 | v0.1 基于 dsh-link 0.3.0；**当前 A 阶段已随 0.6.0 实现**（见 [`mobile/CONTROL-APP.md`](mobile/CONTROL-APP.md) 与 [`../android/README.md`](../android/README.md)） |
| 方法 | 通读 src/ 与 docs/ + 对本机 127.0.0.1:8787 做只读 GET 探测（未 POST、未重启、未改配置）+ 对端 FRP visitor 节点探测 |
| 结论 | **技术可行，无需重写节点；A 阶段（零服务端改动）已实现，B 阶段（节点增强：SSE/设备 token 管理/多节点）为后续** |

---

## 0. 一句话结论

dsh-link 现有节点已经能列出 workspace/session、读取 transcript、经能力通道下发 sessions.prompt，Android App 本质上只是「HTTP 客户端 + 会话 UI + 轮询」；**真正缺的不是功能入口，而是三件事——实时推送、设备级凭证、手机可达的安全传输**。用「Tailscale/WireGuard + 现有 API + 轮询」8–11 人日可做出自用 MVP；要做到接近 IM 的体验，需要节点侧加增量游标与 SSE，总计 13–19 人日。

## 1. 需求边界

### 1.1 用户原话（m00001 第 2 项诉求）

> 探索开发跨平台 link，在当前 link 的基础上开发移动端的控制软件。注意，这里是控制软件而不是移动端 dsh 加入节点，也就是一个安卓应用，可以通过连接到某个 dsh-link 节点来获取当前节点连接到的 dsh 信息，随后通过手机端接收对应 dsh 的 session 内容更新并控制对应 dsh 发送消息。先研究可行性方案，我看一眼再决定要不要做。

### 1.2 分解后的功能需求

| 编号 | 需求 | 说明 |
|---|---|---|
| R1 | 连接节点 | 手机 App 连接到一个 dsh-link 节点，完成配对与鉴权 |
| R2 | 看 DSH 信息 | 列出该节点 DSH home 下的 workspace / session |
| R3 | 看会话内容 | 查看指定 session 的 transcript，并随 DSH 产生新内容而更新 |
| R4 | 控制发送 | 从手机向指定 session 发消息（驱动该 DSH 的 agent） |
| R5 | 不改变定位 | App 只是「控制端」，**不做**移动端 DSH 节点、不跑 agent、不托管会话 |

### 1.3 明确不在本期范围

- 公网中继服务、账号体系、云端多租户（可选的三期，见 §5）。
- iOS 端（本方案只评估 Android；协议层与平台无关，未来可复用）。
- 语音/视频、文件预览高级功能、模型参数管理。
- 修改 DSH 本身（DSH 是独立进程，节点只读它的日志）。

## 2. 可行性摘要

### 2.1 已确认可行（有代码与实测证据）

1. **节点侧只读面完整**：workspace/session/transcript 三类数据都有 HTTP API 且已在运行节点上返回真实数据（§3）。数据来源是 DSH home 下的会话日志，节点只读文件，不需要 DSH 配合（src/dshview.mjs:600-695）。
2. **控制面已存在**：POST /api/v1/dsh/call 可下发 sessions.prompt，由 DSH host 内的 bridge 插件轮询执行（src/server.mjs:288-297，src/ops.mjs:499-522，integrations/dsh-link-bridge/lib/dshops.js:487-502）。实测能力通道 queue 已有 18 条 done 记录，说明链路是通的。
3. **跨节点代理已存在**：dshCall 支持 body.peer 转发到对端节点（src/ops.mjs:499-508），MCP 工具也全部带 peer 参数（src/mcp.mjs:164-218）。
4. **手机端技术栈无难点**：REST + JSON + 轮询/SSE，Kotlin/Compose 原生可实现；无需特殊 SDK。

### 2.2 已确认的硬约束（决定架构）

1. **没有服务端推送**：全仓库无 SSE/WebSocket 实现；GET /mcp 明确 405 并说明不提供服务端发起的流（src/server.mjs:366-369；检索证据见 §7.1）。更新只能靠轮询，除非在节点新增 SSE 端点。
2. **transcript 没有 since-seq / 增量游标**：只有 limit/offset/tail（src/server.mjs:272-279，src/dshview.mjs:913-930）；实测传 since 参数被忽略。客户端要做增量只能用 offset+total 近似。
3. **动作方法默认未授权**：当前节点 capabilities.methods 只有 4 个读方法，sessions.prompt 虽在 catalog 但不在 allowlist；手机发送会被 403 capability_denied（src/ops.mjs:510-521，src/capabilities.mjs:99-112）。需要改节点配置显式授权（配置热重载生效，无需重启节点/DSH host，docs/DSH-ACCESS.md:159-160）；bridge 需已在 DSH host 内运行。
4. **手机 WAN 到达节点没有现成方案**：节点默认 bind 127.0.0.1 且无 TLS（src/config.mjs:41-61，src/server.mjs:424）；FRP 是 STCP provider/visitor 模式，visitor 端口只在节点本机监听（src/tunnel.mjs:43-63），手机不能直接连。
5. **鉴权是静态 token、无设备粒度**：token 只按 label 进审计，无 scopes、无吊销 UI、无移动端专用凭证（src/config.mjs:99-109、:210-240；实测审计只有 ip/token label）。
6. **trustLocalhost 在 FRP/反代下会绕过 token**：实测经 frp visitor 访问对端 19110，不带 token 也返回 200（对端看到源地址是 127.0.0.1）。这意味着任何能到达 visitor 端口的人都能免 token 调 API——移动端接入前必须先解决这个信任边界（§9）。

### 2.3 需要 PoC 确认的点（低风险）

- DSH 会话日志是否**只追加不重写**（决定 offset 增量是否稳定）。
- 日志压缩/归档时 size 是否回退（App 需要检测并全量重拉）。
- Android 后台常驻轮询的电量与厂商杀后台行为（用前台服务/WorkManager + 用户白名单缓解）。
- 大日志尾部读取（>32 MiB 时只读前缀，最新内容可能看不到，src/dshview.mjs:23、:114-139）。

## 3. 实测基线（本机运行节点，2026-11-02）

### 3.1 环境

| 项 | 值 |
|---|---|
| 节点 | alice-pc / nodeId node_01m0000000000000000 / dsh-link 0.3.0 |
| 监听 | 127.0.0.1:8787（bind 127.0.0.1，无 TLS） |
| 配置 | C:\Users\<you>\.dshlink\dshlink.config.json（183 行） |
| DSH | home D:\dsh-home，enabled/workspaces/transcripts 全开，transcriptMaxMessages=200、transcriptMaxChars=8000 |
| 能力通道 | enabled=true，methods 仅 4 个读方法；bridge 0.3.0 online（fresh=true，6 sessions）；queue done=18 |
| 对端 | bob-pc，经 FRP visitor http://127.0.0.1:19110 可达 |

### 3.2 关键端点实测（GET）

| 端点 | 实测结果 | 关键限制 |
|---|---|---|
| /healthz | 200 {ok,name,nodeId,software,version,time} | 唯一免鉴权路径（src/server.mjs:9-10、:107） |
| /api/v1/info | {name,nodeId,version,softwareVersion,publicUrl,roots[3],dsh{enabled,workspaces,transcripts},capabilities{enabled,methods},allowUpload,relay,peers,limits} | 能力发现入口；不含 transcript 上限等细节 |
| /api/v1/status | {node{name,nodeId,url,bind,port,dataDir,configPath,software,version},stats{inbox,inboxUnread,outbox,outboxPending,threads},roots,inboundTokens:10,peers,runtime{pid,startedAt,configReloads,...}} | inboundTokens 只给数量，不给列表 |
| /api/v1/dsh/workspaces | {peer,home,count:9,workspaces[{id,title,path,archived,sessions,lastActivityAt,createdAt,updatedAt}]} | 9 个 workspace；排序 lastActivityAt desc |
| /api/v1/dsh/sessions | {peer,count,sessions[{sessionId,workspaceId,title,titleSource,cwd,createdAt,updatedAt,sizeBytes,archived,messages,messagesExact}]} | limit 默认 100、max 1000（src/server.mjs:262）；limit=5 返回 5 条；updatedAt desc；messages 是下界（messagesExact:false） |
| /dsh/sessions/{id}/transcript | {peer,session,total,messages[{seq,time,role,kind,text,tool,truncated}],truncated,corruptFrames} | limit 请求 1000 被夹到 200（ops.mjs:443-451）；offset 上限 1e6；tail=1；无 since；实测 2.3 MB 会话 200 行 487 KB / 首次 425 ms |
| /api/v1/dsh/capabilities | {peer,enabled,methods[4],catalog[8 个方法{method,kind,description}],bridge{version,at,sessions,stale},queue{pending,claimed,done,failed,expired}} | 动作方法只在 catalog，不在 allowlist |
| /api/v1/bridge/status | {bridge{node,version,capabilities[8],sessions,at},fresh:true,ageMs,queue,enabled:true} | bridge 心跳 60 s 新鲜度（capabilities.mjs:492-499） |
| /api/v1/audit | {entries[{ts,event,method?,forPeer?,commandId?,status?,ip,token}]} | limit 默认 50 max 500；token 字段是 label 或 "localhost"，无设备/请求 id 关联 |
| /api/v1/peers | {self,count,peers[{name,url,hasToken,autoSync}]} | 对端 url 是节点视角的 visitor 地址 127.0.0.1:19110 |
| /api/v1/messages 与 /outbox | {box,count,total,unread,latestId,messages[...]} | inbox 默认 desc、outbox 默认 asc（server.mjs:132-171） |
| /api/v1/files | {root,path,count,truncated,entries[{name,type,size,mtime,path,link?}]} | 虚拟文件根（workspaces/allws/drop） |
| 错误 | 404 {error:{code:"not_found",message:"no route for GET ..."}} | 统一错误信封 |
| CORS | 带 Origin 请求无任何 access-control-* 响应头 | PWA 跨域不可用；原生 App 不受影响 |

### 3.3 实测到的两个重要陷阱

1. **GET 视图路由不接受 peer 参数**：GET /api/v1/dsh/workspaces?peer=bob-pc 返回的仍是本机数据（peer 字段=本机名）；跨节点读只能走 POST /api/v1/dsh/call {peer,...} 或 MCP（server.mjs:250-286 不读 peer，ops.mjs:376-420 支持 peer）。
2. **对端免 token**：GET http://127.0.0.1:19110/api/v1/info 不带 token 返回 200。经 FRP STCP 到达对端的请求源地址是 127.0.0.1，命中 trustLocalhost 放行（server.mjs:54-56）。移动端方案不能建立在「token 会拦人」的假设上。

## 4. 现状可复用面

### 4.1 直接复用（零改动）

| 能力 | 位置 | 用途 |
|---|---|---|
| 鉴权（Bearer / X-DSHLink-Token） | src/server.mjs:39-45 | App 请求头带 token |
| 能力发现 | src/server.mjs:111-113；/api/v1/info | 决定显示哪些功能 |
| workspace / session 列表 | src/server.mjs:250-266；src/ops.mjs:392-430 | 首页与会话列表 |
| transcript（含 seq/time/role/kind/text） | src/server.mjs:272-282；src/dshview.mjs:286-332、:884-931 | 聊天气泡渲染；seq 可用于显示与近似去重 |
| 能力通道与命令队列 | src/ops.mjs:481-545；src/server.mjs:288-301 | 发送 prompt、查询执行结果 |
| 跨节点代理 | src/ops.mjs:499-508 | 一个节点管多台 DSH |
| 审计 | src/server.mjs:104、:237-239 | 操作留痕 |
| 文件 API | src/server.mjs:173-235 | 未来做附件/日志拉取 |
| 位置：MCP 端点 | src/server.mjs:349-364 | 零改动的跨节点读取备选通道 |

### 4.2 需要小改后复用

| 能力 | 现状 | 需要的改动 |
|---|---|---|
| 动作授权 | methods 仅读方法 | 配置加 sessions.prompt（+可选 create/rename/archive），配置热重载生效 |
| 增量读取 | 只有 limit/offset/tail | 加 since/cursor 参数或 SSE 端点（§7.2） |
| 多节点选择 | App 只能逐个配 URL | 节点侧可选代理透传；MVP 先做「App 内多套配置」 |
| 安全传输 | 127.0.0.1 无 TLS | 外部解决（VPN / 反代），不改节点也能用 |

### 4.3 关键代码事实（写实现前必须知道）

- transcript 的 messages 行结构：{seq:number|null, time:epochMs|null, role:user/assistant/system/tool, kind:user/assistant/reasoning/tool-call/tool-result/system, text, tool:string|null, truncated:boolean}（src/dshview.mjs:286-332）。
- **同一事件会渲染成多行**（assistant/message 的 text/reasoning/tool-call 各一行，共享同一个 seq；tool/result 每个 block 一行），且 seq 可能为 null。因此：**seq 不是唯一行游标**，客户端去重必须用行内容哈希或「seq+kind+text 前缀」。
- transcript 响应里的 total 是「渲染行数」而非消息数：实测小会话 total=41 行，而 session meta messages=17。
- transcript 结果按文件 stat(size,mtime)+chars 缓存（src/dshview.mjs:896-912），文件没变时二次请求极快（3 ms）。
- 日志是多个 zstd 帧首尾拼接，节点按魔数切帧逐帧解压（src/dshview.mjs:10-13、:141-204）；超过 32 MiB 只读前 32 MiB（src/dshview.mjs:23、:114-139）。
- 视图有 5 s 缓存（src/dshview.mjs:25），所以手机 1 s 轮询也不会让节点反复扫盘。
- 请求超时 60 s、keepAlive 5 s（src/server.mjs:430-432）；body 上限 32 MiB（src/config.mjs:33-39）。
- 能力调用：waitSeconds 默认 30、最大 180；wait=0 立即返回 pending；命令 TTL 120 s；结果超 512 KiB 会截断成 preview（src/ops.mjs:499-522；src/capabilities.mjs:30-39、:344-361）。
- bridge 是 DSH host 的插件，依赖 ctx.sessionController，必须常驻 Host 内；commandSeconds 默认 5 s 轮询一次（integrations/dsh-link-bridge/lib/index.js:69、:301-314）。

## 5. 候选架构

### 5.1 传输层选项（决定「手机怎么到达节点」）

先把「怎么做 App」和「手机怎么连上节点」分开，因为后者才是真正的约束。

| 选项 | 做法 | 优点 | 问题 | 结论 |
|---|---|---|---|---|
| T1 VPN overlay | 手机与节点机加入同一个 Tailscale / WireGuard / ZeroTier 网络，App 直接访问 http://<节点VPN地址>:8787 | 0 服务端改动；端到端加密；NAT 穿透好；可只允许自己的设备 | 每台手机要装并登录 VPN；节点机要在 VPN 内（或做子网路由）；Android 需常驻 VPN | ✅ MVP 推荐 |
| T2 节点 HTTPS 反代 | Caddy / Nginx 终止 TLS 转发 127.0.0.1:8787，配域名证书，关闭 trustLocalhost | 手机无需装 VPN；标准 HTTPS | 节点暴露公网，攻击面变大；要限 IP / 加防护；审计来源变成反代 IP；证书运维 | ⚠️ 备选（自用可加固） |
| T3 手机侧 frpc visitor | 手机跑 frpc visitor 连 frps，再访问节点 STCP provider 发布的端口 | 复用现有 FRP 拓扑 | 手机要装/保活 frpc、分发 secretKey、无成熟 Android GUI | ❌ 不推荐 |
| T4 公网中继 + 推送 | 节点主动 WSS 出站连中继网关，手机连网关；FCM / 自建推送 | 任意网络可用；后台通知 | 需新建并运维公网服务；账号体系、隐私、推送合规；成本最高 | 🕒 三期（C 架构） |
| T5 节点同源移动 Web | 节点托管静态页，手机浏览器/WebView 打开，天然同源免 CORS | 最快出 demo；无需 APK | 无原生体验、后台/推送弱、token 存 Web Storage 有风险；不是安卓应用 | 🔻 仅 demo/降级 |

> Android 9 起默认禁止明文 HTTP。T1 需在 network_security_config 里对 VPN 网段/域名显式允许 cleartext；T2 用 HTTPS 无此问题。

### 5.2 组合架构 A / B / C

| 维度 | A：直连轮询（过渡版） | B：节点增强 + 原生 App（推荐目标） | C：公网推送中继 |
|---|---|---|---|
| 组成 | 现有节点 API + VPN + 原生 App；用 offset+total 做增量 | A + transcript since/cursor + SSE 或长轮询 + peer 透传 + 设备 token/作用域 + 审计 device | B + 公网中继网关 + 设备注册 + FCM/ntfy + 离线队列 |
| 服务端改动 | **0 行代码**，只改配置（开 dsh/capabilities、methods 加 sessions.prompt，配置热重载生效） | 约 6–9 人日（§7.2） | B 全部 + 中继服务约 8–12 人日 |
| 实时性 | 3–5 s 轮询；2.3 MB 会话每次约 425 ms 服务端开销 | 新内容 ≤1 s（SSE）；大日志仍需处理 32 MiB 上限 | 同 B，且可后台通知 |
| 安全 | VPN 隔离 + 静态 token；无设备粒度 | 设备级 token / 作用域 / 吊销 + 审计；可选 HTTPS | 再加中继信任方与账号体系，隐私面最大 |
| 工期 | 8–11 人日 | 13–19 人日（含 A 的成果） | 25–35 人日 |
| 适用 | 个人自用、先验证价值；不想动节点代码 | 长期自用 / 小团队；要接近 IM 的体验 | 商用 / 多用户 / 无 VPN 且要后台推送 |

### 5.3 加权评分与选择

| 维度（权重） | A | B | C |
|---|---|---|---|
| 功能满足（30%） | 9 | 10 | 10 |
| 实时体验（25%） | 5 | 9 | 10 |
| 安全与隐私（20%） | 5 | 8 | 7（多一个信任方） |
| 工期与成本（15%） | 10 | 6 | 3 |
| 运维复杂度（10%） | 9 | 7 | 4 |
| **加权分** | **7.35** | **8.45** | **7.75** |

结论：**B 最优，A 是 B 的必经第一阶段**。App 侧把 API 抽象成 TranscriptRepository 后，B 只是把轮询换成 SSE 并加鉴权字段，不重写 UI。C 只在「必须公网随时可用且有后台通知」时启动。

## 6. 推荐架构

### 6.1 目标形态

- **App**：Kotlin + Jetpack Compose 原生 Android 应用；单 App 管理多套节点配置（先单节点，后续加 peer）。
- **传输**：默认走 VPN（Tailscale/WireGuard）到节点 8787；如不用 VPN，再用 T2 反代方案。
- **节点**：保持零依赖单进程；新增能力全部是向后兼容的可选参数/新端点，不影响现有 CLI 与 MCP 客户端。
- **实时**：第一阶段轮询（A），第二阶段 SSE/长轮询（B）；App 内统一 TranscriptStream 抽象，两种实现可切换。
- **控制**：复用 sessions.prompt + 命令结果查询；App 把「已发送 / 已接受 / 执行中 / 失败」做成状态机，不假装同步。
- **不做**：公网中继、账号体系、后台推送（MVP 内）。

### 6.2 数据流图

~~~text
┌────────────────────────────┐      HTTPS（T2）或 HTTP over VPN（T1）      ┌────────────────────────────────────────┐
│ Android App                │ ────────────────────────────────────────▶ │ dsh-link 节点  127.0.0.1:8787           │
│  Compose UI                │ ◀──────────────────────────────────────── │  鉴权：Bearer / X-DSHLink-Token         │
│  Room 缓存 + 水位          │   REST：/info /dsh/** /dsh/call           │  只读视图：src/dshview.mjs               │
│  SSE 或轮询                │                                           │  能力队列：<dataDir>/commands/*.json     │
└────────────────────────────┘                                           └───────────────┬────────────────────────┘
                                                                                         │ 读文件系统
                                                                                         ▼
                                                          ┌──────────────────────────────────────────────┐
                                                          │ DSH host（与节点同机，独立进程）               │
                                                          │  $DSH_HOME/sessions/**/session.v3.jsonl.zstd  │
                                                          │  dsh-link-bridge 插件（默认 5 s 轮询命令）     │
                                                          └──────────────────────┬───────────────────────┘
                                                                                 │ ctx.sessionController.prompt
                                                                                 ▼
                                                          ┌──────────────────────────────────────────────┐
                                                          │ DSH agent 会话（模型调用 / 工具执行 / 写日志） │
                                                          └──────────────────────────────────────────────┘
~~~

数据流编号：

1. App 启动 → GET /api/v1/info 能力发现（dsh 开关、capabilities.methods、peers、limits）。
2. 列表页 → GET /api/v1/dsh/sessions（可按 workspace/query 过滤）→ 展示会话。
3. 打开会话 → GET /api/v1/dsh/sessions/{id}/transcript?limit=200&tail=1 渲染最近内容，记录 total 作为 A 阶段水位。
4. 增量更新 → A：GET transcript?offset=<水位>&limit=200 追加；B：GET transcript?since=<cursor> 或订阅 SSE。
5. 发送控制 → POST /api/v1/dsh/call {method:"sessions.prompt", params:{sessionId,text}, waitSeconds:0} → commandId。
6. 观察结果 → GET /api/v1/dsh/call/{id} 看 accepted/done/failed；同时靠步骤 4 的增量看到模型回复。

### 6.3 关键时序

**配对（一次性）**

~~~text
节点机（有终端权限）                    App
  dshlink mobile pair --label pixel8
  ├─ 生成 scoped token（dsh:read + dsh:prompt）
  ├─ 编码为 dshlink-mobile1:<base64url(JSON)>（复用 pairing.mjs 编码习惯）
  └─ 终端打印二维码 ──────────────────▶ 扫码
                                         ├─ 解析 url + token
                                         ├─ GET /info 自检（节点名/版本/dsh 开关）
                                         └─ token 存 Android Keystore，配置存 DataStore
~~~

**打开会话并持续更新**

~~~text
App                              节点                               DSH host / 日志
 │ GET /dsh/sessions                │                                      │
 │────────────────────────────────▶│                                      │
 │ GET transcript?limit=200&tail=1  │                                      │
 │────────────────────────────────▶│ 读 <32MiB 前缀，解码 zstd 帧          │
 │◀── {total, messages, truncated}  │                                      │
 │ 渲染 + 存 total=N                │                                      │
 │ GET transcript?offset=N&limit=200（轮询，3–5 s）                        │
 │────────────────────────────────▶│ 文件 size/mtime 变化 → 重新解码        │
 │◀── 新增行 + 新 total            │                                      │
 │ 按行内容哈希去重后追加到 Room     │                                      │
~~~

**发送 prompt 并等待回复**

~~~text
App                   节点                     bridge 插件（DSH host 内）        DSH agent
 │ POST /dsh/call       │                              │                         │
 │ {sessions.prompt}    │                              │                         │
 │─────────────────────▶│ authorizeCall → enqueue      │                         │
 │◀── commandId         │                              │                         │
 │ GET /dsh/call/{id}   │  (bridge 每 5 s claim)        │                         │
 │─────────────────────▶│─────────────────────────────▶│ controller.prompt(...)  │
 │                      │                              │────────────────────────▶│ 模型开始处理
 │                      │◀── result {accepted:true} ───│                         │
 │◀── status done       │                              │                         │
 │ 轮询 transcript       │                              │                         │ 写入新日志帧
 │─────────────────────▶│ 读日志增量                    │                         │
 │◀── assistant / tool 行│                              │                         │
~~~

### 6.4 降级策略

| 情况 | App 行为 |
|---|---|
| bridge 不在线（capabilities.bridge.stale=true 或 queue pending 长时间不动） | 只读模式照常；控制按钮禁用并提示「Bridge 未运行 / DSH host 未启动」 |
| 节点版本不支持 since/SSE | 自动回退 offset+tail 轮询（按 /info 或响应字段探测能力） |
| SSE 连接被代理/网络中断 | 指数退避重连（1/2/4/8 s，上限 30 s），带 cursor 补拉；连续失败 3 次切轮询 |
| transcript truncated=true 且看不到最新 | 提示「会话日志超过节点读取上限（32 MiB）」并建议调大配置或升级 |
| 401/403 | 停止自动重试，提示重新配对/申请权限；429 按时长退避 |
| 请求超时（默认 60 s，src/server.mjs:430-432） | 命令类请求用 commandId 幂等查询；读请求退避重试 |

## 7. 缺失能力与改动点（按仓库模块）

### 7.1 全局缺口（先给证据）

- **无 SSE / WebSocket / 服务端推送**：全仓库检索 text/event-stream、WebSocket、EventSource、server-sent，只命中 docs/PROTOCOL.md:74、src/doctor.mjs:51（请求 Accept 头）、src/server.mjs:367-368（405 说明文字）；GET /mcp 明确返回 405「dsh-link does not offer a server-initiated SSE stream」（src/server.mjs:366-369）。
- **transcript 无 since 游标**（0.3 基线；**0.4 已补齐**：transcript 接受 `sinceSeq`，返回 `latestSeq`/`sinceSeq`，见 §14.3）：src/server.mjs:272-279 + src/ops.mjs:432-453 + src/dshview.mjs:884-931；当时实测 ?sinceSeq 被忽略。
- **无设备级 token / 作用域 / 吊销 UI**：src/config.mjs:99-109、:210-240；能力授权只按 token label 匹配 peers（src/server.mjs:290；src/capabilities.mjs:99-112）。
- **无 CORS 支持**：实测带 Origin 的请求无 access-control-* 响应头；src/server.mjs 鉴权与路由层无 CORS 处理（:39-62 鉴权、:107 起路由）。
- **无 TLS**：http.createServer（src/server.mjs:424）；默认 bind 127.0.0.1 + trustLocalhost:true（src/config.mjs:41-61）。
- **无移动端适配层/文档**：docs 目录检索 mobile、android、手机、移动端、APK 均无命中（本方案是首份）。

### 7.2 模块改动表

| 模块 / 文件 | 缺口 | 建议改动 | 影响面 | 人日 |
|---|---|---|---|---|
| src/server.mjs（路由） | transcript 不透传 since；无事件流；GET 视图不透传 peer；无 CORS；审计无 device | 1) transcript 路由加 since/cursor 透传（约 10 行）；2) 新增 GET /api/v1/dsh/sessions/{id}/events（SSE，约 80–120 行，含心跳、断线清理、res.setTimeout(0)）；3) 4 个 GET 视图路由透传 peer（约 8 行）；4) 可选 CORS 中间件（默认关，约 15 行）；5) 审计增加 device/tokenId | 向后兼容，不影响 CLI/MCP | 2–3 |
| src/dshview.mjs（读层） | 无增量游标；大文件只读前缀；无变更观察 | 1) transcript 输出 cursor（处理 seq 重复/null：建议「行序号 + 日志指纹」而非裸 seq）；2) 增量解码：按 stat 变化只解码尾部新帧；3) 大日志支持尾部读取（head/tail 窗口可配）；4) 可选 fs.watch 或轮询 stat 做事件源 | 影响所有 DSH 视图调用方 | 2–3 |
| src/ops.mjs（门控/编排） | transcript 无 since；无 events 编排 | 1) dshTranscript 增加 since/after 与 cursor 透传；2) 新增 dshEvents / waitForChange（长轮询）；3) 响应字段只增不改 | 低 | 1 |
| src/capabilities.mjs（授权/队列） | 无 token 作用域；动作授权粗 | 1) authorizeCall 支持 scopes（dsh:read / dsh:prompt / dsh:manage）；2) 命令查询已够用；3) 可选动作二次确认字段 | 中，需兼容旧配置 | 1–2 |
| src/config.mjs（配置） | token 无 scopes/device；无 CORS 配置 | 1) auth.tokens 增加 scopes 与 device（platform/name），无 scopes 旧 token 保持现有行为；2) 可选 cors 配置；3) 移动端配置样例 | 低 | 0.5–1 |
| src/pairing.mjs（配对） | 无可直接给手机用的配对码 | 新增 mobile pair 子命令：scoped token + 二维码（复用 base64url 编码习惯），默认只发读 + prompt 作用域 | 低 | 0.5–1 |
| src/tunnel.mjs（FRP） | 与手机无关 | 不改代码；文档说明「手机不经过 STCP visitor」 | 无 | 0 |
| integrations/dsh-link-bridge | prompt fire-and-forget；无「开始/结束」回执 | MVP 不改；若要「正在输入 / 回复完成」事件，需 Host 侧订阅 session 事件并上报（非 MVP） | 中 | 0（MVP） |
| docs/（文档） | 无移动端接入文档 | 本方案 + API 草案已完成；实现时更新 PROTOCOL.md / DSH-ACCESS.md / OPERATIONS.md | 低 | 实现期 0.5 |
| Android 新工程 | 全部 | 独立目录（建议 integrations/android/ 或 dsh-link-mobile/），Kotlin + Compose；UI/网络/缓存/安全存储 | 高 | 8–11（§8） |
| 测试 | 无移动端契约测试 | node:test 增加 since/SSE/peer/CORS/token scopes 用例；Android JVM 单测 + MockWebServer 契约测试；真机联调 | 中 | 2–3 |

### 7.3 A 阶段「零服务端改动」的增量技巧（可直接实现）

> **0.4 修订**：节点已提供 `sinceSeq` 增量接口（见 §14.3），本节 offset 技巧仅作为“节点未升级时的兜底”，新 App 不应再以它为主路径。

在不动节点代码的前提下，只靠现有 offset/total 就能做增量（会话日志是追加写，历史行前缀稳定）：

1. **首屏**：GET /dsh/sessions/{id}/transcript?limit=200&tail=1 → 记 total=N。
2. **轮询**：GET /dsh/sessions/{id}/transcript?offset=N&limit=200 → 返回从第 N 行开始的行；响应里的 total 是新总数。
3. **追赶**：若 total > N + 本次行数（一次轮询内新增超过 200 行），继续 offset=N+已取行数 再拉，直到取到 total。
4. **落库**：用行内容哈希（seq+role+kind+text 前 N 字符）去重，避免边界重复。
5. **失效检测**：若 total 变小，或 session 的 sizeBytes/updatedAt 回退（日志压缩/重写），丢弃本地缓存全量重拉。
6. **成本**：每次轮询只要文件 size/mtime 变化，节点都会重新解码整段日志（src/dshview.mjs:896-912）。实测 2.3 MB 会话约 425 ms/次，只适合小日志自用；这也是 B 阶段必须做增量接口的原因。

风险：offset 语义依赖日志只追加、不重写；DSH 归档/压缩行为需实测确认。**不要把 offset 当强一致游标**，只作过渡手段。

### 7.4 若实现，建议的代码落点

- 新增 src/events.mjs（SSE hub：连接注册、心跳、按 session 广播、背压/断线清理）；server.mjs 只加路由与鉴权。
- dshview.mjs 增加 transcriptSince(sessionId, cursor, limit) 与 snapshotVersion()（基于 size/mtime/总行数生成指纹，检测重写）。
- 移动端把 API 封装成 TranscriptRepository，内部两种实现：OffsetPoller 与 SseStream，UI 不感知。
- 所有新字段只增不改：旧 App / 旧 CLI / MCP 客户端不受影响。

## 8. MVP 范围与里程碑估算

### 8.1 A 阶段 MVP 功能范围（8–11 人日）

| 模块 | 功能 | 验收标准 |
|---|---|---|
| 连接管理 | 手工填 URL+token 或扫二维码；多套节点配置；连通性测试 | 能列出节点名/版本/DSH 开关；错误可读 |
| 会话列表 | workspace 分组、最近会话、关键词搜索、更新时间 | 9 个 workspace、数十个会话在 2 s 内展示 |
| 会话详情 | 最近 200 行渲染；user/assistant/reasoning/tool-call/tool-result/system 区分；工具块折叠 | 与桌面端 transcript 语义一致 |
| 增量更新 | 3–5 s 轮询 offset；内容哈希去重；失效重拉 | 新内容平均 ≤5 s 出现；无重复气泡 |
| 发送控制 | 发送文字 prompt；状态机（发送中→已受理→失败）；bridge 离线时禁用 | 能从手机驱动 agent 回复 |
| 安全存储 | token 进 Keystore；日志不打印 token；可选生物识别解锁 | 抓日志/截图不泄漏凭证 |
| 设置 | 轮询间隔、字号、节点信息、退出/清除缓存 | — |

### 8.2 里程碑

| 阶段 | 内容 | 人日 | 产出 |
|---|---|---|---|
| M0 | 方案确认 + 节点配置（开动作授权、生成移动 token（配置热重载）） | 0.5–1 | 可用的测试节点 |
| M1 | 服务端契约 PoC：脚本验证 prompt 授权、命令查询、offset 增量、日志追加假设 | 1 | PoC 记录（结论回填本文档 §2.3） |
| M2 | Android 工程骨架 + 网络层 + 能力发现 | 2 | 能显示 /info 与会话列表 |
| M3 | 会话列表与详情 UI（含工具块折叠） | 3 | 单会话可读 |
| M4 | 轮询增量 + 发送控制 + 状态机 | 2 | 端到端可控 |
| M5 | Keystore/配对二维码/设置/异常处理 | 1.5 | 可日常使用 |
| M6 | 真机联调、弱网、电量、厂商后台杀进程 | 2 | 内部可用版本 |
| **合计 A** | | **8–11** | |

**B 阶段追加**（13–19 人日总量）：节点侧 since+cursor 4–5 人日（含 ctx 清理与测试）、SSE 端点 2 人日、设备 token/作用域/吊销 2 人日、App 侧 SSE 与重连 1.5–2 人日、契约/真机回归 2–3 人日。

**C 阶段追加**（25–35 人日总量）：中继网关 8–12 人日、推送与设备注册 4–6 人日、多租户/账号 4–6 人日、运维与安全加固 3–5 人日。

### 8.3 建议节奏

第一周完成 M0–M2 + M1 PoC，用真机给出「列表 + 会话 + 发送」demo；用户确认进入后两周内交付 M3–M6。**不建议一上来做 B**：A 阶段可以验证「手机上看会话、发消息」是否真的有用，再决定是否为实时性与安全追加投入。

## 9. 安全与运维风险

### 9.1 威胁模型

| 威胁 | 现状 | 风险 | 缓解 |
|---|---|---|---|
| 手机丢失/被他人拿到 | 静态 token，无设备吊销 | 高 | token 存 Keystore；B 阶段设备级 token + 远程吊销；可选短 TTL + 生物识别 |
| 公共 Wi-Fi / 运营商链路被截获 | 节点无 TLS，HTTP 明文 | 高 | T1 VPN 或 T2 HTTPS；App 拒绝非回环的明文地址（可配置白名单） |
| 能访问 FRP visitor 端口的人 | trustLocalhost 命中回环，**免 token**（实测） | 高 | 关闭 trustLocalhost、改 bind、网络层隔离；B 阶段前必须处理 |
| token 泄漏（日志/截图/二维码转发） | token 明文只打印一次（config.mjs:210-220），但可被复制 | 中 | 一次性邀请码、限时 token、二维码不落盘、审计 lastUsed |
| 误发到错误会话 | 会话列表同名/多 workspace | 中 | 发送前二次确认，显示 workspace/title/cwd；可撤销仅限未送达 |
| 命令重放/重复发送 | 命令队列 commandId 幂等、TTL 120 s | 低 | App 禁止重复点击；按 commandId 查询 |
| 大日志高频拉取 DoS | 每次文件变化全量解码，2.3 MB 约 425 ms | 中 | 轮询间隔下限、ETag/If-None-Match、B 阶段增量接口 |
| 审计不足以追责 | 只有 ip + token label | 中 | 增加 device/tokenId/请求 id；动作审计单独留痕 |

### 9.2 运维风险

- **bridge 依赖 DSH host 常驻**：Host 重启/升级后 bridge 掉线，控制面不可用；App 必须做 graceful 降级（只读），并在 UI 明示（integrations/dsh-link-bridge/README.md 记录该约束）。
- **版本矩阵**：节点 0.3 + bridge 0.3 才支持能力通道；节点代码升级需重启节点进程；bridge 代码升级需重启 DSH host；只读视图需节点 ≥0.3.0，动作还需 bridge ≥0.3.0 且重启过 host（docs/DSH-ACCESS.md:153-160）。App 需按 /info 的 capabilities.methods 动态显示功能。
- **FRP 隧道故障**：frpc 进程可能未托管/重连风暴（docs/FRP.md:147-154）；手机侧只感知「连接失败」，需要重试与节点切换。
- **手机后台限制**：国产 ROM 杀后台；前台服务 + 电池优化白名单 + 用户引导；不做「保证实时」的承诺。
- **时区/时钟**：transcript 的 time 是 epoch 毫秒（src/dshview.mjs:299-300 附近），App 本地格式化，不要依赖节点时区。
- **升级兼容**：新字段只增不改；App 对未知字段忽略；旧 App 遇新节点不得崩溃（契约测试覆盖）。

### 9.3 合规与隐私

- transcript 可能包含代码、密钥、聊天内容；手机本地 Room 建议加密（SQLCipher 或系统文件加密），并支持「退出即清缓存」。
- 若未来接入 FCM/第三方推送：**推送只发「有更新」信号，不携带会话内容**，避免内容出境。
- 审计日志本身不要记录 message 正文（现有审计只记方法与元数据，保持）。

## 10. Android 技术栈选型建议

| 层 | 推荐 | 理由 | 备选 |
|---|---|---|---|
| 语言/构建 | Kotlin 2.x + Gradle KTS，JDK 17 | 官方方向；协程/Flow 成熟 | Java（不推荐） |
| UI | Jetpack Compose + Material3 + Navigation | 列表/聊天流式 UI 开发快；动态主题 | XML View（老项目） |
| 架构 | MVVM + Repository + Kotlin Flow | 可测试；轮询/SSE 用 Flow 抽象 | MVI（更重） |
| 网络 | OkHttp + kotlinx.serialization | 轻、可控；SSE 可用 OkHttp EventSource 手写 | Retrofit（团队熟可加） |
| 本地存储 | Room（消息缓存）+ DataStore Proto（配置） | 结构化查询、迁移可控 | SQLDelight |
| 凭证 | Android Keystore + EncryptedSharedPreferences | token 不落明文 | 自管加密（易错） |
| 后台 | WorkManager（增量拉取）；前台服务（可选常连） | 系统友好；避免无限后台 | 常驻 Service（耗电） |
| 二维码 | ZXing（journeyapps embedded） | 成熟、体积可控 | ML Kit（需 GMS） |
| 测试 | JUnit + MockWebServer + Compose UI Test | 契约测试与服务端解耦 | 真机手工为主 |
| 兼容 | minSdk 26，targetSdk 35 | 覆盖绝大多数设备 | minSdk 24 |
| 包名/目录 | dev.dshlink.mobile，integrations/android/（或独立仓库） | 与主仓库解耦，可独立发版 | monorepo 子模块 |

补充：
- **不要引 Hilt** 除非团队已有经验（MVP 手写依赖注入可省 1 人日）。
- 若未来要 iOS：网络层/数据模型用 KMP 共享可省 30%–40%；但 MVP 不建议为未来过度设计。
- Flutter 备选：跨端快，但 SSE/后台/Keystore 细节仍需平台通道，且包体与内存略大；用户明确要「安卓应用」，原生优先。

## 11. API 草案

### 11.1 设计原则

1. 复用现有 REST 端点，路径与错误信封保持一致（src/server.mjs 现有风格）。
2. 新增能力放在 v1 内演进：只加字段/参数/端点，不改语义。
3. 增量接口必须能检测「日志被重写」，用 cursor 指纹而不是裸 seq。
4. 控制面沿用命令队列：提交返回 commandId，结果用 GET 查询，天然幂等。
5. 能力发现：App 通过 /api/v1/info 判断是否显示「实时」「发送」功能。

### 11.2 App 会用的现有端点

| 方法 | 路径 | 用途 | App 注意 |
|---|---|---|---|
| GET | /healthz | 连通性探测 | 免鉴权 |
| GET | /api/v1/info | 能力发现 | 缓存 5 min |
| GET | /api/v1/dsh/workspaces | workspace 列表 | 可加 includeArchived=1 |
| GET | /api/v1/dsh/sessions?workspace=&query=&limit= | 会话列表 | limit ≤1000 |
| GET | /api/v1/dsh/sessions/{id} | 会话元数据 | 进入会话时刷新 |
| GET | /api/v1/dsh/sessions/{id}/transcript?limit=&offset=&tail= | 读内容 | 首屏 tail=1 |
| GET | /api/v1/dsh/capabilities | 能力 + bridge 状态 + 队列 | 发送前必查 |
| POST | /api/v1/dsh/call | 下发动作 | body 见下 |
| GET | /api/v1/dsh/call/{id} | 查询命令结果 | 幂等 |
| GET | /api/v1/audit | 操作记录（可选） | 设置页只读展示 |

### 11.3 建议新增（B 阶段，均为可选）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/v1/dsh/sessions/{id}/transcript?sinceSeq=<lastSeq> | **0.4 已实现**：只返回 seq > sinceSeq 的行；响应带 latestSeq/sinceSeq。`nextCursor`/`reset` 仍是 B 阶段建议（用于同 seq 多行与日志重写） |
| GET | /api/v1/dsh/sessions/{id}/events | SSE：transcript 增量 + bridge 状态 + ping |
| GET | /api/v1/dsh/sessions/{id}/transcript/wait?since=&timeoutMs= | 长轮询备选（不支持 SSE 的代理环境） |
| POST | /api/v1/tokens | 设备 token（需 admin 权限；返回一次性明文） |
| DELETE | /api/v1/tokens/{id} | 吊销设备 token |
| GET | /api/v1/tokens | 列出 token 元数据（不返回明文） |

/info 建议补充字段（只增）：

~~~json
{
  "features": {
    "transcriptSince": true,
    "eventsSse": true,
    "longPoll": true,
    "deviceTokens": true,
    "cors": false
  },
  "dsh": {
    "enabled": true,
    "workspaces": true,
    "transcripts": true,
    "limits": { "transcriptMaxMessages": 200, "transcriptMaxChars": 8000 }
  }
}
~~~

### 11.4 关键请求/响应示例

**增量读 transcript（新增 since）**

~~~text
GET /api/v1/dsh/sessions/session-6a134890-.../transcript?since=v1:41:2311442:1793631572269:a1b2c3d4&limit=200
Authorization: Bearer <token>
~~~

响应：

~~~json
{
  "peer": "alice-pc",
  "session": "session-6a134890-...",
  "total": 60,
  "messages": [
    { "seq": 200, "time": 1793631600000, "role": "assistant", "kind": "assistant", "text": "...", "tool": null, "truncated": false }
  ],
  "truncated": false,
  "corruptFrames": 0,
  "nextCursor": "v1:60:2401201:1793631604000:e5f6a7b8",
  "reset": false
}
~~~

若日志被重写/压缩导致指纹不匹配：reset=true 且返回尾部窗口（total 为最新总数），App 清空重建。

**发送 prompt（现有端点）**

~~~json
POST /api/v1/dsh/call
Authorization: Bearer <token>
Content-Type: application/json

{
  "method": "sessions.prompt",
  "params": { "sessionId": "session-6a134890-...", "text": "继续这个任务，先给结论" },
  "waitSeconds": 0
}
~~~

立即响应：

~~~json
{ "commandId": "cmd_01m28...", "method": "sessions.prompt", "status": "pending", "pending": true }
~~~

随后查询：

~~~text
GET /api/v1/dsh/call/cmd_01m28...
→ { "commandId": "cmd_01m28...", "method": "sessions.prompt", "status": "done", "ok": true,
    "origin": { "peer": "mobile-pixel8", "ip": "100.64.0.7", "label": "mobile-pixel8" },
    "createdAt": ..., "finishedAt": ...,
    "result": { "accepted": true, "sessionId": "session-6a134890-..." }, "error": null }
~~~

注意：result 只代表「命令已被 bridge 执行」，**不代表模型回复完成**；回复要靠 transcript 增量观察。

**错误（现有信封）**

~~~json
{ "error": { "code": "capability_denied", "message": "method sessions.prompt is not allowed" } }
~~~

**SSE 帧（新增，B 阶段）**

~~~text
event: transcript
id: v1:60:2401201:1793631604000:e5f6a7b8
data: {"reset":false,"nextCursor":"...","messages":[...],"total":60}

event: heartbeat
data: {"bridgeFresh":true,"queuePending":0}

event: error
data: {"code":"dsh_unavailable","message":"..."}
~~~

### 11.5 App 侧状态机

- 连接：IDLE → CONNECTING → READY / ERROR（401 提示重新配对；429 退避）
- 流：READY → POLLING / STREAMING → RECONNECTING → POLLING（降级）
- 发送：IDLE → SENDING（POST）→ ACCEPTED（commandId）→ DONE / FAILED；超时转「未知，可查询」
- 发送前校验：capabilities.enabled && methods 含 sessions.prompt && bridge.fresh

## 12. 备选路线（若不做原生 App）

| 路线 | 成本 | 体验 | 结论 |
|---|---|---|---|
| 节点托管同源 PWA | 5–7 人日（需加静态托管 + CORS；token 存 Web Storage 有风险） | 中；无后台推送 | 可作 demo 或降级方案 |
| WebView 套壳现有页面 | 2–3 人日 | 低；仍需 PWA 页面 | 仅过渡 |
| Termux + SSH + CLI 脚本 | 0 | 极低；不是「应用」 | 自用临时方案 |
| 通用 MCP 客户端 App | 0–2 人日（接 /mcp JSON-RPC） | 低；信封大、无流式、UI 不可控 | 不满足「控制软件」体验 |
| 原生 Android（本方案） | 8–11 人日起 | 高；可控 | ✅ 推荐 |

## 13. 待用户决策项

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 手机主要在哪用（同一 Wi-Fi / 公网 / 都要） | T1 VPN / T2 反代 / C 中继 | 先 T1；公网刚需再 T2 |
| D2 | 先做 A（8–11 人日）还是直接 B（13–19 人日） | A→B / 直接 B | A 先验证价值 |
| D3 | 使用者范围 | 仅自己 / 家人朋友多设备 / 小团队 | 先单用户，B 阶段多设备 |
| D4 | 是否允许改节点配置开 sessions.prompt 动作（配置热重载；bridge 需已安装并运行） | 允许 / 不允许 | 必须允许，否则只能看不能发 |
| D5 | 发送安全级别 | 直接发 / 二次确认 / 仅预设短语 | 二次确认 |
| D6 | 本地缓存策略 | 全缓存加密 / 仅内存 / 保留 N 天 | 加密 + 默认 7 天 |
| D7 | 是否规划 iOS | 只安卓 / 未来 iOS | 先安卓，网络层留抽象 |
| D8 | 是否接受节点新增 SSE 端点（B 核心） | 接受 / 只做轮询 | 接受（否则实时性受限） |

## 14. 修订（m00512 追问，2026-11-03）

本节回答用户在看到初版方案后提出的四个问题（插话发送、手机 STCP、按需同步架构、计划修订），并给出安全审计结论。前 1–13 节的基线数据仍有效，但部分“缺口”已被 0.4 实现补齐，以本节为准。

### 14.1 插话式回复：已实现（queue → steer）

结论：**可以，而且已经做了。** DSH 的 SessionController 本来就支持两种 prompt 模式（`mode: 'queue' | 'steer'`）；0.3 的 bridge 固定用 `queue`，0.4 把它改成按投递类型自动选择：

| 场景 | 默认 mode | 语义 |
|---|---|---|
| 定向投递（targetSession 命中真实会话） | `steer` | 在目标会话的下一步边界插入，不排队等当前回合结束 |
| 路由投递（thread/replyTo 命中发起会话） | `steer` | 回复直接插回原来的对话 |
| 普通话题批量（桥池会话） | `queue` | 按顺序追加回合，避免打断批量处理 |

配置项 `promptMode: auto | queue | steer`（bridge 配置，默认 `auto`）：`auto` 按上表；`queue` 全部排队；`steer` 全部插话。解析后的值写入 state.json 的 `promptMode`，启动日志也会打印。能力通道的 `sessions.prompt` 也接受可选 `mode` 参数（默认 `queue`，显式 `steer` 插话，其他值 400/错误拒绝），CLI `dshlink bind` 与 MCP 的 `link_send_message`/`link_reply` 不需要 mode（走 bridge 默认策略）。

对手机控制端的含义：

- 手机“回复某条跨机消息/向某会话发指令”默认应走 **steer**（否则用户会感觉消息没反应，要等当前回合结束）；
- 手机批量发送/后台任务用 **queue** 更稳，避免打断长回合；
- steer 的代价是插入点可能落在 agent 正在执行的步骤之间，若 prompt 与当前任务无关会干扰上下文。App 建议把“插话/排队”做成显式开关（默认插话用于单条回复，排队用于批量）。
- 这不是“消息级中断”：steer 只是插到下一步边界，不能取消正在执行的 tool 调用；真正的中断需要 DSH 的 cancel 接口（不在本次范围）。

### 14.2 手机用 STCP：技术上可行，但不建议作为首选

用户设想：给 DSH 一套 STCP、给手机另一套 STCP，每个参与者自己认识、权限靠人管。评估如下。

**能跑通的路径**：手机侧运行 frpc（或等价的 Go frp 客户端，如 Termux 里跑 frpc、或把 frpc 编进 Android App 的 native 层），配置 `[[visitors]] type="stcp" serverName="<节点 proxy>" secretKey="…" bindAddr=127.0.0.1 bindPort=<本地端口>`；App 访问 `http://127.0.0.1:<本地端口>`。节点侧 frpc 用 `[[proxies]] type="stcp" localIP=127.0.0.1 localPort=8787`。拓扑上完全可行，和现在笔记本互连是同一套。

**但安全边界会变得很糟**：节点看到的源地址是 127.0.0.1（frpc 本机转发），`auth.trustLocalhost=true` 直接免 token；也就是说**手机 = 节点 root**，而且任何拿到手机 STCP `secretKey` 的设备也等于节点 root。`secretKey` 成为唯一的“成员资格”，但它是静态共享密钥、无吊销 UI、无法区分设备，和用户“权限管理靠人”的设想一致，却和“手机可能丢失/被借走”的现实冲突。详细风险见 [docs/SECURITY-AUDIT.md](SECURITY-AUDIT.md) 的 F1/F2。

**推荐替代（按优先级）**：

1. **WireGuard / Tailscale（推荐）**：手机装 VPN App，节点只监听 VPN 地址（或 127.0.0.1 + 端口转发但需解决回环问题）；节点 `auth.trustLocalhost:false`，手机用独立 token。成员管理靠 VPN 的 peer 列表，天然支持吊销；token 仍是第二道门。
2. **HTTPS 反代 + 独立 token**：frps 的 TCP 代理 + Caddy/Nginx TLS + 每设备 token；但反代在本机转发到 8787 同样会变成 127.0.0.1，必须同时把 `trustLocalhost` 关掉（这又要求先做 bridge 专用 token，见 14.5）。
3. **STCP（仅在所有设备都完全可信时）**：每台设备独立 secretKey、frps `allowUsers` 收紧、visitor 只绑 127.0.0.1、手机丢失立即轮换；接受“能连上即 root”。

**关于“两套 STCP”**：一套给 DSH、一套给手机在配置上可行，但不会带来隔离——两个隧道最终都落在节点的同一个 HTTP 端口上，节点无法区分来源。要隔离必须改鉴权模型（token→设备身份），而不是加隧道。

### 14.3 按需同步架构：方向对，但不需要“冻结位置”协商

用户方案：手机平常不传输；用户主动拉一次会话列表；选定会话后，不活跃就拉全部消息；活跃则与 DSH 侧约定冻结一个位置，该位置前由手机拉、之后由 DSH 主动推流。

**评价**：省电/省流量的方向完全正确；“冻结位置 + 之后推流”的直觉也对，但**不需要真的和 DSH 协商冻结**。原因：DSH 会话日志是追加写的，节点 0.4 的 transcript 已经提供单调 `seq` 游标：

- 每个渲染行带 `seq`（来自日志事件序号；同一事件可能渲染成多行，共享同一个 seq）；
- 响应带 `latestSeq`（当前最大 seq）和 `sinceSeq`（本次请求实际应用的游标）；
- `GET /api/v1/dsh/sessions/{id}/transcript?sinceSeq=<lastSeq>&limit=200` 只返回 seq 更大的新行。

这条游标就是“冻结位置”：手机拿到 `latestSeq` 的瞬间，该位置之前的内容已经可取、之后的内容用同一个游标继续取；不需要 lease、不需要服务端记住“某个手机冻结在哪”，断线重连只要带上本地保存的 lastSeq 即可。相比冻结协商，它的好处是：无状态、可多设备并发、节点重启不丢、实现简单。

**推荐数据流（MVP，无后台）**：

1. 用户打开 App → `GET /api/v1/info`（一次）+ `GET /api/v1/dsh/workspaces` + `GET /api/v1/dsh/sessions?limit=100`（一次）。
2. 用户点开某会话 → `GET /transcript?tail=1&limit=200` 拉最近 200 行，记 `latestSeq=N`。
3. 若该会话不活跃（updatedAt 很久没变）：到此为止，不做轮询、不推流。
4. 若活跃：前台每 2–5 秒 `GET /transcript?sinceSeq=<lastSeq>&limit=200`；有新行就追加，并更新 lastSeq。用户离开页面/切后台即停止（不需要后台服务）。
5. 重新进入：用本地缓存的 lastSeq 继续；若返回 `latestSeq < lastSeq` 或 `total` 变小（日志被压缩/换代，如 v3→v4），丢弃缓存全量重拉。
6. 分页边界：`limit` 可能截断在同一 seq 的多行中间；此时不要直接把 lastSeq 推到该 seq，应回退到“最后一个完整消费的 seq”或按内容哈希去重后再前进（0.4 的 `seq` 是事件级而非行级，这是已知边界，App 侧需要处理）。
7. 将来 B 阶段可把第 4 步换成 `GET /events`（SSE，Last-Event-ID = lastSeq）或长轮询；届时仍用同一游标语义，App 的网络层可替换。

**为什么“推流”在 MVP 不必做**：DSH bridge 本身是 5–10 秒级轮询；手机前台 3 秒拉一次的成本远小于维持一条推送连接，且没有后台保活问题。等 B 阶段真的需要“实时打字机”再上 SSE。

**流量估计**：transcript 响应是 JSON，一屏约 10–50 KB；前台活跃对话每 3 秒拉一次、每次通常为空（304 级开销约几百字节），一小时约 0.5–2 MB；不活跃会话零流量。

### 14.4 计划修订

基于以上，原方案（§8）的估算需要小改：

| 项 | 原方案 | 修订 |
|---|---|---|
| A 阶段（零服务端改动） | 8–11 人日 | **7–10 人日**：增量改用 0.4 的 `sinceSeq`，不再需要 offset+哈希指纹的兜底逻辑 |
| B 阶段（节点增强） | 13–19 人日 | **12–17 人日**：`transcript sinceSeq` 已完成；剩余 SSE/长轮询、设备 token/scopes、多 peer 过滤 |
| 安全前置（新增） | — | **已完成（0.5.0）**：bridge 专用 token、角色/peer/过期、`trustLocalhost:false` 默认、限速与 `dshlink harden`；手机接入前只剩“给手机发 device token”一步 |
| 插话发送 | 未列 | **0 人日**：0.4 已实现，App 只做“插话/排队”开关与 mode 参数 |

里程碑顺序建议：**P0 安全前置 ✅（0.5.0 已完成）→ A 阶段只读+导航 → A 阶段发送（steer/queue）→ B 阶段实时增量 → 多设备/通知**。

### 14.5 安全审计结论摘要

完整审计见 [docs/SECURITY-AUDIT.md](SECURITY-AUDIT.md)。与手机方案直接相关的三点：

1. **F1（高）**：`trustLocalhost=true` + FRP/代理回环转发 = 免 token 全权限；当前部署已具备该路径（对端 visitor 实测免 token 200）。手机如果经 STCP/本机反代接入，会直接落进这个洞。
2. **F2（中）**：一个 token 就是整节点权限（全部消息、files 含 allws 所有工作区、DSH transcript、可开启的能力通道）。手机 token 必须按最小权限发放，且 App 侧存 Keystore。
3. **F9（信息/中）**：远端消息正文会成为本机会话的 prompt（0.4 定向投递可直达真实会话），提示注入是本设计固有面；手机发送侧应二次确认，接收侧用 targets 收紧。

**结论（已随 0.5.0 更新）**：移动端功能可行，且**P0 安全前置已在 0.5.0 落地**——`trustLocalhost` 默认关闭，
`/api/v1/bridge/*` 只认本机桥或 bridge token，token 有角色/peer 绑定/过期，另有 1200 req/min 的每 token 限速。
手机接入时使用 `role: device` 的独立 token（只读 DSH 视图 + 受 capabilities 白名单控制的能力调用），
节点不再因为“源地址是 127.0.0.1”而裸奔。仍建议手机走 WireGuard/Tailscale，而不是把 STCP visitor 端口
直接暴露给手机；残余边界见 §14.8。

### 14.6 待确认问题（新增）

| # | 问题 | 影响 |
|---|---|---|
| D9 | 手机与节点之间能否用 WireGuard/Tailscale（而不是 STCP）？ | 决定安全前置工作量与是否需要 bridge token |
| D10 | 手机是否需要“发送”能力，还是只读？ | 需要则必须开 capabilities 动作方法 + 设计二次确认 |
| D11 | 是否需要按项目/工作区限制手机可见范围？ | 需要则先做 per-token scopes/exclude，而不是仅靠全局 excludeWorkspaces |
| D12 | 手机“回复”默认插话（steer）还是排队（queue）？ | 影响 App 交互与误打断风险；建议默认 steer、批量 queue |
| D13 | 是否接受无后台通知（只有打开 App 才同步）？ | 接受则 A 阶段足够；不接受则要做 B 阶段 SSE + Android 前台服务/推送 |
| D14 | ~~先做安全前置（P0）还是先做 A 阶段 MVP？~~ **已解决** | P0 已由 0.5.0 完成；用户已决定“先修鉴权，再做手机端”，下一步直接进 A 阶段 |

### 14.7 本节涉及的文件与端点

- 0.4 代码：`src/dshview.mjs`（transcript sinceSeq/latestSeq）、`src/ops.mjs`（dshTranscript）、`src/server.mjs`（transcript 路由）、`src/mcp.mjs`（link_dsh_transcript sinceSeq）、`bin/dshlink.mjs`（`--since-seq`）、`integrations/dsh-link-bridge/lib/index.js`（promptMode）、`integrations/dsh-link-bridge/lib/dshops.js`（sessions.prompt mode）。
- 文档：`docs/PROTOCOL.md`（transcript 游标）、`docs/DIRECTED-SESSIONS.md`（Queue vs steer）、`docs/SECURITY-AUDIT.md`（F1-F10）。
- 端点：`GET /api/v1/dsh/sessions/{id}/transcript?sinceSeq=&limit=&tail=`、`POST /api/v1/dsh/call`（sessions.prompt，params.mode）。

### 14.8 0.5.0 已实施的安全前置（2026-11-03）

> 本节取代 §2.2、§9 中「trustLocalhost 默认开启/免 token」的历史结论；§2/§9 保留为审计时的现场记录。

`docs/SECURITY-AUDIT.md` 的 P0 清单与 0.5.0 的对应关系：

| P0 项（审计原清单） | 0.5.0 状态 | 对手机方案的含义 |
|---|---|---|
| `auth.trustLocalhost` 默认关闭 | ✅ `defaultConfig()`/`normalizeConfig` 默认 `false`，只有显式 `true` 才恢复旧行为 | 手机无论经 STCP、FRP 还是反代到达，都必须带 token |
| bridge 专用 token | ✅ `role: bridge`；`/api/v1/bridge/*` 仅本机回环或 bridge token，远端 admin 也 403 `bridge_forbidden` | 桥与手机 token 分离；桥 token 泄漏不再等于全权限 |
| 每设备独立、可轮换 token | ✅ token 增 `role` / `peer` / `expiresAt`；`dshlink token new --role device --ttl-days N`、`token rm` 轮换 | 手机用 `role: device`，丢失即删 token，无需改节点配置 |
| 手机网络优先 VPN | ⏳ 部署建议 | 见 14.2：STCP 也能用，但建议 WireGuard/Tailscale 承担“成员资格”，token 作第二道门 |
| capabilities 保持最小集 | ⏳ 配置建议 | 手机若要“发送”，需显式把 `sessions.prompt` 加进 `capabilities.methods`，并按 peer 收紧 |

0.5.0 同时带来的抗攻击面：每 token/IP 1200 req/min 滑动窗口（超限 429 + `Retry-After`）、
peer token 强制 `from` 身份与收/发箱过滤、跨 peer relay 与 `/dsh/call` 转发仅 admin、
命令结果按发起 token 隔离、`dshlink doctor` 新增 trust-localhost / rate-limit / bind-exposure 检查。

手机侧仍需注意的残余风险：
1. 节点仍无 TLS（`http.createServer`）——VPN 或 HTTPS 反代负责传输加密；
2. `device` token 目前是“节点级只读”而非“按工作区只读”；要限制可见范围仍靠 `dsh.excludeWorkspaces` 与
   `capabilities.methods`（per-token scopes 尚未实现，见审计 F2 的“部分修复”）；
3. 无 SSE/WebSocket，A 阶段仍是按需轮询；实时推流属 B 阶段。

---

## 附录 A：证据索引

| 论断 | 证据 |
|---|---|
| 节点仅 /healthz 免鉴权 | src/server.mjs:9-10、:107-109 |
| token 鉴权 + 回环放行 + 限流 | src/server.mjs:39-45、:54-56、:58-62 |
| DSH 视图路由与参数 | src/server.mjs:250-286 |
| transcript limit 被夹 200 | src/ops.mjs:432-453；实测 limit=1000 返回 200 |
| transcript 无 since 游标 | src/dshview.mjs:884-931；实测 sinceSeq 被忽略 |
| 渲染行结构与多行同 seq | src/dshview.mjs:286-332 |
| 日志 zstd 多帧、32 MiB 上限、5 s 缓存 | src/dshview.mjs:10-13、:23、:25、:114-139、:896-912 |
| 动作方法默认未授权 | src/capabilities.mjs:19-39；实测 methods 仅 4 读方法 |
| dshCall 命令队列与结果 | src/ops.mjs:499-522；src/capabilities.mjs:242-361 |
| bridge 常驻 DSH host、默认 5 s 轮询 | integrations/dsh-link-bridge/README.md；lib/index.js:69、:301-314；lib/dshops.js:487-502 |
| 无 SSE/WebSocket 实现 | src/server.mjs:366-369；全仓库检索仅文档与 405 说明 |
| GET 视图不支持 peer、dshCall 支持 | src/server.mjs:250-286；src/ops.mjs:499-508 |
| trustLocalhost 经 FRP 绕过 token | 实测对端 http://127.0.0.1:19110/api/v1/info 免 token 200；src/server.mjs:54-56；docs/OPERATIONS.md:124-128 |
| FRP STCP visitor 只在节点本机 | src/tunnel.mjs:43-63；docs/FRP.md:92-118 |
| 静态 token、无设备作用域 | src/config.mjs:99-109、:210-240 |
| 审计只有 ip/token label | src/server.mjs:104、:237-239；实测 /api/v1/audit |
> 行号基准：以上行号于 2026-11-02 23:10 按工作区当前文件核对（HEAD 53b692f + 未提交的 v0.4 directed-reply 改动；该改动只影响 src/server.mjs、src/ops.mjs、src/mcp.mjs 的后续行号）。若后续提交使行号偏移，请以函数名/符号名为准。


## 附录 B：本轮探测方式（只读）

- 仅 GET：/healthz、/api/v1/info、/api/v1/status、/api/v1/peers、/api/v1/dsh/workspaces、/api/v1/dsh/sessions、/api/v1/dsh/sessions/{id}、/api/v1/dsh/sessions/{id}/transcript（多组 limit/offset/tail/since 参数）、/api/v1/dsh/capabilities、/api/v1/bridge/status、/api/v1/audit、/api/v1/messages、/api/v1/outbox、/api/v1/files。
- 未 POST、未重启节点/DSH host、未改配置；节点与 bridge 均为运行中实例，探测结束后未发现状态变化。
- 对端探测仅 GET /healthz 与 /api/v1/info（经验证免 token）。

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| 节点（node） | dsh-link 进程，监听 HTTP，管理 inbox/outbox/files/DSH 视图 |
| DSH host | DeepSeek Harness 主进程，托管会话；与节点同机、独立进程 |
| bridge | 运行在 DSH host 内的 dsh-link 插件，轮询节点命令队列并执行 |
| workspace / session | DSH 的工作区与对话；session 日志在 $DSH_HOME/sessions 下 |
| transcript | 节点把会话 zstd 日志解码后的行视图（含 seq/time/role/kind/text） |
| capability | 节点能力通道，read/action 两类方法，需显式授权 |
| STCP | FRP 的私密隧道模式，visitor 端口只在对端本机监听 |

---

补充材料：[docs/mobile/API-SKETCH.md](mobile/API-SKETCH.md)（端点、字段、错误码与 App 调用时序速查）。
