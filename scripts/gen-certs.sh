#!/usr/bin/env bash
#
# gen-certs.sh - create a CA, a server certificate and per-machine client certificates for frp
# mTLS (mutual TLS). frp works without this; mTLS is the "extra" hardening step in docs/FRP.md.
#
#   ./scripts/gen-certs.sh <frps-host-or-ip> [out-dir] [--clients a,b] [--days 825]
#
# Examples:
#   ./scripts/gen-certs.sh 203.0.113.10 certs
#   ./scripts/gen-certs.sh frps.example.com certs --clients alice-pc,bob-pc
#
# Output (all in <out-dir>):
#   ca.crt ca.key               the CA - ca.crt goes to every machine, ca.key stays offline
#   server.crt server.key       for frps on the public host
#   <client>.crt <client>.key   one pair per frpc (its own name, never shared)
#
# Then, in the frp configs:
#   frps.toml   transport.tls.certFile/keyFile = server.crt/server.key
#               transport.tls.trustedCaFile    = ca.crt
#   frpc.toml   transport.tls.certFile/keyFile = <client>.crt/<client>.key
#               transport.tls.trustedCaFile    = ca.crt
#               transport.tls.serverName       = <frps-host-or-ip>
# and restart frps/frpc. Requires openssl 1.1+ on PATH.
set -euo pipefail

SERVER_NAME=""
CERT_DIR="certs"
CLIENTS="client-a,client-b"
DAYS="825"

while [ $# -gt 0 ]; do
  case "$1" in
    --clients) CLIENTS="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) if [ -z "$SERVER_NAME" ]; then SERVER_NAME="$1"; else CERT_DIR="$1"; fi; shift ;;
  esac
done

if [ -z "$SERVER_NAME" ]; then
  echo "usage: $0 <frps-host-or-ip> [out-dir] [--clients a,b] [--days 825]" >&2
  exit 2
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl not found - install it (Debian/Ubuntu: apt install openssl; macOS: brew install openssl)" >&2
  exit 1
fi

# An IP needs an IP: SAN, a name needs DNS: - frp and TLS clients both check this.
if printf '%s' "$SERVER_NAME" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$'; then
  SAN="IP:$SERVER_NAME"
else
  SAN="DNS:$SERVER_NAME"
fi

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

echo ">>> CA (4096-bit, 10 years)"
if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=frp-local-ca" -out ca.crt
else
  echo "    ca.key already exists - reusing it (delete ca.key/ca.crt to start over)"
fi

echo ">>> server certificate for $SERVER_NAME"
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=$SERVER_NAME" -out server.csr
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$SAN" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 -extfile server.ext

echo ">>> client certificates: $CLIENTS"
OLD_IFS=$IFS
for c in $(printf '%s' "$CLIENTS" | tr ',' ' '); do
  echo "    - $c"
  openssl genrsa -out "$c.key" 2048
  openssl req -new -key "$c.key" -subj "/CN=$c" -out "$c.csr"
  printf 'extendedKeyUsage=clientAuth\n' > "$c.ext"
  openssl x509 -req -in "$c.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$c.crt" -days "$DAYS" -sha256 -extfile "$c.ext"
done
IFS=$OLD_IFS

rm -f ./*.csr ./*.ext

echo
echo ">>> certs are in $(pwd)"
ls -1
echo
echo "next steps"
echo "  1. copy ca.crt to every machine; keep ca.key offline (it can mint new certificates)"
echo "  2. frps:  uncomment transport.tls.certFile/keyFile/trustedCaFile in the frps config"
echo "  3. frpc:  uncomment the same three keys and set transport.tls.serverName = $SERVER_NAME"
echo "  4. restart frps and every frpc (dshlink tunnel stop && dshlink tunnel sync on this machine)"
echo "  5. verify: frpc logs 'login to server success' with no x509 errors"
