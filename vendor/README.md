# vendor/

Third-party binaries that dsh-link *uses* but does **not** redistribute.

## frp (frpc / frps)

The FRP tunnel integration needs the `frp` binaries. They are 16–20 MB each, belong to another
project, and are unsigned (which makes some antivirus products quarantine them silently). So they
are **not committed here** — you download them yourself:

1. Open <https://github.com/fatedier/frp/releases/tag/v0.71.0> (that is the version this repo was
   tested against; newer releases generally work).
2. Download the archive for the machine that will run the client:

   | Platform | Archive | Extract into |
   |---|---|---|
   | Windows x64 | `frp_0.71.0_windows_amd64.zip` | `vendor/frp/windows-amd64/` (`frpc.exe`, `frps.exe`) |
   | Linux x64 | `frp_0.71.0_linux_amd64.tar.gz` | `vendor/frp/linux-amd64/` (`frpc`) |

   Only `frps` belongs on the **server** that has the public address; each DSH machine needs
   `frpc`. The `.gitignore` keeps these platform directories out of git.
3. Verify what you extracted: `node scripts/verify-vendor.mjs` compares every file against
   `vendor/frp/SHA256SUMS.txt` and prints one line per binary.

You do not have to use this directory at all: `dshlink tunnel` also looks at `$DSHLINK_FRPC`,
`$DSHLINK_HOME/frp`, `~/.dshlink/frp`, `~/frp`, `C:\frp` (`/usr/local/bin`) and
`D:\frp` (`/usr/bin`), and `--frpc <path>` overrides everything. Without the binaries the FRP
test in `test/frp.test.mjs` skips itself, and everything except `tunnel` keeps working.

> **Antivirus note.** The frp binaries are unsigned. Huorong/火绒 and similar products are known to
> block execution (silent exit, no output) or delete the files during packaging. Add the directory
> to the product's trust list, and re-run `node scripts/verify-vendor.mjs` afterwards — it tells
> you exactly which file is missing or changed.

frp is licensed under **Apache-2.0**; see <https://github.com/fatedier/frp>.
