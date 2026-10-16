# Native regression: stale forwarded/queued renderer hover cannot capture outside clicks.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class InputProbe {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h,StringBuilder name,int size);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
}
'@
[void][InputProbe]::SetProcessDPIAware()
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$form=New-Object System.Windows.Forms.Form
$form.FormBorderStyle='None'; $form.TopMost=$true; $form.ShowInTaskbar=$false
$form.StartPosition='Manual'; $form.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$clicks=0; $form.Add_MouseDown({$script:clicks++})
function Pump([int]$ms) { $end=[DateTime]::UtcNow.AddMilliseconds($ms); while([DateTime]::UtcNow -lt $end){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 5} }
$p=$null
try {
 $form.Show(); Pump 200
 $p=Start-Process (Join-Path $root 'node_modules/electron/dist/electron.exe') -ArgumentList @('.','--state=listening','--remote-debugging-port=9333') -WorkingDirectory $root -PassThru
 for($i=0;$i -lt 100;$i++){Pump 100;$p.Refresh();if($p.MainWindowHandle -ne [IntPtr]::Zero){break}}
 $orb=$p.MainWindowHandle; if($orb -eq [IntPtr]::Zero){throw 'Native orb did not launch'}
 $r=New-Object InputProbe+RECT; [void][InputProbe]::GetWindowRect($orb,[ref]$r)
 [void][InputProbe]::SetWindowPos($form.Handle,$orb,0,0,0,0,0x13)
 [void][InputProbe]::SetCursorPos($r.Left+285,$r.Top+151); Pump 500
 $point=[InputProbe+POINT]::new($r.Left+285,$r.Top+151)
 $baseline=[InputProbe]::WindowFromPoint($point)
 if($baseline -ne $form.Handle){throw "Baseline target=$baseline backdrop=$($form.Handle) orb=$orb"}
 node (Join-Path $PSScriptRoot 'input-hint-probe.mjs')
 $interceptions=0
 for($i=0;$i -lt 100;$i++){
   $target=[InputProbe]::WindowFromPoint($point)
   if($target -ne $form.Handle){$interceptions++;if($interceptions -eq 1){$owner=0;$name=New-Object System.Text.StringBuilder 256;[void][InputProbe]::GetWindowThreadProcessId($target,[ref]$owner);[void][InputProbe]::GetClassName($target,$name,256);Write-Output "actual interception: HWND=$target PID=$owner class=$name orb=$orb backdrop=$($form.Handle) cursor=$([System.Windows.Forms.Cursor]::Position)"}}
   Pump 5
 }
 [InputProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[InputProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Pump 100
 Write-Output "queued-hint native probe: intercepted=$interceptions/100 backdropClicks=$clicks baseline=$baseline orb=$orb"
 if($interceptions -ne 0 -or $clicks -ne 1){throw 'Queued renderer hover hint captured outside-circle input'}
} finally { if($p -and -not $p.HasExited){Stop-Process -Id $p.Id -Force};$form.Close();$form.Dispose() }
