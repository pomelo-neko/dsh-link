# hub-daemon.ps1 - keep one dsh-link hub process alive.
#
# Launched hidden by hub-daemon.vbs (normally from the dshlink-hub-autostart scheduled task).
# The daemon is deliberately independent of the DSH host: when the host restarts, the hub and
# this daemon keep running; when the daemon sees the hub exit (or stop answering /healthz) it
# cleans up leftover frpc processes and starts the hub again.
#
# Manual use is possible for debugging:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-daemon.ps1 -InstallDir <tree> -DataDir <dir>
# Stop it through hub-service.ps1 stop, not Ctrl+C (it is designed to be killed as a tree).

[CmdletBinding()]
param(
  [string]$InstallDir,
  [string]$DataDir,
  [int]$RestartDelaySeconds = 10,
  [int]$HealthIntervalSeconds = 20,
  [int]$HealthFailureLimit = 3,
  [int]$KeepLogs = 20
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'hub-service-lib.ps1')

$paths = Resolve-HubPaths -ScriptRoot $PSScriptRoot -InstallDir $InstallDir -DataDir $DataDir
New-Item -ItemType Directory -Force -Path $paths.LogDir | Out-Null
$daemonLog = Join-Path $paths.LogDir 'hub-daemon.log'

function Remove-OldHubLogs {
  param([string]$LogDir, [int]$Keep)
  foreach ($pattern in @('hub-*.out.log', 'hub-*.err.log')) {
    try {
      Get-ChildItem -LiteralPath $LogDir -Filter $pattern -ErrorAction Stop |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $Keep |
        Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
  }
}

$existing = Get-DaemonPid -Paths $paths
if ($existing -gt 0 -and $existing -ne $PID) {
  Write-ServiceLog -LogFile $daemonLog -Message ('another daemon is already running (pid ' + $existing + '); exiting')
  exit 3
}

Set-Content -LiteralPath $paths.DaemonPidFile -Value $PID -Encoding ASCII
Write-ServiceLog -LogFile $daemonLog -Message ('daemon started pid=' + $PID + ' install=' + $paths.InstallDir + ' data=' + $paths.DataDir)

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-ServiceLog -LogFile $daemonLog -Message 'node.exe not found on PATH; cannot start the hub'
  Remove-Item -LiteralPath $paths.DaemonPidFile -Force -ErrorAction SilentlyContinue
  exit 2
}

$consecutiveFailures = 0
try {
  while ($true) {
    $hubPid = 0
    try {
      # A previous hub may have died without its frpc children (or the whole daemon may have
      # been restarted): remove our leftovers before binding the ports again.
      $killed = Stop-HubProcesses -Paths $paths -LogFile $daemonLog
      if ($killed -gt 0) { Start-Sleep -Seconds 1 }

      Remove-OldHubLogs -LogDir $paths.LogDir -Keep $KeepLogs
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $outLog = Join-Path $paths.LogDir ('hub-' + $stamp + '.out.log')
      $errLog = Join-Path $paths.LogDir ('hub-' + $stamp + '.err.log')
      $nodeArgs = @('"' + $paths.Cli + '"', 'hub', 'serve', '--data-dir', '"' + $paths.DataDir + '"')
      $proc = Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $paths.InstallDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
      $hubPid = $proc.Id
      Set-Content -LiteralPath $paths.HubPidFile -Value $hubPid -Encoding ASCII
      Write-ServiceLog -LogFile $daemonLog -Message ('hub started pid=' + $hubPid + ' log=' + (Split-Path -Leaf $outLog))

      $config = Get-HubConfig -ConfigPath $paths.ConfigPath
      $port = Get-HubListenPort -Config $config
      $failures = 0
      $startedAt = Get-Date
      while (-not $proc.HasExited) {
        Start-Sleep -Seconds $HealthIntervalSeconds
        $proc.Refresh()
        if ($proc.HasExited) { break }
        # Give the hub time to bind its ports and connect frpc before judging health.
        if (((Get-Date) - $startedAt).TotalSeconds -lt 45) { continue }
        if (Test-HubHealth -Port $port) { $failures = 0; continue }
        $failures += 1
        Write-ServiceLog -LogFile $daemonLog -Message ('hub pid=' + $hubPid + ' health check failed (' + $failures + '/' + $HealthFailureLimit + ')')
        if ($failures -ge $HealthFailureLimit) {
          Write-ServiceLog -LogFile $daemonLog -Message ('hub pid=' + $hubPid + ' is alive but unhealthy; restarting')
          Stop-ProcessTree -ProcessId $hubPid
          break
        }
      }

      $proc.Refresh()
      $exitCode = $null
      try { $exitCode = $proc.ExitCode } catch { $exitCode = 'unknown' }
      Write-ServiceLog -LogFile $daemonLog -Message ('hub pid=' + $hubPid + ' exited code=' + $exitCode)
      if ($exitCode -ne $null -and "$exitCode" -eq '0') { $consecutiveFailures = 0 }
      else { $consecutiveFailures += 1 }
    } catch {
      Write-ServiceLog -LogFile $daemonLog -Message ('daemon loop error: ' + $_.Exception.Message)
      $consecutiveFailures += 1
    } finally {
      Remove-Item -LiteralPath $paths.HubPidFile -Force -ErrorAction SilentlyContinue
    }

    Stop-HubProcesses -Paths $paths -LogFile $daemonLog | Out-Null
    $delay = $RestartDelaySeconds * [Math]::Pow(2, [Math]::Min($consecutiveFailures, 3))
    if ($delay -gt 60) { $delay = 60 }
    if ($delay -lt $RestartDelaySeconds) { $delay = $RestartDelaySeconds }
    $delay = [int]$delay
    Write-ServiceLog -LogFile $daemonLog -Message ('restarting hub in ' + $delay + 's')
    Start-Sleep -Seconds $delay
  }
} finally {
  Write-ServiceLog -LogFile $daemonLog -Message 'daemon stopped'
  Remove-Item -LiteralPath $paths.DaemonPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $paths.HubPidFile -Force -ErrorAction SilentlyContinue
}
