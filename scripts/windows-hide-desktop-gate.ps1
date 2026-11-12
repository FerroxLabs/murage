# Desktop half plus the mandatory same-candidate gate-win-nogit receipt.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$ScenarioScript,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
 [Parameter(Mandatory=$true)][string]$HandoffReceipt,
 [string]$Node='C:\murage-ci\node\node.exe',
 [string]$FeedDirectory='C:\murage-ci\feed',
 [string]$Root='C:\murage-ci'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'gate-admission.ps1')
Assert-GateAdmission
if($Root -ne 'C:\murage-ci'){throw 'Gate root must be C:\murage-ci'}
# Validate the second half before starting anything on the Desktop.
$helper=Join-Path (Split-Path -Parent $ScenarioScript) 'owned-process.ps1'
. $helper
$validate=Invoke-WindowsNative $Node @((Join-Path (Split-Path -Parent $ScenarioScript) 'validate-receipt.mjs'),$HandoffReceipt)
if($validate.ExitCode -ne 0){throw 'A complete handoff receipt with artifacts is required'}
$handoff=Get-Content -LiteralPath $HandoffReceipt -Raw | ConvertFrom-Json
if($handoff.kind -ne 'handoff' -or $handoff.commit -ne $Commit -or $handoff.sha256 -ne (Get-FileHash -LiteralPath $Executable).Hash){throw 'Handoff candidate commit/hash mismatch'}
$run=Join-Path $Root ('runs\winhide-'+[Guid]::NewGuid().ToString('N'))
$receipt=Join-Path $run 'scenario.json'
try {
 & $ScenarioScript -Executable $Executable -Fixture $run -Receipt $receipt -Commit $Commit -FeedDirectory $FeedDirectory -Node $Node
} catch {
 if(Test-Path -LiteralPath $run){"FAIL winhide $($_.Exception.Message)" | Set-Content -LiteralPath (Join-Path $run 'result.txt')}
 throw
}
