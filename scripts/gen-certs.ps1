<#
  gen-certs.ps1 - create a CA, a server certificate and per-machine client certificates for frp
  mTLS (mutual TLS) on Windows. frp works without this; mTLS is the "extra" hardening step in
  docs/FRP.md.

    powershell -ExecutionPolicy Bypass -File .\scripts\gen-certs.ps1 -ServerName 203.0.113.10
    powershell -ExecutionPolicy Bypass -File .\scripts\gen-certs.ps1 -ServerName frps.example.com -Clients alice-pc,bob-pc

  Needs openssl 1.1+; Git for Windows ships one and this script finds it via git even when
  openssl is not on PATH. The equivalent POSIX script is scripts/gen-certs.sh.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ServerName,
  [string]$CertDir = 'certs',
  [string[]]$Clients = @('client-a', 'client-b'),
  [int]$Days = 825
)

$ErrorActionPreference = 'Stop'

function Find-OpenSsl {
  $cmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = @()
  # Git for Windows ships openssl; derive its location from git itself so a non-default
  # install drive (D:\Program Files\Git, ...) still works.
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git -and $git.Source) {
    $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
    $candidates += (Join-Path $gitRoot 'usr\bin\openssl.exe')
    $candidates += (Join-Path $gitRoot 'mingw64\bin\openssl.exe')
  }
  $candidates += @(
    'C:\Program Files\Git\usr\bin\openssl.exe',
    'C:\Program Files\Git\mingw64\bin\openssl.exe',
    'D:\Program Files\Git\usr\bin\openssl.exe',
    'D:\Program Files\Git\mingw64\bin\openssl.exe',
    'C:\Program Files\OpenSSL-Win64\bin\openssl.exe',
    'C:\Program Files (x86)\OpenSSL-Win32\bin\openssl.exe'
  )
  foreach ($candidate in $candidates) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
  return $null
}

$openssl = Find-OpenSsl
if (-not $openssl) {
  throw 'openssl not found. Install Git for Windows (it ships usr/bin/openssl.exe) or OpenSSL, then rerun. mTLS is optional: skip it and frp still works.'
}
Write-Host ">>> openssl: $openssl"

# Arguments are passed as one array: PowerShell would otherwise try to bind "-out", "-key", ...
# to this function's own parameters.
function Invoke-OpenSsl {
  param([string[]]$OsslArgs)
  & $openssl @OsslArgs
  if ($LASTEXITCODE -ne 0) { throw "openssl failed: $($OsslArgs -join ' ')" }
}

if ($ServerName -match '^\d+\.\d+\.\d+\.\d+$') { $San = "IP:$ServerName" } else { $San = "DNS:$ServerName" }

New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
Push-Location $CertDir
try {
  Write-Host '>>> CA (4096-bit, 10 years)'
  if (Test-Path 'ca.key') {
    Write-Host '    ca.key already exists - reusing it (delete ca.key/ca.crt to start over)'
  } else {
    Invoke-OpenSsl @('genrsa', '-out', 'ca.key', '4096')
    Invoke-OpenSsl @('req', '-x509', '-new', '-nodes', '-key', 'ca.key', '-sha256', '-days', '3650', '-subj', '/CN=frp-local-ca', '-out', 'ca.crt')
  }

  Write-Host ">>> server certificate for $ServerName"
  Invoke-OpenSsl @('genrsa', '-out', 'server.key', '2048')
  Invoke-OpenSsl @('req', '-new', '-key', 'server.key', '-subj', "/CN=$ServerName", '-out', 'server.csr')
  $serverExt = @("subjectAltName=$San", 'extendedKeyUsage=serverAuth') -join [Environment]::NewLine
  Set-Content -Path server.ext -Value $serverExt -NoNewline
  Invoke-OpenSsl @('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', "$Days", '-sha256', '-extfile', 'server.ext')

  # "powershell -File script.ps1 -Clients a,b" hands over ONE string, while a direct
  # PowerShell call hands over an array — split on commas so both spellings work.
  $clientList = @()
  foreach ($entry in $Clients) {
    foreach ($item in ($entry -split ',')) {
      $trimmed = $item.Trim()
      if ($trimmed) { $clientList += $trimmed }
    }
  }
  if (-not $clientList.Count) { throw 'no client names given (-Clients a,b)' }

  Write-Host ">>> client certificates: $($clientList -join ', ')"
  foreach ($client in $clientList) {
    Write-Host "    - $client"
    Invoke-OpenSsl @('genrsa', '-out', "$client.key", '2048')
    Invoke-OpenSsl @('req', '-new', '-key', "$client.key", '-subj', "/CN=$client", '-out', "$client.csr")
    Set-Content -Path "$client.ext" -Value 'extendedKeyUsage=clientAuth' -NoNewline
    Invoke-OpenSsl @('x509', '-req', '-in', "$client.csr", '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', "$client.crt", '-days', "$Days", '-sha256', '-extfile', "$client.ext")
  }

  Get-ChildItem -Filter *.csr | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Filter *.ext | Remove-Item -Force -ErrorAction SilentlyContinue

  Write-Host ''
  Write-Host ">>> certs are in $(Get-Location)"
  Get-ChildItem | Select-Object -ExpandProperty Name
  Write-Host ''
  Write-Host 'next steps'
  Write-Host '  1. copy ca.crt to every machine; keep ca.key offline (it can mint new certificates)'
  Write-Host '  2. frps:  uncomment transport.tls.certFile/keyFile/trustedCaFile in the frps config'
  Write-Host "  3. frpc:  uncomment the same three keys and set transport.tls.serverName = $ServerName"
  Write-Host '  4. restart frps and every frpc (dshlink tunnel stop && dshlink tunnel sync on this machine)'
  Write-Host '  5. verify: frpc logs "login to server success" with no x509 errors'
}
finally {
  Pop-Location
}
