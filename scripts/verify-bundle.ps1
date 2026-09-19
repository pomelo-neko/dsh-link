<#
  verify-bundle.ps1 --- 把导出的 zip 当成"另一台 DSH 机器"来验证：
  解压 → 跑 install.ps1 → 起节点 → 与本机已运行的节点互相配对 → 发消息 + 拉文件。
  用法：powershell -ExecutionPolicy Bypass -File scripts\verify-bundle.ps1 `
            -Bundle dist\dsh-link-<版本>-portable.zip -PeerDataDir <本机节点的 data 目录>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [string]$WorkDir = 'dist\verify',
  [int]$Port = 8790,
  # The node on THIS machine that the unpacked bundle pairs with. Pass it explicitly: the
  # script adds a test peer to it and removes that peer (plus the test messages left in its
  # outbox) when it finishes, so it must never default to a data dir you care about.
  [Parameter(Mandatory = $true)][string]$PeerDataDir,
  [switch]$Keep
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$failures = 0
function Check {
  param([string]$Label, [bool]$Ok, [string]$Detail = '')
  if ($Ok) { Write-Host "PASS  $Label" -ForegroundColor Green }
  else { Write-Host "FAIL  $Label  $Detail" -ForegroundColor Red; $script:failures++ }
}
function Run-Node {
  param([string]$Cli, [string[]]$CliArgs, [int[]]$AllowExit = @(0))
  $output = & node $Cli @CliArgs 2>&1 | Out-String
  if ($AllowExit -notcontains $LASTEXITCODE) { throw "node $Cli $($CliArgs -join ' ') 失败 (exit $LASTEXITCODE): $output" }
  return $output
}

$work = Join-Path $root $WorkDir
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null

Write-Host '--- 1. 解压发行包（模拟另一台机器）---'
Expand-Archive -Path (Join-Path $root $Bundle) -DestinationPath $work -Force
$pkgDir = (Get-ChildItem $work -Directory | Where-Object { $_.Name -like 'dsh-link-*' } | Select-Object -First 1).FullName
Check '解压出 dsh-link 目录' ($null -ne $pkgDir) $work
$cli = Join-Path $pkgDir 'bin\dshlink.mjs'
$shared = Join-Path $work 'shared'
New-Item -ItemType Directory -Force -Path $shared | Out-Null
Set-Content -Path (Join-Path $shared 'from-export.txt') -Value 'payload from the exported package' -NoNewline -Encoding ASCII
$dataDir = Join-Path $work 'data'

Write-Host '--- 2. 运行包内 install.ps1 ---'
$installOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkgDir 'install.ps1') -Name 'export-peer' -Port $Port -DataDir $dataDir -Root "ws=$shared" -NoInvite 2>&1 | Out-String
Check 'install.ps1 执行成功' ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $dataDir 'dshlink.config.json'))) $installOut.Substring(0, [Math]::Min(400, $installOut.Length))

Write-Host '--- 3. 启动包内节点（计划任务，测试后注销）---'
$taskName = 'dshlink-bundle-verify'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument ('"' + $cli + '" serve --data-dir "' + $dataDir + '"') -WorkingDirectory $pkgDir
Register-ScheduledTask -TaskName $taskName -Action $action -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 300
  try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2).ok) { $up = $true; break } } catch { }
}
Check '包内节点启动并健康' $up "http://127.0.0.1:$Port/healthz"

try {
  Write-Host '--- 4. 与本机既有节点互相配对（invite / accept --reply）---'
  $invite = (Run-Node (Join-Path $root 'bin\dshlink.mjs') @('invite', '--data-dir', $PeerDataDir, '--json') | ConvertFrom-Json).code
  [System.IO.File]::WriteAllText((Join-Path $work 'invite-prod.txt'), $invite)
  $accepted = Run-Node $cli @('peers', 'accept', '--data-dir', $dataDir, '--invite', "@$(Join-Path $work 'invite-prod.txt')", '--reply', '--json') | ConvertFrom-Json
  Check '包内节点接受了配对码' ($accepted.action -in @('added', 'updated') -and $accepted.peer.hasToken -ne $false) (ConvertTo-Json $accepted -Compress)
  [System.IO.File]::WriteAllText((Join-Path $work 'invite-export.txt'), $accepted.replyCode)
  $back = Run-Node (Join-Path $root 'bin\dshlink.mjs') @('peers', 'accept', '--data-dir', $PeerDataDir, '--invite', "@$(Join-Path $work 'invite-export.txt')", '--json') | ConvertFrom-Json
  Check '本机节点接受了回执' ($back.peer.name -eq 'export-peer') (ConvertTo-Json $back -Compress)

  Write-Host '--- 5. 跨节点发消息 + 拉文件 ---'
  $send = Run-Node (Join-Path $root 'bin\dshlink.mjs') @('send', '--data-dir', $PeerDataDir, '--to', 'export-peer', '--subject', 'bundle check', '--body', 'hello from the packaged peer', '--json') | ConvertFrom-Json
  Check '消息投递成功' ($send.delivery.state -eq 'delivered') (ConvertTo-Json $send.delivery -Compress)
  $inbox = Run-Node $cli @('inbox', '--data-dir', $dataDir, '--json') | ConvertFrom-Json
  Check '包内节点收到消息' ($inbox.count -ge 1 -and $inbox.messages[0].body -like '*packaged peer*') (ConvertTo-Json $inbox.count -Compress)

  $out = Join-Path $work 'pulled.txt'
  $pull = Run-Node (Join-Path $root 'bin\dshlink.mjs') @('pull', '--data-dir', $PeerDataDir, '--peer', 'export-peer', '--root', 'ws', '--path', 'from-export.txt', '--out', $out, '--json') | ConvertFrom-Json
  Check '从包内节点拉文件（sha256 校验）' ($pull.verified -eq $true -and (Get-Content $out -Raw) -eq 'payload from the exported package') (ConvertTo-Json $pull -Compress)

  $ls = Run-Node $cli @('status', '--data-dir', $dataDir, '--probe', '--json') | ConvertFrom-Json
  Check '包内节点能看到对端' ($ls.peers.Count -ge 1) (ConvertTo-Json $ls.peers -Compress)
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  # Unregistering a task does not stop the process it started.
  $verifyPid = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
  if ($verifyPid) { Stop-Process -Id $verifyPid -Force -ErrorAction SilentlyContinue }
  # Leave the production node exactly as we found it: forget the test peer and its queue.
  & node (Join-Path $root 'bin\dshlink.mjs') outbox drop --data-dir $PeerDataDir --to export-peer | Out-Null
  & node (Join-Path $root 'bin\dshlink.mjs') peers rm --data-dir $PeerDataDir export-peer | Out-Null
  if ($Keep) { Write-Host "保留验证目录：$work" -ForegroundColor Gray }
  else { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($failures) { Write-Host "$failures 项验证失败" -ForegroundColor Red; exit 1 }
Write-Host '发行包验证全部通过' -ForegroundColor Green
