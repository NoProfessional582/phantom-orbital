# Local Win32 smoke/captures: no wallpaper changes, network, microphone or Hermes API.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'shadow-check.ps1')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OrbWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x,int y) { X=x; Y=y; } }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
}
'@
[void][OrbWin32]::SetProcessDPIAware()
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $root 'node_modules/electron/dist/electron.exe'
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$backdrop = New-Object System.Windows.Forms.Form
$backdrop.FormBorderStyle = 'None'; $backdrop.ShowInTaskbar = $false
$backdrop.TopMost = $true
$backdrop.StartPosition = 'Manual'; $backdrop.Bounds = $screen
$backdrop.BackColor = [System.Drawing.Color]::White
$clicks = 0
$backdrop.Add_MouseDown({ $script:clicks++ })
$results = New-Object System.Collections.ArrayList
function Pump([int]$milliseconds) {
  $end = [DateTime]::UtcNow.AddMilliseconds($milliseconds)
  while ([DateTime]::UtcNow -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 40 }
}
function Bounds($p) {
  $p.Refresh(); $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero -or -not [OrbWin32]::IsWindowVisible($h)) { return $null }
  $r = New-Object OrbWin32+RECT
  if (-not [OrbWin32]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ H = $h; X = $r.Left; Y = $r.Top; W = $r.Right - $r.Left; Height = $r.Bottom - $r.Top }
}
function Launch([string]$state) {
  $p = Start-Process -FilePath $electron -ArgumentList @('.', "--state=$state") -WorkingDirectory $root -PassThru
  for ($i=0; $i -lt 100; $i++) {
    Pump 100
    if ($p.HasExited) { throw "Electron exited early in $state ($($p.ExitCode))" }
    $b = Bounds $p
    if ($b -and $b.W -eq 320 -and $b.Height -eq 400) {
      # Both windows remain topmost, but place the local backdrop immediately below Electron.
      [void][OrbWin32]::SetWindowPos($backdrop.Handle, $b.H, 0, 0, 0, 0, 0x13)
      return $p
    }
  }
  throw "No visible 320x400 window for $state (PID $($p.Id))"
}
function Shot($p, [string]$state, [string]$shade) {
  $b = Bounds $p
  if (-not $b) { throw "Window disappeared during $state-$shade capture" }
  $bitmap = New-Object System.Drawing.Bitmap($b.W, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bitmap.Size)
    $path = Join-Path $root "docs/screenshots/$state-$shade.png"

    $center = $bitmap.GetPixel(160,151)
    $corner = $bitmap.GetPixel(5,5)
    $expected = if ($shade -eq 'light') { [System.Drawing.Color]::White } else { [System.Drawing.Color]::FromArgb(5,12,16) }
    foreach ($point in @(@(5,5),@(314,5),@(5,394),@(314,394))) {
      if ($bitmap.GetPixel($point[0],$point[1]).ToArgb() -ne $expected.ToArgb()) { throw "Native corner transparency check failed for $state-$shade at $point" }
    }
    if ($center.ToArgb() -eq $corner.ToArgb()) { throw "Native interior check failed for $state-$shade" }
    if ($shade -eq 'light') {
      $shadowPixel = $bitmap.GetPixel(285,151)
      # That coordinate is crossed by expanded blue fabric. Measure the shadow's
      # radial RGB profile instead, requiring many uncontaminated samples at two
      # radii. Approved 79095df uses .90 body scale for all four capture states;
      # the nucleus/fabric pulses must not change this shadow extent.
      # Keep the original density bounds and all native input assertions.
      $bodyScale = @{idle=.90;listening=.90;thinking=.90;speaking=.90}[$state]
      $extent = 1.18*$bodyScale/(5.1*[Math]::Tan(37*[Math]::PI/360))*160
      $profile = Assert-OuterShadow $bitmap $extent
      [void]$results.Add("outer shadow ${state}: $profile; former sample285,151 RGB=$($shadowPixel.R),$($shadowPixel.G),$($shadowPixel.B) (may contain fabric)")
    }
    # Do not replace valid captures with a black frame from a locked desktop.
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$results.Add("capture ${state}-${shade}: $($b.W)x$($b.Height), corner=$($corner.R),$($corner.G),$($corner.B) center=$($center.R),$($center.G),$($center.B)")
  } finally { $g.Dispose(); $bitmap.Dispose() }
}
function Mouse([int]$x, [int]$y, [uint32]$flag) {
  [void][OrbWin32]::SetCursorPos($x,$y); Pump 180
  $cursor = [System.Windows.Forms.Cursor]::Position
  if ($cursor.X -ne $x -or $cursor.Y -ne $y) { throw "Cursor moved away from requested test point ${x},${y}: actual=$cursor" }
  if ($flag) { [OrbWin32]::mouse_event($flag,0,0,0,[UIntPtr]::Zero); Pump 80 }
}
try {
  $backdrop.Show(); Pump 250
  foreach ($state in @('idle','listening','transcribing','thinking','working','speaking','approval','offline','muted')) {
    $p = Launch $state
    try {
      Mouse ($screen.Left+10) ($screen.Top+10) 0
      Pump 1300
      foreach ($shade in $(if ($state -in @('idle','listening','thinking','speaking')) { @('light','dark') } else { @() })) {
        $backdrop.BackColor = if ($shade -eq 'light') { [System.Drawing.Color]::White } else { [System.Drawing.Color]::FromArgb(5,12,16) }
        Pump 380
        Shot $p $state $shade
      }
      # The visible outer shadow must not acquire an input interception region.
      $b = Bounds $p
      $beforeClicks = $clicks
      Mouse ($b.X+285) ($b.Y+151) 0
      $shadowHit = [OrbWin32]::WindowFromPoint([OrbWin32+POINT]::new($b.X+285,$b.Y+151))
      Mouse ($b.X+285) ($b.Y+151) 2; Mouse ($b.X+285) ($b.Y+151) 4; Pump 250
      Write-Output "input diagnostic ${state}: target=$shadowHit backdrop=$($backdrop.Handle) orb=$($b.H) clicks=$beforeClicks->$clicks cursor=$([System.Windows.Forms.Cursor]::Position) backdropTopMost=$($backdrop.TopMost)"
      if ($shadowHit -ne $backdrop.Handle -or $clicks -le $beforeClicks) { throw "Visual shadow intercepted outside-circle input in $state" }
      [void]$results.Add("shadow click-through ${state}: reached backdrop")
      # Verify the backdrop has not jumped above the orb, and entering the body
      # restores real input capture. Child render-widget HWNDs belong to the orb.
      # Clicking a topmost WinForms backdrop activates/promotes it on Windows.
      # Restore its intended position BELOW the orb before checking body input.
      [void][OrbWin32]::SetWindowPos($backdrop.Handle, $b.H, 0, 0, 0, 0, 0x13)
      Mouse ($b.X+160) ($b.Y+151) 0
      $bodyHit = [OrbWin32]::WindowFromPoint([OrbWin32+POINT]::new($b.X+160,$b.Y+151))
      if ([OrbWin32]::GetAncestor($bodyHit,2) -ne $b.H) { throw "Body input/z-order failed in ${state}: target=$bodyHit orb=$($b.H) backdrop=$($backdrop.Handle)" }
      [void]$results.Add("body input ${state}: target=$bodyHit belongs to orb=$($b.H)")
      if ($state -eq 'idle') {
        $b = Bounds $p
        Mouse ($b.X+10) ($b.Y+12) 0
        $outside = [OrbWin32]::WindowFromPoint([OrbWin32+POINT]::new($b.X+10,$b.Y+12))
        Mouse ($b.X+10) ($b.Y+12) 2; Mouse ($b.X+10) ($b.Y+12) 4; Pump 250
        [void]$results.Add("click-through: windowAtCorner=$outside backdropHandle=$($backdrop.Handle) backdropMouseDown=$clicks")
        if ($outside -ne $backdrop.Handle -or $clicks -lt 1) { throw 'Circle click-through did not reach local backdrop' }
        # Lower the test backdrop before dragging so it cannot steal mouse input.
        $backdrop.TopMost = $false
        Mouse ($b.X+160) ($b.Y+151) 0
        $inside = [OrbWin32]::WindowFromPoint([OrbWin32+POINT]::new($b.X+160,$b.Y+151))
        Mouse ($b.X+160) ($b.Y+151) 2
        Mouse ($b.X+106) ($b.Y+102) 0
        Mouse ($b.X+106) ($b.Y+102) 4; Pump 450
        $after = Bounds $p
        [void]$results.Add("drag: from=$($b.X),$($b.Y) to=$($after.X),$($after.Y), insideHandle=$inside orbHandle=$($b.H)")
        if ($after.X -ne ($b.X-54) -or $after.Y -ne ($b.Y-49)) { throw "Native drag mismatch: from $($b.X),$($b.Y) to $($after.X),$($after.Y); expected $($b.X-54),$($b.Y-49); insideHandle=$inside orbHandle=$($b.H)" }
        $saved = "$($after.X),$($after.Y)"
        $backdrop.TopMost = $true
      }
    } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; $p.WaitForExit() }; Pump 400 }
  }
  $p = Launch 'idle'
  try {
    $b = Bounds $p
    [void]$results.Add("restart position: saved=$saved reopened=$($b.X),$($b.Y)")
    if ($saved -ne "$($b.X),$($b.Y)") { throw 'Restart did not retain drag position' }
    $second = Start-Process -FilePath $electron -ArgumentList @('.', '--state=idle') -WorkingDirectory $root -PassThru
    Pump 900
    [void]$results.Add("single-instance: firstPID=$($p.Id) secondExited=$($second.HasExited) secondExitCode=$(if($second.HasExited){$second.ExitCode}else{'running'})")
    if (-not $second.HasExited -or $second.ExitCode -ne 0) { throw 'Second instance did not relinquish lock' }
    if (-not $second.HasExited) { Stop-Process -Id $second.Id -Force }
  } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
} finally {
  $backdrop.Close(); $backdrop.Dispose()
}
$results | ForEach-Object { Write-Output $_ }
