param(
  [switch]$LaunchPet,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetRoot = Join-Path $env:USERPROFILE ".gemini\config\plugins\antigravity-gemini-widget"

Write-Host "=== Gemini 星语猫姬 (antigravity-gemini-widget) 安装脚本 ===" -ForegroundColor Cyan

# 1. Check Node.js & Python
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "未检测到 Node.js，请先安装 Node.js (>= 20)。"
  exit 1
}

$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd) {
  Write-Error "未检测到 Python，请先安装 Python 3.10+。"
  exit 1
}

python -c "import tkinter, PIL" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Python 缺少 tkinter 或 Pillow (PIL) 模块，请执行: pip install pillow"
  exit 1
}

# 2. Stop any existing desktop_pet.py before copying
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessId -ne $PID -and
    ($_.Name -match '^pythonw?\.exe$') -and
    $_.CommandLine -like "*antigravity-gemini-widget*desktop_pet.py*"
  } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }

# 3. Copy/sync plugin files in-place to ~/.gemini/config/plugins/antigravity-gemini-widget
if (-not (Test-Path $TargetRoot)) {
  New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}

$ItemsToCopy = @(
  "plugin.json",
  "hooks.json",
  "README.md",
  "start-pet.ps1",
  "start-pet.vbs",
  "uninstall.ps1",
  "assets",
  "hooks",
  "pet",
  "sidecars"
)

foreach ($item in $ItemsToCopy) {
  $src = Join-Path $SourceRoot $item
  if (Test-Path $src) {
    Copy-Item -Path $src -Destination $TargetRoot -Recurse -Force
  }
}

Write-Host "插件已同步至: $TargetRoot" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "  1. 在 Antigravity 的 Customizations / Plugins 页面启用 'antigravity-gemini-widget'。"
Write-Host "  2. 启用后 Sidecar 会自动启动并在底部显示星语猫姬；也可在右侧辅助面板 '+' 中打开 'Gemini 星语猫姬'。"

if ($LaunchPet) {
  Write-Host ""
  Write-Host "正在启动独立预览模式..." -ForegroundColor Cyan
  $mainScript = Join-Path $TargetRoot "sidecars\gemini_widget\main.mjs"
  Start-Process -FilePath "node" -ArgumentList @($mainScript, "--standalone", "--port", "18923") -WindowStyle Hidden
  Write-Host "已在后台启动独立服务与底部星语猫姬 (http://127.0.0.1:18923/)。" -ForegroundColor Green
}
