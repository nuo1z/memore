# Memore Desktop 构建脚本
# 编译 Windows 桌面版（含 WebView2 窗口 + 系统托盘 + 内嵌前端）
#
# 用法：
#   .\scripts\build-desktop.ps1                    # 完整构建（含前端）
#   .\scripts\build-desktop.ps1 -SkipWebBuild      # 跳过前端构建

param(
  [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$webDir = Join-Path $repoRoot "web"
$desktopDir = Join-Path $repoRoot "cmd\memore-desktop"
$outputPath = Join-Path $repoRoot "build\Memore.exe"

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw "Go is not installed or not in PATH."
}

# Step 1: 构建前端并嵌入到 Go 后端
if (-not $SkipWebBuild) {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is not installed. Install it or use -SkipWebBuild."
  }
  Write-Host "[1/3] Building frontend..."
  pnpm --dir $webDir release
} else {
  Write-Host "[1/3] Skipped frontend build."
}

# Step 2: 生成 Windows 资源（图标 + 版本信息）
Write-Host "[2/3] Generating Windows resources..."
if (Get-Command go-winres -ErrorAction SilentlyContinue) {
  Push-Location $desktopDir
  try { go-winres make } finally { Pop-Location }
} else {
  Write-Host "  go-winres not found, skipping resource embedding."
  Write-Host "  Install: go install github.com/tc-hib/go-winres@latest"
}

# Step 3: 编译桌面版（-H windowsgui 隐藏控制台窗口）
Write-Host "[3/3] Building Memore Desktop..."
New-Item -Path (Split-Path $outputPath) -ItemType Directory -Force | Out-Null

Push-Location $repoRoot
try {
  go build -tags "desktop,production" -ldflags "-H windowsgui -s -w" -o $outputPath ./cmd/memore-desktop/
} finally {
  Pop-Location
}

$size = [math]::Round((Get-Item $outputPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Build complete: $outputPath ($size MB)"
Write-Host "Double-click Memore.exe to launch!"
