<#
  build-bundle.ps1 --- 打包 dsh-link 客户端发行包
  产物（dist/）：
    dsh-link-<版本>-portable.zip       （Windows 友好）
    dsh-link-<版本>-portable.tar.gz    （Linux/WSL 友好，含可执行位）
    SHA256SUMS.txt                     （两个包各自的 sha256）
  包内容：bin src docs integrations test + README + install.ps1/install.sh，
          vendor/frp 只含 frpc（Windows + Linux）——frps 属于服务器侧，不入包。
  用法：powershell -ExecutionPolicy Bypass -File scripts\build-bundle.ps1 [-NoVendor] [-Suffix -src] [-Apk <path>] [-NoApk]
        -NoVendor 只打源码（约 0.1 MB，对方自备 frpc）；-Suffix 给产物名加后缀，避免覆盖完整包。
        -Apk 指定手机 APK（默认自动取 android/dist 下最新的 dshlink-control-*.apk）；-NoApk 不打包 APK。
#>
[CmdletBinding()]
param(
  [switch]$NoVendor,
  [switch]$NoApk,
  [string]$Apk = '',
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

Write-Host "[1/6] 清理暂存目录 $stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host '[2/6] 复制源码与文档（节点 + hub + 文档）'
foreach ($dir in 'bin', 'src', 'docs', 'integrations', 'examples') {
  Copy-Item -Recurse -Force (Join-Path $root $dir) (Join-Path $stage $dir)
}
# test/ 跳过 .tmp（本机测试产物可能很大）：只复制测试源码与脚本
$testSrc = Join-Path $root 'test'
$testDst = Join-Path $stage 'test'
New-Item -ItemType Directory -Force -Path $testDst | Out-Null
Get-ChildItem -Path $testSrc -File | Copy-Item -Destination $testDst -Force
Get-ChildItem -Path $testSrc -Directory | Where-Object { $_.Name -ne '.tmp' } | ForEach-Object {
  Copy-Item -Recurse -Force $_.FullName (Join-Path $testDst $_.Name)
}
foreach ($file in 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md', 'AIGC-Notice.md', 'package.json', '.gitignore') {
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
  Write-Host '[3/6] 放入 FRP 客户端（frpc，Windows + Linux；不含 frps）'
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
  Write-Host '[3/6] -NoVendor：跳过 FRP 二进制'
}

# --- 手机 APK：分发包自带一份，方便下载者直接安装。APK 本身不含任何密钥（0.5.0 起）。
$apkInfo = $null
if ($NoApk) {
  Write-Host '[4/6] -NoApk：跳过手机 APK'
} else {
  $apkPath = $null
  if ($Apk) {
    $apkPath = (Resolve-Path -LiteralPath $Apk -ErrorAction Stop).Path
  } else {
    $apkDir = Join-Path $root 'android\dist'
    $candidate = Get-ChildItem -Path $apkDir -Filter 'dshlink-control-*.apk' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*.idsig' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate) { $apkPath = $candidate.FullName }
  }
  if ($apkPath) {
    $apkDirStage = Join-Path $stage 'apk'
    New-Item -ItemType Directory -Force -Path $apkDirStage | Out-Null
    $apkName = Split-Path -Leaf $apkPath
    Copy-Item -Force $apkPath (Join-Path $apkDirStage $apkName)
    $apkSha = (Get-FileHash (Join-Path $apkDirStage $apkName) -Algorithm SHA256).Hash.ToLower()
    if ($apkName -match 'dshlink-control-(.+?)(?:\.apk)?$') { $apkVersion = $Matches[1] } else { $apkVersion = 'unknown' }
    $apkInfo = [ordered]@{ file = "apk/$apkName"; version = $apkVersion; bytes = (Get-Item $apkPath).Length; sha256 = $apkSha }
    $apkNotes = @(
      'dsh-link 手机控制端 APK',
      '',
      '安装：把 APK 传到 Android 手机（8.0+），允许“安装未知来源应用”后安装。',
      '连接：先在 hub 上生成连接串（dshlink hub invite --phone，或 hub 控制台“手机接入”卡片），',
      '      在 App 里点“导入连接串”粘贴，然后勾选 STCP 中转并连接。',
      '安全：APK 不含任何密钥/token/隧道配置；连接串等同密码，请私下发送。',
      '校验：SHA-256 ' + $apkSha
    )
    $apkNotes | Set-Content -Path (Join-Path $apkDirStage 'README.txt') -Encoding UTF8
    Write-Host "[4/6] 手机 APK: $apkName ($([Math]::Round((Get-Item $apkPath).Length / 1MB, 1)) MB)"
  } else {
    Write-Warning '[4/6] 未找到 android/dist/dshlink-control-*.apk，发行包将不含 APK（用 -Apk 指定，或 -NoApk 消除警告）'
  }
}

Write-Host '[5/6] 生成清单与校验和'
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
  kind           = 'client+hub'
  description    = 'dsh-link 发行包：节点 + 中心服务器（hub）+ CLI + 文档 + 示例，可选手机控制端 APK；含 frpc，不含 frps'
  builtAt        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  node           = (& node --version)
  files          = $files.Count
  frpBinaries    = if ($NoVendor) { @() } else { @('vendor/frp/windows-amd64/frpc.exe', 'vendor/frp/linux-amd64/frpc') }
  apk            = $apkInfo
  quickstart     = 'README-FIRST.md'
}
$info | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $stage 'BUNDLE-INFO.json') -Encoding UTF8

Write-Host '[6/6] 打包 zip / tar.gz'
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
