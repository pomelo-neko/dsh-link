# 架构：dsh-link 由哪些部分组成

一句话：**节点（node）是一个跑在本机的 HTTP 服务，桥（bridge）是一个跑在 DSH 里的 Host 插件，
两者各自独立发版**。`docs/` 其余文档都按这条边界展开。

```
   对端机器                                 本机
 ┌──────────────┐                    ┌────────────────────────────────────────┐
 │ dshlink 节点 │  HTTP + token      │ dshlink 节点  (bin/ + src/, 默认 :8787) │
 │  (同左)      │ ◄────────────────► │   ├─ /api/v1/*   HTTP JSON API         │
 └──────────────┘                    │   ├─ /mcp        MCP streamable HTTP   │
                                     │   └─ 数据目录 <dataDir>/               │
                                     └───────────────┬────────────────────────┘
                                                     │ 本机回环（默认免 token）
                     ┌───────────────────────────────┼───────────────────────────┐
                     │ DSH host                      │                           │
                     │  ├─ dsh-mcp-client ───────────┘  → mcp__dshlink__link_*   │
                     │  └─ dsh-link-bridge (Host 插件)                            │
                     │        ├─ 轮询未读消息 → 唤醒/复用会话                      │
                     │        └─ 轮询命令队列 → 代对端读/驱动本机 DSH              │
                     └───────────────────────────────────────────────────────────┘
```

## 组件

| 组件 | 位置 | 版本 | 作用 |
|---|---|---|---|
| 节点 / CLI | `bin/dshlink.mjs`、`src/*.mjs` | `package.json` 的 `0.3.0` | 消息、文件、隧道、配对、DSH 只读视图、能力通道的命令队列 |
| MCP 端点 | 节点内的 `src/mcp.mjs`（`http://127.0.0.1:8787/mcp`） | 随节点 | 17 个 `link_*` 工具，由 `@deepseek-ai/dsh-mcp-client` 装载 |
| 桥插件 | `integrations/dsh-link-bridge/` | 自己的 `package.json` | DSH Host 插件：未读消息唤醒会话、话题路由与归档、能力通道的 Host 侧执行 |
| 技能 | `integrations/dsh-skill/SKILL.md` | — | 教 agent 用 CLI 的说明文件（复制到 `$DSH_HOME/skills/`） |

**两者可以各自升级**，所以排障第一步永远是先确认版本：`dshlink --version`、
`dshlink peers ping`（对端 `softwareVersion`）、`integrations/dsh-link-bridge/package.json`。

## 磁盘上的状态

| 文件 | 位置 | 内容 |
|---|---|---|
| `dshlink.config.json` | `<dataDir>`（默认 `~/.dshlink`，可用 `DSHLINK_HOME` / `--data-dir` 改） | 身份、监听、token 哈希、共享根、peer、隧道、`dsh`、`capabilities` |
| `inbox.jsonl` / `outbox.jsonl` | `<dataDir>` | 收到的 / 待投递的消息，含投递与已读状态 |
| `state.json` | `<dataDir>` | 已读标记、投递状态、去重用的 id 映射（CLI 与节点共享） |
| `audit.jsonl` | `<dataDir>` | 文件访问与投递审计 |
| `frp/frpc.toml` | `<dataDir>` | `tunnel sync` 生成，frpc 只读这一份 |
| `state.json` | `<DSH_HOME>/plugin-data/dsh-link-bridge/` | **桥**的心跳与水位：`ticks`、`watermarkTs`/`watermarkId`、`notified`、`errors`、`pool`、`commands` |

> `<dataDir>/state.json`（节点）与 `<DSH_HOME>/plugin-data/dsh-link-bridge/state.json`（桥）
> 是两个完全不同的文件，排障时不要看错。

## 一条消息的生命周期

1. `send` → 本机 `outbox.jsonl`（`pending`）；
2. 投递：`flush` / `sync` / `--auto-sync` 或对端拉取 → 对端 `inbox.jsonl`，状态转 `delivered`；
3. 对端的桥轮询发现未读 → 唤醒/复用会话并注入 prompt；
4. 对端的 agent 用 `link_read_message` 读全文、`link_reply` 回复、`link_inbox markRead` 置读。

## 唤醒链路（bridge）

```
节点未读 ──► 桥 pollSeconds 轮询 ──► 选会话（同话题复用/超限新建）──► 注入 prompt
                                                                        │
   markRead ◄── link_reply ◄── agent 处理（MCP 工具）◄──────────────────┘
```

水位是 `(watermarkTs, watermarkId)` **元组**（0.2.2 起）：同一毫秒内到达的两条消息不会被漏掉。

## 能力通道（0.3，默认关闭）

```
对端 ──► 本机节点 /api/v1/capabilities/*（鉴权+策略）──► <dataDir>/commands/*.json
                                                              │ 桥 commandSeconds 轮询
                                                              ▼
                                            桥调用 DSH Host RPC，写回 result ──► 对端取结果
```

策略：`capabilities.enabled` 总开关 → `methods` 节点级白名单 → `peers.<名>.allow/deny` 覆盖
（`allow` 非空即覆盖节点级；`deny` 永远优先）。动作方法（`sessions.create/prompt/rename/archive`）
默认不放行。

## DSH 只读视图（0.3，默认关闭）

节点**直接读磁盘**（`storages/workspace.json` + `sessions/**/session.v3.jsonl.zstd`），
不经过 DSH 进程，所以对端只需要节点 ≥ 0.3 就能看；转录正文另由 `exposeTranscripts` 控制。
副作用是 DSH 换了会话日志格式就要升级 dsh-link；无 zstd 的 Node（< 22.15）会报
`zstd-unsupported`，此时改走能力通道。

## 判据速查

| 想确认 | 看什么 |
|---|---|
| 节点活着 | `dshlink status --json`、`/api/v1/status` 的 `runtime.configReloads` |
| 配置热重载生效 | `status` 的 `configLastReloadAt` / `configLastError` |
| 对端可达 | `dshlink peers ping`（`reachable`、`softwareVersion`） |
| 消息卡住 | `outbox.jsonl` 里的 `pending`、`dshlink flush` |
| 桥在工作 | `plugin-data/dsh-link-bridge/state.json` 的 mtime 在动、`errors: 0` |
| 桥是 0.3 | 该 state 里出现 `pool` / `commands` 字段 |
| 唤醒真的发生过 | state 的 `notified` 增长（它是累计**消息条数**，不是唤醒次数） |
| 对端能看到什么 | `dshlink dsh workspaces/sessions --peer <名>`（受 `excludeWorkspaces` 约束） |
