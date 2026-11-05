# 分发与部署（0.9）

这份文档面向**把 dsh-link 交给别人用**的场景，而不是只在一台机器上自用。它回答三件事：

1. 怎么打出一个别人能直接下载的**发行包**（含手机 APK）；
2. 怎么在**别人的服务器**上部署 hub，让多个节点接进来；
3. 怎么把 **APK** 发给手机用户，并让每部手机用自己的连接串接入（APK 里不含任何密钥）。

> 单机自用、点对点互连的用法见 [README](../README.md)；hub 拓扑的设计见
> [HUB-TOPOLOGY-DESIGN.md](HUB-TOPOLOGY-DESIGN.md)，部署后的日常运维见 [OPERATIONS.md](OPERATIONS.md)。

---

## 1. 发行物一览

| 发行物 | 路径 | 说明 |
|---|---|---|
| 通用发行包 | `dist/dsh-link-<version>-portable.zip` / `.tar.gz` | 节点 + hub + CLI + 文档 + 示例 + （可选）APK；零 npm 依赖 |
| 手机控制端 APK | 包内 `apk/dshlink-control-<version>-debug.apk` | 0.5.0 起**不含任何密钥/证书/隧道配置**，连接串在手机端导入 |
| 完整性清单 | 包内 `SHA256SUMS.txt`、`dist/SHA256SUMS.txt` | 逐个文件校验；下载后先验再装 |

发行包**不含** frps 服务端，也不含任何真实 token。`vendor/frp/` 里只有 frp **客户端**（`frpc`），
用来建立自己的 STCP 通道。公网中继服务器由部署者自备（见 [FRP.md](FRP.md)）。

---

## 2. 构建发行包

### 2.1 前置

- Node.js ≥ 20（仅用于运行，不需要 `npm install`）
- PowerShell（Windows 打包脚本）
- 可选：`vendor/frp/windows-amd64/frpc.exe`、`vendor/frp/linux-amd64/frpc`（从
  [frp releases](https://github.com/fatedier/frp/releases) 下载并放入；版本与 `vendor/SHA256SUMS.txt` 一致）
- 可选：WSL（生成 `.tar.gz` 时给 `install.sh` / Linux frpc 加可执行位；没有就用 Windows tar 兜底）

### 2.2 一条命令

```powershell
# 在仓库根目录
npm run bundle
# 等价于
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-bundle.ps1
```

脚本会：

- 从 `package.json` / `src/util.mjs` 读版本号，staging 到 `dist/stage/dsh-link-<version>`；
- 复制 `bin/ src/ docs/ integrations/ test/ examples/ packaging/ scripts/` 与 README/CHANGELOG/LICENSE/SECURITY 等；
- **自动带上最新 APK**（`android/dist/dshlink-control-*.apk`，取 mtime 最新者）到 `apk/`；
- 校验 vendor 里的 frpc 二进制哈希并一起打包；
- 生成 `SHA256SUMS.txt`、`BUNDLE-INFO.json`，再压缩为 `dist/dsh-link-<version>-portable.zip` 和 `.tar.gz`。

常用参数：

```powershell
# 指定某个 APK（发布时推荐，避免误带本地调试包）
powershell -File scripts/build-bundle.ps1 -Apk android/dist/dshlink-control-0.5.0-debug.apk

# 不打包 APK（只发节点/服务端）
powershell -File scripts/build-bundle.ps1 -NoApk

# 本机没放 frpc 二进制时
powershell -File scripts/build-bundle.ps1 -NoVendor

# 加后缀，便于同时保留多套构建
powershell -File scripts/build-bundle.ps1 -Suffix -rc1
```

### 2.3 校验

```powershell
# 校验发行包自身（Windows）
powershell -File scripts/verify-bundle.ps1 -Bundle dist/dsh-link-0.9.1-portable.zip
# 校验内容（任意平台）
sha256sum -c SHA256SUMS.txt
```

发布前请至少跑一遍全量自测：

```powershell
$env:DSH_HOME = 'D:\dsh-home'   # 没有 DSH 时可省略，MCP 用例会跳过
node test/run.mjs
```

---

## 3. 在别人的服务器上部署 hub

### 3.1 拓扑

```
        [ 手机 App ] --STCP visitor(本地回环)--+
                                              |
[ 节点 A ] --STCP visitor--> [ frps ] <--STCP provider-- [ hub:8790, Web 控制台 /ui ]
[ 节点 B ] --STCP visitor-->    |                         ^
                                +-------------------------+
                     节点通过 enroll 时生成的 frpc 配置访问 hub
```

- hub **只监听 127.0.0.1:8790**，公网入口是 frps 上的 STCP provider（加密、需 secretKey）；
- 所有 HTTP 请求都要 token（hub 从不信任回环来源），admin token 只显示一次；
- 节点第一次 enroll 需要能**直接访问** hub 一次（局域网/VPN/临时端口转发），之后自动改走 STCP 回环端口。

### 3.2 准备 frps 与证书

1. 一台公网服务器 + frps（0.71+），示例配置见 [examples/frps.toml](../examples/frps.toml)、部署细节见 [FRP.md](FRP.md)；
2. 生成 mTLS 证书（hub / 节点共用一套 CA）：

```powershell
powershell -File scripts/gen-certs.ps1 -Out C:\dshlink-certs -Host <frps-host>
# 产出 ca.crt / server.crt / server.key / client.crt / client.key
```

### 3.3 初始化 hub

把发行包解压到服务器（例如 `C:\dshlink`），然后：

```powershell
node bin\dshlink.mjs hub init --name team-hub --bind 127.0.0.1 --port 8790 --frp-server <frps-host> --frp-port 16443 --frp-token <frps-token> --frp-cert C:\dshlink-certs\client.crt --frp-key C:\dshlink-certs\client.key --frp-ca C:\dshlink-certs\ca.crt
```

输出会告诉你：**admin token（只显示一次，立刻保存）**、Web 控制台地址、hub 的 STCP provider 名与
secretKey、以及下一步命令。配置写在 `C:\Users\<you>\.dshlink-hub\dshlink-hub.config.json`。

> 可选：`--frpc-path` 指定 frpc 位置；其余高级项见 [HUB-TOPOLOGY-DESIGN.md](HUB-TOPOLOGY-DESIGN.md)。

### 3.4 启动 hub（常驻）

```powershell
node bin\dshlink.mjs hub serve
# Windows 常驻（计划任务，示例）
schtasks /Create /TN dshlink-hub /SC ONSTART /TR "node C:\dshlink\bin\dshlink.mjs hub serve" /RU SYSTEM /F
```

```bash
# Linux systemd（示例）
sudo tee /etc/systemd/system/dshlink-hub.service >/dev/null <<'EOF'
[Unit]
Description=dsh-link hub
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/dshlink/bin/dshlink.mjs hub serve
Restart=always
User=dshlink

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now dshlink-hub
```

健康检查：

```powershell
curl.exe -H "Authorization: Bearer <admin-token>" http://127.0.0.1:8790/healthz
curl.exe -H "Authorization: Bearer <admin-token>" http://127.0.0.1:8790/api/v1/hub/status
```

Web 控制台：`http://127.0.0.1:8790/ui`（在服务器本机浏览器打开；远程用 SSH 隧道
`ssh -L 8790:127.0.0.1:8790 <server>`，**不要**把 8790 直接暴露到公网）。

### 3.5 接入其他节点

在每台要接入的机器上解压发行包，先初始化并配置隧道：

```powershell
node bin\dshlink.mjs init --name node-a
node bin\dshlink.mjs tunnel setup --server <frps-host> --port 16443 --token <frps-token> --frpc <frpc 路径>
```

在 hub 上签发一次性 enroll token（或用控制台“接入令牌”卡片，role=enroll）：

```powershell
node bin\dshlink.mjs hub token new --role enroll --ttl-hours 2
```

在节点上 enroll（`--url` 填节点**现在能访问到的** hub 地址；hub 返回 STCP 凭据后会自动改回
`http://127.0.0.1:18790`）：

```powershell
node bin\dshlink.mjs hub enroll --url http://<hub-内网或VPN地址>:8790 --token <enroll-token>
node bin\dshlink.mjs tunnel sync      # 发布 to-hub visitor（bind 127.0.0.1:18790）
node bin\dshlink.mjs hub status
```

常见坑：

- 先 `tunnel setup` 再 `hub enroll`：enroll 需要节点自己的 STCP provider 名/secretKey 上报；
- hub 的 `--bind` 若改成 `0.0.0.0`，请确保前面有防火墙/TLS 反代，hub 本身不做 TLS；
- 手机/节点都通过 STCP 访问时，机器的 frpc 必须常驻（`tunnel sync` 启动，或用
  `install.ps1 -Task` 注册的服务）。

---

## 4. 把 APK 发给手机用户

### 4.1 构建 APK

```powershell
$env:JAVA_HOME = 'D:\AndroidSdk\jdk17\jdk-17.0.21.0.2+1'
powershell -File android\build-apk.ps1 -Sdk D:\AndroidSdk
# 产物：android/dist/dshlink-control-<version>-debug.apk
```

0.5.0 起构建**不再需要** `android/app/src/main/assets/tunnel/` 里的真实密钥：APK 出厂不含任何
frpc 凭据，连接串在手机上导入后写入应用私有目录。正式对外分发建议用自己的 release keystore
（见 [android/README.md](../android/README.md)），不要用 debug 签名包。
细节与权限说明见 [mobile/CONTROL-APP.md](mobile/CONTROL-APP.md)。

### 4.2 生成连接串（每部手机一份）

在 hub 上：

```powershell
# 生成、打印并保存到文件（内含 device token；hub 启用 FRP 时还内嵌 STCP 隧道与证书）
node bin\dshlink.mjs hub invite --phone --ttl-hours 2 --label "phone-alice" --out .\phone-alice.txt
```

或者打开 Web 控制台 → “手机接入”卡片 → 填标签/有效期 → **生成手机连接串** → 复制或下载 `.txt`。

- 连接串是一段 `dshlink1:...` 文本，**等同密码**：通过私密渠道（当面、加密 IM）发给对方；
- 生成的连接串**立即生效**（0.9 起运行中的 hub 会自动重载配置文件里的令牌，无需重启），
  吊销同样即时；
- 每个手机一个 label，便于之后在控制台/CLI 按令牌吊销：

```powershell
node bin\dshlink.mjs hub token list
node bin\dshlink.mjs hub token rm --id <token-id>
```

### 4.3 手机端安装与导入

1. 把 APK 传到手机（QQ/网盘/USB 均可），在文件管理器里点击安装，允许“安装未知来源应用”；
2. 打开 App（dsh-link 控制端）；
3. 点 **导入连接串** → 粘贴连接串（或选择 `.txt` 文件）→ 保存；
4. 勾选“通过阿里云 STCP 中转”，点 **连接**；App 会用连接串里的 frpc 配置在本机起 frpc visitor；
5. 连接成功后显示工作区/会话；发送消息走 hub → 节点 DSH。

连接串里的 token 有有效期（默认 2 小时，可在生成时调整），过期后重新生成一份；吊销旧 token 即可
让丢失的手机失去访问。

### 4.4 没有 FRP 的纯局域网用法

- 生成时加 `--no-tunnel --url http://<hub 局域网 IP>:8790`；
- 手机与 hub 在同一网段（或同一 VPN，如 WireGuard/Tailscale）即可直连；
- App 里不要勾选 STCP。

---

## 5. 升级与回滚

```powershell
# 1) 节点/hub：停进程 → 解压新包覆盖 → 重启
node bin\dshlink.mjs --version
node bin\dshlink.mjs hub status

# 2) DSH Host 里的 bridge 插件（只影响自动唤醒）
node bin\dshlink.mjs install-dsh --profile web --url http://127.0.0.1:8787 --write
# 插件是 ESM，必须重启 DSH Host 才生效

# 3) 手机：安装新 APK（版本号更高会覆盖安装，保留本地连接配置）
adb install -r dshlink-control-<new>-debug.apk
```

回滚就是解压上一版发行包并重启；hub 的节点表/令牌/缓存区都在 data 目录里，不随包覆盖。

---

## 6. 安全边界（分发时必须知道）

- **连接串 = 凭据**：内含 device token；启用 FRP 时还内含 STCP secretKey 与客户端证书私钥。
  不要贴到公开群、issue、日志里；泄露后立刻 `hub token rm` 吊销并在 hub 侧重建 provider。
- **APK 不含秘密**：0.5.0 起 APK 里没有 frpc 配置/证书/token。
  正式分发用 release keystore 签名，并在下载页给出 SHA-256。
- **hub 不做 TLS**：公网访问一律经 frps STCP（自带加密），或放在 HTTPS 反代后面；不要把 8790
  裸奔到公网。
- **hub 永不 trustLocalhost**：每次请求都校验 token；admin token 只在初始化时出现一次，丢了就
  `hub token new --role admin` 重新发。
- **最小权限**：手机用 `role=device` 令牌（只能读 DSH 视图 + 提交命令），不要发 admin 令牌给手机；
  每部手机一个令牌，方便单独吊销。
- **node 侧**：enroll 得到的 `hub.token` 存在节点配置里；`dsh.config` 里还可能有节点自己的
  inbound token，都按机密对待。excludeWorkspaces 记得排除 `dshlink-bridge` 与节点数据目录。

---

## 7. 发布检查清单

- [ ] `node test/run.mjs` 全绿（允许 frp 二进制缺失导致的 skip）
- [ ] 版本号一致：`package.json`、`src/util.mjs`（bridge 插件版本独立）
- [ ] APK 版本/versionCode 已递增，且构建自干净工作区
- [ ] `dist/dsh-link-<ver>-portable.zip` 与 `.tar.gz` 都生成，`dist/SHA256SUMS.txt` 更新
- [ ] 随机抽一台**干净机器**解压，按 `README-FIRST.md` 走一遍 init/serve/hub init/console 登录
- [ ] 手机上用**新生成的**连接串导入并连接成功，发一条消息、在 DSH 侧看到
- [ ] 首页/控制台的截图与文档引用没有过期（0.5.0 起 App 界面无“内置模板”字样）
- [ ] 发布说明（CHANGELOG）与下载页的 SHA-256 正确
