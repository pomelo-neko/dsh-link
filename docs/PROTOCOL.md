# dsh-link wire protocol (v1)

Everything is HTTP/1.1 + JSON on one port. Binary file bodies are streamed.
Auth: `Authorization: Bearer <token>` or `X-DSHLink-Token: <token>`.
Requests from 127.0.0.1/::1 are accepted without a token while
`auth.trustLocalhost = true` (default). 20 failed auths per IP per minute → `429`.

## Node API

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness, never authenticated: `{ok,name,nodeId,software,version,time}` |
| GET | `/api/v1/info` | Identity, public URL, shared roots, limits, relay flag |
| GET | `/api/v1/status` | Full local status (`?probe=1` pings peers) |
| GET | `/api/v1/peers` | Configured peers (`?probe=1` adds remote name/roots/latency) |
| POST | `/api/v1/messages` | Deliver a message envelope. `to == me` → inbox; otherwise relay if enabled |
| GET | `/api/v1/messages` | Inbox query: `since`, `limit`, `unread=1`, `thread`, `from`, `order` |
| GET | `/api/v1/messages/:id` | One inbox message |
| POST | `/api/v1/messages/read` | `{ids:[...]}` → mark read |
| POST | `/api/v1/messages/:id/read` | Mark one read |
| GET | `/api/v1/outbox` | Sent messages; `?to=<name>` filters "what I sent you" (used by sync) |
| GET | `/api/v1/files` | List a directory: `root`, `path`, `limit` |
| GET | `/api/v1/files/stat` | Stat: `root`, `path` |
| GET | `/api/v1/files/hash` | `{sha256,size,mtime}` for one file |
| GET | `/api/v1/files/download` | Stream file; `X-DSHLink-SHA256` header; single `Range` supported |
| POST | `/api/v1/files/upload` | Raw body → `root`/`path`; needs `files.allowUpload` + writable root |
| GET | `/api/v1/audit` | Recent audit entries (`limit`) |

Errors: `{"error":{"code","message","details"}}` with HTTP status
(400 bad_request, 401 unauthorized, 403 forbidden, 404 not_found, 409 conflict,
413 payload_too_large, 429 too_many_failures, 502 upstream_error).

`GET /api/v1/status` also reports a `runtime` block describing the **running process** (not the file):
`version`, `pid`, `startedAt`, `configPath`, `configReloads`, `configLastReloadAt`, `configLastError`.
Compare it with the config file when a node appears to "ignore" a change; `dshlink doctor` does that
automatically (`node:config`, `node:version`, `node:hot-reload`). The server re-reads the config file
before every request (throttled to 1 s, `--no-reload` disables it), so peers/tokens/shared roots changed
by the CLI take effect immediately.

## Message envelope

```json
{
  "id": "msg_01m28...",
  "ts": "2026-09-11T10:42:18.112Z",
  "from": { "nodeId": "node_...", "name": "alice-pc", "url": "http://127.0.0.1:8787" },
  "to": "bob-pc",
  "thread": "msg_01m28...",
  "replyTo": null,
  "kind": "message",
  "subject": "hi",
  "body": "hello",
  "attachments": [
    { "name": "note.txt", "size": 14, "sha256": "...", "encoding": "base64", "contentBase64": "..." }
  ]
}
```

Delivery semantics:

1. **push** — sender POSTs to the recipient node (direct peer, or through a relay hub).
2. **queue** — if unreachable, the message stays in the sender's outbox with
   `delivery.state = "pending"`; `flush` retries, `--auto-sync <s>` retries periodically.
3. **pull (sync)** — the receiver calls `GET /api/v1/outbox?to=<me>` on the sender and merges
   by message id (idempotent), which covers "sender could not reach me at all".
4. **relay** — a node that receives a message addressed to a name it knows forwards it and
   records `via`.

## MCP endpoint (`POST /mcp`)

MCP streamable HTTP, JSON-RPC 2.0, protocol versions 2025-11-25 / 2025-06-18 / 2025-03-26 /
2024-11-05 / 2024-10-07 (the client's requested version is echoed when supported).
Batch requests are answered as a batch; notifications get `202 Accepted`.
`GET /mcp` → 405 (no server-initiated stream); `DELETE /mcp` ends a session.
Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list` (empty),
`prompts/list` (empty). Tool names: `link_status`, `link_peers`, `link_send_message`,
`link_inbox`, `link_read_message`, `link_reply`, `link_sync`, `link_flush`,
`link_list_files`, `link_stat_file`, `link_pull_file`, `link_push_file`,
`link_dsh_workspaces`, `link_dsh_sessions`, `link_dsh_transcript`, `link_call`, `link_help`.

## DSH view API (v0.3, read-only, off by default)

Serves the workspaces and conversations of the DSH installation this node belongs to, read
straight from disk (no DSH process required). Enabled with `dsh.enabled`; transcripts need
`dsh.exposeTranscripts`.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/dsh/workspaces` | `{ home, count, workspaces: [ { id, title, path, sessions, lastActivityAt } ] }` |
| GET | `/api/v1/dsh/sessions?workspace=&includeArchived=1&query=&limit=` | `{ count, sessions: [ { sessionId, workspaceId, title, titleSource, cwd, createdAt, updatedAt, sizeBytes, archived, messages, messagesExact } ] }` |
| GET | `/api/v1/dsh/sessions/:id` | `{ session }` |
| GET | `/api/v1/dsh/sessions/:id/transcript?limit=&offset=&tail=1` | `{ session, total, messages: [ { seq, time, role, kind, text, tool, truncated } ], truncated, corruptFrames }` |
| GET | `/api/v1/dsh/capabilities` | `{ enabled, methods, catalog, bridge, queue }` |

`messages` counts inside a session summary are a **lower bound** unless `messagesExact` is true
(the index only scans the head of each log); `transcript().total` is exact.
Sessions are located in `$DSH_HOME/sessions/<slug>/session-<uuid>/session.v3.jsonl.zstd`
(concatenated zstd frames, JSONL inside) and grouped by the `storages/workspace.json` registry.

## Capability channel (v0.3, off by default)

Peer → node → local bridge plugin (inside DSH) → DSH Host services, and back:

| Method | Path | Who calls it |
|---|---|---|
| POST | `/api/v1/dsh/call` `{ method, params, waitSeconds }` | a peer (or the local agent) |
| GET | `/api/v1/dsh/call/:id` | anyone with a token (poll a queued command) |
| GET | `/api/v1/bridge/commands?limit=` | **loopback only** — the bridge claims work |
| POST | `/api/v1/bridge/commands/:id/result` `{ ok, result }` / `{ ok:false, error }` | **loopback only** |
| POST | `/api/v1/bridge/heartbeat` `{ version, capabilities, sessions, at }` | **loopback only** |
| GET | `/api/v1/bridge/status` | **loopback only** |

Methods: `workspaces.list`, `sessions.list`, `sessions.read` (read) and `sessions.create`,
`sessions.prompt`, `sessions.rename`, `sessions.archive` (actions, opt-in per node and per peer),
plus `bridge.status`.

Queue semantics: one command per file under `<dataDir>/commands/<id>.json`; claiming creates
`<id>.claim` with `O_EXCL` so exactly one bridge runs a command (a claim older than
`capabilities.claimStaleSeconds` may be taken over); terminal states are immutable; non-terminal
commands expire after `commandTtlSeconds`; results are clipped to `maxResultBytes`; at most
`maxPending` commands wait at once. Every call is audited (`dsh_call`, `bridge_result`).

## Virtual `workspaces` file root (v0.3)

`files.roots[].kind = "workspaces"` makes one root span every DSH workspace: the first path
segment is a workspace id (or title slug), the rest is a path inside it —
`allws:<workspace-id>/src/index.mjs`. `files.deny` still applies, writes need `write: true` and
`files.allowUpload = true`. GET `/api/v1/files?root=allws` lists the workspaces themselves.

## File sandbox rules

1. Every path is root-relative; absolute paths and `..` segments are rejected.
2. The deepest existing ancestor is `realpath`-ed so symlinks/junctions cannot escape the root.
3. Deny globs (default: `.env*`, `.credentials.yaml`, `.ssh/**`, `id_rsa*`, `*.pem`, `*.key`,
   `*.pfx`, `*.p12`, `credentials.json`) are matched against the relative path and basename.
4. Writes additionally require `files.allowUpload = true` and a root with `write: true`;
   writes are atomic (temp file + rename).
5. Downloads carry a SHA-256 header; the client re-hashes the received bytes and reports
   `verified: false` on mismatch.
