<#
  dsh-link 客户端安装脚本（Windows PowerShell 5.1+）
  例：
    powershell -ExecutionPolicy Bypass -File install.ps1 -Name my-pc -ShareWorkspace -Task
    powershell -ExecutionPolicy Bypass -File install.ps1 -Name my-pc -Root "drop=D:\drop:rw" -AllowUpload -InstallDsh -DshHome D:\DSH
#>
[CmdletBinding()]
param(
  [string]$Name = "$env:COMPUTERNAME-win",
  [int]$Port = 8787,
  [string[]]$Root = @(),
  [switch]$ShareWorkspace,
  [switch]$AllowUpload,
  [string]$DataDir = (Join-Path $env:USERPROFILE '.dshlink'),
  [switch]$Task,
  [string]$FrpServer,
  [string]$FrpToken,
  [string]$FrpcPath,
  [switch]$InstallDsh,
  [string]$Profile = 'web',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$NoInvite
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $here 'bin\dshlink.mjs'
if (-not (Test-Path $cli)) { throw "找不到 $cli --- 请在解压出来的 dsh-link 目录里运行本脚本" }

function Invoke-Cli {
  param([string[]]$CliArgs)
  $output = & node $cli @CliArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw ("dshlink " + ($CliArgs -join ' ') + " 失败 (exit " + $LASTEXITCODE + "): " + $output) }
  return $output
}

$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw '未找到 node --- 请先安装 Node.js 20 或更高版本 (https://nodejs.org)' }
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js $nodeVersion 太旧，需要 20+" }

$configFile = Join-Path $DataDir 'dshlink.config.json'
if (Test-Path $configFile) {
  Write-Host "[1/5] 已存在配置 $configFile --- 跳过 init（要重装请先删除该文件）" -ForegroundColor Yellow
} else {
  $rootArgs = @()
  foreach ($r in $Root) { $rootArgs += @('--root', $r) }
  if ($rootArgs.Count -eq 0 -or $ShareWorkspace) { $rootArgs += @('--root', 'ws=' + (Get-Location).Path) }
  $initArgs = @('init', '--name', $Name, '--port', "$Port", '--data-dir', $DataDir, '--json') + $rootArgs
  if ($AllowUpload) { $initArgs += '--allow-upload' }
  Invoke-Cli -CliArgs $initArgs | Out-Null
  Write-Host "[1/5] 已初始化节点 $Name（数据目录 $DataDir，端口 $Port）" -ForegroundColor Green
}

if ($FrpServer) {
  $tunnelArgs = @('tunnel', 'setup', '--data-dir', $DataDir, '--server', $FrpServer)
  if ($FrpToken) { $tunnelArgs += @('--token', $FrpToken) }
  if ($FrpcPath) { $tunnelArgs += @('--frpc', $FrpcPath) }
  Invoke-Cli -CliArgs $tunnelArgs | Out-Null
  Invoke-Cli -CliArgs @('tunnel', 'sync', '--data-dir', $DataDir) | Out-Null
  Write-Host '[2/5] 已配置 FRP 客户端并启动 frpc' -ForegroundColor Green
} else {
  Write-Host '[2/5] 未指定 -FrpServer --- 跳过穿透（局域网直连，或以后用 tunnel setup 再加）' -ForegroundColor Yellow
}

if ($Task) {
  $taskName = 'dshlink-node'
  $serveArgs = '"' + $cli + '" serve --data-dir "' + $DataDir + '" --auto-sync 60'
  $action = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument $serveArgs -WorkingDirectory $here
  Register-ScheduledTask -TaskName $taskName -Action $action -Description 'dsh-link node (MCP + peer messaging)' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
  Write-Host "[3/5] 已注册并启动计划任务 $taskName" -ForegroundColor Green
} else {
  Write-Host '[3/5] 未注册常驻服务；手动启动：node bin\dshlink.mjs serve' -ForegroundColor Yellow
}

if ($InstallDsh) {
  Invoke-Cli -CliArgs @('install-dsh', '--profile', $Profile, '--dsh-home', $DshHome, '--write') | Out-Null
  Write-Host "[4/5] 已写入 DSH profile 的 MCP 条目并安装技能（$DshHome）" -ForegroundColor Green
} else {
  Write-Host '[4/5] 未接入 DSH；以后可运行：node bin\dshlink.mjs install-dsh --write' -ForegroundColor Yellow
}

if (-not $NoInvite) {
  $invite = Invoke-Cli -CliArgs @('invite', '--data-dir', $DataDir)
  Write-Host '[5/5] 配对码（发给要互联的那台机器，注意它含密钥）：' -ForegroundColor Cyan
  Write-Host $invite
} else {
  Write-Host '[5/5] 已跳过配对码（node bin\dshlink.mjs invite 可随时生成）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '自检：node bin\dshlink.mjs doctor' -ForegroundColor Gray
