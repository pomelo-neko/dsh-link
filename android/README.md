# dsh-link 控制端（Android）

一个**手机控制端**，不是移动版 DSH 节点：它不加入 dsh-link 网络，只连接到一个已经在跑的
dsh-link 节点，把该节点看到的 DSH 工作区/会话/transcript 显示在手机上，并通过节点的能力通道
（`sessions.prompt`）向指定会话发消息。

- 包名：`dev.dshlink.control`，版本 `0.3.0`，minSdk 26，targetSdk 36
- 纯 Java + Android 平台 API，**无 Gradle、无 AndroidX、无第三方依赖**
- 不常驻、不后台轮询：列表在进入/手动刷新时拉一次；会话界面只在 **前台可见期间** 每 2.5 s 拉一次增量
- 0.3.0：连接后可选择该节点网络里**直连**的其他节点并远程读写/发消息；标注子智能体会话；
  连续的工具调用/结果折叠成一行，点击展开；内置 STCP 中转改指 **8788 token 网关**
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
经中转连接与收到的真实 DSH 回复见 `docs/mobile/CONTROL-APP.md` §4。

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

> 需要更严格的最小权限时，把 `capabilities.peers["phone"]` 配成只允许 `sessions.prompt`
> （`peer` 取 token 的 `--label` 或 `--peer`），或把 token 的 `--ttl-days` 缩短；吊销：
> `node bin\dshlink.mjs token rm --id <id>`。

### 2.3 手机怎样到达节点

节点默认 `bind: 127.0.0.1`，手机当然连不上。可选路径：

1. **局域网 / VPN（推荐）**：把节点 `bind` 改成手机能到的地址（如 `0.0.0.0` 或 VPN 网卡地址），
   手机填 `http://<节点IP>:8787`。若用 Tailscale/WireGuard，节点只需 bind 到 VPN 地址，
   公网不暴露任何端口。
2. **反代 + TLS**：在节点前放 Caddy/Nginx，给手机一个 HTTPS 域名；App 支持 https。
3. **内置阿里云 STCP 中转（0.2.0 起，0.3.0 改进：跨公网）**：App 自己带 frpc，勾选复选框后
   无需填节点地址，由手机经 frps 连接到节点发布给手机的 STCP provider（`dshlink-phone`），
   落到 **8788 token 网关**。详见 2.4。**不要把明文 8787 直接暴露到公网。**

App 允许 cleartext HTTP（`usesCleartextTraffic="true"`），这是为局域网/VPN/STCP 场景准备的；
公网路径必须由 STCP 的 TLS 或反代承担加密。

### 2.4 内置阿里云 STCP 中转（0.2.0 起；0.3.0 经 8788 网关）

手机不在节点局域网时，不需要 VPN，也不需要节点开公网端口：把 frpc 的 STCP **visitor** 跑在手机里。
0.2.0 把 Linux x86_64（模拟器）和 arm64（真机）的 frpc 作为 `libfrpc.so` 打进 APK，启动时
解压证书/配置到应用私有目录，执行 visitor，在本机 `127.0.0.1:18788` 打开一个端口；App 随后
像连普通节点一样连这个本地端口。

0.3.0 改变了隧道落点：节点侧由 `dshlink tunnel sync` 额外发布一个 **指向 8788 网关**的 STCP
provider（默认名 `dshlink-phone`，配置来自 `gateway.provider`），不再是旧的 8787 provider。
所以手机 → frps → `dshlink-phone` → `127.0.0.1:8788` → 网关校验 device token → 8787。
网关对每个请求都要求 token 且**不信任回环来源**，因此 STCP 凭据本身不再能绕过 dsh-link 认证；
audit 里能看到真实 device 角色。frps 仍是阿里云 `203.0.113.10:16443`。

前提（缺一不可）：

- 节点 `gateway.enabled=true`、`gateway.provider.secretKey` 已填，且节点侧 frpc 配置里有
  对应的 STCP provider（`dshlink tunnel sync` 会自动生成；本机是
  `C:\Users\example\.dshlink\frp\frpc.toml` 里的 `dshlink-phone` → localPort 8788）；
- 手机能出站访问 frps 的 `serverPort`（16443/TCP）；
- 构建前要在本地生成 `android/app/src/main/assets/tunnel/`（frpc.toml + 三份证书），其中
  `serverName` 必须是节点发布给手机的那个 provider 名（`dshlink-phone`）。这个目录含共享凭据，
  已被 `.gitignore` 忽略、不进仓库；模板与生成步骤见
  [`android/tunnel/README.md`](tunnel/README.md)。换环境时必须替换，且**不要把这个 APK
  公开分发**。

App 里的操作：打开 App → 勾选“通过阿里云 STCP 中转至 8788 网关” → 填 device token → 点“连接”。
URL 输入框会被禁用并显示本地 visitor 地址 `http://127.0.0.1:18788`。首次连接会等待最多 20 秒
让 frpc 登录 frps、注册 visitor；失败时弹窗会带 `frpc` 日志尾部。成功后所有请求都走
手机 → frps → 节点 provider → 8788 网关，与局域网连接完全相同，只是必须带 device token。

自测（本机，不经手机）：

```powershell
# 用仓库里的 frpc 起一个 visitor，模拟手机侧（provider 名必须与节点一致）
& D:\dsh-home\plugins\vendored\dsh-link\vendor\frp\windows-amd64\frpc.exe -c C:\Users\example\.dshlink\frp\frpc-visitor-phone.toml
Invoke-WebRequest http://127.0.0.1:18788/healthz   # 无 token 应是 401（网关拒绝），而不是 200
```

> 安全警告：`assets/tunnel/` 里的 frpc 配置包含 frps auth token、mTLS 客户端证书/私钥和 STCP
> `secretKey`。它们等价于“能连到节点 8788 网关的凭据”，但**不再等价于节点 API 权限**：
> 网关仍要求 device token，且拒绝 `/mcp`、`/api/v1/bridge/*`。泄露后仍应轮换 frps token、
> 重签 mTLS 证书、更换 STCP secretKey 并吊销 device token。不要把 APK 公开分发。

## 3. 构建（无 Gradle）

### 3.1 依赖

- JDK 17+（本仓库在 JDK 26 上验证过）
- Android SDK，至少：
  - `platform-tools`
  - `platforms;android-36`
  - `build-tools;36.0.0`

安装（sdkmanager.bat 会把带分号的包名拆参，用新版 `android.exe` 或 `cmd /c` 包一层引号）：

```powershell
D:\AndroidSdk\cmdline-tools\bin\android.exe --sdk=D:\AndroidSdk sdk install 'platforms;android-36'
D:\AndroidSdk\cmdline-tools\bin\android.exe --sdk=D:\AndroidSdk sdk install 'build-tools;36.0.0'
D:\AndroidSdk\cmdline-tools\bin\android.exe --sdk=D:\AndroidSdk sdk install 'platform-tools'
```

### 3.2 一条命令

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-26.0.2.1'
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Sdk D:\AndroidSdk
```

脚本只调用 SDK 里的 `aapt2 / javac / d8 / zipalign / apksigner`：

```text
aapt2 compile → aapt2 link → javac --release 11 → d8 --min-api 26
→ jar uf classes.dex / assets / lib/<abi>/libfrpc.so → zipalign
→ (首次) keytool 生成 debug.keystore → apksigner sign/verify
```

内置中转所需的 `assets/tunnel/` 与 `native/lib/<abi>/libfrpc.so` 不在仓库里：先按
[`android/tunnel/README.md`](tunnel/README.md) 在本地生成，否则构建脚本会直接报缺文件。

产物：

```text
android/dist/dshlink-control-0.3.0-debug.apk
```

这是 **debug 签名**的 APK，适合自用/内测；上架或长期分发请换成自己的 release keystore
（`build-apk.ps1` 里的 `keytool`/`apksigner` 两步）。

0.2.0 起 APK 还包含（0.3.0 把隧道指向 8788 网关，`frpc.toml` 的 provider 名相应改为
`dshlink-phone`）：

- `assets/tunnel/{frpc.toml,ca.crt,client.crt,client.key}`：内置 visitor 配置与证书（本地生成，
  不进仓库）；
- `lib/x86_64/libfrpc.so`、`lib/arm64-v8a/libfrpc.so`：模拟器/真机可执行的 frpc。
  源码是 frp v0.71.0 的 Linux 二进制（x86_64 来自本机 frp-stcp-base，arm64 来自
  `frp_0.71.0_linux_arm64.tar.gz`），打包进 APK 的 `lib/<abi>/`，Android 解压到
  `nativeLibraryDir` 后 App 直接 exec。换 frp 版本时同时替换这两个文件和
  `vendor/frp/README` 记录，并验证 `frpc --version`。

### 3.3 安装

```powershell
D:\AndroidSdk\platform-tools\adb.exe install -r android\dist\dshlink-control-0.3.0-debug.apk
```

或者把 APK 传到手机点击安装（需允许“安装未知来源应用”）。

## 4. 使用

1. 打开 App，填节点地址（如 `http://192.0.2.20:8787` 或 `http://100.64.0.5:8787`）
   和 2.2 生成的 device token，点“连接”。不在同一局域网时勾选“通过阿里云 STCP 中转至 8788
   网关”，地址框会自动禁用并由 App 启动内置 frpc（见 2.4）。
2. 连接成功后看到工作区列表；点进工作区看会话；archived 会话默认隐藏，可勾选“显示已归档”。
   顶部“控制节点”下拉框列出入口节点可见的节点：选另一个**直连**节点即可远程浏览/发消息
   （0.3.0；经中转的二跳节点只展示不可选）。
3. 点会话进入 transcript：
   - 前台时每 2.5 s 自动拉 `sinceSeq` 增量；按返回键/切后台即停止；
   - 顶部“加载更早”向前翻页；
   - 底部输入框发送消息；勾选“插话（steer）”用 steer 模式，否则 queue；
   - 连续的工具调用/结果默认折叠成一行（“#seq · 工具调用 · N 条 · 点击展开”），点击展开/收起。
4. 顶部状态栏会显示当前节点、只读提示或错误原因；token/URL 错误、能力未开、命令超时
   都有对应提示。

App 不保存多个节点配置（只有一组入口 URL + token），也不在后台同步；换入口节点重新填即可。
远程节点的发送结果不轮询命令 id，只提示“已提交 · 由 <节点> 处理”，回复看 transcript 增量。

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
- **内置中转凭据（0.2.0 新增；0.3.0 已有网关兜底）**：APK 的 `assets/tunnel/` 里有 frps auth
  token、mTLS 客户端证书/私钥和 STCP `secretKey`；拿到 APK 的人可以连到节点的 STCP provider。
  0.3.0 起该 provider 指向 **8788 网关**，网关对每个请求都要求 device token 且不信任回环来源，
  所以 STCP 凭据不再等于节点 API 权限；但 APK 仍只私下给自己/信任的人，不要上传应用商店或
  公开链接。泄露后要换 frps token、重签 mTLS 证书、改 STCP secretKey，并吊销 device token。
- **token**：device token 存在 App 的 `SharedPreferences`（应用私有，但未加密）；手机丢失
  请在节点上 `token rm --id` 吊销。token 可以只给 30 天有效期。
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
- 这是 **debug APK**，没有代码混淆、没有证书固定；不要从不明来源安装二次打包的 APK。

## 6. 已知限制

- **没有推送/SSE**：会话更新靠前台每 2.5 s 轮询；退到后台就停止，没有通知栏提醒。
- **没有离线缓存**：断网后重新进入页面会从头拉。
- **单入口节点**：一个 App 实例只保存一组入口 URL + token；0.3.0 可以切换到该入口节点的
  直连 peer，但经其他节点中转（`via` 非空）的二跳节点只展示、不可控制。
- **远程发送不跟踪命令 id**：远程节点的 `POST /dsh/call` 只返回“已提交”，命令状态在 peer 的
  队列里；结果通过 transcript 增量看。
- **只做浏览与发消息**：不能新建/重命名/归档会话，不能发附件，不能看文件根。
- **命令依赖 bridge**：DSH host 或 bridge 不在线时，发送命令会 pending→expired（默认 120 s）。
- **Android 版本**：minSdk 26（Android 8.0）及以上；targetSdk 36。
- **内置 frpc**：只带 x86_64（模拟器）与 arm64-v8a（真机）两个架构；Android 10+ 才允许执行
  `nativeLibraryDir` 里的二进制。APK 因两个 frpc 约 12 MB；首次中转连接最多等 20 秒。
  个别 Android 15/16 的 16 KB page-size 设备若拒绝执行 4 KB 对齐的 Go 二进制，会弹
  “frpc 未能在 20 秒内建立中转”，此时改用 VPN/局域网路径（或换 16 KB 对齐的 frpc 重新打包）。

## 7. 验证

- 构建：`android/build-apk.ps1` 退出码 0；`aapt2 dump badging` 显示
  `package dev.dshlink.control`、`versionName 0.3.0`、`minSdk 26`、`targetSdk 36`。
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

> 仓库版本 0.6.0 起包含本 App；App 自身版本为 0.3.0，与节点/CLI 独立演进（当前节点 0.7.0）。
