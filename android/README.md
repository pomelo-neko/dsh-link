# dsh-link 控制端（Android）

一个**手机控制端**，不是移动版 DSH 节点：它不加入 dsh-link 网络，只连接到一台已经在跑的
dsh-link 节点（0.3.0 起的单节点模式）或一个 dsh-link 中心服务器 hub（0.4.0 新增的 hub 直连
模式），把入口背后的 DSH 工作区/会话/transcript 显示在手机上，并通过能力通道
（`sessions.prompt`）向指定会话发消息。

- 包名：`dev.dshlink.control`，版本 `0.7.0`（versionCode 10），minSdk 26，targetSdk 36
- 纯 Java + Android 平台 API，**无 Gradle、无 AndroidX**；唯一第三方库是 vendored 的
  ZXing core 3.5.3（Apache-2.0，仅用于解码二维码，见 §1.4 与 §3.1）
- 不常驻、不后台轮询：列表在进入/手动刷新时拉一次；会话界面只在 **前台可见期间** 每 2.5 s 拉一次增量
- 0.3.0：连接后可选择该节点网络里**直连**的其他节点并远程读写/发消息；标注子智能体会话；
  连续的工具调用/结果折叠成一行，点击展开；内置 STCP 中转改指 **8788 token 网关**
- 0.4.0：连接后先探测 `/api/v1/info`，`role:"hub"` / `software:"dsh-link-hub"` / 带
  `nodes` 数组的入口自动进入 **hub 模式**：节点下拉来自 hub 登记表，工作区/会话/transcript/
  发送全部带 `peer=<节点>` 由 hub 转发；默认端口 8790，STCP 模板用 hub 版（本地 18790）
- 0.5.0：**分发化**——通用 APK 不含任何 frps/STCP 凭据，可以直接发给别人；用户从 hub 管理员
  拿到 `dshlink1:` 连接串/配置文件，在 App 里“导入连接串/配置文件”或“从文件导入”，App 把
  自己的隧道 profile 写进私有目录后连接。新增 `-Release` 签名构建、`assets/tunnel/` 改为可选、
  构建产物附带 SHA-256 清单（见 §3）
- 0.6.0：**一次性引导 + 每设备 mTLS 证书**（`dshlink2:` 连接串）。手机本地生成密钥对、只发
  公钥，用一次性引导码换取只属于这台手机的客户端证书，之后所有请求走 mutual TLS、不再携带
  device token；连接串里的自签 CA 是唯一信任锚。0.5.0 的 `dshlink1:` token 路径完全保留，
  导入时按前缀分流，主界面显示当前安全模式（见 §1.3）。
- 0.6.1：修复 **含内置隧道的 dshlink2 连接串误报“frpc 未能在 20 秒内建立中转”**。隧道就绪
  探测原为 HTTP GET /healthz，而 phone gateway 是 HTTPS(mTLS) 监听，明文 HTTP 必然失败；
  改为协议无关的 TCP 连接探测（见 §5 与验证记录）。这是真机走阿里云 phone-frps 的前置修复。
- 0.6.2：**二维码导入连接串**。hub 控制台把约 7 KB 的 dshlink2 连接串切成多帧动态二维码
  （帧文本 `dshlinkqr:<index>/<total>:<chunk>`，默认 chunk 900、最多 32 帧）；App 新增
  「扫描二维码（相机）」连续扫描，以及「从文件导入」一次多选多张二维码图片离屏拼装。
  拼齐后仍走既有 ConnectProfile 校验与导入/连接流程，不绕过任何校验（见 §1.4）。
- 0.7.0：**界面重做**为 工作区 / 连接 / 设置 三个功能区（窄屏底部 tab，≥600dp 左侧栏），
  工作区列表与对话回归应用主体；对话样式对齐 DSH / DeepSeek 手机端（用户右侧气泡、reasoning
  默认折叠），并**内置 Markdown 渲染**（标题/列表/表格/围栏代码/行内代码/可点击链接）；修正
  已 enroll 节点被显示成 hub 名的身份问题；设置页可查看当前连接并一键清除（见 §1.5）。
- 深色不需要；UI 中文

> 可行性研究、方案对比与威胁模型见 [`docs/MOBILE-CONTROL-FEASIBILITY.md`](../docs/MOBILE-CONTROL-FEASIBILITY.md)；
> 架构、API 映射与验证记录见 [`docs/mobile/CONTROL-APP.md`](../docs/mobile/CONTROL-APP.md)。

---

## 1. 它做什么

```text
连接节点 (URL + token)
  ├─ 网络扫描           GET /api/v1/network/nodes?depth=2&maxNodes=50
  │    └─ 选择直连节点后，后续 DSH 请求都带 &peer=<节点名>（经入口节点转发）
  └─ 工作区列表          GET /api/v1/dsh/workspaces[?peer=…]
       └─ 会话列表        GET /api/v1/dsh/sessions?workspace=…[&peer=…]
            └─ 会话界面    GET /api/v1/dsh/sessions/{id}/transcript?tail=1&limit=200[&peer=…]
                 ├─ 前台增量  GET …/transcript?sinceSeq=<lastSeq>&limit=200   （每 2.5 s）
                 ├─ 更早消息  GET …/transcript?tail=1&offset=<loaded>&limit=200
                 └─ 发送     POST /api/v1/dsh/call { sessions.prompt, waitSeconds:20, peer? }
                              └─ 未完成时 GET /api/v1/dsh/call/{commandId} 轮询到终态（仅入口节点）
```

> 截图说明：0.3.0 的主界面（含“控制节点”下拉框）、会话列表（“子智能体 ·”前缀与
> “（3 个子智能体）”计数）、展开的工具组，以及经 8788 网关中转连接后的界面都已验证；
> 这些截图含真实主机名/局域网地址/会话标题，**不随仓库提交**，仅本地留存在 `test/.tmp/`
> （已 gitignore）。UI 细节见 `docs/mobile/CONTROL-APP.md` §4 与本文 §7。

0.3.0 内置阿里云 STCP 中转（勾选后不填节点地址，App 自己启动 frpc visitor，落到 8788 网关）；
0.5.0 起凭据不再内置，改为导入 hub 管理员给的连接串（§1.2）。经中转连接与收到的真实 DSH
回复见 `docs/mobile/CONTROL-APP.md` §4。

### 1.1 hub 直连模式（0.4.0）

0.4.0 起 App 支持“手机只连中心服务器”：连接任意入口后先 `GET /api/v1/info`，若返回
`role:"hub"` 或 `software:"dsh-link-hub"`（或带 `nodes` 数组）即进入 hub 模式；否则就是
0.3.0 的单节点模式，行为不变。

```text
连接中心服务器 (URL + hub token，默认 http://<hub>:8790)
  ├─ 节点登记表   GET /api/v1/network/nodes              （去掉 hub 自身）
  ├─ 能力探测     GET /api/v1/dsh/capabilities?peer=<节点>
  └─ 工作区列表   GET /api/v1/dsh/workspaces?peer=<节点>
       └─ 会话/transcript/发送全部带 peer=<节点>
            ├─ 发送   POST /api/v1/dsh/call {peer, method:"sessions.prompt", params:{…}, waitSeconds:20}
            └─ 结果   GET /api/v1/dsh/call/{commandId}?peer=<节点>   （App 轮询到终态）
```

- **默认节点**：`/api/v1/info` 的 `defaultNode`（若已登记且在线）→ 否则第一个在线节点 →
  否则第一个节点。节点行显示“（在线）/（离线 · 最后心跳 …）”；选中离线节点会提示并回退，
  不会向 hub 发无谓的转发请求。
- **失败提示**：节点离线或 hub 回 `502 upstream_unreachable` 时，只在页内显示“读取 <节点>
  的工作区失败：…”并保留切换节点的能力，不弹模态框；只有 hub 本身不可达/鉴权失败才弹窗。
- **发送**：hub 模式按设计走 `POST /dsh/call`，`waitSeconds:20`；若 20 秒内没到终态（bridge
  正在处理），先显示“已提交/由 <节点> 处理”并按 `GET /dsh/call/{id}?peer=` 继续轮询到终态。
- **登记表为空**：显示“中心服务器还没有登记节点”及 `dshlink hub enroll` 提示，不当作错误。

- **节点选择（0.3.0）**：连接成功后 App 额外拉一次 `/api/v1/network/nodes?depth=2`，把入口节点
  网络里的节点放进“控制节点”下拉框。默认选当前节点（本机直连）；选中另一个**直连**节点后，
  工作区/会话/transcript/发送全部带 `peer=<节点名>`，由入口节点转发。经其他节点中转才能到
  的二跳节点只展示、不可选（避免入口节点变成整网代理）。
- **子智能体标注（0.3.0）**：会话列表对 `origin:"subagent"`、有父会话或 `delegationDepth>0` 的
  条目标题加“子智能体 · ”，副标题显示父会话前 8 位与深度；工作区行显示“（N 个子智能体）”。
- **工具调用折叠（0.3.0）**：连续的工具调用/工具结果行折叠成一行
  （`#seq · 工具调用 · N 条 · HH:mm:ss · 点击展开`），点开后才显示每条的工具名与正文；
  折叠只影响显示，不影响原始消息。
- **只读模式**：若 `/api/v1/info` 显示 `capabilities.enabled=false` 或 `methods` 不含
  `sessions.prompt`，App 顶部提示“只读模式”并禁用输入框；浏览功能不受影响。远程节点则看
  它自己的能力白名单（被拒绝时 App 显示对端返回的错误）。
- 命令由节点上的 **dsh-link-bridge**（DSH Host 插件）执行，因此发送要求 DSH host 正在运行、
  bridge 未被禁用。命令的 `result.accepted=true` 只表示 bridge 已受理，模型的回复要继续看
  transcript 增量。
- “插话（steer）”勾选后，`sessions.prompt` 带 `mode:"steer"`：插到 DSH 下一步边界执行，
  优先于排队回合；不勾选则用默认 `queue`。

### 1.2 分发模式：导入连接串/配置文件（0.5.0）

0.5.0 起 App **不再内置任何 frps/STCP 凭据**，所以通用 APK 可以分发给任何人：连哪台 hub、
用哪套隧道，由 hub 管理员生成的“连接串/配置文件”决定。管理员在 hub 侧执行：

```powershell
dshlink hub invite --phone --label phone --ttl-hours 2 --out phone.dshlink
# 可选：--url http://<hub>:8790   指定入口地址（默认 http://127.0.0.1:18790）
# 可选：--no-tunnel                不打包 STCP 隧道，只给入口地址 + token
# 可选：--max-uses N --note <备注> 控制 code 使用次数/加说明
```

hub 的 Web 面板也有对应入口（“手机连接码”，同一个 `POST /api/v1/hub/phone-invite`）。

code 是 `dshlink1:` + `base64url(gzip(JSON))`，里面包含：

- 入口地址（`entry.kind` 为 `hub` 或 `node`）与一个 **device token**（默认限时，可吊销）；
- 可选的 STCP visitor 配置：`frpc.toml` 文本（含 `{{DIR}}` 占位）+ 实际带上的 mTLS 证书；
- label / 签发时间 / 到期时间等元数据，用于 App 里展示。

手机上的操作（二选一）：

1. **粘贴**：点“导入连接串/配置文件”→ 把整段 `dshlink1:…` 贴进对话框 → 导入。
2. **文件**：管理员把 code 保存成文件（`--out` 生成，或文本另存为 `.txt/.json/.dshlink`），
   传到手机 → 点“从文件导入”→ 选择该文件。

导入后 App 的行为：

- 弹窗显示摘要（标签 / 入口 / 到期时间 / 是否含隧道 / 备注），成功后自动连接；
- **含隧道**：把 `frpc.toml` 和证书写到应用私有目录 `files/tunnel/`，勾选“通过阿里云 STCP
  中转”，启动内置 frpc 后用本地端口连接。本地端口从 `frpc.toml` 的 `bindPort` 读取
  （hub 生成的模板默认 18790）；导入时只要求 `frpc.toml` 实际引用的证书文件存在；
- **含隧道但写文件失败/缺文件**：提示“导入的隧道配置缺少 xxx，请重新导入连接串/配置文件”；
- **不含隧道**（`--no-tunnel`）：清掉旧的 `files/tunnel/frpc.toml` 与证书、取消勾选隧道，
  直接连 `entry.url`（要求手机能 LAN/VPN 到 hub）；
- URL、token、隧道勾选框自动填好；App 只保存这一份配置，重新导入整体替换；
- 非法 code / 文件：弹“导入失败”并说明原因，不会崩溃；过期 code 仍可导入，但会提示
  “该连接配置已过期，连接可能被拒绝；请让 hub 管理员重新生成”。

> 兼容：内部部署仍可把 `assets/tunnel/` 打进 APK（构建脚本检测到 4 个文件齐全时会警告
> “this APK will contain tunnel credentials”）。带凭据的 APK 只能内部使用、不要分发；
> 没有 `assets/tunnel/` 时构建出的是通用 APK，运行时若勾选了隧道却还没导入配置，App 会
> 提示“尚未导入隧道配置，请向 hub 管理员获取连接串/配置文件并导入”。0.6.0 起
> `dshlink1:` 与 `dshlink2:` 两种连接串都接受（见 §1.3）。

### 1.3 一次性引导 + 每设备 mTLS 证书（dshlink2，0.6.0）

0.6.0 的主推入口是 **`dshlink2:` 连接串**：手机不再携带长期 device token，而是在第一次连接
时用一枚**一次性引导码**换取**只属于这台手机的客户端证书**，之后所有请求走 mutual TLS，
`Authorization` 头不再需要。连接串即使被转发给别人也无法使用：引导码只能用一次、只接受公钥，
且证书与手机本地的私钥绑定。

hub 侧（0.10+，需先 `dshlink hub phone setup` 启用手机网关）：

```powershell
# 生成一份 dshlink2 引导码（默认 2h 有效、只能用一次；--no-tunnel 表示手机直连 gateway）
dshlink hub phone bootstrap --data-dir <hub数据目录> --label pixel-9 --ttl-hours 2 `
  --no-tunnel --url https://<hub>:8791 --out phone.dshlink2
# 查看 / 吊销手机设备
dshlink hub phone devices
dshlink hub phone revoke <deviceId|指纹>
```

code 是 `dshlink2:` + `base64url(gzip(JSON))`，包含 `entry.url`（必须 https）、
`gateway.caPem`/`caFingerprint`（hub 自签 CA，App 把它当作**唯一信任锚**，并校验证书链、
主机名与 serverAuth 用途）、一次性 `bootstrap.{id,secret,expiresAt}`、可选的
`tunnel.{frpc,files,bindPort}`（结构与 0.5.0 完全相同）与 label/到期时间。
**兑换成功后 App 立即从存储里删除引导码 secret**，code 本身也不再可复用。

手机上的流程（导入方式与 1.2 相同：粘贴 / 从文件导入 / 其他 App 用 `text/plain` 分享进来）：

1. 导入后 App 显示摘要，自动生成/复用设备身份（首次生成随机 UUID 并持久化，证书
   `CN=<deviceId>`）与私钥（默认 **AndroidKeyStore 不可导出**），只把 **SPKI 公钥**
   POST 到 `https://…/api/v1/phone/bootstrap`；
2. 服务端用连接串里的 CA 校验并发证，返回 `certPem` + `fingerprint` + `validTo`
   （默认 365 天）；App 保存证书、删除 bootstrap secret，然后用 mTLS 连接；
3. 之后每次连接：`GET /api/v1/phone/me`（刷新证书指纹/到期）→ `GET /api/v1/info` →
   与 0.4.0 相同的 hub/节点模式；请求**不带 device token**，客户端证书就是凭据；
4. 主界面显示“安全模式：每设备证书（mTLS） · CA <指纹>；设备证书 <指纹> · 到期 … ·
   私钥 AndroidKeyStore（不可导出）”，token 输入框禁用并提示 dshlink2 不需要 token。

**重置与吊销**：主界面新增“重置设备证书”（清证书保留设备身份 / 连 deviceId 一起换 /
导入新的 dshlink2 引导码）与“清除导入配置”。服务端吊销后 App 下次请求收到
`403 phone_revoked` 会**自动删除本机证书**并弹窗提示重新向管理员索取引导码；重新导入新的
引导码会自动换一个新 deviceId（服务端拒绝已吊销设备重新引导，所以这一步是恢复所必需的）。

**兼容**：`dshlink1:`（device token + 可选隧道，0.5.0 路径）完全保留；导入时按前缀分流，
主界面显示当前安全模式，重新导入另一类 code 即可切换（token 模式下已保存的证书会保留，
切回 dshlink2 时可复用）。

**私钥与 CA 存储**：私钥默认由 AndroidKeyStore 生成（EC P-256、`PURPOSE_SIGN`，并授权
`DIGEST_NONE/SHA256/SHA384/SHA512` —— Android 16/Conscrypt 的 TLS 1.3 客户端证书签名使用
`NONEwithECDSA`，只授权 SHA 摘要会导致握手失败）；Keystore 不可用时回退为软件 EC P-256
私钥（PKCS#8，存 `files/phone/`，应用私有但可被 root/备份提取），主界面会显示
“私钥 软件密钥（可导出）”作为风险提示。CA 与设备证书 PEM 存在 `SharedPreferences`
（应用私有、未加密）。

### 1.4 二维码导入连接串（0.6.2）

dshlink2 连接串约 7 KB，超过单个二维码的容量（版本 40 / ECC L 的 byte 模式约 2953 字节），
所以 hub 控制台把它切成**多帧动态二维码**：帧文本格式 `dshlinkqr:<index>/<total>:<chunk>`，
index 从 1 开始，chunk 默认 900 字符（可配 200..2400），最多 32 帧；各帧 chunk 按 index
升序直接拼接即原连接串（不插入分隔符）。手机端有两种导入方式：

1. **相机连续扫描**：主界面点「扫描二维码（相机）」→ ScanActivity 用 Camera1 预览 + ZXing
   逐帧解码（约 150 ms 节流），识别到帧文本后交给 `QrAssembler`，界面显示「已扫描 x/y 帧」；
   帧可以乱序到达、也可以重复扫描，`total` 不一致时重置并提示重新开始。收齐后把完整连接串
   回传主界面，沿用 `importText(code, "扫描的二维码")` 流程。
2. **图片多选导入**：主界面「从文件导入」一次可以选中多张二维码截图（PNG/JPEG/WebP），逐张
   ZXing 解码后用同一个 `QrAssembler` 拼装；选择器仍同时支持 `.txt/.json/.dshlink` 连接串
   文件。多帧图片的来源可以是逐帧截图，或 `node scripts/qrgen.mjs --code-file <code>
   --out-dir <dir>` 生成的 `frame-01.png …`（供离线/模拟器测试）。

拼装完成后先做 ConnectProfile 的既有校验（`dshlink1:`/`dshlink2:` 前缀、字段完整性），再走
与粘贴/文件导入完全相同的摘要弹窗、保存与连接流程；二维码不绕过任何校验，连接串也不写入日志。

- **解码重试**：ZXing 的 detector 可能在**完全合法**的二维码上抛 NotFoundException（payload 与
  mask 组合出的局部图案在特定方向被误判成 finder pattern）。因此解码器对每个方向都做
  「常规检测 / 反色 / PURE_BARCODE」重试，并对 90°/180°/270° 旋转重试；相机 Y 平面路径同样
  做旋转重试。
- **权限**：首次点扫描会请求 CAMERA 运行时权限；拒绝时弹「无法使用相机」，说明原因并提示
  改用「从文件导入」多选截图，另有「去系统设置」按钮，不崩溃。没有相机的设备（
  `uses-feature android.hardware.camera required=false`）仍可用图片导入。
- **凭据边界**：二维码内容 = 完整连接串 = 凭据。hub 控制台只对 admin 展示、默认 TTL 2 小时；
  拿到二维码的人在有效期内都能接入，扫完请尽快兑换（dshlink2 引导码一次性）。

### 1.5 界面布局与 Markdown（0.7.0）

0.7.0 把单页界面拆成三个功能区（窄屏为底部 tab；窗口宽度 ≥600dp 时 `res/layout-sw600dp/` 把同一组 id 排成左侧栏，折叠屏展开/平板会命中）：

| 区域 | 内容 |
|---|---|
| 工作区（默认，主体） | 状态/摘要 + 刷新、控制节点下拉（可直控节点 >1 时）、工作区列表；空态提示去“连接”页 |
| 连接 | 导入（粘贴/文件/扫描二维码）、手动 URL + token、STCP 中转勾选、连接按钮、连接状态 |
| 设置 | 当前连接摘要或已导入的 profile、重置设备证书 / 清除导入配置 / 清除连接、关于与安全提示 |

- 连接成功后自动切回“工作区”；切 tab 只改可见性，不重建列表或会话状态。
- 对话样式对齐 DSH / DeepSeek 手机端：用户消息右侧浅蓝气泡，助手整宽；reasoning 默认折叠成
  “思考 · 时间 · 预览”，工具调用/结果仍按组折叠（默认一行，点开看完整 JSON 与工具名）。
- 内置 Markdown 渲染（`Markdown.java` 纯 Java 解析，`ChatMarkdown.java` 转 Spannable）：标题、粗体/斜体/删除线、
  行内代码、围栏代码块、有序/无序列表、引用、表格（列宽按 CJK 宽度对齐）、`[text](url)` 可点击链接；
  表格单元格内的行内标记同样渲染，不再显示裸 ** 号或反引号。
- 节点身份修正：已 enroll 到 hub 的节点，`/api/v1/network/nodes` 返回的是 hub 视角（self 是 hub），App 改用
  `/api/v1/info` 合成“本机”节点并追加直连 peer，避免把 hub 名当成被控节点名。
- transcript 的 `time`（epoch 毫秒）用于消息时间；词内下划线（如 `PHONE_FRPS_OK`）按 CommonMark
  当作字面量，不再被误解析成斜体。

## 2. 节点侧准备

### 2.1 打开 DSH 视图与能力通道（配置文件，改完无需重启节点）

```json
{
  "dsh": {
    "enabled": true,
    "home": "D:\\dsh-home",
    "exposeWorkspaces": true,
    "exposeTranscripts": true
  },
  "capabilities": {
    "enabled": true,
    "methods": ["workspaces.list", "sessions.list", "sessions.read", "sessions.prompt"]
  },
  "auth": { "trustLocalhost": false }
}
```

说明：

- `dsh.home` 必须是**跑着 DSH 的那台机器**的 DSH_HOME（注册表与 `sessions/` 所在目录）。
- 只放行读方法时 App 是只读的；要发消息必须把 `sessions.prompt` 加进 `capabilities.methods`。
- 桥的 `targets` 策略（0.4）只影响**远端来信定向投递**，不影响手机；手机是另一个独立客户端。
- `capabilities.commandTtlSeconds`（默认 120）决定命令在队列里等 bridge 的时间；bridge 必须常驻，
  否则命令会 `expired`。

### 2.2 铸一个设备 token

0.5 起默认不信任回环，手机必须带 token。推荐 `device` 角色：

```powershell
node bin\dshlink.mjs token new --label phone --role device --ttl-days 30 --json
# 输出里的 token 只显示这一次；记下来填进 App
```

`device` token 能做什么（0.5 角色矩阵）：

| 能力 | device token |
|---|---|
| 读 DSH 工作区/会话/transcript | ✅ |
| 提交 `/api/v1/dsh/call`（受 `capabilities.methods` 约束） | ✅ |
| 读消息 inbox / 发消息 / 改 peers / 看 audit / 调 `/bridge/*` | ❌ 403 |

### 2.2b 中心服务器（hub）的 device token

hub 有**独立**的 token 库（与节点 token 不互通）。在跑 hub 的机器上执行：

```powershell
node bin\dshlink.mjs hub token new --data-dir <hub数据目录> --role device --label phone
# 也可以 dshlink hub token new --role device --label phone（用默认数据目录）
```

> 0.5.0 起通常不需要手工铸 token：`dshlink hub invite --phone`（或 hub 面板的“手机连接码”）
> 会把一枚新的 hub device token 直接打进 code，App 导入即可（见 1.2）。手工 `hub token new`
> 仍适合“已有 token、只想配一个不含隧道的入口”的场景。

hub **从不信任 localhost**：即使 App 经 `adb reverse`/STCP 落到 `127.0.0.1:8790`，也必须带
token；只有 `/healthz` 匿名可读（App 的中转体检探针用它），其余 API 一律要 Bearer token。
device token 可访问 `/api/v1/info`、`/api/v1/network/nodes`、`/api/v1/dsh/*`、`/dsh/call`
（能做什么还受目标节点自己的能力白名单约束），不能管理 hub、读 inbox 或碰 bridge 控制面。

> 需要更严格的最小权限时，把 `capabilities.peers["phone"]` 配成只允许 `sessions.prompt`
> （`peer` 取 token 的 `--label` 或 `--peer`），或把 token 的 `--ttl-days` 缩短；吊销：
> `node bin\dshlink.mjs token rm --id <id>`。

### 2.3 手机怎样到达节点

节点默认 `bind: 127.0.0.1`，手机当然连不上。可选路径：

1. **局域网 / VPN（推荐）**：把节点 `bind` 改成手机能到的地址（如 `0.0.0.0` 或 VPN 网卡地址），
   手机填 `http://<节点IP>:8787`。若用 Tailscale/WireGuard，节点只需 bind 到 VPN 地址，
   公网不暴露任何端口。
2. **反代 + TLS**：在节点前放 Caddy/Nginx，给手机一个 HTTPS 域名；App 支持 https。
3. **内置阿里云 STCP 中转（0.2.0 起；0.5.0 起凭据来自导入的连接串）**：App 自己带 frpc，
   导入含隧道的 code 后勾选复选框即可，无需填节点地址；手机经 frps 连接到节点/hub 发布给
   手机的 STCP provider（`dshlink-phone`），落到 **8788 token 网关**。详见 2.4。
   **不要把明文 8787 直接暴露到公网。**
4. **中心服务器入口（0.4.0）**：hub 默认 `bind: 127.0.0.1:8790`；手机到达 hub 的方式与节点
   相同（LAN/VPN/HTTPS 反代/内置 STCP），地址填 `http://<hub>:8790`，token 用 2.2b 的
   hub device token。hub 对每个请求都校验 token，不信任回环来源。

App 允许 cleartext HTTP（`usesCleartextTraffic="true"`），这是为局域网/VPN/STCP 场景准备的；
公网路径必须由 STCP 的 TLS 或反代承担加密。

### 2.4 内置阿里云 STCP 中转（0.2.0 起；0.5.0 起凭据运行期导入）

手机不在节点/hub 局域网时，不需要 VPN，也不需要把 API 端口暴露到公网：把 frpc 的 STCP
**visitor** 跑在手机里。0.2.0 起 App 把 Linux x86_64（模拟器）和 arm64（真机）的 frpc 作为
`libfrpc.so` 打进 APK，启动时把配置/证书写到应用私有目录并执行 visitor，在本机
`127.0.0.1:<bindPort>` 打开一个端口，App 随后像连普通入口一样连这个本地端口。

> **0.5.0 起 visitor 配置不再内置在 APK 里**：frpc.toml 和证书由 hub 管理员生成的连接串在
> 导入时写入 `files/tunnel/`（见 1.2）。通用 APK 不含任何隧道凭据；只有内部构建（手动放了
> `assets/tunnel/` 且 4 个文件齐全）才会把凭据打进 APK，构建脚本会显式警告。

0.3.0 起隧道落点是 **8788 token 网关**：节点/hub 侧由 `dshlink tunnel sync` 发布一个指向
8788 网关的 STCP provider（默认名 `dshlink-phone`，配置来自 `gateway.provider`），不再是
旧的 8787 provider。所以手机 → frps → provider → `127.0.0.1:8788` → 网关校验 device token
→ API。网关对每个请求都要求 token 且**不信任回环来源**，因此 STCP 凭据本身不能绕过 dsh-link
认证，audit 里能看到真实 device 角色。frps 仍是阿里云 `203.0.113.10:16443`。

前提（缺一不可）：

- hub 侧已配置 frps（`frp.enabled=true` + `frp.serverAddr`）与 STCP provider
  （`gateway.provider.secretKey`；`dshlink tunnel sync` 会发布它），`dshlink hub invite --phone`
  才能生成带 tunnel 的 code；
- 手机能出站访问 frps 的 `serverPort`（16443/TCP）；
- 管理员把 code **私下**发给用户，用户在 App 里导入（1.2）。导入后 App 把 frpc.toml
  （原样保存，`{{DIR}}` 在启动时替换为私有目录绝对路径）和 code 里带的证书写到
  `files/tunnel/`；只要求 frpc.toml 实际引用的证书文件存在（code 可能只带部分证书，例如
  只用 STCP secretKey 时没有 mTLS）。**APK 本身不需要、也不应该包含任何凭据。**

0.4.0 把同一套内置 frpc 也用于 hub；0.5.0 起**不再有“一个 APK 只装一套模板”的限制**：本地
端口一律从实际使用的 frpc.toml 的 `bindPort` 读取（hub 生成的模板默认 18790，节点模板
18788），A 环境与 B 环境的配置通过导入不同 code 切换，互不覆盖。导入带隧道的 code 后隧道
勾选框自动勾上、URL 框禁用并显示解析出的本地地址；导入 `--no-tunnel` 的 code 则清掉隧道
文件、自动取消勾选，改为直连 `entry.url`（所以 `--no-tunnel` 需要同时给 `--url`）。hub 的
公网落点应只经 STCP/反代，不要把 8790 明文暴露到公网。

真机上的操作：导入管理员给的 code（1.2）→ App 自动填好 URL/token/隧道并连接。含隧道的
配置会启动内置 frpc，第一次连接最多等 20 秒让 frpc 登录 frps、注册 visitor；失败弹窗会带
最近 12 行 `frpc` 日志（已去掉 ANSI 颜色码），常见原因是 frps 不可达、provider/secretKey
不匹配、证书缺失（提示“导入的隧道配置缺少 xxx，请重新导入连接串/配置文件”）。成功后所有
请求都走 手机 → frps → provider → 8788 网关，与局域网连接完全相同，只是必须带 device token。
隧道勾选但还没导入配置时，App 会直接提示“尚未导入隧道配置，请向 hub 管理员获取连接串/
配置文件并导入”。

自测（本机，不经手机）：

```powershell
# 用仓库里的 frpc 起一个 visitor，模拟手机侧（provider 名必须与节点一致）
& D:\dsh-home\plugins\vendored\dsh-link\vendor\frp\windows-amd64\frpc.exe -c C:\Users\example\.dshlink\frp\frpc-visitor-phone.toml
Invoke-WebRequest http://127.0.0.1:18788/healthz   # 无 token 应是 401（网关拒绝），而不是 200
```

> 安全警告：导入的 code 里包含 frps auth token、mTLS 客户端证书/私钥、STCP `secretKey` 和
> hub device token。它们等价于“能连到网关的凭据”，但**不携带节点 API 权限**：网关仍要求
> device token，且拒绝 `/mcp`、`/api/v1/bridge/*`。注意每次生成的连接串只换 device token，
> 内嵌的 frp mTLS 证书/私钥与 STCP secretKey 是部署级的（所有连接串相同，当前证书有效期至
> 2027-07-18）；吊销 device token 不会吊销隧道凭据，换证后需要重新导入新连接串。这些内容明文存在 App 私有目录
> （`files/tunnel/` 与 `SharedPreferences`，未加密），手机丢失/换手请让管理员
> `dshlink hub token rm --id <tokenId>` 吊销；code 泄露时还要轮换 frps token、重签 mTLS
> 证书、更换 STCP secretKey。内部构建（`assets/tunnel/` 存在）的 APK 仍包含凭据，
> **只可内部使用，不要分发**；通用 APK 不含凭据，可以分发。

## 3. 构建（无 Gradle）

### 3.1 依赖

- JDK 17+（本仓库在 JDK 26 上验证过）
- Android SDK，至少：
  - `platform-tools`
  - `platforms;android-36`
  - `build-tools;36.0.0`
- 第三方库只在仓库内 vendored：`vendor/zxing/zxing-core-3.5.3.jar`（ZXing core，Apache-2.0，
  用于二维码解码，见 1.4）。构建脚本把它加进 `javac` classpath **并作为 `d8` 输入**打进
  `classes.dex`（不需要 Gradle/Maven/联网）；jar 缺失时脚本直接报错。

安装（sdkmanager.bat 会把带分号的包名拆参，用新版 `android.exe` 或 `cmd /c` 包一层引号）：

```powershell
D:\AndroidSdk\cmdline-tools\bin\android.exe --sdk=D:\AndroidSdk sdk install 'platforms;android-36'
D:\AndroidSdk\cmdline-tools\bin\android.exe --sdk=D:\AndroidSdk sdk install 'build-tools;36.0.0'
D:\AndroidSdk\cmdline-tools\bin\android.exe --sdk=D:\AndroidSdk sdk install 'platform-tools'
```

### 3.2 一条命令

```powershell
$env:JAVA_HOME = 'D:\AndroidSdk\jdk17\jdk-17.0.21.0.2+1'   # JDK 17+ 即可
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Sdk D:\AndroidSdk
```

脚本只调用 SDK 里的 `aapt2 / javac / d8 / zipalign / apksigner`：

```text
aapt2 compile → aapt2 link → javac --release 11 → d8 --min-api 26
→ jar uf classes.dex / assets / lib/<abi>/libfrpc.so → zipalign
→ (debug 首次) keytool 生成 debug.keystore → apksigner sign/verify
→ 打印 APK 路径/大小/SHA-256，并重写 dist/SHA256SUMS
```

必选与可选：

- **必需**：`native/lib/{x86_64,arm64-v8a}/libfrpc.so`（内置 frpc，不进仓库；按
  [`android/tunnel/README.md`](tunnel/README.md) 在本地生成，缺了构建脚本直接报错）；
- **可选**：`assets/tunnel/{frpc.toml,ca.crt,client.crt,client.key}`。0.5.0 起**四个文件齐全**
  时才打进 APK（构建时警告 `this APK will contain tunnel credentials (internal build only…)`）；
  缺任何一个都按**通用 APK** 构建（打印 `tunnel credentials: none (distribution build)`），
  不再报错——这就是可以分发给他人的产物。

产物：

```text
android/dist/dshlink-control-0.7.0-debug.apk     # debug 签名（默认）
android/dist/dshlink-control-0.7.0.apk           # -Release 签名（见 3.3）
android/dist/SHA256SUMS                          # 每次构建后对 dist/*.apk 全量重写
```

`build-apk.ps1` 默认 `-VersionName "0.7.0" -VersionCode 10`（与 `ApiClient.APP_VERSION` 一致，
发版时两处一起改）。

APK 内容（0.7.0 通用构建）：

- `lib/x86_64/libfrpc.so`、`lib/arm64-v8a/libfrpc.so`：模拟器/真机可执行的 frpc。源码是
  frp v0.71.0 的 Linux 二进制（x86_64 来自本机 frp-stcp-base，arm64 来自
  `frp_0.71.0_linux_arm64.tar.gz`），打包进 APK 的 `lib/<abi>/`，Android 解压到
  `nativeLibraryDir` 后 App 直接 exec。换 frp 版本时同时替换这两个文件并验证
  `frpc --version`；
- **没有 `assets/tunnel/`**：通用 APK 里查不到任何 frps token / mTLS 私钥 / STCP `secretKey`
  （`jar tf` / `unzip -l` 即可确认）；隧道配置只在用户导入 code 后才写进 `files/tunnel/`
  （见 1.2）；
- `classes.dex` 里合并了 vendored 的 `vendor/zxing/zxing-core-3.5.3.jar`（QR 解码；
  `jar tf` 里仍只有一个 `classes.dex`，没有额外 jar 条目）；
- 内部构建（本地放了 `assets/tunnel/` 四件套）仍会把凭据打进 APK，只能内部使用、不要分发。

### 3.3 release 签名（分发给他人）

debug 签名只适合自用/内测。分发给别人前，先生成（或复用）自己的 release keystore：

```powershell
keytool -genkeypair -keystore android\release.keystore -alias dshlink -keyalg RSA `
  -keysize 2048 -validity 3650 -storepass <密码> -keypass <密码> `
  -dname "CN=dsh-link, O=YourOrg"
```

用 `-Release` 构建（keystore 路径/密码/alias 都由参数传入，脚本不保存密码）：

```powershell
$env:JAVA_HOME = 'D:\AndroidSdk\jdk17\jdk-17.0.21.0.2+1'
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Sdk D:\AndroidSdk `
  -Release -Keystore android\release.keystore -KeystorePassword <密码> `
  -KeyAlias dshlink -KeyPassword <密码>
```

- 输出 `android/dist/dshlink-control-0.7.0.apk`（release 不带 `-debug` 后缀）；
- `-KeyPassword` 省略时用 `-KeystorePassword`；`-KeyAlias` 省略时用 keystore 里的别名；
- 结尾会 `apksigner verify --print-certs`，打印 size / SHA-256，并把 `dist/*.apk` 的 SHA-256
  全量重写到 `dist/SHA256SUMS`（格式 `<大写 SHA-256>  <文件名>`）；把 APK 和校验值一起发给用户；
- release APK 的 `aapt2 dump badging` 里**没有** `application-debuggable`，本地没有
  `assets/tunnel/` 时也**不含**任何隧道凭据。

### 3.4 安装

```powershell
D:\AndroidSdk\platform-tools\adb.exe install -r android\dist\dshlink-control-0.7.0-debug.apk
```

或者把（`-Release` 或 debug）APK 传到手机点击安装（需允许“安装未知来源应用”）。

## 4. 使用

**（0.6.0 起，推荐）先导入连接串/配置文件**：点“导入连接串/配置文件”粘贴 `dshlink2:…`
或 `dshlink1:…`，或点“从文件导入”选 `.txt/.json/.dshlink` 文件，也可以从聊天工具里直接
“分享/用其他应用打开”给 App（`text/plain`）；导入成功后 App 自动填写并连接（见 1.2/1.3）。
0.6.2 起还支持二维码：点“扫描二维码（相机）”对准 hub 控制台的动态二维码，或点“从文件导入”
一次多选多张二维码截图（`frame-01.png…`），扫齐多帧后走同一套导入校验（见 1.4）。
**（0.7.0 起）界面分三个区域**：底部 tab（宽屏为左侧栏）切换 工作区 / 连接 / 设置；工作区是默认主体，
连接页负责导入与手动连接，设置页查看/清除当前连接与设备证书。连接成功后自动回到工作区。
下面是手工填写的等价流程。

1. 打开 App，填入口地址 + token，点“连接”。入口可以是：
   - **中心服务器（0.4.0，推荐）**：`http://<hub>:8790` + hub device token（2.2b）；不在同一
     网络时勾选内置 STCP 中转（hub 模板本地端口 18790）。
   - **单个节点（0.3.0 及更早）**：`http://<节点>:8787` + 节点 device token（2.2），或勾选
     STCP 中转（节点模板本地端口 18788）。
   勾选中转后地址框自动禁用，App 启动内置 frpc（见 2.4）。
2. 连接成功后看到工作区列表；点进工作区看会话；archived 会话默认隐藏，可勾选“显示已归档”。
   - **hub 模式**：顶部“控制节点”下拉框列出中心服务器的登记表（不含 hub 自身），默认
     `defaultNode` 或第一个在线节点；选中后所有读取/发送都带 `peer=<节点>` 由 hub 转发。
     节点离线时行内标注“（离线 · 最后心跳 …）”，选中会提示并回退；本页“连接/刷新工作区”
     会重新读取登记表。
   - **单节点模式**：下拉框列出入口节点网络里可见的节点，选另一个**直连**节点即可远程浏览/
     发消息（经中转的二跳节点只展示不可选）。
3. 点会话进入 transcript：
   - 前台时每 2.5 s 自动拉 `sinceSeq` 增量；按返回键/切后台即停止；
   - 顶部“加载更早”向前翻页；
   - 底部输入框发送消息；勾选“插话（steer）”用 steer 模式，否则 queue；
   - 连续的工具调用/结果默认折叠成一行（“#seq · 工具调用 · N 条 · 点击展开”），点击展开/收起。
4. 顶部状态栏会显示当前节点、只读提示或错误原因；token/URL 错误、能力未开、命令超时
   都有对应提示。

App 不保存多个节点配置（只有一组入口 URL + token），也不在后台同步；换入口重新填即可。
单节点模式下远程节点的发送结果不轮询命令 id，只提示“已提交 · 由 <节点> 处理”，回复看
transcript 增量；**hub 模式**会按 `GET /dsh/call/{id}?peer=` 轮询到终态（20 秒内没完成则先
显示 pending/“已提交”），回复同样看 transcript 增量。

### 4.1 真机连接（USB / 局域网 / VPN）

真机只要网络能到节点的 bind:port 即可。四种常见方式，任选其一：

1. **USB（最省事，不依赖 Wi-Fi/防火墙）**：手机开 USB 调试并连电脑，然后
   ```powershell
   adb reverse tcp:8787 tcp:8787
   adb install -r android\dist\dshlink-control-0.3.0-debug.apk
   ```
   App 里节点地址填 http://127.0.0.1:8787 （手机上的 127.0.0.1 经 adb reverse 转到电脑的
   8787）。拔线或重启 adb 后需要重新执行 adb reverse。
2. **同一局域网（Wi-Fi）**：节点配置 "bind": "0.0.0.0"（本机当前已是该配置，端口 8787），
   手机与电脑同网段，App 填 http://<电脑局域网 IP>:8787 （例如本机当前
   http://192.0.2.100:8787 ；IP 变化时用 Get-NetIPAddress -AddressFamily IPv4 查）。
   电脑防火墙需放行 node.exe 的入站 TCP；本机已有 “Node.js JavaScript Runtime” 入站规则。
   首次连接若被防火墙拦截，在“允许应用通过防火墙”里勾选 Node.js 的专用网络。
3. **VPN / 虚拟局域网**（Tailscale、WireGuard、ZeroTier 等）：手机装同一 VPN，节点 bind
   改为 VPN 网卡地址或 0.0.0.0，App 填 VPN 地址。适合跨公网，不需要把 8787 暴露到公网。
4. **内置阿里云 STCP 中转（0.2.0 起；0.3.0 经 8788 网关，手机不在任何同一网络）**：节点侧
   已发布指向 8788 网关的 STCP provider（`dshlink-phone`），手机 App 勾选“通过阿里云 STCP
   中转至 8788 网关”即可；不用改节点 bind、不用开公网端口、不用装 VPN。设备 token 仍必填。
   前提与安全边界严格见 2.4。

device token 在节点上生成（--ttl-days 到期自动失效，手机丢失可 token rm --id 吊销）：

```powershell
node bin\dshlink.mjs token new --label phone --role device --ttl-days 30 --json
```

把输出里的 token 粘到 App 的 token 框。App 只使用 device 角色允许的 /api/v1/dsh/* 与
/api/v1/dsh/call，不能读消息面/管理 peers/碰 bridge 控制面；实测无 token 访问
http://<LAN IP>:8787/api/v1/info 返回 401，带 device token 的正常读取与 sessions.prompt
调用返回 200。

## 5. 安全说明（必读）

- **传输**：公网必须走 VPN（Tailscale/WireGuard 等）、HTTPS 反代或内置 STCP 中转；
  明文 HTTP 仅限可信局域网。
- **分发模式（0.5.0）**：通用 APK **不含**任何 frps auth token、mTLS 私钥或 STCP `secretKey`
  （构建产物可 `jar tf` 确认）；隧道凭据来自用户导入的连接串，只落在 App 私有目录
  `files/tunnel/`（`frpc.toml`、证书）与 `SharedPreferences`（url/token，均未加密）。所以
  **通用 APK 可以分发**。但 code 本身等价于凭据：管理员应私下发放、设到期时间/使用次数上限；
  泄露或手机丢失时用 `dshlink hub token rm --id <tokenId>` 吊销 device token，必要时轮换 frps
  token / 重签 mTLS / 更换 STCP secretKey。内部构建（本地 `assets/tunnel/` 四件套齐全）的 APK
  仍含凭据，**只可内部使用，不要分发**。
- **每设备证书（0.6.0，dshlink2）**：连接串里的 hub 自签 CA 是**唯一信任锚**——App 只信任
  这张 CA 签出的链（校验链、主机名与 serverAuth 用途），其他任何 CA/自签证书一律握手失败；
  设备私钥优先在 AndroidKeyStore 里生成（不可导出），Keystore 不可用时才回退软件密钥
  （`files/phone/`，可被 root/备份提取，界面会标注“私钥 软件密钥（可导出）”）；一次性引导码
  兑换成功后 App 立即删除 secret，只保留证书；hub 侧可用 `dshlink hub phone revoke` 吊销设备
  （App 收到 `403 phone_revoked` 会自动删本地证书）。手机丢失时应**吊销设备**并让管理员
  重新签发引导码，不要只依赖证书的 365 天到期。
- **token**：device token 存在 App 的 `SharedPreferences`（应用私有，但未加密）；手机丢失
  请在节点上 `token rm --id` 吊销。token 可以只给 30 天有效期。
- **hub token 与节点 token 是两套**：连 hub 时 App 只携带 hub 的 device token，由 hub 代转；
  目标节点的权限仍由节点自己的 `capabilities.methods` 决定，hub 不能绕过。hub 的 device token
  同样应设有效期，手机丢失后在 hub 上吊销（`dshlink hub token` 管理）。hub 默认只 bind
  `127.0.0.1:8790`，对外请走 VPN/STCP/HTTPS 反代，不要把 8790 明文暴露到公网。
- **最小权限**：device token 不能读写消息、不能管理 peers、不能碰 bridge 控制面；它仍能读
  **全部未排除的 DSH 工作区与 transcript**——这是 App 的功能本身，只应给自己信任的人装。
- **节点暴露面**：给手机开 `bind 0.0.0.0` 时，请同时确认：
  - 只在可信局域网/VPN 内开放；公网必须走 VPN 或 HTTPS 反代；
  - `auth.trustLocalhost=false`（0.5 默认；本机当前仍为 `true` 以兼容本机 CLI/bridge，
    因此局域网入口必须依赖 token，不要把 8787 直接暴露到公网）；
  - 每个入口都要 token，且 token 有上限频率（`limits.maxRequestsPerMinute`）；
  - 不要启用 `relay` 或不必要的 `files.allowUpload`；
  - 若使用反代，TLS 由反代终止，节点仍只听内网/回环。
- **节点侧**：如果手机走内置 STCP，节点发布的是指向 **8788 网关**的 `dshlink-phone` provider；
  8787 本身只应由本机 CLI/bridge 使用，不要映射到公网。STCP 只保证“没有 secretKey 连不上”，
  不替代 token；网关已经强制 token，但 device token 仍应设有效期并定期轮换。
- 这是 **debug APK**，没有代码混淆；dshlink2 模式会对连接串里的 CA 做固定（pinning），
  dshlink1 token 模式不做证书固定。不要从不明来源安装二次打包的 APK。

## 6. 已知限制

- **没有推送/SSE**：会话更新靠前台每 2.5 s 轮询；退到后台就停止，没有通知栏提醒。
- **没有离线缓存**：断网后重新进入页面会从头拉。
- **单入口**：一个 App 实例只保存一组入口 URL + token；0.3.0 可以切换到该入口节点的直连
  peer（经其他节点中转的二跳节点只展示、不可控制）；0.4.0 的 hub 模式可切换 hub 登记表里的
  任意节点，但一次只控制一个。
- **单份配置**：App 只保存最近一次导入的连接串（URL/token/隧道文件整体替换），不支持多 hub/
  多环境 profile 存储；换环境重新导入即可，旧配置不保留。
- **导入内容未加密**：code 解码后的 token、`frpc.toml`、证书以明文存于 `SharedPreferences` 与
  `files/tunnel/`（应用私有目录），依赖 Android 沙箱保护；手机丢失请吊销 token 并轮换隧道凭据。
  dshlink2 的设备证书（公钥材料）与 CA 存在 `SharedPreferences`，私钥默认在 AndroidKeyStore
  （不可导出），回退软件密钥时才落盘到 `files/phone/`。
- **设备证书有效期 365 天**：到期后服务端拒绝 mTLS，需要重新导入管理员签发的 dshlink2 引导码
  （主界面会显示证书到期时间）；hub 侧吊销后同样必须重新引导。
- **重装/换机**：deviceId 与私钥都在 App 数据里，卸载或“清除数据”后会生成新的 deviceId
  （旧记录留在 hub 设备列表里，可吊销/清理）；重新导入引导码会按新设备注册。
- **dshlink2 的隧道**：0.6.0 已支持 dshlink2 的 `tunnel` 字段（结构同 dshlink1，手机侧照旧用
  内置 frpc + visitor）。0.6.1 起已在“真实公网 phone-frps（STCP）+ 每设备证书”组合上完成
  模拟器端到端验证（见 §7 末尾 0.6.1 冒烟）；真机 arm64 的 mTLS 路径仍待实测。
- **服务端热加载（0.10.1 起）**：`hub serve` 每次鉴权前会检查配置/令牌文件与 `phones.json`
  的 mtime/size，另一个进程里的 `dshlink hub phone revoke`、控制台或 CLI 新建令牌会立即生效，
  不需要重启 hub（0.10.0 及更早才需要重启）。App 会如实显示服务端返回的结果。
- **到期时间仅提示**：`expiresAt` 只用于展示和警告（过期仍可导入/连接，是否拒绝由 hub/节点的
  token 校验决定）；真正吊销要走 `dshlink hub token rm --id <tokenId>`。
- **hub 模式**：只能看到 hub 登记表里的节点；节点离线时只显示状态、不能读取/发送；hub 未提供
  `/api/v1/network/nodes` 时退化到 `info.nodes`。
- **远程发送**：单节点模式不跟踪命令 id，只提示“已提交 · 由 <节点> 处理”；hub 模式会轮询
  `GET /dsh/call/{id}?peer=` 到终态（bridge 慢时先显示 pending）。两种模式最终回复都看
  transcript 增量。
- **只做浏览与发消息**：不能新建/重命名/归档会话，不能发附件，不能看文件根。
- **命令依赖 bridge**：DSH host 或 bridge 不在线时，发送命令会 pending→expired（默认 120 s）。
- **Android 版本**：minSdk 26（Android 8.0）及以上；targetSdk 36。
- **内置 frpc**：只带 x86_64（模拟器）与 arm64-v8a（真机）两个架构；Android 10+ 才允许执行
  `nativeLibraryDir` 里的二进制。APK 因两个 frpc 约 12 MB；首次中转连接最多等 20 秒。
  个别 Android 15/16 的 16 KB page-size 设备若拒绝执行 4 KB 对齐的 Go 二进制，会弹
  “frpc 未能在 20 秒内建立中转”，此时改用 VPN/局域网路径（或换 16 KB 对齐的 frpc 重新打包）。
- **二维码导入（0.6.2）**：二维码内容就是连接凭据（等价于明文连接串），不要截图外发；hub 端
  动态二维码有 TTL，dshlink2 的一次性引导码兑换后即失效。相机扫描需要 CAMERA 权限（拒绝时
  弹窗会提示改用“从文件导入”多选截图，不会崩溃）；多帧必须扫齐同一 total，缺帧/乱序/重复帧
  会按帧号合并，不会拼出错误的连接串。图像导入对每帧做旋转 × 提示组合重试，但极低分辨率或
  严重畸变的截图仍可能识别失败（可重截/放大）；模拟器虚拟相机只能验证打开与释放，不能验证
  真实扫码。

## 7. 验证

- 构建：`android/build-apk.ps1` 退出码 0；`aapt2 dump badging` 显示
  `package dev.dshlink.control`、`versionName 0.7.0`/`versionCode 10`、`minSdk 26`、
  `targetSdk 36`、`native-code arm64-v8a x86_64`。
- `apksigner verify --print-certs` 通过。
- API 契约（本机 node:test，`DSH_HOME` 指向真实 DSH 时运行）：
  `node --test test/mobile-contract.test.mjs` —— 覆盖 App 用到的 info / workspaces / sessions /
  transcript tail / transcript sinceSeq / dsh/call 提交与结果查询、device token 权限边界。
- 模拟器冒烟（x86_64 API 36.1，`adb install -r` + `am start`）：连接 device token → 工作区/会话列表；
  打开会话显示 `#seq · kind · HH:mm:ss`（本机真机时间曾是 epoch 毫秒，0.6.0 已修）；queue 发送与
  “插话（steer）”发送都被节点侧模拟 bridge claim/complete，params 分别为 `{sessionId,text}` 与
  `{sessionId,text,mode:"steer"}`，App 显示“已发送”；把 `sessions.prompt` 从能力白名单移除后重连，
  App 正确切到“只读模式”并禁用输入框；全程 `logcat` 无崩溃。
- 0.1.1 真实节点冒烟（2026-11-04，Android 16 / API 36，节点 dsh-link 0.6.2，device token）：
  - **edge-to-edge 修复**：Android 16 即使在 Material `DarkActionBar` 主题下也强制 edge-to-edge，
    旧版标题下的“刷新”、会话状态行/插话勾选框被 ActionBar 遮住且点不动。新增
    `Ui.applyEdgeToEdgePadding`（状态栏 + `actionBarSize` 顶部 padding，会话页再加 IME 底部
    padding）后全部控件可见可点；刷新按钮实际能重新拉取（新建会话出现）。
  - **真实发送**：在 `session-1aa41492…` 勾选“插话”发送后，节点成功 claim/complete
    `sessions.prompt {mode:"steer"}`，真实 DSH agent 在 transcript 回复
    （`seq 17`：reasoning + `OK — phone↔peer e2e probe 已收到并回复，链路正常。`）。
  - **同一 seq 多行修复**：一个 durable event 可能渲染成多行（同 `seq 17` 的 reasoning 与最终回答），
    旧版按 seq 去重会丢掉第二行；现改为按行身份（`seq + role + kind + 文本 hash`）去重，两行都显示，
    游标仍按 `latestSeq` 前进。
  - **键盘遮挡**：键盘弹出时插话勾选框、输入框、发送键仍在键盘之上；`logcat` 无崩溃。

- 0.2.0 内置 STCP 中转冒烟（2026-11-04，Android 16 / API 36 x86_64 模拟器；节点 dsh-link 0.6.2；
  阿里云 frps `203.0.113.10:16443`；手机侧不接任何局域网/ VPN）：
  - **APK**：`dshlink-control-0.2.0-debug.apk` 11,981,929 bytes（含 x86_64 + arm64 frpc），
    versionCode 3 / versionName 0.2.0；`aapt2 dump xmltree` 确认 `extractNativeLibs=true`，
    APK 内条目为 `assets/tunnel/*` 与 `lib/{x86_64,arm64-v8a}/libfrpc.so`（正斜杠，jar 打包）。
  - **App 内启动 visitor**：勾选“通过阿里云 STCP 中转”后点连接，`logcat` 显示
    `starting /data/app/.../lib/x86_64/libfrpc.so -c /data/user/0/dev.dshlink.control/files/tunnel/frpc.toml`，
    约 50 ms 后 `tunnel is healthy on port 18788`；`adb shell ps -A` 看到 `libfrpc.so` 子进程；
    主界面状态“已连接 · 11 个工作区 · 可发送”，节点 `alice-pc · dsh-link 0.6.2`，
    URL 框禁用并显示 `http://127.0.0.1:18788`。
  - **真实跨公网发送**：经中转打开 `[phone-e2e] 短回复`（`session-1aa41492…`），发送
    `phone tunnel e2e: reply with the single word TUNNEL_OK`；transcript 出现 `#37 · 用户`、
    `#39 · 思考`、`#39 · DSH` 正文 `TUNNEL_OK`。
    全程请求是 手机 → frps → 节点已有 STCP provider → 8787，节点没有新开公网端口。
  - **失败路径**：故意让 frpc 连不上（或删掉 native lib）时，App 在 20 秒内弹窗
    “中转启动失败”，正文带 `frpc` 日志尾部；不会静默假装连接成功。

  - **真机 arm64（2026-11-04，用户实测）**：手机经内置 STCP 中转连接成功，能打开工作区/会话列表，
    并从控制端把一条消息发进已有 DSH 会话；节点 audit 记录了该 `sessions.prompt` 命令
    `cmd_01m6k11b50303a94cfc1c6`（10:17:54Z）。APK 里的 arm64 frpc 因此也已验证可执行。

  历史边界（0.3.0 已修复）：0.2.0 的隧道落到 8787，本机 `auth.trustLocalhost=true` 使经 STCP
  到达的请求绕过 dsh-link token（当时 audit 记为 localhost/admin）。0.3.0 改为落到 8788 网关，
  每请求校验 token 且不信任回环来源。

- 0.3.0 冒烟（2026-11-04，Android 16 / API 36 x86_64 模拟器；真实节点 dsh-link **0.7.0**，
  已启用 8788 网关与 `dshlink-phone` STCP provider）：
  - **APK**：`dshlink-control-0.3.0-debug.apk` 11,986,025 bytes，versionCode 4 / versionName
    0.3.0；debug 签名通过。隧道模板指向 `dshlink-phone` provider；`TunnelManager.healthy()`
    改为“有 HTTP 响应即健康”（网关对无 token 探针回 401 也算隧道已通）。
  - **网关路径**：勾选中转后连接成功，状态“已连接 · 11 个工作区 · alice-pc ·
    可发送”，summary“节点 alice-pc · dsh-link 0.7.0 · 网络 2 个节点 · 2 可达”；
    局域网直连 `http://192.0.2.100:8787` 同样可用。网关侧：无 token /healthz → 401，
    device token info 200，`/api/v1/peers` 与 `/mcp` → 403；`/dsh/call` 经 bridge 完成。
  - **网络扫描与节点切换**：连接测试节点 `NODE-A-TEST`（8797，peer 含 DESKTOP）后下拉框显示
    2 个节点；选 DESKTOP 后状态为“控制 alice-pc（经 NODE-A-TEST 中转）”，远程加载
    11 个工作区、8 个会话（3 个子智能体）与 223 条 transcript；二跳节点会提示暂不支持并回退。
  - **远程发送**：经 NODE-A 中转打开 `session-1aa41492…` 发送 `remote e2e from NODE-A: reply
    REMOTE_OK`，transcript 出现 `#46 · 用户`、`#47 · 用户`、`#49 · DSH` = `REMOTE_OK`。
  - **子智能体与 JSON null 修复**：工作区行显示“共 8 个会话（3 个子智能体）”，3 行带
    “子智能体 · ”前缀。此前 `JSONObject.optString(key, fallback)` 把 `JSONObject.NULL` 读成
    字符串 `"null"`，导致 8/8 都被当成子智能体、工具行显示 `tool: null`；新增
    `Ui.text(object, key)`（null 安全）并在所有 adapter 使用。
  - **工具折叠**：`#414 · 工具调用 · 2 条 · 10:38:46 · 点击展开`，点击后变“点击收起”并显示
    工具调用 JSON 与工具结果正文；折叠只影响显示。
  - 全程 `logcat` 无崩溃；主界面/会话列表/transcript 截图仅本地留存（`test/.tmp/`，
    含真实主机名/局域网地址，不提交仓库）。

- 0.4.0 hub 直连冒烟（2026-11-04，Android 16 / API 36 x86_64 模拟器；hub 为仓库 0.7.0 的
  `src/hub.mjs`（0.8 拓扑的中心服务器），登记 1 个节点 `NODE-ANDROID`（`dsh.home` 指向
  真实 DSH），bridge 由 harness 模拟 claim/complete）：
  - **APK**：`dshlink-control-0.4.0-debug.apk` 11,990,118 bytes；`aapt2 dump badging` 显示
    `versionCode 5`、`versionName 0.4.0`、`minSdk 26`、`targetSdk 36`；
    `apksigner verify` 通过（debug 证书）。
  - **hub 模式**：连 `http://127.0.0.1:18790` + hub device token 后自动进入 hub 模式，状态
    “已连接 · 12 个工作区 · NODE-ANDROID · 可发送”，summary “中心服务器 HUB-ANDROID ·
    dsh-link-hub 0.7.0 · 1 个节点 · 1 在线 · 当前 NODE-ANDROID”，下拉“NODE-ANDROID（在线）”；
    工作区、会话列表、transcript 请求都带 `peer=NODE-ANDROID`（transcript 状态行
    “NODE-ANDROID（经 HUB-ANDROID）”），与 `/api/v1/dsh/...?peer=` 契约一致。
  - **hub 发送与终态**：会话内发送消息，App 发 `POST /api/v1/dsh/call {peer, method:
    "sessions.prompt", params:{sessionId,text}, waitSeconds:20}`；harness bridge 认领并完成
    后，App 经 `GET /api/v1/dsh/call/{id}?peer=` 拿到 `status:"done"` 并显示“已发送”；
    hub 日志 `[bridge] completed sessions.prompt cmd_01m6k86fxz5b3b93e337d4`。
  - **空登记表**：无节点的 hub 上状态“已连接中心服务器 · 还没有登记节点”，summary “0 个节点 ·
    0 在线”，warning 给出 `dshlink hub enroll`，列表空态“中心服务器还没有登记节点”。
  - **节点离线**：只登记一个节点且其 link 已关闭的 hub（节点 url 指向已关端口）→ 首次读取在
    页内显示 502 `upstream_unreachable` + `ECONNREFUSED`（不弹模态、可重试/切换）；等 hub
    离线阈值（90 s + 120 s）过后点“刷新工作区” → 下拉“NODE-OFFLINE（离线）”、状态“已连接
    中心服务器 · NODE-OFFLINE 当前离线”、summary “0 在线”、warning 提示检查节点进程/heartbeat、
    空态“该节点离线，请选择在线节点”，且不再向离线节点发读取请求。
  - **鉴权**：错误 hub token → 弹窗“鉴权失败：token 无效或已过期”，正文给出 hub 侧
    `dshlink hub token new --role device --label phone` 与“hub 从不信任 localhost”说明。
  - **兼容**：同一 APK 连旧单节点入口（真实节点 0.7.0，`http://192.0.2.38:8787`）仍走
    单节点模式：11 个工作区、可发送。
  - 全程 `logcat -b crash` 为空、无 `FATAL EXCEPTION`；截图仅本地留存
    （`android/.tmp/hub-e2e/`，含真实主机地址与临时 token，不入库）。

- 0.5.0 分发化冒烟（2026-11-05，Android 16 / API 36 x86_64 模拟器；真 hub 0.9.0
  `http://127.0.0.1:8790`、真节点 `DESKTOP-NODE-A` 在线；`adb reverse tcp:8790 tcp:8790`）：
  - **通用 debug APK**：`dshlink-control-0.5.0-debug.apk` 11,993,941 bytes，SHA-256
    `9EC9B661A3A7A82F2B1846AA8906E8C644070FE1EAA1D4742CFBC551314A026A`；
    `aapt2 dump badging` 显示 versionCode 6 / versionName 0.5.0 / debuggable；`jar tf` 里
    **没有任何** `assets/tunnel/*` 条目（通用 APK 不含凭据）。
  - **release 签名 APK**：`dshlink-control-0.5.0.apk` 11,993,940 bytes，SHA-256
    `8828B1C42F75277067ED0D4670CAEE7DA1F00126B53E2A6D0133A212C34DF406`；
    `apksigner verify --print-certs` 通过（测试 keystore，CN=DshLink Test）；badging 里没有
    `application-debuggable`，也没有 `assets/tunnel/*`。
  - **内部构建回退校验**：把 `assets/tunnel/` 四件套放回后构建 → 警告 `this APK will contain
    tunnel credentials (internal build only…)`，`jar tf` 含四个 `assets/tunnel/*` 条目；该 APK
    仅本地留存（`android/.tmp/internal-0.5.0-debug.apk`），随后移走 `assets/tunnel/` 重建为
    通用 APK。
  - **CLI code 导入连接（文件 + 粘贴各一次）**：`dshlink hub invite --phone --no-tunnel` 现签
    code（label `android-dist-cli`，tokenId `tok_01example0000000000000000`，入口
    `http://127.0.0.1:8790`）分别用“从文件导入”（.txt）和“粘贴导入”导入：摘要显示
    标签/入口/地址/到期/隧道=无；点“开始连接”后状态“已连接 · 11 个工作区 ·
    DESKTOP-NODE-A · 可发送”，节点下拉“DESKTOP-NODE-A（在线）”，工作区/会话正常
    加载。→ CLI 生成 code 在 hub 0.9.0 热加载修复后可直接导入连接。
  - **真实远程发送 / transcript 增长**：hub 模式打开 `[phone-e2e] 手机控制端联调`
    （`session-573fa0ec…`），App 内发送 queue 消息；hub API 查 transcript 从 38 条增长到 54 条
    （用户消息 seq 174），bridge 命令 `cmd_01m6p2kpe28022041c4b91`（`sessions.prompt`，
    origin `hub:DESKTOP-HUB-A`）claim/done，节点真实回复 seq 216，端到端约 4.7 s；
    全程 DSH host / 节点未重启。
  - **合成隧道 profile**：导入含 `frpc.toml`（含 `{{DIR}}`）+ 假证书的 code →
    `files/tunnel/` 写入 `frpc.toml`/证书，生成 `frpc.runtime.toml`（`{{DIR}}` 已替换为私有目录
    绝对路径），prefs 记录 label/entry/expires/tunnel 等；假证书使 frpc 20 秒超时 → 弹
    “中转启动失败”+ 最近 12 行日志（已去 ANSI 颜色码）。
  - **无隧道导入清理**：导入 `tunnel:null` 的 code 后 `files/tunnel/` 里 `frpc.toml` 与证书被
    删除、`tunnel=false`、URL 框恢复可编辑并直连 `entry.url`。
  - **真实 STCP 隧道导入（手机不在任何同一网络）**：本机 hub 的 `frp.enabled` 已配置（公网
    frps + mTLS 证书 + provider `dshlink-phone`），用 hub HTTP API 现签一份 `tunnel:true` 的 code
    （7,031 字符，内嵌 `frpc.toml` 与 base64 mTLS 证书），用“从文件导入”导入 → 摘要显示
    “隧道：含 STCP 中转凭据（本机 127.0.0.1:18790）”；App 把 `frpc.toml` + 三张证书写进
    `files/tunnel/`，生成 `frpc.runtime.toml`（`{{DIR}}` 已替换为私有目录绝对路径），拉起
    `libfrpc.so` 子进程；`frpc.log` 显示 `login to server success`、`visitor added: [phone-to-hub]`；
    状态“已连接 · 11 个工作区 · DESKTOP-NODE-A · 可发送”，全程**没有** `adb reverse` ——
    请求路径是 手机 → 公网 frps → hub 的 STCP provider → hub `8790`。
  - **真实隧道远程发送**：经该隧道打开 `session-573fa0ec…` 发送
    `android stcp e2e 2302 no action needed`，App 显示“已发送 · #225 · 用户”；hub API 查
    transcript 从 54 条增长到 63 条（`latestSeq 245`），bridge 命令
    `cmd_01m6p3k3cpcccff7b1ee72`（`sessions.prompt`，origin `hub:DESKTOP-HUB-A`）
    claim/done，节点真实回复 seq 227/245；DSH host、节点、hub 全程未重启。
  - **错误路径（均不崩溃；`logcat` 无 `FATAL EXCEPTION`）**：粘贴/文件导入非法内容 →
    “导入失败”+原因；过期 code → 摘要标注“（已过期）”并提示重新生成（导入不拒绝；token 尚未
    过期时仍能连，`expiresAt` 仅提示）；token 被 hub 吊销后点“刷新工作区/连接” →
    “鉴权失败：token 无效或已过期”；勾选隧道但未导入 profile → “尚未导入隧道配置，请向 hub
    管理员获取连接串/配置文件并导入”；导入含隧道 profile 后删掉证书 → “导入的隧道配置缺少
    client.crt，请重新导入连接串/配置文件”。
  - 截图与测试工件仅本地留存（`android/.tmp/`，含真实主机名/token，不入库）。

- 0.6.0 一次性引导 + 每设备 mTLS 冒烟（2026-11-06，Android 16 / API 36.1 x86_64 模拟器
  `emulator-5554`；本地 e2e hub 0.10.0：`hub serve` 监听 `127.0.0.1:8795`，手机网关
  `https://127.0.0.1:8796`（自签 CA），`adb reverse tcp:8796/8795`；未触碰 8787/8790）：
  - **APK（通用构建）**：`dshlink-control-0.6.0-debug.apk` 12,010,326 bytes，SHA-256
    `AF3DD876385F9084C08B35FD94DFB00C6ACB7D7F71F95F10D65019A976C34CE5`；
    `aapt2 dump badging` → versionCode 7 / versionName 0.6.0 / minSdk 26 / targetSdk 36 /
    native-code arm64-v8a x86_64；`jar tf` 无 `assets/tunnel/*`（`tunnel credentials: none
    (distribution build)`）；`apksigner verify` 通过（debug 证书）。
  - **dshlink2 导入**：用 `adb shell am start -a android.intent.action.SEND -t text/plain
    --es android.intent.extra.TEXT <code> -n dev.dshlink.control/.MainActivity` 从“分享”路径导入
    （同时覆盖冷启动与前台 `onNewIntent`）；摘要显示标签/入口/地址/CA 指纹/引导码到期/无隧道/
    来源，主界面出现“安全模式：每设备证书（mTLS） · CA …”与“设备证书：… · 到期 … ·
    私钥 AndroidKeyStore（不可导出）”，token 输入框禁用。
  - **一次性引导 + mTLS**：logcat `开始一次性引导：deviceId=274574db-… entry=https://127.0.0.1:8796`
    → `引导成功：设备证书 0E:9C:41:63:…，到期 2027-11-06T14:52:44.000Z`；hub 日志
    `phone gateway: enrolled e2e-final (ph_01m6rnj1z599f386427e1a) fingerprint 0E:9C:…`；
    `GET /api/v1/phone/me` + `/api/v1/info` 成功（状态“已连接中心服务器 · 还没有登记节点”，
    summary“中心服务器 e2e-hub · dsh-link-hub 0.10.0 · 0 个节点 · 0 在线 · 每设备证书 mTLS”）。
    `shared_prefs/dshlink.xml` 里 `profile.secureMode=cert`、`phone.keyStorage=keystore`、
    `phone.bootstrapId` 保留、**`phone.bootstrapSecret` 不存在**（兑换成功后即清除）。
  - **吊销**：CLI `dshlink hub phone revoke 274574db-…`（需先停 hub，因为运行中的 `hub serve`
    不热加载 CLI 吊销，见 §6）→ App 连接收到 `403 phone_revoked` → 弹窗“本机设备证书已被
    hub 管理员吊销…本机证书已自动清除”；prefs 中 certPem/certFingerprint/certValidTo/
    keyStorage 被删除、deviceId 保留。
  - **恢复**：吊销后导入新引导码 → `设备证书已清除（alsoDeviceIdentity=true）` → 新 deviceId
    `a089181d-…` → 新证书 `4E:C3:52:AE:…`（hub 记录 `ph_01m6rnm7ym47c016348d95`，
    appVersion 0.6.0、status active、lastSeenAt 更新）→ 界面恢复“已连接中心服务器”。
  - **旧路径兼容**：导入 `dshlink1:`（device token + 无隧道）→“安全模式：设备 token（Bearer）”，
    连 hub `127.0.0.1:8795` 成功、工作区/会话正常。
  - **Keystore 关键修复**：Android 16/Conscrypt 的 TLS 1.3 客户端证书签名走 `NONEwithECDSA`
    （raw digest）；若 AndroidKeyStore EC 密钥只授权 SHA256/384/512，keymaster 报
    `INCOMPATIBLE_DIGEST`，表层是 `SSLHandshakeException: Read error…`。0.6.0 生成密钥时
    额外授权 `DIGEST_NONE`，并对已存在旧密钥做 `NONEwithECDSA` 探测、失败则重建（重建后需重新
    引导）。另修 2 分钟时钟偏差容忍（证书 notBefore 略超前不再误报）。
  - 截图与自测记录：`android/dist/selftest-0.6.0/`（`01-connected-mtls.png`、
    `02-revoked-dialog.png`、`03-recovered-new-device.png`、`04-legacy-token-mode.png`、
    `selftest-0.6.0.md`）。
  - 未验证：真机 arm64、dshlink2 + 真实公网 STCP 隧道、强制 TLS 1.2、证书自然过期场景。

- 0.6.1 手机侧 STCP + 阿里云 phone-frps 真链路冒烟（2026-11-07，Android 16 / API 36.1
  x86_64 模拟器 `emulator-5554`；真实 hub 0.10.0 @ 8790，phone gateway `https://127.0.0.1:8791`
  mTLS；独立 phone-frps @ 阿里云 VPS `203.0.113.10:16445`；手机侧 visitor 18790）：
  - **APK（通用构建）**：`dshlink-control-0.6.1-debug.apk` 12,010,323 bytes，SHA-256
    `B65D7ECAC3212240682082B5B0877E923F64052542C5C4255A988A4C8BA744D2`；
    `aapt2 dump badging` → versionCode 8 / versionName 0.6.1 / minSdk 26 / targetSdk 36 /
    native-code arm64-v8a x86_64；`tar -tf` 无任何 `assets/` 条目（`tunnel credentials: none
    (distribution build)`）；`apksigner verify` 通过（debug 证书）。
  - **导入 dshlink2（含内置 tunnel）**：文件导入 `dshlink2:` 码 → 摘要显示标签/入口
    `https://127.0.0.1:18790`/CA 指纹/引导码/“隧道：含内置隧道” → “开始连接”后自动 bootstrap
    换证书（设备 `ph_…` 在 hub `devices: 1 active`），界面显示“安全模式：每设备证书（mTLS） ·
    CA … · 设备证书：… 到期 2027-11-07 · 私钥 AndroidKeyStore（不可导出）”。
  - **经公网 phone-frps 的连接**：状态“已连接 · 11 个工作区 · DESKTOP-NODE-A · 可发送”，
    summary “中心服务器 DESKTOP-HUB-A · dsh-link-hub 0.10.0 · 1 个节点 · 1 在线 ·
    当前 DESKTOP-NODE-A · 每设备证书 mTLS”；工作区列表 11 个；dsh-link 会话列表
    “共 12 个会话（7 个子智能体）”；打开 `[phone-e2e] 短回复` 拉到 28 条消息
    （状态“共 28 条 · DESKTOP-NODE-A（经 DESKTOP-HUB-A） · 每 2.5 秒仅在前台刷新”）。
  - **发送 + 回复**：会话页发送 `phone-frps e2e probe: reply exactly PHONE_FRPS_OK` →
    transcript 出现 `#73 · 用户 · 08:44:54`，约 2 s 后 `#75 · 思考` 与
    `#75 · DSH · 08:44:56 / PHONE_FRPS_OK`；即 App → STCP visitor 18790 → phone-frps(VPS) →
    hub provider → phone gateway 8791 → hub 8790 → 节点 → DSH 会话 → 回复 → App 轮询，全链路闭环。
  - **根因与修复**：`TunnelManager.healthy()` 原来用 `HttpURLConnection` 请求
    `http://127.0.0.1:<localPort>/healthz`；phone gateway 是 HTTPS(mTLS) 监听，明文 HTTP 打
    HTTPS 必抛 IOException，healthy 永远 false，于是 20 s 超时误报——其实 frpc 日志已
    `start visitor success / visitor added [phone-to-hub]`。修复为
    `new Socket().connect(new InetSocketAddress("127.0.0.1", localPort), 800)` 的 TCP 探测，
    对 node gateway / 8788 token gateway / mTLS phone gateway 三种监听都成立。
  - 截图仅本地留存（`test/.tmp/phone-frps-reply-clean.png`、`phone-frps-main.png`，含真实
    主机名/证书指纹，不入库）。
  - **0.10.1 升级后复测（2026-11-07 16:50）**：hub 重启为 0.10.1、phone-frps 自动重连
    （frpc run id `929b5e83c3ba2edc`，login success / visitor added），App 重新点“连接”恢复
    “已连接 · 11 个工作区 · DESKTOP-NODE-A · 可发送”与 hub 0.10.1 summary。随后用
    0.10.1 现签的真机连接串（label `real-phone-2026-11-07`，24 h，含隧道）在独立 visitor
    （bindPort 18791）上验证：`https://127.0.0.1:18791/healthz` 用码内 gateway CA 校验通过，
    返回 `{ok:true, name:DESKTOP-HUB-A, role:phone-gateway, version:0.10.1}`；
    该码已交付用户文件 `C:/Users/example/phone-invite-v2-real-2026-11-07T08-51-31-296Z.txt`。
  - 未验证：安卓真机 arm64（frpc 二进制与 0.2.0 相同）、证书自然过期场景。

- 0.6.2 二维码导入冒烟（2026-11-07，Android 16 / API 36 x86_64 模拟器 `emulator-5554`；
  hub `https://127.0.0.1:18790` phone gateway mTLS；真机 arm64 未验证）：
  - **APK（通用构建，无 `assets/tunnel/`）**：`dshlink-control-0.6.2-debug.apk` 12,284,757 bytes，
    SHA-256 `F1FC4B3737E3D186E11B50D9C0792C83D13C54B2DAA9ED82F04FC52CBB9CCC55`；
    `aapt2 dump badging` → versionCode 9 / versionName 0.6.2 / minSdk 26 / targetSdk 36 /
    native-code arm64-v8a x86_64；permissions `INTERNET` + `CAMERA`；
    `uses-feature-not-required` camera/camera.any；`jar tf` 无任何 `assets/` 条目，
    `classes.dex`（693,120 bytes）含 `com/google/zxing/MultiFormatReader`、`ScanActivity`、
    `QrAssembler`、`QrImages`；`apksigner verify` 通过（debug 证书）。
  - **解码器单测（桌面 JDK17，直接跑 vendored ZXing jar）**：`QrAssembler` 38/38 通过
    （乱序/重复帧、total 不匹配重置、同帧号不同内容重置、非帧文本、超过 32 帧、超大连接串上限）；
    `QrImages` 31/31 通过——`scripts/qrgen.mjs` 生成的 8 帧真实 dshlink2 连接串全部解出并拼回
    7,171 字符原码；倒置/50% 缩放图像、相机 Y 平面、旋转 Y 平面、噪声返回 null；其中 frame-06
    普通检测失败、靠 TRY_HARDER+PURE_BARCODE/旋转重试才解出（证明重试链，桌面 fixture
    `test/.tmp/qr-hard-frame-01.png` 同样通过）。
  - **模拟器图像导入 e2e（8 帧）**：`adb push` 到 `/sdcard/Download/qr-e2e/` 后（adb 推送的文件
    需逐个广播 `MEDIA_SCANNER_SCAN_FILE` 才会出现在 DocumentsUI）长按多选 8 张 PNG → 导入对话框：
    标签 `android-qr-e2e`、入口 `https://127.0.0.1:18790`、安全模式“每设备证书（mTLS，一次性
    引导）”、CA 指纹、引导码/到期/隧道字段均正确、“来源：二维码图片（8 帧）” → “开始连接”后
    自动 bootstrap（logcat `引导成功：设备证书 3F:FE:82:…`）→ 状态“已连接 · 11 个工作区 ·
    DESKTOP-NODE-A · 可发送”，summary 为 hub 0.10.1 / 1 节点 / 每设备证书 mTLS；打开
    dsh-link 工作区，会话列表“共 13 个会话（8 个子智能体）”。截图本地留存于
    `android/.tmp/e2e-*.png`（含真实主机名/指纹，不入库）。该 e2e 消耗了 fixture dshlink2 码的
    一次性引导码（测试标签 `android-qr-e2e`，非用户真机码）。
  - **相机扫描冒烟**：撤销 CAMERA 权限后点“扫描二维码（相机）”→ 系统权限弹窗；拒绝 → 弹窗
    “无法使用相机”+“没有相机权限…仍可用从文件导入”+“去系统设置/返回”，返回后进程未重启、
    logcat 无崩溃；允许 → `ScanActivity` 打开（扫码提示 + 帧进度文案），logcat
    `CameraService: Start camera streaming for dev.dshlink.control`；按返回 →
    `Stop camera streaming` + `Disconnected client for camera 1`，无崩溃。模拟器虚拟相机无
    真实二维码场景，真实扫码未验证。
  - **最终 APK 复装**：用最终构建重新 `adb install -r` 后启动即自动连回已保存的
    `android-qr-e2e` 配置（“已连接 · 11 个工作区 · DESKTOP-NODE-A · 可发送”），
    未重新消耗引导码；相机解码节流为 150 ms（`DECODE_INTERVAL_MS`）。
  - 已知未验证：真机 arm64 的相机解码路径、真实屏幕多帧扫码、极低分辨率/严重畸变截图。

- 0.7.0 界面重做 / Markdown 冒烟（2026-11-07，Android 16 / API 36 x86_64 模拟器 `emulator-5554`；
  真实节点 dsh-link 0.11.0 `/api/v1/info` + device token `ui-070-test`，验证后已吊销）：
  - **APK（通用构建，无 `assets/tunnel/`）**：`dshlink-control-0.7.0-debug.apk` 12,301,450 bytes，
    SHA-256 `48764E9E9C87D2559303C555A06839D85F1D94DCF82809FC042EFF86F7565512`；
    `aapt2 dump badging` → versionCode 10 / versionName 0.7.0 / minSdk 26 / targetSdk 36 /
    native-code arm64-v8a x86_64；permissions `INTERNET` + `CAMERA`；`unzip -l` 16 个条目，
    无任何 `assets/`、无隧道凭据；`apksigner verify` 通过（debug 证书）。
  - **界面**：底部 tab 工作区（默认）/连接/设置；宽屏 `wm size 1600x2560`（density 420 → 609dp，
    命中 `layout-sw600dp`）自动切换为左侧栏，内容区显示工作区列表。连接成功后自动回到工作区。
  - **工作区/会话**：状态“已连接 · 11 个工作区 · DESKTOP-NODE-A · 可发送”，控制节点显示本机
    `DESKTOP-NODE-A`（修复 hub-enrolled 节点误显示 hub 名）；会话列表“共 14 个会话（9 个
    子智能体）”；进入会话前台每 2.5s 增量刷新，加载更早可用（顶部行 `#829` → `#282`）。
  - **Markdown**：标题、表格（列对齐）、表格单元格内行内代码/链接、围栏代码块（灰底等宽）、行内
    代码、`[text](url)` 可点击；`PHONE_FRPS_OK` 保留字面下划线；assistant 头部时间由 epoch `time`
    渲染为 `HH:mm`。reasoning 默认折叠、可展开（“思考 · 时间 · 预览”）；工具调用/结果按组折叠、
    展开显示完整 JSON。
  - **设置页**：显示当前连接与安全模式；“清除连接（地址与令牌）”确认后清空会话、地址与令牌，随后
    手动重连成功。
  - **发送 e2e（steer）**：在 `[phone-e2e] 短回复`（session-1aa41492-8bb7-48b1-9ed9-ce4b5e6f3f5a）
    勾选插话发送 “UI070 probe: reply exactly UI070_OK”，transcript 33 → 37 条，assistant 回
    `UI070_OK`。
  - **证据**：本地留存 `android/dist/selftest-0.7.0/`（9 张截图，git-ignored）；截图另复制到
    `docs/mobile/screenshots/`（该目录 git-ignored）。
  - 已知未验证：真机 arm64 的 UI 与相机扫码、折叠屏内屏实际表现（仅用 `wm size` 模拟 ≥600dp）。
> 仓库版本 0.6.0 起包含本 App；App 自身版本为 0.7.0（versionCode 10），与节点/CLI 独立演进
> （当前仓库/节点 0.11.2，hub 0.11.2；hub 直连 + dshlink2 每设备证书是主推入口）。
