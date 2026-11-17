$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'owned-process.ps1')
. (Join-Path $PSScriptRoot 'ownership.ps1')
function Check([bool]$ok,[string]$name){if(-not $ok){throw "ASSERTION: $name"};Write-Host "PASS $name"}
$oldRoot=$env:SystemRoot;$env:SystemRoot='/fixture';$script:calls=0
function Invoke-OwnedNative($File,$Arguments,$TimeoutSeconds,$ProofTimeoutMilliseconds) {
 $script:calls++
 Check ($TimeoutSeconds -le 58 -and $TimeoutSeconds -ge 55 -and $ProofTimeoutMilliseconds -eq 2000) 'snapshot worker execution plus empty proof fits 60-second deadline'
 Check ($Arguments -match '"-Output" "([^"]+)"') 'snapshot worker has explicit result file'
 @{value=@{ok=$true;marker='fake Scheduler worker'}} | ConvertTo-Json | Set-Content -LiteralPath $Matches[1]
 @{ExitCode=0;Stdout='';Stderr=''}
}
try {
 $result=Invoke-OwnershipDeadline -Operation TaskDiff -Payload @{before=@();prefix=('MurageCI-'+('a'*32)+'-')} -Deadline ([DateTime]::UtcNow.AddSeconds(60))
 Check ($result.ok -and $result.marker -eq 'fake Scheduler worker') 'deadline wrapper reads isolated worker result'
 $failure='';try{Invoke-OwnershipDeadline -Operation Processes -Payload @{} -Deadline ([DateTime]::UtcNow.AddSeconds(-1))}catch{$failure=$_.Exception.Message}
 Check ($failure -like '*deadline exhausted*' -and $script:calls -eq 1) 'expired cleanup never starts a native worker'
 function Invoke-OwnedNative {throw 'owned timeout after job empty proof'}
 $failure='';try{Invoke-OwnershipDeadline -Operation TaskDiff -Payload @{} -Deadline ([DateTime]::UtcNow.AddSeconds(60))}catch{$failure=$_.Exception.Message}
 Check ($failure -eq 'owned timeout after job empty proof') 'worker timeout propagates without an unbounded fallback'
}finally{$env:SystemRoot=$oldRoot}
