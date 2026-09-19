#!/usr/bin/env bash
# dsh-link 客户端安装脚本（Linux / WSL）—— 只装客户端，不部署 frps
# 例：./install.sh --name my-wsl --share-workspace --task --frp-server 1.2.3.4 --frp-token <token>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CLI="$HERE/bin/dshlink.mjs"
NAME=${NAME:-$(hostname)-wsl}
PORT=${PORT:-8787}
DATA_DIR=${DATA_DIR:-$HOME/.dshlink}
ROOTS=()
SHARE_WORKSPACE=0
ALLOW_UPLOAD=0
TASK=0
INSTALL_DSH=0
PROFILE=${PROFILE:-web}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
FRP_SERVER=${FRP_SERVER:-}
FRP_TOKEN=${FRP_TOKEN:-}
NO_INVITE=0

usage() { sed -n '2,4p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --data-dir) DATA_DIR="$2"; shift 2;;
    --root) ROOTS+=("$2"); shift 2;;
    --share-workspace) SHARE_WORKSPACE=1; shift;;
    --allow-upload) ALLOW_UPLOAD=1; shift;;
    --task) TASK=1; shift;;
    --install-dsh) INSTALL_DSH=1; shift;;
    --profile) PROFILE="$2"; shift 2;;
    --dsh-home) DSH_HOME="$2"; shift 2;;
    --frp-server) FRP_SERVER="$2"; shift 2;;
    --frp-token) FRP_TOKEN="$2"; shift 2;;
    --no-invite) NO_INVITE=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done

[ -f "$CLI" ] || { echo "找不到 $CLI --- 请在解压出来的 dsh-link 目录里运行本脚本" >&2; exit 1; }
command -v node >/dev/null || { echo "未找到 node --- 请先安装 Node.js 20+（推荐 nvm）" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 版本过低：$(node -v)，需要 20+" >&2; exit 1; }

CONFIG="$DATA_DIR/dshlink.config.json"
if [ -f "$CONFIG" ]; then
  echo "[1/5] 已存在配置 $CONFIG --- 跳过 init"
else
  ARGS=(init --name "$NAME" --port "$PORT" --data-dir "$DATA_DIR" --json)
  if [ "${#ROOTS[@]}" -gt 0 ]; then
    for r in "${ROOTS[@]}"; do ARGS+=(--root "$r"); done
  fi
  if [ "${#ROOTS[@]}" -eq 0 ] || [ "$SHARE_WORKSPACE" = 1 ]; then ARGS+=(--root "ws=$PWD"); fi
  if [ "$ALLOW_UPLOAD" = 1 ]; then ARGS+=(--allow-upload); fi
  node "$CLI" "${ARGS[@]}" >/dev/null
  echo "[1/5] 已初始化节点 $NAME（数据目录 $DATA_DIR，端口 $PORT）"
fi

if [ -n "$FRP_SERVER" ]; then
  TARGS=(tunnel setup --data-dir "$DATA_DIR" --server "$FRP_SERVER")
  if [ -n "$FRP_TOKEN" ]; then TARGS+=(--token "$FRP_TOKEN"); fi
  node "$CLI" "${TARGS[@]}" >/dev/null
  node "$CLI" tunnel sync --data-dir "$DATA_DIR" >/dev/null
  echo "[2/5] 已配置 FRP 客户端并启动 frpc"
else
  echo "[2/5] 未指定 --frp-server --- 跳过穿透（局域网直连，或以后 tunnel setup）"
fi

if [ "$TASK" = 1 ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
    printf '%%s\n' \
      '[Unit]' \
      'Description=dsh-link node' \
      '[Service]' \
      "ExecStart=$(command -v node) $CLI serve --data-dir $DATA_DIR --auto-sync 60" \
      'Restart=always' \
      'RestartSec=3' \
      '[Install]' \
      'WantedBy=default.target' > "$UNIT_DIR/dshlink.service"
    systemctl --user daemon-reload
    systemctl --user enable --now dshlink.service
    echo "[3/5] 已注册 systemd 用户服务 dshlink.service"
  else
    setsid nohup node "$CLI" serve --data-dir "$DATA_DIR" --auto-sync 60 > "$DATA_DIR/serve.log" 2>&1 < /dev/null &
    echo "[3/5] 已在后台启动（无 systemd；日志 $DATA_DIR/serve.log）"
  fi
  sleep 2
else
  echo "[3/5] 未注册常驻服务；手动启动：node bin/dshlink.mjs serve --data-dir $DATA_DIR"
fi

if [ "$INSTALL_DSH" = 1 ]; then
  node "$CLI" install-dsh --profile "$PROFILE" --dsh-home "$DSH_HOME" --write >/dev/null
  echo "[4/5] 已写入 DSH profile 的 MCP 条目并安装技能（$DSH_HOME）"
else
  echo "[4/5] 未接入 DSH；以后可运行：node bin/dshlink.mjs install-dsh --write"
fi

if [ "$NO_INVITE" = 0 ]; then
  echo "[5/5] 配对码（发给要互联的那台机器，注意它含密钥）："
  node "$CLI" invite --data-dir "$DATA_DIR"
else
  echo "[5/5] 已跳过配对码"
fi
echo
echo "自检：node bin/dshlink.mjs doctor --data-dir $DATA_DIR"
