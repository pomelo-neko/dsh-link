# Changelog

All notable changes to **dsh-link**. Two artefacts are released together and carry their own
version: the node/CLI (`package.json`) and the DSH Host plugin
(`integrations/dsh-link-bridge/package.json`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.11.0] — 2026-11-07

"Point the camera at it": a 7 KB connect code is too long to copy by hand and too long for one
QR symbol, so the hub console now plays it as an animated multi-frame QR code and the Android app
can rebuild it with the camera or from a handful of screenshots.

### Added

- **Multi-frame QR connect codes (hub side).** POST /api/v1/hub/phone/qr (admin only) turns a
  dshlink1:/dshlink2: connect code into a sequence of QR matrices (Nayuki qrcodegen, MIT,
  vendored; no runtime dependency). Frames carry dshlinkqr:<index>/<total>:<chunk>; concatenating
  the chunks in index order restores the original ASCII code. Default chunk 900 chars (~8 frames for
  a 7.2 KB tunnel profile), configurable 200..2400, at most 32 frames. The endpoint returns matrices,
  not images, and the audit event stores only frame count/size, never the code.
- **"显示二维码" in the hub console.** Both the 0.10 phone-certificate card and the legacy
  dshlink1 card can render the just-generated code in an overlay canvas, one frame per ~0.9 s,
  with an i/N chip; closing the overlay stops the timer and a new code closes the old overlay.
  Walkthrough: docs/QR-CONNECT.md; screenshot docs/images/hub-qr.png.
- **Android 0.6.2 — scan / import QR frames.** Camera1 preview with ZXing (vendored
  zxing-core-3.5.3.jar, Apache-2.0), plus multi-select image import; QrAssembler tolerates
  out-of-order and repeated frames and shows x/y progress. Assembled text goes through the normal
  ConnectProfile validation, so a QR code does not bypass any check.
- **Portable bundle now stages vendor/qrcodegen.** The QR endpoint is a hub runtime feature
  (src/qr.mjs imports the vendored Nayuki module), and the bundle only copies an explicit path
  allowlist. build-bundle.ps1 now always copies vendor/qrcodegen (even with -NoVendor, which only
  skips the frpc binaries), and test/release.test.mjs guards it. A bundle built without it makes a
  freshly installed hub die at startup with ERR_MODULE_NOT_FOUND.

### Fixed

- **QR detection is not always a plain decode.** ZXing detector can throw NotFoundException on a
  perfectly rendered symbol when the payload/mask combination forms a false finder pattern; decoding
  the same matrix with PURE_BARCODE or after a 90/180/270 degree rotation succeeds. The bundled test
  decoder and the Android scanner therefore retry across four rotations and three hint modes, and
  the round-trip test fails on any undecoded frame instead of silently skipping it.

## [0.10.1] — 2026-11-07

"Pick up the phone": the Android control app can now actually use the per-device mTLS phone path
over a real, internet-facing phone-frps.

### Fixed

- **Android 0.6.1 — tunnel bring-up detection for the mTLS phone gateway.** The app waited for the
  local STCP visitor by calling `http://127.0.0.1:<bindPort>/healthz`. A `dshlink2:` profile points
  that visitor at the phone gateway, which is HTTPS-only (mutual TLS), so the plain-HTTP probe always
  failed and the app aborted with “frpc 未能在 20 秒内建立中转” even though frpc had already logged
  `start visitor success / visitor added [phone-to-hub]`. The probe is now a plain TCP connect to
  the local port, valid for the node gateway, the 8788 token gateway and the mTLS phone gateway
  alike. Verified end-to-end on an API 36 emulator through a real Aliyun-hosted phone-frps
  (emulator → STCP visitor 18790 → phone-frps VPS → hub provider → phone gateway 8791 → hub → node),
  including sending a prompt through the capability channel and receiving the reply in the
  transcript. Evidence: `android/README.md` §7. The generic 0.6.1 APK is built without any
  bundled tunnel credentials.
- The hub control console / `hub phone` CLI work released in 0.10.0 is unchanged; this patch only
  carries the Android-side fix and its documentation.

## [0.10.0] — 2026-11-06

"Trust one phone, not the whole tunnel": the phone control surface no longer shares the
machine-to-machine tunnel credentials. Every phone gets its own client certificate from a local
CA, the hub checks it on every request, and the phone network lives on a separate frps tenant.

### Added

- **B2 — a phone gateway with mutual TLS.** A loopback-only HTTPS listener (`phoneGateway`,
  default `https://127.0.0.1:8791`) terminates TLS on behalf of the hub and proxies only the
  mobile control surface (`/api/v1/info`, `/api/v1/network/*`, `/api/v1/dsh/*`,
  `/api/v1/phone/me`). It verifies a per-phone client certificate on every request and only then
  injects the hub's local device token; the token never reaches the phone and admin/hub routes
  stay unreachable. Revoking one phone is a registry update checked per request, not a
  deployment-wide credential rotation.
- **A hub-owned phone CA.** `hub phone setup` creates `phone-ca/` under the hub data directory
  (CA + gateway server certificate, OpenSSL; `phoneGateway.opensslPath`/`DSHLINK_OPENSSL`).
  `POST /api/v1/phone/bootstrap` issues a client certificate for a phone-generated public key —
  the private key never leaves the phone. Device certificates default to 365 days, the CA to
  10 years, the gateway certificate to 825 days.
- **A one-time `dshlink2:` bootstrap profile.** The connect code pins the gateway CA, carries a
  single-use `pbs_` bootstrap secret and (when configured) the phone-side visitor config for the
  phone frps. First contact is authenticated by the pinned CA, not by a certificate delivered
  over the connection it is meant to protect; from then on the phone uses mTLS.
- **B4 — a dedicated phone frps tenant.** `phoneFrp` renders its own `phone-frpc.toml` (server,
  auth token, mTLS files, STCP provider + `allowUsers`) and manages a detached frpc. The phone
  visitor only reaches the phone gateway; the node/hub frps credentials are not embedded in
  phone codes, so a leaked code is contained to the phone tenant and still needs the one-time
  secret (or a registered certificate) to control anything.
- **Phone control plane.** CLI: `hub phone setup` (enable gateway, create CA, mint the local
  device token, optionally configure the phone frps), `hub phone bootstrap --label …`,
  `hub phone devices`, `hub phone revoke <deviceId|fingerprint>`, `hub phone status`.
  Admin APIs: `GET /api/v1/hub/phone/status`, `GET /api/v1/hub/phones`,
  `POST /api/v1/hub/phones/:id/revoke`, `POST /api/v1/hub/phone/bootstrap`,
  `DELETE /api/v1/hub/phone/bootstrap/:id`. `hub serve` starts the gateway and phone frpc.
- **Hub console phone card (0.10).** `/ui` now shows the phone gateway (HTTPS address, CA
  fingerprint, injected token, phone frps state), the registered phone certificates and the
  one-time bootstraps, and can mint or revoke both. Screenshot and walkthrough:
  `docs/HUB-CONSOLE.md` §3.6 / `docs/images/hub-phone10.png`.
- **Android control app 0.6.0** (`dshlink2:`): generates its keypair locally, enrolls once,
  stores the issued certificate, then talks mTLS only (no device token on the phone). The old
  `dshlink1:` token path remains available for existing installs.
- **`docs/PHONE-SECURITY.md`**: threat model, bootstrap trust chain, setup commands, revocation
  and rotation runbook, limitations. New tests: `test/phone-security.test.mjs` (CA/bootstrap/
  gateway/control plane) and `test/cli-phone.test.mjs`.

### Changed

- New phone onboarding should use the `dshlink2:` / mTLS path; `dshlink hub invite --phone`
  and the `dshlink1:` profile remain supported for old phones but are no longer the recommended
  deployment.
- `phoneGateway.bind` is forced to a loopback address: phones reach the gateway through the
  local STCP visitor, never by exposing the mTLS listener directly.

### Security

- A leaked phone code no longer exposes the hub's frp token, mTLS client key or node-network
  STCP provider. It only contains the pinned CA, a single-use bootstrap secret and the phone
  tenant's visitor credentials.
- Revoked or unknown certificates are refused with `phone_revoked` / `phone_unknown`; a
  bootstrap code is consumed once and rate-limited, and `allowNewDevices`/`maxDevices` cap
  enrollment.

### Fixed

- **Phone registry changes made by the CLI apply to a running hub immediately.** The hub cached
  `phones.json` for its lifetime, so `dshlink hub phone revoke` (or a re-enrollment written by
  another process) was invisible to a running `hub serve` until a restart — the gateway kept
  accepting a revoked certificate. `HubStore` now tracks the file signature and reloads the
  registry when it changed on disk (the same "generated tokens work at once" behaviour added for
  `auth.tokens` in 0.9).

## [0.9.1] — 2026-11-05

### Fixed

- **`dshlink status` no longer reports a phantom hub outage.** One-shot CLI commands build a
  `HubLink` but never start its heartbeat, so the constructor default (`state: "disabled"`) was
  printed even while the running node was online — a user checking `dshlink status` next to
  `GET /api/v1/status` saw contradictory answers. The CLI now marks an unstarted uplink as
  `state: "unknown"` with `snapshot: true` and a note pointing at the running node's
  `/api/v1/status`; `dshlink hub status --node` does the same. Hub mode that is genuinely off still
  reports `disabled`.

## [0.9.0] — 2026-11-05

"Hand it to someone else": the project can now be distributed as a portable bundle that ships the
Android control app, and a phone joins any hub with one connect code — no secrets are baked into
the APK.

### Added

- **Phone connect codes.** `dshlink hub invite --phone` (and the hub console's "手机接入" card,
  backed by `POST /api/v1/hub/phone-invite`) mints a `dshlink1:` code that carries everything a
  phone needs: the entry URL (hub visitor port), a fresh `device` token and — when the hub has
  FRP enabled — the rendered STCP visitor config plus the client certificate. Codes expire
  (default 2 h), each phone gets its own, and a lost phone is revoked with one token. The console
  card takes the phone-reachable hub URL when FRP is off (required) and prefills it from the
  console's own origin when it is opened on a non-loopback address.
- **Android control app 0.5.0** (`android/`): imports a connect code, optional embedded frpc
  tunnel, no bundled tunnel template and no built-in token — the APK itself is safe to hand out.
- **Distribution docs**: `docs/DISTRIBUTION.md` (build a bundle, deploy a hub for other people,
  hand out the APK, upgrade/rollback, security boundaries, release checklist),
  `docs/HUB-CONSOLE.md` §3.5 (phone onboarding), `examples/hub.config.example.json` (sanitized
  hub config with an FRP provider), `examples/README.md` hub section and
  `packaging/README-FIRST.md` hub/APK sections.
- **The bundle ships the APK**: `scripts/build-bundle.ps1` gained `-Apk <path>` / `-NoApk`,
  picks the newest `android/dist/dshlink-control-*.apk` by default, puts it under `apk/` with an
  install README, records `apk` in `BUNDLE-INFO.json` and copies `examples/`, `CHANGELOG.md`,
  `SECURITY.md`, `AIGC-Notice.md` and `README.zh-CN.md`.

### Changed

- Bundle `kind` is now `client+hub` (one archive can run a node or a hub) and `test/` is copied
  without `.tmp`, so scratch data never leaks into a release.
- `scripts/build-bundle.ps1` must keep its UTF-8 BOM (`node scripts/ensure-bom.mjs`): Windows
  PowerShell 5.1 misreads a BOM-less file and the Chinese text breaks the parser.

### Fixed

- **A connect code minted by the CLI was rejected until the hub restarted.** `dshlink hub invite
  --phone` and `hub token new` edit the hub config file from another process, but a running hub
  kept the token list it had loaded at startup, so a freshly minted code failed with
  `401 unauthorized` (the console and HTTP API paths looked fine, which made it look like a bad
  code). The hub now stat-checks its config file before every authenticated request and swaps in
  a newer token list; console-side mints merge with it instead of overwriting it. A code works the
  moment it is generated, no restart.
- **`scripts/verify-bundle.ps1` raced the unpacked node's config hot-reload.** The script paired
  the bundle node and immediately sent it a message, but a node reloads its config file on a 1 s
  poll: the first send could arrive before the freshly minted peer token was in memory and fail
  with `missing or invalid token`. The script now waits (up to 10 s) until the node's API accepts
  the paired token before testing delivery.

## [0.8.1] — 2026-11-05

Real-relay hardening for the hub and a loss-proof enrollment path, found while deploying the hub
against a production frps (0.71.0) and a real node over STCP.

### Fixed

- **Hub frpc config rejected by frp 0.71.** The generated `hub-frpc.toml` wrote `compression` /
  `useEncryption` as bare proxy fields, which frpc refuses with
  `decode proxy ... unknown field "useEncryption"`; they now use the nested
  `transport.useEncryption = true` / `transport.useCompression = false` form for the provider and
  every per-node visitor. The hub's own client certificate is configurable too:
  `hub init --frp-cert/--frp-key/--frp-ca` map to `transport.tls.certFile/keyFile/trustedCaFile`
  (paths normalized to forward slashes for TOML).
- **STCP work connections rejected by frps (`invalid NewWorkConn`).** A hub provider created
  without `auth.additionalScopes = ["HeartBeats", "NewWorkConns"]` registers its proxy, but every
  visitor connection fails; the generated config now always sets that scope.
- **Enrollment response lost when the hub restarts frpc.** `POST /api/v1/hub/enroll` used to
  `await frp.relaunch()` before replying, which tore down the STCP provider carrying the request:
  the node saw `fetch failed` even though the hub had persisted it. The hub now replies first and
  defers the frpc sync by a short timer (`deferFrpSync`); `HubTunnelManager.sync()` only restarts
  frpc when the rendered config actually differs. `approve` / `remove` use the same deferred path.
- **Re-enrollment of an already known node.** A retry (or a reinstall) of the same `nodeId` now
  succeeds instead of `conflict node_exists`: the hub refreshes the provider/downlink credentials,
  reuses the visitor port, rotates the uplink token and reports `reenrolled: true`; a different
  nodeId claiming the same name is still rejected with 409. The node-side `hub enroll` retries the
  request up to 3 times on network/5xx failures (500 ms × attempt backoff), so a lost response can
  recover on its own.

### Changed

- `hub init` accepts `--frp-cert`, `--frp-key`, `--frp-ca` (mutual-TLS files for frps) and
  `--frpc-path`.
- Docs: `docs/HUB-TOPOLOGY-DESIGN.md` §5.10 records the real-frps compatibility and enrollment
  resilience; `docs/TROUBLESHOOTING.md` gains `invalid NewWorkConn` and `enroll: fetch failed`
  entries; `docs/mobile/CONTROL-APP.md` records the first hub-mode end-to-end run against a real
  hub + enrolled node.

## [0.8.0] — 2026-11-04

The "one centre, many nodes" release. dsh-link gains a **hub topology**: a standalone hub process
that nodes enroll into, keeps a durable per-target outbox with heartbeats and retries, and relays
messages, DSH view/capability calls and file transfers between nodes. The hub ships its own web
console, the bridge plugin exposes the hub link in the DSH Web GUI, and the Android app can point at
a hub instead of a node (0.4.0). The old point-to-point setup keeps working while `hub.enabled` is
false.

### Added

- **Hub process (`dshlink hub`).** New `src/hub.mjs`, `src/hubconfig.mjs`, `src/hubstore.mjs`,
  `src/hubfrp.mjs` and `src/hublink.mjs`. `hub init --name --port` writes
  `dshlink-hub.config.json` (admin token, optional FRP provider secret); `hub serve` listens on
  one port (default 8790; the FRP visitor for phones is 18790) with `/healthz`, `/api/v1/*` and the web console at `/ui`. The hub
  never runs DSH and never reads a node's disk: it only relays/queues (D9).
- **Enrollment.** One-time `role:"enroll"` tokens (TTL 2 h, 1 use by default) from
  `dshlink hub token new --role enroll` or the console; `POST /api/v1/hub/enroll` returns the
  node's uplink peer token while the node stores a hub downlink token. Auto-approve is on by
  default (`enrollment.autoApprove=false` gives pending/approve flow), with `maxNodes`, per-minute
  rate limit and token revocation. Node side: `dshlink hub enroll --url --token`,
  `hub status`, `hub reconnect`; nodes appear as pending/active/offline in
  `GET /api/v1/hub/nodes`.
- **Durable hub outbox and heartbeats.** Messages are stored per target and retried every 5 s
  (`retrySeconds`), expire after 7 days (`messageTtlSeconds`), are capped per target
  (`maxPendingPerTarget`), and are delivered at least once with `relay_through_hub`, message-id
  dedupe and an identity check (`identity_mismatch`). Nodes heartbeat every 30 s, are marked
  offline after 90 s (`offlineAfterSeconds`), reconnect with exponential backoff
  (5–60 s) and flush their own queue on reconnect. `hub outbox --pending`, `hub flush`,
  `GET /api/v1/hub/outbox` and the console expose the queue.
- **Relayed DSH and files.** The hub proxies `GET /api/v1/dsh/{info,workspaces,sessions,…}`,
  `GET /api/v1/dsh/call/:id` and `POST /api/v1/dsh/call` with `peer=<node>`, and streams
  file list/stat/hash/download/upload through the target node. The role matrix is
  admin/enroll/device/peer; a node in hub mode delivers only through the hub (no direct peer
  delivery, relay or peer sync) and `GET /api/v1/network/nodes` reports the enrolled table so a
  controller can pick a node. A node's `hub` config block
  (`enabled/url/token/timeoutMs/heartbeatSeconds/reconnect/visitorPort/peersIgnored`) is off by
  default; `dshlink tunnel sync` publishes the node→hub visitor once enrolled and the hub manages
  its own frpc provider/visitors.
- **Hub web console (`/ui`).** A dependency-free single page served by the hub (also `GET /` →
  302): admin-token login, node approval/removal, **enroll-token minting and revocation**, hub
  status, per-target cache retry/drop/flush, running-Session aggregate, whitelisted settings editor
  and recent audit. Admin APIs: `GET /api/v1/hub/config`, `PATCH /api/v1/hub/settings`,
  `GET|POST /api/v1/hub/tokens`, `DELETE /api/v1/hub/tokens/:id`, `POST /api/v1/hub/flush`,
  `POST /api/v1/hub/outbox/:id/retry`, `DELETE /api/v1/hub/outbox/:id`,
  `GET /api/v1/hub/sessions/running`. The page contains no secrets, sends a strict CSP and
  requires the admin token on every API call; verified with 18 headless-Edge/CDP checks (login,
  mint, enroll, pending retry/drop, settings save, revoke, logout, zero JS errors). New
  `docs/HUB-CONSOLE.md` and `docs/images/hub-console.png`; design write-up §5.9 of
  `docs/HUB-TOPOLOGY-DESIGN.md`.
- **Bridge plugin 0.8.0.** The plugin polls the local node for `state.hub`
  (url/state/last heartbeat/error/pending/enrolled) and exposes it through its capability status;
  it registers `GET /api/v1/hub/status` and `POST /api/v1/hub/reconnect` on the DSH web server
  (`ctx.inject(['webServer'])`) and adds a **Settings → dsh-link** panel in the DSH Web GUI with
  hub URL, link state, last heartbeat/error, pending queue and a reconnect button. `sessions.list`
  passes the Host's `running` flag through when reported. `test/bridge-hub.test.mjs` (16 tests).
  The Host routes and panel appear after the DSH Host restarts.
- **Android control app 0.4.0.** When the URL points at a hub (`role:"hub"` in
  `GET /api/v1/info`) the app works as a hub controller: the enrolled nodes come from
  `GET /api/v1/network/nodes`, every DSH read carries `peer=<node>`, prompts go to
  `POST /api/v1/dsh/call {peer, method:"sessions.prompt", params:{sessionId,text,mode}}` and the
  command result is polled with `GET /api/v1/dsh/call/:id?peer=`; offline nodes are marked and
  skipped until refresh. The same APK still connects to a 0.7 node in single-node mode.
  APK `dshlink-control-0.4.0-debug.apk` (`versionCode 5`, 11,990,118 bytes), verified against a
  real `src/hub.mjs` hub on the Android 16 emulator (send reached the node's bridge and returned
  `done`, empty/offline/401 edges and no crash in logcat).
- **CLI, docs and skill.** `dshlink hub` command family (`init/serve/enroll/status/nodes/token/
  outbox/flush/reconnect/revoke`); `docs/HUB-TOPOLOGY-DESIGN.md` (design v2, decisions D1–D13,
  N1–N6); `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/DSH-INTEGRATION.md`,
  `docs/index.md`, both READMEs, the bridge README, the Android README and
  `integrations/dsh-skill/SKILL.md` (files >10 MiB are not sent through the hub unless the user
  explicitly asks, N3).

### Changed

- **Version 0.8.0** for the node/CLI and the bridge plugin; the Android app is 0.4.0.
- **Hub mode is the only channel when enrolled.** With `hub.enabled=true` the node sends
  everything through the hub, refuses peer-relayed inbound messages (`relay_through_hub`), treats
  `sync` as a no-op and logs that `peers` is ignored; disable the hub section to return to the
  0.7 point-to-point behavior.
- `GET /api/v1/network/nodes` on a hub returns the enrolled node table (name/status/latency/
  version) instead of a peer graph; the Android app understands both shapes.
- Health, audit, token and queue commands accept `--data-dir` for hub instances so a hub and a node
  can be inspected side by side.

## [0.7.0] — 2026-11-04

The "see the whole network and control it safely" release. A controller can now discover every
node reachable from the one it connects to, switch between directly-connected nodes, and read/send
in their Sessions; the phone tunnel lands on a token-checking gateway instead of the localhost-trust
path; transcript tool calls fold into expandable groups.

### Added

- **Network discovery (`GET /api/v1/network/nodes`).** A node walks its configured peer graph
  (depth 1–3, 20 nodes / 2.5 s by default) and returns a merged, token-free view:
  `{ self, nodes, count, total, depth, partial, truncated, errors, scannedAt }`. Each node carries
  `name/nodeId/url/version/softwareVersion/reachable/latencyMs/directPeers/via`; a name or URL seen
  through several paths is merged (direct beats relayed), `via` records the first hop, and peer
  tokens are never included. The `device` role may read it and relay DSH view/capability calls to
  a directly configured peer (`?peer=` on the DSH view routes, `peer` in `POST /api/v1/dsh/call`);
  the peer re-checks its own allowlist. New `src/network.mjs`, client/ops/server wiring, and
  `test/network.test.mjs`.
- **Loopback token gateway on 8788.** An opt-in listener (`gateway.enabled`) that requires a valid
  dsh-link token on **every** request and reverse-proxies to the node API. It never falls back to
  `auth.trustLocalhost`, so a phone request that arrives through frp/STCP (source 127.0.0.1) cannot
  ride the localhost rule. It forwards the caller's token so the node still derives the role, denies
  `/mcp` and `/api/v1/bridge/*` for every role, limits `device` to the DSH/info/healthz/network
  surface, and enforces body-size/timeout limits; a configured gateway that cannot listen makes
  `serve` exit with `gateway_listen_failed`. See `docs/GATEWAY.md` and `test/gateway.test.mjs`.
- **Gateway STCP provider generation.** `dshlink tunnel sync` now also publishes the gateway port
  when `gateway.enabled` and `gateway.provider.secretKey` are set: a second STCP provider
  (`gateway.provider.name`, default `dshlink-phone`) points at `gateway.port` (8788) rather than
  the plain API port, so the phone path can only reach the token-checking listener. A provider with
  no secret is never generated. `src/tunnel.mjs`, config normalizer, `test/tunnel.test.mjs`.
- **Gateway verified against a real node.** With `gateway.enabled` on 8788, an unauthenticated
  `GET /healthz` returned 401, a `device` token read `/api/v1/info` (0.7.0) and
  `/api/v1/network/nodes` but got 403 `role_forbidden` on `/api/v1/peers` and 403 on `POST /mcp`,
  and a `sessions.list` call through the gateway was claimed/completed by the bridge and returned
  `done`. The Android app then connected through the generated `dshlink-phone` provider and the
  gateway with a device token (audit: `role: device`).
- **Android control app 0.3.0.** The app now connects, then lists the nodes of the dsh-link network
  it can see (`depth 2`), lets the user pick a directly-connected node and browse/control that
  node's DSH through the gateway relay, labels subagent Sessions (`子智能体 · 父会话 … · 深度 N`),
  and folds consecutive tool-call/tool-result rows into one expandable line
  (`#505 · 工具调用 · 2 条 · 10:39:53 · 点击展开`) so a transcript stays readable. The built-in
  STCP visitor now targets the gateway provider and the handshake requires the device token.
  APK `dshlink-control-0.3.0-debug.apk` (`versionCode 4`, 11,986,025 bytes). Verified end-to-end on
  the Android 16 emulator against the real 0.7.0 node: network scan found 2 nodes, the picker switched
  to the directly-connected node and read its transcript (223 rows) through the relay, a remote send
  was answered `REMOTE_OK`, and the fold row expanded to show the tool-call and tool-result bodies.
- **Android control app 0.2.0 — built-in STCP tunnel.** The app can now reach a node through an
  existing frps relay when the phone has no LAN/VPN route to it: checking "通过阿里云 STCP 中转"
  starts a bundled `frpc` STCP visitor (packaged as `lib/x86_64/libfrpc.so` and
  `lib/arm64-v8a/libfrpc.so`, so Android 10+ may execute it), waits for
  `http://127.0.0.1:18788/healthz`, then points the normal API client at it. No new public port is
  opened on the node; the node's existing STCP provider is reused.
  - APK `dshlink-control-0.2.0-debug.apk` (11,981,929 bytes, `versionCode 3`) embeds the visitor
    config plus frps auth token and mTLS client certificate/key. It is a private self-use build:
    the node sees STCP traffic from `127.0.0.1`, so with `trustLocalhost: true` this path bypasses
    the dsh-link token. Rotate the relay credentials if the APK leaks; a production deployment
    needs a token-checking gateway or client certificates.
  - Verified on Android 16 / API 36 x86_64: app-started frpc became healthy in ~50 ms, connected to
    the real node 0.6.2 over the Aliyun relay, opened `session-1aa41492…`, and sent a prompt that
    the real DSH agent answered `TUNNEL_OK`. Verified again on a real arm64 phone: the user
    connected through the relay, listed workspaces/sessions, and sent a message into an existing DSH
    Session (node audit recorded `sessions.prompt cmd_01m6k11b50303a94cfc1c6`).
  - `android/README.md`, `docs/mobile/CONTROL-APP.md`, READMEs and screenshots updated; the node,
    CLI and bridge are unchanged (still 0.6.2).

### Changed

- **Node/CLI and bridge 0.7.0.** The DSH view exposes subagent provenance
  (`origin/parentSession/delegationDepth/agentPreset`) on every Session meta; the bridge's
  `sessions.create` resolves a `cwd` that names a registered workspace to that workspace id, so a
  controller-created Session is attached instead of landing in DSH's "未分组" bucket. Version bumped
  to 0.7.0 for both artefacts (the bridge change takes effect when the DSH Host restarts).
- **Android control app 0.1.1.** The app is versioned separately from the node; the node/CLI and
  bridge code are unchanged (still 0.6.2).
  - Fixed API 36 edge-to-edge layout: the heading, session-list refresh button, session status row
    and steer checkbox were drawn underneath the ActionBar and could not be tapped. The app now pads
    the content root by the status-bar inset plus `actionBarSize` (and by the IME inset on the
    session screen).
  - De-duplication is now per transcript row (`seq + role + kind + text hash`) instead of per seq.
    One durable event can render as several rows (reasoning, tool call, final answer); the old code
    dropped every row after the first one sharing a seq.
  - Re-verified end-to-end against a real node 0.6.2 with a `device` token: connect → workspaces →
    sessions → transcript snapshot + `sinceSeq` increments → `sessions.prompt {mode:"steer"}`
    answered by the real DSH agent; `docs/mobile/CONTROL-APP.md` / `android/README.md` updated.
    (Screenshots are kept out of the repository: they contain real host names, a LAN address and
    real Session titles.)

### Fixed

- **Controller-created Sessions are grouped.** `sessions.create { cwd }` on a cwd that is a
  registered workspace now sends `workspaceId` (resolved via `workspaceRegistry.resolveByPath`,
  falling back to path comparison with slash/case normalization) instead of `cwd`; otherwise the
  Host created the Session without a workspace and it showed up as 未分组. Unknown directories still
  fall back to `cwd`.
- **App UI state.** The session status line returns to its message count after a send instead of
  staying on "已发送"; transcript dedup is per rendered row, and remote (peer-relayed) sends report
  "已提交" without waiting on a local command id.
- **App no longer renders JSON `null` as the string `"null"`.** Android's
  `JSONObject.optString(key, fallback)` returns the four characters `null` when the value is
  `JSONObject.NULL`, so every Session without a parent was counted as a subagent ("共 8 个会话
  （8 个子智能体）" instead of 3) and every tool row rendered a `tool: null` line. A small
  `Ui.text(object, key)` helper now maps `null`/absent values to the empty string and all adapters
  use it.

## [0.6.2] — 2026-11-04

The "hot reload actually reloads" patch. Changing `capabilities.methods` in a running node showed
up in `/api/v1/info` but the capability channel kept refusing the new method — the reason enabling
`sessions.prompt` for the phone controller appeared to require a node restart.

### Fixed

- **A capability allowlist change now reaches the command queue.** `cmdServe` called
  `commands.setConfig(cfg.capabilities)` from its config-watcher callback but never destructured
  `commands` from `loadCtx`, so every reload threw `commands is not defined` inside the callback's
  try/catch. The DSH view was reconfigured, the node's own `cfg` was refreshed, and only the queue
  stayed on its startup allowlist; `/api/v1/dsh/call` therefore answered `method_not_allowed` until
  the node was restarted.
- Added `test/cli-reload.test.mjs`: it spawns the real CLI, flips `capabilities.methods` in the
  config file, and asserts that the queue accepts the new method after the watcher reloads (the
  test fails on 0.6.1 and passes now).

### Changed

- Node/CLI version `0.6.2`; the bridge plugin code is unchanged and stays at `0.6.1`.

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
  list (SSE, device-token management, multi-node); screenshots are not committed (real host names).

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

[Unreleased]: https://github.com/pomelo-neko/dsh-link/compare/v0.11.0...HEAD
[0.10.1]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.10.1
[0.10.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.10.0
[0.9.1]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.9.1
[0.9.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.9.0
[0.8.1]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.8.1
[0.8.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.8.0
[0.7.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.7.0
[0.6.2]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.6.2
[0.6.1]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.6.1
[0.6.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.6.0
[0.5.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.5.0
[0.4.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.4.0
[0.3.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.3.0
