# Check the known radial navy compositing profile, excluding colored fabric/rings.
# Multiple independent angular samples must match at BOTH radii. Missing or dense
# shadow fails; no warning-only path. Input is an actual native screen bitmap.
function Assert-OuterShadow($bitmap, [double]$radiusPixels) {
  $counts = @()
  $scale = $radiusPixels / 110.63994528742319
  # Approved body-sized fringe: these radii lie beyond the feathered body and
  # inside the 110.64px shadow, not out at the expanding ribbon edge.
  foreach ($radius in @((106*$scale),(107*$scale))) {
    $matches = 0
    for ($degrees=0; $degrees -lt 360; $degrees+=3) {
      $angle = $degrees*[Math]::PI/180
      $x = [int][Math]::Round(160+$radius*[Math]::Cos($angle))
      $y = [int][Math]::Round(160+$radius*[Math]::Sin($angle))
      $r = [Math]::Sqrt(($x-160)*($x-160)+($y-160)*($y-160))/$radiusPixels
      $t = [Math]::Max(0.0,[Math]::Min(1.0,($r-.6)/.4))
      $inner = [Math]::Max(0.0,[Math]::Min(1.0,($r-.72)/.13))
      $alpha = .58*$inner*$inner*(3-2*$inner)*(1-$t*$t*(3-2*$t))
      $expected = @((255-252*$alpha),(255-247*$alpha),(255-233*$alpha))
      $pixel = $bitmap.GetPixel($x,$y)
      if ($pixel.R -gt 160 -and $pixel.R -lt 254 -and
          [Math]::Abs($pixel.R-$expected[0]) -le 4 -and
          [Math]::Abs($pixel.G-$expected[1]) -le 4 -and
          [Math]::Abs($pixel.B-$expected[2]) -le 4) { $matches++ }
    }
    if ($matches -lt 32) { throw "Shadow profile failed at radius ${radius}: only $matches/120 uncontaminated navy samples (expected >=32), extent=$radiusPixels" }
    $counts += $matches
  }
  return "profile matches r$([Math]::Round(106*$scale,2))=$($counts[0])/120 r$([Math]::Round(107*$scale,2))=$($counts[1])/120, R density remains 160<R<254"
}
