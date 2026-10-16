# Test-only native chord injection. Never runs against a real-microphone app.
param([int]$HoldMs = 500, [switch]$Mute, [switch]$Approval)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$testApp = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'electron.exe' -and $_.CommandLine -like "*$root*" -and
    $_.CommandLine -like '*--mock-hermes*' -and $_.CommandLine -like '*--voice-smoke*'
}
if (@($testApp).Count -ne 1) { throw 'Exactly one explicit --mock-hermes --voice-smoke Orb must be running; refusing key injection.' }
Add-Type @'
using System.Runtime.InteropServices;
public static class OrbVoiceTestKeys {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr window);
}
'@
$modifier = if ($Mute -or $Approval) { [byte]0x12 } else { [byte]0x10 }
$key = if ($Approval) { [byte]0x59 } elseif ($Mute) { [byte]0x4D } else { [byte]0x20 }
# Foreground selection is fixture setup, not consent. Never send keys to the
# terminal/RDP/another app, and never turn an already-held chord into an edge.
foreach ($vk in @(0x11, 0x12, 0x10, 0x5B, 0x5C, $key)) {
    if ([OrbVoiceTestKeys]::GetAsyncKeyState($vk) -band 0x8000) { throw 'A physical key is already held; refusing synthetic input.' }
}
$window = (Get-Process -Id $testApp.ProcessId).MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'Owned synthetic window unavailable.' }
[OrbVoiceTestKeys]::SetForegroundWindow($window) | Out-Null
[uint32]$foregroundPid = 0
# Bounded fixture setup only, with NO keys injected. Require 150ms of stable
# owned foreground so main can publish focus and sidecar can sample release.
$deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1000
$stableSince = 0
do {
    [OrbVoiceTestKeys]::GetWindowThreadProcessId([OrbVoiceTestKeys]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($foregroundPid -eq $testApp.ProcessId) {
        if ($stableSince -eq 0) { $stableSince = $now }
    } else {
        $stableSince = 0
        [OrbVoiceTestKeys]::SetForegroundWindow($window) | Out-Null
    }
    if ($stableSince -ne 0 -and $now - $stableSince -ge 150) { break }
    Start-Sleep -Milliseconds 10
} while ($now -lt $deadline)
[OrbVoiceTestKeys]::GetWindowThreadProcessId([OrbVoiceTestKeys]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
Write-Output ("NATIVE foreground pid={0} name={1} syntheticApp={2}" -f $foregroundPid, (Get-Process -Id $foregroundPid).ProcessName, $testApp.ProcessId)
if ($foregroundPid -ne $testApp.ProcessId -or $stableSince -eq 0 -or $now - $stableSince -lt 150) { throw 'Synthetic Orb is not the stable native foreground target; refusing foreign key injection.' }
foreach ($vk in @(0x11, 0x12, 0x10, 0x5B, 0x5C, $key)) {
    if ([OrbVoiceTestKeys]::GetAsyncKeyState($vk) -band 0x8000) { throw 'A physical key is already held; refusing synthetic input.' }
}
# Caller checks registration/readiness before -Mute or -Approval.
try {
    [OrbVoiceTestKeys]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
    [OrbVoiceTestKeys]::keybd_event($modifier,0,0,[UIntPtr]::Zero)
    [OrbVoiceTestKeys]::keybd_event($key,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    Write-Output ("NATIVE down t={0} ctrl={1} modifier={2} key={3} foreground={4}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([OrbVoiceTestKeys]::GetAsyncKeyState(0x11) -band 0x8000), ([OrbVoiceTestKeys]::GetAsyncKeyState($modifier) -band 0x8000), ([OrbVoiceTestKeys]::GetAsyncKeyState($key) -band 0x8000), [OrbVoiceTestKeys]::GetForegroundWindow())
    $until = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $HoldMs
    $last = ''
    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $until) {
        $state = "{0}/{1}/{2}" -f ([OrbVoiceTestKeys]::GetAsyncKeyState(0x11) -band 0x8000), ([OrbVoiceTestKeys]::GetAsyncKeyState($modifier) -band 0x8000), ([OrbVoiceTestKeys]::GetAsyncKeyState($key) -band 0x8000)
        if ($state -ne $last) { Write-Output ("NATIVE sample t={0} state={1}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $state); $last = $state }
        if ($state -ne '32768/32768/32768') { throw 'Synthetic native chord was not continuously down; no retry.' }
        [OrbVoiceTestKeys]::GetWindowThreadProcessId([OrbVoiceTestKeys]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
        if ($foregroundPid -ne $testApp.ProcessId) { throw 'Native foreground changed during synthetic hold; no retry.' }
        Start-Sleep -Milliseconds 10
    }
} finally {
    [OrbVoiceTestKeys]::keybd_event($key,0,2,[UIntPtr]::Zero)
    [OrbVoiceTestKeys]::keybd_event($modifier,0,2,[UIntPtr]::Zero)
    [OrbVoiceTestKeys]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
    Write-Output ("NATIVE up t={0} ctrl={1} modifier={2} key={3} foreground={4}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([OrbVoiceTestKeys]::GetAsyncKeyState(0x11) -band 0x8000), ([OrbVoiceTestKeys]::GetAsyncKeyState($modifier) -band 0x8000), ([OrbVoiceTestKeys]::GetAsyncKeyState($key) -band 0x8000), [OrbVoiceTestKeys]::GetForegroundWindow())
}
Write-Output 'Synthetic-only native chord released.'
