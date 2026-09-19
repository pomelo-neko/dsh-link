# dsh-link CLI smoke test — two real processes, two real nodes.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File test/cli-smoke.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$cli = Join-Path $root 'bin\dshlink.mjs'
$tmp = Join-Path $root 'test\.tmp\e2e'
$portB = 18991
$failures = 0

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) { Write-Host "PASS  $Name" } else { Write-Host "FAIL  $Name  $Detail" -ForegroundColor Red; $script:failures++ }
}

function Invoke-Cli {
  param([string[]]$CliArgs, [int[]]$AllowExit = @(0))
  $output = & node $cli @CliArgs 2>&1 | Out-String
  if ($AllowExit -notcontains $LASTEXITCODE) { throw "dshlink $($CliArgs -join ' ') failed (exit $LASTEXITCODE): $output" }
  return $output
}

# A failing command writes to stderr; PowerShell 5.1 turns that into a terminating
# error while ErrorActionPreference is Stop, so relax it just for that call.
function Invoke-CliExpectFailure {
  param([string[]]$CliArgs)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & node $cli @CliArgs 2>&1 | Out-String
    $script:lastExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return $output
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$sharedB = Join-Path $tmp 'B-shared'
New-Item -ItemType Directory -Force -Path $sharedB | Out-Null
Set-Content -Path (Join-Path $sharedB 'report.txt') -Value 'report from node B' -NoNewline -Encoding ASCII
$payload = Join-Path $tmp 'payload.txt'
Set-Content -Path $payload -Value 'pushed from node A' -NoNewline -Encoding ASCII

$initB = (Invoke-Cli @('init', '--name', 'nodeB', '--data-dir', "$tmp\B", '--port', "$portB", '--root', "shared=${sharedB}:rw", '--allow-upload', '--json')) | ConvertFrom-Json
$initA = (Invoke-Cli @('init', '--name', 'nodeA', '--data-dir', "$tmp\A", '--port', '18992', '--root', "ws=$root", '--json')) | ConvertFrom-Json
Check 'init both nodes' ($initB.name -eq 'nodeB' -and $initA.name -eq 'nodeA') "$($initB.name)/$($initA.name)"

Invoke-Cli @('peers', 'add', '--data-dir', "$tmp\A", '--name', 'nodeB', '--url', "http://127.0.0.1:$portB", '--token', $initB.token, '--json') | Out-Null

$serverOut = Join-Path $tmp 'serverB.out.log'
$serverErr = Join-Path $tmp 'serverB.err.log'
$proc = Start-Process -FilePath 'node' -ArgumentList @($cli, 'serve', '--data-dir', "$tmp\B") -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$portB/healthz" -TimeoutSec 2; if ($health.ok) { $ready = $true; break } } catch { }
  }
  Check 'node B serve is up' $ready (Get-Content $serverErr -Raw -ErrorAction SilentlyContinue)

  $send = Invoke-Cli @('send', '--data-dir', "$tmp\A", '--to', 'nodeB', '--subject', 'smoke', '--body', 'hello over the wire', '--json') | ConvertFrom-Json
  Check 'A -> B delivered' ($send.delivery.state -eq 'delivered') (ConvertTo-Json $send.delivery -Compress)

  $inboxB = Invoke-Cli @('inbox', '--data-dir', "$tmp\B", '--json') | ConvertFrom-Json
  Check 'B inbox has the message' ($inboxB.count -eq 1 -and $inboxB.messages[0].body -eq 'hello over the wire') (ConvertTo-Json $inboxB -Compress)

  $reply = Invoke-Cli @('send', '--data-dir', "$tmp\B", '--to', 'nodeA', '--body', 'ack from B', '--json') @(0, 3) | ConvertFrom-Json
  Check 'B -> A queued while A is offline' ($reply.delivery.state -eq 'pending') (ConvertTo-Json $reply.delivery -Compress)

  $sync = Invoke-Cli @('sync', '--data-dir', "$tmp\A", '--from', 'nodeB', '--json') | ConvertFrom-Json
  Check 'A syncs the queued reply' ($sync.imported -eq 1) (ConvertTo-Json $sync -Compress)

  $ls = Invoke-Cli @('ls', '--data-dir', "$tmp\A", '--peer', 'nodeB', '--root', 'shared', '--json') | ConvertFrom-Json
  Check 'A lists B shared root' (@($ls.entries | Where-Object { $_.name -eq 'report.txt' }).Count -eq 1)

  $pull = Invoke-Cli @('pull', '--data-dir', "$tmp\A", '--peer', 'nodeB', '--root', 'shared', '--path', 'report.txt', '--json') | ConvertFrom-Json
  Check 'A pulls a file from B' ((Test-Path $pull.path) -and ((Get-Content $pull.path -Raw) -eq 'report from node B') -and $pull.verified)

  $push = Invoke-Cli @('push', '--data-dir', "$tmp\A", '--to', 'nodeB', '--root', 'shared', '--path', 'from-a.txt', '--file', $payload, '--json') | ConvertFrom-Json
  Check 'A pushes a file to B' ((Test-Path (Join-Path $sharedB 'from-a.txt')) -and ((Get-Content (Join-Path $sharedB 'from-a.txt') -Raw) -eq 'pushed from node A')) (ConvertTo-Json $push -Compress)

  $blocked = Invoke-CliExpectFailure @('pull', '--data-dir', "$tmp\A", '--peer', 'nodeB', '--root', 'shared', '--path', '../escape.txt')
  Check 'path traversal is refused' ($script:lastExit -ne 0 -and $blocked -match 'forbidden') $blocked

  $status = Invoke-Cli @('status', '--data-dir', "$tmp\A", '--probe', '--json') | ConvertFrom-Json
  Check 'A sees B reachable' ($status.peers[0].reachable -eq $true)

  $audit = Invoke-Cli @('audit', '--data-dir', "$tmp\B", '--limit', '20', '--json') | ConvertFrom-Json
  Check 'B audit log records the traffic' (@($audit.entries | Where-Object { $_.event -eq 'message_received' }).Count -ge 1)

  $tunnel = Invoke-CliExpectFailure @('tunnel', 'config', '--data-dir', "$tmp\B", '--json')
  Check 'tunnel config is refused before setup' ($script:lastExit -ne 0 -and $tunnel -match 'not set') $tunnel
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}

Write-Host ''
if ($failures -gt 0) { Write-Host "$failures smoke check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'all smoke checks passed' -ForegroundColor Green
