# dsh-link control app (Android) — implementation notes

Status: **implemented, v0.4.0** (shipped with the dsh-link 0.8.0 tree; the app is versioned
independently from the node). v0.2.0 added an optional built-in **STCP tunnel**; v0.3.0 made the
app a network-aware controller: it discovers the dsh-link network from the node it connects to,
lets the user pick any **directly-connected** node and browse/control that node's DSH through the
gateway relay, labels subagent Sessions, and folds consecutive tool-call/tool-result rows into one
expandable transcript line. The tunnel lands on the token-checking 8788 gateway instead of the
node's localhost-trust path. v0.4.0 adds the **hub entry**: when the URL points at a hub
(`role:"hub"`) the app treats it as a central server, lists its enrolled nodes in the same
"控制节点" dropdown, and relays every DSH call to the selected node with `peer=<node>`; the node
entry (0.7 single node) still works unchanged from the same APK.
This document records what the app in [`android/`](../../android/) actually does, which node APIs
it depends on, how it was verified, and what is deliberately left out. The research that led here —
options A/B/C, effort estimates, the 0.5 security prerequisites and the mobile-sync design review —
stays in [`../MOBILE-CONTROL-FEASIBILITY.md`](../MOBILE-CONTROL-FEASIBILITY.md) and
[`API-SKETCH.md`](API-SKETCH.md).

The app is a **controller**, not a node: it never joins the dsh-link mesh, never accepts inbound
connections, and has no outbox/inbox of its own. It authenticates to one existing node with an
ordinary inbound token and uses that node's DSH view + capability channel.

## 0. Screenshots

Screenshots are deliberately **not committed**: they show real host names, a LAN address and real
Session titles. Local copies stay under `test/.tmp/` (git-ignored), taken on the x86_64 API 36.1
emulator talking to the real node (`alice-pc`, dsh-link 0.7.0) with a `device` token (the token
field is masked by Android). What they showed, and therefore what was verified:

- **Connected over LAN** (`http://192.0.2.100:8787`): status `已连接 · 11 个工作区 ·
  alice-pc · 可发送`, summary `节点 alice-pc · dsh-link 0.7.0 · 网络 2 个节点 · 2 可达`, plus
  the "控制节点" dropdown.
- **Sessions of one workspace**: `共 8 个会话（3 个子智能体）` with the `子智能体 ·` prefix on the
  three subagent Sessions.
- **Transcript with an expanded tool group**: `#414 · 工具调用 · 2 条 · 10:38:46 · 点击收起`
  showing its tool-call and tool-result bodies (collapsed default is `点击展开`).
- **0.3.0 gateway tunnel** (phone on a 5G network, no LAN/VPN route to the node): the URL field is
  disabled and reads `http://127.0.0.1:18788`; the app started the bundled `frpc` visitor itself,
  and every request travelled phone → frps `203.0.113.10:16443` → the node's `dshlink-phone` STCP
  provider → the **8788 gateway** (token required) → `127.0.0.1:8787`. A transcript shot after a
  remote send contains the earlier `TUNNEL_OK` exchange and the v0.3.0 remote send `REMOTE_OK`.
  See sections 1 and 4.

## 1. Architecture

```text
┌────────────────────── phone (Android 8+) ──────────────────────┐
│ MainActivity ── ApiClient ── HttpURLConnection (Bearer token)  │
│   │  node URL + device token (SharedPreferences)              │
│   ├─ WorkspaceAdapter   GET /api/v1/dsh/workspaces             │
│   └─ SessionListActivity (GET /api/v1/dsh/sessions)            │
│        └─ SessionActivity                                       │
│             ├─ GET …/transcript?tail=1 (initial 200 rows)      │
│             ├─ GET …/transcript?sinceSeq=N (2.5 s foreground)  │
│             ├─ GET …/transcript?tail=1&offset=K (load older)   │
│             └─ POST /api/v1/dsh/call (sessions.prompt)         │
│                  └─ GET /api/v1/dsh/call/{id} (poll to terminal)│
└────────────────────────────────────────────────────────────────┘
                                │ HTTP(S) + token
                                ▼
        dsh-link node (dsh.enabled + capabilities.methods
        include sessions.prompt; bridge plugin running inside DSH)
```

Network discovery + remote control (0.3.0). The app has no mesh membership of its own; it asks the
node it connects to for that node's peer graph and relays DSH calls through the node API:

```text
GET /api/v1/network/nodes?depth=2&maxNodes=50        (self + each directly connected node)
   └─ node picker: direct node selected → the same DSH APIs with &peer=<node name>
        GET /api/v1/dsh/workspaces?peer=…           (relayed by the entry node)
        POST /api/v1/dsh/call {peer:…, method:"sessions.prompt", params:{…}}
```

Nodes reached only through another node (`via` non-empty) are shown but cannot be selected by the
app; this keeps the relay to a single hop and avoids the entry node silently becoming a proxy for
the whole mesh. The peer re-checks its own `capabilities` allowlist.

Hub entry (0.4.0). The URL may point at a hub instead of a node; the mode is detected from
`GET /api/v1/info` (`role:"hub"`, `software:"dsh-link-hub"`, or an `info.nodes[]` table):

```text
GET /api/v1/info                                (detect: hub vs node)
GET /api/v1/network/nodes?depth=1               (hub: enrolled nodes, fallback info.nodes[])
   └─ node picker: any online enrolled node selected
        GET /api/v1/dsh/info?peer=<node>         (forwarded by hub to that node's node API)
        GET /api/v1/dsh/workspaces?peer=<node>
        GET /api/v1/dsh/sessions?peer=<node>&workspace=…
        GET /api/v1/dsh/sessions/<id>/transcript?peer=<node>&sinceSeq=…
        POST /api/v1/dsh/call {peer:<node>, method:"sessions.prompt", params:{sessionId,text,mode}}
        GET /api/v1/dsh/call/<commandId>?peer=<node>   (poll to done; hub forwards to that node)
```

The hub is the only entry; the selected node never needs to be reachable from the phone. The app
also accepts `device`-role tokens there — a hub never trusts localhost and always requires a token.
The status line reads `NODE（经 HUB）`, and the summary shows the hub name/version and node counts.

Optional built-in STCP tunnel (0.2.0; retargeted to the 8788 gateway in 0.3.0), used when the phone
has no LAN/VPN route to the node:

```text
phone app ──HTTP──► 127.0.0.1:18788 (bundled frpc visitor, inside the app)
                              │  STCP over TLS + frps auth token
                              ▼
                    frps 203.0.113.10:16443
                              │  STCP
                              ▼
        node's frpc provider dshlink-phone (published by "dshlink tunnel sync")
                              │  localPort 8788
                              ▼
        node 127.0.0.1:8788 token gateway ──► 127.0.0.1:8787 node API
```

The app copies the bundled `frpc` (a `lib/<abi>/libfrpc.so` native library, so Android 10+ may
execute it), its TLS client certs and a `frpc.toml` visitor config into app-private storage, starts
it, then connects to `http://127.0.0.1:18788`. The frps config, client certs and STCP secret are
compiled into the APK — see the security note in section 5. The gateway requires the device token on
every request and never trusts the loopback source address, so the STCP path no longer bypasses
dsh-link auth. No inbound port is opened on the node; the STCP provider is generated by the node's
own tunnel configuration.

Deliberate choices:

- **Foreground-only polling.** No Service, no WorkManager, no startup receiver. Work happens in
  `onStart`…`onStop`; leaving the screen stops all traffic. This matches the user's requirement
  "平常不运行时不传输数据" without needing a background scheduler or push infrastructure.
- **Pull, not push.** The node has no SSE/WebSocket endpoint (0.4/0.5); the app uses the monotonic
  `seq` cursor instead. Push/SSE remains the B-phase enhancement in the feasibility study.
- **Snapshot + cursor.** First transcript call requests `tail=1&limit=200` and records
  `latestSeq`; subsequent calls send `sinceSeq=<lastSeq>`, so a reconnect or a poll gap never
  re-sends the whole conversation. `seq` can be null for some rendered rows; the app only advances
  the cursor on rows that have a numeric seq. De-duplication is by **row identity**
  (`seq + role + kind + text hash`), not by seq alone: one durable event can render as several
  rows (reasoning, tool call, final answer), and those rows share the same seq.
- **No dependencies.** Java + platform APIs only (org.json, HttpURLConnection, ListView). The build
  uses SDK command-line tools directly; see `android/build-apk.ps1`. This keeps the app buildable
  offline and reviewable in a repo that promises zero runtime dependencies.
- **One entry node, many controllable nodes (0.3.0).** URL + token still describe the entry node, but
  the app lists the nodes that entry node can see and switches the `peer` parameter to control a
  directly-connected one. Only one URL/token pair is stored: the peer is reached with the entry
  node's credentials and the peer enforces its own policy.
- **Tool groups fold (0.3.0).** Consecutive `tool-call`/`tool-result` rows render as one header
  (`#seq · 工具调用 · N 条 · HH:mm:ss · 点击展开/收起`); tapping it reveals each row's tool name and
  body. This keeps long agent transcripts readable without hiding data from the user.
- **Subagent Sessions are labelled (0.3.0).** Session rows with `origin:"subagent"`, a parent or a
  delegation depth show the prefix `子智能体 ·` plus parent/depth; the workspace line counts them.
- **Optional built-in relay (0.2.0, gateway path since 0.3.0).** Android cannot run a desktop frpc,
  so the APK packages `frpc` as a native library for x86_64 and arm64-v8a. Checking
  "通过阿里云 STCP 中转至 8788 网关" starts that visitor as a child process, waits for
  `http://127.0.0.1:18788/healthz`, then points the normal `ApiClient` at it; unchecking (or leaving
  the screen) stops the child. This is deliberately self-use only: the APK contains the relay
  credentials (section 5).

## 2. API surface used

| Step | Request | Notes |
|---|---|---|
| Connect | `GET /api/v1/info` | checks `dsh.workspaces`, `capabilities.enabled/methods`; `version` shown in UI |
| Network | `GET /api/v1/network/nodes?depth=2&maxNodes=50` | optional (0.7+); a 404/error falls back to single-node mode |
| Workspaces | `GET /api/v1/dsh/workspaces` | sorted by `lastActivityAt` server-side; `&peer=<node>` when controlling a direct peer |
| Sessions | `GET /api/v1/dsh/sessions?workspace=<id>&includeArchived=0|1&limit=300` | archived hidden by default |
| Snapshot | `GET /api/v1/dsh/sessions/{id}/transcript?tail=1&limit=200` | `latestSeq` becomes the cursor |
| Incremental | `GET …/transcript?sinceSeq=<n>&limit=200` | filtered to `seq > n`; returns new `latestSeq` |
| Older | `GET …/transcript?tail=1&offset=<loaded>&limit=200` | prepended, de-duplicated by row identity |
| Send | `POST /api/v1/dsh/call` body `{method:"sessions.prompt", params:{sessionId,text,mode?}, waitSeconds:20}` | `mode:"steer"` when "插话" is checked; omitted = queue; adds `peer:<node>` for a remote node |
| Command result | `GET /api/v1/dsh/call/{commandId}` | poll every 700 ms up to 120 s for pending commands (local entry node only) |

When a **remote** (relayed) node is selected, every DSH request gets `peer=<node name>` and the
entry node forwards it to that peer over the dsh-link peer channel; the peer re-checks its own
`capabilities` allowlist and returns the same shapes. For a remote send the app shows "已提交 · 由
<node> 处理" instead of polling `/dsh/call/{id}`, because the command id lives on the peer.

Auth is `Authorization: Bearer <token>` on every request except `/healthz` (which the app only
uses indirectly). Error bodies are `{ error: { code, message } }`; the app maps the important codes
(`unauthorized`, `role_forbidden`, `capability_denied`, `dsh_*`, `too_many_requests`,
`too_many_failures`) to actionable Chinese messages instead of dumping raw JSON.

## 3. Roles and node prerequisites

The recommended token is a **`device`** token:

```powershell
node bin\dshlink.mjs token new --label phone --role device --ttl-days 30 --json
```

The 0.5 role matrix gives it `GET /api/v1/dsh/*` and `POST /api/v1/dsh/call` (subject to the
capability policy), and denies messages, peers, audit and the `/api/v1/bridge/*` control plane.
It does **not** grant message/file/admin features, so a phone compromise is limited to "read the DSH
view + submit allowed capability calls" — which is exactly the controller's job.

Node configuration:

```json
{
  "dsh": { "enabled": true, "home": "<DSH_HOME>", "exposeWorkspaces": true, "exposeTranscripts": true },
  "capabilities": {
    "enabled": true,
    "methods": ["workspaces.list", "sessions.list", "sessions.read", "sessions.prompt"]
  },
  "auth": { "trustLocalhost": false },
  "gateway": {
    "enabled": true,
    "bind": "127.0.0.1",
    "port": 8788,
    "upstream": "http://127.0.0.1:8787",
    "provider": { "name": "dshlink-phone", "secretKey": "<STCP secret>" }
  },
  "peers": [ { "name": "OTHER-NODE", "url": "http://...", "token": "..." } ]
}
```

`sessions.prompt` is an **action** method and is not in the 0.3 default allow-list; it must be added
explicitly. Without it the app still browses and shows "只读模式". The command queue needs the bridge
plugin running inside a live DSH host; otherwise commands expire after
`capabilities.commandTtlSeconds` (default 120 s). Remote control needs the entry node to have the
target node in `peers`; network discovery walks the same `peers` graph.

For the built-in STCP tunnel (0.3.0) the node publishes a **second STCP provider** that points at
the gateway port, not the plain API port: `dshlink tunnel sync` generates the provider from
`gateway.provider` (name `dshlink-phone`, secret key, `localPort 8788`) whenever
`gateway.enabled` and a secret are configured. The gateway requires a dsh-link token on every
request and never falls back to `trustLocalhost`, so STCP traffic that arrives from `127.0.0.1`
can no longer ride the localhost rule; the node still derives the device role from the forwarded
token (visible in the audit log). This is the production-shaped path for a phone that lives on the
public internet without a VPN.

## 4. Verification

What was checked (2026-11-03, dsh-link 0.6.0 tree, Android SDK 36):

1. **Build**: `android/build-apk.ps1 -Sdk D:\AndroidSdk` exits 0; APK ~37.6 KB.
2. **Package metadata**: `aapt2 dump badging` — `package dev.dshlink.control`,
   `versionCode 1`, `versionName 0.1.0`, `minSdkVersion 26`, `targetSdkVersion 36`,
   `INTERNET` permission, launcher `MainActivity`.
3. **Signature**: `apksigner verify --print-certs` passes (debug key).
4. **API contract** (`test/mobile-contract.test.mjs`, runs when `DSH_HOME` is set):
   info → workspaces → sessions → transcript snapshot → `sinceSeq` increment → queue a
   `sessions.prompt` → claim/complete it as a fake bridge → result lookup; plus the device-token
   boundary (allowed DSH endpoints, denied messages/admin/bridge).
5. **Emulator smoke test** (x86_64 API 36.1 image, `adb install -r` + `am start`):
   - connect with a `device` token → "已连接 · 11 个工作区 · 可发送", workspace/session lists render;
   - populated session → "共 N 条" + `#seq · kind · HH:mm:ss` rows; the emulator run caught a
     real bug where `time` (epoch ms from `dshview.mjs`) was sliced as an ISO string and rendered
     raw milliseconds — fixed in `MessageAdapter.headerOf` (Number → `Ui.clock`, String → ISO slice);
   - send in queue mode and with "插话" checked; both commands were claimed and completed by a
     simulated bridge on the node's loopback channel, and the app showed "已发送". The claimed
     params were `{sessionId, text}` for queue and `{sessionId, text, mode:"steer"}` for steer;
   - read-only gating: removing `sessions.prompt` from `capabilities.methods` and reconnecting made
     the app show the "只读模式" warning and disable the composer/hint as designed;
   - no crash in `logcat` during any of the above.

0.1.1 re-verification (2026-11-04, dsh-link 0.6.2 tree, Android 16 / API 36 emulator, real node
`alice-pc`):

1. **Build metadata**: `versionCode 2`, `versionName 0.1.1`; APK 37,580 bytes; debug signature
   still verifies.
2. **Edge-to-edge accessibility fix**: API 36 forces edge-to-edge even with a Material
   `DarkActionBar` theme, so the heading, the session-list refresh button and the session status /
   steer row were drawn underneath the ActionBar and were not tappable. `Ui.applyEdgeToEdgePadding`
   now pads the content root by the status-bar inset plus `actionBarSize` (and by the IME inset on
   the session screen); every control's uiautomator bounds is inside the visible area and the
   refresh button actually re-fetches (a newly created session appeared).
3. **Real end-to-end send**: with a `device` token, opening `session-1aa41492…` and sending with
   "插话" checked made the node claim and complete `sessions.prompt {mode:"steer"}`; the real DSH
   agent answered in the transcript (`seq 17`: reasoning + `OK — phone↔peer e2e probe 已收到并回复，链路正常。`).
   This replaces the simulated-bridge send check from 0.1.0.
4. **Same-seq rendering fix**: the earlier app de-duplicated rows by `seq`, so the second row of
   `seq 17` was dropped and only the reasoning was visible. Rows are now keyed by
   `seq + role + kind + text hash`; both rows render and the cursor still advances by `latestSeq`.
5. **IME**: with the keyboard open the steer checkbox, composer and send button stay above the
   keyboard (session screen uses the IME inset); no crash in `logcat`.

0.2.0 verification (2026-11-04, dsh-link 0.6.2 tree, Android 16 / API 36 x86_64 emulator, real
node over the Aliyun relay; the phone side had **no** LAN/VPN route to the node):

1. **Build**: `dshlink-control-0.2.0-debug.apk` is 11,981,929 bytes; `versionCode 3`,
   `versionName 0.2.0`, `extractNativeLibs=true`; entries `assets/tunnel/{frpc.toml,ca.crt,
   client.crt,client.key}` and `lib/{x86_64,arm64-v8a}/libfrpc.so` all use forward slashes; debug
   signature verifies.
2. **Tunnel start**: checking the tunnel box and connecting logged
   `starting …/lib/x86_64/libfrpc.so -c …/files/tunnel/frpc.toml` followed by
   `tunnel is healthy on port 18788` about 50 ms later; `ps -A` showed the `libfrpc.so` child. The
   UI showed "已连接 · 11 个工作区 · 可发送", node `alice-pc · dsh-link 0.6.2`, with the
   URL field disabled at `http://127.0.0.1:18788`.
3. **Cross-internet send**: opening `[phone-e2e] 短回复` (`session-1aa41492…`) and sending
   `phone tunnel e2e: reply with the single word TUNNEL_OK` produced `#37 · 用户`, `#39 · 思考`,
   `#39 · DSH` = `TUNNEL_OK` in the real transcript. This is the full phone → frps → node provider →
   8787 path; the node did not open any new public port.
4. **Failure path**: when the visitor cannot start (bad binary/relay unreachable) the app reports
   "中转启动失败" with the tail of the frpc log instead of hanging or pretending to connect.
5. **Real-phone arm64 (2026-11-04)**: the user installed the arm64 APK on a real phone, connected
   through the Aliyun relay, listed workspaces and sessions, and sent a message into an existing DSH
   Session; the node audit recorded that `sessions.prompt` command
   (`cmd_01m6k11b50303a94cfc1c6`, 10:17:54Z). The arm64-v8a frpc inside the APK is therefore
   verified executable end-to-end. Note that, with the node's `trustLocalhost: true`, the audit
   labels these STCP requests as localhost/admin rather than by the device token; closing that
   bypass is the production-hardening item in section 5.

0.3.0 verification (2026-11-04, dsh-link 0.7.0 tree, Android 16 / API 36 x86_64 emulator, real
node `alice-pc`; the node was restarted on 0.7.0 with the 8788 gateway enabled and a
`dshlink-phone` STCP provider):

1. **Build**: `dshlink-control-0.3.0-debug.apk` is 11,986,025 bytes, `versionCode 4`,
   `versionName 0.3.0`; debug signature verifies. The tunnel asset now points at the
   `dshlink-phone` provider (port 8788), and `TunnelManager.healthy()` treats any HTTP response
   (including the gateway's 401 for a tokenless probe) as "visitor is up" instead of requiring 200.
2. **Gateway path**: through the built-in tunnel the app connected with a `device` token and showed
   "已连接 · 11 个工作区 · alice-pc · 可发送", summary
   "节点 alice-pc · dsh-link 0.7.0 · 网络 2 个节点 · 2 可达". The 8788 gateway rejects
   unauthenticated requests (401), allows `device` on `/api/v1/info`, `/api/v1/dsh/*` and
   `/api/v1/network/*`, and denies `/api/v1/peers` and `/mcp` (403); see `docs/GATEWAY.md` and
   `test/gateway.test.mjs`. A LAN connection to `http://192.0.2.100:8787` also works.
3. **Network discovery + picker**: connecting to the test node `NODE-A-TEST` (8797) whose peer graph
   includes `alice-pc` produced 2 nodes in the picker; selecting the direct peer showed
   "控制 alice-pc（经 NODE-A-TEST 中转）" and loaded its 11 workspaces, 8 Sessions
   (3 subagents) and a 223-row transcript through the relay. Two-hop nodes are shown but rejected
   with an explanation.
4. **Remote send**: opening `session-1aa41492…` through the relay and sending
   `remote e2e from NODE-A: reply REMOTE_OK` produced `#46 · 用户`, `#47 · 用户`, `#49 · DSH` =
   `REMOTE_OK`; the entry node forwarded `POST /api/v1/dsh/call {peer:…}` and the peer's bridge
   claimed/completed it.
5. **Subagent labels**: the workspace line reads "共 8 个会话（3 个子智能体）"; three rows show the
   "子智能体 ·" prefix with parent/depth. This caught a real bug: `JSONObject.optString(key, fallback)`
   returns the string `"null"` for `JSONObject.NULL`, so every parentless Session counted as a
   subagent (8/8) and tool rows rendered `tool: null`. Fixed by `Ui.text(object, key)` (null-safe)
   used by all adapters.
6. **Tool folding**: consecutive tool-call/tool-result rows render as
   `#414 · 工具调用 · 2 条 · 10:38:46 · 点击展开` with the tool name in the collapsed body; tapping
   toggles to "点击收起" and shows the tool-call JSON and tool-result body (verified with a
   uiautomator dump, not just a screenshot).
7. **No crash** in `logcat` during any of the above.

0.4.0 verification (2026-11-04, dsh-link 0.8.0 tree, Android 16 / API 36 x86_64 emulator,
real hub harness `src/hub.mjs` on `127.0.0.1:18790` with one enrolled node and a fake bridge —
the STCP-to-hub path was emulated with `adb reverse tcp:18790`):

1. **Build**: `dshlink-control-0.4.0-debug.apk` is 11,990,118 bytes, `versionCode 5`,
   `versionName 0.4.0`, SHA-256 `71D3516AD4ED23BE832661B197EC4AB537D739F9187A06CC66A2E46415398F08`;
   debug signature verifies. `minSdk 26`, `targetSdk 36`.
2. **Hub detection**: `GET /api/v1/info` returns `role:"hub"` → hub mode: status
   "已连接 · 12 个工作区 · NODE-ANDROID · 可发送", summary
   "中心服务器 HUB-ANDROID · dsh-link-hub 0.7.0 · 1 个节点 · 1 在线 · 当前 NODE-ANDROID",
   node dropdown "NODE-ANDROID（在线）". Workspace/session/transcript requests went through the
   hub with `peer=<node>`.
3. **Hub send**: `POST /api/v1/dsh/call {peer:"NODE-ANDROID", method:"sessions.prompt",
   params:{sessionId,text,mode}}` → polling `GET /api/v1/dsh/call/{id}?peer=…` reached `done`;
   the hub logged `[bridge] completed sessions.prompt cmd_01m6k86fxz5b3b93e337d4` and the app
   showed "已发送".
4. **Edges**: an empty hub shows "还没有登记节点" + enroll hint; before the offline threshold a
   node request returns 502 `upstream_unreachable` as an inline warning (no modal), after it the
   dropdown marks "（离线）" and reads are skipped; a wrong token shows a 401 explanation;
   `logcat -b crash` stayed empty (no FATAL).
5. **Compatibility**: the same APK connected to the real 0.7 node `http://192.0.2.38:8787`
   still used single-node mode (11 workspaces, sending allowed).
6. **Limits recorded**: one APK embeds one STCP visitor template, so the hub path needs the hub
   visitor template rendered into `assets/tunnel/` (no repo command yet) — the e2e used
   `adb reverse`; the optional running badge from design §5.8 was not built. Send params follow
   the repo contract `{sessionId,text,mode}` (queue|steer), not content blocks.

Real hub + real node (2026-11-05, dsh-link 0.8.1 tree, APK 0.4.0, same Android 16 emulator). The
app was re-pointed at a production hub instead of a harness: `hub serve` on
`http://127.0.0.1:8790` publishing the `dshlink-hub` STCP provider over the Aliyun frps, with the
real node `DESKTOP-NODE-A` enrolled (visitor port 19111) and running in hub mode. The phone
path was again `adb reverse tcp:8790 tcp:8790` because the APK still embeds only the node visitor
template:

- Login with a hub `device` token → status "已连接 · 11 个工作区 · DESKTOP-NODE-A · 可发送",
  summary "中心服务器 DESKTOP-HUB-A · dsh-link-hub 0.8.0 · 1 个节点 · 1 在线 · 当前
  DESKTOP-NODE-A", dropdown "DESKTOP-NODE-A（在线）"; workspace list loaded through the
  hub with `peer=`.
- `dsh-link` session list read "共 10 个会话（5 个子智能体） · DESKTOP-NODE-A · 进入后才会
  拉取消息"; transcript for `session-1aa41492…` read "共 21 条 · DESKTOP-NODE-A（经
  DESKTOP-HUB-A） · 每 2.5 秒仅在前台刷新" and refreshed incrementally.
- A steer message ("hub e2e probe: reply HUB_OK") reached the real DSH Session through
  phone → hub(8790) → node STCP visitor(19111) → bridge (`seq 58` user, `seq 64` assistant
  `HUB_OK`); the reply appeared in the app. Hub audit is admin-only, so the device token sees 403
  there (expected).
- Screenshots (not committed, they show real names): `test/.tmp/hub-main-2.png`,
  `test/.tmp/hub-sessions-2.png`, `test/.tmp/hub-transcript-bottom.png`.

The node test suite at this release: `node test/run.mjs` — see the root README for the current
count (frp/MCP tests skip automatically when their binaries/SDK are missing).

The app is a debug-signed APK; release signing, versionCode management and Play distribution are
out of scope for this repo.

## 5. Security notes

- **Transport**: cleartext HTTP is allowed because the intended deployment is LAN or a VPN
  (Tailscale/WireGuard), or the built-in STCP tunnel (TLS + frps auth token on the phone↔frps hop;
  plain HTTP only inside the phone's own loopback and the node's own loopback). Since 0.3.0 the
  tunnel lands on the token-checking gateway, so the STCP secret is not by itself enough to reach
  the node API. For any other internet path, terminate TLS in a reverse proxy (Caddy/Nginx) or keep
  the node off the public internet.
- **Bundled relay credentials (0.2.0/0.3.0)**: the APK embeds the frps auth token, the mTLS client
  certificate/key and the STCP `secretKey`. Anyone with the APK can reach the gateway port, but the
  gateway still requires a device token on every request. Treat the APK as a private build: do not
  upload it to a store or public link, and if it leaks rotate the frps token, re-issue the client
  certificate, change the STCP secret and revoke the device token.
- **The gateway closes the trustLocalhost bypass.** STCP requests arrive at the node from
  `127.0.0.1`, which would satisfy `auth.trustLocalhost`; the 0.3.0 tunnel therefore points at
  8788, where every request must present a token and loopback is never trusted. The gateway also
  denies `/mcp` and `/api/v1/bridge/*` for every role and limits `device` to info/healthz/dsh/
  network. The plain 8787 listener still honors `trustLocalhost` for the local CLI/bridge, so do
  not expose 8787 itself to the internet or to the relay.
- **Token storage**: `SharedPreferences` (app-private, not encrypted at rest). Use a short
  `--ttl-days`, revoke with `dshlink token rm --id <id>` if the phone is lost.
- **Capability scope**: the node's `capabilities.methods` (and optional per-peer `peers` policy)
  is the real limit on what a phone can do; the token role only gates the HTTP surface.
- **No message plane**: the app cannot read or send dsh-link messages, so a stolen phone does not
  expose the peer network or the bridge control plane.
- **No background presence**: the node cannot tell whether the app is running; there is no
  heartbeat or device management endpoint (B-phase item).

## 6. Known gaps / next steps (B phase)

- **Hub-mode STCP template**: the app can already control a hub over plain HTTP/relay, but the
  bundled visitor template still targets the node's `dshlink-phone` provider (8788); shipping the
  hub path needs a `dshlink-hub` visitor template (bindPort 18789) rendered into
  `android/app/src/main/assets/tunnel/frpc.toml` before building, and a real phone test.
- SSE or long-poll endpoint (`/api/v1/dsh/sessions/{id}/events`) for true push and fewer requests;
  this is the main missing node feature.
- Device-scoped token management API (create/list/revoke from the phone, last-used metadata).
- Multi-node *profiles* (several entry nodes) — 0.3.0 can switch between the entry node's direct
  peers but stores only one URL/token pair, and nodes reached through another node remain
  view-only.
- Attachments / file browse (needs `files` roots and an upload UI).
- Session actions beyond prompt (create/rename/archive) and command cancellation.
- Encrypted token storage (Android Keystore) and certificate pinning for reverse-proxy TLS.
- Gateway hardening: per-device rate limits and an audit view for token use (the node currently
  applies its normal limits, and audit records the derived role).
- Keep the bundled frpc current (and provide 16 KB-page-size-aligned builds) or load it from a
  separately updatable location instead of rebuilding the APK.
