# Changelog

All notable changes to **dsh-link**. Two artefacts are released together and carry their own
version: the node/CLI (`package.json`) and the DSH Host plugin
(`integrations/dsh-link-bridge/package.json`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The bridge no longer writes `state.json` twice per wake-up. The intermediate write lacked
  `errors`, `notified` and `ticks`, so a reader that polled the file at the wrong moment could
  see a heartbeat without those fields (found by running the suite on Linux).

### Changed

- `test/mcp.test.mjs` and `test/reload.test.mjs` skip themselves when the MCP client SDK is not
  installed, instead of failing: the SDK ships with DSH, not with this repository.
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

[Unreleased]: https://github.com/pomelo-neko/dsh-link/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/pomelo-neko/dsh-link/releases/tag/v0.3.0
