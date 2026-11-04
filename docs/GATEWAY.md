# 回环令牌网关（gateway）

**gateway** 是 dsh-link 节点上的一个可选前置监听器：它只绑回环地址（默认 `127.0.0.1:8788`），
对**每一个**请求先做 dsh-link token 校验，通过后再反代到真正的节点 API（默认 `http://127.0.0.1:8787`）。
它存在的理由只有一个：把"经隧道到达本机、源地址看起来是 127.0.0.1"的远程流量，与
"本机可信进程"区分开——前者必须带有效 token，后者才享受回环便利。

> 一句话：**gateway 从不信任来源地址**。没有有效 token，就没有请求。

## 1. 为什么需要它

frp/STCP 隧道到达节点时，对端连接由本机 frpc 建立，节点看到的客户端地址**恒为 `127.0.0.1`**。
而节点自己的鉴权函数 `authorize()`（`src/server.mjs:102-118`）在 token 校验失败后，还有一条
回环回落分支（`src/server.mjs:109-111`）：

```js
if (cfg.auth.trustLocalhost && (LOCAL_ADDRESSES.has(req.socket.remoteAddress ?? '') || ...)) {
  return { ok: true, via: 'localhost', token: null, ip };
}
```

也就是说，只要配置里 `auth.trustLocalhost: true`，**任何**走到 8787 的隧道流量都会在"没有 token"
的情况下被当成 admin 放行。0.5 起 `trustLocalhost` 默认 `false`，`dshlink harden --write` 也会关掉它，
但这仍然是**配置项**：历史配置、自用调试节点、误操作都可能把它打开，而一旦打开，暴露的
是整个 API（包括 `/mcp` 和 `/api/v1/bridge/*`）。

gateway 提供的是**结构性防线**而不是配置纪律：

1. 它自己维护一份 token 校验（复用 `src/config.mjs` 的 `verifyToken`，同一份 `auth.tokens`、
   同样的角色与过期时间语义），**没有"回环即放行"分支**；
2. 它把原始 `Authorization` / `X-DSHLink-Token` 一并转发给节点，节点仍会按 token 解析角色、
   再鉴权一次——gateway 是前置硬门槛，不是替代节点鉴权；
3. 它还顺带收窄远程面：`/mcp` 与 `/api/v1/bridge/*` 对**任何角色**一律 403，
   `device` 角色只放行手机/控制器真正需要的 DSH 只读面与 capability 调用。

它**不**负责：TLS 终止（交给 frp 的 `transport.tls` 或前置反代）、限流（节点
`limits.maxRequestsPerMinute` 仍在）、以及 STCP `secretKey` 的分发。

## 2. 请求链路

```
手机控制端
  URL http://127.0.0.1:18788  +  device token
        │
        ▼
手机内置 frpc visitor (bindPort 18788)
        │  STCP over frps:7000 (TLS)
        ▼
公网 frps  ◀──────── 节点侧 frpc provider（stcp）
                          │  localIP = 127.0.0.1
                          │  localPort = 8788     ← 关键：指向 gateway，不是 8787
                          ▼
             gateway 127.0.0.1:8788
               · 只接受回环连接
               · 验 token（无 token / 过期 / 撤销 → 401）
               · 角色/路由策略（/mcp、bridge、device 白名单）
               · 请求体大小/超时限制
                          │  转发原始 Authorization + method + path/query + body
                          ▼
             dsh-link 节点 API 127.0.0.1:8787
               · 再次按 token 鉴权、审计、限流
```

要点：

- provider 的 `localPort` 必须是 **8788**。指向 8787 等于绕过 gateway，回到"信任回环"的老路。
- gateway 的 `bind` 被强制为回环地址；配置里写 `0.0.0.0` 之类会被规范化回 `127.0.0.1`。
- `upstream` 会被规范化成 origin（`http://host:port` / `https://host:port`；即使写了路径也会被截掉），
  因为 gateway 原样转发请求路径。

## 3. 配置

在 `dshlink.config.json` 顶层加 `gateway` 段（默认关闭）：

```json
{
  "name": "alice-pc",
  "bind": "127.0.0.1",
  "port": 8787,
  "auth": { "trustLocalhost": false },
  "gateway": {
    "enabled": true,
    "bind": "127.0.0.1",
    "port": 8788,
    "upstream": "http://127.0.0.1:8787",
    "maxBodyBytes": 2097152,
    "timeoutMs": 60000,
    "provider": { "name": "dshlink-phone", "secretKey": "<STCP secret for the phone>" }
  }
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 必须严格为 `true` 才启动；字符串 `"true"` 不算 |
| `bind` | `127.0.0.1` | 只允许回环（`127.x`、`::1`、`localhost`）；非法值回落默认 |
| `port` | `8788` | 1–65535；随机端口可写 `0`（测试用） |
| `upstream` | `http://127.0.0.1:8787` | 节点 API 的 origin（写了路径会被截掉）；支持 https |
| `maxBodyBytes` | `2097152`（2 MiB） | 请求体硬上限；超过返回 413，不转发 |
| `timeoutMs` | `60000` | 等待上游响应的超时；超过返回 504 |
| `provider.name` | `dshlink-phone` | 可选；`tunnel sync` 为 gateway 生成的 STCP provider 名 |
| `provider.secretKey` | `null` | 可选；填了才会生成指向 8788 的第二个 provider，留空不生成 |

规范化是**容错**的：任何一个字段写错（端口越界、协议不对、类型不对）都会回落到安全默认值，
不会导致节点起不来（见 `src/config.mjs` 的 `normalizeGatewayConfig`）。因此"以为开了其实没开"
只能从启动日志和 401/403 行为来判断，见 §4。

启动/停止语义：

- `dshlink serve` 在节点 API 监听成功后，若 `gateway.enabled === true` 才启动 gateway；
- gateway 启动失败（端口被占等）是**硬错误**：`serve` 会关闭节点并以 `gateway_listen_failed`
  （exit 2）退出，避免"以为有 token 防线、实际没有"；
- 配置热重载时，**token 增删/撤销、`upstream`、`maxBodyBytes`、`timeoutMs` 立即生效**（每个请求
  读取当前配置）；**`enabled` / `bind` / `port` 的改动需要重启 serve**（监听器只创建一次）。

## 4. 启用、启动日志与健康检查

1. 铸一个 device token（明文只显示一次，配置里只存 sha256）：

   ```powershell
   node bin\dshlink.mjs token new --role device --label phone --ttl-days 30
   ```

2. 把 §3 的 `gateway` 段写进 `dshlink.config.json`（或先加 token 再改配置都行），重启 serve。
   启动日志应出现：

   ```
   dsh-link node "alice-pc" listening on http://127.0.0.1:8787
   ...
   gateway      : http://127.0.0.1:8788 -> http://127.0.0.1:8787 (token required; /mcp and /api/v1/bridge/* denied; device limited to dsh/info/healthz/network)
   ```

   没有这一行 = gateway 没启用（`enabled` 不是布尔 `true`，或旧进程未重启）。

3. 健康检查（注意：**经 gateway 的 `/healthz` 也需要 token**，gateway 没有"开放路径"）：

   ```powershell
   # 期望 401 JSON：{"error":{"code":"unauthorized",...}}
   curl.exe -i http://127.0.0.1:8788/healthz

   # 期望 200 + 节点信息
   curl.exe -H "Authorization: Bearer <device-token>" http://127.0.0.1:8788/api/v1/info

   # 期望 403 role_forbidden（device 不能读 peers）
   curl.exe -H "Authorization: Bearer <device-token>" http://127.0.0.1:8788/api/v1/peers
   ```

   `X-DSHLink-Token: <token>` 与 `Authorization: Bearer <token>` 等价，二者都可用。

4. 撤销：`dshlink token rm --id <id>` 后**无需重启**，下一个请求立即 401
   （热重载会把新 token 表推进同一个 cfg 对象，gateway 每请求读取）。

生产建议：即使部署了 gateway，也把 `auth.trustLocalhost` 设为 `false`——它保护的是**不经过**
gateway 的直连路径（例如把 8787 直接挂到 frp 的旧部署），gateway 只能保护经过它的流量。

## 5. 角色与路由策略

gateway 的判定顺序：**回环来源检查 → token 校验（401）→ 禁用路由（403 forbidden）→ 角色白名单
（403 role_forbidden）→ 请求体上限（413）→ 超时/上游错误（504/502）→ 反代**。
通过后再由节点按同一 token 的角色鉴权一次（审计、限流也在那里）。

| 请求 | admin | peer | bridge | device |
|---|---|---|---|---|
| `/mcp`、`/mcp/*` | 403 forbidden | 403 | 403 | 403 |
| `/api/v1/bridge`、`/api/v1/bridge/*` | 403 forbidden | 403 | 403 | 403 |
| `GET /healthz` | ✓ | ✓ | ✓ | ✓ |
| `GET /api/v1/info` | ✓ | ✓ | ✓ | ✓ |
| `GET\|POST /api/v1/dsh/*` | ✓ | ✓ | ✓ | ✓（仅 GET/POST） |
| `GET /api/v1/network/*` | ✓ | ✓ | ✓ | ✓ |
| 其余节点 API（peers、messages、files、audit、tokens…） | ✓ | 由节点按角色判定 | 由节点按角色判定 | 403 role_forbidden |

说明：

- 没有 `role` 字段的旧 token 按 `admin` 处理（与节点一致）。
- `device` 是手机/控制器角色：`/api/v1/dsh/*` 的 `PUT/DELETE/PATCH` 会被 403，
  `POST /api/v1/dsh/call` 可以（是否真的执行还受节点 `capabilities.methods` 与能力队列策略约束）。
- `/api/v1/network/*` 是只读网络视图前缀；目前节点只实现 `GET /api/v1/network/nodes`。
- 任何角色都不能经 gateway 访问 MCP 与 bridge 控制面；这两类只应从本机回环直接访问。

## 6. 手机 / 远程接入示例（STCP provider 指向 gateway）

节点侧 frpc.toml（provider 指向 gateway 的 8788）。0.7 起，若在配置里写 `gateway.provider.secretKey`，
`dshlink tunnel sync` / `tunnel start` 会自动在生成的 frpc.toml 里追加这一段（与节点 API 的 provider 并存，
互不影响；`provider.name` 可改）：

```toml
serverAddr = "<frps地址>"
serverPort = 7000
auth.method = "token"
auth.token = "<frp token>"
transport.tls.enable = true

[[proxies]]
name = "dshlink-phone"
type = "stcp"
secretKey = "<STCP secret>"
allowUsers = ["<phone 侧的 user>"]
localIP = "127.0.0.1"
localPort = 8788            # gateway，不是 8787
```

手机/客户端侧 frpc visitor：

```toml
serverAddr = "<frps地址>"
serverPort = 7000
auth.method = "token"
auth.token = "<frp token>"
transport.tls.enable = true

[[visitors]]
name = "to-node-gateway"
type = "stcp"
serverName = "dshlink-phone"
secretKey = "<与 provider 相同的 STCP secret>"
bindAddr = "127.0.0.1"
bindPort = 18788
```

然后手机端连接 `http://127.0.0.1:18788`，token 填 §4 铸的 device token。

注意：

- `secretKey` 两端必须一字不差；同一条隧道上各 frpc 的 `user` 要一致，`allowUsers` 要包含对方。
- 生成的 provider 名来自 `gateway.provider.name`，`secretKey` 必须与手机 visitor 一字不差；
  没填 `gateway.provider.secretKey` 时不会生成（避免把没有 token 防线的端口发布出去）。
- 也可以不用 `tunnel sync`，手写 frpc（参考 `docs/FRP.md` §6：手写 frpc 与 dsh-link 生成配置
  不要混用——`tunnel sync` 会覆盖同一份文件）；同一份手写文件里保留原来的 8787 provider 给本机
  CLI/对等节点使用、再加一段 8788 provider，是最简单的做法。
- 若节点侧用别的 frpc 进程/容器跑 provider，同样只要求它把 8788 暴露成同一个 `serverName`。
- 手机端如果是本项目 Android 控制端，内置隧道默认 visitor 端口是 18788，URL 填
  `http://127.0.0.1:18788` 即可；生产部署应把 provider 改指向 gateway，见
  `docs/mobile/CONTROL-APP.md` §5（trustLocalhost 绕过与生产加固）。

## 7. 排障

| 症状 | 原因 | 处理 |
|---|---|---|
| 连接被拒绝 / `ECONNREFUSED` | gateway 没启用、没重启、或端口不对 | 看启动日志是否有 `gateway      :` 行；确认 `gateway.enabled === true`（布尔值）；确认 frpc provider `localPort = 8788` |
| `401 unauthorized`（`www-authenticate: Bearer realm="dsh-link"`） | 没带 token、token 拼错、已过期、已被 `token rm`、或配置还没热重载（默认 1s） | 用 `dshlink token list` 查 id/角色/过期时间；重新 `token new`；等 1s 再试 |
| `403 forbidden` + `route /mcp ... is not exposed through the gateway` | 访问了 `/mcp` 或 `/api/v1/bridge/*` | 设计如此：MCP/bridge 只能从本机回环直接访问节点 8787 |
| `403 role_forbidden` + `this route is not available to role "device"` | 用 device token 访问了非 DSH 面（peers/messages/…） | 换用途正确的 token；只给手机发 device token |
| `413 payload_too_large` | 请求体超过 `maxBodyBytes` | 调大 `maxBodyBytes`（上限 512 MiB）或分块上传 |
| `502 bad_gateway` + `gateway upstream is unreachable` | 节点 API 没起、端口写错、upstream 写了 base path | 检查 `upstream` 是否 `http://127.0.0.1:8787`；先直连 8787 验证节点活着 |
| `504 gateway_timeout` | 上游超过 `timeoutMs`（长 DSH/能力调用） | 调大 `timeoutMs`（上限 3600000 ms） |
| `400 bad_request` | 请求 URL 畸形，或请求体读到一半连接断了 | 检查客户端 |
| serve 启动即退出，`gateway_listen_failed` | 8788 被占用 / bind 非法 | 换端口或释放占用；这是故意硬失败（防止无防线运行） |

## 8. 实现与测试

- `src/gateway.mjs`：gateway 本体（`createGateway`、`GATEWAY_POLICY_SUMMARY`）。
- `src/config.mjs`：`DEFAULT_GATEWAY`、`normalizeGatewayConfig`、`isLoopbackAddress`；
  `defaultConfig` / `normalizeConfig` 的 `gateway` 段。
- `bin/dshlink.mjs`：`serve` 中启动/关闭 gateway，启动日志一行。
- 测试（gateway 子集）：

  ```powershell
  node --test --test-concurrency=1 test/gateway.test.mjs
  ```

  覆盖：配置规范化/回环判定、provider 配置、缺失/非法/过期 token 的 401（且不触达上游）、device 白名单与
  role_forbidden、admin/peer 放行、/mcp 与 bridge 的全角色 403、POST body/content-type 转发、
  Range 头转发（远程文件断点下载）、413/502/504、token 热重载、`close()` 幂等，以及端到端转发
  （fake upstream 校验它收到的 `Authorization` 就是调用方原始 token）。

## 9. 相关文档

- [`FRP.md`](FRP.md) — STCP provider/visitor 的完整部署与坑；§2.3 第 1 条正是本页要堵的回环绕过。
- [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) — trustLocalhost 的历史审计与残余风险。
- [`mobile/CONTROL-APP.md`](mobile/CONTROL-APP.md) §5 — 手机端生产加固，与本页配套。
- [`OPERATIONS.md`](OPERATIONS.md) — 令牌轮换与常驻部署。
