# dsh-link 设计说明

## 目标

让**多台计算机上的 DeepSeek Harness** 能互相通信：发消息、互相拉取/推送文件、离线不丢，
并且尽量少依赖外部服务（零 npm 依赖、可只靠一台公网 frps）。

非目标：替代 DSH 自身的会话/子代理机制；做通用分布式文件同步（那是另一个问题域，本项目只关注 DSH 之间）。

## 为什么是“每机一个节点 + HTTP”

- DSH 的扩展点里，`@deepseek-ai/dsh-mcp-client` 原生支持 **streamable-http**，
  于是把能力做成一个 HTTP 服务 = agent 直接拿到原生工具，无需改 DSH 内核。
- 传输层用 HTTP，就可以自由选择直连 / FRP / 反代，而不必为每种网络改代码。
- 每个节点自持数据（JSONL），不依赖中心服务器：中心只在 FRP 层做 TCP 汇聚。

## 组件

```
   A 机 (DSH)                          B 机 (DSH)
┌────────────────────┐              ┌────────────────────┐
│ agent ── MCP ──► dshlink :8787 ──┼─► dshlink :8787 ◄── MCP ── agent │
│   inbox/outbox.jsonl│  HTTP/mcp    │  inbox/outbox.jsonl│
│   共享根(ro/rw)      │              │   共享根(ro/rw)      │
└─────────┬──────────┘              └──────────┬─────────┘
          │ STCP provider                      │ STCP provider
          └──────────► 公网 frps :7000 ◄───────┘
                    （双方都只出站；visitor 端口只在本机监听）
```

模块职责见 `README.md` §6；协议细节见 `PROTOCOL.md`。

## 投递模型（四个动作覆盖所有网络情形）

| 情形 | 机制 |
|---|---|
| 双方在线、网络可达 | 直接 `POST /api/v1/messages`（push） |
| 接收方离线/不可达 | 发送方 outbox 排队 `pending`；`flush` 或 `--auto-sync` 重投 |
| 发送方连不上接收方（NAT/单向） | 接收方 `sync`：`GET /api/v1/outbox?to=me` 主动拉，按 id 去重 |
| 两者互不可达、但有共同 hub | hub `relay`：收到写给第三方的消息后转发并记录 `via` |

消息幂等：id 唯一 + 接收端去重；`sync` 可重复执行。

## 与既有研究的关系（重要）

FRP STCP 这一类工具（provider 服务方 + visitor 访问方，经公网 frps 会合，双方零入站端口）
已经是很成熟的做法；dsh-link 沿用这套拓扑，但代码与凭据都是自己的：

1. **FRP STCP 拓扑**：固化进 `src/tunnel.mjs`（生成 `frpc.toml` + 管理 frpc 进程）。
2. **二进制位置约定**：按 `--frpc` → `$DSHLINK_FRPC` → `<仓库>/vendor/frp/<平台>` → `$DSHLINK_HOME/frp`
   → `~/.dshlink/frp` → 常见系统目录 的顺序查找（完整列表见 [`FRP.md`](FRP.md) §2）。
   token/secretKey 一律不写死，由 `tunnel setup` / `tunnel share` 现场生成与分发。

## 威胁模型

| 威胁 | 缓解 |
|---|---|
| 陌生人访问 API | token（sha256 存储、恒时比较）+ 默认只绑回环 + 认证失败限流 |
| 越权读文件 | 共享根白名单 + realpath 校验 + 拒绝清单 + 只读默认 |
| 越权写文件 | `allowUpload` 默认关闭；根需显式 `write: true`；原子写 |
| 传输窃听 | 局域网可信假设；公网走 frps TLS（`transport.tls.force`）或 HTTPS 反代；mTLS 可选 |
| 消息伪造 | 消息带 `from.nodeId/name`，但只作为**展示**信息；投递凭 token，不凭 from |
| 磁盘被撑满 | 请求体上限（默认 32 MiB）、消息上限（1 MiB）、内联附件上限（512 KiB） |
| 事后追责 | `audit.jsonl` 记录文件读/写、消息投递、认证失败 |

尚未做（明确记录）：端到端加密、消息签名、token 轮换自动化、多租户隔离。

## 路线图

已完成：邀请式配对（0.2.1 `invite` / `peers accept`）、配置热重载（0.2.1）、
DSH Host 插件与自动唤醒（0.2.1；0.3 起话题路由 + 自动归档）、只读 DSH 视图与能力通道（0.3）。

待做：

1. **HTTPS/TLS 直连模式**：自带自签证书 + 指纹固定（`--tls --fingerprint`）。
2. **大文件**：分片 + 断点续传（服务端 Range 已就绪）。
3. **守护化模板**：systemd 单元；Windows 已有 `scripts/start-dshlink.*` 幂等启动器。
4. **端到端加密 / 消息签名**：当前只有传输层保护，见 [`../SECURITY.md`](../SECURITY.md)。
5. **token 轮换自动化**：两端同时换 + 带外交接目前靠人工，步骤见 [`OPERATIONS.md`](OPERATIONS.md) §5。
