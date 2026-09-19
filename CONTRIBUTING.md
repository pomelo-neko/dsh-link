# Contributing to dsh-link

Thanks for taking the time to contribute. This project is deliberately small: **zero runtime
dependencies**, everything in `src/` runs on Node's standard library, and the tests use only
`node:test` plus the Node built-ins.

## Ground rules

- **Zero runtime dependencies.** A change that adds an entry to `dependencies` needs a very good
  reason in the PR description. Dev-time tooling (e.g. the MCP SDK used by one test) is resolved
  from the host DSH installation and skipped when absent.
- **Node >= 20.** Both the node and the bridge plugin run on the DSH host's Node.
- **No secrets, ever.** Never commit tokens, STCP `secretKey` values, real peer names, real
  hostnames, public IP addresses, `C:\Users\<you>` paths, or audit-log excerpts. Use the
  placeholders already used in the docs (`alice-pc`, `bob-pc`, `<frps-host>`, `D:\ws`).
- **Two components, two version numbers.** `package.json` (the node/CLI) and
  `integrations/dsh-link-bridge/package.json` (the DSH Host plugin) are released independently.
  `test/release.test.mjs` checks that the version strings agree with the runtime constant and the
  FRP provider name — update all of them together.

## Get set up

```bash
git clone https://github.com/pomelo-neko/dsh-link.git
cd dsh-link
node --version            # must be >= 20
node bin/dshlink.mjs --help
```

There is nothing to install: `npm install` is not needed to run the node, the CLI or the tests.

## Run the tests

```bash
node test/run.mjs                                  # 116 checks, in-process, ~10 s
node --test --test-concurrency=1 test/             # same suites through node:test
powershell -NoProfile -ExecutionPolicy Bypass -File test/cli-smoke.ps1   # two real processes
```

Notes:

- `test/frp.test.mjs` really starts `frps` + two `frpc` processes and skips itself when the frp
  binaries are missing — download them yourself per [`vendor/README.md`](vendor/README.md) and put
  them in `vendor/frp/<platform>/` if you want that coverage locally.
- On Windows, an antivirus product may silently quarantine the **unsigned** frp binaries. Run
  `node scripts/verify-vendor.mjs` — it prints one line per binary and tells you exactly what to
  restore.
- `scripts/verify-bundle.ps1 -Bundle <zip> -PeerDataDir <dir>` unpacks a built portable bundle and
  drives a real end-to-end run against a second node on the same machine. It mutates the data
  directory you pass (adds and removes a test peer), so pass a throwaway one.

## Layout

| Path | What lives there |
|---|---|
| `bin/dshlink.mjs` | the CLI (argument parsing, all subcommands, output formatting) |
| `src/*.mjs` | the node: config, store, fs sandbox, HTTP server, MCP endpoint, ops, tunnel, pairing, hot reload, DSH view, capability channel |
| `integrations/dsh-link-bridge/` | the DSH Host plugin that wakes a conversation when messages arrive |
| `integrations/dsh-skill/` | the agent-facing skill (`SKILL.md`) for driving the CLI |
| `docs/` | design, protocol, DSH integration, FRP, operations, troubleshooting |
| `test/` | `*.test.mjs` suites + the CLI smoke script |
| `scripts/` | bundle build/verify, vendor fetch/verify, Windows autostart |

## Pull requests

1. One topic per PR; keep diffs readable and avoid reformatting untouched files.
2. Add or update a test for behaviour changes. Bug fixes should reference the failing case.
3. Run `node test/run.mjs` and paste the summary line in the PR description.
4. Update `CHANGELOG.md` under **Unreleased**.
5. Docs are part of the change: a new config key, CLI flag or endpoint needs a line in
   `README.md` and the relevant file under `docs/`.

Commit messages: imperative mood, one short summary line, optional body explaining *why*.
