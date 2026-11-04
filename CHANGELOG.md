# Changelog

All notable changes to **dsh-link**. Two artefacts are released together and carry their own
version: the node/CLI (`package.json`) and the DSH Host plugin
(`integrations/dsh-link-bridge/package.json`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.1] — 2026-11-04

The "keep the conversation after a reboot" patch. Ask-and-answer routes were lost on every
bridge/Host restart, which showed up as a peer's reply opening a brand-new bridge Session instead
of returning to the conversation that started the thread (observed in the 0.6.0 upgrade thread:
the reply landed in `session-5a0f4db8…` rather than the Session that asked).

### Fixed

- **Routes survive a bridge restart.** The heartbeat writes the raw route table as `routeTable` and a
  human-readable summary as `routes`, but the loader assigned `saved.routes` to the runtime table.
  Every restart therefore replaced the table with the summary, `sweepRoutes` discarded its keys as
  malformed, and the next reply in an existing thread fell into the topic pool. The loader now
  restores `routeTable` and still accepts the older shape where the raw table lived under `routes`.
- **Thread bindings are a second routing fallback.** When a thread has no in-memory route (for
  example right after a restart), the bridge asks the node
  (`GET /api/v1/bridge/bind?thread=…`; `bindings.json` survives both node and Host restarts) and
  prompts the bound Session, re-registering the route. Topic-pool threads are excluded so their
  rotation/idle policy keeps deciding when a topic moves to a fresh Session, and a refused/absent
  target still falls back as before.
- A binding hit is reported as `delivery: "binding"`, `routed`/`lastRoute.matched: "binding"` and a
  note in the prompt, so the wake is diagnosable from `state.json` and the transcript.

### Changed

- Bridge version `0.6.1` (the node `package.json` follows the release); no node API change.
- `test/bridge.test.mjs` adds two regressions: a restart restores the route table, and a thread
  without a route is routed by the node binding.

## [0.6.0] — 2026-11-03

The "control it from the phone" release. Ships the first Android controller app on top of the
0.5.0-hardened node. The app is a *controller*, not a node: it never joins the mesh, has no
inbox/outbox, and only uses the node's DSH view plus the capability channel (a `device` token).

### Added

- **Android control app (`android/`).** Native Java app (minSdk 26, targetSdk 36, no Gradle or
  AndroidX dependencies) that connects to one dsh-link node, lists its DSH workspaces and sessions,
  follows a conversation with a snapshot + `sinceSeq` cursor while the screen is in the foreground,
  and sends messages with `sessions.prompt` over `POST /api/v1/dsh/call` (optional `mode: "steer"`).
  Built with the SDK command-line tools via `android/build-apk.ps1`; see `android/README.md`.
- **`test/mobile-contract.test.mjs`.** Pins the exact node API contract the app depends on
  (info → workspaces → sessions → transcript snapshot/increment → capability call → result) and the
  `device` token boundary; runs when `DSH_HOME` points at a DSH installation.
- `docs/mobile/CONTROL-APP.md`: implementation notes, API mapping, verification and the B-phase gap
  list (SSE, device-token management, multi-node); screenshots under `docs/mobile/screenshots/`.

### Fixed

- **App transcript timestamps.** The node's transcript `time` field is epoch milliseconds, but the
  message row formatted it as an ISO string and displayed raw milliseconds (e.g.
  `#1313 · 工具调用 · 1793721695734`). It now formats numbers with `HH:mm:ss` and still accepts ISO
  strings if a future node returns them. Caught during the emulator smoke test.

### Changed

- **The `device` role is documented precisely.** A device token may read the DSH view *and* submit
  capability calls allowed by `capabilities.methods` (that is how the phone sends messages); it
  still has no access to messages, files, peers, audit or the bridge control plane. The 0.5.0 notes
  described it as a read-only viewer, which is only true for the message/control planes.
- Root `README`/`README.zh-CN` and the docs index now cover the Android app; the feasibility study
  is marked as implemented for phase A.
- The bridge plugin reports version `0.6.0` so a node, its bridge and the app can be matched by
  release; no bridge behaviour changed in this release.
- `scripts/deploy-sync.mjs` ignores `android/dist/` (SDK build output) so a deploy never copies
  classes/dex into the deployed node tree.

## [0.5.0] — 2026-11-03

The "harden the node" release. Fixes the two findings of the 0.4.0 security audit (F1: a loopback
forwarder made every API call token-free; F2: one static token had full control and no device scope)
and adds the controls a phone controller needs before it can be exposed.

### Security

- **`auth.trustLocalhost` now defaults to `false`.** Tokens generated by `dshlink init`, pairing and
  `dshlink token new` are required from every client, including this machine, the MCP server and the
  bridge. A config that explicitly sets `true` keeps the old behaviour (and `dshlink doctor` fails it).
  This closes the frp/STCP hole where a remote visitor arrived as `127.0.0.1` and could call the whole
  API without a token.
- **Token roles and scope.** Inbound tokens carry `role` (`admin` | `bridge` | `peer` | `device`), an
  optional bound peer identity and an optional `expiresAt`; a token without a role keeps full admin
  compatibility. Every route now has an allow-list: `peer` tokens can exchange messages (their own
  only), `device` tokens are read-only DSH viewers, `bridge` tokens own the loopback control plane,
  and `/peers`, `/status`, `/audit` and MCP require `admin`. Mismatches are audited and return
  `403 role_forbidden`.
- **The bridge control plane is no longer reachable by a remote admin token.** `/api/v1/bridge/*`
  accepts the local process (loopback with a role token or `trustLocalhost`) or a `bridge` token only;
  remote admin tokens get `403 bridge_forbidden`. Mint a bridge token with `dshlink token new --role bridge`.
- **Peer identity is enforced.** A `peer` token bound to `peer:<name>` cannot forge `from.name`
  (`403 identity_mismatch`), can only read its own traffic (`not_your_message` / `not_your_traffic`),
  and cannot relay to a third node (`403 relay_not_allowed`). Peer setup can be given a dedicated
  token so both sides know which identity a request belongs to.
- **Token expiry and rotation.** `dshlink token new --role ... --peer ... --ttl-days N`; `token list`
  shows `ROLE` / `PEER` / `EXPIRES`; `dshlink invite --role --peer` embeds a scoped token. Expired
  tokens are rejected at authentication time.
- **Rate limiting.** `limits.maxRequestsPerMinute` (default `1200`, `0` disables) counts requests per
  token id (or per IP before authentication) in a 60 s window; excess requests get `429`,
  `Retry-After: 60` and `code: too_many_requests`. The existing auth-failure throttle is unchanged.
- **`dshlink harden`.** One command turns `trustLocalhost` off, mints the MCP/CLI admin token and a
  dedicated bridge token, warns about peers without a scoped token and prints the matching
  `dshlink install-dsh --token ... --bridge-token ...` command. `--json` for automation, `--write`
  to persist.
- **`install-dsh --token/--bridge-token`.** The generated DSH patch now writes the MCP
  `headers.authorization` and the bridge plugin's `token`, so a hardened node keeps its own MCP and
  auto-wake working without `trustLocalhost`.
- **`dshlink doctor` security checks.** `trust-localhost` (FAIL when on), `rate-limit`,
  `bind-exposure` and a token-audit summary with legacy-token warnings; HTTP probes can authenticate
  with `--token` / `DSHLINK_TOKEN`.
- **Capability channel origin.** Queued commands record the caller's `role` and token id;
  `dshlink dsh call` cross-peer forwarding and result lookup are admin-only, and a non-admin can read
  only the commands it issued.

### Added

- `src/server.mjs`: role matrix (`ALL_ROLES` / `READ_ROLES` / `DSH_ROLES` / `BRIDGE_ROLES`),
  `boundPeer()` identity checks, sliding-window rate limiter, `Retry-After` on 429.
- `src/config.mjs`: `TOKEN_ROLES`, `normalizeTokenRole()`, expiry normalization, `createInboundToken`
  options, `verifyToken()` returning role/peer/expiry.
- `test/auth.test.mjs` — 8 tests covering defaults, the role matrix, expiry, peer binding, rate
  limiting, bridge tokens and `install-dsh --token`.
- Docs: `docs/SECURITY-AUDIT.md` updated with the 0.5.0 status and residual risks,
  `SECURITY.md` harden runbook, `docs/PROTOCOL.md` role matrix,
  `docs/DSH-INTEGRATION.md` MCP/bridge token wiring.

### Changed

- `dshlink token list` / `new` and `dshlink invite` gained `--role`, `--peer` and `--ttl-days`.
- `dshlink doctor` takes `--token` and reports token roles; `install-dsh` takes `--token` and
  `--bridge-token`.
- The bridge plugin version is `0.5.0`; it still works with an unauthenticated loopback node, but a
  hardened node requires the bridge token in its config.

### Migration from 0.4.0

1. `dshlink harden --write` — turns off `trustLocalhost`, prints the new admin and bridge tokens.
2. `dshlink install-dsh --write --token <admin-token> [--bridge --bridge-token <bridge-token>]`.
3. Restart the node and the DSH host; run `dshlink doctor --token <admin-token>`.
4. For a remote peer, mint `dshlink token new --role peer --peer <their-name>` and give that node the
   token; keep the peer token only in that peer's config (never in a browser or phone app).

## [0.4.0] — 2026-11-02

The "talk to a specific conversation" release.

### Added

- **Directed conversations.** A peer message can name the DSH Session that should receive it
  (`targetSession`), and the sender can identify its own Session (`originSession`). The bridge
  delivers such a message straight into that Session — one prompt per target, in arrival order —
  and persists the thread→Session binding through the node (`POST /api/v1/bridge/bind`).
  `link_reply` / `dshlink reply` default the answer's `targetSession` to the original message's
  `originSession`, so two DSH instances can hold a multi-round conversation between two chosen
  conversations instead of two bridge pools. Policy: `targets.enabled` / `peers` / `allow` /
  `deny` glob lists; a refused or missing target falls back to the route/topic Session with the
  reason written into the prompt, and the local route is still registered so follow-ups without
  `targetSession` land in the same Session.
- **Steering wake-ups.** The bridge now chooses DSH's `SessionPromptRequest.mode` per delivery:
  directed and route wake-ups use `steer` (interject at the target Session's next step boundary),
  while topic batches keep `queue` (append a turn), so a peer reply lands like a person interjecting
  instead of waiting behind a long tool loop. `promptMode: auto|queue|steer` overrides the split;
  the resolved mode is in `state.json` and the startup log. The capability channel's
  `sessions.prompt` accepts the same optional `mode` (`queue` default) and validates it.
- **Incremental transcripts.** `GET /api/v1/dsh/sessions/:id/transcript` accepts `sinceSeq` and
  returns `latestSeq` + the applied `sinceSeq`, so a client can poll for changes and fetch only the
  new messages without re-reading the log or negotiating a freeze position. Exposed in the
  `link_dsh_transcript` MCP tool and as `dshlink dsh transcript --since-seq N`.
- `dshlink send --target-session/--origin-session`, `dshlink bind --thread <id> [--session <id>]`,
  and the two fields in `dshlink show`; the MCP tools `link_send_message` / `link_reply` gained
  the matching arguments (and `link_reply` reuses `originSession` automatically).
- [`docs/DIRECTED-SESSIONS.md`](docs/DIRECTED-SESSIONS.md) — design, two-machine
  conversation flow, authorization model, fallbacks and troubleshooting.
- `scripts/deploy-sync.mjs` — the repository and the tree DSH actually runs
  (`<DSH_HOME>/plugins/vendored/dsh-link`) drift apart silently; `--check` classifies every file
  (missing / different / stale / local to the machine) and exits non-zero on drift, `--apply --write`
  copies the difference with a per-file backup. Machine-local files (node config, vendored frp
  binaries, `*.local.*`) are never compared, copied or deleted. The tool prints the restart it
  implies instead of restarting anything.
- The bridge now answers a peer's reply back into the conversation that asked: a thread a local
  Session sent on is remembered (`routes`, filled from the DSH Host `tools/result` event, so no new
  tool argument and no agent cooperation is needed) and the reply is prompted straight into that
  Session instead of the topic pool. Missing sessions expire/fall back to the pool;
  `routes.enabled: false` restores the old behaviour.
- `scripts/gen-secrets.mjs` — generate the three credentials a deployment needs (frp `auth.token`,
  STCP `secretKey`, dsh-link inbound token + its sha256) without openssl, printing ready-to-paste
  config snippets; `--count`, `--name`, `--json`.
- `scripts/gen-certs.sh` / `scripts/gen-certs.ps1` — create a CA, a server certificate and
  per-machine client certificates for frp mTLS (`--clients`, `--days`; the PowerShell twin finds
  openssl through git when it is not on PATH). Verified with a real mutual-TLS handshake.
- [`docs/FRP.md`](docs/FRP.md) §2.3 "STCP 模式注意事项" — the caveats that actually bite: the
  `secretKey` is the boundary (not the token), `user`/`allowUsers` pairing, one visitor port per
  peer, TCP-only, `start = [...]` whitelist trap, WSL2 `localIP`, paired rotation — plus §7 on
  generating tokens and certificates.
- [`AIGC-Notice.md`](AIGC-Notice.md) — the repository is entirely AI-generated and maintained.

### Fixed

- **DSH 0.2.0 compatibility**: `SessionPromptRequest.mode` became a required field. Every bridge
  wake-up now sends a mode (`steer` for directed/route deliveries, `queue` for topic batches) and
  the capability channel defaults to `queue`; verified live against DSH 0.2.0-rc.2 (wake-up,
  ask-and-answer routing and `workspaces.list` all pass).
- **Session-log v4.** Newer DSH writes `session.v4.jsonl.zstd`; the disk-read view only looked for
  `session.v3.jsonl.zstd`, which would make whole conversations vanish from the DSH view after an
  upgrade. It now accepts every `session.vN.jsonl.zstd` and reads the highest generation present.
- The bridge no longer writes `state.json` twice per wake-up. The intermediate write lacked
  `errors`, `notified` and `ticks`, so a reader that polled the file at the wrong moment could
  see a heartbeat without those fields (found by running the suite on Linux).

### Changed

- The bridge registers thread→Session bindings even when `routes.enabled: false`: the binding is
  what lets a later reply carry `originSession`, and it is independent of ask-and-answer routing.
- The bridge `state.json` heartbeat now includes `directed`, `lastDirected`, the normalized
  `targets` policy and `promptMode`, and the startup log prints the directed-session policy and the
  wake mode next to the route one.
- `test/mcp.test.mjs` and `test/reload.test.mjs` skip themselves when no MCP client SDK is
  installed instead of failing; they auto-detect both `@modelcontextprotocol/sdk` 1.x and
  `@modelcontextprotocol/client` 2.x (the one DSH ships), so they run wherever DSH is installed.
- `scripts/verify-vendor.mjs` gained `--platform` and `--strict`; a missing (not yet downloaded)
  frp binary is reported but is not an error unless you ask for `--strict`.
- `scripts/verify-bundle.ps1` requires `-PeerDataDir` explicitly: it mutates that node's data
  directory while testing, so it must not default to a real one.

## [0.3.0] — 2026-09-12

The "see and drive the other machine's DSH" release.

### Added

- **DSH view (read-only, off by default).** The node reads the local DSH registry and session logs
  from disk (`storages/workspace.json` + `sessions/**/session.v3.jsonl.zstd`), so a peer with a
  valid token can list workspaces, list sessions (including archived ones) and read a transcript
  without the DSH host being involved: `dshlink dsh enable|workspaces|sessions|transcript`,
  MCP tools `link_dsh_workspaces` / `link_dsh_sessions` / `link_dsh_transcript`.
- **`allws` virtual file root** (`kind: "workspaces"`): one file root that exposes every DSH
  workspace, addressed as `<workspace id or title>/<relative path>`.
- **Capability channel (off by default).** A peer can ask this machine's bridge to act inside DSH:
  `workspaces.list`, `sessions.list`, `sessions.read`, `sessions.create`, `sessions.prompt`,
  `sessions.rename`, `sessions.archive`. Action methods are never allowed by default; per-peer
  `allow`/deny lists override the node-level list, and every call is audited:
  `dshlink dsh enable --actions ...`, `dshlink dsh call <method>`, MCP tool `link_call`.
- **Bridge topic routing.** One conversation per topic instead of one forever: peers are routed by
  thread/subject, and sessions retire on budget (`maxSessionWakes`), age
  (`maxSessionAgeSeconds`) or idleness (`topicIdleResetSeconds`), with a pool cap
  (`maxPoolSize`). Retired sessions are archived through the DSH workspace registry
  (`archiveIdleSeconds`), so the sidebar stays clean while logs are kept.
- **`dsh.excludeWorkspaces`** so a node never exposes its own data directory or bridge workspace
  through the DSH view.
- **`dshlink doctor` DSH checks**: warns when no explicit `dsh.home` is configured (a service or
  scheduled task has no `DSH_HOME` and would silently fall back to `~/.dsh`), when the transcript
  view is unavailable (Node without zstd), and when the capability channel has no bridge.
- Docs: `docs/DSH-ACCESS.md` (what the switches mean, threat model, recommended combinations),
  `docs/OPERATIONS.md`.

### Changed

- `link_inbox` with `markRead: true` marks **exactly the messages returned by that call**; use
  `unreadOnly: true, markRead: true` to mean "mark everything unread". This makes wake-ups
  idempotent and stops a poll from swallowing a message that arrived mid-call.
- Config hot reload now also covers `dsh` and `capabilities`, and a broken config file no longer
  takes the node down.

## 0.2.2 — 2026-09-12

### Added

- Bridge watermark as a `(timestamp, message id)` tuple (`watermarkTs`/`watermarkId` in
  `state.json`), so two messages written inside the same millisecond cannot make a wake-up
  disappear.
- `selfcheck.mjs` for the bridge: inject a synthetic message and prove the wake-up chain end to end.
- `dshlink tunnel share` prints the STCP provider name + `secretKey`, and
  `dshlink tunnel import` wires the matching visitor on the other machine.

### Fixed

- `frpc` visitor ports occupied by another process are moved to the next free port before start.
- Outbox entries can be dropped explicitly (`dshlink flush --drop`) instead of being retried forever.

## 0.2.1 — 2026-09-11

### Added

- **Config hot reload**: peers, tokens, file roots and limits are re-read before every request, so
  adding a peer to a running node works without a restart (`runtime.configReloads` in
  `/api/v1/status`).
- **Pairing**: `dshlink invite` prints one portable code carrying URLs, the inbound token and the
  STCP share; `dshlink peers accept --invite <code> [--reply]` registers both directions.
- **`dshlink install-dsh`**: writes the MCP entry into a DSH profile patch (preview by default,
  `--write` applies it with a timestamped backup) and installs the agent skill.
- **`dshlink doctor`**: config / HTTP / MCP / peer / tunnel checks with a non-zero exit code when
  something fails.
- Portable bundles: `scripts/build-bundle.ps1` (+ `verify-bundle.ps1`) produce and then really
  exercise `dsh-link-<version>-portable.zip` / `.tar.gz`.

### Changed

- `serve` gained `--auto-sync <seconds>` and `--no-reload`.

## 0.2.0 — 2026-09-11

First packaged version.

### Added

- Node with an HTTP JSON API, a `dshlink` CLI, an MCP streamable-HTTP endpoint (13 `link_*`
  tools) and an `aliyun-mcp.mjs` variant for a relay/cloud setup.
- Messages with offline queueing (`inbox.jsonl` / `outbox.jsonl`), threads, attachments, relay,
  `sync`/`flush`, and per-message delivery state.
- Sandboxed file exchange (`ls`/`pull`/`push`) over explicit roots with realpath checks, a deny
  list and sha256 verification on both ends.
- FRP STCP tunnel management (`tunnel setup|sync|status|share|import|stop|config`) with vendored
  frp v0.71.0 binaries.
- Inbound authentication by token (stored as sha256, optional loopback trust) and an audit log.
- The `dsh-link-bridge` DSH Host plugin: polls the node and wakes a DSH conversation when unread
  messages arrive (`integrations/dsh-link-bridge/`).

[Unreleased]: https://github.com/pomelo-neko/dsh-link/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.6.1
[0.6.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.6.0
[0.5.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.5.0
[0.4.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.4.0
[0.3.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.3.0
