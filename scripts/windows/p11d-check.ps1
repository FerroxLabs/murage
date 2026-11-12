# Isolated Linux fixtures for the fixed production dispatch paths.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'ownership.ps1')
function Check([bool]$ok,[string]$name){if(-not $ok){throw "ASSERTION: $name"};Write-Host "PASS $name"}
$prefix='MurageCI-'+('d'*32)+'-'
$old=[pscustomobject]@{id='existing'}
$own=[pscustomobject]@{id=($prefix+'new')}
$unrelated=[pscustomobject]@{id='unrelated-new'}
$script:rows=@($old,$own,$unrelated);$script:deleted=@();$script:registrations=0
function Get-TaskSnapshot {$script:rows}
function Remove-SnapshotTask($item) {
 $script:deleted+=,$item.id
 $script:rows=@($script:rows | Where-Object {$_.id -ne $item.id})
}
function Get-RegistrationSnapshot {$script:registrations++;@()}
$result=Complete-SnapshotDiff @($old) $prefix -Surface Tasks
Check (($script:deleted -join ',') -eq $own.id -and $result.remaining.Count -eq 2 -and -not $result.ok) 'fixed task dispatch deletes only new owned task; preserves unrelated task and fails'
$script:rows=@($old)
$result=Complete-OwnershipSnapshot @{tasks=@($old);kind='desktop';registrations=@()} $prefix
Check ($result.ok -and $script:registrations -eq 0) 'fixed Desktop dispatch never enumerates registrations'
$result=Complete-OwnershipSnapshot @{tasks=@($old);kind='handoff';registrations=@()} $prefix
Check ($result.ok -and $script:registrations -eq 2) 'fixed Handoff dispatch enumerates and reads back registrations'
$result=Compare-ProcessSnapshot @() @(@{id='new';path='unknown.exe'}) '' $false
Check (-not $result.ok -and $result.escaped.Count -eq 1) 'production process comparison reports escape without executing a callback'

. (Join-Path $PSScriptRoot 'native-broker.ps1')
Initialize-OwnedProcess
function Assert-GatePath($path){$path}
$script:nativeCalls=0
function Invoke-OwnedNative($File,$Arguments,$TimeoutSeconds,$ProofTimeoutMilliseconds) {
 $script:nativeCalls++
 Check ($TimeoutSeconds -ge 25 -and $TimeoutSeconds -le 30 -and $ProofTimeoutMilliseconds -eq 2000) 'fixed broker clock supplies bounded owned-helper timeout'
 throw 'fixture native boundary reached'
}
$directory=Join-Path ([IO.Path]::GetTempPath()) ('p11d-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($directory)
$previousRoot=$env:SystemRoot;$env:SystemRoot='/fixture'
try {
 $id=[Guid]::NewGuid().ToString()
 @{id=$id;file='/fixture/System32/WindowsPowerShell/v1.0/powershell.exe';args=@();deadlineAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+30000)} |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory ($id+'.request.json'))
 Invoke-NativeBrokerRequest -Directory $directory
 $response=Get-Content -LiteralPath (Join-Path $directory ($id+'.response.json')) -Raw | ConvertFrom-Json
 Check ($script:nativeCalls -eq 1 -and $response.error -like '*fixture native boundary reached*' -and $null -eq $response.proof) 'fixed broker records native failure without inventing job proof'
}finally{$env:SystemRoot=$previousRoot;Remove-Item -LiteralPath $directory -Recurse -Force}
