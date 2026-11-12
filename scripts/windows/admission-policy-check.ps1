# Container-only test of the production admission function with a fake native type.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'owned-process.ps1')
Initialize-LinuxAdmissionFixture
. (Join-Path $PSScriptRoot 'gate-admission.ps1')
function Reject([scriptblock]$Action,[string]$Name) {
  $failed=$false;try{Invoke-LinuxFixtureCallback -Callback $Action}catch{$failed=$true}
  if(-not $failed){throw "ASSERTION: $Name"};"PASS $Name"
}
Reject {Assert-GateAdmission} 'non-Windows refused'
$env:OS='Windows_NT';$env:COMPUTERNAME='desktop'
Assert-GateAdmission -Mode Desktop -Operator
'PASS Desktop operator admitted'
Reject {Assert-GateAdmission -Mode Handoff -Operator} 'Desktop cannot select Handoff'
$env:COMPUTERNAME='gate-win-nogit'
Assert-GateAdmission -Mode Handoff -Operator
'PASS Handoff operator admitted on gate'
Reject {Assert-GateAdmission} 'direct child without context refused'
$env:MURAGE_GATE_RUN_PREFIX='MurageCI-'+('a'*32)+'-'
$env:MURAGE_GATE_JOB_NAME='Local\'+$env:MURAGE_GATE_RUN_PREFIX
$env:MURAGE_GATE_TASK_HELPER='C:\murage-ci\results\d1\task-bridge.exe'
Assert-GateAdmission
'PASS child with actual job membership admitted'
[MurageGateProcess]::Inside=$false
Reject {Assert-GateAdmission} 'spoofed environment without job membership refused'
