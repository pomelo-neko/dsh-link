# dsh-link

**Peer-to-peer messaging and file exchange between DeepSeek Harness (DSH) instances — across
machines, and across the open internet if you want.**

[English](README.md) | [简体中文](README.zh-CN.md)

Run one `dshlink` node on each machine. They can then send each other messages, pull and push
files, queue messages while the other side is offline, and appear inside DSH as native tools.

- **Zero runtime dependencies.** Only Node built-ins (`node:http`, `node:crypto`, `node:fs`).
  There is nothing to `npm install` — clone and run.
- **Three ways to connect.** Direct LAN/WAN, **FRP STCP** through a public relay (no inbound ports,
  recommended), or **relay forwarding** (A → hub → B).
- **Two ways into DSH.** **MCP** (17 `mcp__dshlink__link_*` tools via `dsh-mcp-client`) and the
  **CLI** (`dshlink …`, which an agent can drive from a shell).
- **An agent that notices messages.** `integrations/dsh-link-bridge/` is a DSH Host plugin that
  wakes a conversation when unread messages arrive — one conversation per topic, retired sessions
  archived.
- **Opt-in remote visibility (0.3).** With explicit switches, a peer can browse your DSH
  workspaces and sessions, read a transcript, or ask your bridge to create/prompt/archive a
  conversation. All of it is default-off.
- **Files stay inside declared roots.** Paths go through realpath validation, `.env` /
  `*.key` / `.ssh` are denied by default, writes are off by default, and transfers are
  sha256-checked on both ends.

---

## Contents

- [Quick start (two machines)](#quick-start-two-machines)
- [Wire it into DSH](#wire-it-into-dsh)
- [Wake a conversation automatically (bridge)](#wake-a-conversation-automatically-bridge)
- [See and drive the other machine's DSH (0.3)](#see-and-drive-the-other-machines-dsh-03)
- [NAT traversal with FRP STCP](#nat-traversal-with-frp-stcp)
- [Command reference](#command-reference)
- [Security model](#security-model)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)

## Quick start (two machines)

Both machines need **Node.js >= 20**. Nothing else.

On **machine A** (this repository, e.g. `D:\dsh-link`):

```powershell
# 1) create the node: name, port, shared folder (repeat --root for more roots)
node bin\dshlink.mjs init --name alice-pc --port 8787 --root ws=D:\ws
#    the output prints a one-time inbound token and an STCP secretKey for the peer

# 2) start it (HTTP API + MCP endpoint)
node bin\dshlink.mjs serve
```

Do the same on **machine B**, then register B from A:

```powershell
node bin\dshlink.mjs peers add --name bob-pc --url http://<B-ip>:8787 --token <B's token>
node bin\dshlink.mjs peers ping --name bob-pc
node bin\dshlink.mjs send --to bob-pc --subject hi --body "hello from A"
node bin\dshlink.mjs pull --peer bob-pc --root ws --path report.pdf --out .\report.pdf
```

On B, read and answer:

```powershell
node bin\dshlink.mjs inbox --unread
node bin\dshlink.mjs show --id msg_xxx
node bin\dshlink.mjs send --to alice-pc --body "got it" --thread msg_xxx
```

> **Offline is fine.** If the peer is unreachable the message goes to the local outbox
> (`send` returns `pending`). Later `dshlink flush` retries it, or the peer picks it up with
> `dshlink sync --from <you>`.

## Wire it into DSH

Add one MCP entry pointing at the **local** node — one entry per machine, not per peer (remote
nodes are reached by name through the `peer` argument):

```yaml
- id: mcp-dshlink
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dshlink
    transport: streamable-http
    url: http://127.0.0.1:8787/mcp
```

Restart DSH and the native tools appear: `link_status`, `link_peers`, `link_send_message`,
`link_inbox`, `link_read_message`, `link_reply`, `link_sync`, `link_flush`,
`link_list_files`, `link_stat_file`, `link_pull_file`, `link_push_file`, `link_help`, plus
the opt-in `link_dsh_workspaces`, `link_dsh_sessions`, `link_dsh_transcript` and `link_call`.

Loopback requests are trusted by default, so the local MCP client needs no token. To require one
(and to turn loopback trust off), see [`docs/DSH-INTEGRATION.md`](docs/DSH-INTEGRATION.md).

You can also copy `integrations/dsh-skill/` to `$DSH_HOME/skills/dshlink/` so an agent knows how
to drive the CLI.

### One command does the wiring

```powershell
node bin\dshlink.mjs install-dsh --profile web --write          # MCP entry + skill, preview first
node bin\dshlink.mjs install-dsh --profile web --bridge --bridge-workspace "D:\dshlink-bridge" --write
```

`install-dsh` edits the profile's `cordis.patch.yml` (timestamped backup first) — a restart of the
DSH host is needed once for the bridge entry to load.

## Wake a conversation automatically (bridge)

MCP alone answers "can the agent use the tools"; it does not answer "does the agent know a message
arrived". `integrations/dsh-link-bridge/` is a **DSH Host plugin**: it polls the local node and,
when unread messages appear, reuses or creates a conversation in a dedicated workspace and injects
a prompt containing the message and the peer name. The agent then reads the full text, pulls
attachments, replies with `link_reply` and marks the message read.

Since 0.3 the bridge is topic-aware: one conversation per topic, new conversation when a topic hits
its wake budget, age limit or idle timeout, and retired conversations are archived through DSH's
own registry (hidden from the sidebar, logs kept). Configuration, state file layout and the
self-check are documented in
[`integrations/dsh-link-bridge/README.md`](integrations/dsh-link-bridge/README.md).

> Point `workspacePath` at a **dedicated empty directory** (e.g. `D:\dshlink-bridge`) and add it —
> together with the node's data directory — to `dsh.excludeWorkspaces`. Otherwise bridge sessions
> pollute a normal workspace, and the node's own data directory (which holds peer tokens) can end
> up visible through the DSH view.

## See and drive the other machine's DSH (0.3)

Two capabilities, both **off by default**:

```powershell
# read-only view: list the peer's workspaces and sessions, read a transcript
dshlink dsh enable --write
dshlink dsh workspaces --peer bob-pc
dshlink dsh sessions   --peer bob-pc --archived
dshlink dsh transcript session-xxxx --peer bob-pc --tail --limit 40

# files: one virtual root over "all workspaces" (first segment = workspace id or title)
#   config: "files": { "roots": [ { "name": "allws", "kind": "workspaces", "read": true } ] }
dshlink ls   --peer bob-pc --root allws
dshlink pull --peer bob-pc --root allws --path "<workspace-id>/src/index.mjs" --out x.mjs

# actions: let the peer read/create/prompt/rename/archive conversations (explicit allow-list)
dshlink dsh enable --actions workspaces.list,sessions.list,sessions.read,sessions.prompt --write
dshlink dsh call sessions.prompt --peer bob-pc --wait 30 --params '{"sessionId":"session-xxxx","text":"status?"}'
```

The read-only view is disk-level: the node reads `storages/workspace.json` and the session logs
itself, so any peer running node 0.3 can do it. Actions go through the capability channel:
peer → your node → your bridge (inside DSH) → the DSH service, so they need bridge 0.3.

> Opening the DSH view lets a token-holding peer read **every workspace path and every
> conversation** on the machine. Only enable it for peers you trust, and read
> [`docs/DSH-ACCESS.md`](docs/DSH-ACCESS.md) first.

## NAT traversal with FRP STCP

When the machines share no LAN and you have no public port, put an `frps` on a host with a public
address. dsh-link **does not ship frp binaries** — download frp v0.71.0 yourself from
<https://github.com/fatedier/frp/releases/tag/v0.71.0> and place `frpc` / `frpc.exe` where the
node looks for it (`vendor/frp/windows-amd64/`, `vendor/frp/linux-amd64/`, `DSHLINK_FRPC`, or
`--frpc`). `node scripts/verify-vendor.mjs` checks whatever is there against the recorded
upstream sha256 values.

Generate the credentials (and, optionally, mutual-TLS certificates) with the bundled scripts:

```powershell
node scripts/gen-secrets.mjs                                    # frp token + STCP secretKey + dsh-link inbound token
powershell -ExecutionPolicy Bypass -File .\scripts\gen-certs.ps1 -ServerName <frps-host>   # Windows: CA + server + client certs
./scripts/gen-certs.sh <frps-host>                              # Linux / WSL / macOS
```

Read [`docs/FRP.md`](docs/FRP.md) §2.3 before exposing an STCP tunnel: the `secretKey` — not the
dsh-link token — is the real boundary on that path.

```powershell
# public server (once): frps only needs 7000/tcp open; template in docs/FRP.md

# on each DSH machine:
node bin\dshlink.mjs tunnel setup --server <frps-host> --port 7000 --token <frp token>
node bin\dshlink.mjs tunnel sync          # writes frpc.toml, starts frpc (background)
node bin\dshlink.mjs tunnel share         # prints the peer's half: proxyName + secretKey
```

The other side joins with one command:

```powershell
node bin\dshlink.mjs tunnel import --peer alice-pc --frp-server-name dshlink-alice-pc \
     --frp-secret <secretKey> --token <alice-pc's dshlink token>
node bin\dshlink.mjs peers ping --name alice-pc
```

Every node exposes its `127.0.0.1:8787` as an STCP **provider** and opens a local visitor port
(19100+) to reach a peer. Both directions are outbound; the only public port is the relay's 7000,
and the dsh-link API itself is never exposed. See [`docs/FRP.md`](docs/FRP.md).

## Command reference

| Command | What it does |
|---|---|
| `init` | Write the config, generate the inbound token and STCP identity (`--root name=path[:ro|:rw]`, `--allow-upload`) |
| `serve` | Start the HTTP API + `/mcp`; `--auto-sync 30` re-pushes periodically, `--no-reload` disables hot reload |
| `status` / `peers list\|add\|rm\|ping` | Local status, peer registry, liveness probes |
| `token list\|new\|rm` | Manage inbound tokens (only the sha256 is stored; the plaintext is shown once) |
| `send` / `inbox` / `show` / `sync` / `flush` | Messages: send, list, read one, pull the peer's queue, retry the outbox |
| `ls` / `pull` / `push` | List a directory, pull a file, push a file (needs `files.allowUpload: true` on the peer) |
| `audit` | Local audit log (who pulled which file, when) |
| `tunnel setup\|sync\|status\|share\|import\|stop\|config` | FRP tunnel configuration and process management |
| `invite` / `peers accept --invite <code> [--reply]` | Register both directions from one portable pairing code |
| `doctor` | Self-check: config, roots, port, MCP, peers, tunnel, DSH view — non-zero exit on failure |
| `install-dsh [--write]` | Write the MCP entry into the profile patch and install the skill (preview by default) |

Every command accepts `--json` (for agents and scripts) and `--data-dir` / `--config`.
Exit codes: `0` success, `2` usage/config error, `3` message still queued, `4` hash mismatch.

### Config hot reload (since 0.2.1)

`serve` re-reads the config file before every request, so adding a peer, a token or a file root
takes effect immediately — no restart. `/api/v1/status` reports `runtime.configReloads`, and
`dshlink doctor` compares the running process with the file on disk. Only `bind`, `port`,
`limits.requestTimeoutMs` and the tunnel process itself still need a restart.

### Keep it running (Windows)

```powershell
scripts\start-dshlink.cmd      # idempotent: starts the node and frpc hidden if they are not up
```

`start-dshlink.cmd → start-dshlink.vbs → start-dshlink.ps1` checks port 8787 and the frpc process
and starts whatever is missing, always with `-WindowStyle Hidden`. Register the `.vbs` as a
scheduled task (at logon, plus a periodic top-up) to survive reboots.

## Security model

| Item | Default | Notes |
|---|---|---|
| Bind address | `127.0.0.1` | Only the local machine; `--bind 0.0.0.0` for LAN direct |
| Auth | outbound token + optional loopback trust | Inbound tokens stored as sha256; loopback is trusted by default |
| File roots | explicit | Each root is read-only unless `:rw`; realpath-checked, symlinks cannot escape |
| Deny list | `.env`, `*.key`, `.ssh`, `.credentials.yaml`, `*.pem` … | Overridable per node |
| Uploads | off | `files.allowUpload: true` enables inbound `push` |
| Limits | 32 MiB request, 1 MiB message, 60 s timeout | See `limits` |
| Audit | on | `audit.jsonl` records file access and message delivery |
| DSH view (0.3) | off | `dsh.enabled`; `dsh.exposeTranscripts` gates conversation bodies |
| Capability channel (0.3) | off | `capabilities.enabled` + method allow-list; action methods are never allowed by default, per-peer overrides exist, every call is audited |

**Loopback trust + a tunnel that terminates on loopback means inbound tokens are not checked on
that path.** If your machines are joined over an untrusted network, set
`auth.trustLocalhost: false` on both ends and give local clients explicit tokens. See
[`SECURITY.md`](SECURITY.md) for the full hardening checklist.

## Repository layout

```
dsh-link/
├── bin/dshlink.mjs         # CLI entry point (init/serve/send/pull/tunnel/...)
├── src/
│   ├── config.mjs          # config, identity, token hashes, peer registry
│   ├── store.mjs           # inbox/outbox JSONL, read marks, delivery state, audit
│   ├── fsroot.mjs          # shared-root sandbox (realpath, deny list, sha256)
│   ├── server.mjs          # inbound HTTP API (auth, limits, Range download, audit)
│   ├── mcp.mjs             # MCP streamable-HTTP endpoint (17 link_* tools)
│   ├── ops.mjs             # delivery, queues, sync, relay, file operations
│   ├── client.mjs          # outbound HTTP client (streaming download + hash check)
│   ├── tunnel.mjs          # FRP STCP: frpc.toml generation, process management, share/import
│   ├── reload.mjs          # config hot reload
│   ├── dshview.mjs         # DSH workspaces/sessions/transcripts read straight from disk (0.3)
│   ├── capabilities.mjs    # capability channel: command queue, policy, audit (0.3)
│   └── pairing.mjs         # pairing codes + DSH install (MCP entry / skill / bridge)
├── integrations/
│   ├── dsh-link-bridge/    # DSH Host plugin: wake a conversation on unread messages (0.3: topics + archive)
│   ├── dsh-skill/          # agent-facing skill (SKILL.md)
│   ├── dsh-mcp-settings.example.yaml
│   └── wan-lab/            # two-machine WAN test lab (WSL helper scripts)
├── scripts/                # autostart, bundle build/verify, gen-secrets, gen-certs, vendor check
├── vendor/frp/             # sha256 manifest only — download the frp binaries yourself
├── test/                   # 15 test files / 116 checks + CLI smoke script
├── docs/                   # architecture, design, protocol, DSH access, FRP, operations, troubleshooting
└── examples/               # sanitised config samples
```

## Testing

```powershell
node test/run.mjs                                                        # 116/116, ~10 s
node --test --test-concurrency=1 test/                                   # the same suites via node:test
powershell -NoProfile -ExecutionPolicy Bypass -File test/cli-smoke.ps1   # 13/13, two real processes
```

`test/frp.test.mjs` really starts `frps` plus two `frpc` processes and moves messages and files
through the STCP tunnel only; it skips itself when you have not downloaded the frp binaries.
The MCP test drives dsh-link through the `@modelcontextprotocol/sdk` that DSH itself uses, and
`scripts/verify-bundle.ps1 -Bundle <zip> -PeerDataDir <throwaway-data-dir>` unpacks a built
portable bundle and runs an end-to-end pairing against a node on the same machine.

Cross-internet verification (Windows node ↔ WSL node through a public frps) is written up in
[`docs/WAN-VERIFICATION.md`](docs/WAN-VERIFICATION.md).

## Known limitations

- Pairing is manual: both sides exchange tokens (`invite`/`peers accept`); there is no automatic
  key exchange.
- FRP support generates STCP configuration only — deploying the public `frps` and its certificate
  is up to you.
- Large files have no chunking or resume (HTTP Range is supported server-side, the client does not
  use it yet).
- Inline attachments are capped at 512 KiB; bigger payloads go through the file API.
- The DSH view reads session logs from disk, so a DSH format change needs a dsh-link update; Node
  without zstd (older than 22.15) reports `zstd-unsupported` — use the bridge's capability channel
  instead.
- Message counts in the session list are a lower bound (the index reads the head of each log).
- **No end-to-end encryption.** Traffic relies on the transport: loopback, a LAN you control, frp
  STCP with TLS, or your own HTTPS reverse proxy.

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Component map: node, CLI, MCP, bridge, capability channel; files and versions |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deployment, autostart, upgrades, token rotation, wake-up troubleshooting |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | HTTP API and message/file wire protocol |
| [`docs/DSH-INTEGRATION.md`](docs/DSH-INTEGRATION.md) | MCP entry, skill install, bridge install, profile patch mechanics |
| [`docs/DSH-ACCESS.md`](docs/DSH-ACCESS.md) | The 0.3 switches: read-only view, transcripts, capability actions, threat model |
| [`docs/FRP.md`](docs/FRP.md) | Public `frps` deployment, STCP provider/visitor, TLS, verification |
| [`docs/WAN-VERIFICATION.md`](docs/WAN-VERIFICATION.md) | What was actually verified across the internet, and how |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Symptom → cause → fix, plus a one-minute health check |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Why the pieces look the way they do |
| [`SECURITY.md`](SECURITY.md) | Trust model and hardening checklist |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE). frp is a separate project by fatedier, licensed under Apache-2.0 — it is not
redistributed here.

> **AIGC notice** — this repository is generated and maintained entirely by AI. What that means for
> you (and what to verify yourself) is written down in [`AIGC-Notice.md`](AIGC-Notice.md).
