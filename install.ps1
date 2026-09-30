# Installs Reaper Controller into REAPER's resource folder (run again after updating the files):
#   web\*                  → <REAPER>\reaper_www_root\reaper-controller\   (served by REAPER's web interface)
#   reaper\*.lua           → <REAPER>\Scripts\ReaperController\
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-ReaperPath "D:\PortableREAPER"] [-Autostart ask|yes|no]
#
# Autostart adds a few lines to <REAPER>\Scripts\__startup.lua (REAPER runs that file on launch) that
# register ReaperController.lua as an action and start it — so it runs every time REAPER opens.
param(
    [string]$ReaperPath = "$env:APPDATA\REAPER",
    [ValidateSet("ask", "yes", "no")][string]$Autostart = "ask"
)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $ReaperPath "reaper.ini"))) {
    Write-Host "REAPER resource folder not found at $ReaperPath" -ForegroundColor Red
    Write-Host "In REAPER: Options > Show REAPER resource path in explorer, then run:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File install.ps1 -ReaperPath `"<that folder>`""
    exit 1
}

$www = Join-Path $ReaperPath "reaper_www_root\reaper-controller"
$scripts = Join-Path $ReaperPath "Scripts\ReaperController"
New-Item -ItemType Directory -Force $www, $scripts | Out-Null
Copy-Item (Join-Path $src "web\*") $www -Recurse -Force
Copy-Item (Join-Path $src "reaper\ReaperController.lua") $scripts -Force

Write-Host "Installed:" -ForegroundColor Green
Write-Host "  page   $www"
Write-Host "  script $scripts\ReaperController.lua"

# --- Autostart via Scripts\__startup.lua -------------------------------------------------------
$startup = Join-Path $ReaperPath "Scripts\__startup.lua"
$marker = "-- Reaper Controller autostart"
$already = (Test-Path $startup) -and ((Get-Content $startup -Raw) -match [regex]::Escape($marker))
if ($already) {
    Write-Host "  autostart already set up in $startup"
} else {
    if ($Autostart -eq "ask") {
        $answer = Read-Host "Start Reaper Controller automatically whenever REAPER opens? [Y/n]"
        $Autostart = if ($answer -match "^(n|no)$") { "no" } else { "yes" }
    }
    if ($Autostart -eq "yes") {
        $block = @"

$marker (added by install.ps1; delete these lines to turn it off)
do
  local path = reaper.GetResourcePath() .. "/Scripts/ReaperController/ReaperController.lua"
  local id = reaper.AddRemoveReaScript(true, 0, path, true) -- registers it in the action list
  if id ~= 0 then reaper.Main_OnCommand(id, 0) end
end
"@
        Add-Content -Path $startup -Value $block -Encoding utf8
        Write-Host "  autostart added to $startup (takes effect next time REAPER starts)"
    }
}

# Web interface port from reaper.ini (csurf line starting with HTTP), for the address to open.
$port = $null
foreach ($line in Get-Content (Join-Path $ReaperPath "reaper.ini")) {
    if ($line -match "^csurf_\d+=HTTP \d+ (\d+)") { $port = $Matches[1]; break }
}
Write-Host ""
if ($port) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like "192.168.*" } | Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = "<this PC's IP>" }
    Write-Host "Open on the tablet:  http://${ip}:$port/reaper-controller/index.html" -ForegroundColor Cyan
} else {
    Write-Host "REAPER's web interface isn't enabled yet: Options > Preferences > Control/OSC/web > Add >" -ForegroundColor Yellow
    Write-Host "  Web browser interface, pick a port (e.g. 2307), OK. Then open http://<PC IP>:<port>/reaper-controller/index.html"
}
Write-Host "To run it now (without restarting REAPER): Actions > Show action list > New action > Load ReaScript... >"
Write-Host "  $scripts\ReaperController.lua > Run.  If an older version is running: run it again > 'Terminate instances', then Run."
