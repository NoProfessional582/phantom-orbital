# Prints the persona's personality.md with {{name}} and {{user}} filled in from
# orb.config.json, for pasting into an agent's own personality file (for Hermes,
# the profile's SOUL.md). Writes nothing unless -Out is given; never edits Hermes.
param([string]$Out)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$personaDir = Join-Path $root 'personas\megan'
$user = 'the user'
$configPath = Join-Path $root 'orb.config.json'
if (Test-Path $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if ($config.persona) { $personaDir = if ([IO.Path]::IsPathRooted($config.persona)) { $config.persona } else { Join-Path $root $config.persona } }
    if ($config.user.name) { $user = $config.user.name }
}
$persona = Get-Content -Raw -LiteralPath (Join-Path $personaDir 'persona.json') | ConvertFrom-Json
$text = (Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $personaDir 'personality.md')) -replace '\{\{\s*name\s*\}\}', $persona.name -replace '\{\{\s*user\s*\}\}', $user
if ($Out) { [IO.File]::WriteAllText($Out, $text, (New-Object Text.UTF8Encoding $false)); Write-Host "Wrote $Out" }
else { $text }
