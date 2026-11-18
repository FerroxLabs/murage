# The reviewer witnesses use virtual elapsed time and injected native/Scheduler boundaries.
param([ValidateSet('hang','throw')][string]$Witness='hang')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'ownership.ps1')
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
function Check([bool]$ok,[string]$name){if(-not $ok){throw "ASSERTION: $name"};"PASS $name"}
$prefix='MurageCI-'+('a'*32)+'-';$task=$prefix+'wrapper'
$launcherBefore=@();$launcherCleanup=$null
$output=Join-Path ([IO.Path]::GetTempPath()) ('p11c-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($output)
$ledger=Join-Path $output 'ledger';[IO.File]::WriteAllText($ledger,'')
$Commit='a'*40;$PackageSha256='b'*64
try {
 foreach($mode in @($Witness)) {
  $script:events=@();$script:seconds=151;$script:present=$true;$script:mode=$mode
  function Invoke-WrapperScheduler($Operation,$Id,$Deadline) {
   if($null -eq $Deadline){throw 'ASSERTION: Scheduler call lacks deadline'}
   $script:events+=$Operation
   if($Operation -eq 'Unregister'){$script:present=$false}
   if($Operation -eq 'ReadBack'){return $script:present}
  }
  function Get-TaskSnapshot {
   $script:events+='enumerate'
   if($script:mode -eq 'hang'){$script:seconds+=60;throw 'owned child job timeout: Scheduler enumeration hangs'}
   throw 'Scheduler enumeration throws'
  }
  function Invoke-OwnershipDeadline($Operation,$Payload,$Deadline) {
   Check ($null -ne $Deadline) 'snapshot-diff child has hard deadline'
   Get-TaskSnapshot
  }
  $wrapperJob=[pscustomobject]@{}
  $wrapperJob | Add-Member ScriptMethod TerminateAndProveEmpty {param($budget) $script:events+='empty';return $true}
  $failed=''
  try {
   if(Get-Command Invoke-LauncherCleanup -ErrorAction SilentlyContinue) {
    Invoke-LauncherCleanup -Task ('\'+$task) -Prefix $prefix -Before $launcherBefore -WrapperJob $wrapperJob -Output $output -Commit $Commit -PackageSha256 $PackageSha256 -Result ([ref]$launcherCleanup)
   } else {
    # Run the actual pre-fix cleanup core, with its unbounded RPC replaced by a
    # throwing/virtual-hang double. Do not recreate or simplify its ordering.
    Invoke-LinuxLegacyLauncherCleanup
   }
  }catch{$failed=$_.Exception.Message}
  Check ($script:seconds -ge 151 -and $script:seconds -le 211) "witness $mode : TimeoutSeconds 60; prelaunch CIM blocked past 150 seconds"
  Check (-not $script:present -and ($script:events[0..3] -join ',') -eq 'End,empty,Unregister,ReadBack') "witness $mode : name removal precedes enumeration"
  Check ($failed -like '*Scheduler enumeration*') "witness $mode : enumeration failure fails closed"
  $report=Get-Content -LiteralPath (Join-Path $output 'failure.json') -Raw | ConvertFrom-Json
  Check ($report.status -eq 'FAIL' -and $report.task -eq ('\'+$task) -and $report.removalCommand -eq "Unregister-ScheduledTask -TaskPath '\' -TaskName '$task' -Confirm:`$false") "witness $mode : finally writes exact task and actionable removal command"
 }
 # Success and an earlier launch failure use the same name-first coordinator.
 function Invoke-OwnershipDeadline($Operation,$Payload,$Deadline) {
  if($null -eq $Deadline){throw 'ASSERTION: diff deadline required'}
  Complete-SnapshotDiff @() $prefix { @() } {param($item) throw 'unexpected deletion'}
 }
 $script:events=@();$script:present=$true
 Invoke-LauncherCleanup -Task ('\'+$task) -Prefix $prefix -Before @() -WrapperJob $wrapperJob -Output $output -Commit $Commit -PackageSha256 $PackageSha256 -Result ([ref]$launcherCleanup)
 Check ($launcherCleanup.ok -and -not $script:present) 'successful cleanup publishes bounded diff after exact-name removal'
 Invoke-LauncherCleanup -Task ('\'+$task) -Prefix $prefix -Before @() -WrapperJob $wrapperJob -Output $output -Commit $Commit -PackageSha256 $PackageSha256 -Result ([ref]$launcherCleanup) -PriorFailure 'prelaunch CIM exceeded outer timeout'
 $report=Get-Content -LiteralPath (Join-Path $output 'failure.json') -Raw | ConvertFrom-Json
 Check ($report.error -like '*prelaunch CIM exceeded outer timeout*' -and $report.removalCommand -like '*Unregister-ScheduledTask*') 'earlier launcher exception still writes actionable FAIL after successful cleanup'
}finally{Remove-Item -LiteralPath $output -Recurse -Force}
