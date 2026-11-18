$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'ownership.ps1')
. (Join-Path $PSScriptRoot 'owned-process.ps1')
function Check([bool]$Condition,[string]$Name) {if(-not $Condition){throw "ASSERTION: $Name"};"PASS $Name"}
$prefix='MurageCI-'+('a'*32)+'-'
$item=[pscustomobject]@{id=('\'+$prefix+'wrapper');state=4}
$script:events=@();$script:present=$true;$script:tries=0;$script:seconds=151
$end={param($id) $script:events+='end'}
$empty={ $script:events+='empty';$true }
$unregister={param($id) $script:events+='unregister';$script:tries++;$script:present=$false}
$read={param($id) $script:events+='read';$script:present}
$sleep={param($ms) $script:seconds+=$ms/1000}
$now={ [DateTime]::UnixEpoch.AddSeconds($script:seconds) }
function Cleanup([scriptblock]$Remove=$unregister,[scriptblock]$Empty=$empty) {
 Remove-WrapperTask -Item $item -Prefix $prefix -Before @() -End $end -Empty $Empty -Unregister $Remove -ReadBack $read -Sleep $sleep -Now $now
}
# Reviewer's exact witness: TimeoutSeconds=60 + 90s launcher allowance; CIM
# still blocked at t=151. Virtual time avoids pretending Linux runs Scheduler.
Check ($script:seconds -gt (60+90) -and $item.state -eq 4) 'witness: TimeoutSeconds 60; prelaunch CIM delayed beyond 150 seconds'
Cleanup
Check (-not $script:present -and ($script:events -join ',') -eq 'end,empty,unregister,read') 'running wrapper ended, job empty, unregistered, absence read back in order'
$script:present=$true;$script:events=@();$script:tries=0
Cleanup {param($id) $script:tries++;if($script:tries -lt 3){throw 'busy'};$script:present=$false}
Check (-not $script:present -and $script:tries -eq 3) 'transient unregister failures retried'
$script:present=$true;$script:tries=0;$script:seconds=151;$failure=''
try {Cleanup {param($id) $script:tries++}}catch{$failure=$_.Exception.Message}
Check ($script:tries -eq 5 -and $script:seconds -le 211 -and $failure.Contains($item.id) -and $failure.Contains('Unregister-ScheduledTask -TaskPath')) 'five bounded tries; persistent wrapper FAIL names exact path and removal command'
$script:present=$true;$script:tries=0;$failure=''
try {Cleanup -Empty {$false}}catch{$failure=$_.Exception.Message}
Check ($failure -ne '' -and $script:tries -eq 0 -and $script:present) 'nonempty job fails before unregister'
$script:events=@();$failure=''
try {Remove-WrapperTask -Item $item -Prefix $prefix -Before @($item) -End $end -Empty $empty -Unregister $unregister -ReadBack $read -Sleep $sleep -Now $now}catch{$failure=$_.Exception.Message}
Check ($failure -ne '' -and $script:events.Count -eq 0) 'preexisting prefixed task untouched'
$failure='';$other=[pscustomobject]@{id='\unrelated';state=4}
try {Remove-WrapperTask -Item $other -Prefix $prefix -Before @() -End $end -Empty $empty -Unregister $unregister -ReadBack $read -Sleep $sleep -Now $now}catch{$failure=$_.Exception.Message}
Check ($failure -ne '' -and $script:events.Count -eq 0) 'unprefixed task untouched'
$script:seconds=151;$script:events=@();$failure=''
try {
 Remove-WrapperTask -Item $item -Prefix $prefix -Before @() -End {param($id) $script:seconds+=5} -Empty {param($budget) $script:events+='empty';$script:seconds+=$budget/1000;throw 'job timeout'} -Unregister $unregister -ReadBack $read -Sleep $sleep -Now $now
}catch{$failure=$_.Exception.Message}
Check ($failure -ne '' -and $script:seconds -le 211 -and $script:events.Count -eq 5) 'end plus five job timeouts and backoff stay within 60 seconds'
$oldRoot=$env:SystemRoot;$env:SystemRoot='/fixture'
function Invoke-OwnedNative([string]$File,[string]$Arguments,[int]$TimeoutSeconds,[int]$ProofTimeoutMilliseconds) {
 $script:rpcBudgetOk=$TimeoutSeconds -le 3 -and $ProofTimeoutMilliseconds -eq 2000
 $script:command=$Arguments
 @{ExitCode=0;Stdout='0';Stderr=''}
}
try {
 $absent=Invoke-WrapperScheduler ReadBack $item.id ([DateTime]::UtcNow.AddSeconds(60))
 Check $script:rpcBudgetOk 'Scheduler RPC bounded in owned helper including proof budget'
 Check (-not $absent -and $script:command.Contains('Get-ScheduledTask') -and $script:command.Contains('-ieq')) 'absence requires successful full root task enumeration'
 $failure='';try {Invoke-WrapperScheduler End $item.id ([DateTime]::UtcNow.AddSeconds(-1))}catch{$failure=$_.Exception.Message}
 Check ($failure -like '*deadline exhausted*') 'no Scheduler process starts after cleanup budget expires'
}finally{$env:SystemRoot=$oldRoot}
function Invoke-OwnedNative([string]$File,[string]$Arguments,[int]$TimeoutSeconds) {
 Check ($File -eq 'schtasks.exe' -and $TimeoutSeconds -eq 30) 'schtasks operation over 30 seconds receives owned helper deadline'
 throw 'Owned job terminated and proved empty at timeout (fake native boundary)'
}
$failure='';try {Invoke-WindowsNative 'schtasks.exe' @('/Query','/TN','space here')}catch{$failure=$_.Exception.Message}
Check ($failure -like 'Owned job terminated*') 'native timeout propagates failure through owned helper'
