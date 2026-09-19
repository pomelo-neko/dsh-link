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
| `auth.trustLocalhost` | `true` | Requests from loopback need **no token**. This is what makes a local MCP client work; it also means anything that can reach the port from the same host (or through a tunnel that terminates on loopback) is already authenticated. |
| `files.roots` | empty | Each root is read-only unless `rw`. |
| `files.allowUpload` | `false` | Inbound `push` writes files into a root. |
| `dsh.enabled` | `false` | Peers can list **every** workspace and session and read transcripts on this machine. |
| `capabilities.enabled` | `false` | Peers can act inside this machine's DSH: create/prompt/rename/archive conversations. |
| `relay.enabled` | `true` | A peer can ask your node to forward a message to another peer. |

Hardening checklist for machines joined over an untrusted network:

1. **Turn off loopback trust** on both ends (`auth.trustLocalhost: false`) and give every local
   client an explicit token (`dshlink token new --label mcp`). Loopback trust plus a tunnel that
   terminates on loopback means inbound tokens are never checked on that path.
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

## Cryptography

- Tokens are stored as `sha256` and compared in constant time (`safeEqual`).
- File transfers carry a `sha256` of the payload; the client verifies it.
- Messages and files are **not end-to-end encrypted**. Everything relies on the transport
  (loopback, a LAN you control, frp STCP with TLS, or your own reverse proxy).
