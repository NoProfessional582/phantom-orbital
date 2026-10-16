# Explicit one-time model setup. Never invoked by the running sidecar.
# -Voice picks a Piper voice id (default: the persona in orb.config.json, else en_US-amy-medium).
param([switch]$Download, [string]$Voice)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$python = Join-Path $root 'sidecar\.venv\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Install the project-local sidecar environment first (uv sync --project sidecar).' }
$models = Join-Path $root 'sidecar\models'
if (!$Voice) {
    $Voice = 'en_US-amy-medium'
    $configPath = Join-Path $root 'orb.config.json'
    $personaDir = Join-Path $root 'personas\megan'
    if (Test-Path $configPath) {
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        if ($config.persona) { $personaDir = if ([IO.Path]::IsPathRooted($config.persona)) { $config.persona } else { Join-Path $root $config.persona } }
    }
    $personaFile = Join-Path $personaDir 'persona.json'
    if (Test-Path $personaFile) {
        $persona = Get-Content -Raw -LiteralPath $personaFile | ConvertFrom-Json
        if ($persona.voice.model) { $Voice = $persona.voice.model }
    }
}
if ($Voice -notmatch '^([a-z]{2,3})_[A-Z]{2}-([a-z0-9_]+)-(x_low|low|medium|high)$') { throw "Not a Piper voice id: $Voice" }
$voiceFamily = $Matches[1]; $voiceName = $Matches[2]; $voiceQuality = $Matches[3]
$voiceLocale = $Voice.Split('-')[0]
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$hfHub = if ($env:HF_HUB_CACHE) { $env:HF_HUB_CACHE } elseif ($env:HF_HOME) { Join-Path $env:HF_HOME 'hub' } else { Join-Path $HOME '.cache\huggingface\hub' }
$repo = 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo'
$required = @('config.json','model.bin','tokenizer.json','vocabulary.json','preprocessor_config.json')
$cached = Get-ChildItem -LiteralPath (Join-Path $hfHub "$repo\snapshots") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $dir = $_.FullName; @($required | Where-Object { !(Test-Path (Join-Path $dir $_)) }).Count -eq 0 } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
function Copy-Verified($source, $target) {
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    # Python follows cache symlinks and copies bytes, never edits the source/cache.
    & $python -E -s -c 'import shutil,sys; shutil.copyfile(sys.argv[1],sys.argv[2])' $source $target
    if ($LASTEXITCODE -ne 0) { throw 'Model copy failed' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) { throw 'Model copy verification failed' }
}
if (@($required | Where-Object { !(Test-Path (Join-Path $models "whisper\$_")) }).Count -eq 0) {
    Write-Host 'Whisper already present; preserving existing files.'
} elseif ($cached) {
    foreach ($name in $required) { Copy-Verified (Join-Path $cached.FullName $name) (Join-Path $models "whisper\$name") }
    Write-Host "Whisper copied and verified from local snapshot $($cached.Name)"
} elseif ($Download) {
    & $python -E -s -c 'from huggingface_hub import snapshot_download; import sys; snapshot_download(sys.argv[1],local_dir=sys.argv[2],allow_patterns=sys.argv[3:])' 'mobiuslabsgmbh/faster-whisper-large-v3-turbo' (Join-Path $models 'whisper') '*.json' 'model.bin'
    if ($LASTEXITCODE -ne 0) { throw 'Official Whisper model download failed' }
} else { throw 'Whisper cache missing. Re-run with -Download to explicitly download official models.' }
# Piper voices go in models/voices. Older installs keep Amy in models/amy.
foreach ($name in @("$Voice.onnx", "$Voice.onnx.json")) {
    $source = Join-Path $hermesHome "cache\piper-voices\$name"
    $legacy = Join-Path $models "amy\$name"
    $target = Join-Path $models "voices\$name"
    if ((Test-Path $target) -or (Test-Path $legacy)) { Write-Host "Voice already present; preserving: $name" }
    elseif (Test-Path $source) { Copy-Verified $source $target; Write-Host "Voice copied and verified: $name" }
    elseif ($Download) {
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        $pendingVoice = "$target.download"
        try {
            Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/$voiceFamily/$voiceLocale/$voiceName/$voiceQuality/$name" -OutFile $pendingVoice
            Move-Item -LiteralPath $pendingVoice -Destination $target -Force
        } finally { Remove-Item -LiteralPath $pendingVoice -ErrorAction SilentlyContinue }
        Write-Host "Voice downloaded from the official rhasspy/piper-voices repository: $name"
    } else { throw "Voice $Voice missing. Re-run with -Download to explicitly download it." }
}
# Approved sherpa release artifact (CC BY 4.0); not the unmodified upstream model.
# SHA256 computed from the actual release bytes; GitHub supplied no asset digest.
$speakerUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx'
$speakerHash = '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94'
$speaker = Join-Path $models 'speaker\wespeaker_en_voxceleb_resnet34.onnx'
$validSpeaker = (Test-Path $speaker) -and ((Get-FileHash -LiteralPath $speaker -Algorithm SHA256).Hash -eq $speakerHash)
if (!$validSpeaker) {
    if (!$Download) { throw 'Speaker model missing or SHA256 mismatch. Run scripts/setup-models.ps1 -Download explicitly.' }
    New-Item -ItemType Directory -Path (Split-Path $speaker -Parent) -Force | Out-Null
    $pending = "$speaker.download"
    try {
        Invoke-WebRequest -Uri $speakerUrl -OutFile $pending
        if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash -ne $speakerHash) { throw 'Speaker model SHA256 mismatch; existing model was not replaced.' }
        Move-Item -LiteralPath $pending -Destination $speaker -Force
    } finally { Remove-Item -LiteralPath $pending -ErrorAction SilentlyContinue }
}
# Safe isolated ONNX metadata preflight, before invoking the native extractor.
& $python -E -s -c 'import sys; sys.path.insert(0,sys.argv[1]); from speaker import verify_model; print(verify_model(sys.argv[2]))' (Join-Path $root 'sidecar') $speaker
if ($LASTEXITCODE -ne 0) { throw 'Speaker model metadata validation failed' }
# Approved M6 archive; copy only pinned model/token files (no scripts/samples).
$wakeUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2'
$wakeHash = 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a'
$wake = Join-Path $models 'wake'
& $python -E -s (Join-Path $root 'sidecar\wake.py') --verify $wake
if ($LASTEXITCODE -ne 0) {
    if (!$Download) { throw 'Wake model missing/corrupt. Re-run setup-models.ps1 -Download explicitly.' }
    $archive = Join-Path $root '.cache\kws.tar.bz2'
    New-Item -ItemType Directory -Path (Split-Path $archive -Parent) -Force | Out-Null
    $cachedWake = (Test-Path $archive) -and ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $wakeHash)
    if (!$cachedWake) {
        $pendingWake = "$archive.download"
        try {
            Invoke-WebRequest -Uri $wakeUrl -OutFile $pendingWake
            if ((Get-FileHash -LiteralPath $pendingWake -Algorithm SHA256).Hash -ne $wakeHash) { throw 'Wake archive SHA256 mismatch; not installed.' }
            Move-Item -LiteralPath $pendingWake -Destination $archive -Force
        } finally { Remove-Item -LiteralPath $pendingWake -ErrorAction SilentlyContinue }
    }
    & $python -E -s (Join-Path $root 'sidecar\wake.py') --install $archive $wake
    if ($LASTEXITCODE -ne 0) { throw 'Safe pinned wake model installation failed' }
}
& $python -E -s (Join-Path $root 'sidecar\wake.py') --metadata $wake
if ($LASTEXITCODE -ne 0) { throw 'Wake model metadata validation failed' }
# Validate locally with no network (no mic/output device touched).
$env:HF_HUB_OFFLINE = '1'; $env:HF_HUB_DISABLE_TELEMETRY = '1'
& $python -E -s -c 'import sys; sys.path.insert(0,sys.argv[1]); from voice import LocalModels; from persona import Voice; m=LocalModels(sys.argv[2], voice=Voice(sys.argv[4])); pcm,rate=m.synthesize(sys.argv[3]); print(rate,len(pcm))' (Join-Path $root 'sidecar') $models 'Local model setup complete.' $Voice
if ($LASTEXITCODE -ne 0) { throw 'Local model validation failed' }
