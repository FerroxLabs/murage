# Both profiles are admitted through the operator launcher. Direct children must
# prove membership in that launcher's named, non-breakaway job before mutation.
function Assert-GateAdmission([ValidateSet('Desktop','Handoff')][string]$Mode='Desktop',[switch]$Operator) {
  if($env:OS -ne 'Windows_NT'){throw 'Windows required'}
  if($Mode -eq 'Handoff' -and $env:COMPUTERNAME -ine 'gate-win-nogit'){throw 'Handoff is gate-win-nogit only'}
  if($Operator){return}
  if($env:MURAGE_GATE_RUN_PREFIX -notmatch '^MurageCI-[a-f0-9]{32}-$' -or $env:MURAGE_GATE_JOB_NAME -cne ('Local\'+$env:MURAGE_GATE_RUN_PREFIX)){throw 'Owned launcher context required'}
  if($env:MURAGE_GATE_TASK_HELPER -notmatch '^C:\\murage-ci\\results\\[^\r\n]+\\task-bridge\.exe$'){throw 'Owned task bridge required'}
  . (Join-Path $PSScriptRoot 'owned-process.ps1')
  Initialize-OwnedProcess
  if(-not [MurageGateProcess]::InNamedJob($env:MURAGE_GATE_JOB_NAME)){throw 'Child is outside the launcher job'}
}
