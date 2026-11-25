$ErrorActionPreference = "SilentlyContinue"
$TargetRoot = Join-Path $env:USERPROFILE ".gemini\config\plugins\antigravity-gemini-widget"

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $PID -and
    ($_.Name -match '^(?:pythonw?|node)\.exe$') -and (
      $_.CommandLine -like "*antigravity-gemini-widget*desktop_pet.py*" -or
      $_.CommandLine -like "*antigravity-gemini-widget*main.mjs*"
    )
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
  }

if (Test-Path $TargetRoot) {
  Remove-Item -Path $TargetRoot -Recurse -Force
  Write-Host "已卸载插件目录: $TargetRoot" -ForegroundColor Green
} else {
  Write-Host "插件目录不存在，无需清理: $TargetRoot" -ForegroundColor Yellow
}
