# STCP tunnel: runtime import (0.5.0+) and optional internal assets

Since 0.5.0 the Android control app **does not ship tunnel credentials**. A generic APK contains no
frps auth token, no mTLS client key and no STCP `secretKey`. Instead the user imports a `dshlink1:`
connect code / profile file produced by the hub administrator (`dshlink hub invite --phone`, or the
hub web console's phone-invite action). The app then writes `frpc.toml` + the certificates it carries
into its private directory and starts the bundled frpc visitor at runtime.

What the app needs on the phone:

- `files/tunnel/frpc.toml` — written by the import flow, kept verbatim (its `{{DIR}}` placeholder is
  replaced with the private directory's absolute path when the tunnel starts; the original template is
  preserved and a `frpc.runtime.toml` is generated for frpc);
- the certificate files referenced by that TOML — written from the code's `tunnel.files` (the code may
  carry only the files the rendered template actually references; a pure-STCP profile needs none);
- the bundled `lib/<abi>/libfrpc.so` (still required in every build).

The local visitor port is read from the imported TOML's `bindPort` (the hub-rendered template
defaults to **18790**; the older node template used 18788). Nothing about the tunnel is compiled into
the APK.

## Optional: internal builds with `assets/tunnel/`

For an internal build that should still connect without importing a code, the old behavior is kept:
drop all four files into `android/app/src/main/assets/tunnel/`. `build-apk.ps1` bundles them only when
`frpc.toml` + `ca.crt` + `client.crt` + `client.key` are all present, and prints:

```text
assets\tunnel found: this APK will contain tunnel credentials (internal build only)...
```

Such an APK must **not** be distributed. Without `assets/tunnel/` (the repository default) the build
produces the generic, distributable APK and prints `tunnel credentials: none (distribution build)`.

Populate the assets on the machine that already has a working frpc configuration:

```powershell
$dst = 'android\app\src\main\assets\tunnel'
New-Item -ItemType Directory -Force $dst | Out-Null

# 1. frps client certs (ca.crt / client.crt / client.key)
Copy-Item 'C:\Users\example\.dshlink\frp\certs\ca.crt','C:\Users\example\.dshlink\frp\certs\client.crt','C:\Users\example\.dshlink\frp\certs\client.key' $dst

# 2. render frpc.toml; substitute the values used by the node's existing provider
$tpl = Get-Content 'android\tunnel\frpc.toml.example' -Raw
$tpl = $tpl.Replace('{{SERVER_ADDR}}', '<frps host>')
$tpl = $tpl.Replace('{{SERVER_PORT}}', '16443')
$tpl = $tpl.Replace('{{FRPS_AUTH_TOKEN}}', '<frps auth token>')
$tpl = $tpl.Replace('{{STCP_SERVER_NAME}}', 'dshlink-phone')
$tpl = $tpl.Replace('{{STCP_SECRET_KEY}}', '<stcp secretKey>')
$tpl = $tpl.Replace('{{VISITOR_PORT}}', '18790')
Set-Content -NoNewline -Encoding utf8 (Join-Path $dst 'frpc.toml') $tpl
```

Values come from the node-side frpc config (`C:\Users\example\.dshlink\frp\frpc.toml` in this setup): the frps
`serverAddr`/`serverPort`, `auth.token`, the STCP `[[proxies]]` `serverName`, and its
`secretKey`. Since 0.3.0 the target provider is the one that points at the **gateway**
(`gateway.provider.name`, default `dshlink-phone` → `localPort 8788`), not the older provider that
points at the plain API port 8787; `dshlink tunnel sync` publishes it from the node's
`gateway.enabled` + `gateway.provider.secretKey` configuration. The visitor port is local to the
phone; 18790 avoids the node's 19110 visitor and the billion-context proxy on 18787.

## Native frpc binaries

`android/native/lib/<abi>/libfrpc.so` is also git-ignored. It is a renamed `frpc` binary for each
packaged ABI:

- `x86_64`: from frp v0.71.0 linux-amd64 (emulator)
- `arm64-v8a`: from frp v0.71.0 linux-arm64 (real phone)

Download `frp_0.71.0_linux_amd64.tar.gz` / `frp_0.71.0_linux_arm64.tar.gz` from the frp release,
extract `frpc`, and copy it to the matching `libfrpc.so` path. See
[`../README.md`](../README.md) sections 1.2, 2.4 and 3.2 for the import flow, full prerequisites and
security boundary.

## Security

- **Generic APK** (no `assets/tunnel/`): contains no tunnel credentials and can be distributed. The
  per-user credentials arrive in the connect code and live only in the app-private
  `files/tunnel/` and `SharedPreferences` (plaintext, sandboxed by Android). If a code or phone
  leaks, revoke the device token (`dshlink hub token rm --id <tokenId>`) and rotate the frps auth
  token / mTLS certificate / STCP `secretKey` as needed.
- **Internal APK** (with `assets/tunnel/`): embeds credentials; private self-use build only, do not
  publish or share it.
- Since 0.3.0 the provider points at the node's token-checking **8788 gateway**, so the STCP secret
  alone does not reach the node API: every request still needs a `device` token and the gateway never
  falls back to `trustLocalhost`.
