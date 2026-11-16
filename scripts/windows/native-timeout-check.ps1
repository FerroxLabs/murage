# Runs the real C# timeout path against a Linux Win32 boundary double.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'owned-process.ps1')
Initialize-OwnedProcess
$resolver=[Runtime.InteropServices.DllImportResolver]{param($name,$assembly,$path)
  if($name -eq 'kernel32.dll'){return [Runtime.InteropServices.NativeLibrary]::Load($env:WINSCEN_NATIVE_SHIM)}
  return [IntPtr]::Zero
}
[Runtime.InteropServices.NativeLibrary]::SetDllImportResolver([MurageGateProcess].Assembly,$resolver)
[IO.File]::WriteAllText($env:WINSCEN_NATIVE_TRACE,'')
$errorText=''
try {Invoke-WindowsNative 'schtasks.exe' @('/Query','/TN','fixture')}catch{$errorText=$_.Exception.ToString()}
if($errorText -notmatch 'Owned command exceeded its deadline'){throw "ASSERTION: real C# native timeout missing: $errorText"}
$events=@(Get-Content -LiteralPath $env:WINSCEN_NATIVE_TRACE)
$expected=@('create-audit','create-owner','no-breakaway-kill-on-close','assign-audit-and-owner-at-creation','inherit-only-stdio','create-suspended-schtasks','resume-owned-thread','schtasks-still-running-after-30000ms','terminate-owned-job-only','close-owner','prove-empty-after-termination-and-close')
if(($events -join ',') -cne ($expected -join ',')){throw "ASSERTION: wrong native sequence: $events"}
"PASS actual C# schtasks timeout: $($events.Count) ordered native boundary events; unrelated PID untouched"
if([MurageGateProcess]::Proofs.Count -ne 1 -or -not [MurageGateProcess]::Proofs[0].empty){throw 'ASSERTION: missing actual C# empty proof'}
'PASS actual C# timeout records empty proof before propagating failure'
