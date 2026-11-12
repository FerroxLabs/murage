param(
  [Parameter(Mandatory=$true)][string]$Package,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Plan,
  [string]$Case,
  [switch]$Admit
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Package -PathType Leaf)) { throw 'Packaged S0 Murage.exe required' }
if (Test-Path -LiteralPath $Out) { throw 'Output directory must be new' }
if ($Package.Contains('"') -or $Out.Contains('"') -or ($Plan -and $Plan.Contains('"'))) { throw 'Quote in path' }
$arguments = @('--out', ('"' + $Out + '"'))
if ($Admit) { $arguments += '--admit' } else {
  if (-not $Plan) { throw 'Plan required (or -Admit)' }
  $arguments += @('--plan', ('"' + $Plan + '"'))
}
if ($Case) { $arguments += @('--case', $Case) }
$p = Start-Process -FilePath $Package -ArgumentList $arguments -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "S0 OPEN: inspect $Out for OPEN.json or cleanup.json" }
Write-Output "S0_CAPTURED $Out (not qualified; finalize and review required)"
