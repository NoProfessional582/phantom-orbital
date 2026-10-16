# Exercises the actual project tray icon in the Windows 11 overflow flyout.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TrayWin32 {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
$process = Get-CimInstance Win32_Process -Filter "name = 'electron.exe'" |
  Where-Object { $_.CommandLine -match 'phantom-orbital.*electron.exe"? \. --state=idle' -and $_.CommandLine -notmatch '--type=' } |
  Select-Object -First 1
if (-not $process) { throw 'No running project Electron idle process' }
$orbPid = $process.ProcessId
$orbHandle = (Get-Process -Id $orbPid).MainWindowHandle
if ($orbHandle -eq [IntPtr]::Zero) { throw 'Project orb window handle unavailable before tray test' }
function Visible {
  return [TrayWin32]::IsWindowVisible($orbHandle)
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
function ByName([string]$name) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Icon {
  $class = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TopLevelWindowForOverflowXamlIsland')
  $overflow = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $class)
  $name = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ' Phantom Orbital Assistant')
  $icon = if ($overflow) { $overflow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $name) } else { $null }
  if (-not $icon) {
    $button = ByName 'Show Hidden Icons'
    if (-not $button) { throw 'Windows 11 hidden-icons button unavailable' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 400
    $overflow = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $class)
    $icon = if ($overflow) { $overflow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $name) } else { $null }
  }
  if (-not $icon) { throw 'Phantom Orbital icon not exposed in tray overflow' }
  return $icon
}
function ClickIcon([bool]$right) {
  $rect = (Icon).Current.BoundingRectangle
  [void][TrayWin32]::SetCursorPos([int]($rect.X+$rect.Width/2),[int]($rect.Y+$rect.Height/2))
  Start-Sleep -Milliseconds 100
  if ($right) { [TrayWin32]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [TrayWin32]::mouse_event(16,0,0,0,[UIntPtr]::Zero) }
  else {
    for ($i=0; $i -lt 2; $i++) { [TrayWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [TrayWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80 }
  }
  Start-Sleep -Milliseconds 450
}
$before = Visible
ClickIcon $false
$hidden = -not (Visible)
ClickIcon $false
$shown = Visible
ClickIcon $true
$menu = ByName 'Quit'
if (-not $menu) { throw "Tray context menu Quit item unavailable (before=$before hidden=$hidden shown=$shown)" }
$rect = $menu.Current.BoundingRectangle
[void][TrayWin32]::SetCursorPos([int]($rect.X+$rect.Width/2),[int]($rect.Y+$rect.Height/2))
[TrayWin32]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [TrayWin32]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 600
$quit = -not [bool](Get-Process -Id $orbPid -ErrorAction SilentlyContinue)
"tray: before=$before hidden=$hidden shown=$shown quit=$quit pid=$orbPid"
if (-not ($before -and $hidden -and $shown -and $quit)) { exit 1 }
