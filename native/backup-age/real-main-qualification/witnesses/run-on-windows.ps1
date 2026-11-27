# Native witnesses for PS1-REPARSE-DESIGN-r2 section 3 (Beast or Desktop runner, via WINRUN-REQ).
# Real kernel32 helper, real NTFS links, real job objects; only the ProfileList lookup, Win32_ComputerSystem and (for
# recorder witnesses) the scheduler cmdlets are shadowed. Results go to -Out (outside the repo). A NOT RUN row never passes.
# Usage (elevation not required): powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-on-windows.ps1 -Repo <checkout> -Out <dir> [-Mutants]
param([Parameter(Mandatory=$true)][string]$Repo,[Parameter(Mandatory=$true)][string]$Out,[switch]$Mutants,[string]$HostExe=(Join-Path $PSHOME 'powershell.exe'))
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $HostExe)){ $HostExe=(Get-Process -Id $PID).Path }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$results=[Collections.Generic.List[object]]::new()
$account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskJourney='Murage-B20-RealMain-20260914-025600'
$rmqName='real-main-qualification'

function Row([string]$Id,[string]$Status,[string]$Detail){ $results.Add([pscustomobject]@{id=$Id;host=(Split-Path $HostExe -Leaf);status=$Status;detail=$Detail}); Write-Host ('{0} {1} {2}' -f $Status,$Id,$Detail) }
function Sha([string]$Path){ (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
# A witness returns its named checks; it is GREEN only when every check holds. Mutant receipts name the check they target.
function Checks([Collections.Specialized.OrderedDictionary]$C,[string]$Detail){ return [pscustomobject]@{ok=(@($C.Values | Where-Object { !$_ }).Count -eq 0);checks=$C;detail=$Detail} }
function Failed($Res){ return (@($Res.checks.Keys | Where-Object { !$Res.checks[$_] }) -join ',') }
function Win32([object]$ErrorRecord){ $e=$ErrorRecord.Exception; while($e.InnerException){$e=$e.InnerException}; return ($e.HResult -band 0xFFFF) }

# Work copy of the repo scripts: mutants and the B2 instance-lookup shadow are applied here, never in the checkout.
function New-WorkTree([string]$Mutant,[switch]$Recorder) {
  $w=Join-Path $env:TEMP ('wrp-tree-'+[guid]::NewGuid().ToString('N'))
  Copy-Item -Recurse -LiteralPath (Join-Path $Repo 'native\backup-age') -Destination $w
  if($Mutant){ Set-Mutant $w $Mutant }
  if($Recorder) {
    Add-Content -LiteralPath (Join-Path $w "$rmqName\qualification-paths.ps1") -Value @'

# WITNESS SHADOW (B2): the recorder's Start launched a real powershell.exe whose command line names the admitted path.
function Get-QualificationTaskActionPid([string]$TaskName) { if(Get-Command WrpTick -ErrorAction SilentlyContinue){ WrpTick }; $p=$global:WrpActionPid; if($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)){ return $p }; return $null }
'@
  }
  return $w
}

function Edit-File([string]$Path,[string]$Old,[string]$New) {
  $text=[IO.File]::ReadAllText($Path)
  if(!$text.Contains($Old)){ throw ('MUTANT NOT APPLIED in {0}: {1}' -f (Split-Path $Path -Leaf),$Old) }
  [IO.File]::WriteAllText($Path,$text.Replace($Old,$New))
}

function Set-Mutant([string]$w,[string]$Id) {
  $paths=Join-Path $w "$rmqName\qualification-paths.ps1"; $run=Join-Path $w "$rmqName\qualification-run.ps1"
  switch($Id) {
    'M1' { Edit-File $paths 'for (int i = 1; i < parts.Length; i++) { cursor = cursor + "\\" + parts[i]; HoldDirectory(cursor, i == parts.Length - 1 ? "admitted" : "ancestor"); }' 'HoldDirectory(Admitted, "admitted");' }
    'M2' { Edit-File $paths 'public const uint FLAG_BACKUP_SEMANTICS = 0x02000000, FLAG_OPEN_REPARSE_POINT = 0x00200000' 'public const uint FLAG_BACKUP_SEMANTICS = 0x02000000, FLAG_OPEN_REPARSE_POINT = 0' }
    'M3' { Edit-File $paths 'if (!directory && info.Links != 1)' 'if (false)' }
    'M3b' { Edit-File $run "    try { Assert-QualificationLease `$Lease; `$r.outcome='LEASE-OK' }" "    try { `$r.outcome='LEASE-OK' }" }
    'M4a' { Edit-File $paths 'if (!string.Equals(actual, expected, StringComparison.Ordinal)) throw' 'if (false) throw' }
    'M4b' { Edit-File $paths '$bytes=Invoke-QualificationLeaseCall { $Lease.HashPinned($Path,$Sha256,[bool]$ReturnBytes) }' '$bytes=$null; if((Get-FileHash -LiteralPath (Join-Path $Lease.Admitted $Path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256){throw ("Pinned file hash mismatch: <admitted>\"+$Path)}' }
    'M5' { Edit-File $paths 'if (final == null || !string.Equals(final, item.Expected, StringComparison.OrdinalIgnoreCase))' 'if (false)' }
    'M6a' { Edit-File $paths 'if (!h.IsInvalid) { h.Dispose(); throw new LeaseRefused("Output name already exists: " + Name(full)); }' 'if (!h.IsInvalid) { h.Dispose(); return; }' }
    'M6d' { Edit-File $paths 'if (planted) throw new LeaseRefused' 'if (false) throw new LeaseRefused' }
    'M7' { Edit-File $run '    try { Start-ScheduledTask -TaskName $TaskName' '    Close-QualificationLease $Lease' + "`r`n" + '    try { Start-ScheduledTask -TaskName $TaskName' }
    'M7d' { Edit-File $paths 'SafeFileHandle h = Open(full, Native.FILE_LIST_DIRECTORY | Native.FILE_READ_ATTRIBUTES | Native.SYNCHRONIZE, Native.SHARE_READ | Native.SHARE_WRITE, Native.OPEN_EXISTING, Native.FLAG_BACKUP_SEMANTICS | Native.FLAG_OPEN_REPARSE_POINT);' 'SafeFileHandle h = Open(full, Native.FILE_READ_ATTRIBUTES | Native.SYNCHRONIZE, Native.SHARE_READ | Native.SHARE_WRITE | Native.SHARE_DELETE, Native.OPEN_EXISTING, Native.FLAG_BACKUP_SEMANTICS | Native.FLAG_OPEN_REPARSE_POINT);' }
    'M8' { Edit-File $paths 'if (directory && CaseSensitive(item.Handle))' 'if (false)' }
    'M12' { Edit-File $paths '  if(!$Job.Assign($ActionPid)){return $false}' '  return $true' }
    'M6c' { Edit-File $paths 'if (!Allowed(name)) lock (gate)' 'if (false) lock (gate)' }
    'M6e' { Edit-File $paths '        Drain();' '        // Drain();' }
    'M13' { Edit-File $run '$until=$startUtc.AddSeconds($StartBoundSeconds)' '$until=$startUtc' }
    # M14 releases the lease after the watchdog write (which must still succeed) and before the stop-pending settle wait.
    'M14' { Edit-File $run "deadline``r``n`")" ("deadline``r``n`")"+[Environment]::NewLine+'      Close-QualificationLease $Lease') }
    'M21n' { Edit-File $paths 'foreach($item in $created){ try {' 'foreach($item in @()){ try {' }
    default { throw ('Unknown mutant '+$Id) }
  }
}

# NTFS sandbox C:\wrp-<guid>\Users\fixture\AppData\Local\Temp\<scratch> with a journey-shaped admitted directory.
function New-Sandbox([string]$RunPs1) {
  $base='C:\wrp-'+[guid]::NewGuid().ToString('N').Substring(0,12)
  $profileRoot=Join-Path $base 'Users\fixture'
  $adm=Join-Path $profileRoot 'AppData\Local\Temp\murage-b20-real-main-20260914-025600'
  $fixture=Join-Path $adm 'fixture'; $app=Join-Path $adm 'candidate-d70fe5a145d0\app'
  New-Item -ItemType Directory -Force -Path $fixture,(Join-Path $app 'resources'),(Join-Path $base 'outside') | Out-Null
  $src=Join-Path $Repo "native\backup-age\$rmqName"
  foreach($n in 'OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs','journey-entry.ps1'){ Copy-Item -LiteralPath (Join-Path $src $n) -Destination $fixture }
  if($RunPs1){ [IO.File]::WriteAllText((Join-Path $fixture 'run.ps1'),$RunPs1) } else { Copy-Item -LiteralPath (Join-Path $src 'run.ps1') -Destination $fixture }
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\whoami.exe') -Destination (Join-Path $app 'Murage.exe')
  [IO.File]::WriteAllText((Join-Path $app 'resources\app.asar'),'synthetic asar')
  [IO.File]::WriteAllText((Join-Path $app 'electron-stand-in.dll'),'synthetic dll')
  $hashes=[ordered]@{}; foreach($n in 'run.ps1','OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs'){ $hashes[$n]=Sha (Join-Path $fixture $n) }
  $manifest=[ordered]@{root=(Join-Path $adm $rmqName);executable=(Join-Path $app 'Murage.exe');exeSha256=(Sha (Join-Path $app 'Murage.exe'));asarSha256=(Sha (Join-Path $app 'resources\app.asar'));sid=$sid;sessionId=1;deadlineUtc=[DateTime]::UtcNow.AddMinutes(15).ToString('o');fixtureFiles=$hashes}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 5))
  [IO.File]::WriteAllBytes((Join-Path $adm 'journey-manifest.json'),$bytes)
  return [pscustomobject]@{Base=$base;Profile=$profileRoot;Admitted=$adm;ManifestSha=(Sha (Join-Path $adm 'journey-manifest.json'));Outside=(Join-Path $base 'outside')}
}

function Get-TreeManifest([string]$Root) {
  @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object {
    if($_.PSIsContainer){ '{0}|d|{1}' -f $_.FullName,$_.Attributes } else { '{0}|{1}|{2}' -f $_.FullName,$_.Length,(Sha $_.FullName) } }) -join "`n"
}

function Remove-Sandbox($Box) {
  if(!$Box){return}
  Get-ChildItem -LiteralPath $Box.Base -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { if($_.PSIsContainer){ [IO.Directory]::Delete($_.FullName,$false) } else { [IO.File]::Delete($_.FullName) } }
  Remove-Item -LiteralPath ($Box.Base) -Recurse -Force -ErrorAction SilentlyContinue
}

# Child-process bootstrap: shadows (ProfileList, Win32_ComputerSystem, optional scheduler recorders), then the registrar.
$bootstrap=@'
param([string]$Script,[string]$ArgsFile,[string]$ProfileRoot,[string]$Account,[string]$Recorder,[string]$OpsFile,[string]$Log)
$ErrorActionPreference='Stop'
$global:WrpCalls=[Collections.Generic.List[string]]::new(); $global:WrpOps=@(); $global:WrpActionPid=$null
$global:WrpProfile=$ProfileRoot
function global:Get-ItemPropertyValue { param($LiteralPath,$Name,$ErrorAction) return $global:WrpProfile }
function global:Get-CimInstance { param($ClassName,$Filter) if($ClassName -eq 'Win32_ComputerSystem'){ return [pscustomobject]@{UserName=$Account} }; if($Filter){ return CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter $Filter }; return CimCmdlets\Get-CimInstance -ClassName $ClassName }
if($Recorder -eq '1') {
  $global:WrpTask=$null
  function global:Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject) $global:WrpCalls.Add('MUT register'); $global:WrpTask=$InputObject }
  function global:Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm) $global:WrpCalls.Add('MUT unregister'); $global:WrpTask=$null }
  function global:Disable-ScheduledTask { param($TaskName,$TaskPath) $global:WrpCalls.Add('MUT disable') }
  # WRP_START_DELAY (seconds or 'never'): the action launches lazily on the first poll after the delay (W-RP12); WRP_DELAY_OPS
  # run once on the first poll 10 s into the delay, while the task is still Ready.
  # WRP_STOP_PENDING (seconds): Stop is recorded but the action is killed only after the delay; WRP_STOP_OPS run once on
  # the first poll after Stop returned (W-RP13). WRP_ACTION_SECONDS: action lifetime. WRP_PIDFILE: the action pid (W-RP11).
  function global:WrpLaunch {
    $adm=$global:WrpTask.Actions[0].WorkingDirectory
    $seconds=6; if($env:WRP_ACTION_SECONDS){ $seconds=[int]$env:WRP_ACTION_SECONDS }
    $p=Start-Process -PassThru -WindowStyle Hidden -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-Command',('Start-Sleep -Seconds '+$seconds+' # '+$adm))
    $global:WrpActionPid=$p.Id
    if($env:WRP_PIDFILE){ Set-Content -LiteralPath $env:WRP_PIDFILE -Value $p.Id }
  }
  function global:WrpTick {
    if($env:WRP_DELAY_OPS -and $global:WrpDelayOpsAt -and !$global:WrpDelayOpsRun -and !$global:WrpActionPid -and [DateTime]::UtcNow -ge $global:WrpDelayOpsAt){ $global:WrpDelayOpsRun=$true; $ops=. $env:WRP_DELAY_OPS; foreach($op in $ops){ $global:WrpOps+=('delay '+(& $op)) } }
    if(!$global:WrpActionPid -and $global:WrpStartAt -and [DateTime]::UtcNow -ge $global:WrpStartAt){ WrpLaunch }
    if($global:WrpStopAt) {
      if($env:WRP_STOP_OPS -and !$global:WrpStopOpsRun){ $global:WrpStopOpsRun=$true; $ops=. $env:WRP_STOP_OPS; foreach($op in $ops){ $global:WrpOps+=('stop '+(& $op)) } }
      if([DateTime]::UtcNow -ge $global:WrpStopAt -and $global:WrpActionPid){ Stop-Process -Id $global:WrpActionPid -Force -ErrorAction SilentlyContinue }
    }
  }
  function global:Stop-ScheduledTask { param($TaskName,$TaskPath)
    $global:WrpCalls.Add('MUT stop')
    if($env:WRP_STOP_PENDING){ if(!$global:WrpStopAt){ $global:WrpStopAt=[DateTime]::UtcNow.AddSeconds([int]$env:WRP_STOP_PENDING) }; return }
    if($global:WrpActionPid){ Stop-Process -Id $global:WrpActionPid -Force -ErrorAction SilentlyContinue } }
  function global:Export-ScheduledTask { param($TaskName,$TaskPath) return '<Task/>' }
  function global:Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction)
    WrpTick
    if(!$global:WrpTask){ if($ErrorAction -eq 'SilentlyContinue'){return $null}; throw 'No MSFT_ScheduledTask objects found' }
    $running=$global:WrpActionPid -and (Get-Process -Id $global:WrpActionPid -ErrorAction SilentlyContinue)
    return [pscustomobject]@{State=$(if($running){'Running'}else{'Ready'});Principal=$global:WrpTask.Principal} }
  function global:Get-ScheduledTaskInfo { param($TaskName,$TaskPath) return [pscustomobject]@{LastRunTime=$(if($global:WrpActionPid){[DateTime]::Now}else{[DateTime]::MinValue});LastTaskResult=$(if($global:WrpActionPid){0}else{267011})} }
  function global:Start-ScheduledTask { param($TaskName,$TaskPath)
    $global:WrpCalls.Add('MUT start')
    if($env:WRP_START_DELAY -eq 'never'){ $global:WrpStartAt=[DateTime]::MaxValue }
    elseif($env:WRP_START_DELAY){ $global:WrpStartAt=[DateTime]::UtcNow.AddSeconds([int]$env:WRP_START_DELAY); $global:WrpDelayOpsAt=[DateTime]::UtcNow.AddSeconds(10) }
    else { WrpLaunch }
    if($OpsFile){ $ops=. $OpsFile; foreach($op in $ops){ $global:WrpOps+=(& $op) } }
  }
}
$splat=@{}; foreach($p in (Get-Content -LiteralPath $ArgsFile -Raw | ConvertFrom-Json).PSObject.Properties){ $splat[$p.Name]=$p.Value }
$threw=$null; $code=$null
try { & $Script @splat | Out-Null; $code=$LASTEXITCODE } catch { $threw=$_.Exception.Message }
[ordered]@{threw=$threw;exit=$code;calls=@($global:WrpCalls);ops=@($global:WrpOps)} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Log
'@
$bootFile=Join-Path $Out 'bootstrap.ps1'; Set-Content -LiteralPath $bootFile -Value $bootstrap

function Invoke-Journey($Box,[string]$Tree,[hashtable]$Extra,[switch]$Recorder,[string]$Ops,[switch]$Real) {
  $a=[ordered]@{Account=$account;DesktopSid=$sid;ProfileRoot=$Box.Profile;Parent=$Box.Admitted;ManifestSha256=$Box.ManifestSha;DeadlineUtc=[DateTime]::UtcNow.AddMinutes(15).ToString('o')}
  if($Extra){ foreach($k in $Extra.Keys){ $a[$k]=$Extra[$k] } }
  $log=Join-Path $Out ('run-'+[guid]::NewGuid().ToString('N')+'.json')
  $opsFile=''; if($Ops){ $opsFile=Join-Path $Out ('ops-'+[guid]::NewGuid().ToString('N')+'.ps1'); Set-Content -LiteralPath $opsFile -Value $Ops }
  $argsFile=Join-Path $Out ('args-'+[guid]::NewGuid().ToString('N')+'.json'); $a | ConvertTo-Json -Compress | Set-Content -LiteralPath $argsFile
  $stdout=& $HostExe -NoProfile -ExecutionPolicy Bypass -File $bootFile -Script (Join-Path $Tree "$rmqName\register-journey.ps1") -ArgsFile $argsFile -ProfileRoot $Box.Profile -Account $account -Recorder $(if($Recorder){'1'}else{'0'}) -OpsFile $opsFile -Log $log 2>&1 | Out-String
  $r=Get-Content -LiteralPath $log -Raw | ConvertFrom-Json
  $r | Add-Member -NotePropertyName stdout -NotePropertyValue $stdout
  $line=($stdout -split "`n" | Where-Object { $_ -match '"outcome"' } | Select-Object -Last 1)
  $r | Add-Member -NotePropertyName outcome -NotePropertyValue $(if($line -match '"outcome":"([A-Z-]+)"'){$Matches[1]}else{$null})
  return $r
}

# Refusal: exact class, 0 mutating scheduler calls, scratch tree identical (independent manifest by the harness).
function Test-Refusal([string]$Id,[scriptblock]$Setup,[string]$Class,[string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder
  try {
    $skip=& $Setup $box
    if($skip -is [string] -and $skip.StartsWith('NOT RUN')){ Row $Id 'NOTRUN' $skip; return $null }
    $before=Get-TreeManifest $box.Base
    $r=Invoke-Journey $box $tree $null -Recorder
    $after=Get-TreeManifest $box.Base
    $res=Checks ([ordered]@{class=[bool]($r.threw -and $r.threw.StartsWith($Class));mutations0=(@($r.calls | Where-Object { $_ -like 'MUT *' }).Count -eq 0);treeSame=($before -eq $after)}) $r.threw
    Row ($Id+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('{0} threw={1} mutations={2} treeSame={3} failed={4}' -f $(if($Mutant){'mutant '+$Mutant}else{''}),$r.threw,@($r.calls | Where-Object { $_ -like 'MUT *' }).Count,($before -eq $after),(Failed $res))
    return $res
  } finally { Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}

function New-Junction([string]$Path){ $real=$Path+'-real'; [IO.Directory]::Move($Path,$real); cmd /c mklink /J "$Path" "$real" | Out-Null; if(!(Test-Path -LiteralPath $Path)){throw 'junction failed'} }
function Pinned($b){ @('journey-manifest.json','fixture\run.ps1','fixture\OwnedJob.cs','fixture\dialogs.ps1','fixture\seed.ts','fixture\verify.mjs','fixture\journey-entry.ps1','candidate-d70fe5a145d0\app\Murage.exe','candidate-d70fe5a145d0\app\resources\app.asar') }

# ---------- W-RP1 / W-RP2: junctions on every ancestor and work directory.
$junctionCases=[ordered]@{
  'W-RP1 Temp'={ param($b) New-Junction (Split-Path $b.Admitted) }
  'W-RP2 Local'={ param($b) New-Junction (Join-Path $b.Profile 'AppData\Local') }
  'W-RP2 profile'={ param($b) New-Junction $b.Profile }
  'W-RP2 Users'={ param($b) New-Junction (Join-Path $b.Base 'Users') }
  'W-RP2 admitted'={ param($b) New-Junction $b.Admitted }
  'W-RP2 fixture'={ param($b) New-Junction (Join-Path $b.Admitted 'fixture') }
  'W-RP2 candidate'={ param($b) New-Junction (Join-Path $b.Admitted 'candidate-d70fe5a145d0\app\resources') }
}
foreach($k in $junctionCases.Keys){ $null=Test-Refusal $k $junctionCases[$k] 'Reparse point on admitted path' }
# ---------- W-RP3: file symlinks to identical bytes (symlink privilege or developer mode, otherwise NOT RUN).
foreach($p in Pinned){ $null=Test-Refusal ('W-RP3 '+$p) ([scriptblock]::Create("param(`$b) `$f=Join-Path `$b.Admitted '$p'; `$c=Join-Path `$b.Outside ([IO.Path]::GetFileName(`$f)); Copy-Item -LiteralPath `$f -Destination `$c; Remove-Item -LiteralPath `$f; try { New-Item -ItemType SymbolicLink -Path `$f -Target `$c -ErrorAction Stop | Out-Null } catch { Copy-Item -LiteralPath `$c -Destination `$f; return 'NOT RUN: symlink privilege absent' }")) 'Reparse point on admitted path' }
# ---------- W-RP4: hardlinks (nlink 2) on every pinned file and one held candidate DLL.
foreach($p in (Pinned)+@('candidate-d70fe5a145d0\app\electron-stand-in.dll')){ $null=Test-Refusal ('W-RP4 '+$p) ([scriptblock]::Create("param(`$b) New-Item -ItemType HardLink -Path (Join-Path `$b.Outside ('link-'+[guid]::NewGuid().ToString('N'))) -Target (Join-Path `$b.Admitted '$p') | Out-Null")) 'Hardlinked file refused' }
# ---------- W-RP5a: one byte changed in each pinned file against its pin source.
foreach($p in Pinned){ $null=Test-Refusal ('W-RP5a '+$p) ([scriptblock]::Create("param(`$b) `$f=Join-Path `$b.Admitted '$p'; `$x=[IO.File]::ReadAllBytes(`$f); `$x[`$x.Length-1]=`$x[`$x.Length-1] -bxor 1; [IO.File]::WriteAllBytes(`$f,`$x)")) 'Pinned file hash mismatch' }
# ---------- W-RP6: subst drive (8.3 NOT RUN when short names are off).
$null=Test-Refusal 'W-RP6 subst' { param($b) $d=@('W:','V:','U:' | Where-Object { !(Test-Path ($_+'\')) })[0]; if(!$d){return 'NOT RUN: no free drive letter'}; cmd /c subst $d $b.Base | Out-Null; $b.Profile=$d+'\Users\fixture'; $b.Admitted=$d+$b.Admitted.Substring($b.Base.Length); $b | Add-Member -NotePropertyName Subst -NotePropertyValue $d } 'Final path mismatch on admitted path'
cmd /c subst W: /d 2>$null | Out-Null; cmd /c subst V: /d 2>$null | Out-Null; cmd /c subst U: /d 2>$null | Out-Null
# ---------- W-RP7a: planted links at output names before admission. W-RP7d: planted code.
foreach($o in 'journey-task.xml','journey-task-invoked.txt','journey-console.log','journey-lease.txt','journey-watchdog.txt') {
  $null=Test-Refusal ('W-RP7a hardlink '+$o) ([scriptblock]::Create("param(`$b) `$t=Join-Path `$b.Outside 'target.txt'; [IO.File]::WriteAllText(`$t,'outside'); New-Item -ItemType HardLink -Path (Join-Path `$b.Admitted '$o') -Target `$t | Out-Null")) 'Output name already exists'
  $null=Test-Refusal ('W-RP7a junction '+$o) ([scriptblock]::Create("param(`$b) cmd /c mklink /J (Join-Path `$b.Admitted '$o') `$b.Outside | Out-Null")) 'Output name already exists'
}
foreach($o in 'version.dll','native-probe.exe.local','planted.manifest','planted.exe'){ $null=Test-Refusal ('W-RP7d '+$o) ([scriptblock]::Create("param(`$b) [IO.File]::WriteAllText((Join-Path `$b.Admitted '$o'),'x')")) 'Planted code refused' }
# ---------- W-RP9: case-sensitive admitted directory (NOT RUN when the flag cannot be set).
$null=Test-Refusal 'W-RP9' { param($b) $o=cmd /c fsutil file setCaseSensitiveInfo $b.Admitted enable 2>&1; if($LASTEXITCODE){ return 'NOT RUN: case-sensitive flag unavailable' } } 'Case-sensitive directory refused'

# ---------- W-RP8 a,b,c,f and W-RP8e: swaps from the Start recorder under the lease; each op also runs unleased (control).
$swapOps=@'
@(
 { try { [IO.Directory]::Move($env:WRP_ADM,$env:WRP_ADM+'-moved'); 'a:0' } catch { 'a:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } },
 { try { [IO.File]::WriteAllText((Join-Path $env:WRP_ADM 'candidate-d70fe5a145d0\app\Murage.exe'),'x'); 'b:0' } catch { 'b:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } },
 { try { [IO.File]::Delete((Join-Path $env:WRP_ADM 'fixture\OwnedJob.cs')); 'c:0' } catch { 'c:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } },
 { try { [IO.Directory]::Move((Split-Path $env:WRP_ADM),(Split-Path $env:WRP_ADM)+'-moved'); 'f:0' } catch { 'f:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } }
)
'@
function Test-Swaps([string]$Mutant) {
  # Control: each op alone on its own identical unleased sandbox must succeed.
  $ctl=@(); foreach($op in @(& ([scriptblock]::Create($swapOps)))){ $control=New-Sandbox; $env:WRP_ADM=$control.Admitted; $ctl+=(& $op); Remove-Sandbox $control }
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder; $env:WRP_ADM=$box.Admitted
  try {
    $before=@{}; foreach($p in Pinned){ $before[$p]=Sha (Join-Path $box.Admitted $p) }
    $r=Invoke-Journey $box $tree $null -Recorder -Ops $swapOps
    $changed=@(Pinned | Where-Object { !(Test-Path -LiteralPath (Join-Path $box.Admitted $_)) -or (Sha (Join-Path $box.Admitted $_)) -ne $before[$_] }).Count
    $res=Checks ([ordered]@{control=((@($ctl) -join ',') -eq 'a:0,b:0,c:0,f:0');leased=((@($r.ops) -join ',') -eq 'a:32,b:32,c:32,f:32');unchanged=($changed -eq 0);outcome=($r.outcome -eq 'LEASE-OK')})
    Row ('W-RP8 a,b,c,f'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('control={0} leased={1} changed={2} outcome={3} threw={4} failed={5}' -f ($ctl -join ','),(@($r.ops) -join ','),$changed,$r.outcome,$r.threw,(Failed $res))
    return $res
  } finally { Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-Swaps $null
$hardlinkOps=@'
@(
 { $l=Join-Path (Split-Path (Split-Path (Split-Path (Split-Path (Split-Path (Split-Path $env:WRP_ADM)))))) 'outside\probe-link.exe'; try { New-Item -ItemType HardLink -Path $l -Target (Join-Path $env:WRP_ADM 'candidate-d70fe5a145d0\app\Murage.exe') -ErrorAction Stop | Out-Null; 'e1:0' } catch { 'e1:fail' } },
 { $l=Join-Path (Split-Path (Split-Path (Split-Path (Split-Path (Split-Path (Split-Path $env:WRP_ADM)))))) 'outside\probe-link.exe'; try { [IO.File]::WriteAllText($l,'x'); 'e2:0' } catch { 'e2:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } }
)
'@
function Test-HardlinkDuringRun([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder; $env:WRP_ADM=$box.Admitted
  try {
    $exe=Join-Path $box.Admitted 'candidate-d70fe5a145d0\app\Murage.exe'; $h=Sha $exe
    $r=Invoke-Journey $box $tree $null -Recorder -Ops $hardlinkOps
    $res=Checks ([ordered]@{e2=(@($r.ops)[1] -eq 'e2:32');exeSame=((Sha $exe) -eq $h);outcome=($r.outcome -eq 'LEASE-BROKEN');exitNonZero=($r.exit -ne 0)})
    Row ('W-RP8e1/e2'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('ops={0} outcome={1} exit={2} failed={3}' -f (@($r.ops) -join ','),$r.outcome,$r.exit,(Failed $res))
    return $res
  } finally { Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-HardlinkDuringRun $null

# ---------- W-RP5b: handle vs name; a deny-read ACE lands after F1 opened each pinned file.
function Test-HandleNotName([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant
  try {
    $env:WRP_WITNESS='1'
    $script=@"
`$ErrorActionPreference='Stop'
. '$tree\$rmqName\qualification-paths.ps1'
`$denied=[Collections.Generic.List[string]]::new()
`$lease=New-QualificationLease -Root '$($box.Profile)' -Directory '$($box.Admitted)' -AfterOpen { param(`$p) icacls `$p /deny ('{0}:(R)' -f '$account') | Out-Null; `$denied.Add(`$p) }
try { Add-QualificationPin `$lease 'journey-manifest.json' '$($box.ManifestSha)'; 'ADMITTED' } catch { 'REFUSED '+`$_.Exception.Message } finally { Close-QualificationLease `$lease; foreach(`$p in `$denied){ icacls `$p /remove:d '$account' | Out-Null } }
"@
    $out=& $HostExe -NoProfile -ExecutionPolicy Bypass -Command $script 2>&1 | Out-String
    $res=Checks ([ordered]@{admitted=($out -cmatch '(?m)^ADMITTED\r?$')})
    Row ('W-RP5b'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) $out.Trim()
    return $res
  } finally { $env:WRP_WITNESS=$null; Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-HandleNotName $null

# ---------- W-RP16: lpac scripts refuse on the elapsed deadline with zero writes.
foreach($pair in @(@('prepare-lpac-extension.ps1','Extension deadline elapsed'),@('complete-lpac-extension.ps1','Extension expired'))) {
  $box=New-Sandbox
  try {
    $before=Get-TreeManifest $box.Base
    $log=Join-Path $Out ('lpac-'+[guid]::NewGuid().ToString('N')+'.json')
    $argsFile=Join-Path $Out ('args-'+[guid]::NewGuid().ToString('N')+'.json'); [ordered]@{Account=$account;DesktopSid=$sid;ProfileRoot=$box.Profile;Extension=(Join-Path $box.Admitted 'extension-20260914-035100')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $argsFile
    & $HostExe -NoProfile -ExecutionPolicy Bypass -File $bootFile -Script (Join-Path $Repo "native\backup-age\$rmqName\$($pair[0])") -ArgsFile $argsFile -ProfileRoot $box.Profile -Account $account -Recorder '0' -OpsFile '' -Log $log | Out-Null
    $r=Get-Content -LiteralPath $log -Raw | ConvertFrom-Json
    Row ('W-RP16 '+$pair[0]) $(if($r.threw -eq $pair[1] -and (Get-TreeManifest $box.Base) -eq $before){'GREEN'}else{'RED'}) ('threw='+$r.threw)
  } finally { Remove-Sandbox $box }
}

# ---------- W-RP0a: real Task Scheduler, journey shape. The exact task name must be absent; it is never removed if pre-existing.
$sandboxRun=@'
param([string]$Manifest)
$ErrorActionPreference='Stop'
$spec=Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$env:TEMP=Join-Path $spec.root 'temp'; $env:TMP=$env:TEMP
[IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
foreach($entry in $spec.fixtureFiles.PSObject.Properties){ if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value){ throw 'fixture hash' } }
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedJob.cs')
. (Join-Path $PSScriptRoot 'dialogs.ps1')
$p=Start-Process -PassThru -Wait -WindowStyle Hidden -FilePath $spec.executable
'WRP0A-SANDBOX-RUN exit=' + $p.ExitCode
exit 0
'@
if(Get-ScheduledTask -TaskName $taskJourney -TaskPath '\' -ErrorAction SilentlyContinue) { Row 'W-RP0a' 'NOTRUN' 'exact task name already registered' }
elseif(((Get-CimInstance Win32_ComputerSystem).UserName) -ne $account) { Row 'W-RP0a' 'NOTRUN' 'runner account not logged on interactively' }
else {
  $box=New-Sandbox $sandboxRun; $tree=New-WorkTree $null
  try {
    $r=Invoke-Journey $box $tree $null
    $console=[IO.File]::ReadAllText((Join-Path $box.Admitted 'journey-console.log'))
    $ok=$r.outcome -eq 'LEASE-OK' -and $r.exit -eq 0 -and $console.Contains('WRP0A-SANDBOX-RUN')
    Row 'W-RP0a' $(if($ok){'GREEN'}else{'RED'}) ('outcome={0} exit={1} threw={2} console={3}' -f $r.outcome,$r.exit,$r.threw,$console.Length)
  } finally {
    if(Get-ScheduledTask -TaskName $taskJourney -TaskPath '\' -ErrorAction SilentlyContinue){ Unregister-ScheduledTask -TaskName $taskJourney -TaskPath '\' -Confirm:$false }
    Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue
  }
}

# ---------- W-RP7c (X3): the Start recorder plants version.dll beside the action and deletes it before SETTLE.
$plantOps=@'
@(
 { $f=Join-Path $env:WRP_ADM 'version.dll'; try { [IO.File]::WriteAllText($f,'x'); [IO.File]::Delete($f); 'p:0' } catch { 'p:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } }
)
'@
function Test-PlantDeleted([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder; $env:WRP_ADM=$box.Admitted
  try {
    $r=Invoke-Journey $box $tree $null -Recorder -Ops $plantOps
    $res=Checks ([ordered]@{planted=((@($r.ops) -join ',') -eq 'p:0');gone=!(Test-Path -LiteralPath (Join-Path $box.Admitted 'version.dll'));outcome=($r.outcome -eq 'LEASE-BROKEN');exitNonZero=($r.exit -ne 0);watchEvent=($r.stdout -match 'Change watch event')})
    Row ('W-RP7c'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('ops={0} outcome={1} exit={2} failed={3}' -f (@($r.ops) -join ','),$r.outcome,$r.exit,(Failed $res))
    return $res
  } finally { Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-PlantDeleted $null

# ---------- W-RP7c drain (Astra n4:625): L3 meets a completed notification the watch thread has not recorded yet.
# The witness-only delay holds the thread for 3 s after each completion; L3 must wait for it, never pass on an empty record.
function Test-WatchDrain([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant
  try {
    $env:WRP_WITNESS='1'
    $script=@"
`$ErrorActionPreference='Stop'
. '$tree\$rmqName\qualification-paths.ps1'
[MurageQualification.Lease]::WitnessWatchDelayMs=3000
`$lease=New-QualificationLease -Root '$($box.Profile)' -Directory '$($box.Admitted)'
try {
  Start-QualificationWatch `$lease
  Assert-QualificationLease `$lease
  'CLEAN'
  `$f=Join-Path '$($box.Admitted)' 'version.dll'; [IO.File]::WriteAllText(`$f,'x'); [IO.File]::Delete(`$f)
  try { Assert-QualificationLease `$lease; 'ADMITTED' } catch { 'BROKEN '+`$_.Exception.Message }
} finally { Close-QualificationLease `$lease }
"@
    $out=& $HostExe -NoProfile -ExecutionPolicy Bypass -Command $script 2>&1 | Out-String
    $res=Checks ([ordered]@{clean=($out -cmatch '(?m)^CLEAN\r?$');broken=($out -cmatch '(?m)^BROKEN Change watch event: <admitted>\\version\.dll\r?$')})
    Row ('W-RP7c drain'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) $out.Trim()
    return $res
  } finally { $env:WRP_WITNESS=$null; Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-WatchDrain $null

# ---------- W-RP14 rollback (native, Astra n4:625): RESERVE refused at the last task log removes this run's files by handle.
function Test-ReserveRollback([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant
  try {
    $script=@"
`$ErrorActionPreference='Stop'
. '$tree\$rmqName\qualification-paths.ps1'
`$lease=New-QualificationLease -Root '$($box.Profile)' -Directory '$($box.Admitted)'
try {
  Test-QualificationOutputs `$lease -Outputs @('wrp-o1.txt','wrp-o2.txt') -TaskLogs @('wrp-t1.log','wrp-t2.log')
  [IO.File]::WriteAllText((Join-Path '$($box.Admitted)' 'wrp-t2.log'),'planted')
  try { Reserve-QualificationOutputs `$lease; 'RESERVED' } catch { 'REFUSED '+`$_.Exception.Message }
} finally { Close-QualificationLease `$lease }
"@
    $out=& $HostExe -NoProfile -ExecutionPolicy Bypass -Command $script 2>&1 | Out-String
    $left=@('wrp-o1.txt','wrp-o2.txt','wrp-t1.log' | Where-Object { Test-Path -LiteralPath (Join-Path $box.Admitted $_) })
    $planted=[IO.File]::ReadAllText((Join-Path $box.Admitted 'wrp-t2.log'))
    $res=Checks ([ordered]@{refused=($out -cmatch '(?m)^REFUSED REFUSED-RESERVE: Output name already exists: <admitted>\\wrp-t2\.log\r?$');left0=($left.Count -eq 0);plantedKept=($planted -eq 'planted')})
    Row ('W-RP14 rollback native'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('left={0} planted={1} failed={2} {3}' -f ($left -join ','),$planted,(Failed $res),$out.Trim())
    return $res
  } finally { Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-ReserveRollback $null

# ---------- W-RP11 (recorder start, real job): the registrar is killed after binding; the job close ends the action tree.
function Test-LauncherLoss([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder; $actionPid=$null; $registrar=$null
  $id=[guid]::NewGuid().ToString('N'); $pidFile=Join-Path $Out "pid-$id.txt"; $log=Join-Path $Out "run-$id.json"; $argsFile=Join-Path $Out "args-$id.json"
  [ordered]@{Account=$account;DesktopSid=$sid;ProfileRoot=$box.Profile;Parent=$box.Admitted;ManifestSha256=$box.ManifestSha;DeadlineUtc=[DateTime]::UtcNow.AddMinutes(15).ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $argsFile
  $env:WRP_PIDFILE=$pidFile; $env:WRP_ACTION_SECONDS='120'
  try {
    $q={ param($v) '"'+$v+'"' }
    $registrar=Start-Process -PassThru -WindowStyle Hidden -FilePath $HostExe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(& $q $bootFile),'-Script',(& $q (Join-Path $tree "$rmqName\register-journey.ps1")),'-ArgsFile',(& $q $argsFile),'-ProfileRoot',(& $q $box.Profile),'-Account',(& $q $account),'-Recorder','1','-Log',(& $q $log))
    $until=(Get-Date).AddSeconds(90); while(!(Test-Path -LiteralPath $pidFile) -and (Get-Date) -lt $until){ Start-Sleep -Milliseconds 250 }
    if(!(Test-Path -LiteralPath $pidFile)){ Stop-Process -Id $registrar.Id -Force -ErrorAction SilentlyContinue; $res=Checks ([ordered]@{launched=$false}); Row ('W-RP11 recorder start'+$(if($Mutant){' mutant '+$Mutant})) 'RED' 'action never launched'; return $res }
    $actionPid=[int](Get-Content -LiteralPath $pidFile -Raw)
    Start-Sleep -Seconds 15
    $swap=try { [IO.File]::Delete((Join-Path $box.Admitted 'fixture\OwnedJob.cs')); 'c:0' } catch { 'c:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) }
    Stop-Process -Id $registrar.Id -Force
    $gone=$false; $until=(Get-Date).AddSeconds(10)
    while((Get-Date) -lt $until){ if(!(Get-Process -Id $actionPid -ErrorAction SilentlyContinue)){ $gone=$true; break }; Start-Sleep -Milliseconds 250 }
    # LOST: RESERVE created journey-lease.txt empty and nothing wrote the receipt.
    $receiptFile=Join-Path $box.Admitted 'journey-lease.txt'
    $receiptBytes=if(Test-Path -LiteralPath $receiptFile){ (Get-Item -LiteralPath $receiptFile).Length }else{ -1 }
    $res=Checks ([ordered]@{launched=$true;treeGone=$gone;swap=($swap -eq 'c:32');receiptEmpty=($receiptBytes -eq 0);noBootLog=!(Test-Path -LiteralPath $log)})
    Row ('W-RP11 recorder start'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('treeGone={0} swap={1} receiptBytes={2} bootLog={3} failed={4}' -f $gone,$swap,$receiptBytes,(Test-Path -LiteralPath $log),(Failed $res))
    return $res
  } finally {
    if($registrar){ Stop-Process -Id $registrar.Id -Force -ErrorAction SilentlyContinue }
    if($actionPid){ Stop-Process -Id $actionPid -Force -ErrorAction SilentlyContinue }
    $env:WRP_PIDFILE=$null; $env:WRP_ACTION_SECONDS=$null
    Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue
  }
}
$null=Test-LauncherLoss $null

# ---------- W-RP12 delayed start: (i) Ready 20 s then Running; swaps 10 s into the delay are denied, LEASE-OK; (ii) never starts.
function Test-DelayedStart([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder; $env:WRP_ADM=$box.Admitted; $env:WRP_START_DELAY='20'
  $delayOps=Join-Path $Out ('delayops-'+[guid]::NewGuid().ToString('N')+'.ps1'); Set-Content -LiteralPath $delayOps -Value $swapOps; $env:WRP_DELAY_OPS=$delayOps
  try {
    $r=Invoke-Journey $box $tree $null -Recorder
    $res=Checks ([ordered]@{ops=((@($r.ops) -join ',') -eq 'delay a:32,delay b:32,delay c:32,delay f:32');outcome=($r.outcome -eq 'LEASE-OK');exit0=($r.exit -eq 0)})
    Row ('W-RP12 (i)'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('ops={0} outcome={1} exit={2} failed={3}' -f (@($r.ops) -join ','),$r.outcome,$r.exit,(Failed $res))
    return $res
  } finally { $env:WRP_START_DELAY=$null; $env:WRP_DELAY_OPS=$null; Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }
}
$null=Test-DelayedStart $null
$box=New-Sandbox; $tree=New-WorkTree $null -Recorder; $env:WRP_START_DELAY='never'
try {
  $r=Invoke-Journey $box $tree $null -Recorder
  $ok=$r.outcome -eq 'NOT-STARTED' -and $r.exit -ne 0 -and @($r.calls) -contains 'MUT disable' -and @($r.calls) -contains 'MUT unregister'
  Row 'W-RP12 (ii)' $(if($ok){'GREEN'}else{'RED'}) ('outcome={0} exit={1} calls={2}' -f $r.outcome,$r.exit,(@($r.calls) -join ','))
} finally { $env:WRP_START_DELAY=$null; Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue }

# ---------- W-RP13 deadline with stop pending: Stop is pending 20 s; swaps after Stop returned are denied until settled.
# The first stop op reads the watchdog before any swap runs: a swap that succeeds (M14) moves the directory, so the
# post-run path can no longer prove the write happened (ASTRA 5cdb72c73a). 'w:1' = written with the watchdog text.
$watchdogProbe=@'
@(
 { $f=Join-Path $env:WRP_ADM 'journey-watchdog.txt'; try { $s=[IO.FileStream]::new($f,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite, Delete'); try { $t=[IO.StreamReader]::new($s).ReadToEnd() } finally { $s.Dispose() }; 'w:'+[int]$t.StartsWith('Outer watchdog stopped the exact task') } catch { 'w:'+(($_.Exception.InnerException,$_.Exception -ne $null)[0].HResult -band 0xFFFF) } }
)
'@
function Test-StopPending([string]$Mutant) {
  $box=New-Sandbox; $tree=New-WorkTree $Mutant -Recorder; $env:WRP_ADM=$box.Admitted
  $stopOps=Join-Path $Out ('stopops-'+[guid]::NewGuid().ToString('N')+'.ps1'); Set-Content -LiteralPath $stopOps -Value ($watchdogProbe.Trim()+' + '+$swapOps.Trim())
  $env:WRP_ACTION_SECONDS='600'; $env:WRP_STOP_PENDING='20'; $env:WRP_STOP_OPS=$stopOps
  try {
    $r=Invoke-Journey $box $tree @{DeadlineUtc=[DateTime]::UtcNow.AddSeconds(150).ToString('o')} -Recorder
    $watchdog=Join-Path $box.Admitted 'journey-watchdog.txt'
    $ops=@($r.ops)
    $res=Checks ([ordered]@{stopCalled=(@($r.calls) -contains 'MUT stop');watchdog=($ops.Count -gt 0 -and $ops[0] -eq 'stop w:1');ops=((@($ops | Select-Object -Skip 1) -join ',') -eq 'stop a:32,stop b:32,stop c:32,stop f:32');outcome=($r.outcome -eq 'LEASE-OK');watchdogKept=(Test-Path -LiteralPath $watchdog)}) ($ops -join ',')
    Row ('W-RP13'+$(if($Mutant){' mutant '+$Mutant})) $(if($res.ok){'GREEN'}else{'RED'}) ('ops={0} outcome={1} exit={2} watchdogKept={3} failed={4}' -f ($ops -join ','),$r.outcome,$r.exit,(Test-Path -LiteralPath $watchdog),(Failed $res))
    return $res
  } finally {
    $env:WRP_ACTION_SECONDS=$null; $env:WRP_STOP_PENDING=$null; $env:WRP_STOP_OPS=$null
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($box.Admitted) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Sandbox $box; Remove-Item -Recurse -Force -LiteralPath $tree -ErrorAction SilentlyContinue
  }
}
$null=Test-StopPending $null

# Rows the harness does not drive yet: reported as NOT RUN so they can never read as a pass.
foreach($id in 'W-RP0b1','W-RP0b2','W-RP7b','W-RP8d','W-RP10','W-RP11 real scheduler','W-RP14 native order','W-RP15 native','W-RP6 8.3'){ Row $id 'NOTRUN' 'not driven by this harness revision (NATIVE-PENDING)' }

# ---------- Mutants: each applied alone must turn its named witness RED.
if($Mutants) {
  # KILLED only when the targeted check failed and every check the mutant must pass through held (MAIN 11-21 receipts):
  # a throw is SETUP-FAILED, any other failure pattern is OFF-TARGET; both count red like SURVIVED.
  # -Observed pins the path: the witness detail (the refusal text) must match it, so a RED by any other route is OFF-TARGET.
  function Mutant([string]$Id,[string]$Target,[string[]]$Reached,[scriptblock]$Witness,[string]$Observed){
    try { $res=& $Witness } catch { Row ('MUTANT '+$Id) 'SETUP-FAILED' ('target={0} error={1}' -f $Target,$_.Exception.Message); return }
    if($null -eq $res){ Row ('MUTANT '+$Id) 'NOTRUN' ('target='+$Target); return }
    $hit=$res.checks.Contains($Target) -and $res.checks[$Target] -eq $false
    # A reached name '!x' means check x must have failed (a refusal mutant must let the journey mutate: '!mutations0').
    $passed=@($Reached | Where-Object { $n=$_.TrimStart('!'); !$res.checks.Contains($n) -or ($res.checks[$n] -eq $_.StartsWith('!')) }).Count -eq 0
    $onPath=!$Observed -or ([string]$res.detail -cmatch $Observed)
    Row ('MUTANT '+$Id) $(if($res.ok){'SURVIVED'}elseif($hit -and $passed -and $onPath){'KILLED'}else{'OFF-TARGET'}) ('target={0} reached={1} failed={2} observed={3}' -f $Target,($Reached -join ','),(Failed $res),$res.detail)
  }
  Mutant 'M1' 'class' @('!mutations0') { Test-Refusal 'W-RP1 Temp' $junctionCases['W-RP1 Temp'] 'Reparse point on admitted path' 'M1' }
  Mutant 'M2' 'class' @('!mutations0') { Test-Refusal 'W-RP2 admitted' $junctionCases['W-RP2 admitted'] 'Reparse point on admitted path' 'M2' }
  Mutant 'M3' 'class' @('!mutations0') { Test-Refusal 'W-RP4 fixture\OwnedJob.cs' { param($b) New-Item -ItemType HardLink -Path (Join-Path $b.Outside 'l') -Target (Join-Path $b.Admitted 'fixture\OwnedJob.cs') | Out-Null } 'Hardlinked file refused' 'M3' }
  Mutant 'M3b' 'outcome' @('e2','exeSame') { Test-HardlinkDuringRun 'M3b' }
  Mutant 'M4a' 'class' @('!mutations0') { Test-Refusal 'W-RP5a fixture\OwnedJob.cs' { param($b) Add-Content -LiteralPath (Join-Path $b.Admitted 'fixture\OwnedJob.cs') -Value '//' } 'Pinned file hash mismatch' 'M4a' }
  Mutant 'M4b' 'admitted' @() { Test-HandleNotName 'M4b' }
  Mutant 'M5' 'class' @('!mutations0') { Test-Refusal 'W-RP6 subst' { param($b) $d='W:'; cmd /c subst $d $b.Base | Out-Null; $b.Profile=$d+'\Users\fixture'; $b.Admitted=$d+$b.Admitted.Substring($b.Base.Length) } 'Final path mismatch on admitted path' 'M5' }
  cmd /c subst W: /d 2>$null | Out-Null
  # M6a removes the admission check; RESERVE (CREATE_NEW, before REGISTER) still refuses, so the class changes with zero
  # scheduler calls and the tree restored. KILLED only by that path: the refusal must be REFUSED-RESERVE on the planted name.
  Mutant 'M6a' 'class' @('mutations0','treeSame') -Observed '^REFUSED-RESERVE: Output name already exists: <admitted>\\journey-console\.log$' { Test-Refusal 'W-RP7a hardlink journey-console.log' { param($b) $t=Join-Path $b.Outside 't'; [IO.File]::WriteAllText($t,'o'); New-Item -ItemType HardLink -Path (Join-Path $b.Admitted 'journey-console.log') -Target $t | Out-Null } 'Output name already exists' 'M6a' }
  Mutant 'M6d' 'class' @('!mutations0') { Test-Refusal 'W-RP7d version.dll' { param($b) [IO.File]::WriteAllText((Join-Path $b.Admitted 'version.dll'),'x') } 'Planted code refused' 'M6d' }
  Mutant 'M7' 'leased' @('control') { Test-Swaps 'M7' }
  Mutant 'M7d' 'leased' @('control') { Test-Swaps 'M7d' }
  Mutant 'M6c' 'watchEvent' @('planted','gone') { Test-PlantDeleted 'M6c' }
  Mutant 'M6e' 'broken' @('clean') { Test-WatchDrain 'M6e' }
  Mutant 'M12' 'treeGone' @('launched','swap') { Test-LauncherLoss 'M12' }
  Mutant 'M13' 'outcome' @() { Test-DelayedStart 'M13' }
  # M14: the watchdog probe runs before the swaps, so a successful swap can only fail 'ops' (watchdogKept is not required).
  # KILLED only by the early release itself: the admitted-directory rename right after the probe must have succeeded.
  Mutant 'M14' 'ops' @('stopCalled','watchdog') -Observed '^stop w:1,stop a:0(,|$)' { Test-StopPending 'M14' }
  Mutant 'M21n' 'left0' @('refused','plantedKept') { Test-ReserveRollback 'M21n' }
  Mutant 'M8' 'class' @('!mutations0') { Test-Refusal 'W-RP9' { param($b) cmd /c fsutil file setCaseSensitiveInfo $b.Admitted enable 2>&1 | Out-Null; if($LASTEXITCODE){ return 'NOT RUN: case-sensitive flag unavailable' } } 'Case-sensitive directory refused' 'M8' }
}

$results | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $Out 'native-witnesses.json')
# A witness row run under a mutant ('<id> mutant Mx') is expected RED; its MUTANT row carries the verdict.
$red=@($results | Where-Object { $_.status -in 'RED','SURVIVED','OFF-TARGET','SETUP-FAILED' -and $_.id -cnotmatch ' mutant M' }).Count
Write-Output ('NATIVE SUMMARY green={0} red={1} notrun={2} killed={3}' -f @($results | Where-Object status -eq 'GREEN').Count,$red,@($results | Where-Object status -eq 'NOTRUN').Count,@($results | Where-Object status -eq 'KILLED').Count)
if($red){ exit 1 }
