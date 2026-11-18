$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'ownership.ps1')
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
$prefix='MurageCI-'+('a'*32)+'-'
function Row([string]$Id,[string]$Action='unchanged') {[pscustomobject]@{id=$Id;name=$Id;author='fixture';actions=$Action}}
function Check([bool]$Condition,[string]$Name) {if(-not $Condition){throw "ASSERTION: $Name"};"PASS $Name"}
$script:deleted=@()
$enumerate={@($script:rows)}
$delete={param($item) $script:deleted+=,$item.id;$script:rows=@($script:rows | Where-Object {$_.id -ne $item.id})}
$base=@((Row '\existing'),(Row ('\'+$prefix+'preexisting')))
$script:rows=@($base)+(Row ('\nested\'+$prefix+'new'))
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete
Check ($result.ok -and $script:deleted.Count -eq 1 -and $script:rows.Count -eq 2) 'new prefixed task cleaned; preexisting prefixed task preserved'
$script:deleted=@();$script:rows=@($base)+(Row '\unprefixed-new')
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete
Check (-not $result.ok -and $script:deleted.Count -eq 0 -and $script:rows.Count -eq 3) 'unprefixed new task FAIL and never deleted'
$script:rows=@($base)+(Row ('\other-'+$prefix+'suffix'))
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete
Check (-not $result.ok -and $script:deleted.Count -eq 0) 'prefix substring is not ownership'
$script:rows=@((Row '\existing' 'changed'),$base[1])
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete
Check (-not $result.ok -and $result.changed.Count -eq 1) 'existing action modification FAIL'
$script:rows=@($base[0]);$result=Complete-SnapshotDiff $base $prefix $enumerate $delete
Check (-not $result.ok -and $result.removed.Count -eq 1) 'existing task removal FAIL'
$script:rows=@($base)+(Row ('\'+$prefix+'orphan'))
$result=Complete-SnapshotDiff $base $prefix $enumerate {param($item)}
Check (-not $result.ok) 'no-op deletion FAIL on final enumeration'
$result=Complete-SnapshotDiff $base $prefix $enumerate {throw 'denied'}
Check (-not $result.ok) 'delete error FAIL'
$failed=$false;try{Complete-SnapshotDiff $base $prefix {throw 'denied'} $delete}catch{$failed=$true}
Check $failed 'snapshot enumeration error FAIL'
$script:rows=@($base)+(Row ('\'+$prefix+'timeout'))
try {throw 'simulated killed child'}catch{}finally{$result=Complete-SnapshotDiff $base $prefix $enumerate $delete}
Check ($result.ok -and $script:rows.Count -eq 2) 'outer cleanup after child timeout'
$packaged='C:\fixture\app\Murage.exe'
function SentinelRow([string]$Id,[string]$Command=$packaged,[string]$Arguments='--murage-sentinel-scan C:\scan.js C:\descriptor.json --once',[int]$Count=1) {
  $exec=('<Exec><Command>'+[Security.SecurityElement]::Escape($Command)+'</Command><Arguments>'+[Security.SecurityElement]::Escape($Arguments)+'</Arguments></Exec>')*$Count
  [pscustomobject]@{id=$Id;name=$Id;author='fixture';actions=$exec;definition=('<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Actions Context="Author">'+$exec+'</Actions></Task>')}
}
$production='\FerroxLabs\Murage\Sentinel\'+('0123456789abcdef'*2)
$script:deleted=@();$script:rows=@($base)+(SentinelRow $production)
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged
Check ($result.ok -and $script:deleted.Count -eq 1 -and $script:deleted[0] -ceq $production -and $script:rows.Count -eq 2) 'new unprefixed Sentinel task of the packaged executable cleaned'
$script:deleted=@();$script:rows=@($base)+(SentinelRow $production)
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete
Check (-not $result.ok -and $script:deleted.Count -eq 0) 'unprefixed Sentinel task preserved without the packaged executable'
foreach($case in @(
  @{name='other executable';row=(SentinelRow $production 'C:\other\Murage.exe')},
  @{name='no scan flag';row=(SentinelRow $production $packaged 'C:\scan.js')},
  @{name='second action';row=(SentinelRow $production $packaged '--murage-sentinel-scan C:\scan.js' 2)},
  @{name='other folder';row=(SentinelRow ('\FerroxLabs\Murage\'+('0123456789abcdef'*2)))},
  @{name='suffixed id';row=(SentinelRow ($production+'x'))},
  @{name='no definition';row=(Row $production)}
)) {
  $script:deleted=@();$script:rows=@($base)+$case.row
  $result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged
  Check (-not $result.ok -and $script:deleted.Count -eq 0) ('unprefixed Sentinel task preserved: '+$case.name)
}
$withProduction=@($base)+(SentinelRow $production)
$script:deleted=@();$script:rows=@($withProduction)
$result=Complete-SnapshotDiff $withProduction $prefix $enumerate $delete -OwnedExecutable $packaged
Check ($result.ok -and $script:deleted.Count -eq 0 -and $script:rows.Count -eq 3) 'pre-existing Sentinel task never deleted'
$script:deleted=@();$script:rows=@($base)+(SentinelRow $production)
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -Surface Registrations -OwnedExecutable $packaged
Check (-not $result.ok -and $script:deleted.Count -eq 0) 'owned Sentinel rule is tasks only'
# The shipped registration starts its own task once, outside the run's job. The finalizer ends that exact task through the
# Scheduler and requires idle before it deletes; a scanner that outlives End is preserved and fails the run.
$script:clock=[DateTime]::new(2026,1,1,0,0,0,[DateTimeKind]::Utc)
function SentinelOps([scriptblock]$End) {
  @{Disable={param($item) $script:log+='disable '+$item.id};Running={param($item) $script:log+='running';$script:running};End=$End
    Sleep={param($ms) $script:clock=$script:clock.AddMilliseconds($ms)};Now={$script:clock}}
}
$script:log=@();$script:running=$true;$script:deleted=@();$script:rows=@($base)+(SentinelRow $production)
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged -OwnedTaskOps (SentinelOps {param($item) $script:log+='end '+$item.id;$script:running=$false})
Check ($result.ok -and $script:deleted.Count -eq 1 -and $script:deleted[0] -ceq $production -and ($script:log -join ',') -ceq ('disable '+$production+',running,end '+$production+',running')) 'startup scanner outside the job: owned Sentinel task disabled, ended, idle, then deleted'
$script:log=@();$script:running=$false;$script:deleted=@();$script:rows=@($base)+(SentinelRow $production)
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged -OwnedTaskOps (SentinelOps {param($item) $script:log+='end'})
Check ($result.ok -and $script:deleted.Count -eq 1 -and ($script:log -join ',') -ceq ('disable '+$production+',running')) 'idle owned Sentinel task disabled and deleted without End'
$script:log=@();$script:running=$true;$script:deleted=@();$script:rows=@($base)+(SentinelRow $production);$started=$script:clock
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged -OwnedTaskOps (SentinelOps {param($item) $script:log+='end'})
Check (-not $result.ok -and $script:deleted.Count -eq 0 -and $script:rows.Count -eq 3 -and @($script:log | Where-Object {$_ -ceq 'end'}).Count -eq 1 -and @($result.errors | Where-Object {$_ -like '*still running*preserved*'}).Count -eq 1 -and ($script:clock-$started).TotalSeconds -ge 20 -and ($script:clock-$started).TotalSeconds -le 21) 'crash: scanner that outlives End is preserved, never deleted, run FAIL at the deadline'
$script:log=@();$script:running=$true;$script:deleted=@();$script:rows=@($base)+(SentinelRow $production)
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged -OwnedTaskOps (SentinelOps {throw 'end denied'})
Check (-not $result.ok -and $script:deleted.Count -eq 0 -and @($result.errors | Where-Object {$_ -like '*end denied*'}).Count -eq 1) 'Scheduler End error FAIL and task preserved'
$script:log=@();$script:running=$true;$script:deleted=@();$script:rows=@($base)+(SentinelRow $production 'C:\other\Murage.exe')+(Row '\unprefixed-new')
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged -OwnedTaskOps (SentinelOps {param($item) $script:log+='end'})
Check (-not $result.ok -and $script:deleted.Count -eq 0 -and $script:log.Count -eq 0) 'a task that is not the owned Sentinel task is never disabled or ended'
$script:log=@();$script:running=$true;$script:deleted=@();$script:rows=@($base)+(Row ('\'+$prefix+'sentinel-run'))
$result=Complete-SnapshotDiff $base $prefix $enumerate $delete -OwnedExecutable $packaged -OwnedTaskOps (SentinelOps {param($item) $script:log+='end'})
Check ($result.ok -and $script:deleted.Count -eq 1 -and $script:log.Count -eq 0) 'prefixed job-joined copies are never ended by the Scheduler'
function Get-TaskSnapshot {@()}
function Get-RegistrationSnapshot {throw 'Desktop touched registry'}
$s=Get-OwnershipSnapshot desktop
Check ($s.registrations.Count -eq 0) 'Desktop skips installer registrations'
$r=Complete-OwnershipSnapshot $s $prefix
Check ($r.ok -and $null -eq $r.registrations) 'Desktop cleanup skips installer registrations'
$failed=$false;try{Assert-RegistrationHost}catch{$failed=$true}
Check $failed 'installer registry refuses nongate host'
$before=@(@{id='1|old';pid=1;path='browser.exe'})
$after=@($before)+@(@{id='2|new';pid=2;path='escaped.exe'})
$r=Compare-ProcessSnapshot $before $after '' $false {param($p) $false}
Check (-not $r.ok -and $r.escaped.Count -eq 1) 'escaped process reported without a kill callback'
$r=Compare-ProcessSnapshot $before $after 'escaped.exe' $false {param($p) $false}
Check (-not $r.ok) 'Desktop never admits an external browser survivor'
$r=Compare-ProcessSnapshot $before $after 'escaped.exe' $true {param($p) $false}
Check ($r.ok -and $r.browsers.Count -eq 1) 'gate HTTPS browser survivor recorded'
$r=Compare-ProcessSnapshot $before $after '' $false {param($p) $true}
Check ($r.ok -and $r.enrolled.Count -eq 1) 'job membership checked before escape classification'
