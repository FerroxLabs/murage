# OpenSSH is not the desktop. Register /IT under an explicitly named logged-on
# account; no password, SYSTEM account, service session or stored credential.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$Commit,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$PackageSha256,
  [Parameter(Mandatory=$true)][string]$InteractiveUser,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$Executable = 'C:\murage-ci\app\Murage.exe',
  [string]$ScenarioScript = 'C:\murage-ci\source\scripts\windows\full-packaged-scenario.ps1',
  [ValidateSet('Desktop','Handoff')][string]$Mode='Desktop',
  [string]$HandoffReceipt,
  [string]$Node='C:\murage-ci\node\node.exe',
  [string]$FeedDirectory='C:\murage-ci\feed',
  [ValidateRange(60,3600)][int]$TimeoutSeconds = 1200
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows required' }
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
. (Join-Path $PSScriptRoot 'ownership.ps1')
. (Join-Path $PSScriptRoot 'finalize-receipt.ps1')
. (Join-Path $PSScriptRoot 'gate-admission.ps1')
Assert-GateAdmission -Mode $Mode -Operator
foreach($path in @($PSScriptRoot,$Executable,$ScenarioScript,$OutputDirectory,$Node,$FeedDirectory,$HandoffReceipt) | Where-Object {$_}){[void](Assert-GatePath $path)}
$identity=Assert-StagedPackage $PackageSha256
if($Commit -ne $identity.commit){throw 'Caller commit differs from packaged build provenance'}
# schtasks can otherwise ask for another account's password. This launcher
# intentionally has no credential path: SSH as the desktop's logged-on user.
$account = New-Object Security.Principal.NTAccount($InteractiveUser)
$ownerSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
if ($Mode -eq 'Handoff') {
  if($env:COMPUTERNAME -ine 'gate-win-nogit'){throw 'Handoff is gate-win-nogit only'}
  $marker=Get-Content -LiteralPath 'C:\murage-ci\gate-user.json' -Raw | ConvertFrom-Json
  if($marker.sid -ne $ownerSid){throw 'Task must use provisioned gate user'}
  $ScenarioScript='C:\murage-ci\source\scripts\windows\updates-handoff.ps1'
} elseif (-not $HandoffReceipt) {throw 'Desktop gate requires the handoff receipt and its artifacts'}
if ($Mode -ne 'Handoff' -and $ownerSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'SSH/task registration must use the same account as the logged-on Desktop user; no credentials are accepted' }
$root = 'C:\murage-ci'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$ScenarioScript = (Resolve-Path -LiteralPath $ScenarioScript).Path
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
foreach ($file in @($Executable, $ScenarioScript, $output)) {
  if (-not $file.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Inputs and evidence must be under C:\murage-ci' }
}
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must be new (prevents stale evidence)' }
New-GateDirectory $output
$prefix='MurageCI-'+[Guid]::NewGuid().ToString('N')+'-'
$ledger=Join-Path $output 'launcher-ledger.jsonl'
[IO.File]::WriteAllText($ledger,'')
$request = Join-Path $output 'request.json'
[ordered]@{ prefix=$prefix; wrapperTask=('\'+$prefix+'wrapper'); wrapperJob=('Global\'+$prefix+'wrapper'); ledger=$ledger; packageSha256=$PackageSha256; executable=$Executable; scenarioScript=$ScenarioScript; commit=$Commit; timeoutSeconds=$TimeoutSeconds; mode=$Mode; handoffReceipt=$HandoffReceipt; node=$Node; feedDirectory=$FeedDirectory } |
  ConvertTo-Json | Set-Content -LiteralPath $request -Encoding UTF8
. (Join-Path $PSScriptRoot 'owned-process.ps1')
$task = $prefix+'wrapper'
$scheduler = Join-Path $env:SystemRoot 'System32\schtasks.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = ((@($powershell, '-NoP', '-NonI', '-EP', 'Bypass', '-W', 'Hidden', '-File', (Join-Path $PSScriptRoot 'desktop-task.ps1'), '-Request', $request) | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ')
if ($action.Length -gt 260) { throw 'Task action exceeds schtasks /TR limit; use a shorter OutputDirectory' }
# /SC ONCE is only a safety trigger; /Run starts the task immediately. A past
# date prevents an accidental second run if the machine stays up overnight.
$launcherBefore=$null
$launcherCleanup=$null
$registered = $false
$complete = $false
$runFailure=$null
$wrapperJob=$null
$wrapperJobEmpty=$false
$saved=Set-FixtureEnvironment (Join-Path $output 'launcher-env')
try {
  Initialize-OwnedProcess
  $launcherBefore=@(Invoke-OwnershipDeadline -Operation TaskSnapshot -Payload @{} -Deadline ([DateTime]::UtcNow.AddSeconds(60)))
  $wrapperJob=[MurageGateProcess]::CreateWrapperJob('Global\'+$prefix+'wrapper')
  Add-RunLedger $ledger $prefix 'task' $task
  $create = Invoke-WindowsNative $scheduler @('/Create', '/TN', $task, '/TR', $action, '/SC', 'ONCE', '/SD', '01/01/2000', '/ST', '00:00', '/RU', $InteractiveUser, '/IT', '/RL', 'LIMITED')
  if ($create.ExitCode -ne 0) { throw "Interactive task registration failed: $($create.Stdout) $($create.Stderr)" }
  $registered = $true
  $xml = Invoke-WindowsNative $scheduler @('/Query', '/TN', $task, '/XML')
  if ($xml.ExitCode -ne 0) { throw "Task XML readback failed: $($xml.Stderr)" }
  $xml.Stdout | Set-Content -LiteralPath (Join-Path $output 'task.xml') -Encoding UTF8
  [xml]$definition = $xml.Stdout
  if ($definition.Task.Principals.Principal.LogonType -ne 'InteractiveToken') { throw 'Task is not InteractiveToken (/IT)' }
  $started = Invoke-WindowsNative $scheduler @('/Run', '/TN', $task)
  if ($started.ExitCode -ne 0) { throw "Task start failed: $($started.Stderr)" }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds + 90)
  $statusFile = Join-Path $output 'task-status.json'
  while (-not (Test-Path -LiteralPath $statusFile -PathType Leaf)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Interactive task timed out; verify the named user is logged on to the Desktop' }
    Start-Sleep -Milliseconds 500
  }
  $status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
  # Wait for the task process itself to finish after committing its status.
  do {
    $registeredTask=Invoke-OwnershipDeadline -Operation TaskState -Payload @{task=$task} -Deadline $deadline
    if($registeredTask.state -ne 4){break}
    if([DateTime]::UtcNow -ge $deadline){throw 'Task wrote status but did not exit'}
    Start-Sleep -Milliseconds 500
  } while($true)
  $registeredTask | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'task-result.json') -Encoding UTF8
  $complete = $true
  if (Test-Path -LiteralPath (Join-Path $output 'result.txt')) { Get-Content -LiteralPath (Join-Path $output 'result.txt') }
  if (-not $status.ok -or $registeredTask.LastTaskResult -ne 0) { throw "Desktop gate failed: $($status.error); evidence=$output" }
} catch {
  $runFailure=$_.Exception.Message
  throw
} finally {
  try {
  Invoke-LauncherCleanup -Task ('\'+$task) -Prefix $prefix -Before $launcherBefore -WrapperJob $wrapperJob -Output $output -Commit $Commit -PackageSha256 $PackageSha256 -Result ([ref]$launcherCleanup) -PriorFailure $runFailure
  $wrapperJobEmpty=$true
  } finally {
    try {
      @{wrapper=@{name=('Global\'+$prefix+'wrapper');empty=$wrapperJobEmpty};nativeJobs=@([MurageGateProcess]::Proofs.ToArray())} |
        ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'launcher-jobs.json') -Encoding UTF8
      $launcherCleanup | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $output 'launcher-cleanup.json') -Encoding UTF8
    } finally {
      if($null -ne $wrapperJob){$wrapperJob.Dispose()}
      Restore-FixtureEnvironment $saved
    }
  }
}

if(-not $complete -or -not $status.ok){throw 'Child did not finish successfully; no receipt'}
$requestDataForFinalizer=Get-Content -LiteralPath $request -Raw | ConvertFrom-Json
Finalize-GateReceipt -Output $output -Status $status -Request $requestDataForFinalizer -LauncherCleanup $launcherCleanup
