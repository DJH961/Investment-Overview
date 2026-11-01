<#
.SYNOPSIS
  Try the v6 app on this laptop with a COPY of your real ledger, before the server exists.

.DESCRIPTION
  Run from the repo root in Windows PowerShell:   .\deploy\try_local.ps1
  Steps (it asks before each one that matters):
    1. copies your v5 ledger.sqlite + config.sqlite (your v5 files are only read),
    2. builds one encrypted database from the copies (inv-dashboard-upload-db --local-only),
    3. builds the frontend if needed,
    4. sets a login password in that database,
    5. shares the app to your phone over Tailscale (HTTPS, needed for passkeys),
    6. runs the server until you press Ctrl+C, then switches the sharing off.
  No secret is stored in this file or on disk: the passphrase lives only in this
  PowerShell window while the script runs. Close the v5 app first.
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
Write-Host "Copied to $Work (originals untouched)."

Write-Host "`n== 2. Database passphrase ==" -ForegroundColor Cyan
Write-Host 'Choose a passphrase for the encrypted copy. For a rehearsal any value works;'
Write-Host 'for the real server use the same one you will put in app.env.'
$sec = Read-Host 'Passphrase' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $env:INV_DASHBOARD_DB_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if (-not $env:INV_DASHBOARD_DB_PASSPHRASE) { throw 'Empty passphrase.' }

Push-Location (Join-Path $Repo 'backend')
try {
    $Db = Join-Path $Work 'app.sqlite'
    uv run inv-dashboard-upload-db --ledger (Join-Path $Work 'ledger.sqlite') `
        --config (Join-Path $Work 'config.sqlite') --out $Db --local-only
    if ($LASTEXITCODE -ne 0) {
        throw 'Preparing the database failed (no SQLCipher driver on Windows? see RUNBOOK "Try it before the server").'
    }

    Write-Host "`n== 3. Frontend ==" -ForegroundColor Cyan
    $Dist = Join-Path $Repo 'frontend\dist'
    if (-not (Test-Path (Join-Path $Dist 'index.html'))) {
        Push-Location (Join-Path $Repo 'frontend')
        try { npm install; npm run build } finally { Pop-Location }
    } else { Write-Host 'frontend\dist already built.' }

    Write-Host "`n== 4. Your Tailscale address ==" -ForegroundColor Cyan
    $dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
    if (-not $dns) { throw 'Could not read this laptop''s Tailscale name. Is Tailscale running?' }
    Write-Host "Phone address: https://$dns"

    $env:INV_DASHBOARD_DB_PATH = $Db
    $env:INV_DASHBOARD_SERVER_MODE = 'true'
    $env:INV_DASHBOARD_ENCRYPT_SYNCED_TIERS = 'true'
    $env:INV_DASHBOARD_SCHEDULER_ENABLED = 'true'
    $env:INV_DASHBOARD_COOKIE_SECURE = 'true'
    $env:INV_DASHBOARD_HOST = '127.0.0.1'
    $env:INV_DASHBOARD_PORT = "$Port"
    $env:INV_DASHBOARD_FRONTEND_DIST = $Dist
    $env:INV_DASHBOARD_WEBAUTHN_RP_ID = $dns
    $env:INV_DASHBOARD_WEBAUTHN_ORIGIN = "https://$dns"

    Write-Host "`n== 5. Login password ==" -ForegroundColor Cyan
    uv run inv-dashboard-set-password
    if ($LASTEXITCODE -ne 0) { throw 'Setting the password failed.' }

    Write-Host "`n== 6. Share and run ==" -ForegroundColor Cyan
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
    Remove-Item Env:INV_DASHBOARD_DB_PASSPHRASE -ErrorAction SilentlyContinue
    Write-Host "Delete $Work when you are done (it holds a copy of your ledger)."
}
