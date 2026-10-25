# Renders each mockup page in this folder to a PNG in docs/design/ with headless Edge (or Chrome).
# Usage: powershell -File docs/design/mockups/render.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Split-Path $here -Parent
$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Edge or Chrome is needed to render the mockups' }
# The browser logs harmless warnings on stderr
$ErrorActionPreference = 'Continue'

# Page heights in CSS pixels (the width is always 1640)
$pages = @{ '01-login' = 720; '02-lobby' = 760; '03-admin' = 1010; '04-components' = 1330 }
foreach ($name in $pages.Keys) {
  $html = Join-Path $here "$name.html"
  $png = Join-Path $out "$name.png"
  $url = 'file:///' + ($html -replace '\\', '/')
  & $browser --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1.5 `
    "--window-size=1640,$($pages[$name])" "--screenshot=$png" $url 2>$null | Out-Null
  Write-Output "$name.png"
}
