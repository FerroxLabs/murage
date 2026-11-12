# MAIN: run from a normal Windows PowerShell console on the Desktop PC.
# Requires a checkout of F0.3 and Node >=24. No install, credentials or network.
param([string]$Checkout = 'C:\murage-ci')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $Checkout
$nodeMajor = [int]((& node -p 'parseInt(process.versions.node)').Trim())
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 24) { throw 'Node 24 or newer is required' }
$platform = (& node -p 'process.platform').Trim()
if ($platform -ne 'win32') { throw 'Run this script on the Windows Desktop PC' }
$evidence = Join-Path $Checkout 'evidence\f03-windows'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$originalRoot = $env:MURAGE_F03_TEST_ROOT
try {
  $env:MURAGE_F03_TEST_ROOT = $evidence
  & git rev-parse HEAD | Set-Content -LiteralPath (Join-Path $evidence 'head.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot record checkout SHA' }
  & node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/highlevel-f03-native.mjs 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'native.log')
  $result = $LASTEXITCODE
  $result | Set-Content -LiteralPath (Join-Path $evidence 'native.rc')
  if ($result -ne 0) { throw "F0.3 Windows native tests failed ($result)" }
  Write-Output 'PASS F0.3 Windows NTFS; no live app or provider used'
} finally { $env:MURAGE_F03_TEST_ROOT = $originalRoot }
