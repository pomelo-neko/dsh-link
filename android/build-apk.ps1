# Build the dsh-link Android control app without Gradle.
#
# Debug build (generic APK, no tunnel credentials bundled):
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Sdk D:\AndroidSdk
#
# Release build signed with your own keystore:
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Release ^
#     -Keystore android\release.keystore -KeystorePassword "..." -KeyAlias dshlink -KeyPassword "..."
#
# Requires: Android SDK with build-tools;36.0.0 and platforms;android-36, plus a JDK (17+).
# Uses only aapt2 / javac / d8 / zipalign / apksigner from the SDK, so no network and no Gradle.
#
# Since 0.5.0 the distribution APK must NOT contain tunnel credentials: assets/tunnel is optional.
# When it is missing or incomplete the build still succeeds and prints a warning; internal
# deployments can keep the render there (android\tunnel\README.md). The frpc native libraries
# under android\native\lib are still required.
param(
    [string]$Sdk = "D:\AndroidSdk",
    [string]$VersionName = "0.6.0",
    [int]$VersionCode = 7,
    [switch]$Release,
    [string]$Keystore = "",
    [string]$KeystorePassword = "",
    [string]$KeyAlias = "",
    [string]$KeyPassword = ""
)

$ErrorActionPreference = "Continue"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$App = Join-Path $Root "app"
$BuildTools = Join-Path $Sdk "build-tools\36.0.0"
$AndroidJar = Join-Path $Sdk "platforms\android-36\android.jar"
$Dist = Join-Path $Root "dist"
$Obj = Join-Path $Dist "obj"
$Gen = Join-Path $Obj "gen"
$Classes = Join-Path $Obj "classes"
$DebugKeystore = Join-Path $Root "debug.keystore"

if (-not (Test-Path $BuildTools)) { throw "build-tools not found: $BuildTools" }
if (-not (Test-Path $AndroidJar)) { throw "android.jar not found: $AndroidJar" }

if ($Release) {
    if (-not $Keystore) {
        throw "-Release requires -Keystore <path> (generate a release keystore first, see android\README.md)"
    }
    if (-not (Test-Path $Keystore)) { throw "keystore not found: $Keystore" }
    $Keystore = (Resolve-Path $Keystore).Path
    if (-not $KeystorePassword) { throw "-Release requires -KeystorePassword" }
    if (-not $KeyPassword) { $KeyPassword = $KeystorePassword }
}

function Find-JavaTool([string]$Name) {
    if ($env:JAVA_HOME) {
        $candidate = Join-Path $env:JAVA_HOME "bin\$Name.exe"
        if (Test-Path $candidate) { return $candidate }
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "$Name not found; install a JDK 17+ and set JAVA_HOME"
}

$Javac = Find-JavaTool "javac"
$JavaExe = Find-JavaTool "java"
$Keytool = Find-JavaTool "keytool"
$env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $Javac)
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
Write-Host "JDK: $env:JAVA_HOME"

Remove-Item -Recurse -Force $Obj -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Obj, $Gen, $Classes, $Dist | Out-Null

# --- optional tunnel credentials -------------------------------------------------------------
# assets/tunnel is gitignored and must never be part of a shared/distributed APK. A missing or
# incomplete directory is expected for the generic build: warn, keep going, bundle nothing.
$Assets = Join-Path $App "src\main\assets"
$TunnelAssets = Join-Path $Assets "tunnel"
$TunnelAssetNames = @("frpc.toml", "ca.crt", "client.crt", "client.key")
$IncludeTunnelAssets = $false
if (Test-Path $TunnelAssets) {
    $missing = @($TunnelAssetNames | Where-Object { -not (Test-Path (Join-Path $TunnelAssets $_)) })
    if ($missing.Count -eq 0) {
        $IncludeTunnelAssets = $true
        Write-Warning "assets\tunnel found: this APK will contain tunnel credentials (internal build only, do not distribute it)"
    } else {
        Write-Warning ("assets\tunnel is incomplete (missing: {0}); building a generic APK without bundled tunnel credentials" -f ($missing -join ", "))
    }
} else {
    Write-Warning "assets\tunnel not found; building a generic APK without bundled tunnel credentials (users import a connection string/configuration file)"
}
if ($IncludeTunnelAssets) {
    Write-Host "tunnel credentials: bundled"
} else {
    Write-Host "tunnel credentials: none (distribution build)"
}

# frpc native libraries are still required: they are what makes the STCP visitor possible.
$Native = Join-Path $Root "native"
$nativeAbis = @()
if (Test-Path $Native) {
    $nativeAbis = @(Get-ChildItem (Join-Path $Native "lib") -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}
if ($nativeAbis.Count -eq 0) { throw "no native frpc binaries found under $Native\lib (see android\tunnel\README.md)" }
Write-Host ("frpc ABIs: {0}" -f ($nativeAbis -join ", "))

Write-Host "[1/6] aapt2 compile"
& "$BuildTools\aapt2.exe" compile --dir "$App\src\main\res" -o "$Obj\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "[2/6] aapt2 link"
# Debug builds are marked debuggable so adb run-as can inspect the app's prefs/files during
# on-device verification; release builds stay non-debuggable.
$linkArgs = @("link", "-o", "$Obj\base.apk", "-I", $AndroidJar,
              "--manifest", "$App\src\main\AndroidManifest.xml", "--java", $Gen,
              "--min-sdk-version", "26", "--target-sdk-version", "36",
              "--version-code", "$VersionCode", "--version-name", $VersionName)
if (-not $Release) { $linkArgs += "--debug-mode" }
$linkArgs += "$Obj\res.zip"
& "$BuildTools\aapt2.exe" @linkArgs
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "[3/6] javac --release 11"
$sources = @(Get-ChildItem -Path "$App\src\main\java", $Gen -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw "no Java sources found" }
$javacArgs = @("--release", "11", "-encoding", "UTF-8", "-cp", $AndroidJar, "-d", $Classes) + $sources
& $Javac @javacArgs
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "[4/6] d8"
New-Item -ItemType Directory -Force -Path "$Obj\dex" | Out-Null
& "$BuildTools\d8.bat" --min-api 26 --lib $AndroidJar --output "$Obj\dex" (Get-ChildItem -Path $Classes -Recurse -Filter *.class | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "[5/6] package assets, classes.dex and frpc native libs into the APK"
# aapt2 on Windows writes asset names with backslashes (assets/tunnel\ca.crt), which Android
# cannot open. Package assets with jar instead so every entry uses forward slashes.
$AssetStage = Join-Path $Obj "apk-assets"
Remove-Item -Recurse -Force $AssetStage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $AssetStage "assets") | Out-Null
if (Test-Path $Assets) {
    # Everything except the (possibly secret) tunnel render.
    Copy-Item -Path (Join-Path $Assets "*") -Destination (Join-Path $AssetStage "assets") -Recurse -Force -Exclude "tunnel"
}
if ($IncludeTunnelAssets) {
    New-Item -ItemType Directory -Force -Path (Join-Path $AssetStage "assets\tunnel") | Out-Null
    Copy-Item -Path (Join-Path $TunnelAssets "*") -Destination (Join-Path $AssetStage "assets\tunnel") -Recurse -Force
}
Copy-Item "$Obj\base.apk" "$Obj\unsigned.apk" -Force
$jar = Get-Command "jar" -ErrorAction SilentlyContinue
if (-not $jar) { throw "jar.exe not found; install a JDK" }
Push-Location "$Obj"
try {
    & $jar.Source uf "$Obj\unsigned.apk" -C "$Obj\dex" classes.dex
    if ($LASTEXITCODE -ne 0) { throw "jar uf classes.dex failed" }
    & $jar.Source uf "$Obj\unsigned.apk" -C $AssetStage assets
    if ($LASTEXITCODE -ne 0) { throw "jar uf assets failed" }
    & $jar.Source uf "$Obj\unsigned.apk" -C $Native lib
    if ($LASTEXITCODE -ne 0) { throw "jar uf native libs failed" }
} finally {
    Pop-Location
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("$Obj\unsigned.apk")
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    if ($IncludeTunnelAssets) {
        foreach ($name in @("assets/tunnel/frpc.toml", "assets/tunnel/ca.crt", "assets/tunnel/client.crt", "assets/tunnel/client.key")) {
            if (-not ($names -contains $name)) { throw "APK is missing $name" }
        }
    } else {
        # Guard the release contract: a generic APK must not embed the window into the tunnel.
        foreach ($name in $names) {
            if ($name -like "assets/tunnel/*") { throw "generic APK unexpectedly contains $name" }
        }
    }
    foreach ($abi in $nativeAbis) {
        if (-not ($names -contains ("lib/$abi/libfrpc.so"))) { throw "APK is missing lib/$abi/libfrpc.so" }
    }
} finally {
    $zip.Dispose()
}

Write-Host "[6/6] zipalign + sign"
& "$BuildTools\zipalign.exe" -f -p 4 "$Obj\unsigned.apk" "$Obj\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

if ($Release) {
    $OutputApk = Join-Path $Dist "dshlink-control-$VersionName.apk"
    $signArgs = @("sign", "--ks", $Keystore)
    if ($KeyAlias) { $signArgs += @("--ks-key-alias", $KeyAlias) }
    $signArgs += @("--ks-pass", "pass:$KeystorePassword", "--key-pass", "pass:$KeyPassword",
                   "--out", $OutputApk, "$Obj\aligned.apk")
    & "$BuildTools\apksigner.bat" @signArgs
    if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }
    Write-Host "signed with release keystore: $Keystore"
} else {
    if (-not (Test-Path $DebugKeystore)) {
        Write-Host "generating debug keystore"
        & $Keytool -genkeypair -keystore $DebugKeystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
        if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
    }
    $OutputApk = Join-Path $Dist "dshlink-control-$VersionName-debug.apk"
    & "$BuildTools\apksigner.bat" sign --ks $DebugKeystore --ks-pass pass:android --key-pass pass:android --out $OutputApk "$Obj\aligned.apk"
    if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }
    Write-Host "signed with debug keystore: $DebugKeystore"
}
& "$BuildTools\apksigner.bat" verify --print-certs $OutputApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputApk).Hash
Write-Host ""
Write-Host "APK: $OutputApk"
$mode = if ($Release) { "release" } else { "debug" }
Write-Host ("mode: {0}" -f $mode)
Write-Host ("tunnel credentials bundled: {0}" -f $IncludeTunnelAssets)
Write-Host ("size: {0:N0} bytes" -f (Get-Item $OutputApk).Length)
Write-Host "SHA-256: $hash"

# Checksums for every APK currently in dist/ so a distributed file can be verified later.
$sumsPath = Join-Path $Dist "SHA256SUMS"
$sumLines = @(Get-ChildItem -Path $Dist -Filter *.apk -File | Sort-Object Name | ForEach-Object {
    $lineHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    "{0}  {1}" -f $lineHash, $_.Name
})
Set-Content -Path $sumsPath -Value $sumLines -Encoding ASCII
Write-Host "SHA256SUMS: $sumsPath"
