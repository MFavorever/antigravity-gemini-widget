$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PetScript = Join-Path $PluginRoot "pet\desktop_pet.py"
$MainScript = Join-Path $PluginRoot "sidecars\gemini_widget\main.mjs"

# Check if local bridge is already listening
$bridgeUp = $false
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:18923/api/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
  if ($resp.StatusCode -eq 200) { $bridgeUp = $true }
} catch {}

if (-not $bridgeUp) {
  Start-Process -FilePath "node" -ArgumentList @($MainScript, "--standalone", "--port", "18923") -WindowStyle Hidden
} else {
  Start-Process -FilePath "pythonw" -ArgumentList @($PetScript, "--port", "18923") -WindowStyle Hidden
}
