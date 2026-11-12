$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'finalize-receipt.ps1')
function Assert-GatePath([string]$Path){$Path}
function Invoke-WindowsNative($File,$Arguments) {
  $script:calls++
  if($script:calls -eq $script:failCall){return @{ExitCode=1;Stderr='deliberate fixture failure'}}
  if($Arguments[0] -like '*receipt-pair.mjs'){@{receipts=@($Arguments[1],$Arguments[2])} | ConvertTo-Json | Set-Content -LiteralPath $Arguments[3]}
  @{ExitCode=0;Stdout='ok';Stderr=''}
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('winscen-finalizer-'+[Guid]::NewGuid().ToString('N'))
try {
  foreach($case in @('success-desktop','success-handoff','child-receipt','child-failure','cleanup-failure','job-nonempty','validator-failure','pair-failure')) {
    $output=Join-Path $root $case;$fixture=Join-Path $output 'fixture'
    New-Item -ItemType Directory -Path $fixture -Force | Out-Null
    $status=[pscustomobject]@{ok=$true;fixture=$fixture;finalizerTaskPid=($PID+1)}
    $request=[pscustomobject]@{commit=('a'*40);packageSha256=('b'*64);mode='Desktop';prefix=('MurageCI-'+('c'*32)+'-');node='fixture-node';scenarioScript=(Join-Path $root 'full-packaged-scenario.ps1');handoffReceipt='fixture-handoff'}
    if($case -eq 'success-handoff'){$request.mode='Handoff'}
    $cleanup=@{ok=$true;job=@(@{empty=$true});completedAt=1;tasks=@{};registrations=$null;processes=@{}}
    $launcher=@{ok=$true}
    @{kind=$request.mode.ToLowerInvariant();commit=$request.commit;packageSha256=$request.packageSha256} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixture 'child-assertions.json')
    $script:calls=0;$script:failCall=0
    switch($case) {
      'child-receipt' {'child' | Set-Content -LiteralPath (Join-Path $fixture 'scenario.json')}
      'child-failure' {$status.ok=$false}
      'cleanup-failure' {$launcher.ok=$false}
      'job-nonempty' {$cleanup.job[0].empty=$false}
      'validator-failure' {$script:failCall=1}
      'pair-failure' {$script:failCall=2}
    }
    $cleanup | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'cleanup.json')
    $failed=$false;try{Finalize-GateReceipt $output $status $request $launcher}catch{$failed=$true}
    $success=$case.StartsWith('success-')
    if($failed -eq $success){throw "ASSERTION: $case wrong finalizer result"}
    if(-not $success -and $case -ne 'child-receipt' -and (Test-Path -LiteralPath (Join-Path $fixture 'scenario.json'))){throw "ASSERTION: $case published a receipt"}
    if($case -eq 'success-desktop') {
      $paired=Get-Content -LiteralPath (Join-Path $fixture 'pair.json') -Raw | ConvertFrom-Json
      if($paired.receipts[0] -ne (Join-Path $fixture 'scenario.json')){throw 'ASSERTION: pair refers to pending receipt'}
    }
    if($success){
      $receipt=Get-Content -LiteralPath (Join-Path $fixture 'scenario.json') -Raw | ConvertFrom-Json
      if($receipt.cleanup.writer -ne 'operator' -or $receipt.cleanup.pid -ne $PID -or $receipt.cleanup.finalizedAt -lt $receipt.cleanup.completedAt){throw 'ASSERTION: outer writer/order'}
    }
    "PASS $case"
  }
}finally{if($root -and (Test-Path -LiteralPath $root)){Remove-Item -LiteralPath $root -Recurse -Force}}
