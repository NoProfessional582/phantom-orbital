# Local native screen-frame animation; no desktop settings or media packages.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PreviewWin32 {
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
}
'@
[void][PreviewWin32]::SetProcessDPIAware()
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination=Join-Path $root '.orchestra/previews'; [void][System.IO.Directory]::CreateDirectory($destination)
$form=New-Object System.Windows.Forms.Form
$form.FormBorderStyle='None';$form.ShowInTaskbar=$false;$form.TopMost=$true;$form.StartPosition='Manual'
$form.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;$form.BackColor=[System.Drawing.Color]::FromArgb(5,12,16)
function Pump([int]$ms){$end=[DateTime]::UtcNow.AddMilliseconds($ms);while([DateTime]::UtcNow -lt $end){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 5}}
$p=$null;$frames=New-Object System.Collections.ArrayList
$strip=New-Object System.Drawing.Bitmap(1280,800);$sg=[System.Drawing.Graphics]::FromImage($strip)
try {
 $form.Show();$p=Start-Process (Join-Path $root 'node_modules/electron/dist/electron.exe') -ArgumentList @('.','--state=speaking') -WorkingDirectory $root -PassThru
 for($i=0;$i -lt 100;$i++){Pump 100;$p.Refresh();if($p.MainWindowHandle -ne [IntPtr]::Zero){break}}
 $h=$p.MainWindowHandle;if($h -eq [IntPtr]::Zero){throw 'Native preview window missing'}
 $r=New-Object PreviewWin32+RECT;[void][PreviewWin32]::GetWindowRect($h,[ref]$r)
 [void][PreviewWin32]::SetWindowPos($form.Handle,$h,0,0,0,0,0x13)
 [void][PreviewWin32]::SetCursorPos(10,10);Pump 2000
 $times=New-Object System.Collections.ArrayList;$clock=[System.Diagnostics.Stopwatch]::StartNew()
 # Capture longer than the four-second nucleus period, not just its crest.
 for($i=0;$i -lt 36;$i++){
   $bitmap=New-Object System.Drawing.Bitmap(320,400);$g=[System.Drawing.Graphics]::FromImage($bitmap);$stream=New-Object System.IO.MemoryStream
   try{
     $g.CopyFromScreen($r.Left,$r.Top,0,0,$bitmap.Size)
     [void]$times.Add($clock.ElapsedMilliseconds)
     $corner=$bitmap.GetPixel(5,5);if($corner.ToArgb() -ne $form.BackColor.ToArgb()){throw 'Preview backdrop/corner mismatch'}
     $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
     [void]$frames.Add('data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray()))
     if($i%5 -eq 0){$n=[int]($i/5);$sg.DrawImage($bitmap,($n%4)*320,[Math]::Floor($n/4)*400)}
   }finally{$g.Dispose();$bitmap.Dispose();$stream.Dispose()}
   Pump 120
 }
 $json=ConvertTo-Json -InputObject @($frames.ToArray()) -Compress
 $interval=[int][Math]::Round(($times[$times.Count-1]-$times[0])/($times.Count-1))
 $html='<!doctype html><meta charset="utf-8"><title>Native speaking wave preview</title><style>body{background:#050c10;color:#ddd;font:16px sans-serif}img{width:320px;height:400px}button{margin:12px}</style><p>36 actual native speaking frames spanning a full nucleus pulse, local screen captures. No synthesized frames.</p><button id="play">Pause / play</button><img id="frame"><span id="index"></span><script>const frames='+$json+';let i=0,play=true;const image=document.getElementById("frame");document.getElementById("play").onclick=()=>play=!play;setInterval(()=>{if(play)i=(i+1)%frames.length;image.src=frames[i];document.getElementById("index").textContent="Frame "+i;},120);image.src=frames[0];</script>'
 $html=$html.Replace('},120);','},'+$interval+');')
 [System.IO.File]::WriteAllText((Join-Path $destination 'motion-preview.html'),$html)
 $strip.Save((Join-Path $destination 'motion-strip.png'),[System.Drawing.Imaging.ImageFormat]::Png)
 Write-Output "native preview: $($frames.Count) frames, actual capture times(ms)=$($times -join ','); output=$destination"
}finally{$sg.Dispose();$strip.Dispose();if($p -and -not $p.HasExited){Stop-Process -Id $p.Id -Force};$form.Close();$form.Dispose()}
# All eight final native captures together for visual inspection.
$sheet=New-Object System.Drawing.Bitmap(1280,800);$g=[System.Drawing.Graphics]::FromImage($sheet)
try{$n=0;foreach($shade in @('light','dark')){foreach($state in @('idle','listening','thinking','speaking')){$image=[System.Drawing.Image]::FromFile((Join-Path $root "docs/screenshots/$state-$shade.png"));try{$g.DrawImage($image,($n%4)*320,[Math]::Floor($n/4)*400)}finally{$image.Dispose()};$n++}};$sheet.Save((Join-Path $destination 'native-eight.png'),[System.Drawing.Imaging.ImageFormat]::Png);Write-Output "native contact sheet: $n captures"}finally{$g.Dispose();$sheet.Dispose()}
