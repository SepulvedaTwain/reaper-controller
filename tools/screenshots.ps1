# Regenerates the README screenshots in docs/images with headless Microsoft Edge + the demo server.
#   powershell -ExecutionPolicy Bypass -File tools\screenshots.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$out = Join-Path $root "docs\images"
New-Item -ItemType Directory -Force $out | Out-Null
$demo = Start-Process python -ArgumentList "`"$root\tools\demo_server.py`" --port 4832" -PassThru -WindowStyle Hidden
try {
    Start-Sleep -Seconds 1
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:4832/_/1007" | Out-Null  # press play so meters move
    foreach ($scene in "mixer", "routing", "record", "input", "menu") {
        $args = @("--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
            "--user-data-dir=$env:TEMP\rc-shot", "--force-device-scale-factor=2", "--window-size=1180,820",
            "--virtual-time-budget=5000", "--screenshot=$out\$scene.png", "http://127.0.0.1:4832/shot.html?s=$scene")
        Start-Process -FilePath $edge -ArgumentList $args -Wait -WindowStyle Hidden
        Write-Host "captured $scene.png"
    }
}
finally {
    Stop-Process -Id $demo.Id -ErrorAction SilentlyContinue
}
