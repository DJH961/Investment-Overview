<#
.SYNOPSIS
  Try the v6 app on this laptop with a COPY of your real ledger, before the server exists.

.DESCRIPTION
  Run from the repo root in Windows PowerShell:   .\deploy\try_local.ps1
  Steps (it asks before each one that matters):
    1. copies your v5 ledger.sqlite + config.sqlite (your v5 files are only read),
    2. builds one database from the copies (inv-dashboard-upload-db --local-only --plain;
       unencrypted, like the v5 files it comes from, because Windows has no SQLCipher driver),
    3. builds the frontend if needed,
    4. sets a login password in that database,
    5. shares the app to your phone over Tailscale (HTTPS, needed for passkeys),
    6. runs the server until you press Ctrl+C, then switches the sharing off.
  No secret is stored in this file. Close the v5 app first.
  The working folder is  $env:LOCALAPPDATA\inv-try  (delete it when you are done).
#>
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Work = Join-Path $env:LOCALAPPDATA 'inv-try'
$Port = 8000

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "'$cmd' not found. $hint" }
}
Need 'uv' 'Install uv first (see CONTRIBUTING.md).'
Need 'npm' 'Install Node.js first.'
Need 'tailscale' 'Install Tailscale and sign in on this laptop.'

Write-Host "`n== 1. Your v5 data folder ==" -ForegroundColor Cyan
Write-Host 'This is the folder holding ledger.sqlite and config.sqlite (often inside OneDrive).'
$Src = Read-Host 'Folder path'
foreach ($f in 'ledger.sqlite', 'config.sqlite') {
    if (-not (Test-Path (Join-Path $Src $f))) { throw "$f not found in $Src" }
}
$null = New-Item -ItemType Directory -Force -Path $Work
Copy-Item (Join-Path $Src 'ledger.sqlite') (Join-Path $Work 'ledger.sqlite') -Force
Copy-Item (Join-Path $Src 'config.sqlite') (Join-Path $Work 'config.sqlite') -Force
$Cache = Join-Path $env:LOCALAPPDATA 'inv-dashboard\cache.sqlite'
$CacheArgs = @()
if (Test-Path $Cache) {
    Copy-Item $Cache (Join-Path $Work 'cache.sqlite') -Force
    $CacheArgs = @('--cache', (Join-Path $Work 'cache.sqlite'))
}
Write-Host "Copied to $Work (originals untouched)."

Push-Location (Join-Path $Repo 'backend')
try {
    $Db = Join-Path $Work 'app.sqlite'
    uv run inv-dashboard-upload-db --ledger (Join-Path $Work 'ledger.sqlite') `
        --config (Join-Path $Work 'config.sqlite') @CacheArgs --out $Db --local-only --plain
    if ($LASTEXITCODE -ne 0) { throw 'Preparing the database failed.' }

    Write-Host "`n== 2. Frontend ==" -ForegroundColor Cyan
    $Dist = Join-Path $Repo 'frontend\dist'
    if (-not (Test-Path (Join-Path $Dist 'index.html'))) {
        Push-Location (Join-Path $Repo 'frontend')
        try { npm install; npm run build } finally { Pop-Location }
    } else { Write-Host 'frontend\dist already built.' }

    Write-Host "`n== 3. Your Tailscale address ==" -ForegroundColor Cyan
    $dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
    if (-not $dns) { throw 'Could not read this laptop''s Tailscale name. Is Tailscale running?' }
    Write-Host "Phone address: https://$dns"

    $env:INV_DASHBOARD_DB_PATH = $Db
    $env:INV_DASHBOARD_SERVER_MODE = 'true'
    $env:INV_DASHBOARD_ENCRYPT_SYNCED_TIERS = 'false'
    $env:INV_DASHBOARD_SCHEDULER_ENABLED = 'true'
    $env:INV_DASHBOARD_COOKIE_SECURE = 'true'
    $env:INV_DASHBOARD_HOST = '127.0.0.1'
    $env:INV_DASHBOARD_PORT = "$Port"
    $env:INV_DASHBOARD_FRONTEND_DIST = $Dist
    $env:INV_DASHBOARD_WEBAUTHN_RP_ID = $dns
    $env:INV_DASHBOARD_WEBAUTHN_ORIGIN = "https://$dns"

    Write-Host "`n== 4. Login password ==" -ForegroundColor Cyan
    uv run inv-dashboard-set-password
    if ($LASTEXITCODE -ne 0) { throw 'Setting the password failed.' }

    Write-Host "`n== 5. Share and run ==" -ForegroundColor Cyan
    tailscale serve --bg $Port
    Write-Host "Open https://$dns on this laptop or your phone (phone needs Tailscale on)."
    Write-Host 'Press Ctrl+C to stop. Sharing is switched off afterwards.'
    try { uv run inv-dashboard-server }
    finally {
        tailscale serve reset
        Write-Host 'Sharing switched off.'
    }
}
finally {
    Pop-Location
    Write-Host "Delete $Work when you are done (it holds a copy of your ledger)."
}
