# hub-service.ps1 - install, start, stop and inspect the dsh-link hub auto-start service (Windows).
#
# The hub used to be started by hand (or as a child of the DSH host), so restarting the DSH host
# silently took the hub offline. This script registers a logon scheduled task that starts a hidden
# daemon (hub-daemon.ps1); the daemon keeps exactly one hub process alive and restarts it after a
# crash or a failed health check. Everything is independent of both DSH and its host process.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-service.ps1 status
#   powershell ... -File scripts\hub-service.ps1 install        # register + start
#   powershell ... -File scripts\hub-service.ps1 stop           # stop now and disable auto-start
#   powershell ... -File scripts\hub-service.ps1 start          # enable auto-start + start now
#   powershell ... -File scripts\hub-service.ps1 restart
#   powershell ... -File scripts\hub-service.ps1 disable        # keep running, no auto-start
#   powershell ... -File scripts\hub-service.ps1 enable
#   powershell ... -File scripts\hub-service.ps1 uninstall      # stop + remove the task
#
# Optional parameters: -InstallDir <repo or deployed tree> (default: parent of this script),
# -DataDir <hub data dir> (default: $env:DSHLINK_HUB_HOME or %USERPROFILE%\.dshlink-hub),
# -TaskName <name> (default: dshlink-hub-autostart), -WaitSeconds <health wait>, -Json (status).
#
# "stop" also disables the scheduled task, because a disabled daemon would otherwise be resurrected
# by the periodic top-up trigger within 15 minutes. "start" re-enables it.

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'start', 'stop', 'restart', 'install', 'uninstall', 'enable', 'disable', 'run-task')]
  [string]$Action = 'status',
  [string]$InstallDir,
  [string]$DataDir,
  [string]$TaskName = 'dshlink-hub-autostart',
  [switch]$NoStart,
  [switch]$Json,
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hub-service-lib.ps1')
$script:JsonOutput = [bool]$Json

function Note {
  param([string]$Text)
  if (-not $script:JsonOutput) { Write-Host $Text }
}

function Get-HubServiceStatus {
  param($Paths, [string]$TaskName)
  $config = Get-HubConfig -ConfigPath $Paths.ConfigPath
  $port = Get-HubListenPort -Config $config
  $health = Get-HubHealth -Port $port -TimeoutSec 3
  $daemonPid = Get-DaemonPid -Paths $Paths
  $hubPid = Read-PidFile -Path $Paths.HubPidFile
  $hubRunning = Test-ProcessAlive -ProcessId $hubPid
  if (-not $hubRunning) {
    try {
      $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -First 1
      if ($conn) { $hubPid = [int]$conn.OwningProcess; $hubRunning = $true }
    } catch { }
  }
  $task = Get-HubTask -TaskName $TaskName
  $hubName = $null
  $hubVersion = $null
  if ($health) {
    $hubName = [string]$health.name
    $hubVersion = [string]$health.version
  }
  $latestHubLog = $null
  try {
    $latest = Get-ChildItem -LiteralPath $Paths.LogDir -Filter 'hub-*.out.log' -ErrorAction Stop |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) { $latestHubLog = $latest.FullName }
  } catch { }
  return [pscustomobject]@{
    action        = 'status'
    taskName      = $TaskName
    taskInstalled = [bool]$task.Installed
    taskState     = $task.State
    taskEnabled   = $task.Enabled
    nextRunTime   = $task.NextRunTime
    daemonPid     = [int]$daemonPid
    daemonRunning = ($daemonPid -gt 0)
    hubPid        = [int]$hubPid
    hubRunning    = [bool]$hubRunning
    hubHealthy    = ($null -ne $health)
    hubName       = $hubName
    hubVersion    = $hubVersion
    hubPort       = $port
    installDir    = $Paths.InstallDir
    dataDir       = $Paths.DataDir
    daemonLog     = (Join-Path $Paths.LogDir 'hub-daemon.log')
    latestHubLog  = $latestHubLog
  }
}

function Show-HubServiceStatus {
  param($Paths, [string]$TaskName)
  $status = Get-HubServiceStatus -Paths $Paths -TaskName $TaskName
  if ($script:JsonOutput) {
    $status | ConvertTo-Json -Depth 6
    return
  }
  $taskText = 'not installed'
  if ($status.taskInstalled) {
    $taskText = 'installed, state=' + $status.taskState
    if ($status.taskEnabled -eq $false) { $taskText = $taskText + ', auto-start disabled' }
  }
  $daemonText = 'not running'
  if ($status.daemonRunning) { $daemonText = 'running, pid=' + $status.daemonPid }
  $hubText = 'not healthy'
  if ($status.hubHealthy) {
    $hubText = 'healthy, http://127.0.0.1:' + $status.hubPort
    if ($status.hubName) { $hubText = $hubText + ' (' + $status.hubName + ' ' + $status.hubVersion + ')' }
  } elseif ($status.hubRunning) {
    $hubText = 'process running (pid=' + $status.hubPid + ') but /healthz did not answer'
  }
  Write-Host ('task          : ' + $TaskName + ' — ' + $taskText)
  Write-Host ('daemon        : ' + $daemonText)
  Write-Host ('hub           : ' + $hubText)
  if ($status.nextRunTime) { Write-Host ('next run      : ' + $status.nextRunTime) }
  Write-Host ('install dir   : ' + $status.installDir)
  Write-Host ('data dir      : ' + $status.dataDir)
  Write-Host ('daemon log    : ' + $status.daemonLog)
  if ($status.latestHubLog) { Write-Host ('latest hub log: ' + $status.latestHubLog) }
}

function Install-HubService {
  param($Paths, [string]$TaskName, [switch]$NoStart)
  $task = Get-HubTask -TaskName $TaskName
  if ($task.Installed) { Note ('replacing existing scheduled task ' + $TaskName) }
  if (-not (Test-Path -LiteralPath $Paths.ConfigPath)) {
    Note ('warning: hub config not found at ' + $Paths.ConfigPath)
    Note '         initialize the hub first, for example: node bin\dshlink.mjs hub init --name <name> ...'
  }
  $vbs = Join-Path $Paths.ScriptRoot 'hub-daemon.vbs'
  if (-not (Test-Path -LiteralPath $vbs)) { throw ('missing ' + $vbs) }
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $actionArgument = '"' + $vbs + '" "' + $Paths.InstallDir + '" "' + $Paths.DataDir + '"'
  $taskAction = New-ScheduledTaskAction -Execute $wscript -Argument $actionArgument -WorkingDirectory $Paths.InstallDir
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $triggers = @()
  $triggers += New-ScheduledTaskTrigger -AtLogOn -User $user
  try {
    # Top-up: if the daemon dies, the next 15-minute tick brings it back. StartWhenAvailable
    # covers a missed tick after sleep/hibernate.
    $triggers += New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 15)
  } catch {
    Note 'periodic top-up trigger is not available here; using the logon trigger only'
  }
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $triggers -Settings $settings -Principal $principal -Description 'Keep the dsh-link hub process online: starts a hidden daemon that restarts the hub after it exits or stops answering health checks.' -Force | Out-Null
  Note ('installed scheduled task ' + $TaskName)
  Note ('  action: ' + $wscript + ' ' + $actionArgument)
  if (-not $NoStart) {
    $healthy = Start-HubService -Paths $Paths -TaskName $TaskName -WaitSeconds $WaitSeconds
    if (-not $healthy) { return $false }
  }
  return $true
}

function Start-HubService {
  param($Paths, [string]$TaskName, [int]$WaitSeconds)
  $task = Get-HubTask -TaskName $TaskName
  if (-not $task.Installed) {
    Note ('auto-start task ' + $TaskName + ' is not installed; run: scripts\hub-service.ps1 install')
    return $false
  }
  if ($task.Enabled -eq $false) {
    if (Enable-HubTask -TaskName $TaskName) { Note ('enabled auto-start task ' + $TaskName) }
    else { Note ('could not enable scheduled task ' + $TaskName); return $false }
  }
  $daemonPid = Get-DaemonPid -Paths $Paths
  if ($daemonPid -gt 0) {
    Note ('daemon already running (pid ' + $daemonPid + ')')
  } else {
    Note ('starting the daemon through scheduled task ' + $TaskName)
    if (-not (Start-HubTask -TaskName $TaskName)) { Note 'failed to start the scheduled task'; return $false }
  }
  $config = Get-HubConfig -ConfigPath $Paths.ConfigPath
  $port = Get-HubListenPort -Config $config
  if (Wait-HubHealth -Port $port -Seconds $WaitSeconds) {
    Note ('hub is healthy on http://127.0.0.1:' + $port)
    return $true
  }
  Note ('hub did not become healthy within ' + $WaitSeconds + 's')
  Note ('check ' + (Join-Path $Paths.LogDir 'hub-daemon.log') + ' and the newest hub-*.out.log')
  return $false
}

function Stop-HubService {
  param($Paths, [string]$TaskName)
  $task = Get-HubTask -TaskName $TaskName
  if ($task.Installed -and $task.Enabled -ne $false) {
    if (Disable-HubTask -TaskName $TaskName) {
      Note ('disabled auto-start task ' + $TaskName + ' so it cannot restart the hub')
    }
  }
  $daemonPid = Get-DaemonPid -Paths $Paths
  if ($daemonPid -gt 0) {
    Note ('stopping daemon pid=' + $daemonPid)
    Stop-ProcessTree -ProcessId $daemonPid
    Start-Sleep -Seconds 1
  }
  $killed = Stop-HubProcesses -Paths $Paths -LogFile (Join-Path $Paths.LogDir 'hub-daemon.log')
  if ($killed -gt 0) { Note ('stopped ' + $killed + ' leftover hub process(es)') }

  $config = Get-HubConfig -ConfigPath $Paths.ConfigPath
  $port = Get-HubListenPort -Config $config
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $listening = $false
    try {
      $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
      if ($conn) { $listening = $true }
    } catch { $listening = $false }
    if (-not $listening -and -not (Test-HubHealth -Port $port -TimeoutSec 1)) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  Note 'hub is stopped'
  return $true
}

function Uninstall-HubService {
  param($Paths, [string]$TaskName)
  Stop-HubService -Paths $Paths -TaskName $TaskName | Out-Null
  $task = Get-HubTask -TaskName $TaskName
  if ($task.Installed) {
    if (Unregister-HubTask -TaskName $TaskName) { Note ('removed scheduled task ' + $TaskName) }
    else { Note ('could not remove scheduled task ' + $TaskName); return $false }
  } else {
    Note ('scheduled task ' + $TaskName + ' is not installed')
  }
  return $true
}

$exitCode = 0
try {
  $paths = Resolve-HubPaths -ScriptRoot $PSScriptRoot -InstallDir $InstallDir -DataDir $DataDir
  New-Item -ItemType Directory -Force -Path $paths.LogDir | Out-Null
  $ok = $true
  switch ($Action) {
    'status' {
      Show-HubServiceStatus -Paths $paths -TaskName $TaskName
    }
    'install' {
      $ok = Install-HubService -Paths $paths -TaskName $TaskName -NoStart:$NoStart
      if ($ok) { Show-HubServiceStatus -Paths $paths -TaskName $TaskName }
    }
    'start' {
      $ok = Start-HubService -Paths $paths -TaskName $TaskName -WaitSeconds $WaitSeconds
      if ($ok) { Show-HubServiceStatus -Paths $paths -TaskName $TaskName }
    }
    'run-task' {
      $ok = Start-HubService -Paths $paths -TaskName $TaskName -WaitSeconds $WaitSeconds
      if ($ok) { Show-HubServiceStatus -Paths $paths -TaskName $TaskName }
    }
    'stop' {
      $ok = Stop-HubService -Paths $paths -TaskName $TaskName
      Show-HubServiceStatus -Paths $paths -TaskName $TaskName
    }
    'restart' {
      Stop-HubService -Paths $paths -TaskName $TaskName | Out-Null
      $ok = Start-HubService -Paths $paths -TaskName $TaskName -WaitSeconds $WaitSeconds
      if ($ok) { Show-HubServiceStatus -Paths $paths -TaskName $TaskName }
    }
    'uninstall' {
      $ok = Uninstall-HubService -Paths $paths -TaskName $TaskName
      Show-HubServiceStatus -Paths $paths -TaskName $TaskName
    }
    'enable' {
      $task = Get-HubTask -TaskName $TaskName
      if (-not $task.Installed) { Note ('scheduled task ' + $TaskName + ' is not installed; run install first'); $ok = $false }
      elseif (Enable-HubTask -TaskName $TaskName) { Note ('enabled auto-start task ' + $TaskName) }
      else { Note ('could not enable scheduled task ' + $TaskName); $ok = $false }
      Show-HubServiceStatus -Paths $paths -TaskName $TaskName
    }
    'disable' {
      $task = Get-HubTask -TaskName $TaskName
      if (-not $task.Installed) { Note ('scheduled task ' + $TaskName + ' is not installed'); $ok = $false }
      elseif (Disable-HubTask -TaskName $TaskName) { Note ('disabled auto-start task ' + $TaskName + '; the running daemon is not stopped (use stop)') }
      else { Note ('could not disable scheduled task ' + $TaskName); $ok = $false }
      Show-HubServiceStatus -Paths $paths -TaskName $TaskName
    }
  }
  if (-not $ok) { $exitCode = 1 }
} catch {
  Write-Error ('hub-service: ' + $_.Exception.Message)
  $exitCode = 1
}
exit $exitCode
