# Serviced by scenario-common in the existing owner process. Never bootstrap a
# plain native process from Node. Each request gets a separate suspended job.
function Invoke-NativeBrokerRequest([string]$Directory,[scriptblock]$Now) {
  foreach($file in @(Get-ChildItem -LiteralPath $Directory -Filter '*.request.json' -File)) {
    $request=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if($request.id -notmatch '^[a-f0-9-]{36}$' -or $file.Name -cne ($request.id+'.request.json')){throw 'Invalid native request identity'}
    [void](Assert-GatePath $file.FullName)
    $answer=@{id=$request.id;exitCode=$null;stdout='';stderr='';error=$null;proof=$null}
    $proofCount=[MurageGateProcess]::Proofs.Count
    try {
      $nowValue=if($Now){Invoke-LinuxFixtureCallback -Callback $Now}else{[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
      $remaining=[Math]::Floor(($request.deadlineAt-$nowValue)/1000)
      if($remaining -lt 1 -or $remaining -gt 300){throw 'Native request deadline expired or invalid'}
      # Only the native helpers used by this driver. No shell executable chosen
      # by arbitrary request content, no credentials, and no inherited handles.
      $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $cmd=Join-Path $env:SystemRoot 'System32\cmd.exe'
      if($request.file -ine $ps -and $request.file -ine $cmd){throw 'Unexpected native helper'}
      $arguments=(@($request.args) | ForEach-Object {ConvertTo-WindowsArgument ([string]$_)}) -join ' '
      $result=Invoke-OwnedNative -File $request.file -Arguments $arguments -TimeoutSeconds ([int]$remaining) -ProofTimeoutMilliseconds 2000
      $answer.exitCode=$result.ExitCode;$answer.stdout=$result.Stdout;$answer.stderr=$result.Stderr
    }catch{$answer.error=$_.Exception.Message}
    finally {
      if([MurageGateProcess]::Proofs.Count -eq ($proofCount+1)){$answer.proof=[MurageGateProcess]::Proofs[$proofCount]}
      $answer | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath (Join-Path $Directory 'native-jobs.jsonl') -Encoding UTF8
      $pending=Join-Path $Directory ($request.id+'.response.pending');$response=Join-Path $Directory ($request.id+'.response.json')
      $answer | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $pending -Encoding UTF8
      Move-Item -LiteralPath $pending -Destination $response
      Remove-Item -LiteralPath $file.FullName
    }
  }
}
