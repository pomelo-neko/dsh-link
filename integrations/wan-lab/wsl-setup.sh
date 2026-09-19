#!/usr/bin/env bash
# WSL-side peer setup for a dsh-link WAN test.
# Env: DSHLINK_FRP_SERVER (default: read from $WAN/frps-addr.txt), DSHLINK_FRP_TOKEN_FILE
set -euo pipefail
PROJ=${PROJ:-/mnt/d/dsh-link}
WAN=${WAN:-$PROJ/test/.tmp/wan}
CLI=$PROJ/bin/dshlink.mjs
NAME=${NAME:-wsl-node}
PORT=${PORT:-19302}
DATA=${DATA:-$HOME/dshlink-b}
SHARED=${SHARED:-$HOME/dshlink-shared}
FRPS=${DSHLINK_FRP_SERVER:?set DSHLINK_FRP_SERVER=<frps host>}
FRP_TOKEN_FILE=${DSHLINK_FRP_TOKEN_FILE:-$PROJ/test/.tmp/frp-token.txt}

[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
rm -rf "$DATA" "$SHARED"; mkdir -p "$SHARED"
printf 'payload from wsl' > "$SHARED/hello-from-wsl.txt"

node "$CLI" init --name "$NAME" --data-dir "$DATA" --port "$PORT" --root "ws=$SHARED" --allow-upload --json > "$WAN/init-b.json"
node "$CLI" tunnel setup --data-dir "$DATA" --server "$FRPS" --port 7000 --token "$(tr -d '\r\n' < "$FRP_TOKEN_FILE")" --json > "$WAN/tunnel-b.json"
node "$CLI" tunnel sync --data-dir "$DATA" --json > "$WAN/tunnelsync-b.json" 2>&1 || true

if [ -f "$WAN/invite-a.json" ]; then
  CODE=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$WAN/invite-a.json','utf8')).code)")
  node "$CLI" peers accept --data-dir "$DATA" --invite "$CODE" --reply --json > "$WAN/accept-b.json"
fi

setsid nohup node "$CLI" serve --data-dir "$DATA" > "$WAN/b.out.log" 2>&1 < /dev/null &
sleep 2
curl -s -m 3 "http://127.0.0.1:$PORT/healthz" && echo
node "$CLI" tunnel status --data-dir "$DATA" --json | head -c 400
