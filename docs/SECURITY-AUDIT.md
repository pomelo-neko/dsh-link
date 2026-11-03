# dsh-link 安全审计（0.4.0 审计 + 0.5.0 修复状态）

- 审计对象：D:/dsh-link 工作树（0.4.0，未提交；HEAD 53b692f + directed conversations / steer / sinceSeq 改动）
- 审计日期：2026-11-03
- 审计范围：节点 HTTP 服务、鉴权与 token 模型、消息与 relay、文件根、DSH 只读视图、能力通道、bridge 回环接口、部署与传输拓扑
- 方法：源码静态审计 + 本机运行实例只读探测 + 实际配置（脱敏）+ FRP 配置核对。未做破坏性测试、未尝试登录他人设备。
- 结论先行：**dsh-link 的安全边界是「能连上节点端口的人 = 可信成员」，而不是 token。审计时的部署（trustLocalhost=true + FRP 回环转发）下，任何能到达节点端口的人都会自动获得完整节点权限；接入手机前必须先决定是否接受这一边界。** 0.5.0 已把默认边界改为「每个请求都需要 token」，并给 bridge 独立角色，见下方 §0.5。

## 0. 一句话结论

在单机、单用户、对端只有自己另一台电脑的场景，当前风险可接受；一旦把端口开放给手机、更多 DSH 或任何不受完全信任的设备，**F1（trustLocalhost + 回环转发免鉴权）会让 token、transcript 只读等所有「权限控制」失效**，必须先修。其余风险（F2-F9）多为「token 即完整权限」的派生问题，按最小暴露面收敛即可。

## 0.5. 0.5.0 修复状态（2026-11-03）

0.5.0 针对本报告的 P0/P1 项做了实现，F1/F2/F3/F5/F8 已修复或有实质性缓解；F4/F6/F7/F9/F10 仍有残余风险，需要按部署方式收敛。

| 发现 | 0.5.0 状态 | 说明 |
|---|---|---|
| F1 免 token 全权限 | **已修复（默认）** | `auth.trustLocalhost` 默认 `false`，本机 MCP/CLI/bridge 也必须带 token；`/api/v1/bridge/*` 只接受本机进程或 `role: bridge` token，远端 admin token 返回 `403 bridge_forbidden`。显式把 `trustLocalhost` 设为 `true` 的旧配置仍保留原行为，`dshlink doctor` 会把它判为 FAIL。 |
| F2 单 token = 整节点 | **部分修复** | token 有 `role`（admin/bridge/peer/device）、可绑定 peer、可设 `expiresAt`；路由级 role 矩阵把 peer/device/bridge 的权限分开。仍没有 per-token 文件/工作区 scope：device 能看全部未排除的 DSH 视图，并**能提交 `capabilities.methods` 放行的动作**（手机发消息就靠这个，见 0.6）；手机 token 泄露等于该节点的 DSH 视图 + 被放行的动作，仍应短 TTL、按需吊销。 |
| F3 身份自述 + relay | **已修复（绑定 peer 时）** | 绑定 peer 的 token 不能伪造 `from.name`（`identity_mismatch`），relay 只允许 admin（`relay_not_allowed`），inbox/outbox 按其身份过滤。未绑定 peer 的旧 token 仍按 admin 处理——应轮换。 |
| F4 能力通道动作 | **缓解** | 路由 role 矩阵与 `capabilities.methods` 双层控制；手机应只给 `device` 或最小 methods，动作方法默认仍关闭。 |
| F5 消息不按接收者过滤 | **已修复（绑定 peer 时）** | `GET /messages` 按绑定的 peer 过滤 `from`，`/messages/:id` 读他人消息返回 `403 not_your_message`，read 端点同样逐条校验；`/outbox` 只返回发给该 peer 的消息。 |
| F6 本地进程伪造 bridge | **缓解** | bridge 控制面需要 `role: bridge` token（或本机 `trustLocalhost`）；本机文件权限仍是信任边界，命令结果仍无签名。 |
| F7 凭据明文落盘 | **未变** | 出站 `peers[].token`、frp secretKey/证书、DSH profile 里的 bridge/MCP token 仍是明文；收紧 ACL、不要让数据目录进共享根、备份加密。 |
| F8 DoS | **已修复（基础）** | `limits.maxRequestsPerMinute` 默认 1200（0=关），按 token id 或 IP 的 60 s 滑动窗口，超限 `429` + `Retry-After`；大 body/大文件仍受既有 `limits` 约束，公网仍建议反代限速。 |
| F9 远端消息 prompt 注入 | **设计如此，未消除** | 0.4 的 `targets.peers/allow/deny` 可收紧可达会话；桥 prompt 明确把远端正文当数据，但仍建议只对可信 peer 开定向投喂，bridge 使用低权限 preset。 |
| F10 元数据/可见范围 | **未变** | `bindings.json` 仍明文、`excludeWorkspaces` 仍是全局、不能按 peer 隔离可见工作区。 |

### 0.5.0 迁移（必须按顺序）

1. `dshlink harden --write`：关闭 `trustLocalhost`，铸造 `mcp-admin` 与 `bridge` 两个 token（明文只打印一次）。
2. `dshlink install-dsh --write --token <admin-token> --bridge --bridge-token <bridge-token>`：把 MCP 的 `headers.authorization` 与 bridge 的 `token` 写进 DSH patch。
3. 重启 dsh-link 节点与 DSH host，然后 `dshlink doctor --token <admin-token>`；`trust-localhost`、`rate-limit`、`bind-exposure` 应通过。
4. 对端/手机各铸独立 token：`dshlink token new --role peer --peer <对端名>` 或 `--role device --ttl-days 90`；不要把 admin token 给对端或手机。
5. STCP 的 `secretKey` 视为 root 凭据：只放本机、每设备独立、丢失即轮换；frps 用 `allowUsers` 收紧。

### 0.5.0 验证命令（本机）

```powershell
# 1) 未带 token 应 401（healthz 除外）
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:8787/api/v1/info
# 2) admin token 可以，但 bridge 控制面只认本机/bridge token
curl.exe -s -o NUL -w "%{http_code}\n" -H "Authorization: Bearer <admin>" http://127.0.0.1:8787/api/v1/bridge/status
curl.exe -s -o NUL -w "%{http_code}\n" -H "Authorization: Bearer <bridge>" http://127.0.0.1:8787/api/v1/bridge/status
# 3) 角色矩阵：device 不能读 /peers
curl.exe -s -o NUL -w "%{http_code}\n" -H "Authorization: Bearer <device>" http://127.0.0.1:8787/api/v1/peers
# 4) 自检
node bin/dshlink.mjs doctor --token <admin-token>
```

预期：1) 401；2) admin→403 `bridge_forbidden`、bridge→200；3) 403 `role_forbidden`；4) trust-localhost PASS。

## 1. 信任模型

dsh-link 的显式设计（README / PROTOCOL）是「参与者相互认识，权限管理靠人」：

- 网络可达性 = 成员资格（能连上 8787 或 FRP visitor 端口的设备就是成员）。
- 一个节点 token 代表**整台节点的全部 API**，不区分 peer / 设备 / 会话。
- bridge 的自动唤醒会把远端消息正文作为 prompt 注入本机会话，属于设计功能，不是漏洞；但它把「远端消息」提升为「可影响本机会话行为的输入」。

因此下文的严重度按「暴露范围」评估：仅回环 → 低；仅自己另一台设备 → 中；手机/多设备/公网可达 → 高。

> 以下 §1–§8 是 0.4.0 审计原文，用于说明问题和攻击路径；哪些已修复见上方 §0.5。

## 2. 发现总表

| # | 严重度 | 发现 | 影响 | 现状是否触发 |
|---|---|---|---|---|
| F1 | **高（接入手机后为严重）** | trustLocalhost 经回环转发（FRP/代理/SSH 隧道）把远端连接当成 localhost，免 token；bridge 回环接口同样被绕过 | 免 token 读全部消息/文件/DSH transcript，调用 dsh/call 转发、领取命令、伪造结果、bind 任意会话，进而向任意本机会话注入 prompt | **是**（frpc STCP localIP=127.0.0.1，visitor 已对端可用，实测免 token 200） |
| F2 | 中 | 单 token = 整节点权限：inbox/outbox、files（含 allws 所有工作区）、DSH view 全部未排除会话/transcript、能力调用 | token 泄露 = 整机数据 + 可开启的 DSH 控制权；手机 token 尤其敏感 | 是 |
| F3 | 中 | 消息 from 字段完全自述，relay 原样转发任意 to；token 不绑定 peer 身份 | 持有任一 token 者可冒名、可借节点向其他 peer 转发消息 | 是（relay.enabled=true） |
| F4 | 中低 | 能力通道动作方法（sessions.prompt/create/rename/archive）一旦放开，任何 token 持有者可按全局 methods 驱动 DSH | 手机 token 泄露 = 可向任意会话发 prompt（受 allow/deny 约束） | 否（当前 methods 仅 4 个只读） |
| F5 | 中低 | GET /api/v1/messages 返回全部 inbox、GET /api/v1/outbox 未给 to 时返回全部 outbox | 多 peer 场景下任一对端可读本节点与其他 peer 的全部往来 | 是（当前只有 1 个 peer，风险低） |
| F6 | 低 | 桥命令结果接口可被本机任意进程伪造；bindings.json/命令队列可被本地进程改写 | 本地提权/恶意进程可劫持 bridge；本地边界通常视为可信 | 取决于本机 |
| F7 | 低 | 出站 token、FRP secretKey、frp 证书私钥明文落盘（inbound token 已 hash） | 备份/共享目录/截图泄露 = 凭据泄露 | 是 |
| F8 | 低 | 仅认证失败有节流（60s/20 次），无通用限速 | token 持有者可用大 body/大文件/transcript 解码做 DoS | 是（低优先级） |
| F9 | 信息/中 | 远端消息正文会被当 prompt 注入本机会话（bridge auto-wake） | 提示注入：远端可让 agent 执行其会话工具允许的动作；0.4 定向投递把可达面从桥会话扩大到真实会话 | 是（设计如此） |
| F10 | 信息 | bindings.json 仅存 thread→sessionId；DSH view 直接读盘；excludeWorkspaces 是全局而非 per-peer | 定向路由元数据泄露会话 id；无法按 peer 隔离可见工作区 | 是 |

## 3. 详细发现

### F1（高）trustLocalhost + 回环转发 = 免 token 全权限

**证据**

- src/server.mjs:9：LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])。
- src/server.mjs:47-56：先试 token；失败后 if (cfg.auth.trustLocalhost && LOCAL_ADDRESSES.has(...)) return { ok: true, via: 'localhost', token: null, ip }。
- src/config.mjs:52、:100：trustLocalhost 默认 true，只有显式 false 才关闭。
- src/server.mjs:244-248：bridge 回环接口只检查 ctx.auth?.via === 'localhost' || 'open'；合法 token 反而会被拒（via === 'token'）。
- 实际 FRP 拓扑 C:/Users/example/.dshlink/frp/frpc.toml：[[proxies]] ... type="stcp" localIP="127.0.0.1" localPort=8787；visitor 绑定 127.0.0.1:19110。即对端所有流量都以 127.0.0.1 到达节点。
- 实况 C:/Users/<you>/.dshlink/dshlink.config.json：auth.trustLocalhost=true；节点 bind 127.0.0.1:8787。
- 既有实测（0.3 时期，仍适用）：从对端经 visitor 访问 http://127.0.0.1:19110/api/v1/info，不带 token 返回 200。

**攻击路径（无需任何凭据）**

1. 能连上 visitor 端口（对端本机端口，或经隧道转发的手机/其他设备）→ 请求源地址被节点识别为 127.0.0.1 → 免 token。
2. 可读：GET /api/v1/messages（全部收件箱）、/api/v1/outbox（全部发件箱）、/api/v1/dsh/workspaces、/sessions、/transcript（全部未排除会话内容）、/api/v1/files（含 allws 所有工作区文件）、/api/v1/audit。
3. 可写：POST /api/v1/messages 直接投递任意消息（含 0.4 的 targetSession，可让 bridge 把消息投进任意指定会话）；POST /api/v1/bridge/bind 建任意 thread→session 绑定；GET /api/v1/bridge/commands 领取本应交给本机 bridge 的命令（可读到待执行 prompt，并让 bridge 抢不到命令）；POST /api/v1/bridge/commands/:id/result 伪造执行结果。
4. POST /api/v1/dsh/call：body 带 peer 可借本节点把能力调用转发给其他 peer（本节点只校验本地 capabilities 的 methods 列表；转发路径在 src/ops.mjs:504-513，未做本地 authorizeCall）。
5. 本机 capabilities 若开启动作方法，loopback 来源的 origin.peer 为 127.0.0.1（src/server.mjs:292），会按全局 methods 放行（src/capabilities.mjs:99-112；peer 级 allow/deny 对空 peer 不生效）。

**组合影响（与 0.4 定向会话叠加，最危险）**

0.4 的 targetSession + 自动唤醒意味着：**能免 token 写 /api/v1/messages 的人，可以直接把任意文本作为 prompt 注入到任意 DSH 会话**（通过 bridge 投递），无需拿到 DSH 的 MCP/控制接口。配合 prompt 注入，等于远程影响本机 agent 行为。这比 0.3 只落到桥会话严重一档。

**缓解**

- 立即（不改代码）：
  - 不要把 visitor 端口暴露到 LAN/公网；只在自己完全信任的设备上使用。STCP secretKey 视同 root 凭据。
  - 节点 bind 保持 127.0.0.1；FRP proxy/visitor 均保持 127.0.0.1；frps 用 allowUsers 收紧。
  - 若要临时关闭风险：停用节点或 frpc（但节点/桥会失效）。
- 必须改代码才能安全做到（建议 0.5）：
  - 为 bridge 增加「专用角色」：requireLoopback 除 localhost 外，允许持有 label === 'bridge' 的 inbound token 的请求（或引入 auth.bridgeTokenId）。这样可安全设置 auth.trustLocalhost:false，bridge 配置里配对应 token。
  - 或引入本地 IPC（Unix socket / 命名管道）承载 bridge 通道，不再经过 HTTP 回环。
  - 给 /api/v1/dsh/call 的 peer 转发路径加本地 authorizeCall 校验，并默认拒绝 peer 未在 capabilities.peers 中显式授权的转发。
- 手机接入前必须完成上述之一；否则手机/任何拿到 visitor 端口访问权的设备 = 节点 root。

### F2（中）单 token = 整节点权限

**证据**：src/config.mjs:210-240（token 只存 hash；verifyToken 返回 {id,label}，不绑定 peer/设备/scopes）；所有 API 路由共用同一 authorize。当前 10 个 inbound token 的 label 仅为 peer-default / win-laptop / invite:*，没有设备/作用域信息。

**影响**：任何 token 持有者都可以读取 files 根（实际配置含 allws：所有 DSH 工作区文件）、全部 transcript、全部消息；如果开启 actions，还能驱动 DSH。手机丢失/token 被 backup 带走 = 全量泄露。

**缓解**：每设备一 token（已在做）；文件根只留最小集合（例如去掉 allws，或改成只读单目录）；excludeWorkspaces 扩大；不需要看 transcript 时关闭 exposeTranscripts；未来加 scopes（dsh:read / dsh:prompt / files:read）与 token 吊销 UI（B 阶段）。

### F3（中）消息身份自述 + relay 原样转发

**证据**：信封 from 是发送方自行填写（src/ops.mjs buildMessage），acceptMessage 不校验来源（src/ops.mjs:333-349）；relay 分支把原 record 原样转发给目标 peer，只补 relayedBy。实况 relay.enabled=true。

**影响**：持有任一 token 的人可冒用任意 from.name 发消息（bridge 用 from.name 决定回信目标）；可借本节点向其他配置 peer 转发任意内容（POST /api/v1/messages 的 to 指定对端名字）。审计只能看到 IP/label，不能证明身份。

**缓解**：只在对端可信时开 relay；可考虑 token→peer 绑定（配置 peers[].token 的 label 与 from 校验）；关键动作在消息正文里带 nonce/签名（超出当前设计）。

### F4（中低）能力通道动作方法

**证据**：src/capabilities.mjs:19-28 定义 action 方法（sessions.prompt 等），默认 methods 只读（:30-39）。实况 capabilities.enabled=true 但 methods 只有 4 个读方法，peers 为空。

**影响**：一旦把 sessions.prompt/sessions.create 加进 methods，任何有效 token（或 F1 绕过者）都能按全局 methods 驱动 DSH；peer 级 allow/deny 只对有名字的 peer 生效。手机「控制发消息」必须开这个，等于把控制权交给手机 token。

**缓解**：只给需要的 peer 开 peers.<name>.allow；为手机单独 token + 仅 sessions.prompt；动作方法要求二次确认（App 侧）；审计/通知。

### F5（中低）入站/出站消息不按接收者过滤

**证据**：src/server.mjs:132-143 GET messages 返回全 inbox；:161-171 GET outbox 未给 to 时返回全部；/messages/:id 可读任意 id。

**影响**：多 peer 时任一 token 持有者可读本节点与其他 peer 的全部往来（含附件元数据、正文）。当前仅 1 个 peer，风险低；手机加入后变多设备。

**缓解**：多 peer 时按 peer 过滤；更好的做法是 token→peer 身份绑定后再做 box 过滤（当前 from 可伪造，纯按名字过滤不安全）。

### F6（低）本地进程可伪造 bridge 通道

**证据**：bridge 回环接口只验「来自 localhost」；命令 result 无签名。任何本机进程都能 POST result / bind / 读命令。

**影响**：本地恶意进程可劫持 bridge 命令；本地通常视为可信边界，且 DSH host 本身被入侵时已无安全可言。

**缓解**：bridge token 角色（同 F1）；本地文件权限（state/commands 目录 ACL）。

### F7（低）凭据明文落盘

**证据**：inbound token 只存 sha256（好）；outbound peers[].token 必须明文（通信需要）；frpc auth.token/secretKey/证书私钥明文；commands/ 下的 prompt 与结果明文；audit 记录 IP/label。

**影响**：备份、共享、截图、误提交导致凭据泄露。

**缓解**：这些文件放在 DSH 数据目录之外并收紧 ACL；C:/Users/example/.dshlink/frp 不要放共享目录；备份加密；不要截图 token。

### F8（低）DoS 面

**证据**：认证失败 60s/20 次节流（src/server.mjs:57-62），无其他限速；body 上限 32MB、message 1MB、inline attachment 512KB；transcript 解码有 32MiB 上限与 5s 缓存，但大日志仍可耗 CPU。

**影响**：无 token 者只能撞认证；token 持有者（或 F1 绕过者）可反复大请求拖慢节点/DSH。

**缓解**：反向代理层限速；只对可信网络开放；未来加 per-IP/per-token 速率限制。

### F9（信息/中）远端消息 → prompt 注入

**证据**：bridge tick 把消息正文渲染进 prompt（integrations/dsh-link-bridge/lib/index.js DEFAULT_PROMPT 与 renderPrompt），随后 sessionController.prompt({mode}) 注入会话；0.4 定向投递可直接落在真实用户会话。

**影响**：对端（或其被污染的账号/设备）可以写入「忽略之前指令…」之类内容，借目标会话的工具权限行动。桥的 DEFAULT_PROMPT 已声明「把远端消息当数据」，但 LLM 不可靠。

**缓解**：targets 收紧（只允许特定 peer / 会话）；定向投递前人工确认（未来 feature）；桥会话使用低权限 preset；把自动唤醒限制在可信 peer。

### F10（信息）元数据与可见范围

- bindings.json 明文保存 thread→sessionId（不含正文），可推断本机哪些会话参与过跨机对话；文件权限默认继承用户目录。
- DSH view 直接读 $DSH_HOME/sessions 日志，不依赖 DSH 进程；excludeWorkspaces 是全局过滤，无法按 peer 区分。
- 当前 exclude 包含 D:/dshlink-bridge 与 C:/Users/<you>/.dshlink，但其他 10 个工作区全部可见（包括 D:/agent-workspace、D:/other-project 等）。

## 4. 分场景加固清单

### 场景 A：单机回环（当前，只有本机使用）

- 保持 bind 127.0.0.1；不外发 visitor 端口；frpc 仅本机使用。
- 暂时保留 trustLocalhost:true（bridge 需要）；风险接受。
- 定期 dshlink token list 清理不用的 token；dshlink peers list 检查对端。

### 场景 B：两台自己的机器（当前跨机场景）

- 在 A 基础上：每台机器用独立 inbound token；peers[].token 只给对端；FRP secretKey 强随机且只存本机。
- 对端 dsh.enabled、files roots 按最小暴露面配置；不需要看 transcript 时关闭。
- 定期检查 /api/v1/audit 是否有异常 IP（当前审计只有 ip/token label，见 F2/F10）。

### 场景 C：手机接入（用户正在评估）

**前置条件（二选一）**：

1. **推荐：私有 VPN（Tailscale/WireGuard）+ 信任边界改为 token**
   - 手机装 VPN，节点只监听 VPN 地址（或 127.0.0.1 + 反代但必须解决回环问题）。
   - 节点 auth.trustLocalhost:false；bridge 用专用 token（需先实现 F1 的 bridge 角色），否则 bridge 会 403。
   - 手机使用独立 token（未来 scopes：dsh:read + dsh:prompt + 可选 files:read）。
   - 手机 App 端 token 存 Android Keystore；不写入日志/备份。
2. **不推荐直接 STCP 给手机**：STCP 的 visitor 必须运行在手机侧（frpc/等价物），最终节点看到的源地址是 127.0.0.1，绕过 token，等于把 F1 暴露给手机及任何拿到 secretKey 的设备；且 Android 后台常驻 frpc 体验差、secretKey 泄露面大。若坚持 STCP，至少：visitor 只在手机、secretKey 每设备独立、frps 的 allowUsers/端口 ACL 收紧、手机丢失即轮换 secretKey，并接受「手机 = 节点 root」。

**其他**：手机侧不后台轮询（用户已要求）；按需拉取；传输层用 TLS（VPN 内可接受 HTTP，公网必须 HTTPS 反代）；App 通知内容脱敏；二次确认发送；审计记录设备 label。

## 5. 验证清单（可在本机执行）

1. 确认节点只监听回环：
   Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
2. 确认 frpc 的 localIP/visitor 绑定（脱敏查看）：
   Select-String -Path C:/Users/example/.dshlink/frp/frpc.toml -Pattern 'localIP|bindAddr|bindPort|type|name'
3. 确认 trustLocalhost 与 token 数量（不打印明文）：
   node -e "const c=require('C:/Users/<you>/.dshlink/dshlink.config.json'); console.log({trustLocalhost:c.auth.trustLocalhost, tokens:c.auth.tokens.length, peers:c.peers.map(p=>p.name), relay:c.relay, caps:c.capabilities.methods})"
4. 从另一台机器（经 visitor 端口）验证是否免 token；预期 200 = 存在 F1：
   curl.exe -s -o NUL -w "%{http_code}%n" http://<对端地址>:<visitorPort>/api/v1/info

**判据**：第 4 步返回 200 且没有带 Authorization ⇒ 该路径完全绕过 token。

## 6. 与移动端方案的关系

- 移动端 App 的只读视图（workspaces/sessions/transcript）在现有 API 上已可用，但每个 token 都能看全部未排除工作区；若手机只用于控制某个项目，需要先做 excludeWorkspaces 或未来的 per-token 可见范围。
- 控制面（sessions.prompt）需要 capabilities.enabled=true + methods 含 sessions.prompt + bridge 常驻。这是「手机 = 可向 DSH 发 prompt」的授权，必须配合手机 token 的最小权限与二次确认。
- 按需同步（用户 m00512 的方案）与安全无关；0.4 已提供 sinceSeq/latestSeq 增量游标，手机可以不后台轮询、只在前台按需拉取（详见 docs/MOBILE-CONTROL-FEASIBILITY.md 第 14 节）。
- **结论：移动端功能上可行，但当前鉴权边界不适合直接暴露到手机；建议先做 F1 的 bridge token/本地 IPC 与 trustLocalhost:false 迁移，再开手机端实现。**

## 7. 建议的后续工作（按优先级）

| 优先级 | 工作 | 估计 |
|---|---|---|
| P0 | bridge 专用 token 角色（requireLoopback 接受 label=bridge 的 token）或本地 IPC；文档迁移 trustLocalhost:false | 0.5–1 人日 |
| P0 | 手机接入前完成：隧道/VPN 选型 + 每设备 token + 最小 files/DSH 暴露 | 0.5 人日（配置） |
| P1 | /api/v1/dsh/call 转发路径加本地 authorizeCall；peer 显式 allow 才转发 | 0.5 人日 |
| P1 | 每设备 token + 可选 scopes（dsh:read / dsh:prompt / files:read）+ 吊销 UI | 2–3 人日 |
| P2 | 多 peer 时消息/outbox 按 peer 过滤（依赖 token→peer 身份绑定） | 2–3 人日 |
| P2 | 通用速率限制、TLS/反代、审计增加 device/tokenId | 1–2 人日 |
| P3 | 提示注入防护（可选：对远端消息做结构化标记、二次确认） | 研究项 |

## 8. 审计限制

- 未做渗透测试、未尝试从外部网络实际访问（仅本机回环探测与配置核对）。
- 未审计 DSH 本体及其插件（D:/dsh-home）；本报告只覆盖 dsh-link 及其 bridge。
- 未审计 frps 服务端配置（远端 203.0.113.10）；只核对了本机 frpc。
- 行号与配置快照为 2026-11-03 工作树/运行实例，后续改动可能偏移；以函数名与配置键为准。
