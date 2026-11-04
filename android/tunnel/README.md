# Built-in STCP tunnel assets (local only)

The Android control app can start an `frpc` STCP visitor so a phone without a LAN/VPN route to the
node can reach it through an existing frps relay. That visitor needs:

- `android/app/src/main/assets/tunnel/frpc.toml` — rendered from `frpc.toml.example`
- `android/app/src/main/assets/tunnel/{ca.crt,client.crt,client.key}` — the frps mTLS client certs

**These files are git-ignored on purpose.** They contain the frps auth token, the STCP `secretKey`
and the client private key; committing them would let anyone with the repository reach the node's
STCP provider. Only the template and this document are versioned.

## Populate the assets

On the machine that already has the working frpc configuration:

```powershell
$dst = 'android\app\src\main\assets\tunnel'
New-Item -ItemType Directory -Force $dst | Out-Null

# 1. frps client certs (ca.crt / client.crt / client.key)
Copy-Item 'C:\Users\example\.dshlink\frp\certs\ca.crt','C:\Users\example\.dshlink\frp\certs\client.crt','C:\Users\example\.dshlink\frp\certs\client.key' $dst

# 2. render frpc.toml; substitute the values used by the node's existing provider
$tpl = Get-Content 'android\tunnel\frpc.toml.example' -Raw
$tpl = $tpl.Replace('{{SERVER_ADDR}}', '203.0.113.10')
$tpl = $tpl.Replace('{{SERVER_PORT}}', '16443')
$tpl = $tpl.Replace('{{FRPS_AUTH_TOKEN}}', '<frps auth token>')
$tpl = $tpl.Replace('{{STCP_SERVER_NAME}}', 'dshlink-desktop-e4nrkp6')
$tpl = $tpl.Replace('{{STCP_SECRET_KEY}}', '<stcp secretKey>')
$tpl = $tpl.Replace('{{VISITOR_PORT}}', '18788')
Set-Content -NoNewline -Encoding utf8 (Join-Path $dst 'frpc.toml') $tpl
```

Values come from the node-side frpc config (`C:\Users\example\.dshlink\frp\frpc.toml` in this setup): the frps
`serverAddr`/`serverPort`, `auth.token`, the STCP `[[proxies]]` `serverName`, and its
`secretKey`. The visitor port is local to the phone; 18788 avoids the node's 19110 visitor and the
billion-context proxy on 18787.

## Native frpc binaries

`android/native/lib/<abi>/libfrpc.so` is also git-ignored. It is a renamed `frpc` binary for each
packaged ABI:

- `x86_64`: from frp v0.71.0 linux-amd64 (emulator)
- `arm64-v8a`: from frp v0.71.0 linux-arm64 (real phone)

Download `frp_0.71.0_linux_amd64.tar.gz` / `frp_0.71.0_linux_arm64.tar.gz` from the frp release,
extract `frpc`, and copy it to the matching `libfrpc.so` path. See
[`../README.md`](../README.md) section 2.4 for the full prerequisites and security boundary.

## Security

The built APK embeds these credentials. It is a private self-use build; do not publish it. If the
APK leaks, rotate the frps auth token, re-issue the client certificate and change the STCP
`secretKey`. With `auth.trustLocalhost: true` on the node, STCP traffic arrives on loopback and
bypasses the dsh-link token, so a production phone deployment needs a token-checking gateway (or
client certificates) in front of a dedicated STCP provider.
