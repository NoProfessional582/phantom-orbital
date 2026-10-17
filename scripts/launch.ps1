# Starts Orbital from this checkout without a terminal window.
# Rebuilds first when npm is available and the source is newer than the last build.
# -Shortcut also creates (or refreshes) a desktop shortcut that runs this script.
param([switch]$Shortcut)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$built = Join-Path $root 'out\main\index.js'

if ($Shortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop 'Phantom Orbital.lnk'))
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $link.WorkingDirectory = $root
  $link.IconLocation = "$electron,0"
  $link.Description = 'Phantom Orbital Assistant'
  $link.Save()
  Write-Output "Shortcut created: $($link.FullName)"
  return
}

if (-not (Test-Path $electron)) { throw "Electron not found. Run npm ci in $root first." }
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
  $lastBuild = if (Test-Path $built) { (Get-Item $built).LastWriteTime } else { [datetime]::MinValue }
  $newest = Get-ChildItem (Join-Path $root 'src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest.LastWriteTime -gt $lastBuild) {
    Push-Location $root
    try { & $npm.Source run build | Out-Null; if ($LASTEXITCODE) { throw 'npm run build failed' } } finally { Pop-Location }
  }
}
if (-not (Test-Path $built)) { throw "No build found. Run npm run build in $root first." }
# Orbital is single-instance: launching again just shows the running orb.
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root
