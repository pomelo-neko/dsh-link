# examples/

Sanitised samples. Every value here is a placeholder — replace it, and never commit a real token,
an STCP `secretKey` or a real host name.

| File | What it is |
|---|---|
| `dshlink.config.example.json` | A complete node config (`<data-dir>/dshlink.config.json`) with every documented key set to a safe, explicit value |
| `cordis.patch.example.yml` | The DSH profile patch: MCP entry + bridge plugin (what `dshlink install-dsh` writes) |
| `dsh-mcp-settings.example.yaml` | The same MCP entry on its own, if you edit settings by hand |
| `frps.toml` | A public-relay `frps` configuration to start from |
| `hub.config.example.json` | A complete hub config (`<data-dir>/dshlink-hub.config.json`): enrollment limits, files cache, FRP provider |

## Node config

`dshlink init` writes a minimal config; this file shows the full surface, including the parts that
are **off by default** (`dsh.enabled`, `capabilities.enabled`, `files.allowUpload`). Points worth
noticing:

- `auth.trustLocalhost` defaults to `false` since 0.5: every request needs a token, including
  local MCP/CLI/bridge traffic. Run `dshlink harden --write` to mint the `admin` and `bridge`
  tokens, then `install-dsh --token … --bridge-token …`. See [`../SECURITY.md`](../SECURITY.md).
- `files.roots`: a `dir` root needs `path`; a `workspaces` root is virtual and takes the
  workspace id (or title) as its first path segment. Read-only unless `write: true`.
- `dsh.excludeWorkspaces` matches a workspace id, title or normalised absolute path **exactly**
  (not as a prefix). Always exclude the node's own data directory and the bridge workspace.
- `capabilities.methods` is the node-wide allow list; a non-empty `peers.<name>.allow` overrides
  it for that peer, and `deny` always wins. Action methods (`sessions.create`, `sessions.prompt`,
  `sessions.rename`, `sessions.archive`) are never enabled unless you list them.
- `peers[].token` is the token **the peer issued for you**; your own inbound tokens live in
  `auth.tokens` as sha256 hashes (`dshlink token new`).

```powershell
# try it without touching a real data dir
node bin\dshlink.mjs status --config examples\dshlink.config.example.json --json
```

## Hub config

`hub.config.example.json` is what `dshlink hub init` produces (plus every knob spelled out). It is
read from `<data-dir>/dshlink-hub.config.json` — a **separate** data dir and port from a node
(`8790` vs `8787`). Things that matter when handing a hub to someone else:

- `bind` stays `127.0.0.1`: remote access goes through the FRP STCP provider, never a public port.
  The hub does **not** trust loopback callers; every request needs a token.
- `frp.provider.secretKey` is the secret a phone/node visitor must present; it is embedded in the
  phone invite codes issued by `dshlink hub invite --phone` — treat those codes as passwords.
- `enrollment`: `autoApprove: false` means a new node waits in the console until an admin approves
  it; `tokenTtlHours` / `maxUsesPerToken` bound how long an enroll token lives.
- `files`: the hub caches file payloads, so `maxBytes` is a per-file ceiling for transfers that
  pass through the hub (default 10 MiB).
- `auth.tokens` starts empty because `hub init` mints the admin token; its sha256 lives here.
  Never commit a real value of this file.

```powershell
# validate a candidate config without starting anything
node bin\dshlink.mjs hub status --config examples\hub.config.example.json --json
```

