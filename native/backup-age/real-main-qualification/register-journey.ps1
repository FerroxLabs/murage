param([Parameter(Mandatory=$true)][string]$Parent,[switch]$ConfirmHiddenAncestorCorrection,[string]$TaskName='Murage-B20-RealMain-20260914-025600',[string]$DeadlineUtc='2026-09-14T03:56:00Z')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($TaskName -notmatch '^Murage-B20-RealMain-(Extension-)?20260914-[0-9]{6}$'){throw 'Unexpected task identity'}
$deadline=[DateTime]::Parse($DeadlineUtc).ToUniversalTime()
$remaining=($deadline-[DateTime]::UtcNow).TotalSeconds
if($remaining -lt 120){throw 'Insufficient admitted window; do not launch'}
if((Get-CimInstance Win32_ComputerSystem).UserName -ne 'SeanDesktop\seand'){throw 'Expected interactive account unavailable'}
if($ConfirmHiddenAncestorCorrection) {
  $prior=Get-ScheduledTask -TaskName $taskName -TaskPath '\'
  if($prior.State -eq 'Running' -or $prior.Principal.UserId -notmatch '(?i)(seand|S-1-5-21-3954847422-1325544036-2038804778-1001)$'){throw 'Prior owned task identity/state mismatch'}
  if(Test-Path -LiteralPath (Join-Path $Parent 'real-main-qualification\evidence\invoked.json')){throw 'Initial application invocation already occurred'}
  if(!(Get-Content -LiteralPath (Join-Path $Parent 'journey-console.log') -Raw).Contains('Could not find item C:\Users\seand\AppData.')){throw 'Expected hidden-ancestor prelaunch failure absent'}
  if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($Parent)}).Count){throw 'Prior task-owned processes remain'}
  foreach($name in @('journey-console.log','journey-task.xml','journey-task-invoked.txt')) {
    $saved=Join-Path $Parent ($name+'.r1')
    if(Test-Path -LiteralPath $saved){throw 'Final confirmation already prepared'}
    Copy-Item -LiteralPath (Join-Path $Parent $name) -Destination $saved
  }
  Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
}
if(Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue){throw 'Task exists; do not adopt/replay'}
if(!$ConfirmHiddenAncestorCorrection -and (Test-Path -LiteralPath (Join-Path $Parent 'journey-task-invoked.txt'))){throw 'Task already invoked'}
$manifest=Get-Content -LiteralPath (Join-Path $Parent 'journey-manifest.json') -Raw | ConvertFrom-Json
if($manifest.sid -ne 'S-1-5-21-3954847422-1325544036-2038804778-1001' -or $manifest.sessionId -ne 1){throw 'Manifest desktop binding mismatch'}
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $Parent 'fixture\journey-entry.ps1')+'" -Parent "'+$Parent+'"'
$action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $Parent
$principal=New-ScheduledTaskPrincipal -UserId 'SeanDesktop\seand' -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ([Math]::Floor($remaining))) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task=New-ScheduledTask -Action $action -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $task | Out-Null
Export-ScheduledTask -TaskName $taskName -TaskPath '\' | Set-Content -LiteralPath (Join-Path $Parent 'journey-task.xml')
[DateTime]::UtcNow.ToString('o') | Set-Content -LiteralPath (Join-Path $Parent 'journey-task-invoked.txt')
Start-ScheduledTask -TaskName $taskName -TaskPath '\'
[pscustomobject]@{task=$taskName;startedUtc=[DateTime]::UtcNow.ToString('o');deadlineUtc=$deadline.ToString('o');account='SeanDesktop\seand';runLevel='Limited';parent=$Parent} | ConvertTo-Json -Compress
# Outer watchdog: only this exact task is in scope. No app/process-name kill.
$observedRunning=$false
do {
  $state=Get-ScheduledTask -TaskName $taskName -TaskPath '\'
  if($state.State -eq 'Running'){$observedRunning=$true}
  if($observedRunning -and $state.State -ne 'Running'){break}
  $info=Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
  if($info.LastRunTime -gt [DateTime]::Now.AddMinutes(-2) -and $info.LastTaskResult -ne 267009 -and $state.State -ne 'Running'){break}
  Start-Sleep -Seconds 2
} while([DateTime]::UtcNow -lt $deadline)
if((Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -eq 'Running') {
  Stop-ScheduledTask -TaskName $taskName -TaskPath '\'
  'Outer watchdog stopped the exact task at its admitted deadline' | Set-Content -LiteralPath (Join-Path $Parent 'journey-watchdog.txt')
}
$final=Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
[pscustomobject]@{task=$taskName;state=(Get-ScheduledTask -TaskName $taskName -TaskPath '\').State;lastTaskResult=$final.LastTaskResult;finishedUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
