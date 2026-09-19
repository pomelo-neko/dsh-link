<#
  install-bridge.ps1 —— 把 dsh-link-bridge（收到消息自动唤醒对话）装进某个 DSH profile。
  做两件事：
    1) dsh plugin --profile <p> add link:<本目录>         （把插件包装进 profile）
    2) dshlink install-dsh --bridge --bridge-workspace …  （写 profile patch 条目，自动备份）
  用法：
    powershell -ExecutionPolicy Bypass -File install-bridge.ps1 -Workspace D:\dshlink-bridge
    powershell -ExecutionPolicy Bypass -File install-bridge.ps1 -Workspace D:\dshlink-bridge -Profile web -Poll 15 -DshHome D:\DSH
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [string]$Profile = 'web',
  [string]$DshHome = '',
  [string]$SessionId = '',
  [int]$Poll = 15,
  [int]$Cooldown = 30
)
$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$linkDir = Split-Path (Split-Path $pluginDir -Parent) -Parent
$cli = Join-Path $linkDir 'bin\dshlink.mjs'
if (-not (Test-Path $cli)) { throw "找不到 dsh-link CLI：$cli（install-bridge.ps1 要放在 dsh-link/integrations/dsh-link-bridge/ 里）" }
$spec = 'link:' + $pluginDir.Replace('\', '/')

Write-Host "[1/2] 把插件包安装到 profile '$Profile'"
$pluginArgs = @('plugin', '--profile', $Profile, 'add', $spec)
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
  & $dsh.Source @pluginArgs
} elseif ($DshHome -and (Test-Path (Join-Path $DshHome 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
  & node (Join-Path $DshHome 'node_modules/@deepseek-ai/dsh/lib/bin.js') @pluginArgs
} else {
  Write-Warning '没找到 dsh 命令，也没有可用的 -DshHome；请手动执行下面的命令后再继续：'
  Write-Host "  dsh plugin --profile $Profile add $spec"
}
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

Write-Host "[2/2] 写入 profile patch 配置"
$cliArgs = @($cli, 'install-dsh', '--profile', $Profile, '--bridge', '--bridge-workspace', $Workspace, '--bridge-poll', "$Poll", '--bridge-cooldown', "$Cooldown", '--write')
if ($DshHome) { $cliArgs += @('--dsh-home', $DshHome) }
if ($SessionId) { $cliArgs += @('--bridge-session', $SessionId) }
& node @cliArgs
if ($LASTEXITCODE -ne 0) { throw "install-dsh 失败（exit $LASTEXITCODE）" }

Write-Host ''
Write-Host '完成。还差一步：重启一次 DSH host（新插件条目在启动时装载）' -ForegroundColor Yellow
Write-Host "  dsh $Profile"
Write-Host ''
Write-Host '验证（发出第一条远端消息后）：'
Write-Host '  1) 心跳文件 $DSH_HOME/plugin-data/dsh-link-bridge/state.json 的 mtime 一直在动'
Write-Host '  2) host 控制台出现 dsh-link-bridge 的 watching / woke session 日志'
Write-Host '  3) 侧边栏出现该 workspace 下的新对话，且 agent 开始按消息内容干活'
