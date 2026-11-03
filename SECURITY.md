# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for vulnerabilities. Use GitHub's private reporting
(Security → *Report a vulnerability*) on this repository, or contact the maintainers directly.
Include: what you ran, the config you used (redacted), what you observed, and the version of both
the node (`dshlink --version`) and the bridge plugin.

Supported versions: the latest release only. Security fixes are released as patch versions.

## What dsh-link is, security-wise

dsh-link connects machines that you own and control. It is a **trusted-peer tool, not a
multi-tenant service**. Its defaults are conservative, but the operator can open very wide doors:

| Door | Default | What opening it means |
|---|---|---|
| `bind` | `127.0.0.1` | A public/LAN bind exposes the API to the network. |
| `auth.trustLocalhost` | `false` | Off by default since 0.5.0: every request needs a token. Turning it on lets loopback requests skip tokens — only acceptable on a single-user machine, and never when a loopback forwarder (frp/STCP, `ssh -L`) can reach the port: the remote end then arrives as `127.0.0.1` and is authenticated automatically. |
| `files.roots` | empty | Each root is read-only unless `rw`. |
| `files.allowUpload` | `false` | Inbound `push` writes files into a root. |
| `dsh.enabled` | `false` | Peers can list **every** workspace and session and read transcripts on this machine. |
| `capabilities.enabled` | `false` | Peers can act inside this machine's DSH: create/prompt/rename/archive conversations. |
| `relay.enabled` | `true` | A peer can ask your node to forward a message to another peer. |

Hardening checklist for machines joined over an untrusted network:

1. **Turn off loopback trust and issue role-scoped tokens** on both ends:
   `dshlink harden --write` (it turns `auth.trustLocalhost` off and mints an `mcp-admin` admin token
   plus a dedicated `bridge` token), then
   `dshlink install-dsh --write --token <admin-token> [--bridge --bridge-token <bridge-token>]`.
   Restart the node and the DSH host once. Never hand an admin token to a peer or a phone: mint
   `dshlink token new --role peer --peer <name>` or `--role device --ttl-days 90` instead.
2. Prefer **frp STCP over a TLS frps** (or a reverse proxy with HTTPS) instead of exposing port
   8787. STCP is not a substitute for auth: whoever holds the STCP `secretKey` can open a visitor
   against the provider.
3. Rotate tokens by hand and out of band. Tokens are exchanged during pairing; rotating one end
   without the other turns every cross-machine call into `401`.
4. Keep `dsh.excludeWorkspaces` populated with the data directories of the node itself
   (`.dshlink`, the bridge workspace) so that the DSH view cannot leak its own credentials.
5. Never leave the node's data directory inside a shared file root. If a token ever lands in a
   shared root, treat it as leaked: move the data dir out first, then rotate on both ends.
6. Read `audit.jsonl` (file access) and the node's `outbox.jsonl` when something is delivered
   that you did not expect.


## Token model (0.5.0)

Every inbound token can carry a `role`, an optional bound peer identity and an optional
`expiresAt`. A token without a role is treated as `admin` for compatibility with 0.4 configs —
rotate those.

The action allowance is not a role: a `device` token can submit any method listed in
`capabilities.methods`, and an `admin` token is still refused when the method is not listed. A phone
controller therefore needs a `device` token **and** `capabilities.methods` containing
`sessions.prompt`; it never needs to hold an admin token.

| Role | Can | Cannot |
|---|---|---|
| `admin` | everything the node API offers: peers/status/audit, messages, files, DSH view, capability calls, MCP | the bridge control plane from a remote address (use a local process or a `bridge` token) |
| `bridge` | `/api/v1/bridge/*` (status, commands claim/result, heartbeat, bind) and read messages/DSH view | manage peers/tokens, post messages, files, MCP |
| `peer` | exchange its own messages (inbox/outbox filtered by its bound identity), DSH view, capability calls | read another peer's messages, forge `from`, relay to a third node, manage the node |
| `device` | DSH view (workspaces, sessions, transcripts, capabilities), capability calls allowed by `capabilities.methods` (a phone sends `sessions.prompt`), own queued call results | messages, files, bridge control plane, peers/tokens/audit/MCP |

`auth.trustLocalhost` is only about the local process: with it off, the MCP client, the CLI and the
bridge must all send their token (this is what `harden` + `install-dsh --token ...` configure).
`GET /healthz` is always open. Failed authentication is throttled per IP (20 per minute); every
authenticated request also counts against `limits.maxRequestsPerMinute` (default 1200; 0 disables)
in a 60 s window, and excess requests get `429` with `Retry-After`.

## Cryptography

- Tokens are stored as `sha256` and compared in constant time (`safeEqual`).
- File transfers carry a `sha256` of the payload; the client verifies it.
- Messages and files are **not end-to-end encrypted**. Everything relies on the transport
  (loopback, a LAN you control, frp STCP with TLS, or your own reverse proxy).
