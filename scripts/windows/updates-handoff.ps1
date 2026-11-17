[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$Fixture,
 [Parameter(Mandatory=$true)][string]$Receipt,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
 [string]$FeedDirectory='C:\murage-ci\feed',
 [string]$Node='C:\murage-ci\node\node.exe'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:COMPUTERNAME -ine 'gate-win-nogit' -or $env:USERNAME -cne 'murage-gate'){throw 'Full install is bound to gate-win-nogit and gate-owned murage-gate user'}
$marker=Get-Content -LiteralPath 'C:\murage-ci\gate-user.json' -Raw | ConvertFrom-Json
if($marker.sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Not the provisioned gate user'}
if($env:MURAGE_DATA_DIR -or $env:MURAGE_USER_DATA){throw 'Default profile required'}
. (Join-Path $PSScriptRoot 'scenario-common.ps1')
Invoke-PackagedScenario -Kind handoff -Executable $Executable -Fixture $Fixture -Receipt $Receipt -Commit $Commit -FeedDirectory $FeedDirectory -Node $Node -Groups @('updates-handoff')
