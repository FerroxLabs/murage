# One terminal path for every registrar (PS1-REPARSE-DESIGN-r2 sections 2.4-2.6):
# ADMIT (caller, reads only) -> L3(a) -> RESERVE -> CORRECT -> REGISTER -> L3(a') -> START -> BIND -> WATCH -> SETTLE -> [UNREGISTER] -> L3(b) -> CLOSE.
# Only LEASE-OK with this run's runId is evidence. Stdout and the receipt carry no account, SID or profile-derived path.

function ConvertTo-QualificationBytes([string]$Text,[switch]$Unicode) {
  if($Unicode){ return ,([Text.Encoding]::Unicode.GetPreamble()+[Text.Encoding]::Unicode.GetBytes($Text)) }
  return ,([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

# P1: the caller token must be the verified desktop SID (run after Confirm-QualificationProfile).
function Confirm-QualificationCaller([string]$DesktopSid) {
  if(![string]::Equals((Get-QualificationCallerSid),$DesktopSid,[StringComparison]::Ordinal)){throw 'Caller token is not the qualification account'}
}

# U4: scheduler errors can quote the principal; only lease classes (relative names) or a fixed step class leave the registrar.
function Get-QualificationFailure($ErrorRecord,[string]$Step) {
  $m=[string]$ErrorRecord.Exception.Message
  if($m -match '^(Reparse point|Hardlinked|Final path|Pinned|Output|Planted|Change watch|Held object|Case-sensitive|Not a directory|Directory refused|Admitted path|Reserved|Not held|Not a registrar)'){ return $m }
  return $Step
}

function Get-QualificationActiveProcesses($Job) { if(!$Job){return 0}; return $Job.ActiveProcesses() }

# Settled: the task is still registered and not Running, the scheduler has no running instance and the bound job is empty.
# A missing task is unknown, never settled: a started task is unregistered only after this returned true (ROW91-NOTE).
function Wait-QualificationSettled($Job,[string]$TaskName,[int]$Seconds) {
  $until=(Get-QualificationUtcNow).AddSeconds($Seconds)
  do {
    # A scheduler/COM error on this poll reads as not settled; it never escapes the J5 hold in finally.
    try {
      $task=Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
      if($task -and $task.State -ne 'Running' -and (Get-QualificationActiveProcesses $Job) -eq 0 -and !(Get-QualificationTaskActionPid $TaskName)){return $true}
    } catch {}
    Start-Sleep -Milliseconds 500
  } while((Get-QualificationUtcNow) -lt $until)
  return $false
}

function Invoke-QualificationLeasedTask {
  param($Lease,[string]$TaskName,$Task,[string]$Admitted,[string]$XmlName,[string]$InvokedName,[string]$WatchdogName,[string]$ReceiptName,
    [Nullable[DateTime]]$DeadlineUtc,[int]$LimitSeconds,[scriptblock]$Correct,[hashtable]$Started,[int]$StartBoundSeconds=90,[int]$StopGraceSeconds=60,[int]$HoldSeconds=600)
  $runId=[guid]::NewGuid().ToString()
  try {
    # L3(a): the last admission step; a failure is a refusal with zero mutations.
    Assert-QualificationLease $Lease
    # B. RESERVE: the first mutation. A failure removes this run's files by handle (REFUSED-RESERVE).
    Reserve-QualificationOutputs $Lease
  } catch { Close-QualificationLease $Lease; throw }
  $r=[ordered]@{runId=$runId;task=$TaskName;outcome=$null;failure=$null;priorRemoved=$false;lastTaskResult=$null}
  $registered=$false;$startedTask=$false;$settled=$true;$job=$null;$receipt=$true;$unregisterSettled=$false
  try {
    # C. CORRECT (journey correction branch only).
    if($Correct) {
      try { & $Correct } catch {
        $r.failure=Get-QualificationFailure $_ 'correction copy failed'; $receipt=$false
        # ABORTED-NO-CHANGE only when every reservation is gone; a file left behind is ABORTED-DIRTY (not evidence).
        try { Remove-QualificationOutputs $Lease -All; $r.outcome='ABORTED-NO-CHANGE' } catch { $r.failure+='; '+(Get-QualificationFailure $_ 'reservation removal failed'); $r.outcome='ABORTED-DIRTY' }
        return $r
      }
      try { Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false } catch { $r.failure='prior unregister failed'; $r.outcome='ABORTED-PRIOR-KEPT'; return $r }
      $r.priorRemoved=$true
    }
    # D. REGISTER -> Export into the reserved handle -> invoked marker -> L3(a').
    try {
      Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $Task | Out-Null
      $registered=$true
      Write-QualificationOutput $Lease $XmlName (ConvertTo-QualificationBytes ((Export-ScheduledTask -TaskName $TaskName -TaskPath '\') | Out-String) -Unicode)
      Write-QualificationOutput $Lease $InvokedName (ConvertTo-QualificationBytes ([DateTime]::UtcNow.ToString('o')+"`r`n"))
      Assert-QualificationLease $Lease
    } catch {
      $r.failure=Get-QualificationFailure $_ 'register step failed'
      if($registered){ try { Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false } catch { $r.failure+='; unregister failed' } }
      $r.outcome='ABORTED-BEFORE-START'; return $r
    }
    # E. START. The kill-on-close job exists before Start so binding is the only step between Start and containment.
    try { $job=New-QualificationJob } catch {
      $r.failure=Get-QualificationFailure $_ 'job creation failed'
      try { Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false } catch { $r.failure+='; unregister failed' }
      $r.outcome='ABORTED-BEFORE-START'; return $r
    }
    $startLocal=[DateTime]::Now.AddSeconds(-1)
    # From here the task may be running: J5 holds the lease in finally until it is settled.
    $startedTask=$true; $settled=$false
    try { Start-ScheduledTask -TaskName $TaskName -TaskPath '\' } catch {
      # Start can fail after the task really started (scheduler timeout). The task stays registered until settled:
      # J5 holds it and finally unregisters it only once settled (ASTRA H1 r2).
      $r.failure='start failed'
      try { Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' } catch {}
      $settled=Wait-QualificationSettled $job $TaskName $StopGraceSeconds
      $unregisterSettled=$true
      $r.outcome=if($settled){'ABORTED-BEFORE-START'}else{'UNSETTLED'}; return $r
    }
    $startUtc=Get-QualificationUtcNow
    $deadline=if($null -eq $DeadlineUtc){ $startUtc.AddSeconds($LimitSeconds+60) } else { ([DateTime]$DeadlineUtc).ToUniversalTime() }
    $Started.startedUtc=$startUtc.ToString('o'); $Started.deadlineUtc=$deadline.ToString('o'); $Started.runId=$runId
    [Console]::Out.WriteLine(([pscustomobject]$Started | ConvertTo-Json -Compress))
    # J1/J3: bind the exact invocation, or disable and remove a task that never starts.
    $bound=$false;$seen=$false;$until=$startUtc.AddSeconds($StartBoundSeconds)
    do {
      $actionPid=Get-QualificationTaskActionPid $TaskName
      if($actionPid){ $seen=$true; $bound=Bind-QualificationInvocation $job $actionPid $Admitted; break }
      $info=Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\'
      if($info.LastRunTime -ge $startLocal -and $info.LastTaskResult -notin @(267009,267011)){ $seen=$true; break }
      Start-Sleep -Seconds 1
    } while((Get-QualificationUtcNow) -lt $until)
    if(!$seen) {
      try { Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null } catch { $r.failure='disable failed' }
      # It may have started between the last poll and Disable: stop it; J5 holds and finally unregisters it once settled.
      if(Get-QualificationTaskActionPid $TaskName){ try { Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' } catch {} }
      $settled=Wait-QualificationSettled $job $TaskName $StopGraceSeconds
      $unregisterSettled=$true
      $r.outcome=if($settled){'NOT-STARTED'}else{'UNSETTLED'}; return $r
    }
    if(!$bound) {
      try { Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' } catch {}
      $settled=Wait-QualificationSettled $job $TaskName $StopGraceSeconds
      $r.outcome='UNBOUND'; return $r
    }
    # J2: watch this exact task until it was seen to finish and the bound tree and the scheduler instance are gone.
    $observedRunning=$false
    do {
      $state=(Get-ScheduledTask -TaskName $TaskName -TaskPath '\').State
      if($state -eq 'Running'){$observedRunning=$true}
      $info=Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\'
      $finished=$state -ne 'Running' -and ($observedRunning -or ($info.LastRunTime -ge $startLocal -and $info.LastTaskResult -notin @(267009,267011)))
      if($finished -and (Get-QualificationActiveProcesses $job) -eq 0 -and !(Get-QualificationTaskActionPid $TaskName)){ $settled=$true; break }
      Start-Sleep -Seconds 2
    } while((Get-QualificationUtcNow) -lt $deadline)
    if(!$settled) {
      # J4: stop pending; the lease is held until not-Running and ActiveProcesses = 0.
      try { Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' } catch {}
      Write-QualificationOutput $Lease $WatchdogName (ConvertTo-QualificationBytes "Outer watchdog stopped the exact task at its admitted deadline`r`n")
      $settled=Wait-QualificationSettled $job $TaskName $StopGraceSeconds
      if(!$settled){ $job.Terminate(); $settled=Wait-QualificationSettled $job $TaskName 10 }
      if(!$settled){ $r.outcome='UNSETTLED'; return $r }
    }
    $r.lastTaskResult=(Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\').LastTaskResult
    # SETTLE -> L3(b): every held handle, the task logs on their reserved handles, X2 and the X3 event record.
    try { Assert-QualificationLease $Lease; $r.outcome='LEASE-OK' } catch { $r.failure=Get-QualificationFailure $_ 'lease check failed'; $r.outcome='LEASE-BROKEN' }
    return $r
  } catch {
    if(!$r.outcome){ $r.failure=Get-QualificationFailure $_ 'registrar error'; $r.outcome=if($startedTask){'UNSETTLED'}else{'ABORTED-BEFORE-START'} }
    return $r
  } finally {
    # J5: never release the lease while the exact task or the bound tree is alive. Stop and terminate until settled,
    # up to the hold cap; a release without settlement is UNSETTLED whatever the earlier outcome was (U2 narrowing).
    if($startedTask -and !$settled) {
      $holdUntil=(Get-QualificationUtcNow).AddSeconds($HoldSeconds)
      do {
        try { Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' } catch {}
        if($job){ $job.Terminate() }
        $settled=Wait-QualificationSettled $job $TaskName 10
      } while(!$settled -and (Get-QualificationUtcNow) -lt $holdUntil)
      if(!$settled) {
        $r.failure=(@($r.failure,'lease released unsettled') | Where-Object { $_ }) -join '; '
        $r.outcome='UNSETTLED'
      }
    }
    # Unregister only a settled task; an unsettled one stays registered (visible), never hidden while it may run.
    if($unregisterSettled) {
      if($settled){ try { Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false } catch { $r.failure=(@($r.failure,'unregister failed') | Where-Object { $_ }) -join '; ' } }
      else { $r.failure=(@($r.failure,'task kept registered unsettled') | Where-Object { $_ }) -join '; ' }
    }
    if(!$r.outcome){ $r.outcome='UNSETTLED' }
    if($receipt) {
      $text=([ordered]@{runId=$runId;outcome=$r.outcome;failure=$r.failure;priorRemoved=$r.priorRemoved;lastTaskResult=$r.lastTaskResult;utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress)+"`r`n"
      try { Write-QualificationOutput $Lease $ReceiptName (ConvertTo-QualificationBytes $text) } catch { $r.receiptFailure='receipt write failed' }
      try { Remove-QualificationOutputs $Lease } catch { $r.receiptFailure=$_.Exception.Message }
    }
    if($job){ $job.Dispose() }
    Close-QualificationLease $Lease
  }
}

function Write-QualificationResult($Result) {
  [Console]::Out.WriteLine(([pscustomobject]$Result | ConvertTo-Json -Compress))
  if($Result.outcome -eq 'LEASE-OK'){ $code=[long]$Result.lastTaskResult; if($code -ge 0 -and $code -le 255){ exit ([int]$code) } }
  exit 1
}

# The seven sibling registrars: probe, its JS, protocol.mjs and the dist-native tools are pinned; same terminal path.
function Invoke-QualificationSibling {
  param([string]$Account,[string]$DesktopSid,[string]$ProfileRoot,[string]$RepoRoot,[string]$Scratch,[string]$TaskName,[ValidateSet('--limited-session','--guard-diagnostic')][string]$Mode,
    [string]$Log,[string]$Xml,[string]$Invoked,[string]$Lease,[int]$LimitMinutes,[string]$ProbeSha256,[string]$HelperSha256)
  Confirm-QualificationCaller $DesktopSid
  if ((Resolve-QualificationAccountSid (Get-CimInstance Win32_ComputerSystem).UserName) -ne $DesktopSid) { throw 'Expected interactive account unavailable' }
  $admitted=Resolve-QualificationAdmitted $ProfileRoot $Scratch
  if ($Mode -eq '--guard-diagnostic') {
    $script='guard-diagnostic.mjs'; $workPrefixes=@('guard-diagnostic-20260913-115706\'); $workNames=@('guard-diagnostic-20260913-115706'); $receipts='guard-diagnostic-receipts.json'
  } else {
    $script='native-fixture.mjs'; $data='synthetic spaces '+[char]0x03A9; $workPrefixes=@($data+'\'); $workNames=@($data,'synthetic-junction'); $receipts='native-receipts.json'
  }
  $watchdog=$Log -replace '\.log$','-watchdog.txt'
  $leaseObject=$null
  try {
    $leaseObject=New-QualificationLease -Root $ProfileRoot -Directory $admitted
    Add-QualificationPin $leaseObject 'native-probe.exe' $ProbeSha256
    Add-QualificationPin $leaseObject $script (Get-FileHash -LiteralPath (Join-Path $RepoRoot $script) -Algorithm SHA256).Hash.ToLowerInvariant()
    Add-QualificationPin $leaseObject 'native\backup-age\protocol.mjs' (Get-FileHash -LiteralPath (Join-Path $RepoRoot 'protocol.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
    Add-QualificationPin $leaseObject 'dist-native\backup-tools\win32-x64\murage-backup-age.exe' $HelperSha256
    Add-QualificationPin $leaseObject 'dist-native\backup-tools\win32-x64\age.exe' '2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0'
    Add-QualificationPin $leaseObject 'dist-native\backup-tools\win32-x64\age-keygen.exe' '1549c7049be32695594bedd09bbd352a94b6013a9d5c43364f3c6cd7a09ab61c'
    # The --limited-session siblings share one scratch and one receipts name: an existing receipts file is held like a correction log.
    $existingReceipts=@()
    try { Test-QualificationAbsent $leaseObject $receipts } catch { if($_.Exception.Message -like 'Output name already exists:*'){ $existingReceipts=@($receipts) } else { throw } }
    Test-QualificationOutputs $leaseObject -Outputs @($Xml,$Invoked,$watchdog,$Lease) -TaskLogs (@($receipts | Where-Object { $existingReceipts -notcontains $_ })+@($Log)) -CorrectionTaskLogs $existingReceipts
    Add-QualificationScan $leaseObject @('','dist-native\backup-tools\win32-x64','native\backup-age')
    Start-QualificationWatch $leaseObject -WorkPrefixes $workPrefixes -WorkNames $workNames
    if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Task already exists; do not adopt/replay' }
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''{0}\native-probe.exe'' {1} *> ''{0}\{2}''; exit $LASTEXITCODE"' -f $admitted,$Mode,$Log
    $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $admitted
    $principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $LimitMinutes) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
  } catch { Close-QualificationLease $leaseObject; throw }
  $result=Invoke-QualificationLeasedTask -Lease $leaseObject -TaskName $TaskName -Task $task -Admitted $admitted -XmlName $Xml -InvokedName $Invoked -WatchdogName $watchdog -ReceiptName $Lease -LimitSeconds ($LimitMinutes*60) -Started @{task=$TaskName;runLevel='Limited';logon='Interactive';scratch='<admitted>'}
  Write-QualificationResult $result
}
