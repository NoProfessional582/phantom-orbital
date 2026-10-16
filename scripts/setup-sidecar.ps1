# Project-local tooling only. No PATH, registry, Hermes or system Python edits.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$uv = Join-Path $root '.tools\uv\bin\uv.exe'
if (!(Test-Path $uv)) {
    & python -E -s -m pip install --target (Join-Path $root '.tools\uv') 'uv==0.13.0'
    if ($LASTEXITCODE -ne 0) { throw 'Project-local uv bootstrap failed; no system installer attempted.' }
}
$env:UV_CACHE_DIR = Join-Path $root '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root '.tools\python'
& $uv python install '3.12' --install-dir $env:UV_PYTHON_INSTALL_DIR
if ($LASTEXITCODE -ne 0) { throw 'Project-local Python 3.12 installation failed.' }
& $uv sync --project (Join-Path $root 'sidecar') --python '3.12' --managed-python --locked
if ($LASTEXITCODE -ne 0) { throw 'Sidecar uv sync failed.' }
Write-Host 'Sidecar environment ready. Next: scripts/setup-models.ps1 (copies local models first).'
