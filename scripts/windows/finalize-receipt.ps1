# Only run-interactive, the operator process, calls this after task exit and cleanup.
function Finalize-GateReceipt([string]$Output,$Status,$Request,$LauncherCleanup) {
  if(-not $Status.ok -or -not $LauncherCleanup.ok){throw 'No receipt before successful outer cleanup'}
  $fixture=Assert-GatePath $Status.fixture
  $receipt=Join-Path $fixture 'scenario.json'
  if(Test-Path -LiteralPath $receipt){throw 'Child-written receipt refused'}
  $cleanup=Get-Content -LiteralPath (Join-Path $Output 'cleanup.json') -Raw | ConvertFrom-Json
  if(-not $cleanup.ok -or $cleanup.job.Count -ne 1 -or -not $cleanup.job[0].empty){throw 'Missing job-empty proof'}
  $assertions=Get-Content -LiteralPath (Join-Path $fixture 'child-assertions.json') -Raw | ConvertFrom-Json
  if($assertions.commit -ne $Request.commit -or $assertions.packageSha256 -ne $Request.packageSha256){throw 'Assertion identity differs from operator request'}
  $proof=[ordered]@{writer='operator';pid=$PID;childPid=$Status.finalizerTaskPid;prefix=$Request.prefix;completedAt=$cleanup.completedAt;finalizedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();job=$cleanup.job[0];processes=$cleanup.processes;tasks=$cleanup.tasks;registrations=$cleanup.registrations;launcher=$LauncherCleanup}
  $assertions | Add-Member -NotePropertyName cleanup -NotePropertyValue $proof
  $pending=Join-Path $fixture 'outer-receipt.pending.json'
  $assertions | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $pending -Encoding UTF8
  $validator=Join-Path (Split-Path -Parent $Request.scenarioScript) 'validate-receipt.mjs'
  $validate=Invoke-WindowsNative $Request.node @($validator,$pending)
  if($validate.ExitCode -ne 0){throw ('Outer receipt validation failed: '+$validate.Stderr)}
  # Pair the validated pending receipt before publication: pairing failure cannot leave a receipt.
  if($Request.mode -eq 'Desktop') {
    $pair=Invoke-WindowsNative $Request.node @((Join-Path (Split-Path -Parent $validator) 'receipt-pair.mjs'),$pending,$Request.handoffReceipt,(Join-Path $fixture 'pair.json'))
    if($pair.ExitCode -ne 0){throw ('Pair failed: '+$pair.Stderr)}
    $pairFile=Join-Path $fixture 'pair.json'
    $paired=Get-Content -LiteralPath $pairFile -Raw | ConvertFrom-Json
    $paired.receipts=@($receipt,$Request.handoffReceipt)
    $paired | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $pairFile -Encoding UTF8
  }
  $(if($Request.mode -eq 'Desktop'){$pair.Stdout}else{"RECEIPT handoff $receipt (pair still required)"}) | Set-Content -LiteralPath (Join-Path $Output 'result.txt')
  Move-Item -LiteralPath $pending -Destination $receipt
}
