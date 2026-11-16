param([ValidateSet('desktop','handoff')][string]$Kind,[string]$File)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
. (Join-Path $PSScriptRoot 'ownership.ps1')
[void](Assert-GatePath $File)
Get-OwnershipSnapshot $Kind | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $File -Encoding UTF8
