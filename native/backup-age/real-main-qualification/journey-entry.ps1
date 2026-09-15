param([Parameter(Mandatory=$true)][string]$Parent)
$ErrorActionPreference='Stop'
$log=Join-Path $Parent 'journey-console.log'
try {
  $global:LASTEXITCODE=0
  & (Join-Path $Parent 'fixture\run.ps1') -Manifest (Join-Path $Parent 'journey-manifest.json') *> $log
  exit $LASTEXITCODE
} catch {
  $_ | Out-String | Add-Content -LiteralPath $log
  exit 1
}
