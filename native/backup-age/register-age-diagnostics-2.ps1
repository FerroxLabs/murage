param([Parameter(Mandatory=$true)][string]$Account,[Parameter(Mandatory=$true)][string]$DesktopSid,[Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][string]$ProbeSha256,[Parameter(Mandatory=$true)][string]$HelperSha256)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-identity.ps1')
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-paths.ps1')
. (Join-Path $PSScriptRoot 'real-main-qualification\qualification-run.ps1')
$ProfileRoot=Confirm-QualificationProfile $Account $DesktopSid $ProfileRoot
Invoke-QualificationSibling -Account $Account -DesktopSid $DesktopSid -ProfileRoot $ProfileRoot -RepoRoot $PSScriptRoot -Scratch 'murage-b20-dirguard-20260913-154251' -TaskName 'Murage-B20-AgeDiagnostics-20260913-160800' -Mode '--limited-session' -Log 'age-diagnostics-2.log' -Xml 'age-diagnostics-2-task.xml' -Invoked 'age-diagnostics-2-invoked.txt' -Lease 'age-diagnostics-2-lease.txt' -LimitMinutes 10 -ProbeSha256 $ProbeSha256 -HelperSha256 $HelperSha256
