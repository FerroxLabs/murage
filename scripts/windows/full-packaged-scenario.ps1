[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$Fixture,
 [Parameter(Mandatory=$true)][string]$Receipt,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
 [string]$FeedDirectory='C:\murage-ci\feed',
 [string]$Node='C:\murage-ci\node\node.exe',
 [ValidateSet('bot-turns','tools','sentinel','mcp','browser','updates-isolated')][string[]]$Groups=@('bot-turns','tools','sentinel','mcp','browser','updates-isolated')
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'scenario-common.ps1')
Invoke-PackagedScenario -Kind desktop -Executable $Executable -Fixture $Fixture -Receipt $Receipt -Commit $Commit -FeedDirectory $FeedDirectory -Node $Node -Groups $Groups
