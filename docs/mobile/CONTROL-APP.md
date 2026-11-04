# dsh-link control app (Android) — implementation notes

Status: **implemented, v0.1.1** (shipped with the dsh-link 0.6.2 tree; the app is versioned
independently from the node).
This document records what the app in [`android/`](../../android/) actually does, which node APIs
it depends on, how it was verified, and what is deliberately left out. The research that led here —
options A/B/C, effort estimates, the 0.5 security prerequisites and the mobile-sync design review —
stays in [`../MOBILE-CONTROL-FEASIBILITY.md`](../MOBILE-CONTROL-FEASIBILITY.md) and
[`API-SKETCH.md`](API-SKETCH.md).

The app is a **controller**, not a node: it never joins the dsh-link mesh, never accepts inbound
connections, and has no outbox/inbox of its own. It authenticates to one existing node with an
ordinary inbound token and uses that node's DSH view + capability channel.

## 0. Screenshots

| Connected | Sessions of one workspace | Transcript + composer |
|---|---|---|
| ![main](screenshots/main.png) | ![sessions](screenshots/sessions.png) | ![transcript](screenshots/transcript.png) |

All shots come from the x86_64 API 36.1 emulator talking to the real node
(`alice-pc`, dsh-link 0.6.2) through a `device` token over its LAN address
(`192.0.2.100:8787`); the token field is masked by Android. The transcript shot shows the final answer (`#17 · DSH`) from the real DSH agent plus the
composer; the same-seq de-duplication fix that keeps such a row after its reasoning sibling is
covered in section 4.

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
- **One node per install.** URL + token are stored in one place; there is no node picker. The app is
  a personal remote control, not a multi-tenant console.

## 2. API surface used

| Step | Request | Notes |
|---|---|---|
| Connect | `GET /api/v1/info` | checks `dsh.workspaces`, `capabilities.enabled/methods`; `version` shown in UI |
| Workspaces | `GET /api/v1/dsh/workspaces` | sorted by `lastActivityAt` server-side |
| Sessions | `GET /api/v1/dsh/sessions?workspace=<id>&includeArchived=0|1&limit=300` | archived hidden by default |
| Snapshot | `GET /api/v1/dsh/sessions/{id}/transcript?tail=1&limit=200` | `latestSeq` becomes the cursor |
| Incremental | `GET …/transcript?sinceSeq=<n>&limit=200` | filtered to `seq > n`; returns new `latestSeq` |
| Older | `GET …/transcript?tail=1&offset=<loaded>&limit=200` | prepended, de-duplicated by row identity |
| Send | `POST /api/v1/dsh/call` body `{method:"sessions.prompt", params:{sessionId,text,mode?}, waitSeconds:20}` | `mode:"steer"` when "插话" is checked; omitted = queue |
| Command result | `GET /api/v1/dsh/call/{commandId}` | poll every 700 ms up to 120 s for pending commands |

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
  "auth": { "trustLocalhost": false }
}
```

`sessions.prompt` is an **action** method and is not in the 0.3 default allow-list; it must be added
explicitly. Without it the app still browses and shows "只读模式". The command queue needs the bridge
plugin running inside a live DSH host; otherwise commands expire after
`capabilities.commandTtlSeconds` (default 120 s).

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

The node test suite is unchanged by the app release (`node test/run.mjs`: 166 tests, 165 pass,
1 skipped for the missing frp binary).

The app is a debug-signed APK; release signing, versionCode management and Play distribution are
out of scope for this repo.

## 5. Security notes

- **Transport**: cleartext HTTP is allowed because the intended deployment is LAN or a VPN
  (Tailscale/WireGuard). For any internet path, terminate TLS in a reverse proxy (Caddy/Nginx) or
  keep the node off the public internet. The node's own STCP visitor listens on the node's
  `127.0.0.1` only and is **not** reachable from a phone.
- **Token storage**: `SharedPreferences` (app-private, not encrypted at rest). Use a short
  `--ttl-days`, revoke with `dshlink token rm --id <id>` if the phone is lost.
- **Capability scope**: the node's `capabilities.methods` (and optional per-peer `peers` policy)
  is the real limit on what a phone can do; the token role only gates the HTTP surface.
- **No message plane**: the app cannot read or send dsh-link messages, so a stolen phone does not
  expose the peer network or the bridge control plane.
- **No background presence**: the node cannot tell whether the app is running; there is no
  heartbeat or device management endpoint (B-phase item).

## 6. Known gaps / next steps (B phase)

- SSE or long-poll endpoint (`/api/v1/dsh/sessions/{id}/events`) for true push and fewer requests;
  this is the main missing node feature.
- Device-scoped token management API (create/list/revoke from the phone, last-used metadata).
- Multi-node profiles and a node picker.
- Attachments / file browse (needs `files` roots and an upload UI).
- Session actions beyond prompt (create/rename/archive) and command cancellation.
- Encrypted token storage (Android Keystore) and certificate pinning for reverse-proxy TLS.
