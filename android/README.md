# dsh-link 控制端（Android）

一个**手机控制端**，不是移动版 DSH 节点：它不加入 dsh-link 网络，只连接到一个已经在跑的
dsh-link 节点，把该节点看到的 DSH 工作区/会话/transcript 显示在手机上，并通过节点的能力通道
（`sessions.prompt`）向指定会话发消息。

- 包名：`dev.dshlink.control`，版本 `0.1.0`，minSdk 26，targetSdk 36
- 纯 Java + Android 平台 API，**无 Gradle、无 AndroidX、无第三方依赖**
- 不常驻、不后台轮询：列表在进入/手动刷新时拉一次；会话界面只在 **前台可见期间** 每 2.5 s 拉一次增量
- 深色不需要；UI 中文

> 可行性研究、方案对比与威胁模型见 [`docs/MOBILE-CONTROL-FEASIBILITY.md`](../docs/MOBILE-CONTROL-FEASIBILITY.md)；
> 架构、API 映射与验证记录见 [`docs/mobile/CONTROL-APP.md`](../docs/mobile/CONTROL-APP.md)。

---

## 1. 它做什么

```text
连接节点 (URL + token)
  └─ 工作区列表          GET /api/v1/dsh/workspaces
       └─ 会话列表        GET /api/v1/dsh/sessions?workspace=…
            └─ 会话界面    GET /api/v1/dsh/sessions/{id}/transcript?tail=1&limit=200
                 ├─ 前台增量  GET …/transcript?sinceSeq=<lastSeq>&limit=200   （每 2.5 s）
                 ├─ 更早消息  GET …/transcript?tail=1&offset=<loaded>&limit=200
                 └─ 发送     POST /api/v1/dsh/call { sessions.prompt, waitSeconds:20 }
                              └─ 未完成时 GET /api/v1/dsh/call/{commandId} 轮询到终态
```

| 连接后（主界面） | 工作区里的会话 |
|---|---|
| ![main](../docs/mobile/screenshots/main.png) | ![sessions](../docs/mobile/screenshots/sessions.png) |

- **只读模式**：若 `/api/v1/info` 显示 `capabilities.enabled=false` 或 `methods` 不含
  `sessions.prompt`，App 顶部提示“只读模式”并禁用输入框；浏览功能不受影响。
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
3. **STCP/FRP？** 节点自己的 STCP **visitor 只监听节点本机的 127.0.0.1**，手机连不到
   （见可行性文档 §14）。想让手机走 frp，需要单独给手机配一个 TCP 类型代理 + TLS/反代，
   或者直接用第 1 条的 VPN。**不要把明文 8787 直接暴露到公网。**

App 允许 cleartext HTTP（`usesCleartextTraffic="true"`），这是为局域网/VPN 场景准备的；
公网必须由 TLS 反代或 VPN 承担加密。

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
→ jar uf classes.dex → zipalign → (首次) keytool 生成 debug.keystore → apksigner sign/verify
```

产物：

```text
android/dist/dshlink-control-0.1.0-debug.apk
```

这是 **debug 签名**的 APK，适合自用/内测；上架或长期分发请换成自己的 release keystore
（`build-apk.ps1` 里的 `keytool`/`apksigner` 两步）。

### 3.3 安装

```powershell
D:\AndroidSdk\platform-tools\adb.exe install -r android\dist\dshlink-control-0.1.0-debug.apk
```

或者把 APK 传到手机点击安装（需允许“安装未知来源应用”）。

## 4. 使用

1. 打开 App，填节点地址（如 `http://192.0.2.20:8787` 或 `http://100.64.0.5:8787`）
   和 2.2 生成的 device token，点“连接”。
2. 连接成功后看到工作区列表；点进工作区看会话；archived 会话默认隐藏，可勾选“显示已归档”。
3. 点会话进入 transcript：
   - 前台时每 2.5 s 自动拉 `sinceSeq` 增量；按返回键/切后台即停止；
   - 顶部“加载更早”向前翻页；
   - 底部输入框发送消息；勾选“插话（steer）”用 steer 模式，否则 queue。
4. 顶部状态栏会显示当前节点、只读提示或错误原因；token/URL 错误、能力未开、命令超时
   都有对应提示。

App 不保存多个节点配置（只有一组 URL + token），也不在后台同步；换节点重新填即可。

## 5. 安全说明（必读）

- **传输**：公网必须走 VPN（Tailscale/WireGuard 等）或 HTTPS 反代；明文 HTTP 仅限可信局域网。
- **token**：device token 存在 App 的 `SharedPreferences`（应用私有，但未加密）；手机丢失
  请在节点上 `token rm --id` 吊销。token 可以只给 30 天有效期。
- **最小权限**：device token 不能读写消息、不能管理 peers、不能碰 bridge 控制面；它仍能读
  **全部未排除的 DSH 工作区与 transcript**——这是 App 的功能本身，只应给自己信任的人装。
- **节点暴露面**：给手机开 `bind 0.0.0.0` 时，请同时确认：
  - `auth.trustLocalhost=false`（0.5 默认）；
  - 每个入口都要 token，且 token 有上限频率（`limits.maxRequestsPerMinute`）；
  - 不要启用 `relay` 或不必要的 `files.allowUpload`；
  - 若使用反代，TLS 由反代终止，节点仍只听内网/回环。
- 这是 **debug APK**，没有代码混淆、没有证书固定；不要从不明来源安装二次打包的 APK。

## 6. 已知限制

- **没有推送/SSE**：会话更新靠前台每 2.5 s 轮询；退到后台就停止，没有通知栏提醒。
- **没有离线缓存**：断网后重新进入页面会从头拉。
- **单节点**：一个 App 实例只连一个节点。
- **只做浏览与发消息**：不能新建/重命名/归档会话，不能发附件，不能看文件根。
- **命令依赖 bridge**：DSH host 或 bridge 不在线时，发送命令会 pending→expired（默认 120 s）。
- **Android 版本**：minSdk 26（Android 8.0）及以上；targetSdk 36。

## 7. 验证

- 构建：`android/build-apk.ps1` 退出码 0；`aapt2 dump badging` 显示
  `package dev.dshlink.control`、`versionName 0.1.0`、`minSdk 26`、`targetSdk 36`。
- `apksigner verify --print-certs` 通过。
- API 契约（本机 node:test，`DSH_HOME` 指向真实 DSH 时运行）：
  `node --test test/mobile-contract.test.mjs` —— 覆盖 App 用到的 info / workspaces / sessions /
  transcript tail / transcript sinceSeq / dsh/call 提交与结果查询、device token 权限边界。
- 模拟器冒烟（x86_64 API 36.1，`adb install -r` + `am start`）：连接 device token → 工作区/会话列表；
  打开会话显示 `#seq · kind · HH:mm:ss`（本机真机时间曾是 epoch 毫秒，0.6.0 已修）；queue 发送与
  “插话（steer）”发送都被节点侧模拟 bridge claim/complete，params 分别为 `{sessionId,text}` 与
  `{sessionId,text,mode:"steer"}`，App 显示“已发送”；把 `sessions.prompt` 从能力白名单移除后重连，
  App 正确切到“只读模式”并禁用输入框；全程 `logcat` 无崩溃。

> 仓库版本 0.6.0 起包含本 App；App 自身版本仍是 0.1.0，二者独立演进。
