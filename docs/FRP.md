# 用 FRP 让不在同一网络的 DSH 互相访问

dsh-link 的传输层就是 HTTP，所以任何能把 TCP 送到对方 `127.0.0.1:8787` 的方案都能用。
本仓库推荐并已实现的是 **frp STCP**：双方都只做出站连接，公网只暴露 frps 的 7000 端口，
dsh-link 的 API 永远不直接暴露在公网。

## 1. 公网服务器：frps

frps 跑在**服务器侧**。本仓库不分发 frp 二进制，请从
<https://github.com/fatedier/frp/releases/tag/v0.71.0> 自行下载对应平台包，取其中的 `frps`。关键配置：

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
transport.tls.force = true              # 强制 frpc 走 TLS
auth.method = "token"
auth.token = "<openssl rand -hex 32>"   # 部署前替换，勿沿用示例值
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
webServer.addr = "127.0.0.1"            # dashboard 不要暴露公网
allowUsers = []                          # 由各 provider 的 allowUsers 控制
```

启动：`./frps -c frps.toml`（生产环境建议写成 systemd 单元或 Windows 服务）。
防火墙只放开 **7000/tcp**。

dsh-link 不会替你生成或保存 frps 的 token：`tunnel setup` 要求显式传入，
这样每台机器的凭据都来自你自己，而不是从别人的配置里复制。

## 1.5 起一台 frps 之后先自检（可选）

frps 起来后，先在服务器本机确认它活着，再往下配 frpc：

```powershell
# 服务器侧：进程在、7000 在听
ss -ltnp | Select-String 7000          # Linux
Get-NetTCPConnection -LocalPort 7000 -State Listen   # Windows

# 客户端侧：只有 frpc 真的连上了 frps，隧道才算通
node bin\dshlink.mjs tunnel setup --server <frps-host> --port 7000 --token <frp token>
node bin\dshlink.mjs tunnel sync
node bin\dshlink.mjs tunnel status     # 期望：running + 已生成 frpc.toml + visitor 端口
```

判据（缺一不可）：frpc 日志出现 `login to server success` 与 `start proxy success`；
`tunnel share` 能打印 `proxyName`/`secretKey`；`dshlink doctor` 的 `tunnel:*` 项通过。
若日志只有 `login to server failed`，先查 token、TLS（`transport.tls.force` 与客户端
`transport.tls.enable` 要一致）与安全组/防火墙。

## 2. 每台 DSH 机器：frpc

`dsh-link` 负责生成 `frpc.toml` 并拉起/停掉 frpc（`src/tunnel.mjs`）：

```powershell
node bin\dshlink.mjs tunnel setup --server <frps地址> --port 7000 --token <frp token>
#   本仓库不分发 frp 二进制：请自行下载 frp v0.71.0，把 frpc/frpc.exe 放到
#   <仓库>\vendor\frp\windows-amd64\（或 linux-amd64\），查找顺序为：
#   --frpc 指定 → $DSHLINK_FRPC → <仓库>\vendor\frp\<平台> → $DSHLINK_HOME\frp
#   → ~/.dshlink\frp → ~/frp → C:\frp（Linux: /usr/local/bin）→ D:\frp（/usr/bin）→ /opt/frp
node bin\dshlink.mjs tunnel sync      # 写 <data-dir>\frp\frpc.toml 并启动 frpc（detached）
node bin\dshlink.mjs tunnel status    # 进程、配置文件、visitor 端口
node bin\dshlink.mjs tunnel stop
```

生成的配置（节选）：

```toml
serverAddr = "<frps地址>"
serverPort = 7000
auth.method = "token"
auth.token = "<frp token>"
transport.tls.enable = true

# 把自己私密地发布出去：只有持有 secretKey 的对端能连
[[proxies]]
name = "dshlink-<本机名>"
type = "stcp"
secretKey = "<本机 STCP secret>"
allowUsers = ["<user>"]
localIP = "127.0.0.1"
localPort = 8787            # 本机 dshlink API

# 每个走 FRP 的对端一个 visitor：访问 127.0.0.1:19100 等于访问对方
[[visitors]]
name = "to-<对端名>"
type = "stcp"
serverName = "dshlink-<对端名>"
secretKey = "<对端 STCP secret>"
bindAddr = "127.0.0.1"
bindPort = 19100
```

### 2.3 STCP 模式注意事项（务必先读）

STCP = Secret TCP：服务端口**不在公网 frps 上开放**，只有持有 `secretKey` 的 visitor 能连。
这也决定了它的边界和坑：

1. **真正的边界是 `secretKey`，不是 dsh-link 的 token。** 经隧道到达本机节点的请求，源地址
   恒为 `127.0.0.1`；在 `auth.trustLocalhost: true`（默认）下，`server.mjs` 会在 token 校验
   失败后回落放行——也就是说**这条路径上入站 token 从未被检查**。要让 token 成为边界，两端
   都要切 `auth.trustLocalhost: false`（并给本机 MCP/脚本补 token）。见 [`../SECURITY.md`](../SECURITY.md)。
2. **`secretKey` 与 `user`/`allowUsers` 必须成对匹配**：provider 的 `secretKey` 与 visitor 的
   必须一字不差；同一条隧道上所有 frpc 的 `user` 要一致，且 `allowUsers` 要包含对方（写
   `["team"]` 这类具体值，不要用 `"*"`）。
3. **一个对端一个 visitor 端口**：visitor 只在**发起方**本机监听（dsh-link 从 19100 递增分配）。
   provider 侧不需要任何入站端口。visitor 默认只绑 `127.0.0.1`，不要改成 `0.0.0.0`。
4. **STCP 只支持 TCP**。UDP 服务用 `sudp` 或另想办法；FTP 主动模式、动态端口协议需要为每个
   端口单独加 proxy。
5. **服务看到的是本机 frpc 的连接**，不是远端真实 IP（需要真实 IP 得靠 `proxyProtocol` 或业务层传递）。
6. **两层加密**：`transport.tls.force = true`（frps 侧强制 TLS）+ STCP 各自的
   `transport.useEncryption = true`（数据二次加密）。服务本身已是 TLS 时可关掉后者省点开销。
7. **配置里不要写 `start = [...]`**：frp 的 `start` 是"只启动这些代理"的白名单（不是标签），
   写了会让 provider/visitor 全部不启动——dsh-link 生成的配置已经不带它。
8. **WSL2 的 `localIP`**：frpc 与服务在同一 WSL 发行版内 → `127.0.0.1`；服务在 Windows 宿主 →
   用 WSL 里 `ip route show | grep default` 得到的宿主 IP。dsh-link 场景下 `localIP` 固定是
   本机节点的 `127.0.0.1:8787`，不受此影响。
9. **轮换要成对做**：`auth.token` 与 `secretKey` 一起换，且**两端同时换、带外交接新值**；
   只换一端 = 立刻 401 或 visitor 连不上。步骤见 [`OPERATIONS.md`](OPERATIONS.md) §5。
10. **启动前先校验配置**：`frpc verify -c <config>` / `frps verify -c <config>` 比"起来看日志"快得多。

## 3. 两个节点互相接入（两步）

**A 机**：`tunnel share` 打印一段信息，把它交给 B（连同 A 的 dshlink 入站 token）：

```
proxyName  dshlink-alice-pc
secretKey  <32字节随机串>
frps       <frps-host>:7000
```

**B 机**：一条命令登记对端并重启 frpc：

```powershell
node bin\dshlink.mjs tunnel import --peer alice-pc --frp-server-name dshlink-alice-pc \
     --frp-secret <secretKey> --token <A 的 dshlink token>
node bin\dshlink.mjs peers ping --name alice-pc
```

反方向（A 访问 B）在 A 机上执行同样的两步。因为 STCP 的 visitor 端口只在**发起方**本机监听，
所以双方不需要任何公网端口，也不需要知道对方的真实 IP。

## 4. 只有一方有 frps 的场景

- **单向需求**（B 只需要拉 A 的文件）：只配 B→A 的 visitor 即可。
- **中继模式**：只有 hub 有公网地址时，其它节点 `peers add` 指向 hub，
  发往第三方的消息由 hub 转发（`relay.enabled`，见 `docs/DESIGN.md` §投递模型）。

## 5. 安全清单

1. `auth.token` 必须是新生成的随机值；frps 开 `transport.tls.force`。
2. 生产建议再上 mTLS（`transport.tls.certFile/keyFile/trustedCaFile`）。
3. 每个节点的 `secretKey` 独立，泄露后只需重跑 `tunnel share`/重新 init 换新。
4. frps dashboard 绑 `127.0.0.1` 或用 SSH 隧道访问，绝不放公网。
5. dsh-link 自己的 token 与 frp token 是两套凭证，都要分发，但作用域不同：
   frp token 只用于接入 frps，dsh-link token 才决定谁能读写你的共享目录。

## 6. 手工 frpc 与 dsh-link 混用（"挪用"别人写好的 frpc.toml）

常见情形：frpc 是用一份手写的 `frpc.toml` 起的（不是 dsh-link 生成的），而 dsh-link 里
`tunnel.enabled = false`。消息能通，但两边互不知情，出问题时最费解：

- `dshlink tunnel status` 说 `not started`，`doctor` 也只给一条 "tunnel not configured"；
- dsh-link 不知道隧道是谁起的：它不会重启、不会重载、换密钥也不会跟着动；
- `dshlink tunnel sync` 会**覆盖** `$DSHLINK_HOME/frp/frpc.toml` 并抢占 visitor 端口，与手写配置打架；
- 手写配置里的 publish/visitor `secretKey` 与 dsh-link 配置里的 `stcp.secretKey` 是两套东西：
  `dshlink invite` 发出去的是后者，对端照它建 visitor 必然连不上。

自检（0.2.1 起 `doctor` 会自动加一条 `peer-route:<peer>`）：

```powershell
dshlink doctor --json
# peer-route:bob-pc  "forwarded through http://127.0.0.1:19110 by something outside dsh-link"
#   → 说明这个 peer 是外面某个 frpc 转进来的，dsh-link 管不到它
```

改法二选一，不要一半一半：

- **A. 全交给 dsh-link**：`tunnel setup --server <frps> --port <port> --token <frp token>` → `tunnel enable`
  → `tunnel sync`，然后停掉手工 frpc（否则 proxy 名 / visitor 端口会冲突）。
- **B. 保留手工 frpc**：peer 的 url 就写 `http://127.0.0.1:<visitorPort>`（手写配置里的 `bindPort`），
  让 frpc 以服务/计划任务方式常驻，并且**不要**再跑 `dshlink tunnel sync`；每个对端一个独立 visitor 端口。

两种改法验证方式相同：`dshlink peers ping <peer>` → `dshlink send --to <peer> ...` →
`dshlink doctor`（`peer:<peer>`、`peer-route:<peer>` 两项都 pass）。

## 7. 生成 token / secretKey / 证书

### 7.1 token 与 secretKey

```powershell
node scripts/gen-secrets.mjs                  # 一次生成 frp token + STCP secretKey + dsh-link 入站 token
node scripts/gen-secrets.mjs --count 3        # 三台机器各一套
node scripts/gen-secrets.mjs --name alice-pc  # 输出里带上节点名，便于直接粘进配置
node scripts/gen-secrets.mjs --json           # 给脚本用
```

输出里直接给出可粘贴的片段：frps 的 `auth.token`/`webServer.password`、`tunnel setup` 命令行、
`dshlink.config.json` 的 `stcp.secretKey`，以及入站 token 的 `auth.tokens[].hash`
（也可以照常走 `dshlink token new --label <peer>`，它只存 sha256、明文只打印一次）。
不想用脚本的话，等价的命令行是 `openssl rand -hex 32`（frp token）与
`openssl rand -base64 32`（secretKey）。

### 7.2 mTLS 证书（可选加固）

frp 自带 TLS，`transport.tls.force = true` 就能用；下面这套是**双向 TLS**——frpc 校验 frps、
frps 也校验 frpc：

```bash
# Linux / WSL / macOS
./scripts/gen-certs.sh 203.0.113.10 certs --clients alice-pc,bob-pc
```

```powershell
# Windows（openssl 不在 PATH 时会自动从 git 安装目录找）
powershell -ExecutionPolicy Bypass -File .\scripts\gen-certs.ps1 -ServerName 203.0.113.10 -Clients alice-pc,bob-pc
```

生成 `ca.crt/ca.key`、`server.crt/server.key`、每个客户端一套 `<名称>.crt/.key`（SAN 按 IP/域名
自动写成 `IP:` 或 `DNS:`）。启用方式：frps 与各 frpc 打开

```toml
transport.tls.certFile = "certs/server.crt"     # frpc 换成自己的 <名称>.crt
transport.tls.keyFile  = "certs/server.key"     # 同理
transport.tls.trustedCaFile = "certs/ca.crt"
transport.tls.serverName = "203.0.113.10"       # 仅 frpc 需要
```

然后重启 frps 与所有 frpc（本机 `dshlink tunnel stop && dshlink tunnel sync`）。判据：frpc 日志
出现 `login to server success` 且没有 x509 报错。`ca.key` 要离线保存——拿到它就能签发任意证书。
