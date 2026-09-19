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
