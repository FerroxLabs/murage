# Internal worker: caller supplies a hard native-job deadline for this entire RPC tree.
param([ValidateSet('TaskSnapshot','TaskDiff','OwnershipDiff','Processes','TaskState')][string]$Operation,[string]$Payload,[string]$Output)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
. (Join-Path $PSScriptRoot 'ownership.ps1')
$data=Get-Content -LiteralPath $Payload -Raw | ConvertFrom-Json
$value=switch($Operation) {
  'TaskSnapshot' {@(Get-TaskSnapshot)}
  'TaskDiff' {Complete-SnapshotDiff @($data.before) $data.prefix -Surface Tasks}
  'OwnershipDiff' {Complete-OwnershipSnapshot $data.before $data.prefix}
  'Processes' {@(Get-SessionProcesses | Where-Object {$_.pid -ne $PID})}
  'TaskState' {
    $service=New-Object -ComObject 'Schedule.Service';$service.Connect()
    $task=$service.GetFolder('\').GetTask($data.task)
    @{name=$data.task;lastRunTime=$task.LastRunTime.ToString('O');lastTaskResult=$task.LastTaskResult;state=$task.State}
  }
}
@{value=$value} | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $Output -Encoding UTF8
