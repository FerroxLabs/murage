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
