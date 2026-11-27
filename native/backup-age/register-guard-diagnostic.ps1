param([Parameter(Mandatory=$true)][string]$Account,[Parameter(Mandatory=$true)][string]$DesktopSid,[Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][string]$ProbeSha256,[Parameter(Mandatory=$true)][string]$HelperSha256)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-identity.ps1')
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-paths.ps1')
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-run.ps1')
$ProfileRoot=Confirm-QualificationProfile $Account $DesktopSid $ProfileRoot
Invoke-QualificationSibling -Account $Account -DesktopSid $DesktopSid -ProfileRoot $ProfileRoot -RepoRoot $PSScriptRoot -Scratch 'murage-b20-native-20260913-103710' -TaskName 'Murage-B20-GuardDiagnostic-20260913-115706' -Mode '--guard-diagnostic' -Log 'guard-diagnostic.log' -Xml 'guard-diagnostic-task.xml' -Invoked 'guard-diagnostic-invoked.txt' -Lease 'guard-diagnostic-lease.txt' -LimitMinutes 5 -ProbeSha256 $ProbeSha256 -HelperSha256 $HelperSha256
