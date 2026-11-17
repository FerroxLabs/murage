# Actual broker -> Invoke-OwnedNative -> C# timeout; Win32 APIs are Linux fakes.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'owned-process.ps1')
. (Join-Path $PSScriptRoot 'native-broker.ps1')
Initialize-OwnedProcess
$resolver=[Runtime.InteropServices.DllImportResolver]{param($name,$assembly,$path)
  if($name -eq 'kernel32.dll'){return [Runtime.InteropServices.NativeLibrary]::Load($env:WINSCEN_NATIVE_SHIM)}
  return [IntPtr]::Zero
}
[Runtime.InteropServices.NativeLibrary]::SetDllImportResolver([MurageGateProcess].Assembly,$resolver)
function Assert-GatePath($path){return $path}
function Check([bool]$ok,[string]$name){if(-not $ok){throw "ASSERTION: $name"};"PASS $name"}
$dir=Join-Path ([IO.Path]::GetTempPath()) ('broker-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($dir)
$oldRoot=$env:SystemRoot;$env:SystemRoot='/fixture'
try {
 [IO.File]::WriteAllText($env:WINSCEN_NATIVE_TRACE,'')
 $id=[Guid]::NewGuid().ToString();$input=Join-Path $dir ($id+'.request.json')
 @{id=$id;file='/fixture/System32/WindowsPowerShell/v1.0/powershell.exe';args=@('-File','snapshot.ps1');deadlineAt=1300000} | ConvertTo-Json | Set-Content -LiteralPath $input
 Invoke-NativeBrokerRequest -Directory $dir -Now {1000000}
 $response=Get-Content -LiteralPath (Join-Path $dir ($id+'.response.json')) -Raw | ConvertFrom-Json
 $events=@(Get-Content -LiteralPath $env:WINSCEN_NATIVE_TRACE)
 $expected=@('create-audit','create-owner','no-breakaway-kill-on-close','assign-audit-and-owner-at-creation','inherit-only-stdio','create-suspended-snapshot','resume-owned-thread','snapshot-still-running-after-300000ms','terminate-owned-job-only','close-owner','prove-empty-after-termination-and-close')
 Check (($events -join ',') -ceq ($expected -join ',')) 'reviewer Desktop snapshot >300 seconds: 11 real C# events; owned job terminated and empty; unrelated PID untouched'
 Check ($response.error -like '*Owned command exceeded its deadline*' -and $response.proof.empty -and $response.proof.ownerClosed -and $response.proof.flags -eq 8192 -and $response.proof.remaining.Count -eq 0) 'broker returns timeout only after closed empty no-breakaway job proof'
 Check ((Test-Path -LiteralPath (Join-Path $dir 'native-jobs.jsonl')) -and -not (Test-Path -LiteralPath $input)) 'broker persists native proof and consumes exact request'
 # No deadline, expired work, or non-helper requests can reach native creation.
 foreach($case in @('expired','wrong-helper')) {
  $id=[Guid]::NewGuid().ToString();$before=[MurageGateProcess]::Proofs.Count
  @{id=$id;file=$(if($case -eq 'wrong-helper'){'unexpected.exe'}else{'/fixture/System32/WindowsPowerShell/v1.0/powershell.exe'});args=@();deadlineAt=$(if($case -eq 'expired'){999999}else{1300000})} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir ($id+'.request.json'))
  Invoke-NativeBrokerRequest -Directory $dir -Now {1000000}
  $answer=Get-Content -LiteralPath (Join-Path $dir ($id+'.response.json')) -Raw | ConvertFrom-Json
  Check ($answer.error -and $null -eq $answer.proof -and [MurageGateProcess]::Proofs.Count -eq $before) "broker refuses $case before native creation"
 }
}finally{$env:SystemRoot=$oldRoot;Remove-Item -LiteralPath $dir -Recurse -Force}
