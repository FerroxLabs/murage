. (Join-Path $PSScriptRoot 'owned-process.ps1')
# Snapshot/diff policy. Injected enumerators let the same cleanup run in Linux tests.
function Test-RunPrefix([string]$Id,[string]$Prefix) {
  if($Prefix -notmatch '^MurageCI-[a-f0-9]{32}-$'){throw 'Invalid run prefix'}
  return @($Id -split '[\\/]' | Where-Object {$_.StartsWith($Prefix,[StringComparison]::Ordinal)}).Count -gt 0
}
function Get-TaskSnapshot {
  $service=New-Object -ComObject 'Schedule.Service';$service.Connect()
  @(Get-RunTasks ($service.GetFolder('\')) | ForEach-Object {
    [xml]$xml=$_.Xml
    $author=$xml.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="RegistrationInfo"]/*[local-name()="Author"]')
    $actions=$xml.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Actions"]')
    [pscustomobject]@{id=$_.Path;name=$_.Name;author=$(if($null -eq $author){''}else{$author.InnerText});actions=$(if($null -eq $actions){''}else{$actions.OuterXml});definition=$_.Xml}
  } | Sort-Object id)
}
function Get-SnapshotRows([scriptblock]$Enumerate,[string]$Surface) {
  if($Enumerate){Invoke-LinuxFixtureCallback -Callback $Enumerate;return}
  if($Surface -eq 'Registrations'){Get-RegistrationSnapshot}else{Get-TaskSnapshot}
}
function Complete-SnapshotDiff($Before,[string]$Prefix,[scriptblock]$Enumerate,[scriptblock]$Delete,[ValidateSet('Tasks','Registrations')][string]$Surface='Tasks') {
  $after=@(Get-SnapshotRows $Enumerate $Surface)
  $added=@();$changed=@();$removed=@();$deleted=@();$errors=@()
  foreach($old in @($Before)) {
    $now=@($after | Where-Object {$_.id -ieq $old.id})
    if(-not $now.Count){$removed+=,$old}
    elseif(($old | ConvertTo-Json -Depth 20 -Compress) -cne ($now[0] | ConvertTo-Json -Depth 20 -Compress)){$changed+=,$now[0]}
  }
  foreach($item in $after) {
    if(@($Before | Where-Object {$_.id -ieq $item.id}).Count){continue}
    $added+=,$item
    if(Test-RunPrefix $item.id $Prefix) {
      try {if($Delete){Invoke-LinuxFixtureCallback -Callback $Delete -Arguments @($item)}elseif($Surface -eq 'Registrations'){Remove-SnapshotRegistration $item}else{Remove-SnapshotTask $item};$deleted+=,$item.id}catch{$errors+=$_.Exception.Message}
    } else {$errors+='Unprefixed new registration (preserved): '+$item.id}
  }
  if($changed.Count -or $removed.Count){$errors+='Pre-existing registrations changed or removed (preserved)'}
  $remaining=@(Get-SnapshotRows $Enumerate $Surface)
  foreach($id in $deleted){if(@($remaining | Where-Object {$_.id -ieq $id}).Count){$errors+='Registration survived cleanup: '+$id}}
  [pscustomobject]@{before=@($Before);after=$after;added=$added;changed=$changed;removed=$removed;deleted=$deleted;remaining=$remaining;errors=$errors;ok=($errors.Count -eq 0)}
}
function Remove-SnapshotTask($Item) {
  $service=New-Object -ComObject 'Schedule.Service';$service.Connect()
  $task=$service.GetFolder('\').GetTask($Item.id)
  # Never stop an escaped process. Disable future triggers, then require idle.
  $task.Enabled=$false
  if($task.GetInstances(0).Count){throw ('Scheduled task still running; preserved: '+$Item.id)}
  $folder=Split-Path -Parent $Item.id;if(-not $folder){$folder='\'}
  $service.GetFolder($folder).DeleteTask((Split-Path -Leaf $Item.id),0)
}
# Run potentially blocking Scheduler RPCs in their own owned native job. The
# retry deadline covers both command execution and its empty-job proof.
function Invoke-WrapperScheduler([ValidateSet('End','Unregister','ReadBack')][string]$Operation,[string]$Id,[DateTime]$Deadline) {
  if($Id -cnotmatch '^\\MurageCI-[a-f0-9]{32}-wrapper$'){throw 'Invalid wrapper task path'}
  $budget=($Deadline-[DateTime]::UtcNow).TotalSeconds
  $seconds=[int][Math]::Floor([Math]::Min(3,$budget-2))
  if($seconds -lt 1){throw 'Wrapper cleanup deadline exhausted'}
  $name=$Id.TrimStart('\')
  $command="`$ErrorActionPreference='Stop'; "
  switch($Operation) {
    'End' {$command+="Stop-ScheduledTask -TaskPath '\' -TaskName '$name'"}
    'Unregister' {$command+="Unregister-ScheduledTask -TaskPath '\' -TaskName '$name' -Confirm:`$false"}
    'ReadBack' {$command+="@((Get-ScheduledTask -TaskPath '\') | Where-Object {`$_.TaskName -ieq '$name'}).Count"}
  }
  $words=@('-NoProfile','-NonInteractive','-Command',$command)
  $arguments=($words | ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '
  $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $result=Invoke-OwnedNative -File $exe -Arguments $arguments -TimeoutSeconds $seconds -ProofTimeoutMilliseconds 2000
  if($result.ExitCode -ne 0){throw "Scheduler $Operation failed: $($result.Stderr)"}
  if($Operation -eq 'ReadBack') {
    if($result.Stdout.Trim() -notmatch '^[01]$'){throw 'Invalid Scheduler absence readback'}
    return $result.Stdout.Trim() -eq '1'
  }
}
# Only the operator calls this for its exact write-ahead wrapper task.
# Scheduler End (Stop-ScheduledTask), owned-job termination/proof, unregister,
# and authoritative readback are ordered. Never preserve a running own wrapper.
function Get-WrapperNow([scriptblock]$Now) {
  if($Now){return (Invoke-LinuxFixtureCallback -Callback $Now)}
  [DateTime]::UtcNow
}
function Remove-WrapperTask($Item,[string]$Prefix,$Before,
  [scriptblock]$End,
  [scriptblock]$Empty,
  [scriptblock]$Unregister,
  [scriptblock]$ReadBack,
  [scriptblock]$Sleep,
  [scriptblock]$Now,$WrapperJob) {
  if($null -eq $Before -or -not (Test-RunPrefix $Item.id $Prefix) -or $Item.id -cne ('\'+$Prefix+'wrapper') -or @($Before | Where-Object {$_.id -ieq $Item.id}).Count){throw 'Wrapper is not a newly created owned task'}
  if($null -eq $Empty -and -not $PSBoundParameters.ContainsKey('WrapperJob')){throw 'Wrapper job proof callback required'}
  $deadline=(Get-WrapperNow $Now).AddSeconds(60)
  $lastError=''
  try {if($End){Invoke-LinuxFixtureCallback -Callback $End -Arguments @($Item.id,$deadline)}else{Invoke-WrapperScheduler End $Item.id $deadline}} catch {$lastError=$_.Exception.Message}
  for($attempt=1;$attempt -le 5;$attempt++) {
    if((Get-WrapperNow $Now) -ge $deadline){break}
    try {
      $budget=[int][Math]::Min(8000,[Math]::Max(1,($deadline-(Get-WrapperNow $Now)).TotalMilliseconds))
      $isEmpty=if($Empty){Invoke-LinuxFixtureCallback -Callback $Empty -Arguments @($budget)}elseif($null -eq $WrapperJob){$true}else{$WrapperJob.TerminateAndProveEmpty($budget)}
      if(-not $isEmpty){throw 'Wrapper job not empty'}
      if($Unregister){Invoke-LinuxFixtureCallback -Callback $Unregister -Arguments @($Item.id,$deadline)}else{Invoke-WrapperScheduler Unregister $Item.id $deadline}
      $present=if($ReadBack){Invoke-LinuxFixtureCallback -Callback $ReadBack -Arguments @($Item.id,$deadline)}else{Invoke-WrapperScheduler ReadBack $Item.id $deadline}
      if($present){throw 'Wrapper still registered'}
      return
    } catch {$lastError=$_.Exception.Message}
    if($attempt -lt 5) {
      $delay=[Math]::Min(1000*[Math]::Pow(2,$attempt-1),[Math]::Max(0,($deadline-(Get-WrapperNow $Now)).TotalMilliseconds))
      if($delay -gt 0){if($Sleep){Invoke-LinuxFixtureCallback -Callback $Sleep -Arguments @([int]$delay)}else{Start-Sleep -Milliseconds ([int]$delay)}}
    }
  }
  # Prefix validation above restricts this command to a safe literal task name.
  $command="Unregister-ScheduledTask -TaskPath '\' -TaskName '$($Prefix)wrapper' -Confirm:`$false"
  throw "Wrapper cleanup FAIL: $($Item.id); removal command: $command; $lastError"
}
function Assert-RegistrationHost {
  if($env:COMPUTERNAME -ine 'gate-win-nogit' -or $env:USERNAME -cne 'murage-gate'){throw 'Installer registrations are gate-win-nogit only'}
}
function Get-RegistrationSnapshot {
  Assert-RegistrationHost
  # Registration surfaces only; never crawl unrelated user registry data.
  foreach($hive in @('CurrentUser','LocalMachine')) {
    foreach($view in @('Registry32','Registry64')) {
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
      try {
        # NSIS also stores its installation marker directly below Software under
        # the app GUID. Inventory key names without reading unrelated user values.
        $software=$base.OpenSubKey('Software')
        if($null -ne $software) {
          try {foreach($name in @($software.GetSubKeyNames() | Sort-Object)) {
            [pscustomobject]@{id=('roots\'+$hive+'\'+$view+'\Software\'+$name);kind='registry-root';hive=$hive;view=$view;path=('Software\'+$name)}
          }}finally{$software.Dispose()}
        }
        foreach($root in @('Software\Microsoft\Windows\CurrentVersion\Uninstall','Software\Classes','Software\Microsoft\Windows\CurrentVersion\App Paths','Software\RegisteredApplications','Software\Murage','Software\com.murage.app')) {
          function Read-RegistrationKey([string]$Path) {
            $key=$base.OpenSubKey($Path)
            if($null -eq $key){return}
            try {
              $values=@(foreach($name in @($key.GetValueNames() | Sort-Object)) {
                @{name=$name;type=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
              })
              [pscustomobject]@{id=($hive+'\'+$view+'\'+$Path);kind='registry';hive=$hive;view=$view;path=$Path;values=$values}
              foreach($child in @($key.GetSubKeyNames() | Sort-Object)){Read-RegistrationKey ($Path+'\'+$child)}
            } finally {$key.Dispose()}
          }
          Read-RegistrationKey $root
        }
      } finally {$base.Dispose()}
    }
  }
  foreach($folder in @('DesktopDirectory','CommonDesktopDirectory','Programs','CommonPrograms')) {
    $path=[Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
    if($path -and (Test-Path -LiteralPath $path)) {
      foreach($file in @(Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction Stop | Where-Object {$_.Extension -in @('.lnk','.url')})) {
        if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Shortcut reparse point refused'}
        [pscustomobject]@{id=$file.FullName;kind='shortcut';path=$file.FullName;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash}
      }
    }
  }
}
function Remove-SnapshotRegistration($Item) {
  Assert-RegistrationHost
  if($Item.kind -eq 'shortcut'){Remove-Item -LiteralPath $Item.path -ErrorAction Stop;return}
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$($Item.hive),[Microsoft.Win32.RegistryView]::$($Item.view))
  try {$base.DeleteSubKeyTree($Item.path,$false)}finally{$base.Dispose()}
}
function Get-OwnershipSnapshot([string]$Kind) {
  $registrations=@()
  if($Kind -eq 'handoff'){$registrations=@(Get-RegistrationSnapshot)}
  @{tasks=@(Get-TaskSnapshot);registrations=$registrations;kind=$Kind}
}
function Complete-OwnershipSnapshot($Before,[string]$Prefix) {
  $tasks=Complete-SnapshotDiff $Before.tasks $Prefix -Surface Tasks
  $registrations=$null
  if($Before.kind -eq 'handoff'){$registrations=Complete-SnapshotDiff $Before.registrations $Prefix -Surface Registrations}
  @{tasks=$tasks;registrations=$registrations;ok=($tasks.ok -and ($null -eq $registrations -or $registrations.ok))}
}
function Get-SessionProcesses {
  $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
    # WMI/scheduler can create caller-owned processes in a different session.
    # Include those too; a session-only baseline would miss such an escape.
    $include=$_.SessionId -eq $session
    if(-not $include) {
      $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
      $include=$owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid
    }
    if($include){@{id=([string]$_.ProcessId+'|'+$_.CreationDate.ToUniversalTime().ToString('O'));pid=[uint32]$_.ProcessId;path=[string]$_.ExecutablePath;parent=[uint32]$_.ParentProcessId;session=[uint32]$_.SessionId}}
  })
}
function Get-HttpsBrowser {
  Assert-RegistrationHost
  $choice=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop
  $command=(Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\'+$choice.ProgId+'\shell\open\command') -ErrorAction Stop).GetValue('')
  if($command -notmatch '^"([A-Za-z]:\\[^"\r\n]+\.exe)"'){throw 'Cannot identify HTTPS browser executable; refuse exception'}
  return $Matches[1]
}
function Compare-ProcessSnapshot($Before,$After,[string]$Browser,[bool]$Dispatch,[scriptblock]$InJob) {
  $escaped=@();$browsers=@();$enrolled=@()
  foreach($item in @($After)) {
    if(@($Before | Where-Object {$_.id -eq $item.id}).Count){continue}
    if($InJob -and (Invoke-LinuxFixtureCallback -Callback $InJob -Arguments @($item))){$enrolled+=,$item;continue}
    if($Dispatch -and $Browser -and $item.path -ieq $Browser){$browsers+=,$item;continue}
    $escaped+=,$item
  }
  @{escaped=$escaped;browsers=$browsers;enrolled=$enrolled;ok=($escaped.Count -eq 0)}
}

# The parent never performs cleanup RPCs itself. Each whole operation, including
# snapshot deletion/readback, runs in an atomic, suspended, no-breakaway child job.
function Invoke-OwnershipDeadline {
  param([Parameter(Mandatory=$true)][ValidateSet('TaskSnapshot','TaskDiff','OwnershipDiff','Processes','TaskState')][string]$Operation,
    [Parameter(Mandatory=$true)]$Payload,[Parameter(Mandatory=$true)][DateTime]$Deadline)
  $seconds=[int][Math]::Floor(($Deadline-[DateTime]::UtcNow).TotalSeconds-2)
  if($seconds -lt 1){throw 'Ownership cleanup deadline exhausted'}
  $dir=Join-Path ([IO.Path]::GetTempPath()) ('ownership-'+[Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($dir)
  try {
    $inputFile=Join-Path $dir 'request.json';$resultFile=Join-Path $dir 'result.json'
    $Payload | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $inputFile -Encoding UTF8
    $words=@('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'ownership-worker.ps1'),'-Operation',$Operation,'-Payload',$inputFile,'-Output',$resultFile)
    $args=($words | ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '
    $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $result=Invoke-OwnedNative -File $exe -Arguments $args -TimeoutSeconds $seconds -ProofTimeoutMilliseconds 2000
    if($result.ExitCode -ne 0){throw ('Ownership '+$Operation+' failed: '+$result.Stderr)}
    (Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json).value
  } finally {Remove-Item -LiteralPath $dir -Recurse -Force}
}

# Task is fixed before registration and persisted in request.json. Never discover
# it through enumeration. All failure paths publish the same actionable record.
function Invoke-LauncherCleanup {
  param([string]$Task,[string]$Prefix,$Before,$WrapperJob,[string]$Output,[string]$Commit,[string]$PackageSha256,[ref]$Result,[string]$PriorFailure)
  $failure=$null
  $removalCommand="Unregister-ScheduledTask -TaskPath '\' -TaskName '$($Prefix)wrapper' -Confirm:`$false"
  try {
    Remove-WrapperTask -Item ([pscustomobject]@{id=$Task}) -Prefix $Prefix -Before $Before -WrapperJob $WrapperJob
    $diff=Invoke-OwnershipDeadline -Operation TaskDiff -Payload @{before=@($Before);prefix=$Prefix} -Deadline ([DateTime]::UtcNow.AddSeconds(60))
    $Result.Value=$diff
    if(-not $diff.ok){throw ($diff.errors -join '; ')}
  } catch {$failure=$_.Exception.Message;throw}
  finally {
    if($null -eq $failure -and $PriorFailure){$failure=$PriorFailure}
    if($null -ne $failure) {
      $message="Wrapper cleanup FAIL: $Task; removal command: $removalCommand; $failure"
      [ordered]@{status='FAIL';commit=$Commit;packageSha256=$PackageSha256;task=$Task;removalCommand=$removalCommand;error=$message} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Output 'failure.json') -Encoding UTF8
      ('FAIL '+$message) | Set-Content -LiteralPath (Join-Path $Output 'result.txt') -Encoding UTF8
    }
  }
}
