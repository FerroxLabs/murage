# Shared receipt boundary. The Node driver emits assertions only; cleanup and the
# independent native console observer must both succeed before a receipt exists.
function Invoke-PackagedScenario {
  param([string]$Kind,[string]$Executable,[string]$Fixture,[string]$Receipt,[string]$Commit,[string]$FeedDirectory,[string]$Node,[string[]]$Groups)
  Remove-Item Env:MURAGE_GATE_CREATE_JOB -ErrorAction SilentlyContinue
  if($env:OS -ne 'Windows_NT'){throw 'Windows desktop required'}
  if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or -not [Environment]::UserInteractive){throw 'Real interactive desktop required'}
  . (Join-Path $PSScriptRoot 'windows-hide-gate-checks.ps1')
  . (Join-Path $PSScriptRoot 'gate-paths.ps1')
  . (Join-Path $PSScriptRoot 'gate-admission.ps1')
  Assert-GateAdmission -Mode $(if($Kind -eq 'handoff'){'Handoff'}else{'Desktop'})
  foreach($path in @($Executable,$Fixture,$Receipt,$FeedDirectory,$Node,$PSScriptRoot)){[void](Assert-GatePath $path)}
  $identity=Assert-StagedPackage $env:MURAGE_GATE_PACKAGE_SHA256
  if($Commit -ne $identity.commit){throw 'Package provenance commit mismatch'}
  $Executable=(Resolve-Path -LiteralPath $Executable).Path
  if($Executable -ine 'C:\murage-ci\app\Murage.exe'){throw 'Only the separately staged candidate may be launched'}
  $Node=(Resolve-Path -LiteralPath $Node).Path
  $Fixture=[IO.Path]::GetFullPath($Fixture).TrimEnd('\')
  if(-not $Fixture.StartsWith('C:\murage-ci\runs\winhide-',[StringComparison]::OrdinalIgnoreCase)){throw 'Expected gate-owned fixture'}
  if(Test-Path -LiteralPath $Fixture){throw 'Fixture must be new'}
  $Receipt=[IO.Path]::GetFullPath($Receipt)
  if(-not $Receipt.StartsWith($Fixture+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Receipt must be inside fixture'}
  if((Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion -ne '1.0.19'){throw 'Expected candidate version 1.0.19'}
  $bytes=[IO.File]::ReadAllBytes($Executable);$pe=[BitConverter]::ToInt32($bytes,0x3c)
  if([BitConverter]::ToUInt16($bytes,$pe+24+68) -ne 2){throw 'Candidate must use GUI subsystem'}
  New-Item -ItemType Directory -Path (Join-Path $Fixture 'evidence') -Force | Out-Null
  $packageManifest=Assert-WindowsHideManifest $Executable $Commit (Join-Path $Fixture 'package-manifest.json')
  $request=Join-Path $Fixture 'request.json'
  @{kind=$Kind;executable=$Executable;fixture=$Fixture;commit=$Commit;feedDirectory=(Resolve-Path -LiteralPath $FeedDirectory).Path;node=(Resolve-Path -LiteralPath $Node).Path;groups=$Groups} | ConvertTo-Json | Set-Content -LiteralPath $request -Encoding UTF8
  $saved=Set-FixtureEnvironment $Fixture -DefaultProfile:($Kind -eq 'handoff')
  $controls=New-Object 'System.Collections.Generic.List[object]'
  $savedBroker=$env:MURAGE_GATE_NATIVE_BROKER
  $driver=$null
  $failure=$null
  $desktop=$null
  $start=[DateTime]::UtcNow
  try {
    . (Join-Path $PSScriptRoot 'owned-process.ps1')
    . (Join-Path $PSScriptRoot 'console-observer.ps1')
    . (Join-Path $PSScriptRoot 'native-broker.ps1')
    $broker=Join-Path $Fixture 'native-broker'
    New-GateDirectory $broker
    $env:MURAGE_GATE_NATIVE_BROKER=$broker
    Initialize-OwnedProcess
    $desktop=[MurageConsoleObserver]::Desktop()
    Assert-WindowsHideDesktop $desktop
    $controlExe=New-ConsoleControl $Fixture
    [MurageConsoleObserver]::Start()
    $args=@('--experimental-strip-types',(Join-Path $PSScriptRoot 'packaged-scenario.mjs'),$request) | ForEach-Object {ConvertTo-WindowsArgument $_}
    $driver=[MurageGateProcess]::RunInBackground($Node,($args -join ' '),$PSScriptRoot,1500,$false)
    $controlRequest=Join-Path $Fixture 'observer-request.json'
    while(-not $driver.IsCompleted) {
      Invoke-NativeBrokerRequest $broker
      if(Test-Path -LiteralPath $controlRequest) {
        [void](Assert-GatePath $controlRequest)
        $control=Get-Content -LiteralPath $controlRequest -Raw | ConvertFrom-Json
        if($control.edge -notin @('start','end') -or $control.group -notin $Groups -or $control.id -notmatch '^[a-f0-9]{32}$'){throw 'Invalid positive control request'}
        $at=Invoke-ConsoleControl $controlExe $Fixture
        $controls.Add(@{group=$control.group;edge=$control.edge;at=$at;detected=$true})
        Remove-Item -LiteralPath $controlRequest
        $response=Assert-GatePath (Join-Path $Fixture 'observer-response.json')
        $responseTemp=Assert-GatePath (Join-Path $Fixture 'observer-response.tmp')
        @{id=$control.id;at=$at} | ConvertTo-Json | Set-Content -LiteralPath $responseTemp -Encoding UTF8
        Move-Item -LiteralPath $responseTemp -Destination $response -Force
      }
      Start-Sleep -Milliseconds 50
    }
    $code=$driver.GetAwaiter().GetResult()
    if($code -ne 0){throw "Packaged assertions exited $code; see fixture evidence"}
    $rechecked=Assert-WindowsHideManifest $Executable $Commit (Join-Path $Fixture 'package-manifest-after.json')
    if($rechecked.sha256 -ne $packageManifest.sha256){throw 'Package changed during scenario'}
  } catch {
    $failure=$_.Exception.Message
    if('MurageGateProcess' -as [type]){[MurageGateProcess]::CancelAll()}
    if($null -ne $driver){try{[void]$driver.GetAwaiter().GetResult()}catch{}}
  }
  finally {
    if('MurageConsoleObserver' -as [type]){[MurageConsoleObserver]::Stop()}
    $env:MURAGE_GATE_NATIVE_BROKER=$savedBroker
    Restore-FixtureEnvironment $saved
  }
  $observer=@{controls=@($controls.ToArray());startedAt=[MurageConsoleObserver]::StartedAt;stoppedAt=[MurageConsoleObserver]::StoppedAt;finalGapMs=[MurageConsoleObserver]::FinalGapMs;samples=[MurageConsoleObserver]::Samples;maxGapMs=[MurageConsoleObserver]::MaxGapMs;visible=@([MurageConsoleObserver]::Visible);enumerationErrors=@([MurageConsoleObserver]::Errors)}
  if($observer.samples -lt 4 -or $observer.maxGapMs -gt 1000 -or $observer.visible.Count -or $observer.enumerationErrors.Count){$failure='Console observation failed'}
  @{commit=$Commit;fixture=$Fixture;executable=$Executable;machine=$env:COMPUTERNAME;user=$env:USERNAME;windows=[Environment]::OSVersion.VersionString;version=(Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion;start=$start.ToString('O');end=[DateTime]::UtcNow.ToString('O');intervalMs=250;scenarioSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'packaged-scenario.mjs')).Hash;sha256=(Get-FileHash -LiteralPath $Executable).Hash;observer=$observer;desktopVerified=($null -ne $desktop);controlVerified=($controls.Count -eq $Groups.Count*2);desktop=$desktop;packageManifest=$packageManifest;failure=$failure} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Fixture 'windows.json') -Encoding UTF8
  if($failure){throw $failure}
  $assertions=Get-Content -LiteralPath (Join-Path $Fixture 'assertions.json') -Raw | ConvertFrom-Json
  $assertions | Add-Member -NotePropertyName observer -NotePropertyValue $observer
  # A subset may be useful for diagnosis but is never a gate receipt.
  $expected=if($Kind -eq 'desktop'){@('bot-turns','tools','sentinel','mcp','browser','updates-isolated')}else{@('updates-handoff')}
  if(@(Compare-Object @($assertions.groups.name | Sort-Object) @($expected | Sort-Object)).Count){throw 'Incomplete group set; no receipt'}
  $assertions | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $Fixture 'child-assertions.json') -Encoding UTF8
  "ASSERTIONS $Kind (outer finalizer required)" | Set-Content -LiteralPath (Join-Path $Fixture 'result.txt')
}
