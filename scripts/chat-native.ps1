# Native M2 input regression; attach only the project's mock demo on port 9335.
param([switch]$TextControl)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ChatWin32 {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
}
'@
[void][ChatWin32]::SetProcessDPIAware()
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$owner=(Get-NetTCPConnection -LocalPort 9335 -State Listen).OwningProcess
$p=Get-Process -Id $owner; $orb=$p.MainWindowHandle
if(!$orb){throw 'Native Orb window missing'}
function Pump([int]$ms){$end=[DateTime]::UtcNow.AddMilliseconds($ms);while([DateTime]::UtcNow -lt $end){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 10}}
function Probe([string]$mode){$out=& node.exe (Join-Path $PSScriptRoot 'chat-probe.mjs') $mode;if($LASTEXITCODE -ne 0){throw "CDP $mode failed"};Write-Output $out}
function Toggle(){
 if($TextControl){
  $state=(& node.exe (Join-Path $PSScriptRoot 'chat-probe.mjs') 'snapshot') | ConvertFrom-Json
  $b=New-Object ChatWin32+RECT;[void][ChatWin32]::GetWindowRect($orb,[ref]$b)
  [void][ChatWin32]::SetCursorPos($b.Left+[int]$state.textCenter.x,$b.Top+[int]$state.textCenter.y);Pump 300
  [ChatWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[ChatWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 }else{[System.Windows.Forms.SendKeys]::SendWait('^+ ')}
 Pump 500
}
$form=New-Object System.Windows.Forms.Form
$form.FormBorderStyle='None';$form.TopMost=$true;$form.ShowInTaskbar=$false;$form.StartPosition='Manual';$form.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$clicks=0;$form.Add_MouseDown({$script:clicks++})
try {
 Probe 'prepare'
 $form.Show();Pump 200
 [void][ChatWin32]::SetWindowPos($form.Handle,$orb,0,0,0,0,0x13)
 [void][ChatWin32]::SetForegroundWindow($orb)
 if([ChatWin32]::GetForegroundWindow() -ne $orb){throw 'Orb is not foreground for shortcut test'}
 Toggle;Probe 'open'
 $r=New-Object ChatWin32+RECT;[void][ChatWin32]::GetWindowRect($orb,[ref]$r)
 if(($r.Right-$r.Left) -ne 320 -or ($r.Bottom-$r.Top) -ne 520){throw 'Chat shell must expand to 320x520'}
 foreach($point in @(@(0,0),@(319,519),@(285,151))){
  [void][ChatWin32]::SetCursorPos($r.Left+$point[0],$r.Top+$point[1]);Pump 250
  $target=[ChatWin32]::WindowFromPoint([ChatWin32+POINT]::new($r.Left+$point[0],$r.Top+$point[1]))
  if($target -ne $form.Handle){throw "Transparent point intercepted: $point"}
 }
 [ChatWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[ChatWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Pump 100
 if($clicks -ne 1){throw 'Outside click did not reach backdrop'}
 [void][ChatWin32]::SetWindowPos($form.Handle,$orb,0,0,0,0,0x13)
 [void][ChatWin32]::SetCursorPos($r.Left+50,$r.Top+490);Pump 250
 $target=[ChatWin32]::WindowFromPoint([ChatWin32+POINT]::new($r.Left+50,$r.Top+490))
 if([ChatWin32]::GetAncestor($target,2) -ne $orb){throw 'Text input did not capture native hover'}
 [ChatWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[ChatWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Pump 100
 [void][ChatWin32]::SetForegroundWindow($orb)
 if([ChatWin32]::GetForegroundWindow() -ne $orb){throw 'Orb is not foreground; refusing to type'}
 [System.Windows.Forms.SendKeys]::SendWait('native keyboard{ENTER}');Pump 1800
 Probe 'native-answer';Probe 'capture'
 # Captions below the old 400px shell are interactive, not click-through.
 [void][ChatWin32]::SetCursorPos($r.Left+30,$r.Top+350);Pump 250
 $target=[ChatWin32]::WindowFromPoint([ChatWin32+POINT]::new($r.Left+30,$r.Top+350))
 if([ChatWin32]::GetAncestor($target,2) -ne $orb){throw 'Caption scroll/select area did not capture native input'}
 Toggle;Probe 'closed';Probe 'prepare'
 [void][ChatWin32]::GetWindowRect($orb,[ref]$r)
 if(($r.Bottom-$r.Top) -ne 400){throw 'Dismissed chat did not restore 320x400 shell'}
 $toggle=if($TextControl){'Text button fallback (global hotkey not tested in this mode)'}else{'Ctrl+Shift+Space'}
 Write-Output "Native chat PASS: $toggle open/close; native click/type/Enter; real mock caption; caption hit; three transparent points; backdrop click; 320x400 restored."
} finally {$form.Close();$form.Dispose()}
