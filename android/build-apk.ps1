# Build the dsh-link Android control app without Gradle.
#
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Sdk D:\AndroidSdk -VersionName 0.1.1
#
# Requires: Android SDK with build-tools;36.0.0 and platforms;android-36, plus a JDK (17+).
# Uses only aapt2 / javac / d8 / zipalign / apksigner from the SDK, so no network and no Gradle.
param(
    [string]$Sdk = "D:\AndroidSdk",
    [string]$VersionName = "0.1.0",
    [int]$VersionCode = 1
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
$Keystore = Join-Path $Root "debug.keystore"

if (-not (Test-Path $BuildTools)) { throw "build-tools not found: $BuildTools" }
if (-not (Test-Path $AndroidJar)) { throw "android.jar not found: $AndroidJar" }

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

Write-Host "[1/6] aapt2 compile"
& "$BuildTools\aapt2.exe" compile --dir "$App\src\main\res" -o "$Obj\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "[2/6] aapt2 link"
& "$BuildTools\aapt2.exe" link -o "$Obj\base.apk" -I $AndroidJar --manifest "$App\src\main\AndroidManifest.xml" --java $Gen --min-sdk-version 26 --target-sdk-version 36 --version-code $VersionCode --version-name $VersionName "$Obj\res.zip"
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

Write-Host "[5/6] package classes.dex into the APK"
Copy-Item "$Obj\base.apk" "$Obj\unsigned.apk" -Force
$jar = Get-Command "jar" -ErrorAction SilentlyContinue
if (-not $jar) { throw "jar.exe not found; install a JDK" }
Push-Location "$Obj"
try {
    & $jar.Source uf "$Obj\unsigned.apk" -C "$Obj\dex" classes.dex
    if ($LASTEXITCODE -ne 0) { throw "jar uf failed" }
} finally {
    Pop-Location
}

Write-Host "[6/6] zipalign + sign"
& "$BuildTools\zipalign.exe" -f -p 4 "$Obj\unsigned.apk" "$Obj\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

if (-not (Test-Path $Keystore)) {
    Write-Host "generating debug keystore"
    & $Keytool -genkeypair -keystore $Keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

$OutputApk = Join-Path $Dist "dshlink-control-$VersionName-debug.apk"
& "$BuildTools\apksigner.bat" sign --ks $Keystore --ks-pass pass:android --key-pass pass:android --out $OutputApk "$Obj\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }
& "$BuildTools\apksigner.bat" verify --print-certs $OutputApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

Write-Host ""
Write-Host "APK: $OutputApk"
Write-Host ("size: {0:N0} bytes" -f (Get-Item $OutputApk).Length)
