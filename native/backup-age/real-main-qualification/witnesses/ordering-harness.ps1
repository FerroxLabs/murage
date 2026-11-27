# Linux ordering harness (PS1-REPARSE-DESIGN-r2 section 3, "Linux container"): pwsh 7, --network none.
# The real registrars, qualification-identity.ps1 and qualification-run.ps1 run unchanged. Only the OS layer is replaced:
# qualification-paths.ps1 (kernel32 lease, scheduler instance lookup, caller token) by a recorder, and the scheduler,
# CIM and ProfileList providers by global recorder functions. Native lease behaviour is proved only by run-on-windows.ps1.
# Usage: pwsh -File ordering-harness.ps1 -Tree <repo root>        (driver)
param([string]$Tree,[string]$Child,[string]$Scenario,[string]$Log)
$ErrorActionPreference='Stop'

$stub=@'
$global:Calls=[Collections.Generic.List[string]]::new()
function global:Step([string]$Name,[switch]$Mutation) {
  $global:Calls.Add(($(if($Mutation){'MUT '}else{'READ '})+$Name))
  if($global:S.failAt -and $Name -like $global:S.failAt) { throw ('INJECTED '+$Name) }
}
function Get-QualificationCallerSid { Step 'caller-token'; return $global:S.callerSid }
function Resolve-QualificationAdmitted([string]$ProfileRoot,[string]$Name) { Step 'resolve'; return [IO.Path]::GetFullPath($ProfileRoot+'\AppData\Local\Temp\'+$Name) }
function New-QualificationLease([string]$Root,[string]$Directory,[scriptblock]$AfterOpen) { Step 'lease-open'; return [pscustomobject]@{Admitted=$Directory;Planned=@();TaskLogs=@()} }
function Add-QualificationPin($Lease,[string]$Path,[string]$Sha256,[switch]$ReturnBytes) {
  Step ('pin '+$Path)
  if($Sha256 -notmatch '^[a-f0-9]{64}$'){throw ('Pinned hash malformed: <admitted>\'+$Path)}
  if($ReturnBytes){ return ,([Text.Encoding]::UTF8.GetBytes(($global:S.manifest | ConvertTo-Json -Depth 5))) }
}
function Add-QualificationHeld($Lease,[string]$Path) { Step ('held '+$Path) }
function Add-QualificationScan($Lease,[string[]]$Directories) { Step 'x2-scan' }
function Test-QualificationOutputs($Lease,[string[]]$Outputs,[string[]]$TaskLogs=@(),[string[]]$Correction=@(),[string[]]$CorrectionTaskLogs=@()) {
  Step 'x1-check'; $Lease.Planned=@($Outputs); $Lease.TaskLogs=@($TaskLogs)
  $global:Planned=@($Outputs)+@($TaskLogs)
}
function Test-QualificationAbsent($Lease,[string]$Path) { Step ('absent '+$Path) }
function Read-QualificationHeld($Lease,[string]$Path) {
  Step ('read '+$Path)
  if($Path -eq 'journey-console.log'){ return ,([Text.Encoding]::UTF8.GetBytes(('Could not find item {0}.' -f (Join-Path $global:S.verifiedProfile 'AppData')))) }
  return ,([Text.Encoding]::UTF8.GetBytes('prior '+$Path))
}
function Start-QualificationWatch($Lease,[string[]]$WorkPrefixes=@(),[string[]]$WorkNames=@()) { Step 'x3-watch'; $global:Work=@($WorkPrefixes)+@($WorkNames) }
function Assert-QualificationLease($Lease) { $global:AssertCount++; Step ('assert#'+$global:AssertCount) }
function Reserve-QualificationOutputs($Lease) {
  Step 'reserve' -Mutation
  if($global:S.reserveFails){ $global:Calls.Add('MUT unreserve-all'); throw 'REFUSED-RESERVE: Output name already exists: <admitted>\x' }
}
function Write-QualificationOutput($Lease,[string]$Path,[byte[]]$Bytes) { Step ('write '+$Path) -Mutation; $global:Writes[$Path]=[Text.Encoding]::UTF8.GetString($Bytes) }
function Remove-QualificationOutputs($Lease,[switch]$All) { Step ('remove-outputs'+$(if($All){' all'}else{''})) -Mutation }
# LiveAtClose: running instances (registered or orphaned by Unregister) at the moment the lease closes.
function Close-QualificationLease($Lease) { $global:Calls.Add('CLOSE lease'); if($null -eq $global:LiveAtClose){ $global:LiveAtClose=@($global:Sched.Values | Where-Object State -eq 'Running').Count+@($global:Orphans | Where-Object State -eq 'Running').Count } }
function Get-QualificationTaskActionPid([string]$TaskName) { Step 'instance'; if($global:Sched[$TaskName] -and $global:Sched[$TaskName].State -eq 'Running'){return 4242}; return $null }
function New-QualificationJob { Step 'job'; $j=[pscustomobject]@{}; $j | Add-Member ScriptMethod ActiveProcesses { if($global:Bound -and (@($global:Sched.Values)+@($global:Orphans) | Where-Object State -eq 'Running')){1}else{0} }; $j | Add-Member ScriptMethod Terminate { $global:Calls.Add('MUT job-terminate') }; $j | Add-Member ScriptMethod Dispose { $global:Calls.Add('CLOSE job') }; return $j }
# An unbound job holds no process: only a successful bind makes ActiveProcesses see the tree.
function Bind-QualificationInvocation($Job,[int]$ActionPid,[string]$Admitted) { Step 'bind'; $global:Bound=[bool]$global:S.bind; return [bool]$global:S.bind }
function Get-QualificationUtcNow { return $global:Now }
'@

$bootstrap=@'
param([string]$Registrar,[string]$Scenario,[string]$Log)
$ErrorActionPreference='Stop'
$global:S=Get-Content -LiteralPath $Scenario -Raw | ConvertFrom-Json
$global:Writes=@{}; $global:Sched=@{}; $global:Orphans=@(); $global:Bound=$false; $global:LiveAtClose=$null; $global:AssertCount=0; $global:Reads=[Collections.Generic.List[string]]::new()
# Fake registrar clock: Start-Sleep advances it, so settle waits, the start bound and the J5 hold cap run without real time.
$global:Now=[DateTime]::UtcNow; $global:StopsIgnored=0
foreach($prior in @($global:S.priorTasks)){ if($prior){ $global:Sched[$prior]=[pscustomobject]@{State='Ready';Principal=[pscustomobject]@{UserId=$global:S.sid};Polls=0} } }
function global:Rec([string]$Name,[switch]$Mutation) { $global:Calls.Add(($(if($Mutation){'MUT '}else{'READ '})+$Name)); if($global:S.failAt -and $Name -like $global:S.failAt){ throw ('INJECTED '+$Name) } }
function global:Get-ItemPropertyValue($LiteralPath,$Name,$ErrorAction) { if($LiteralPath -ne ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$global:S.sid)){throw 'Unexpected registry lookup'}; return $global:S.registeredProfile }
function global:Get-CimInstance($ClassName,$Filter) { if($ClassName -eq 'Win32_ComputerSystem'){ return [pscustomobject]@{UserName=$global:S.interactive} }; return @() }
function global:Get-Content { param([string]$LiteralPath,[switch]$Raw) $global:Reads.Add('get-content'); return ($global:S.manifest | ConvertTo-Json -Depth 5) }
function global:Start-Sleep { param($Seconds,$Milliseconds) $global:Now=$global:Now.AddSeconds([double]$Seconds).AddMilliseconds([double]$Milliseconds) }
function global:New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function global:New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return [pscustomobject]@{UserId=$UserId} }
function global:New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) return [pscustomobject]@{} }
function global:New-ScheduledTask { param($Action,$Principal,$Settings) return [pscustomobject]@{Action=$Action;Principal=$Principal} }
function global:Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction)
  Rec ('sched-get '+$TaskName)
  $t=$global:Sched[$TaskName]
  if(!$t){ if($ErrorAction -eq 'SilentlyContinue'){return $null}; throw 'No MSFT_ScheduledTask objects found' }
  if($t.State -eq 'Running'){ $t.Polls++; if($t.Polls -gt [int]$global:S.runningPolls){ $t.State='Ready' } }
  return $t
}
# neverRuns: Start is accepted but no run is recorded (the action has not launched).
function global:Get-ScheduledTaskInfo { param($TaskName,$TaskPath) Rec ('sched-info '+$TaskName); $t=$global:Sched[$TaskName]; $ran=$t -and $t.Started -and !$global:S.neverRuns; return [pscustomobject]@{LastRunTime=$(if($ran){[DateTime]::Now}else{[DateTime]::MinValue});LastTaskResult=$(if($ran){[int]$global:S.taskResult}else{267011})} }
function global:Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject) Rec ('sched-register '+$TaskName) -Mutation; $global:Sched[$TaskName]=[pscustomobject]@{State='Ready';Principal=$InputObject.Principal;Polls=0;Started=$false;Task=$InputObject} }
# Unregistering a Running task does not end its instance: the orphan keeps running, invisible to Get-ScheduledTask and the instance lookup.
function global:Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm) Rec ('sched-unregister '+$TaskName) -Mutation; $t=$global:Sched[$TaskName]; if($t -and $t.State -eq 'Running'){ $global:Orphans+=$t }; $global:Sched.Remove($TaskName) }
function global:Export-ScheduledTask { param($TaskName,$TaskPath) Rec ('sched-export '+$TaskName); return ('<Task><Exec>'+$global:Sched[$TaskName].Task.Action.Arguments+'</Exec></Task>') }
# startThrowsAfter: the task really starts, then the cmdlet fails (scheduler timeout).
function global:Start-ScheduledTask { param($TaskName,$TaskPath) Rec ('sched-start '+$TaskName) -Mutation; $t=$global:Sched[$TaskName]; $t.Started=$true; if(!$global:S.neverRuns){$t.State='Running'}; if($global:S.startThrowsAfter){ throw 'INJECTED start timeout' } }
# stuckStops: that many Stop requests leave the task Running (stop pending / a tree that outlives Stop and TerminateJobObject).
function global:Stop-ScheduledTask { param($TaskName,$TaskPath) Rec ('sched-stop '+$TaskName) -Mutation; if($global:StopsIgnored -lt [int]$global:S.stuckStops){ $global:StopsIgnored++; return }; if($global:Sched[$TaskName]){$global:Sched[$TaskName].State='Ready'} }
# lateStartOnDisable: the instance launches between the last start-bound poll and Disable.
function global:Disable-ScheduledTask { param($TaskName,$TaskPath) Rec ('sched-disable '+$TaskName) -Mutation; if($global:S.lateStartOnDisable -and $global:Sched[$TaskName]){ $global:Sched[$TaskName].State='Running' } }
$threw=$null; $exitCode=$null
$splat=@{}; foreach($p in $global:S.args.PSObject.Properties){ $splat[$p.Name]=$p.Value }
try { & $Registrar @splat | Out-Null; $exitCode=$LASTEXITCODE } catch { $threw=$_.Exception.Message }
[ordered]@{threw=$threw;exit=$exitCode;liveAtClose=$global:LiveAtClose;orphans=@($global:Orphans).Count;calls=@($global:Calls);writes=$global:Writes;reads=@($global:Reads);sched=@($global:Sched.Keys);work=@($global:Work);planned=@($global:Planned)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Log
'@

if(!$Tree){throw 'usage: -Tree <repo root>'}
$Tree=(Resolve-Path -LiteralPath $Tree).Path
$pwsh=(Get-Process -Id $PID).Path
$work=Join-Path ([IO.Path]::GetTempPath()) ('wrp-order-'+[guid]::NewGuid().ToString('N'))
$sandbox=Join-Path $work 'tree'
New-Item -ItemType Directory -Path $sandbox | Out-Null
Copy-Item -Recurse -LiteralPath (Join-Path $Tree 'native/backup-age') -Destination $sandbox
$rmq=Join-Path $sandbox 'backup-age/real-main-qualification'
Set-Content -LiteralPath (Join-Path $rmq 'qualification-paths.ps1') -Value $stub
# The account translation is OS-provided ([NTAccount]::Translate); the sandbox copy resolves the synthetic fixture account only.
Add-Content -LiteralPath (Join-Path $rmq 'qualification-identity.ps1') -Value "`nfunction Resolve-QualificationAccountSid([string]`$Account) { if(`$Account -eq `$global:S.account){return `$global:S.sid}; throw 'Qualification account could not be resolved' }"
Set-Content -LiteralPath (Join-Path $work 'bootstrap.ps1') -Value $bootstrap
Push-Location $work
[Environment]::CurrentDirectory=$work
$failures=[Collections.Generic.List[string]]::new()
# Each FAIL names the harness statement that asserted it (the receipt line for mutant receipts).
function Fail([string]$Witness,[string]$Detail){
  $at=@(Get-PSCallStack | Where-Object { $_.ScriptName -eq $PSCommandPath })[-1].ScriptLineNumber
  $Detail=$Detail -replace '\s*\r?\n\s*',' | '
  $failures.Add(('{0}: {1}' -f $Witness,$Detail)); Write-Output ('FAIL {0}: {1} [AssertionFailed ordering-harness.ps1:{2}]' -f $Witness,$Detail,$at)
}

# Synthetic identity values only (W-RP15 on Linux).
$account='Fixture Person'; $sid=('S-1-5','21','1001','2002','3003','1001' -join '-'); $profileRaw='C:\Profiles\Fixture Person'
$verifiedProfile=[IO.Path]::GetFullPath($profileRaw)
$admittedJourney=[IO.Path]::GetFullPath($verifiedProfile+'\AppData\Local\Temp\murage-b20-real-main-20260914-025600')
$hex='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$manifest=[ordered]@{root=($admittedJourney+'\real-main-qualification');executable=($admittedJourney+'\candidate-d70fe5a145d0\app\Murage.exe');exeSha256=$hex;asarSha256=$hex;sid=$sid;sessionId=1;fixtureFiles=[ordered]@{'run.ps1'=$hex;'OwnedJob.cs'=$hex;'dialogs.ps1'=$hex;'seed.ts'=$hex;'verify.mjs'=$hex}}

function Invoke-Scenario([string]$Registrar,[hashtable]$Overrides) {
  $s=[ordered]@{account=$account;sid=$sid;callerSid=$sid;interactive=$account;registeredProfile=$profileRaw;verifiedProfile=$verifiedProfile;manifest=$manifest;failAt=$null;bind=$true;runningPolls=1;taskResult=0;priorTasks=@();reserveFails=$false;neverRuns=$false;lateStartOnDisable=$false;stuckStops=0;startThrowsAfter=$false;args=@{}}
  foreach($k in $Overrides.Keys){$s[$k]=$Overrides[$k]}
  $id=[guid]::NewGuid().ToString('N')
  $scenarioFile=Join-Path $work "$id.json"; $logFile=Join-Path $work "$id.log.json"
  $s | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $scenarioFile
  $stdout=& $pwsh -NoProfile -NonInteractive -File (Join-Path $work 'bootstrap.ps1') -Registrar $Registrar -Scenario $scenarioFile -Log $logFile 2>&1 | Out-String
  $result=Get-Content -LiteralPath $logFile -Raw | ConvertFrom-Json
  $result | Add-Member -NotePropertyName stdout -NotePropertyValue $stdout
  return $result
}
function Mutations($r){ return @($r.calls | Where-Object { $_ -like 'MUT *' }) }

$journey=Join-Path $rmq 'register-journey.ps1'
$journeyArgs=[ordered]@{Account=$account;DesktopSid=$sid;ProfileRoot=$profileRaw;Parent=$admittedJourney;ManifestSha256=$hex;DeadlineUtc=[DateTime]::UtcNow.AddMinutes(15).ToString('o')}
function With([hashtable]$Change){ $h=[ordered]@{}; foreach($k in $journeyArgs.Keys){$h[$k]=$journeyArgs[$k]}; foreach($k in $Change.Keys){$h[$k]=$Change[$k]}; return $h }
$priorName='Murage-B20-RealMain-20260914-025600'

# --- W-RP14 (Linux ordering): the baseline run, then a failure at every admission step.
$base=Invoke-Scenario $journey @{args=$journeyArgs}
$baseOutcome=($base.stdout -split "`n" | Where-Object { $_ -match '"outcome"' } | Select-Object -Last 1)
if($base.threw -or $baseOutcome -notmatch '"outcome":"LEASE-OK"'){ Fail 'W-RP14 baseline' ("journey did not reach LEASE-OK: threw={0} out={1}" -f $base.threw,$base.stdout.Trim()) }
$calls=@($base.calls)
$firstMutation=[Array]::FindIndex([string[]]$calls,[Predicate[string]]{ param($c) $c -like 'MUT *' })
$l3a=[Array]::IndexOf([string[]]$calls,'READ assert#1')
if($l3a -lt 0 -or $firstMutation -lt 0 -or $l3a -ne $firstMutation-1 -or $calls[$firstMutation] -ne 'MUT reserve'){ Fail 'W-RP14 order' ("L3(a) must be the last admission step and RESERVE the first mutation: {0}" -f ($calls -join ' | ')) }
# J1: the kill-on-close job exists before Start (Astra n4:625, launcher loss before binding).
$jobAt=[Array]::IndexOf([string[]]$calls,'READ job'); $startAt=[Array]::IndexOf([string[]]$calls,"MUT sched-start $priorName")
if($jobAt -lt 0 -or $startAt -lt 0 -or $jobAt -gt $startAt){ Fail 'J1 job before start' ("job={0} start={1}" -f $jobAt,$startAt) }
$admission=@($calls[0..($firstMutation-1)] | Where-Object { $_ -like 'READ *' } | ForEach-Object { $_.Substring(5) } | Select-Object -Unique)
foreach($step in $admission) {
  $r=Invoke-Scenario $journey @{args=$journeyArgs;failAt=$step}
  if(!$r.threw -or (Mutations $r).Count -ne 0 -or @($r.writes.PSObject.Properties).Count -ne 0){ Fail 'W-RP14 admit' ("failure at '{0}' -> threw={1} mutations={2}" -f $step,$r.threw,((Mutations $r) -join ',')) }
}
Write-Output ('W-RP14 admission failures: {0} steps, each refused with 0 mutations' -f $admission.Count)
$reserve=Invoke-Scenario $journey @{args=$journeyArgs;reserveFails=$true}
if($reserve.threw -notlike 'REFUSED-RESERVE:*' -or @(Mutations $reserve | Where-Object { $_ -like 'MUT sched-*' }).Count -ne 0){ Fail 'W-RP14 reserve' ("threw={0} mutations={1}" -f $reserve.threw,((Mutations $reserve) -join ',')) }

# --- W-RP14 (iii): post-admission recovery table.
function Expect-Outcome([string]$Name,$r,[string]$Outcome,[string[]]$Must,[string[]]$MustNot) {
  $line=($r.stdout -split "`n" | Where-Object { $_ -match '"outcome"' } | Select-Object -Last 1)
  if($line -notmatch ('"outcome":"'+$Outcome+'"')){ Fail $Name ("expected {0}, got threw={1} out={2}" -f $Outcome,$r.threw,$r.stdout.Trim()); return }
  if($Outcome -ne 'LEASE-OK' -and $r.exit -eq 0){ Fail $Name 'non-LEASE-OK outcome exited 0' }
  foreach($m in $Must){ if(@($r.calls) -notcontains $m){ Fail $Name ("missing call '{0}'" -f $m) } }
  foreach($m in $MustNot){ if(@($r.calls) -contains $m){ Fail $Name ("unexpected call '{0}'" -f $m) } }
}
Expect-Outcome 'W-RP14 register' (Invoke-Scenario $journey @{args=$journeyArgs;failAt="sched-register $priorName"}) 'ABORTED-BEFORE-START' @() @("MUT sched-unregister $priorName","MUT sched-start $priorName")
Expect-Outcome 'W-RP14 export' (Invoke-Scenario $journey @{args=$journeyArgs;failAt='write journey-task.xml'}) 'ABORTED-BEFORE-START' @("MUT sched-unregister $priorName") @("MUT sched-start $priorName")
Expect-Outcome "W-RP14 L3(a')" (Invoke-Scenario $journey @{args=$journeyArgs;failAt='assert#2'}) 'ABORTED-BEFORE-START' @("MUT sched-unregister $priorName") @("MUT sched-start $priorName")
Expect-Outcome 'W-RP14 start' (Invoke-Scenario $journey @{args=$journeyArgs;failAt="sched-start $priorName"}) 'ABORTED-BEFORE-START' @("MUT sched-unregister $priorName") @()
Expect-Outcome 'W-RP14 job' (Invoke-Scenario $journey @{args=$journeyArgs;failAt='job'}) 'ABORTED-BEFORE-START' @("MUT sched-unregister $priorName") @("MUT sched-start $priorName")
# Start fails after the task really started: it is stopped and settled before it is unregistered and the lease closes.
$threwAfter=Invoke-Scenario $journey @{args=$journeyArgs;startThrowsAfter=$true;runningPolls=100000000}
Expect-Outcome 'J5 start threw' $threwAfter 'ABORTED-BEFORE-START' @("MUT sched-stop $priorName","MUT sched-unregister $priorName") @()
$c=[string[]]@($threwAfter.calls)
if([Array]::IndexOf($c,"MUT sched-stop $priorName") -gt [Array]::IndexOf($c,"MUT sched-unregister $priorName")){ Fail 'J5 start threw order' ($c -join ' | ') }
Expect-Outcome 'W-RP14 L3(b)' (Invoke-Scenario $journey @{args=$journeyArgs;failAt='assert#3'}) 'LEASE-BROKEN' @('MUT write journey-lease.txt') @()
Expect-Outcome 'J1 unbound' (Invoke-Scenario $journey @{args=$journeyArgs;bind=$false}) 'UNBOUND' @("MUT sched-stop $priorName") @()
# J5 (Astra n4:625): the tree outlives Stop and TerminateJobObject. The lease is held to the hold cap, then the run is UNSETTLED.
$stuck=Invoke-Scenario $journey @{args=$journeyArgs;bind=$false;runningPolls=100000000;stuckStops=100000000}
Expect-Outcome 'J5 release unsettled' $stuck 'UNSETTLED' @('MUT write journey-lease.txt') @()
if($stuck.writes.'journey-lease.txt' -notmatch '"outcome":"UNSETTLED"' -or $stuck.writes.'journey-lease.txt' -notmatch 'lease released unsettled'){ Fail 'J5 receipt' ('receipt={0}' -f $stuck.writes.'journey-lease.txt') }
$terminates=@($stuck.calls | Where-Object { $_ -eq 'MUT job-terminate' }).Count
$closeAt=[Array]::IndexOf([string[]]@($stuck.calls),'CLOSE lease'); $lastTerminate=[Array]::LastIndexOf([string[]]@($stuck.calls),'MUT job-terminate')
if($terminates -lt 2 -or $closeAt -lt $lastTerminate){ Fail 'J5 hold' ("terminate attempts={0} close={1} lastTerminate={2}" -f $terminates,$closeAt,$lastTerminate) }
# J5: a tree that settles inside the hold keeps its earlier outcome, and the lease closes only after it settled.
$late=Invoke-Scenario $journey @{args=$journeyArgs;bind=$false;runningPolls=100000000;stuckStops=3}
Expect-Outcome 'J5 settles late' $late 'UNBOUND' @() @()
# ASTRA H1 (r2): a started task that is not settled is never unregistered; the J5 hold runs on the registered task,
# the lease closes with no live instance, and the unregister comes only after the Stop that took.
function Expect-HeldThenRemoved([string]$Name,$r) {
  Expect-Outcome $Name $r 'UNSETTLED' @("MUT sched-unregister $priorName") @()
  $c=[string[]]@($r.calls)
  if($r.liveAtClose -ne 0 -or $r.orphans -ne 0){ Fail $Name ("lease closed with live={0} orphans={1}" -f $r.liveAtClose,$r.orphans) }
  $stops=@($c | Where-Object { $_ -eq "MUT sched-stop $priorName" }).Count
  if($stops -lt 4 -or [Array]::LastIndexOf($c,"MUT sched-stop $priorName") -gt [Array]::IndexOf($c,"MUT sched-unregister $priorName") -or [Array]::IndexOf($c,"MUT sched-unregister $priorName") -gt [Array]::IndexOf($c,'CLOSE lease')){ Fail ($Name+' order') ("stops={0} {1}" -f $stops,($c -join ' | ')) }
}
Expect-HeldThenRemoved 'H1a J5 start threw unsettled' (Invoke-Scenario $journey @{args=$journeyArgs;startThrowsAfter=$true;runningPolls=100000000;stuckStops=3})
Expect-HeldThenRemoved 'H1b J5 not-seen late start' (Invoke-Scenario $journey @{args=$journeyArgs;neverRuns=$true;lateStartOnDisable=$true;runningPolls=100000000;stuckStops=3})
# The hold cap ends unsettled: the task stays registered (visible), never unregistered while it may run.
$kept=Invoke-Scenario $journey @{args=$journeyArgs;startThrowsAfter=$true;runningPolls=100000000;stuckStops=100000000}
Expect-Outcome 'H1c start threw never settles' $kept 'UNSETTLED' @('MUT job-terminate') @("MUT sched-unregister $priorName")
if(@($kept.sched) -notcontains $priorName -or $kept.writes.'journey-lease.txt' -notmatch 'task kept registered unsettled'){ Fail 'H1c kept registered' ('sched={0} receipt={1}' -f (@($kept.sched) -join ','),$kept.writes.'journey-lease.txt') }
$notStarted=Invoke-Scenario $journey @{args=$journeyArgs;neverRuns=$true}
Expect-Outcome 'J3 not started' $notStarted 'NOT-STARTED' @("MUT sched-disable $priorName","MUT sched-unregister $priorName") @()
$correctionArgs=With @{ConfirmHiddenAncestorCorrection=$true}
Expect-Outcome 'W-RP14 correction' (Invoke-Scenario $journey @{args=$correctionArgs;priorTasks=@($priorName)}) 'LEASE-OK' @('MUT write journey-console.log.r1',"MUT sched-unregister $priorName","MUT sched-register $priorName") @()
Expect-Outcome 'W-RP14 r1 copy' (Invoke-Scenario $journey @{args=$correctionArgs;priorTasks=@($priorName);failAt='write journey-task.xml.r1'}) 'ABORTED-NO-CHANGE' @('MUT remove-outputs all') @("MUT sched-unregister $priorName")
$kept=Invoke-Scenario $journey @{args=$correctionArgs;priorTasks=@($priorName);failAt="sched-unregister $priorName"}
Expect-Outcome 'W-RP14 prior unregister' $kept 'ABORTED-PRIOR-KEPT' @() @("MUT sched-register $priorName")
if(@($kept.sched) -notcontains $priorName){ Fail 'W-RP14 prior unregister' 'prior task not kept' }
Write-Output 'W-RP14 recovery table done'

# --- W-RP10 (Linux part): consistent fixture; only the checked value differs.
function Expect-Refusal([string]$Name,$r,[string]$Message) {
  if($r.threw -ne $Message -or (Mutations $r).Count -ne 0){ Fail $Name ("expected refusal '{0}' with 0 mutations, got threw={1} mutations={2}" -f $Message,$r.threw,((Mutations $r) -join ',')) }
}
Expect-Refusal 'W-RP10 P1 caller' (Invoke-Scenario $journey @{args=$journeyArgs;callerSid=($sid+'9')}) 'Caller token is not the qualification account'
Expect-Refusal 'W-RP10 P2 case' (Invoke-Scenario $journey @{args=(With @{ProfileRoot=$profileRaw.ToLowerInvariant().Replace('c:\','C:\')})}) 'Qualification profile root does not match ProfileList'
Expect-Refusal 'W-RP10 P2 separator' (Invoke-Scenario $journey @{args=(With @{ProfileRoot=($profileRaw+'\')})}) 'Qualification profile root does not match ProfileList'
foreach($parent in @(($admittedJourney+'\'),($admittedJourney.Substring(0,$admittedJourney.Length-6)+'025601'),($admittedJourney.Replace('murage-b20','Murage-B20')))) {
  Expect-Refusal 'W-RP10 P3 parent' (Invoke-Scenario $journey @{args=(With @{Parent=$parent})}) 'Parent is not the admitted directory'
}
Write-Output 'W-RP10 Linux parity done'

# --- Siblings: same terminal path, pinned set and X1 outputs from the sources.
$siblings=@(Get-ChildItem -LiteralPath (Join-Path $sandbox 'backup-age') -Filter 'register-*.ps1')
if($siblings.Count -ne 7){ Fail 'siblings' ('expected 7 sibling registrars, found {0}' -f $siblings.Count) }
$siblingRuns=@()
foreach($file in $siblings) {
  $r=Invoke-Scenario $file.FullName @{args=@{Account=$account;DesktopSid=$sid;ProfileRoot=$profileRaw;ProbeSha256=$hex;HelperSha256=$hex}}
  $siblingRuns+=$r
  Expect-Outcome ('sibling '+$file.Name) $r 'LEASE-OK' @('READ pin native-probe.exe','READ pin native\backup-age\protocol.mjs','READ pin dist-native\backup-tools\win32-x64\murage-backup-age.exe','READ pin dist-native\backup-tools\win32-x64\age.exe','READ pin dist-native\backup-tools\win32-x64\age-keygen.exe') @()
  $js=@($r.calls | Where-Object { $_ -in @('READ pin native-fixture.mjs','READ pin guard-diagnostic.mjs') })
  if($js.Count -ne 1){ Fail ('sibling '+$file.Name) 'probe JS not pinned' }
  if(@($r.planned | Where-Object { $_ -match '^(native|guard-diagnostic)-receipts\.json$' }).Count -ne 1){ Fail ('sibling '+$file.Name) 'JS receipts not reserved' }
  $first=[Array]::FindIndex([string[]]@($r.calls),[Predicate[string]]{ param($c) $c -like 'MUT *' })
  if(@($r.calls)[$first-1] -ne 'READ assert#1'){ Fail ('sibling order '+$file.Name) 'L3(a) is not the last admission step' }
  $missing=Invoke-Scenario $file.FullName @{args=@{Account=$account;DesktopSid=$sid;ProfileRoot=$profileRaw;ProbeSha256='not-a-pin';HelperSha256=$hex}}
  if(!$missing.threw -or (Mutations $missing).Count){ Fail ('sibling probe pin '+$file.Name) 'malformed -ProbeSha256 was not refused before mutation' }
}
Write-Output ('siblings: {0} registrars on the leased path' -f $siblings.Count)

# --- W-RP15 (synthetic identity): stdout and every non-I1 output carry no account, SID or profile-derived path.
$i1=@('journey-task.xml','journey-task.xml.r1','journey-task-invoked.txt.r1','journey-console.log.r1')
$identity=@($account,$sid,$verifiedProfile,$profileRaw,'Profiles\Fixture')
$corpus=@($base.stdout)+@($siblingRuns | ForEach-Object { $_.stdout })
foreach($run in @($base)+$siblingRuns){ foreach($p in $run.writes.PSObject.Properties){ if($p.Name -notin $i1 -and $p.Name -notlike '*-task.xml'){ $corpus+=$p.Value } } }
$hits=0; foreach($text in $corpus){ foreach($value in $identity){ if($text -and $text.IndexOf($value,[StringComparison]::OrdinalIgnoreCase) -ge 0){ $hits++ } } }
if($hits){ Fail 'W-RP15' ('{0} identity occurrences in stdout/receipts/markers' -f $hits) } else { Write-Output ('W-RP15: 0 identity occurrences in {0} outputs' -f $corpus.Count) }
if(!(Select-String -LiteralPath (Join-Path $rmq 'preflight.ps1') -SimpleMatch "seedRoot='real-main-qualification'" -Quiet)){ Fail 'W-RP15 preflight' 'seedRoot is not the relative name' }

# --- W-RP16: prepare/complete-lpac refuse on the elapsed deadline before any Temp read or write.
foreach($pair in @(@('prepare-lpac-extension.ps1','Extension deadline elapsed'),@('complete-lpac-extension.ps1','Extension expired'))) {
  $ext=Join-Path (Join-Path $verifiedProfile 'AppData\Local\Temp\murage-b20-real-main-20260914-025600') 'extension-20260914-035100'
  $r=Invoke-Scenario (Join-Path $rmq $pair[0]) @{args=@{Account=$account;DesktopSid=$sid;ProfileRoot=$profileRaw;Extension=$ext}}
  if($r.threw -ne $pair[1] -or @($r.reads).Count -ne 0 -or (Mutations $r).Count -ne 0){ Fail 'W-RP16' ("{0}: threw={1} reads={2}" -f $pair[0],$r.threw,@($r.reads).Count) }
}
Write-Output 'W-RP16 lpac refusals done'

# --- Static: no registrar passes -AfterOpen or sets the witness watch delay; only qualification-paths.ps1 defines the scheduler instance lookup.
$all=@(Get-ChildItem -LiteralPath (Join-Path $Tree 'native/backup-age') -Recurse -Filter '*.ps1' | Where-Object { $_.FullName -notmatch '[\\/]witnesses[\\/]' })
foreach($file in $all) {
  $ast=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$null,[ref]$null)
  $after=@($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandParameterAst] -and $n.ParameterName -eq 'AfterOpen' },$true))
  if($after.Count){ Fail 'static AfterOpen' $file.Name }
  $defs=@($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-QualificationTaskActionPid' },$true))
  if($defs.Count -and $file.Name -ne 'qualification-paths.ps1'){ Fail 'static instance lookup' $file.Name }
  if($file.Name -ne 'qualification-paths.ps1' -and (Select-String -LiteralPath $file.FullName -SimpleMatch 'WitnessWatchDelayMs' -Quiet)){ Fail 'static watch delay' $file.Name }
}
Write-Output ('static checks over {0} scripts' -f $all.Count)

Pop-Location
Remove-Item -Recurse -Force -LiteralPath $work
if($failures.Count){ Write-Output ('ORDERING HARNESS RED: {0} failure(s)' -f $failures.Count); exit 1 }
Write-Output 'ORDERING HARNESS GREEN'
