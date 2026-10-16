$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'shadow-check.ps1')
function Fixture([string]$kind, [double]$extent) {
  $image = New-Object System.Drawing.Bitmap(320,400)
  for ($y=0; $y -lt 400; $y++) { for ($x=0; $x -lt 320; $x++) {
    $drawExtent = if ($kind -eq 'old-radius') { $extent*.85/.90 } else { $extent }
    $r = [Math]::Sqrt(($x-160)*($x-160)+($y-160)*($y-160)) / $drawExtent
    $t = [Math]::Max(0.0,[Math]::Min(1.0,($r-.6)/.4))
    $inner = [Math]::Max(0.0,[Math]::Min(1.0,($r-.72)/.13))
    $a = .58*$inner*$inner*(3-2*$inner)*(1-$t*$t*(3-2*$t))
    if ($kind -eq 'missing') { $a = 0 }
    if ($kind -eq 'dense') { $a = [Math]::Min(1.0,$a*3) }
    $color = [System.Drawing.Color]::FromArgb([int][Math]::Round(255-252*$a),[int][Math]::Round(255-247*$a),[int][Math]::Round(255-233*$a))
    if ($kind -eq 'wrong-color') { $color = [System.Drawing.Color]::FromArgb($color.R,$color.G,[Math]::Max(0,$color.B-20)) }
    # Simulate a moving blue ribbon over the formerly sampled right-side sector.
    if ($kind -eq 'fabric' -and $x -gt 240 -and $y -gt 125 -and $y -lt 195) { $color=[System.Drawing.Color]::FromArgb(58,86,158) }
    $image.SetPixel($x,$y,$color)
  } }
  return $image
}
foreach ($scale in @(.80,.90,.92)) {
  $extent=1.18*$scale/(5.1*[Math]::Tan(37*[Math]::PI/360))*160
  foreach ($kind in @('valid','fabric','missing','dense','old-radius','wrong-color')) {
  $image = Fixture $kind $extent

  try {
    $rejected = $false
    try { $result = Assert-OuterShadow $image $extent } catch { $rejected = $true; if ($kind -in @('valid','fabric')) { throw } }
    $shouldReject = $kind -in @('missing','dense','old-radius','wrong-color')
    if ($rejected -ne $shouldReject) { throw "Shadow fixture ${kind}: rejected=$rejected, expected=$shouldReject" }
    Write-Output "shadow fixture ${kind} scale=${scale}: PASS (rejected=$rejected)"
  } finally { $image.Dispose() }
  }
}
