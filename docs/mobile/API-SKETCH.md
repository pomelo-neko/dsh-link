# dsh-link 移动端 API 速查（已实现）

> **状态（0.6.0）：A 阶段已实现。** 实际 App 在 [`android/`](../../android/)，实现说明与验证见
> [`CONTROL-APP.md`](CONTROL-APP.md) 与 [`android/README.md`](../../android/README.md)。本文件保留为
> 接口速查与 B 阶段建议，不再只是草案。

配套文档：[MOBILE-CONTROL-FEASIBILITY.md](../MOBILE-CONTROL-FEASIBILITY.md)。本文件只列 App 需要的端点、字段与调用顺序，便于实现时对照；标「B 阶段」的端点为建议、当前节点未实现；标「已实现」的端点已随 dsh-link 落地。

## 1. 连接与鉴权

- Base URL：http://<节点地址>:8787（默认 bind 127.0.0.1，无 TLS）
- 鉴权头二选一：Authorization: Bearer <token> 或 X-DSHLink-Token: <token>
- 0.5 起默认 `trustLocalhost: false`：即使来自回环/隧道也必须带 token（手机用 `role: device`）
- 失败响应统一为 { "error": { "code": "...", "message": "..." } }
- 同 IP 每分钟失败超过 20 次会返回 429（src/server.mjs:58-62）

~~~text
GET /healthz                       # 免鉴权连通性探测
GET /api/v1/info                   # 能力发现，App 启动时调用一次并缓存
~~~

info 关键字段（节选）：

~~~json
{
  "name": "alice-pc",
  "nodeId": "node_01m0000000000000000",
  "softwareVersion": "0.3.0",
  "dsh": { "enabled": true, "workspaces": true, "transcripts": true },
  "capabilities": { "enabled": true, "methods": ["workspaces.list", "sessions.list", "sessions.read", "bridge.status"] },
  "peers": [{ "name": "bob-pc", "url": "http://127.0.0.1:19110", "hasToken": true }],
  "limits": { "maxBodyBytes": 33554432, "maxMessageBytes": 1048576, "maxInlineAttachmentBytes": 524288 }
}
~~~

## 2. 只读视图

| 方法 | 路径 | 关键参数 | 返回要点 |
|---|---|---|---|
| GET | /api/v1/dsh/workspaces | includeArchived=1 | {peer,home,count,workspaces[]}；workspaces 含 id/title/path/archived/sessions/lastActivityAt |
| GET | /api/v1/dsh/sessions | workspace, query, limit（≤1000） | {peer,count,sessions[]}；sessions 含 sessionId/workspaceId/title/cwd/updatedAt/sizeBytes/messages/messagesExact |
| GET | /api/v1/dsh/sessions/{id} | — | {peer,session{...}}；不存在 404 |
| GET | /api/v1/dsh/sessions/{id}/transcript | limit, offset, tail=1, sinceSeq | {peer,session,total,messages[],truncated,corruptFrames,latestSeq,sinceSeq}；sinceSeq 只返回 seq 更大的行（0.4 已实现） |
| GET | /api/v1/dsh/capabilities | — | {peer,enabled,methods,catalog[],bridge{...},queue{...}} |
| GET | /api/v1/bridge/status | — | {bridge{...},fresh,ageMs,queue,enabled} |

transcript 行结构：

~~~json
{ "seq": 132, "time": 1793631572269, "role": "assistant", "kind": "assistant",
  "text": "……", "tool": null, "truncated": false }
~~~

要点：

- limit 请求上限 1000，但节点实际夹到 dsh.transcriptMaxMessages（默认 200）；offset 上限 1e6；tail=1 表示取尾部窗口。
- total 是「渲染行数」，不是消息数；同一事件可能渲染成多行且共享 seq，seq 可能为 null。
- 无 since/游标参数；增量只能用 offset+total 近似（见 §4）。
- truncated=true 代表窗口被截断（前面还有内容或日志超 32 MiB 只读前缀）。

## 3. 控制面（发送消息）

~~~text
POST /api/v1/dsh/call
Content-Type: application/json
Authorization: Bearer <token>

{ "method": "sessions.prompt",
  "params": { "sessionId": "session-6a134890-...", "text": "继续，先给结论" },
  "waitSeconds": 0 }
~~~

- 提交返回 {commandId, method, status:"pending", pending:true}；waitSeconds=0 不等待，默认 30、最大 180。
- 查询：GET /api/v1/dsh/call/{commandId} → {commandId,method,status,ok,origin{peer,ip,label},createdAt,finishedAt,result,error}
- 跨节点：body 增加 "peer":"bob-pc"。
- 前置条件：/info 的 capabilities.enabled=true、methods 含 sessions.prompt、bridge.stale=false；否则 403 capability_denied 或 503。
- result.accepted=true 只代表 bridge 已受理，不代表模型回复完成；回复需轮询 transcript。

动作方法（当前节点默认只授权读方法）：

| 方法 | kind | 参数 |
|---|---|---|
| workspaces.list | read | — |
| sessions.list | read | workspace, includeArchived, limit, query |
| sessions.read | read | sessionId, tail, maxMessages, maxChars |
| bridge.status | read | — |
| sessions.create | action | workspaceId, title?, cwd? |
| sessions.prompt | action | sessionId, text |
| sessions.rename | action | sessionId, title |
| sessions.archive | action | sessionId, archived? |

## 4. A 阶段增量算法（零服务端改动）

~~~text
首屏：GET transcript?limit=200&tail=1        → 记 total=N，渲染
轮询：GET transcript?offset=N&limit=200      → 取 [N, ...] 行；新 total=M
追赶：while M > N + 已取行数: offset += 已取行数 继续拉
去重：行哈希 = sha1(seq + "|" + role + "|" + kind + "|" + text)
失效：若 M < N 或 session.sizeBytes 回退 → 清空本地缓存，tail=1 重拉
~~~

轮询建议 3–5 s；进入后台后降频或停止（WorkManager）。

## 5. 新增端点草案（B 阶段）

> **0.4 已实现**：节点 transcript 支持 `sinceSeq` 并返回 `latestSeq`/`sinceSeq`，App 可直接用「tail 快照 + sinceSeq 轮询」实现增量，无需下面的指纹 cursor。以下 cursor/SSE 设计保留为 B 阶段增强（解决同一 seq 多行、日志重写检测与实时推送）。

### 5.1 增量 transcript（B 阶段增强）

~~~text
GET /api/v1/dsh/sessions/{id}/transcript?since=v1:41:2311442:1793631572269:a1b2c3d4&limit=200
→ { peer, session, total, messages[], truncated, corruptFrames,
    nextCursor: "v1:60:2401201:1793631604000:e5f6a7b8", reset: false }
~~~

cursor 格式建议 v1:<渲染行总数>:<日志字节数>:<mtimeMs>:<末 64KiB sha1 前 8 位>；节点比对指纹，不一致则 reset=true 并返回尾窗。

### 5.2 SSE 事件流

~~~text
GET /api/v1/dsh/sessions/{id}/events
Accept: text/event-stream
Last-Event-ID: v1:60:2401201:1793631604000:e5f6a7b8

event: transcript
id: v1:61:2401500:1793631609000:f1e2d3c4
data: {"reset":false,"nextCursor":"...","messages":[...],"total":61}

event: heartbeat
data: {"bridgeFresh":true,"queuePending":0}
~~~

服务端要求：心跳 15–25 s、连接断开清理、res.setTimeout(0)、支持 Last-Event-ID 补发。

### 5.3 长轮询备选

~~~text
GET /api/v1/dsh/sessions/{id}/transcript/wait?since=<cursor>&timeoutMs=25000
→ 有新内容立即返回（同 5.1 结构）；超时返回 {unchanged:true,nextCursor:...}
~~~

### 5.4 设备 token 管理

~~~text
POST   /api/v1/tokens        {label, device:{platform,name,model}, scopes:["dsh:read","dsh:prompt"]}
                              → 一次性返回明文 token；服务端只存 hash
GET    /api/v1/tokens        → [{id,label,device,scopes,createdAt,lastUsedAt}]
DELETE /api/v1/tokens/{id}   → 吊销
~~~

## 6. 错误码与 App 处理

| code | HTTP | 含义 | App 处理 |
|---|---|---|---|
| unauthorized | 401 | token 缺失/错误 | 提示重新配对，停止重试 |
| dsh_disabled | 403 | 节点未开 DSH 视图 | 隐藏 DSH 功能 |
| dsh_workspaces_disabled | 403 | 未开 workspace 暴露 | 隐藏列表 |
| dsh_transcripts_disabled | 403 | 未开 transcript | 隐藏详情 |
| dsh_unavailable | 503 | DSH home 不可读 | 提示节点侧检查 DSH |
| capability_denied | 403 | 方法未授权/peer 受限 | 提示需要节点开动作授权 |
| capability_pending_overflow | 429 | 队列满 | 退避，稍后重试 |
| not_found | 404 | session/命令不存在 | 返回上一级并刷新列表 |
| rate_limited | 429 | 失败次数过多 | 指数退避 |

## 7. App 调用时序（最短路径）

~~~text
启动：GET /info → 校验 dsh.enabled / capabilities.methods → 进入列表
列表：GET /dsh/workspaces；GET /dsh/sessions?limit=100
详情：GET /dsh/sessions/{id}；GET /dsh/sessions/{id}/transcript?limit=200&tail=1
更新：3–5 s GET /dsh/sessions/{id}/transcript?sinceSeq=<lastSeq>&limit=200（0.4 已实现；B 阶段换 SSE/长轮询）
发送：GET /dsh/capabilities 校验 → POST /dsh/call(sessions.prompt, waitSeconds:0)
      → GET /dsh/call/{commandId} 轮询到 done/failed → 继续看 transcript 增量
~~~

## 8. 契约测试建议（node:test + MockWebServer）

1. transcript 参数夹取：limit=1000 → 200；offset 超界 → 空 messages。
2. 增量：文件追加后 total 增加；日志重写后 reset=true（B 阶段）。
3. 动作授权：未授权 methods 下发 → 403 capability_denied；授权后 → 命令入队。
4. SSE：断线重连带 Last-Event-ID 不丢行、不重复（B 阶段）。
5. 错误信封：401 / 403 / 404 / 429 与上表一致。
6. 兼容：节点返回未知字段时 App 不崩溃（kotlinx.serialization ignoreUnknownKeys）。
