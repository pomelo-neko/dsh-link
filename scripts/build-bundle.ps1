<#
  build-bundle.ps1 --- 打包 dsh-link 客户端发行包
  产物（dist/）：
    dsh-link-<版本>-portable.zip       （Windows 友好）
    dsh-link-<版本>-portable.tar.gz    （Linux/WSL 友好，含可执行位）
    SHA256SUMS.txt                     （两个包各自的 sha256）
  包内容：bin src docs integrations test + README + install.ps1/install.sh，
          vendor/frp 只含 frpc（Windows + Linux）——frps 属于服务器侧，不入包。
  用法：powershell -ExecutionPolicy Bypass -File scripts\build-bundle.ps1 [-NoVendor] [-Suffix -src]
        -NoVendor 只打源码（约 0.1 MB，对方自备 frpc）；-Suffix 给产物名加后缀，避免覆盖完整包。
#>
[CmdletBinding()]
param(
  [switch]$NoVendor,
  [string]$Suffix = '',
  [string]$OutDir = 'dist'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
# The runtime version lives in src/util.mjs (DSHLINK_VERSION); package.json must match it.
$utilSource = Get-Content (Join-Path $root 'src\util.mjs') -Raw
if ($utilSource -match "DSHLINK_VERSION\s*=\s*'([^']+)'") {
  $version = $Matches[1]
  if ($pkg.version -ne $version) {
    Write-Warning "package.json says $($pkg.version) but src/util.mjs says $version — using $version（请同步 package.json）"
  }
} else {
  $version = $pkg.version
}
$name = "dsh-link-$version$Suffix"
$stageRoot = Join-Path $root "$OutDir\stage"
$stage = Join-Path $stageRoot $name

Write-Host "[1/5] 清理暂存目录 $stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host '[2/5] 复制源码与文档（客户端组件）'
foreach ($dir in 'bin', 'src', 'docs', 'integrations', 'test') {
  Copy-Item -Recurse -Force (Join-Path $root $dir) (Join-Path $stage $dir)
}
foreach ($file in 'README.md', 'package.json', '.gitignore') {
  Copy-Item -Force (Join-Path $root $file) (Join-Path $stage $file)
}
foreach ($file in 'install.ps1', 'install.sh', 'README-FIRST.md', 'PAIRING.md') {
  Copy-Item -Force (Join-Path $root "packaging\$file") (Join-Path $stage $file)
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'scripts') | Out-Null
foreach ($file in 'start-dshlink.ps1', 'start-dshlink.vbs', 'start-dshlink.cmd') {
  Copy-Item -Force (Join-Path $root "scripts\$file") (Join-Path $stage 'scripts')
}
Remove-Item -Recurse -Force (Join-Path $stage 'test\.tmp') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $stage 'integrations\wan-lab') -ErrorAction SilentlyContinue

if (-not $NoVendor) {
  Write-Host '[3/5] 放入 FRP 客户端（frpc，Windows + Linux；不含 frps）'
  $winDir = Join-Path $stage 'vendor\frp\windows-amd64'
  $nixDir = Join-Path $stage 'vendor\frp\linux-amd64'
  New-Item -ItemType Directory -Force -Path $winDir, $nixDir | Out-Null
  Copy-Item -Force (Join-Path $root 'vendor\frp\windows-amd64\frpc.exe') $winDir
  Copy-Item -Force (Join-Path $root 'vendor\frp\linux-amd64\frpc') $nixDir
  # The frp binaries are UNSIGNED: antivirus products (Huorong/火绒 …) sometimes block or
  # quarantine them, which used to produce a silently half-empty bundle. Fail loudly instead.
  $vendorPairs = @(
    @{ staged = (Join-Path $winDir 'frpc.exe'); source = (Join-Path $root 'vendor\frp\windows-amd64\frpc.exe') },
    @{ staged = (Join-Path $nixDir 'frpc'); source = (Join-Path $root 'vendor\frp\linux-amd64\frpc') }
  )
  foreach ($pair in $vendorPairs) {
    if (-not (Test-Path $pair.staged)) { throw "vendor binary missing after copy: $($pair.staged) — run: node scripts/verify-vendor.mjs (frp 未签名，杀软可能拦截/隔离)" }
    $srcHash = (Get-FileHash $pair.source -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash $pair.staged -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw "vendor binary changed while copying: $($pair.staged)" }
  }
  Write-Host ('      已校验 ' + $vendorPairs.Count + ' 个 frpc 二进制')
} else {
  Write-Host '[3/5] -NoVendor：跳过 FRP 二进制'
}

Write-Host '[4/5] 生成清单与校验和'
$files = Get-ChildItem -Recurse -File $stage | Sort-Object FullName
$sums = foreach ($f in $files) {
  $rel = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
  $hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
  "$hash  $rel"
}
$sums | Set-Content -Path (Join-Path $stage 'SHA256SUMS.txt') -Encoding ASCII
$info = [ordered]@{
  name           = 'dsh-link'
  version        = $version
  kind           = 'client'
  description    = 'dsh-link 客户端包：多台 DSH 之间互发消息 / 互传文件；含 frpc，不含 frps'
  builtAt        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  node           = (& node --version)
  files          = $files.Count
  frpBinaries    = if ($NoVendor) { @() } else { @('vendor/frp/windows-amd64/frpc.exe', 'vendor/frp/linux-amd64/frpc') }
  quickstart     = 'README-FIRST.md'
}
$info | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $stage 'BUNDLE-INFO.json') -Encoding UTF8

Write-Host '[5/5] 打包 zip / tar.gz'
New-Item -ItemType Directory -Force -Path (Join-Path $root $OutDir) | Out-Null
$zip = Join-Path $root "$OutDir\$name-portable.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal

$tgz = Join-Path $root "$OutDir\$name-portable.tar.gz"
Remove-Item -Force $tgz -ErrorAction SilentlyContinue
$stagePosixParent = '/mnt/' + ($stageRoot.Substring(0, 1).ToLower()) + $stageRoot.Substring(2).Replace('\', '/')
$outPosix = '/mnt/' + ($root.Substring(0, 1).ToLower()) + (Join-Path $root $OutDir).Substring(2).Replace('\', '/') + "/$name-portable.tar.gz"
$tarScript = "cd '$stagePosixParent' && chmod +x '$name/install.sh' '$name/vendor/frp/linux-amd64/frpc' 2>/dev/null; tar -czf '$outPosix' '$name'"
# Pick the distro explicitly: $env:DSHLINK_WSL_DISTRO, otherwise the default WSL distro name.
$wslDistro = if ($env:DSHLINK_WSL_DISTRO) { $env:DSHLINK_WSL_DISTRO } else { 'Ubuntu' }
& wsl.exe -d $wslDistro -e bash -lc $tarScript
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'WSL 打包失败，退回 Windows tar（Linux 上解包后请用 bash install.sh）'
  & tar.exe -czf $tgz -C $stageRoot $name
}

$artifacts = Get-ChildItem (Join-Path $root $OutDir) -File | Where-Object { $_.Name -like '*-portable.*' }
$artifactSums = foreach ($a in $artifacts) {
  $hash = (Get-FileHash $a.FullName -Algorithm SHA256).Hash.ToLower()
  "$hash  $($a.Name)  ($([Math]::Round($a.Length / 1MB, 1)) MB)"
}
$artifactSums | Set-Content -Path (Join-Path $root "$OutDir\SHA256SUMS.txt") -Encoding ASCII

Write-Host ''
Write-Host "打包完成：$version（$($files.Count) 个文件）" -ForegroundColor Green
$artifactSums | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host '包内顶层：' -ForegroundColor Gray
Get-ChildItem $stage | ForEach-Object { Write-Host "  $($_.Name)" }
