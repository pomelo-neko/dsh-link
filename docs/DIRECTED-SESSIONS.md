# Directed conversations: talking to a specific Session (0.4)

dsh-link 0.3 could already carry messages between machines, and the bridge could answer the
conversation that asked. What it could not do was let **the sender choose which conversation on the
other machine should receive the message**: every inbound message without a local route landed in
the bridge's own topic-pool workspace (`D:\dshlink-bridge`), and both ends ended up talking through
their bridge sessions instead of through the conversations the humans actually use.

0.4 adds **directed conversations**: an envelope may name the DSH Session it is addressed to, the
sender's Session is carried along so that replies can be aimed back, and the bridge turns those two
ids into a real end-to-end conversation between two named Sessions.

## What is new

| Piece | Where | What it does |
|---|---|---|
| `targetSession` envelope field | `src/ops.mjs` `buildMessage` | The receiving DSH Session id (optional, ≤200 chars). |
| `originSession` envelope field | `src/ops.mjs` `buildMessage` | The sending DSH Session id (optional, informational, ≤200 chars). |
| thread → Session binding | `src/store.mjs` (`bindings.json`), `src/ops.mjs` `bindSession` | Remembers which local Session owns a thread, so later sends on that thread fill `originSession` automatically. |
| `POST/GET /api/v1/bridge/bind` | `src/server.mjs` | Loopback-only endpoint the bridge uses to write/read a binding. |
| `targetSession` / `originSession` tool args | `src/mcp.mjs` `link_send_message` | Any DSH agent can address a peer Session. |
| automatic reply addressing | `src/mcp.mjs` `link_reply` | `targetSession` defaults to the answered message's `originSession`. |
| `--target-session`, `--origin-session`, `bind` | `bin/dshlink.mjs` | Same from the CLI. |
| `targets` delivery policy | `integrations/dsh-link-bridge/lib/targets.js` | Decides whether a named local Session may be woken by a peer, and by which peers. |
| directed delivery | `integrations/dsh-link-bridge/lib/index.js` | Plans inbound messages by delivery target, prompts the named Session, binds the thread and registers a route. |

Everything is additive. **Old peers that do not send `targetSession` keep working exactly as in
0.3** (messages fall through to route/topic pool), and a new node accepts envelopes from old peers
(it just stores the unknown-in-0.3 fields). One side may upgrade first.

## Message flow

Two humans work in ordinary conversations. `A`'s conversation asks `B`'s conversation a question and
the exchange continues for as many turns as needed:

```
A machine                                   B machine
─────────                                   ─────────
session-a1 (human conversation)
  link_send_message
    peer: B, body: "..."
    targetSession: "session-b1"   ──────────►  inbox message with targetSession
                                                bridge: targets policy allows session-b1
                                                → prompt lands IN session-b1
                                                  (no bridge session is created)
                                                  thread → session-b1 binding written
                                                  route thread → session-b1 registered
session-a1  ◄────────── reply ──────────────  session-b1 calls link_reply
  bridge: no target? route by thread/replyTo     targetSession defaults to
  → prompt lands IN session-a1                   message.originSession = "session-a1"
  (originSession came from A's binding)
  ... repeat: both sides now address each other's conversation by id ...
```

Key point: after the first directed exchange, the bridge has a binding **and** a route for the
thread on both machines, so neither side needs to re-specify the id for the rest of the
conversation — `link_reply` (and `dshlink reply`) reuse `originSession`, and the planner falls back to
the thread route when a message does not carry a target.

## Wire format

```json
{
  "id": "msg_01m2…",
  "ts": "2026-11-02T12:00:00.000Z",
  "from": { "nodeId": "node_…", "name": "alice-pc", "url": "http://127.0.0.1:8787" },
  "to": "bob-pc",
  "thread": "msg_01m2…",
  "replyTo": null,
  "kind": "message",
  "subject": "请继续排查",
  "body": "……",
  "attachments": [],
  "targetSession": "session-5f0c…",
  "originSession": "session-a1c9…"
}
```

* Both fields are optional and clamped to 200 characters at build time.
* They are first-class envelope fields, not `meta`. The bridge also accepts `message.meta.targetSession`
  as a compatibility fallback for hand-written envelopes.
* Relays, store, and imports copy the fields untouched (records are spread unchanged), so a
  targeted message survives A → hub → B and the offline sync path.
* `sendMessage` fills `originSession` from the local thread binding when the caller omits it:
  `record.originSession ??= (await store.getBinding(record.thread))?.sessionId ?? null`.

### Bindings

`<dataDir>/bindings.json` is a small JSON map `thread → { thread, sessionId, peer, updatedAt }`,
capped at 500 entries (oldest `updatedAt` dropped first), written atomically. It is not a message
TTL: a binding stays until overwritten by another session sending on the same thread.

```powershell
# read a binding
Invoke-RestMethod 'http://127.0.0.1:8787/api/v1/bridge/bind?thread=msg_abc'
# write one (what the bridge does before prompting a session)
Invoke-RestMethod -Method Post 'http://127.0.0.1:8787/api/v1/bridge/bind' -ContentType application/json `
  -Body '{"thread":"msg_abc","sessionId":"session-5f0c","peer":"bob-pc"}'
```

Both endpoints live on the **bridge control plane**: since 0.5 they accept only the local process
(loopback with `trustLocalhost`, or any local role) or a `role: bridge` token. A remote `admin`
token gets 403 `bridge_forbidden`; bindings describe this machine's own Sessions and are never
part of the peer API.

## Using it

### From an agent (MCP)

```jsonc
// first message of a directed conversation
{ "name": "link_send_message", "arguments": {
    "peer": "bob-pc",
    "subject": "构建失败",
    "body": "请帮我看一下这条错误……",
    "targetSession": "session-5f0c…"        // the peer's Session, e.g. from link_dsh_sessions
} }

// the peer answers with link_reply: targetSession is filled from originSession automatically
{ "name": "link_reply", "arguments": { "id": "msg_…", "body": "…" } }
```

To discover the peer's sessions first: `link_dsh_workspaces {peer}` →
`link_dsh_sessions {peer, workspace}` → use the `sessionId` of the conversation you want.

`link_reply` defaults: `targetSession = args.targetSession ?? parent.originSession`,
`originSession = args.originSession ?? parent.targetSession` (so a reply also tells the peer which of
its sessions this is answering). Explicit arguments always win.

### From the CLI

```powershell
dshlink send --to bob-pc --subject hi --body "…" `
  --target-session session-5f0c --thread msg_abc
dshlink send --to bob-pc --body "reply" --thread msg_abc --reply-to msg_abc
dshlink bind --thread msg_abc --session session-a1c9     # remember the local side of a thread
dshlink bind --thread msg_abc                              # show the binding
```

`send` fills `originSession` from the binding of the thread it is sending on; an explicit
`--origin-session` wins.

### From code / another node

```js
await ops.sendMessage({ to: 'bob-pc', body: 'hi', targetSession: 'session-…', originSession: 'session-…' });
await ops.bindSession({ thread, sessionId, peer });   // loopback bridge API is a thin wrapper
await ops.binding({ thread });
```

## Bridge delivery policy (`targets`)

The bridge must not let any token-holding peer inject work into an arbitrary local Session, so
directed delivery is gated. Defaults are **on, open** (matching the bridge's existing "any
configured peer may wake a session" posture); tighten them for real deployments.

```yaml
targets:
  enabled: true          # false = ignore targetSession entirely (0.3 behaviour)
  peers: []              # glob list of peer names; empty = any configured peer
  allow: []              # glob list of Session ids; empty = any local Session
  deny: []               # glob list; always wins over allow
```

* Session ids: `/^[A-Za-z0-9._:-]{1,200}$/` (the canonical `session-<uuid>` form, plus bare uuids).
* Patterns support `*`, `?`, `**`, case-insensitive; `deny` beats `allow`; when both lists are
  empty the channel is **open** (`targets.open: true` appears in `state.json` and in the startup log).
* Examples:

```yaml
targets: { peers: ["LAPTOP-*"], allow: ["session-5f0c*"] }   # one peer, one session family
targets: { deny: ["session-*"], allow: ["session-public"] }  # only the public session
targets: { enabled: false }                                   # off: everything goes to route/pool
```

Delivery precedence for each inbound message:

1. **direct** — `targetSession` exists, policy allows it, and the Session is not dead → prompt that
   Session. The thread is bound to it and a route is registered so later messages can find it again.
2. **route** — an existing `thread` (or `replyTo`) route points at a live local Session → prompt it.
3. **topic** — otherwise the topic pool decides (0.3 behaviour, bridge workspace).

When a target is refused or unavailable the message is **not dropped**: the bridge renders the
reason into `{{targetNote}}` and delivers through the route/topic path, so the conversation still
continues in a bridge session. Rejections/fallbacks are counted in `state.directed` /
`state.lastDirected` (absent when not directed) and visible in the prompt text.

### Prompt template additions

The default template now includes `{{targetNote}}` (empty, or the fallback explanation) and can use
`{{delivery}}` (`direct` | `route` | `topic`), `{{targetSession}}` and `{{originSession}}`.
Custom templates that do not use them keep working.

## Queue vs steer

DSH's `SessionController.prompt` takes a `mode`: `queue` appends a turn, `steer` hands the content to
the session at its next step boundary (interject). 0.4 uses both:

| Wake-up | Mode | Why |
|---|---|---|
| directed (`targetSession`) | `steer` | a peer replying into a live conversation should land like a person interjecting, not wait behind a long tool loop |
| route (reply on a thread a local Session started) | `steer` | same: it is a reply inside an ongoing exchange |
| topic batch | `queue` | unrelated notifications should not interrupt; they accumulate as the next turn |

The bridge setting `promptMode` overrides the table: `auto` (default) chooses per delivery as above,
`queue` forces every wake-up to queue, `steer` forces every wake-up to steer. The resolved value is
written to `state.json` as `promptMode`.

The capability channel exposes the same DSH field: `sessions.prompt` accepts an optional `mode`
(`"queue"` default, `"steer"` to interject), so
`link_call {method:"sessions.prompt", params:{sessionId, text, mode:"steer"}}` interrupts a peer's
running conversation instead of appending a turn. It still requires `capabilities.enabled` and an
explicit method allow-list on the target node.

The loop guard is independent of the mode: thread cooldowns and wake budgets still apply to steered
wake-ups.

## Compatibility matrix

| Sender | Receiver | Result |
|---|---|---|
| 0.4 with `targetSession` | 0.4 | Directed delivery (or documented fallback) |
| 0.4 without target | 0.4 | Route / topic pool, same as 0.3 |
| 0.3 | 0.4 | Route / topic pool (no target to direct) |
| 0.4 | 0.3 | The field is stored but ignored; bridge uses the topic pool |
| CLI `dshlink send` | 0.4 | Directed, but no `originSession` unless `--origin-session` is passed (CLI has no Session) |

## Failure modes

| Situation | Behaviour |
|---|---|
| Named Session id unknown on the peer | `sessionController.prompt` fails "unknown session" → the session is marked dead, its routes are forgotten, the watermark is not advanced, and the next tick falls back to route/topic (the message is not lost). |
| Target refused by `targets` | Delivered via route/topic with the reason in the prompt and `{{targetNote}}`. |
| Session already archived/dead | Same fallback; dead ids are remembered for this process run. |
| Peer has no binding for a thread | Its reply simply has no `originSession`; the receiver's thread route still replies to the conversation (if one asked there). |
| Bridge restarted | Bindings persist in `bindings.json`; routes persist in `state.json`; watermark prevents double wakes. |
| Both bridges auto-answering each other | The 0.3 loop guard still applies to directed wakes: `threadCooldownSeconds` (soft hold) and `maxThreadWakes`/`threadWindowSeconds` + `maxWakesPerHour` (hard drops), recorded in `state.suppressed`. |

## Security notes

* A directed message still only carries an **id**. The receiving bridge never lets a peer pick an
  arbitrary process or run a command: it wakes a conversation the way a human would type into it.
* The effective trust boundary is: *whoever holds the node's inbound token and has `targets` access
  can inject a prompt into any allowed local Session of their choosing.* Set `targets.peers` and
  `targets.allow` for any node reachable by untrusted peers, and remember that the existing
  capability channel (`sessions.prompt` as an action) can already do much more when enabled.
* Bindings are loopback-only and hold Session ids, not message content. They are stored next to
  `state.json` in the node data dir (protect that directory like `state.json`/`config.json`).
* Directed delivery goes through the same `message_received` audit entry as any other message.

## Tests

`node test/run.mjs` covers this feature with:

* `test/bridge-targets.test.mjs` — policy normalization, target resolution (field vs `meta`),
  peer glob/allow/deny gates, summary.
* `test/directed.test.mjs` — envelope round-trip over HTTP, bind endpoint (loopback, round-trip,
  missing thread), automatic `originSession` from a binding.
* `test/bridge.test.mjs` — directed wake + thread binding + `state.directed`, refused-target
  fallback with explanation, two targets in one batch, explicit target beating a route, and the
  `promptMode` matrix (auto: direct/route `steer`, topic `queue`; forced `queue`/`steer`).
* `test/bridge-commands.test.mjs` — `sessions.prompt` `mode` pass-through, default `queue`, and
  rejection of values other than `queue`/`steer`.
* `test/mcp.test.mjs` — `link_send_message` field pass-through, `originSession` from a binding,
  and `link_reply` addressing the answered message's `originSession`.
* `test/dsh-access.test.mjs` — the transcript HTTP endpoint forwards `sinceSeq` and returns
  `latestSeq`/`sinceSeq` (incremental polling).

## See also

* [`docs/PROTOCOL.md`](PROTOCOL.md) — envelope and bridge bind API.
* [`docs/DSH-INTEGRATION.md`](DSH-INTEGRATION.md) — MCP/CLI/bridge setup.
* [`docs/SECURITY-AUDIT.md`](SECURITY-AUDIT.md) — why a loopback-forwarded connection is trusted, and how to harden before exposing directed delivery.
* [`integrations/dsh-link-bridge/README.md`](../integrations/dsh-link-bridge/README.md) — bridge
  configuration, state file, loop guard.
