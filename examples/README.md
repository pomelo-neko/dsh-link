# examples/

Sanitised samples. Every value here is a placeholder — replace it, and never commit a real token,
an STCP `secretKey` or a real host name.

| File | What it is |
|---|---|
| `dshlink.config.example.json` | A complete node config (`<data-dir>/dshlink.config.json`) with every documented key set to a safe, explicit value |
| `cordis.patch.example.yml` | The DSH profile patch: MCP entry + bridge plugin (what `dshlink install-dsh` writes) |
| `dsh-mcp-settings.example.yaml` | The same MCP entry on its own, if you edit settings by hand |
| `frps.toml` | A public-relay `frps` configuration to start from |

## Node config

`dshlink init` writes a minimal config; this file shows the full surface, including the parts that
are **off by default** (`dsh.enabled`, `capabilities.enabled`, `files.allowUpload`). Points worth
noticing:

- `auth.trustLocalhost: false` + an explicit token is the hardened setting. With the default
  (`true`), anything that reaches the port from loopback — including a tunnel that terminates on
  loopback — is already authenticated. See [`../SECURITY.md`](../SECURITY.md).
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
