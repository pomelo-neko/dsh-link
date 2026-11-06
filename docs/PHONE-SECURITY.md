# 手机接入安全：每设备证书 + 独立 phone-frps（0.10，B2+B4）

这份文档说明 0.10 起的手机控制面安全架构：不再把机器之间的隧道凭据（frps token、mTLS
client key、节点 STCP secretKey）塞进手机连接串，而是让每部手机先在 hub 上登记自己的公钥、
拿到一张只属于自己的客户端证书，之后每次请求都用 mutual TLS。配套的 phone-frps 是独立于
节点/hub 网络的 frps 租户，手机走它进入 hub 的 mTLS 网关。

> 面向“把手机交给别人用”的分发、构建与部署步骤见 [DISTRIBUTION.md](DISTRIBUTION.md)。
> 旧的 `dshlink1:` 连接串仍被支持，但它把 hub 的共享隧道凭据放在码里，只建议用于已有设备。

---

## 1. 旧路径（dshlink1）的问题

0.9 的 `dshlink1:` 连接串包含：

- hub 的 frp auth token、mTLS client.crt/client.key、hub STCP provider secretKey；
- 一个独立的 `device` token（这一部分是好的，能单独吊销）。

结果是：

1. 一部手机泄露 = 整个隧道身份泄露。拿到码的人可以冒充任意 frpc 客户端连 frps、连接 hub 的
   STCP provider，不只是控制自己的 API 权限。吊销 device token 并不会让隧道凭据失效。
2. 所有手机共用同一套隧道身份，隧道层无法按手机吊销，只能整体轮换 frps token / 重签证书 /
   更换 provider secretKey，然后把所有连接串重发一遍。
3. 连接串 = 密码 + 隧道私钥。码一旦被转发/落盘，被动泄露很难发现，也很难只收回一部手机。

0.10 把“首次引导”和“长期身份”分开：首次连接靠 pin 住的 CA 公钥 + 一次性 bootstrap secret，
长期身份是每部手机自己的客户端证书。

---

## 2. 目标架构

```
                        公网/内网
  手机 App ──HTTPS(mTLS)──▶ 127.0.0.1:18790 (visitor)
                               │  STCP（phone-frps 租户，独立 token / 证书 / provider）
                               ▼
                        phone-frps ◀── provider ── hub 上的 frpc
                               │
                               ▼
  hub 机器:  127.0.0.1:8791  phone gateway (HTTPS, mutual TLS)
                               │  校验客户端证书 → 注入 hub 的本地 device token
                               ▼
                        127.0.0.1:8790  hub HTTP API
```

组件与代码位置：

| 组件 | 代码 | 作用 |
|---|---|---|
| 手机 CA | `src/phoneca.mjs` | 生成 CA、网关 server 证书、按手机公钥签发客户端证书；校验客户端证书 |
| mTLS 网关 | `src/phonegateway.mjs` | `https://127.0.0.1:8791`，唯一没有客户端证书的入口是 `POST /api/v1/phone/bootstrap` |
| 一次性引导 | `src/phonebootstrap.mjs` | `dshlink2:` 码：pin CA + bootstrap id/secret + 可选 phone-frps visitor |
| 独立隧道 | `src/phonefrp.mjs` | `phone-frpc.toml` 的生成与进程管理，与节点/hub 的 frpc 完全分开 |
| 设备/引导登记 | `src/hubstore.mjs` | `phones.json`、`phone-bootstrap.json`、按指纹查询/吊销 |
| 控制面 | `src/hub.mjs` | `/api/v1/hub/phone/*` 管理路由 + 生命周期 |
| CLI | `bin/dshlink.mjs` | `hub phone setup / bootstrap / devices / revoke / status` |
| Android | `android/`（0.6.0+） | 本地生成密钥对、导入 `dshlink2:`、bootstrap、mTLS |

网关绑定强制回环：它终止 mTLS 之后会注入 hub 的 device token，暴露到非回环等于把 token 交给
网络。手机只能经本地 STCP visitor（或受控端口转发）到达它。

---

## 3. 信任链：首次连接为什么不死锁

“下发的证书需要可信连接，可信连接又需要证书”只在下发证书本身被当作信任根时成立。这里把
信任根和设备身份分开：

1. 管理员在 hub 上运行 `hub phone setup`，hub 生成 CA。CA 公钥（ca.crt）通过连接串带外交给
   手机；CA 私钥永远只在 hub 的 `phone-ca/` 目录里。
2. 手机生成自己的 RSA 密钥对，私钥不离开手机，只把公钥发给网关。
3. 手机用 `entry.url` 连网关，用连接串里 pin 的 CA 校验证书链（不是系统信任库，也不接受
   运行时下发的“新 CA”）。TLS 建立后，网关的 server 证书必须由同一 CA 签发。
4. 手机在 TLS 内提交一次性 bootstrap id/secret 和公钥；网关校验 secret、TTL、使用次数、
   `allowNewDevices`/`maxDevices`，然后签发该公钥对应的客户端证书。
5. 之后所有请求都用该客户端证书 mTLS。网关按证书指纹查 `phones.json`，未知/已吊销一律拒绝。

因此第一次连接的可信来源是带外 pin 的 CA 公钥 + 一次性 secret；证书本身不是信任根。连接串
泄露时，攻击者拿到的是“一个还没用过的 bootstrap 名额”或“一部已登记手机的访问能力”，不是
hub 的隧道凭据。

---

## 4. 配置与命令

### 4.1 hub 侧：建立 CA 与网关

最低限度（手机走局域网/VPN 的端口转发，不建 phone-frps）：

```powershell
node bin\dshlink.mjs hub init --data-dir C:\dshlink-hub --name team-hub --port 8790
node bin\dshlink.mjs hub phone setup --no-tunnel --data-dir C:\dshlink-hub
node bin\dshlink.mjs hub serve --data-dir C:\dshlink-hub
```

`hub phone setup` 会：

- 打开 `phoneGateway.enabled`，绑定 `127.0.0.1:8791`，在 `<data-dir>/phone-ca/` 生成
  CA + 网关 server 证书（需要 OpenSSL；Windows 上通常来自 Git for Windows，也可
  `--openssl <path>` 或环境变量 `DSHLINK_OPENSSL`）；
- 创建一个长期 device 角色 token，写进 `phoneGateway.hubToken`（只在这里打印一次；手机永远
  看不到它）；
- 打印 CA 指纹、网关地址与下一步命令。CA 指纹应带外核对（连接串里也有）。

带独立 phone-frps（B4，推荐给公网手机）：

```powershell
node bin\dshlink.mjs hub phone setup --data-dir C:\dshlink-hub --phone-frp-server frps.example.com --phone-frp-port 7000 --phone-frp-token <phone-frps token> --phone-frp-cert C:\certs\client.crt --phone-frp-key C:\certs\client.key --phone-frp-ca C:\certs\ca.crt --frpc-path C:\dshlink\vendor\frp\windows-amd64\frpc.exe
node bin\dshlink.mjs hub serve --data-dir C:\dshlink-hub
```

- phoneFrp 是另一套 frps（可以是同一台服务器上的第二个 frps 实例/端口，也可以是完全独立的
  服务器）。它有自己的 auth token、mTLS 证书、user（默认 `dsh-link-phone`）与 STCP provider
  （默认 `dshlink-phone`）；不要复用节点网络的 frps token/证书。
- `hub serve` 先启动 phone-frps 的 frpc provider（localPort = 网关 8791），再启动网关与 hub HTTP。
- 手机侧只需要 phone-frps 的 visitor 配置与 phone 租户的 secretKey；这些会在 `hub phone
  bootstrap` 时塞进 `dshlink2:` 码，而不是把 hub 的 frp 凭据塞进去。

相关配置（`dshlink-hub.config.json`）默认值：

```json
{
  "phoneGateway": {
    "enabled": false,
    "bind": "127.0.0.1",
    "port": 8791,
    "caDir": "<data-dir>/phone-ca",
    "hubToken": null,
    "bootstrapTtlHours": 2,
    "deviceDays": 365,
    "maxDevices": 64,
    "allowNewDevices": true
  },
  "phoneFrp": {
    "enabled": false,
    "serverAddr": null,
    "serverPort": 7000,
    "user": "dsh-link-phone",
    "token": null,
    "tls": true,
    "certFile": null,
    "keyFile": null,
    "trustedCaFile": null,
    "bindPort": 18790,
    "provider": { "name": "dshlink-phone", "secretKey": null }
  }
}
```

### 4.2 生成一次性手机连接串

```powershell
# 带 phone-frps 隧道（默认；手机经 visitor 18790 访问网关）
node bin\dshlink.mjs hub phone bootstrap --label alice-pixel --ttl-hours 2 --out alice.txt

# 不走隧道：必须给一个手机能访问的 https URL
node bin\dshlink.mjs hub phone bootstrap --label bob --no-tunnel --url https://127.0.0.1:8791 --out bob.txt
```

- `--ttl-hours` 默认 2（1..720），`--max-uses` 默认 1；码过期或用完即失效。
- 码的内容：pin 的 CA 证书/指纹、bootstrap id/secret、entry.url、可选 phone-frps visitor 配置
  与它自己的证书/密钥；不含 hub token、CA 私钥、其他手机的证书。
- 码通常约 7 KB，适合文件/粘贴导入，不适合二维码。
- 无隧道时，`entry.url` 的主机名必须能通过网关 server 证书校验。当前 server 证书的 SAN 是
  `IP:127.0.0.1, DNS:localhost` —— 所以 `--url` 应指向手机本机回环（例如 `adb reverse`
  或本地 port-forward），不要把 LAN IP 直接写进去。跨网络的手机请使用 phone-frps 隧道。

Android 0.6.0 的“导入连接串/配置文件”支持 `dshlink2:`；导入后 App 自动生成密钥对并
bootstrap，成功后保存客户端证书。旧的 `dshlink1:` 仍可导入以兼容已有设备。

---

## 5. 网关的授权边界

`src/phonegateway.mjs` 对手机只暴露：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 无认证，返回 role=phone-gateway、CA 指纹、版本 |
| POST | `/api/v1/phone/bootstrap` | 唯一允许“无客户端证书”的入口；一次性 secret |
| GET | `/api/v1/phone/me` | 已认证手机的自身设备信息（label/指纹/到期） |
| GET | `/api/v1/info` | 经网关代理到 hub，注入 hub 的 device token |
| GET | `/api/v1/network/*` | 代理 |
| GET/POST | `/api/v1/dsh/*` | 代理（工作区/会话/transcript/能力调用） |

其他路径（包括 `/api/v1/hub/*`、`/ui`、`/api/v1/hub/tokens`）一律
`403 phone_route_denied`。客户端自带的所有认证头都会被剥离，网关用
`Authorization: Bearer <phoneGateway.hubToken>` 访问本机 hub；因此手机即使拿到自己的证书，
也只能使用 device 角色的最小面。

错误语义：

- 无客户端证书：`401 client_certificate_required`
- 证书不是本 CA 签发/过期/EKU 不对：`403 phone_certificate_invalid`
- 证书有效但未登记：`403 phone_unknown`
- 已吊销：`403 phone_revoked`
- 网关关闭：`403 phone_gateway_disabled`；hub token 未配置：`503 phone_gateway_misconfigured`
- bootstrap：`401 bootstrap_rejected`（未知/过期/用尽/secret 错）、`429 too_many_attempts`、
  `409 too_many_devices`

---

## 6. 设备登记、吊销与轮换

状态文件都在 hub 的 data dir：

| 文件 | 内容 | 敏感性 |
|---|---|---|
| `phone-ca/ca.crt` | CA 公钥证书 | 可公开（连接串里就是它） |
| `phone-ca/ca.key` | CA 私钥 | 最高：泄露即可签发任意手机证书 |
| `phone-ca/server.crt/server.key` | 网关 TLS 证书 | 私钥敏感 |
| `phones.json` | 设备 id/label/deviceId/指纹/状态/时间 | 管理数据 |
| `phone-bootstrap.json` | bootstrap id、secret 的 sha256、TTL/次数/状态 | 不含明文 secret |

### 6.1 日常

```powershell
node bin\dshlink.mjs hub phone devices            # 谁登记了、最后出现、状态
node bin\dshlink.mjs hub phone status             # 网关/隧道/设备/引导码计数
node bin\dshlink.mjs hub phone revoke alice-pixel # 按 deviceId 或证书指纹立即吊销
```

吊销是按请求检查的：该手机的下一请求就 `403 phone_revoked`，不需要重启 hub，也不影响其他
手机。0.10 起 hub 在每次鉴权前检查 `phones.json` 的修改时间/大小，因此用 CLI 在另一个进程里
执行的 `hub phone revoke`（或重新登记）会立即对运行中的 `hub serve` 生效；更早版本需要重启
hub 才能看到 CLI 改动的设备登记。设备丢失时应同时删除/作废该手机的连接串文件。

### 6.2 轮换

| 场景 | 操作 | 影响 |
|---|---|---|
| 手机丢失 | `hub phone revoke <id>` | 仅该手机立即失效 |
| 网关 token 泄露 | `hub phone setup --reset-hub-token`，重启 hub 或等配置生效 | 手机不受影响（手机只持有客户端证书），旧 hub token 失效 |
| 某手机私钥泄露 | 吊销该设备，让用户重新导入一条新 bootstrap 码 | 仅该手机 |
| bootstrap secret 泄露 | 等它过期/用掉；在 hub 控制面吊销对应 bootstrap（`DELETE /api/v1/hub/phone/bootstrap/:id`） | 该码失效 |
| phone-frps 凭据泄露 | 轮换 phone-frps auth token / mTLS 证书 / provider secretKey，重启 phone-frpc；重发所有依赖隧道的连接串 | 所有手机隧道需要重新导入；已登记的客户端证书仍可复用但入口变化 |
| CA 私钥泄露或过期 | 删除/停用 `phone-ca/` 并重建（会生成新 CA），重发所有手机连接串 | 所有旧客户端证书失效；这是最彻底的重置 |

> CA 私钥在 hub 上，建议把 hub data dir 放在受控磁盘、限制 ACL，并定期备份 `phones.json`
> （丢失只会让手机需要重新 bootstrap）。

---

## 7. 威胁模型

| 威胁 | 结果 | 说明 |
|---|---|---|
| 手机连接串被动泄露 | 攻击者可消耗一次性 bootstrap 名额，或使用未吊销手机的证书 | 不再获得 hub 的 frps token/mTLS 私钥/STCP provider secret；码可过期、可限次、可吊销 |
| 手机丢失/被拿走 | 攻击者可作为该手机控制 DSH | 用 `hub phone revoke` 立即止损；客户端证书无法被其他设备复用（私钥在手机内） |
| 恶意手机尝试访问 hub 管理面 | 403 | 网关白名单 + 注入 device token，手机拿不到 admin 能力 |
| 未登记设备伪造证书 | 403 | 证书必须由 hub CA 签发且指纹在 `phones.json`；未知一律拒绝 |
| 中间人 | TLS 校验失败 | 手机只信任连接串 pin 的 CA；不信任系统库或运行时下发的 CA |
| frps/phone-frps 被攻破 | 可看到/转发隧道流量，但拿不到客户端私钥 | 仍受 mTLS 与设备登记约束；应使用独立租户、TLS、最小权限 |
| hub 主机被攻破 | 完全失守 | CA 私钥在 hub 上；这是本地信任根，须按服务器安全基线保护 |
| 重放 bootstrap secret | 只能成功一次 | uses/maxUses + TTL + 每码速率限制；已用码再次请求 401 |
| 手机时钟/证书过期 | 连接失败 | 客户端证书默认 365 天，可在到期前重新 bootstrap；错误明确 |

仍未解决/不在范围内：

- 手机端私钥的硬件保护取决于 Android 实现（当前 0.6.0 若使用软件 KeyStore 私钥，root 后可被
  提取；README 会标注风险）。
- 不提供远程擦除/推送吊销通知；吊销在下一次请求生效（客户端已缓存的页面数据不回收）。
- phone-frps 的 visitor secretKey 仍随连接串下发（它是手机进入 phone 租户的隧道凭据），轮换需
  重发码；这与“hub 共享隧道凭据”相比影响面已收敛到手机租户。
- 无端点行为审计之外的 DLP；agent 能做什么仍取决于 DSH 的 capabilities.methods 与节点配置。
- 网关 server 证书 SAN 目前固定为 127.0.0.1/localhost；无隧道 LAN 直连需要本地端口转发，
  跨网络请走 phone-frps。

---

## 8. 与 dshlink1 的差异

| | dshlink1（0.9） | dshlink2（0.10，B2+B4） |
|---|---|---|
| 手机身份 | 共享 hub device token | 每设备客户端证书（私钥不出手机） |
| 首次连接 | 码里直接给 token | pin CA + 一次性 bootstrap secret |
| 隧道凭据 | hub 的 frps token/mTLS key/STCP secret 全在码里 | 独立 phone-frps 租户 + 手机自己的 visitor 配置 |
| 吊销一部手机 | 吊销 device token（隧道身份仍共享） | 按证书指纹即时吊销，不影响其他手机 |
| hub token | 手机持有 | 只在网关内存/配置里，手机永不接触 |
| 管理面暴露 | 受 device 角色限制 | 网关白名单，管理路由不可达 |
| 轮换 | 通常要重发全部码 | 单设备吊销；隧道/CA 轮换才需重发 |

旧码仍可用；升级后建议所有新手机改用 `dshlink2:`，并逐步把旧设备迁移到新流程。

---

## 9. 排障

| 症状 | 检查 |
|---|---|
| `hub phone setup` 报找不到 OpenSSL | 安装 Git for Windows；或 `--openssl <path>`；或设 `DSHLINK_OPENSSL` |
| `hub phone bootstrap` 报 `phone_gateway_disabled` | 先 `hub phone setup`；确认配置里 `phoneGateway.enabled=true` |
| bootstrap 报 `bootstrap_rejected` | 码过期/已用/secret 错；核对 hub 时间；重新生成一条 |
| 手机连接报证书错误 | 连接串的 CA 与当前 hub CA 不一致（hub 重建过 CA？）；核对 CA 指纹 |
| `403 phone_unknown` | 手机的客户端证书不在 `phones.json`：重新导入有效 bootstrap 码 |
| `403 phone_revoked` | 该设备已被吊销；重新登记 |
| `502 bad_gateway` / `504 phone_gateway_timeout` | hub HTTP 没起、端口不对或超时；看 `hub phone status` 与 hub 日志 |
| 手机连不上 `entry.url` | visitor 18790 是否在跑；phone-frps 是否可达；防火墙/安全组 |
| 隧道起来了但 mTLS 失败 | 手机是否导入的是 `dshlink2:`（mTLS）而不是旧 `dshlink1:` |
| 网关拒绝 `phone_gateway_bind_not_loopback` | 不要把 `phoneGateway.bind` 设成 0.0.0.0；手机经 visitor 访问 |

---

## 10. 测试与代码索引

- `test/phone-security.test.mjs`：phone-frps 配置、bootstrap 编解码/不泄露 secret、CA 签发 +
  mTLS 代理、hub 控制面（生成/吊销/角色）。
- `test/cli-phone.test.mjs`：`hub init → phone setup → phone bootstrap → devices → status` 的
  CLI 全流程。
- 全量：`DSH_HOME=D:/dsh-home node test/run.mjs`。

主要文件：`src/phoneca.mjs`、`src/phonegateway.mjs`、`src/phonebootstrap.mjs`、
`src/phonefrp.mjs`、`src/hubstore.mjs`、`src/hubconfig.mjs`、`src/hub.mjs`、
`bin/dshlink.mjs`、`android/`。
