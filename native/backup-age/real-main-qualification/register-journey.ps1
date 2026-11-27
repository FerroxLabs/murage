param([Parameter(Mandatory=$true)][string]$Account,[Parameter(Mandatory=$true)][string]$DesktopSid,[Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][string]$Parent,[Parameter(Mandatory=$true)][string]$ManifestSha256,[switch]$ConfirmHiddenAncestorCorrection,[string]$TaskName='Murage-B20-RealMain-20260914-025600',[string]$DeadlineUtc='2026-09-14T03:56:00Z')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'qualification-identity.ps1')
. (Join-Path $PSScriptRoot 'qualification-paths.ps1')
. (Join-Path $PSScriptRoot 'qualification-run.ps1')
# A. ADMIT: reads only. Any failure is a refusal with zero mutations.
$ProfileRoot=Confirm-QualificationProfile $Account $DesktopSid $ProfileRoot
Confirm-QualificationCaller $DesktopSid
if($TaskName -notmatch '^Murage-B20-RealMain-(Extension-)?20260914-[0-9]{6}$'){throw 'Unexpected task identity'}
$deadline=[DateTime]::Parse($DeadlineUtc).ToUniversalTime()
$remaining=($deadline-[DateTime]::UtcNow).TotalSeconds
if($remaining -lt 120){throw 'Insufficient admitted window; do not launch'}
$interactiveAccount=(Get-CimInstance Win32_ComputerSystem).UserName
if((Resolve-QualificationAccountSid $interactiveAccount) -ne $DesktopSid){throw 'Expected interactive account unavailable'}
$admitted=Resolve-QualificationAdmitted $ProfileRoot 'murage-b20-real-main-20260914-025600'
if(![string]::Equals([IO.Path]::GetFullPath($Parent),$admitted,[StringComparison]::Ordinal)){throw 'Parent is not the admitted directory'}
$Parent=$admitted
$correction=[bool]$ConfirmHiddenAncestorCorrection
$lease=$null
try {
  $lease=New-QualificationLease -Root $ProfileRoot -Directory $admitted
  $manifestBytes=Add-QualificationPin $lease 'journey-manifest.json' $ManifestSha256 -ReturnBytes
  $manifest=[Text.Encoding]::UTF8.GetString($manifestBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $fixtureNames=@($manifest.fixtureFiles.PSObject.Properties | ForEach-Object Name)
  foreach($required in @('run.ps1','OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs')){ if($fixtureNames -notcontains $required){throw ('Manifest fixture pin missing: '+$required)} }
  foreach($entry in $manifest.fixtureFiles.PSObject.Properties){
    if($entry.Name -cnotmatch '^[A-Za-z0-9._-]+$' -or $entry.Name -match '^\.+$'){throw 'Manifest fixture name refused'}
    Add-QualificationPin $lease ('fixture\'+$entry.Name) ([string]$entry.Value)
  }
  Add-QualificationPin $lease 'fixture\journey-entry.ps1' (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'journey-entry.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
  if($manifest.sid -ne $DesktopSid -or $manifest.sessionId -ne 1){throw 'Manifest desktop binding mismatch'}
  $candidatePrefix=$admitted+'\candidate-d70fe5a145d0\'
  $executable=[string]$manifest.executable
  if(!$executable.StartsWith($candidatePrefix,[StringComparison]::OrdinalIgnoreCase) -or ![string]::Equals([IO.Path]::GetFullPath($executable),$executable,[StringComparison]::Ordinal) -or !$executable.EndsWith('\Murage.exe',[StringComparison]::Ordinal)){throw 'Manifest executable outside the admitted directory'}
  $exeRelative=$executable.Substring($admitted.Length+1)
  Add-QualificationPin $lease $exeRelative ([string]$manifest.exeSha256)
  Add-QualificationPin $lease ((Split-Path $exeRelative)+'\resources\app.asar') ([string]$manifest.asarSha256)
  Add-QualificationHeld $lease 'candidate-d70fe5a145d0'
  if($correction) {
    Test-QualificationOutputs $lease -Outputs @('journey-console.log.r1','journey-task.xml.r1','journey-task-invoked.txt.r1','journey-watchdog.txt','journey-lease.txt') -Correction @('journey-task.xml','journey-task-invoked.txt') -CorrectionTaskLogs @('journey-console.log')
    $prior=Get-ScheduledTask -TaskName $TaskName -TaskPath '\'
    $priorPrincipal=$prior.Principal.UserId
    if($prior.State -eq 'Running' -or ($priorPrincipal -ne $DesktopSid -and (Resolve-QualificationAccountSid $priorPrincipal) -ne $DesktopSid)){throw 'Prior owned task identity/state mismatch'}
    try { Test-QualificationAbsent $lease 'real-main-qualification\evidence\invoked.json' } catch { throw 'Initial application invocation already occurred' }
    $console=[IO.StreamReader]::new([IO.MemoryStream]::new((Read-QualificationHeld $lease 'journey-console.log')),[Text.Encoding]::UTF8,$true).ReadToEnd()
    if(!$console.Contains(('Could not find item {0}.' -f (Join-Path $ProfileRoot 'AppData')))){throw 'Expected hidden-ancestor prelaunch failure absent'}
    if(@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($admitted)}).Count){throw 'Prior task-owned processes remain'}
  } else {
    Test-QualificationOutputs $lease -Outputs @('journey-task.xml','journey-task-invoked.txt','journey-watchdog.txt','journey-lease.txt') -TaskLogs @('journey-console.log')
  }
  Add-QualificationScan $lease @('','fixture')
  Start-QualificationWatch $lease -WorkPrefixes @('real-main-qualification\') -WorkNames @('real-main-qualification')
  if(!$correction -and (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue)){throw 'Task exists; do not adopt/replay'}
  $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$admitted+'\fixture\journey-entry.ps1" -Parent "'+$admitted+'"'
  $action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments -WorkingDirectory $admitted
  $principal=New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ([Math]::Floor($remaining))) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $task=New-ScheduledTask -Action $action -Principal $principal -Settings $settings
} catch { Close-QualificationLease $lease; throw }
$correct=$null
if($correction) {
  $correct={ foreach($name in @('journey-console.log','journey-task.xml','journey-task-invoked.txt')){ Write-QualificationOutput $lease ($name+'.r1') (Read-QualificationHeld $lease $name) } }
}
# L3(a) -> RESERVE -> CORRECT -> REGISTER -> START -> BIND -> WATCH -> SETTLE -> L3(b) -> CLOSE (qualification-run.ps1).
$result=Invoke-QualificationLeasedTask -Lease $lease -TaskName $TaskName -Task $task -Admitted $admitted -XmlName 'journey-task.xml' -InvokedName 'journey-task-invoked.txt' -WatchdogName 'journey-watchdog.txt' -ReceiptName 'journey-lease.txt' -DeadlineUtc $deadline -Correct $correct -Started @{task=$TaskName;runLevel='Limited';parent='<admitted>'}
Write-QualificationResult $result
