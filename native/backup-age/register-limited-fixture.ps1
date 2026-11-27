param([Parameter(Mandatory=$true)][string]$Account,[Parameter(Mandatory=$true)][string]$DesktopSid,[Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][string]$ProbeSha256,[Parameter(Mandatory=$true)][string]$HelperSha256)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-identity.ps1')
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-paths.ps1')
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-run.ps1')
$ProfileRoot=Confirm-QualificationProfile $Account $DesktopSid $ProfileRoot
Invoke-QualificationSibling -Account $Account -DesktopSid $DesktopSid -ProfileRoot $ProfileRoot -RepoRoot $PSScriptRoot -Scratch 'murage-b20-native-20260913-103710' -TaskName 'Murage-B20-Limited-20260913-113648' -Mode '--limited-session' -Log 'limited-session.log' -Xml 'limited-task.xml' -Invoked 'limited-task-invoked.txt' -Lease 'limited-session-lease.txt' -LimitMinutes 10 -ProbeSha256 $ProbeSha256 -HelperSha256 $HelperSha256
