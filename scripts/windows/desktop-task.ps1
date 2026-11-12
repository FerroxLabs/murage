# Internal task action. run-interactive.ps1 supplies the unique request path.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
. (Join-Path $PSScriptRoot 'gate-admission.ps1')
Assert-GateAdmission -Operator
[void](Assert-GatePath $Request)
$requestData = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
$root = 'C:\murage-ci'
$output = [IO.Path]::GetFullPath((Split-Path -Parent $Request))
$lock = $null
$saved=@{}
$baseline=$null
$cleanup=$null
$processBefore=$null
$browser=$null
foreach($path in @($requestData.executable,$requestData.scenarioScript,$requestData.node,$requestData.feedDirectory,$output)){[void](Assert-GatePath $path)}
$env:MURAGE_GATE_PACKAGE_SHA256=$requestData.packageSha256
$status = [ordered]@{ ok=$false; exitCode=$null; fixture=$null; error=$null; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId }
try {
  if ($status.sessionId -eq 0 -or -not [Environment]::UserInteractive) { throw 'Task did not enter an interactive user session' }
  [void](Assert-GatePath (Join-Path $root '.desktop-gate.lock'))
  $saved=Set-FixtureEnvironment (Join-Path $output 'task-env') -DefaultProfile:($requestData.mode -eq 'Handoff')
  $lock = [IO.File]::Open((Join-Path $root '.desktop-gate.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $runs = Join-Path $root 'runs'
  New-GateDirectory $runs
  $before = @(Get-ChildItem -LiteralPath $runs -Directory | Select-Object -ExpandProperty FullName)
  . (Join-Path $PSScriptRoot 'owned-process.ps1')
  . (Join-Path $PSScriptRoot 'run-ledger.ps1')
  . (Join-Path $PSScriptRoot 'ownership.ps1')
  . (Join-Path $PSScriptRoot 'gate-task-helper.ps1')
  $kind=if($requestData.mode -eq 'Handoff'){'handoff'}else{'desktop'}
  Initialize-OwnedProcess
  [MurageGateProcess]::JoinNamedJob($requestData.wrapperJob)
  $processBefore=@(Get-SessionProcesses)
  if($kind -eq 'handoff'){$browser=Get-HttpsBrowser}
  $baseline=Get-OwnershipSnapshot $kind
  $baseline | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $output 'baseline.json') -Encoding UTF8
  $env:MURAGE_GATE_RUN_PREFIX=$requestData.prefix
  $env:MURAGE_GATE_JOB_NAME='Local\'+$requestData.prefix
  $env:MURAGE_GATE_TASK_HELPER=New-GateTaskHelper $output
  $env:MURAGE_GATE_CREATE_JOB=$env:MURAGE_GATE_JOB_NAME
  Initialize-OwnedProcess
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $words = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Join-Path $root 'windows-hide-desktop-gate.ps1'), '-Executable', $requestData.executable, '-ScenarioScript', $requestData.scenarioScript, '-Commit', $requestData.commit)
  $words += @('-Node',$requestData.node,'-FeedDirectory',$requestData.feedDirectory)
  if($requestData.mode -eq 'Handoff') {
    $fixture=Join-Path $runs ('winhide-'+[Guid]::NewGuid().ToString('N'))
    $words=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$requestData.scenarioScript,'-Executable',$requestData.executable,'-Commit',$requestData.commit,'-Fixture',$fixture,'-Receipt',(Join-Path $fixture 'scenario.json'),'-Node',$requestData.node,'-FeedDirectory',$requestData.feedDirectory)
  } else {$words+=@('-HandoffReceipt',$requestData.handoffReceipt)}
  $arguments = ($words | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
  try { $status.exitCode = [MurageGateProcess]::Run($exe, $arguments, $root, $requestData.timeoutSeconds) }
  finally {
    $created = @(Get-ChildItem -LiteralPath $runs -Directory | Where-Object { $_.FullName -notin $before })
    if ($created.Count -eq 1) {
      $status.fixture = $created[0].FullName
      foreach ($name in @('result.txt', 'windows.json')) {
        $file = Join-Path $status.fixture $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination (Join-Path $output $name) }
      }
    }
  }
  if ($created.Count -ne 1) { throw "Expected one new gate fixture, found $($created.Count)" }
  foreach ($name in @('result.txt', 'windows.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $output $name) -PathType Leaf)) { throw "Gate did not write $name" }
  }
  $report = Get-Content -LiteralPath (Join-Path $output 'windows.json') -Raw | ConvertFrom-Json
  if ($report.commit -ne $requestData.commit -or $report.fixture -ne $status.fixture -or $report.executable -ne $requestData.executable) { throw 'Gate report identity mismatch' }
  if ($status.exitCode -ne 0 -or $null -ne $report.failure) { throw "Gate failed (exit=$($status.exitCode)): $($report.failure)" }
  $firstLine = @(Get-Content -LiteralPath (Join-Path $output 'result.txt'))[0]
  if($firstLine -notmatch '^ASSERTIONS '){throw 'Child assertions missing'}
  $status.ok = $true
} catch { $status.error = $_.Exception.Message }
finally {
  try {
    if($null -eq $baseline){throw 'Missing prelaunch ownership baseline'}
    $scenarioProofs=@([MurageGateProcess]::Proofs.ToArray())
    $cleanupResult=Invoke-OwnershipDeadline -Operation OwnershipDiff -Payload @{before=$baseline;prefix=$requestData.prefix} -Deadline ([DateTime]::UtcNow.AddSeconds(60))
    $cleanup=@{};foreach($property in $cleanupResult.PSObject.Properties){$cleanup[$property.Name]=$property.Value}
    $cleanup.job=$scenarioProofs
    $dispatched=$false
    if($kind -eq 'handoff' -and $status.fixture) {
      $dispatchFile=Join-Path $status.fixture 'evidence\updates-handoff.json'
      if(Test-Path -LiteralPath $dispatchFile){$dispatch=Get-Content -LiteralPath $dispatchFile -Raw | ConvertFrom-Json;$dispatched=@($dispatch.shellRows | Where-Object {$_.row -eq 'https-opened' -and $_.osDispatch -eq 'fulfilled'}).Count -eq 1}
    }
    $cleanup.processes=Compare-ProcessSnapshot $processBefore @(Invoke-OwnershipDeadline -Operation Processes -Payload @{} -Deadline ([DateTime]::UtcNow.AddSeconds(60))) $browser $dispatched
    $cleanup.ok=$cleanup.ok -and $cleanup.processes.ok
    $cleanup.completedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $cleanup | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $output 'cleanup.json') -Encoding UTF8
    if(-not $cleanup.ok -or $cleanup.job.Count -ne 1 -or -not $cleanup.job[0].empty){throw 'Ownership cleanup failed; inspect cleanup.json'}
  } catch {$status.ok=$false;$status.error=$_.Exception.Message}
  $status['finalizerTaskPid']=$PID
  Restore-FixtureEnvironment $saved
  if ($null -ne $lock) { $lock.Dispose() }
  $temporary = Join-Path $output 'task-status.tmp'
  $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination (Join-Path $output 'task-status.json')
}
if (-not $status.ok) { exit 1 }
