# Shared helpers for hub-service.ps1 and hub-daemon.ps1.
#
# Windows PowerShell 5.1 compatible. Nothing machine-specific (host name, IP, user path,
# token) belongs in this file: the service scripts are part of the public repository.
# The only defaults are the documented ones: the scripts directory decides the install tree,
# and $env:DSHLINK_HUB_HOME (or %USERPROFILE%\.dshlink-hub) decides the hub data directory.

function Resolve-HubPaths {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptRoot,
    [string]$InstallDir,
    [string]$DataDir
  )
  if (-not $InstallDir) { $InstallDir = Split-Path -Parent $ScriptRoot }
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
  if (-not $DataDir) {
    if ($env:DSHLINK_HUB_HOME) { $DataDir = $env:DSHLINK_HUB_HOME }
    else { $DataDir = Join-Path $env:USERPROFILE '.dshlink-hub' }
  }
  $DataDir = [System.IO.Path]::GetFullPath($DataDir)
  $cli = Join-Path $InstallDir 'bin\dshlink.mjs'
  if (-not (Test-Path -LiteralPath $cli)) {
    throw "dsh-link CLI not found at $cli (pass -InstallDir <repository or deployed tree>)"
  }
  return [pscustomobject]@{
    ScriptRoot    = $ScriptRoot
    InstallDir    = $InstallDir
    DataDir       = $DataDir
    Cli           = $cli
    ConfigPath    = Join-Path $DataDir 'dshlink-hub.config.json'
    LogDir        = Join-Path $DataDir 'logs'
    DaemonPidFile = Join-Path $DataDir 'hub-daemon.pid'
    HubPidFile    = Join-Path $DataDir 'hub.pid'
  }
}

function Get-HubConfig {
  param([string]$ConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  try { return ((Get-Content -LiteralPath $ConfigPath -Raw -ErrorAction Stop) | ConvertFrom-Json) }
  catch { return $null }
}

function Get-HubListenPort {
  param($Config)
  if ($Config -and $Config.port) { return [int]$Config.port }
  return 8790
}

function Get-HubAdminPorts {
  param($Config)
  $ports = @()
  if ($Config) {
    if ($Config.frp -and $Config.frp.adminPort) { $ports += [int]$Config.frp.adminPort }
    if ($Config.phoneFrp -and $Config.phoneFrp.adminPort) { $ports += [int]$Config.phoneFrp.adminPort }
  }
  return $ports
}

function Get-HubHealth {
  param([int]$Port = 8790, [int]$TimeoutSec = 3)
  try {
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec $TimeoutSec -ErrorAction Stop
    if ($health -and $health.ok) { return $health }
  } catch { }
  return $null
}

function Test-HubHealth {
  param([int]$Port = 8790, [int]$TimeoutSec = 3)
  return ($null -ne (Get-HubHealth -Port $Port -TimeoutSec $TimeoutSec))
}

function Wait-HubHealth {
  param([int]$Port = 8790, [int]$Seconds = 30)
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-HubHealth -Port $Port -TimeoutSec 2) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Read-PidFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  try { $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch { return 0 }
  if (-not $raw) { return 0 }
  $value = 0
  if ([int]::TryParse($raw.Trim(), [ref]$value)) { return $value }
  return 0
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  try { Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null; return $true }
  catch { return $false }
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ProcessId) -ErrorAction Stop
    if ($proc) { return [string]$proc.CommandLine }
  } catch { }
  return $null
}

# Run a native command with stderr captured instead of raised: with $ErrorActionPreference
# = 'Stop' (used by both entry scripts), PowerShell 5.1 turns redirected native stderr into
# a terminating error even when it is sent to $null, so "task not found" would abort the caller.
function Invoke-QuietNative {
  param([string]$FilePath, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $FilePath @Arguments 2>&1)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ Output = $output; ExitCode = $code }
}

# The hub CLI invocation contains: node.exe "<...>\bin\dshlink.mjs" hub serve --data-dir <DataDir>.
# Match on the data directory as well, so a second hub started from another data dir is never touched.
function Get-HubNodeProcesses {
  param($Paths)
  $found = @()
  try { $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop) }
  catch { return @() }
  foreach ($proc in $procs) {
    $cmd = [string]$proc.CommandLine
    if (-not $cmd) { continue }
    if ($cmd.IndexOf($Paths.DataDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    if ($cmd -match '(^|\s)hub(\s|$)' -and $cmd -match '(^|\s)serve(\s|$)') { $found += $proc }
  }
  return $found
}

function Get-HubFrpcProcesses {
  param($Paths)
  $found = @()
  try { $procs = @(Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" -ErrorAction Stop) }
  catch { return @() }
  foreach ($proc in $procs) {
    $cmd = [string]$proc.CommandLine
    if (-not $cmd) { continue }
    if ($cmd.IndexOf($Paths.DataDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $found += $proc }
  }
  return $found
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return }
  try { Invoke-QuietNative -FilePath 'taskkill.exe' -Arguments @('/PID', [string]$ProcessId, '/T', '/F') | Out-Null } catch { }
}

# Stop everything that belongs to this hub data directory: the hub's node process, its frpc
# children (also if the hub died without taking them down), and — as a fallback for processes
# whose command line is not readable — frpc instances that still listen on the configured
# frpc admin ports. Never touches the node's own external frpc or other dsh-link processes.
function Stop-HubProcesses {
  param($Paths, [string]$LogFile)
  $stopped = 0
  foreach ($proc in @(Get-HubNodeProcesses -Paths $Paths)) {
    Write-ServiceLog -LogFile $LogFile -Message ('stopping leftover hub node pid=' + $proc.ProcessId)
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    $stopped += 1
  }
  foreach ($proc in @(Get-HubFrpcProcesses -Paths $Paths)) {
    Write-ServiceLog -LogFile $LogFile -Message ('stopping leftover hub frpc pid=' + $proc.ProcessId)
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    $stopped += 1
  }
  $config = Get-HubConfig -ConfigPath $Paths.ConfigPath
  $listenPort = Get-HubListenPort -Config $config
  # Fallback when the command line of the hub process is unreadable (for example a process
  # started by another elevated account): only stop it if /healthz identifies this hub by name.
  if (Test-HubHealth -Port $listenPort -TimeoutSec 2) {
    $expectedName = $null
    if ($config -and $config.name) { $expectedName = [string]$config.name }
    $health = Get-HubHealth -Port $listenPort -TimeoutSec 2
    if ($health -and $expectedName -and ([string]$health.name) -eq $expectedName) {
      try { $conns = @(Get-NetTCPConnection -State Listen -LocalPort $listenPort -ErrorAction Stop) } catch { $conns = @() }
      foreach ($conn in $conns) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
          Write-ServiceLog -LogFile $LogFile -Message ('stopping hub node pid=' + $proc.Id + ' via health/port fallback')
          Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
          $stopped += 1
        }
      }
    }
  }
  foreach ($port in @(Get-HubAdminPorts -Config $config)) {
    try { $conns = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop) } catch { $conns = @() }
    foreach ($conn in $conns) {
      $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'frpc') {
        Write-ServiceLog -LogFile $LogFile -Message ('stopping hub frpc pid=' + $proc.Id + ' on admin port ' + $port)
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $stopped += 1
      }
    }
  }
  return $stopped
}

function Get-HubTask {
  param([string]$TaskName)
  $result = [pscustomobject]@{ Installed = $false; State = $null; Enabled = $null; NextRunTime = $null }
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $result.Installed = $true
    $result.State = [string]$task.State
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($info -and $info.NextRunTime -and $info.NextRunTime.Year -gt 1900) { $result.NextRunTime = $info.NextRunTime }
    $result.Enabled = ($task.State -ne 'Disabled')
  } catch {
    $query = Invoke-QuietNative -FilePath 'schtasks.exe' -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST')
    if ($query.ExitCode -eq 0) {
      $result.Installed = $true
      foreach ($line in @($query.Output)) {
        if ($line -match '^\s*(Status|状态)\s*[:：]\s*(.+)$') { $result.State = $Matches[2].Trim() }
        if ($line -match '^\s*(Next Run Time|下次运行时间)\s*[:：]\s*(.+)$') { $result.NextRunTime = $Matches[2].Trim() }
      }
      if ($result.State) { $result.Enabled = -not ($result.State -match 'Disabled|禁用') }
    }
  }
  return $result
}

function Enable-HubTask {
  param([string]$TaskName)
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null; return $true } catch { }
  $result = Invoke-QuietNative -FilePath 'schtasks.exe' -Arguments @('/Change', '/TN', $TaskName, '/ENABLE')
  return ($result.ExitCode -eq 0)
}

function Disable-HubTask {
  param([string]$TaskName)
  try { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null; return $true } catch { }
  $result = Invoke-QuietNative -FilePath 'schtasks.exe' -Arguments @('/Change', '/TN', $TaskName, '/DISABLE')
  return ($result.ExitCode -eq 0)
}

function Start-HubTask {
  param([string]$TaskName)
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; return $true } catch { }
  $result = Invoke-QuietNative -FilePath 'schtasks.exe' -Arguments @('/Run', '/TN', $TaskName)
  return ($result.ExitCode -eq 0)
}

function Unregister-HubTask {
  param([string]$TaskName)
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; return $true } catch { }
  $result = Invoke-QuietNative -FilePath 'schtasks.exe' -Arguments @('/Delete', '/TN', $TaskName, '/F')
  return ($result.ExitCode -eq 0)
}

function Get-DaemonPid {
  param($Paths)
  $pidValue = Read-PidFile -Path $Paths.DaemonPidFile
  if (-not (Test-ProcessAlive -ProcessId $pidValue)) { return 0 }
  $cmd = Get-ProcessCommandLine -ProcessId $pidValue
  if ($cmd -and $cmd.IndexOf('hub-daemon.ps1', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return 0 }
  return $pidValue
}

function Test-DaemonRunning {
  param($Paths)
  return ((Get-DaemonPid -Paths $Paths) -gt 0)
}

function Write-ServiceLog {
  param([string]$LogFile, [string]$Message)
  if (-not $LogFile) { return }
  try {
    Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Message) -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch { }
}
