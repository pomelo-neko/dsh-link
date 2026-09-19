# 跨机访问对方 DSH 的工作区与对话（dsh-link 0.3）

0.2.x 的 dsh-link 只在**预先声明的共享目录**里传文件，也只能等你手动打开某个对话去看消息。
0.3 增加两层能力，让任意一方可以看到并进入对方**全部工作区、全部对话**；同时把 bridge 的
「永远复用同一个对话」改成「按话题建对话、老对话自动归档」。

---

## 1. 能力一览

| 层 | 谁在跑 | 能做到什么 | 依赖 | 默认 |
|---|---|---|---|---|
| **只读视图层** | 本机 dsh-link 节点直读磁盘 | 列出对方所有工作区 / 所有对话（标题、时间、大小、是否归档）、读任意对话的完整消息、按工作区浏览文件 | 只要对方节点 ≥ 0.3.0 | **关**（`dsh.enabled`） |
| **能力通道层** | 对方 DSH 里的 bridge 插件执行 | 权威的会话列表/读取、**新建会话、向任意会话发消息、重命名、归档** | 对方 bridge ≥ 0.3.0（需重启 DSH 加载新代码） | **关**（`capabilities.enabled`） |

两层都只在**已配置 token 的 peer** 之间生效（本机 loopback 例外），每一次跨机访问都写审计。

---

## 2. 只读视图层（节点直读磁盘，不需要 DSH 进程）

数据来源（本机实测路径，DSH_HOME = `D:\DSH`）：

- 工作区注册表：`storages/workspace.json`（`tables.workspaces[<id>]` = { path, title, sessionIds }，`global.archivedSessionIds` = 已归档会话）
- 会话日志：`sessions/<slug>/session-<uuid>/session.v3.jsonl.zstd`
  （多个 zstd 帧首尾拼接；按魔数 `28 B5 2F FD` 切帧、逐帧解压后是 JSONL；首行是
  `{"type":"session",...,"cwd":...,"createdAt":...}`，标题事件是 `session/title`）
- 标题兜底：`storages/session_projcache/sessions/<sessionId>.json`

### 配置（节点数据目录里的 dshlink.config.json）

```json
"dsh": {
  "enabled": true,
  "home": "D:\\\\DSH",
  "exposeWorkspaces": true,
  "exposeTranscripts": true,
  "transcriptMaxChars": 8000,
  "transcriptMaxMessages": 200,
  "excludeWorkspaces": []
}
```

### HTTP 接口（都要 token 或 loopback）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/dsh/workspaces` | 全部工作区：id/title/path/会话数/最后活动时间 |
| GET | `/api/v1/dsh/sessions?workspace=&includeArchived=1&query=&limit=` | 全部对话（默认隐藏已归档） |
| GET | `/api/v1/dsh/sessions/:id` | 单个对话的元数据 |
| GET | `/api/v1/dsh/sessions/:id/transcript?limit=&offset=&tail=1` | 对话消息（user/assistant/reasoning/tool-call/tool-result，超长裁剪） |
| GET | `/api/v1/dsh/capabilities` | 本机开放了哪些能力 + bridge 心跳 + 命令队列统计 |

会话摘要里的 `messages` 是**下界**（索引只扫日志头部，`messagesExact: true` 时才是精确值）；
要精确条数用 `transcript` 返回的 `total`。日志超过 32 MiB 只读前 32 MiB 并置 `truncated`。

### 虚拟文件根：`kind: "workspaces"`

```json
"files": { "roots": [ { "name": "allws", "kind": "workspaces", "read": true, "write": false } ] }
```

根下的第一段路径是工作区（用 id 或 slug），其余是该工作区内的相对路径，例如
`allws:<workspace-id>/src/index.mjs`。写入需要 `write: true`
且 `files.allowUpload: true`；`files.deny` 仍然生效（`.env`、私钥等照旧被拦）。

---

## 3. 能力通道层（bridge 在 DSH 里执行）

```
对端 DSH ──HTTP──> 本机 node ──命令队列──> 本机 bridge（在 DSH 进程内）──> DSH Host 服务
   人/模型            8787          commands/        sessionController / workspaceRegistry
```

- 对端调用 `POST /api/v1/dsh/call`，本机节点把命令写进 `<dataDir>/commands/<id>.json` 并等待结果；
- 本机 bridge 每 `commandSeconds`（默认 5s）轮询 `GET /api/v1/bridge/commands`，原子认领一条命令，
  用 DSH 服务执行，再 `POST /api/v1/bridge/commands/:id/result` 回填；
- 节点把结果返回给对端；超时未完成则返回 commandId，对端可用 `GET /api/v1/dsh/call/:id` 补取；
- `GET /api/v1/bridge/status`（仅 loopback）给出 bridge 心跳与队列统计，`dshlink dsh bridge` 就是它。

命令队列的耐久性：一条命令一个文件（`<dataDir>/commands/<id>.json`），认领时用 `O_EXCL` 建 `<id>.claim`，
所以**同一条命令只会被一个 bridge 执行**；认领超过 `claimStaleSeconds` 可被接管，非终态命令在
`commandTtlSeconds` 后作废（`expired`），结果按 `maxResultBytes` 裁剪，队列上限 `maxPending`。

### 方法表

| 方法 | 类型 | 参数 | 返回 |
|---|---|---|---|
| `workspaces.list` | 读 | — | 全部工作区（含归档标记） |
| `sessions.list` | 读 | `workspace?, includeArchived?, limit?` | 会话摘要 |
| `sessions.read` | 读 | `sessionId, limit?, tail?` | 会话消息 |
| `sessions.create` | 动作 | `workspaceId?\|cwd?, agentPreset?, title?` | `{ sessionId, title }` |
| `sessions.prompt` | 动作 | `sessionId, text, requestId?` | `{ accepted: true }` |
| `sessions.rename` | 动作 | `sessionId, title` | `{ sessionId, title }` |
| `sessions.archive` | 动作 | `sessionId` | `{ archived: true }`（DSH 原生归档集） |
| `bridge.status` | 读 | — | bridge 心跳与版本 |

### 配置

```json
"capabilities": {
  "enabled": true,
  "methods": ["workspaces.list", "sessions.list", "sessions.read", "bridge.status"],
  "peers": { "bob-pc": { "allow": ["sessions.prompt"], "deny": [] } },
  "maxWaitSeconds": 30,
  "maxPending": 50
}
```

读方法默认允许（启用后），`sessions.create/prompt/rename/archive` 属于**动作**，必须显式加入
`methods` 或某个 peer 的 `allow` 才会执行。判定顺序：`enabled` → 方法是否已知 → 该 peer 的 `deny`
→ 生效白名单；**某个 peer 配了非空 `allow` 时，它的白名单会覆盖节点级 `methods`**（既可用于收窄，
也可用于给单个 peer 额外授权），`deny` 永远优先。

bridge 侧的相关配置（写在 profile patch 的插件 config 里，见插件 README）：`commandSeconds`（轮询间隔，
0 = 关闭整条通道）、`commandBatch`、`topics.*`、`archiveSessions`、`sessionTitlePrefix`。

---

## 4. 智能建会话与自动归档（bridge 侧）

旧行为：bridge 永远复用同一个 `sessionId`，所有话题堆在一个上下文里，越跑越长。

新行为：**一个话题一个会话**。

- **话题键**：有 `thread` 用 `thread:<id>`；否则用 `topic:<peer>/<去掉 Re:/答复: 前缀的主题>`；都没有用 `msg:<id>`。
- **复用**：同话题且未超预算 → 复用原会话。
- **新建**（并把旧会话归档）：话题闲置超过 `topicIdleResetSeconds`(6h) / 会话唤醒次数达
  `maxSessionWakes`(12) / 会话存活超过 `maxSessionAgeSeconds`(12h)。
- **自动归档**：闲置超过 `archiveIdleSeconds`(24h) 的会话加入 DSH 原生归档集
  （`workspaceRegistry.archiveSession`，等价于界面上的「归档对话」：从侧边栏收起但日志保留），
  话题池超过 `maxPoolSize`(20) 时按最久未用优先归档。
- 状态落在 bridge 的 `state.json`：`pool`（每话题 sessionId/wakes/createdAt/lastUsedAt/label/archived）。

新建的会话标题统一带 `[dsh-link] ` 前缀，便于在侧边栏一眼区分人开的对话与桥开的对话。

---

## 5. 安全模型

- **默认全关**：`dsh.enabled` 与 `capabilities.enabled` 都是 `false`，不配置就等于没有这些能力。
- **只对带 token 的 peer 开放**（`auth.trustLocalhost` 只影响 loopback）。
- **动作要显式授权**：读会话和写会话是两组开关，`sessions.prompt` 等于让对方驱动你机器上的
  agent（会执行命令、改文件），**只在本机操作员明确同意时打开**。
- **审计**：`audit.jsonl` 记录 `dsh_view_*`、`dsh_call`、`bridge_result` 事件（peer、方法、目标、结果）。
- **限额**：`maxPending`（队列）、`maxWaitSeconds`（长轮询）、`commandTtlSeconds`（过期作废）、
  结果裁剪 `maxResultBytes`。
- 对话内容里可能含凭据/隐私，读接口默认裁剪长文本；共享时请自行评估。

---

## 6. 升级与验证

1. 更新节点代码 → **重启节点进程**（运行中的进程需操作员批准）；
2. 更新 bridge 代码 → **重启 DSH host**（ESM 缓存，热重载不生效）；
3. 两侧配置里打开 `dsh.enabled`（只读）或再加 `capabilities.enabled`（动作）；
4. 两侧都要升级：**只读视图**需要节点 ≥ 0.3.0；**动作**还要 bridge ≥ 0.3.0 并重启过 DSH host；
5. 打开开关（配置热重载，不必重启）：`dshlink dsh enable --write`（只读），
   要动作再加 `--actions workspaces.list,sessions.list,sessions.read,sessions.prompt --write`；
6. 验证：
   - 本机：`dshlink dsh workspaces`、`dshlink dsh sessions`、`dshlink dsh transcript <id>`、`dshlink dsh bridge`
   - 跨机：`dshlink peers ping <peer>` 看 `softwareVersion`；`dshlink dsh workspaces --peer <peer>`；
     `dshlink dsh call bridge.status --peer <peer> --wait 10`；
   - 归档验证：让对方连发两条同话题消息，`state.json` 的 `pool` 应只有一条记录、`sessionsCreated` 不涨；
     触发预算后再看 `sessionsArchived` + `lastArchive.reason`。

---

## 7. 已验证（0.3.0）

- 单元 + 集成测试 **116 项全绿**（`node test/run.mjs`），其中与本次改动直接相关的：
  `dshview`（19）直读真实 DSH home：4 个工作区 / 15 条对话（2 条归档）/ 4.9 MB 会话 `total=1653`、冷读 234 ms；
  `capabilities`（18）队列与授权矩阵（含并发认领只有一个赢家、陈旧租约接管、上限 429、结果裁剪）；
  `bridge-topics`（12）话题键、预算/超龄/闲置轮换与清扫；
  `bridge-commands`（22）worker 与 Host 处理器；
  `dsh-access`（4）端到端：只读视图、虚拟工作区根（含 `.env` 仍被拒）、能力通道 claim→result、非 loopback 访问被拒；
  `bridge`（12）含新增用例：一个话题一个会话、退休会话归档、闲置清扫、命令端到端。
- 真实环境回归只用只读方式（没有任何写操作）跑过：`dshlink dsh workspaces/sessions/transcript` 对本机 DSH_HOME。
