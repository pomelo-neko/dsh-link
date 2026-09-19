# 配对与穿透（客户端视角）

## 两种连法

| 场景 | 做法 |
|---|---|
| 同一局域网 / 有可达地址 | `peers add --name X --url http://<host>:<port> --token <对方的 token>` |
| 双方都在 NAT 后（推荐） | 公网 frps + STCP：`tunnel setup` → `invite` → 对端 `peers accept` |

## FRP 客户端配置

```powershell
node bin\dshlink.mjs tunnel setup --server <frps 地址> --port 7000 --token <frp token>
node bin\dshlink.mjs tunnel sync        # 生成 frpc.toml 并拉起 frpc
node bin\dshlink.mjs tunnel status      # 进程 / visitor 端口 / 日志尾部
node bin\dshlink.mjs tunnel stop
```

- frpc 自动在 `vendor/frp/<平台>/frpc` 里找，也可用 `--frpc <路径>` 或 `DSHLINK_FRPC`。
- **本包不含 frps**；frps 部署在公网服务器（配置示例见 `docs/FRP.md`，token 在服务器 `/etc/frp/frps.toml`）。
- 双方必须连**同一个 frps**：STCP visitor 只在同一 frps 内找得到对方的 provider。

## 配对码（invite）里有什么

```json
{
  "kind": "dshlink-invite", "v": 1,
  "name": "my-pc",
  "urls": ["http://<本机可见地址>:8787"],
  "token": "<为对端新生成的入站 token>",
  "stcp": { "proxyName": "dshlink-my-pc", "secretKey": "...", "serverAddr": "<frps-host>", "serverPort": 7000 },
  "issuedAt": "...", "expiresAt": null
}
```

- 它是**密钥**：只走可信渠道。泄露后用 `token rm --id <id>` 单独撤销那一条，不影响其它对端。
- `--ttl <分钟>` 让它过期；`--no-token` 生成不含 token 的码（之后 `--their-token` 手工补）。
- 收到码的一方执行 `peers accept --invite <码> [--reply]`；`--reply` 打印回执码，双方一次配好。
- 也可以直接粘贴整段：`peers accept --invite @path/to/code.txt`。

## 常见问题

| 现象 | 处理 |
|---|---|
| `peers ping` 报 `ECONNREFUSED` | visitor 端口没起来：`tunnel status` 看 frpc 是否在跑、日志里有没有 `start visitor success` |
| 同一台机器上跑两个节点时端口冲突 | 已自动处理：管理端口 / visitor 端口被占用会自动顺延并写回配置 |
| 拉取报 `forbidden` | 路径越出共享根，或命中拒绝清单（`.env`、`*.key`、`.ssh` 等） |
| 推送 `403` | 对端未开 `allowUpload`，或目标根不是 `rw` |
| 消息 `queued`（退出码 3） | 对端离线，已排队；恢复后 `flush`，或对端 `sync --from <你>` |
| 想让 agent 直接调用 | `install-dsh --write` 后 DSH 出现 `mcp__dshlink__link_*` 工具；或把 `integrations/dsh-skill` 装进技能库 |

## 自检

```powershell
node bin\dshlink.mjs doctor            # 配置/目录/共享根/端口/MCP/对端/隧道
node bin\dshlink.mjs status --probe    # 本机身份 + 对端可达性
```
