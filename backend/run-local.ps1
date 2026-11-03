# Runs the API on your PC against a practice database (backend\local-dev.db), never the live Neon one.
# Neon is in Ohio: from India every query takes ~0.3 s, so a local server on Neon takes minutes to start and its
# start-up jobs write reminders into the live data. This file is a few metres away instead.
#
# Usage (in the backend folder):   .\run-local.ps1           start at http://127.0.0.1:8000 (docs at /docs)
#                                  .\run-local.ps1 -Fresh    throw the practice data away and start again
# The first run builds the database and loads the sample data (about a minute); later runs start in seconds.
param([switch]$Fresh, [int]$Port = 8000)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$db = Join-Path $PSScriptRoot "local-dev.db"
if ($Fresh -and (Test-Path $db)) { Remove-Item $db -Confirm:$false }

# These override backend\.env for this window only.
$env:DATABASE_URL = "sqlite:///" + ($db -replace "\\", "/")
$env:APP_ENV = "development"
$env:STORAGE_BACKEND = "local"
$env:RUN_MIGRATIONS_ON_START = "false"
$env:SEED_ON_START = "false"

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $db)) {
    Write-Host "Creating the practice database and loading sample data (about a minute)..."
    & $python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Database setup failed." }
    & $python -m app.seed
    if ($LASTEXITCODE -ne 0) { throw "Loading sample data failed." }
}
Write-Host "Practice server: http://127.0.0.1:$Port  (live data is not touched; Ctrl+C to stop)"
& $python -m uvicorn app.main:app --host 127.0.0.1 --port $Port
