# start-dshlink.ps1 — start the local dsh-link node (and the FRP client) hidden and idempotently.
#
# Safe to run repeatedly: it starts only what is not already running, and never opens a console
# window (Start-Process -WindowStyle Hidden). Point a logon task / shortcut at start-dshlink.vbs,
# which runs this file with no window at all.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "node not found on PATH"; exit 2 }

$dataArg = @()
if ($env:DSHLINK_HOME) { $dataArg = @("--data-dir", $env:DSHLINK_HOME) }
# The node runs windowless, so a crash would otherwise leave no trace at all: keep its stdout and
# stderr next to the data dir so a post-mortem is possible.
$logDir = if ($env:DSHLINK_HOME) { $env:DSHLINK_HOME } else { Join-Path $env:USERPROFILE ".dshlink" }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
if (-not (Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue)) {
  $cli = Join-Path $root "bin\dshlink.mjs"
  Start-Process -FilePath $node -ArgumentList (@("`"$cli`"", "serve", "--auto-sync", "60") + $dataArg) -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "node.out.log") -RedirectStandardError (Join-Path $logDir "node.err.log")
  Write-Host "dsh-link node: started (logs: $logDir\node.out.log, node.err.log)"
} else {
  Write-Host "dsh-link node: already listening on 8787"
}

$frpc = Join-Path $root "vendor\frp\windows-amd64\frpc.exe"
$frpcConfig = if ($env:DSHLINK_FRPC_CONFIG) { $env:DSHLINK_FRPC_CONFIG } else { Join-Path $env:USERPROFILE '.dshlink\frp\frpc.toml' }
if (-not (Test-Path $frpc)) { Write-Host "frpc: not bundled here, skipped" }
elseif (-not (Test-Path $frpcConfig)) { Write-Host "frpc: no config at $frpcConfig, skipped" }
elseif (Get-Process frpc -ErrorAction SilentlyContinue) { Write-Host "frpc: already running" }
else {
  Start-Process -FilePath $frpc -ArgumentList @("-c", $frpcConfig) -WorkingDirectory (Split-Path -Parent $frpcConfig) -WindowStyle Hidden
  Write-Host "frpc: started ($frpcConfig)"
}
