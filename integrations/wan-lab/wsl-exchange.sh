#!/usr/bin/env bash
# WSL-side peer: read the inbox, push a file to the peer, reply, and ping back.
set -uo pipefail
PROJ=${PROJ:-/mnt/d/dsh-link}
CLI=$PROJ/bin/dshlink.mjs
DATA=${DATA:-$HOME/dshlink-b}
SHARED=${SHARED:-$HOME/dshlink-shared}
PEER=${PEER:-win-node}

[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
echo "=== inbox ==="; node "$CLI" inbox --data-dir "$DATA" --json | head -c 600
echo; echo "=== push ==="; node "$CLI" push --data-dir "$DATA" --to "$PEER" --root ws --path from-wsl.txt --file "$SHARED/hello-from-wsl.txt" --json | head -c 300
echo; echo "=== send ==="; node "$CLI" send --data-dir "$DATA" --to "$PEER" --subject "re: wan test" --body "hello over the public internet" --json | head -c 300
echo; echo "=== ping ==="; node "$CLI" peers ping --data-dir "$DATA" --name "$PEER" --json | head -c 300
