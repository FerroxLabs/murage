# G-WINBOX proof only. Run in a fresh disposable Windows 11 interactive runner.
# Windows Terminal must ALREADY be the default console host; this never changes it.
[CmdletBinding()]
param(
  [string]$Installer,
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$InstallerSha256,
  [ValidatePattern('^[a-f0-9]{40}$')][string]$Commit,
  [string]$OutputDirectory,
  [string]$Node='C:\murage-ci\node\node.exe',
  [switch]$SelfTest,
  [switch]$DisposableRunner,
  [ValidateRange(120,1800)][int]$TimeoutSeconds=900,
  [string]$WorkerRequest
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:OS -ne 'Windows_NT'){throw 'Windows runner only; do not run on Linux or a customer PC'}
if($PSVersionTable.PSEdition -ne 'Desktop'){throw 'Use Windows PowerShell 5.1 (System.Management and desktop capture)'}
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
. (Join-Path $PSScriptRoot 'owned-process.ps1')
. (Join-Path $PSScriptRoot 'run-ledger.ps1')
. (Join-Path $PSScriptRoot 'ownership.ps1')
. (Join-Path $PSScriptRoot 'native-broker.ps1')
function Save-Json([string]$Path,$Value){ConvertTo-Json -InputObject $Value -Depth 40 | Set-Content -LiteralPath $Path -Encoding UTF8}
function Get-TerminalDefault {
  # Microsoft registry contract: https://learn.microsoft.com/windows/terminal/group-policy#registry-information-2
  $value=Get-ItemProperty -LiteralPath 'HKCU:\Console\%%Startup' -ErrorAction Stop
  $ok=$value.DelegationConsole -ieq '{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}' -and $value.DelegationTerminal -ieq '{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}'
  if(-not $ok){throw 'Set Windows Terminal (stable) as Default terminal application in this disposable runner before the run'}
  return @{DelegationConsole=$value.DelegationConsole;DelegationTerminal=$value.DelegationTerminal}
}
Initialize-OwnedProcess
if($WorkerRequest) {
  [void](Assert-GatePath $WorkerRequest)
  $request=Get-Content -LiteralPath $WorkerRequest -Raw | ConvertFrom-Json
  . (Join-Path $PSScriptRoot 'gate-admission.ps1')
  Assert-GateAdmission
  # The outer owner created the named job atomically before this process ran.
  Remove-Item Env:MURAGE_GATE_CREATE_JOB -ErrorAction SilentlyContinue
  $status=@{ok=$false;cleanup=@{ok=$false};phases=@();installed=$null;error=$null}
  $driver=$null
  try {
    if($request.selfTest) {
      # Deliberate NEW visible console. /wait keeps the starter/job alive while
      # cmd /c start asks the configured default host to present its child.
      $args='/d /c start "G-WINBOX deliberate visible console" /wait "'+$env:COMSPEC+'" /d /c "ping -n 8 127.0.0.1 >nul"'
      $result=Invoke-OwnedNative -File $env:COMSPEC -Arguments $args -TimeoutSeconds 30
      if($result.ExitCode -ne 0){throw 'Deliberate console launch failed'}
    } else {
      foreach($path in @($request.installer,$request.node,$request.executable)){[void](Assert-GatePath $path)}
      if((Get-FileHash -LiteralPath $request.installer -Algorithm SHA256).Hash -ine $request.installerSha256){throw 'RC installer SHA256 mismatch'}
      $installRoot=Split-Path -Parent $request.executable
      if(Test-Path -LiteralPath $installRoot){throw 'Install target must not exist'}
      # NSIS /D must be the unquoted last argument. The validated root is local,
      # fresh, and bounded by C:\murage-ci. No existing installation is reused.
      $args='/S /currentuser --no-desktop-shortcut --no-start-menu-shortcut /D='+$installRoot
      $result=Invoke-OwnedNative -File $request.installer -Arguments $args -TimeoutSeconds 180
      if($result.ExitCode -ne 0){throw "RC installer exited $($result.ExitCode): $($result.Stderr)"}
      [void](Assert-GatePath $request.executable)
      if((Get-Item -LiteralPath $request.executable).VersionInfo.ProductVersion -ne '1.0.19'){throw 'Installed RC must be 1.0.19'}
      . (Join-Path $PSScriptRoot 'windows-hide-gate-checks.ps1')
      $manifest=Assert-WindowsHideManifest $request.executable $request.commit (Join-Path $request.output 'package-manifest.json')
      $provenance=Get-Content -LiteralPath (Join-Path $installRoot 'resources\build-provenance.json') -Raw | ConvertFrom-Json
      if($provenance.commit -cne $request.commit){throw 'Installed build provenance differs from requested commit'}
      $status.installed=@{version='1.0.19';sha256=$request.installerSha256;commit=$request.commit;executable=$request.executable;manifest=$manifest}
      Save-Json (Join-Path $request.output 'installed.json') $status.installed
      $words=@('--experimental-strip-types',(Join-Path $PSScriptRoot 'winbox-driver.mjs'),'--run',$WorkerRequest)
      $args=($words | ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '
      $driver=[MurageGateProcess]::RunInBackground($request.node,$args,$PSScriptRoot,$request.timeoutSeconds,$false)
      while(-not $driver.IsCompleted){Invoke-NativeBrokerRequest $env:MURAGE_GATE_NATIVE_BROKER;Start-Sleep -Milliseconds 25}
      if($driver.GetAwaiter().GetResult() -ne 0){throw 'Packaged Node workflow failed; see phases.json and driver output'}
      $status.phases=@(Get-Content -LiteralPath (Join-Path $request.fixture 'phases.json') -Raw | ConvertFrom-Json)
      [void](Assert-WindowsHideManifest $request.executable $request.commit (Join-Path $request.output 'package-manifest-after.json'))
    }
    $status.ok=$true
  } catch {
    $status.error=$_.Exception.Message
    $partial=Join-Path $request.fixture 'phases.json'
    if(Test-Path -LiteralPath $partial){$status.phases=@(Get-Content -LiteralPath $partial -Raw | ConvertFrom-Json)}
    [MurageGateProcess]::CancelAll()
    if($null -ne $driver){try{[void]$driver.GetAwaiter().GetResult()}catch{}}
  } finally {
    # The outer owner removes newly prefixed tasks after closing/proving the
    # complete worker job empty, including on timeout or a worker crash.
    Save-Json (Join-Path $request.output 'worker-status.json') $status
  }
  if(-not $status.ok){exit 1};exit 0
}

if(-not $DisposableRunner){throw 'Supply -DisposableRunner only on a fresh disposable runner/account; installation writes that account registrations'}
if(-not $OutputDirectory){throw '-OutputDirectory is required'}
foreach($path in @($OutputDirectory,$Node,$PSScriptRoot)){[void](Assert-GatePath $path)}
$output=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if(-not $output.StartsWith('C:\murage-ci\results\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence must be a new directory under C:\murage-ci\results'}
if(Test-Path -LiteralPath $output){throw 'OutputDirectory must be new; stale evidence refused'}
if(-not $SelfTest) {
  if(-not $Installer -or -not $InstallerSha256 -or -not $Commit){throw 'Installer, InstallerSha256 and Commit are required'}
  [void](Assert-GatePath $Installer)
  # Fresh runner/account required, even though all app data is isolated below.
  foreach($existing in @((Join-Path $env:LOCALAPPDATA 'Programs\Murage'),(Join-Path $env:APPDATA 'Murage'),(Join-Path $env:USERPROFILE '.murage'))) {
    if(Test-Path -LiteralPath $existing){throw "Fresh runner required: existing Murage profile/install at $existing"}
  }
  if(@(Get-Process -Name Murage -ErrorAction SilentlyContinue).Count){throw 'Existing Murage process; refuse a live app'}
}
New-GateDirectory $output
$fixture=Join-Path $output 'fixture';New-GateDirectory $fixture
$executable=Join-Path $fixture 'app\Murage.exe'
$requestFile=Join-Path $output 'request.json'
$prefix='MurageCI-'+[Guid]::NewGuid().ToString('N')+'-'
$request=@{installer=$Installer;installerSha256=$InstallerSha256;commit=$Commit;output=$output;fixture=$fixture;executable=$executable;node=$Node;selfTest=[bool]$SelfTest;timeoutSeconds=$TimeoutSeconds}
Save-Json $requestFile $request
$envKeys=@('MURAGE_GATE_RUN_PREFIX','MURAGE_GATE_JOB_NAME','MURAGE_GATE_CREATE_JOB','MURAGE_GATE_TASK_HELPER','MURAGE_GATE_NATIVE_BROKER')
$savedGate=@{};foreach($key in $envKeys){$savedGate[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$savedFixture=@{};$sampler=$null;$worker=$null;$cleanup=@{ok=$false};$scenario=@{ok=$false;cleanup=$cleanup};$failure=$null
$observer=@{intervalMs=200;errors=@();desktopVerified=$false;terminalDefault=$false;windowsBuild=0;finalGapMs=0}
$screenshot=Join-Path $output 'desktop-end.png';$screenshotBytes=0;$verdictCode=1;$baseline=$null
try {
  $observer.windowsBuild=[int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
  if($observer.windowsBuild -lt 22000){throw 'Windows 11 runner required'}
  $observer.terminalRegistry=Get-TerminalDefault;$observer.terminalDefault=$true
  Add-Type -AssemblyName System.Management,System.Web.Extensions,System.Drawing,System.Windows.Forms
  Add-Type -Path (Join-Path $PSScriptRoot 'winbox-sampler.cs') -ReferencedAssemblies System,System.Core,System.Management,System.Web.Extensions
  [WinboxSampler]::RequireDesktop();$observer.desktopVerified=$true
  $savedFixture=Set-FixtureEnvironment $fixture
  $env:MURAGE_GATE_RUN_PREFIX=$prefix;$env:MURAGE_GATE_JOB_NAME='Local\'+$prefix
  $env:MURAGE_GATE_TASK_HELPER=New-GateTaskHelper $output
  $broker=Join-Path $fixture 'native-broker';New-GateDirectory $broker;$env:MURAGE_GATE_NATIVE_BROKER=$broker
  $baseline=@(Get-TaskSnapshot);Save-Json (Join-Path $output 'tasks-before.json') $baseline
  $sampler=New-Object WinboxSampler (Join-Path $output 'windows.jsonl')
  $env:MURAGE_GATE_CREATE_JOB=$env:MURAGE_GATE_JOB_NAME
  $words=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$PSCommandPath,'-WorkerRequest',$requestFile)
  $args=($words | ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '
  $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $worker=[MurageGateProcess]::RunInBackground($ps,$args,$PSScriptRoot,($TimeoutSeconds+240),$false)
  # Keep CREATE_JOB until the worker has inherited its environment and exited.
  while(-not $worker.IsCompleted){Start-Sleep -Milliseconds 100}
  $code=$worker.GetAwaiter().GetResult() # includes job owner close and empty proof
  Remove-Item Env:MURAGE_GATE_CREATE_JOB -ErrorAction SilentlyContinue
  $scenario=Get-Content -LiteralPath (Join-Path $output 'worker-status.json') -Raw | ConvertFrom-Json
  if($code -ne 0 -or -not $scenario.ok){throw "Worker failed: $($scenario.error)"}
} catch {$failure=$_.Exception.Message}
finally {
  try {
    if($null -ne $worker -and -not $worker.IsCompleted){[MurageGateProcess]::CancelAll();try{[void]$worker.GetAwaiter().GetResult()}catch{}}
    Remove-Item Env:MURAGE_GATE_CREATE_JOB -ErrorAction SilentlyContinue
    if($null -ne $baseline) {
      $cleanup=Invoke-OwnershipDeadline -Operation TaskDiff -Payload @{before=$baseline;prefix=$prefix} -Deadline ([DateTime]::UtcNow.AddSeconds(60))
      if(-not $cleanup.ok){throw 'Owned task cleanup failed'}
      $proofs=@([MurageGateProcess]::Proofs.ToArray())
      if(-not $proofs.Count -or @($proofs | Where-Object {-not $_.empty -or -not $_.ownerClosed}).Count){throw 'Worker job empty proof missing'}
      Save-Json (Join-Path $output 'job-proofs.json') $proofs
    }
  } catch {$failure=($_.Exception.Message+'; '+$failure);$cleanup=@{ok=$false;error=$_.Exception.Message}}
  $scenario.cleanup=$cleanup
  if($failure){$scenario.ok=$false}
  Save-Json (Join-Path $output 'scenario.json') @{result=$scenario;failure=$failure}
  try {
    [WinboxSampler]::RequireDesktop()
    [void](Get-TerminalDefault)
    $bounds=[Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap=New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
    try {$graphics=[Drawing.Graphics]::FromImage($bitmap);try{$graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bounds.Size)}finally{$graphics.Dispose()};$bitmap.Save($screenshot,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
    $screenshotBytes=(Get-Item -LiteralPath $screenshot).Length
  } catch {$observer.errors+=('Desktop screenshot/prerequisite failure: '+$_.Exception.Message)}
  if($null -ne $sampler){$sampler.Dispose();$observer.errors+=@($sampler.Errors.ToArray());$observer.finalGapMs=$sampler.FinalGapMs}
  if($failure){$observer.errors+=$failure}
  Save-Json (Join-Path $output 'observer.json') $observer
  $metadata=@();if($null -ne $sampler){$metadata=@($sampler.Metadata.Values)}
  Save-Json (Join-Path $output 'process-metadata.json') $metadata
  if($null -ne $sampler) {
    $inputFile=Join-Path $output 'verdict-input.json'
    Save-Json $inputFile @{samplesFile=(Join-Path $output 'windows.jsonl');metadata=$metadata;executable=$executable;observer=$observer;scenario=$scenario;screenshot=$screenshot;screenshotBytes=$screenshotBytes;selfTest=[bool]$SelfTest}
    try {
      $words=@((Join-Path $PSScriptRoot 'winbox-driver.mjs'),'--verdict',$inputFile)
      $args=($words | ForEach-Object {ConvertTo-WindowsArgument $_}) -join ' '
      $result=Invoke-OwnedNative -File $Node -Arguments $args -TimeoutSeconds 60
      $verdictCode=$result.ExitCode
    } catch {$failure='Verdict driver failed: '+$_.Exception.Message}
  }
  if(-not (Test-Path -LiteralPath (Join-Path $output 'verdict.json'))) {
    $offendersFile=Join-Path $output 'offending-windows.json'
    $offenders=@()
    if(Test-Path -LiteralPath $offendersFile) {
      $offenders=@(Get-Content -LiteralPath $offendersFile -Raw | ConvertFrom-Json)
    } else {Save-Json $offendersFile $offenders}
    Save-Json (Join-Path $output 'verdict.json') @{gate='G-WINBOX';verdict='FAIL';selfTest=[bool]$SelfTest;selfTestPassed=$false;errors=@($failure)+@($observer.errors);offendingWindows=$offenders;screenshot=$screenshot}
  }
  Restore-FixtureEnvironment $savedFixture
  foreach($key in $savedGate.Keys){[Environment]::SetEnvironmentVariable($key,$savedGate[$key],'Process')}
}
Get-Content -LiteralPath (Join-Path $output 'verdict.json') -Raw
exit $verdictCode
