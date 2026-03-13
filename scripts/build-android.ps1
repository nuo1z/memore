# Memore Android 构建脚本
# 流程：前端构建 -> gomobile AAR -> 复制 libs -> Capacitor sync -> Gradle assembleDebug

param(
  [switch]$SkipWebBuild,
  [switch]$SkipAarBuild,
  [switch]$SkipGradleBuild,
  [switch]$SkipEmbedVerify
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$webDir = Join-Path $repoRoot "web"
$frontendDistDir = Join-Path $repoRoot "server\router\frontend\dist"
$androidDir = Join-Path $webDir "android"
$packagingAndroidDir = Join-Path $repoRoot "packaging\android"
$androidAppLibsDir = Join-Path $androidDir "app\libs"
$sdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$ndkDir = Join-Path $sdkRoot "ndk"
$ndkPath = if (Test-Path $ndkDir) {
  (Get-ChildItem $ndkDir -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
} else { "" }
$aarPath = Join-Path $packagingAndroidDir "mobile.aar"
$mobileModuleVersion = "v0.0.0-20260217195705-b56b3793a9c4"
$buildMarkerValue = ""

function Ensure-MobileBindDependency {
  go list golang.org/x/mobile/bind | Out-Null
  if ($LASTEXITCODE -eq 0) {
    return
  }

  Write-Host "  x/mobile/bind not found in go.mod, adding pinned dependency..."
  go get "golang.org/x/mobile/bind@$mobileModuleVersion"
}

function Write-FrontendBuildMarker {
  param(
    [string]$DistDir
  )

  $marker = "memore-frontend-marker-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$([Guid]::NewGuid().ToString('N'))"
  $markerPath = Join-Path $DistDir "memore-build-marker.txt"
  Set-Content -Path $markerPath -Value $marker -Encoding UTF8
  return $marker
}

function Test-AarContainsMarker {
  param(
    [string]$AarFilePath,
    [string]$Marker
  )

  if (-not (Test-Path $AarFilePath)) {
    return $false
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $tempDir = Join-Path $env:TEMP ("memore-aar-verify-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($AarFilePath, $tempDir)
    $soPath = Join-Path $tempDir "jni\arm64-v8a\libgojni.so"
    if (-not (Test-Path $soPath)) {
      return $false
    }

    $bytes = [System.IO.File]::ReadAllBytes($soPath)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    return $text.Contains($Marker)
  } finally {
    if (Test-Path $tempDir) {
      Remove-Item -Path $tempDir -Recurse -Force
    }
  }
}

function Build-MobileAar {
  if (Test-Path $ndkPath) {
    $env:ANDROID_NDK_HOME = $ndkPath
  }

  Ensure-MobileBindDependency
  gomobile bind "-target=android/arm64,android/arm" -androidapi 24 -o $aarPath ./mobile
}

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw "Go is not installed or not in PATH."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is not installed or not in PATH."
}
if (-not (Get-Command gomobile -ErrorAction SilentlyContinue)) {
  throw "gomobile is not installed. Run: go install golang.org/x/mobile/cmd/gomobile@latest"
}

if (-not $SkipWebBuild) {
  Write-Host "[1/5] Building frontend to server/router/frontend/dist (required for Go embed)..."
  pnpm --dir $webDir release
} else {
  Write-Host "[1/5] Skipped web build."
}

if (-not $SkipAarBuild) {
  if (-not (Test-Path $frontendDistDir)) {
    throw "Frontend dist directory missing: $frontendDistDir"
  }
  $buildMarkerValue = Write-FrontendBuildMarker -DistDir $frontendDistDir
  Write-Host "  Frontend marker: $buildMarkerValue"

  Write-Host "[2/5] Building mobile.aar with gomobile..."
  New-Item -ItemType Directory -Path $packagingAndroidDir -Force | Out-Null
  Build-MobileAar

  if (-not $SkipEmbedVerify) {
    Write-Host "  Verifying mobile.aar embeds latest frontend..."
    $verified = Test-AarContainsMarker -AarFilePath $aarPath -Marker $buildMarkerValue
    if (-not $verified) {
      Write-Host "  Marker missing in AAR, cleaning Go build cache and retrying..."
      go clean -cache
      Build-MobileAar
      $verified = Test-AarContainsMarker -AarFilePath $aarPath -Marker $buildMarkerValue
      if (-not $verified) {
        throw "AAR embed verification failed: latest frontend marker not found. Stop to prevent stale APK."
      }
    }
    Write-Host "  AAR embed verification passed."
  }
} else {
  Write-Host "[2/5] Skipped AAR build."
}

Write-Host "[3/5] Copying AAR to Android libs..."
New-Item -ItemType Directory -Path $androidAppLibsDir -Force | Out-Null
Copy-Item $aarPath (Join-Path $androidAppLibsDir "mobile.aar") -Force
if (Test-Path (Join-Path $packagingAndroidDir "mobile-sources.jar")) {
  Copy-Item (Join-Path $packagingAndroidDir "mobile-sources.jar") (Join-Path $androidAppLibsDir "mobile-sources.jar") -Force
}

Write-Host "[4/5] Syncing Capacitor Android project..."
Push-Location $webDir
try {
  npx cap sync android
} finally {
  Pop-Location
}

if (-not $SkipGradleBuild) {
  Write-Host "[5/5] Cleaning and assembling debug APK..."
  # Capacitor v7 requires JDK 21; prefer Android Studio's bundled JBR
  $androidStudioJbr = "C:\Program Files\Android\Android Studio\jbr"
  if (Test-Path $androidStudioJbr) {
    $env:JAVA_HOME = $androidStudioJbr
    $env:Path = "$($env:JAVA_HOME)\bin;$($env:Path)"
    Write-Host "  Using JDK 21 from: $androidStudioJbr"
  }
  Push-Location $androidDir
  try {
    .\gradlew.bat :app:clean :app:assembleDebug
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[5/5] Skipped Gradle build."
}

Write-Host ""
Write-Host "Android build workflow completed."
Write-Host "Debug APK: web/android/app/build/outputs/apk/debug/app-debug.apk"

$apkPath = Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $apkPath) {
  $apkHash = (Get-FileHash $apkPath -Algorithm SHA256).Hash
  Write-Host "APK SHA256: $apkHash"
}
