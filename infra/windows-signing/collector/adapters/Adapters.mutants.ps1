# Adapter check/mutant producer owner: Builder B; evidence/acceptance consumer owner: MAIN.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $Output, [switch] $Selfcheck, [string] $Group = 'all')
$ErrorActionPreference = 'Stop'
$collector = [IO.Path]::GetFullPath("$PSScriptRoot/..")
$checkout = [IO.Path]::GetFullPath("$collector/../../..")
if (-not [IO.Path]::IsPathFullyQualified($Output) -or [IO.Path]::GetFullPath($Output) -cne $Output) { throw 'Absolute evidence path required' }
$relative = [IO.Path]::GetRelativePath($checkout, $Output)
if (-not $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { throw 'Evidence must be outside checkout' }
if ($Selfcheck) {
    $references = @(Get-ChildItem "$PSHOME/ref/*.dll" | ForEach-Object FullName)
    $sources = @(Get-ChildItem "$collector/*.cs" | Where-Object { $_.Name -notlike '*.selfcheck.cs' } | ForEach-Object FullName)
    $sources += @(Get-ChildItem "$PSScriptRoot/*.cs" | ForEach-Object FullName)
    $sources += @(Get-ChildItem "$collector/reapers/*.cs" -ErrorAction SilentlyContinue | ForEach-Object FullName)
    $sources += @("$collector/../boundary/SigningProcess.cs", "$collector/../boundary/WindowsSigningProcessApi.cs")
    Add-Type -Path $sources -ReferencedAssemblies $references
    $null = [IO.Directory]::CreateDirectory($Output)
    Write-Output 'ADAPTER_TEST_ASSEMBLY_COMPILED'
    try { $count = [AdapterChecks]::Run($Group, "$PSScriptRoot/fixtures", $Output, "$checkout/scripts/windows-signing-witness/plan.json", "$collector/WitnessCollector.csproj") }
    catch { Write-Output "ADAPTER_BEHAVIOR_FAILURE group=$Group"; throw }
    Write-Output "ADAPTER_CHECKS_PASS group=$Group assertions=$count RELEASE_HOLD"
    exit 0
}
if (Test-Path -LiteralPath $Output) { throw 'New mutation evidence directory required' }
$null = [IO.Directory]::CreateDirectory($Output)
$mutants = @(
    @{ Name='M-Assets-leaf-pair'; Group='M-B12'; File='adapters/AssetsCollector.cs'; Old='writer.WriteString("leafDerSha256", pe.LeafDerSha256);'; New='writer.WriteString("leafDerSha256", new string((char)98, 64));' },
    @{ Name='M-S4-creation-window'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='api.ArmContainment();'; New='GC.KeepAlive(api);' },
    @{ Name='M-S4-cleanup-budget'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='(int)Math.Clamp(deadline - now, 0, WitnessCodec.CaseMilliseconds)'; New='WitnessCodec.CaseMilliseconds' },
    @{ Name='M-B1-omit-first-step'; Group='M-B1'; File='adapters/CaseRunner.cs'; Old='foreach (var step in Steps(caseId))'; New='foreach (var step in Steps(caseId).Skip(1))' },
    @{ Name='M-B1-omit-last-step'; Group='M-B1'; File='adapters/CaseRunner.cs'; Old='foreach (var step in Steps(caseId))'; New='foreach (var step in Steps(caseId).SkipLast(1))' },
    @{ Name='M-D2-S1-no-local-tool'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='using var target = JsonDocument.Parse("{}");'; New='using var forbidden = System.Diagnostics.Process.Start("forbidden-ci-tool"); using var target = JsonDocument.Parse("{}");' },
    @{ Name='M-D2-S3-tool-hash'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='WitnessCodec.Text(policies, "toolSha256") != enrolledCiToolSha256'; New='!WitnessCodec.Hex(enrolledCiToolSha256, 64)' },
    @{ Name='M-D2-S4-build'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='snapshot.Build != acceptedBuild'; New='snapshot.Build < 22000' },
    @{ Name='M-D2-S5-policy-kind'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='WitnessCodec.Text(state, "kind") != "DWord"'; New='state.ValueKind == JsonValueKind.Null' },
    @{ Name='M-D2-F1-own-token'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='!Same(measurement.Failure, measurement.TokenOwner)'; New='measurement.TokenOwner == null' },
    @{ Name='M-D2-F2-installed-path'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='!String.Equals(measurement.Failure.ImagePath, installedImagePath, StringComparison.OrdinalIgnoreCase)'; New='measurement.Failure.ImagePath == null' },
    @{ Name='M-D2-F2-image-hash'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='measurement.Failure.ImageSha256 != installedImageSha256'; New='!WitnessCodec.Hex(measurement.Failure.ImageSha256, 64)' },
    @{ Name='M-D2-F3-descendant'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='!Same(measurement.SuspendedCreatedProcess, measurement.Failure)'; New='measurement.SuspendedCreatedProcess == null' },
    @{ Name='M-D2-F4-standard-caller'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='api.AssertStandardCaller();'; New='GC.KeepAlive(api);' },
    @{ Name='M-D2-F5-probe-not-witness'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='measurement.OsFeasibilityOnly ||'; New='measurement.Failure == null ||' },
    @{ Name='M-D2-C1-no-refusal-pass'; Group='M-B9'; File='adapters/CollectionEntry.cs'; Old='SeamStatus.Require(caseId, SeamStatus.Adapters(enrollment));'; New='ResultWriter.WriteExclusive(Path.Combine(output, "result.json"), System.Text.Encoding.UTF8.GetBytes("{\"status\":\"PASS\"}")); SeamStatus.Require(caseId, SeamStatus.Adapters(enrollment));' },
    @{ Name='M-D2-C2-before-effect'; Group='M-B1'; File='adapters/CaseRunner.cs'; Old='using var request = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024);'; New='using var request = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024); using var premature = ResourceJournal.Open(journalPath, WitnessCodec.Text(request.RootElement, "runNonce"));' },
    @{ Name='M-D2-C4-sac-handler'; Group='M-B1'; File='adapters/CaseRunner.cs'; Old='"sac-real-turn-s4" => new[]'; New='"missing-sac-handler" => new[]' },
    @{ Name='M-D2-O2-protected-pin'; Group='M-B2'; File='adapters/EvidenceManifest.cs'; Old='HeldFile.Hash(manifest) != protectedPin'; New='!WitnessCodec.Hex(protectedPin, 64)' },
    @{ Name='M-D2-O3-run-binding'; Group='M-B2'; File='adapters/EvidenceManifest.cs'; Old='WitnessCodec.Text(value, "runNonce") == binding.RunNonce'; New='value.ValueKind == JsonValueKind.Object'; SecondOld='Create(binding, files)'; SecondNew='Create(binding with { RunNonce = WitnessCodec.Text(value.GetProperty("binding"), "runNonce") }, files)'  },
    @{ Name='M-D2-O1-unenrolled'; Group='M-B9'; File='adapters/CollectionEntry.cs'; Old='new UnenrolledEvidenceAuthenticator().Verify(Array.Empty<byte>(), Array.Empty<byte>());'; New='GC.KeepAlive(Array.Empty<byte>());'; Count=2 },
    @{ Name='M-B1-plan'; Group='M-B1'; File='adapters/CaseRunner.cs'; Old='var measured = operations.Complete(binding, cancellation);'; New='var measured = new BoundObservation(binding, spec.GetProperty("expect"));' },
    @{ Name='M-B1-act'; Group='M-B1'; File='adapters/CaseRunner.cs'; Old='operations.Act(step, operation, cancellation);'; New='GC.KeepAlive(step);' },
    @{ Name='M-B2-nonce'; Group='M-B2'; File='adapters/EvidenceManifest.cs'; Old='WitnessCodec.Text(value, "caseNonce") == binding.CaseNonce'; New='value.ValueKind == JsonValueKind.Object' },
    @{ Name='M-B2-capture'; Group='M-B2'; File='adapters/EvidenceManifest.cs'; Old='HeldFile.Hash(actual) != file.Sha256'; New='!WitnessCodec.Hex(file.Sha256, 64)' },
    @{ Name='M-B3-identity'; Group='M-B3'; File='WitnessCodec.cs'; Old='!Equal(request.GetProperty("identity"), enrollment.GetProperty("identity"))'; New='!Equal(request.GetProperty("identity"), request.GetProperty("identity"))' },
    @{ Name='M-B4-peer'; Group='M-B4'; File='adapters/ObservationChannel.cs'; Old='creation = peer.Authenticate();'; New='creation = 123;' },
    @{ Name='M-B4-binding'; Group='M-B4'; File='adapters/ObservationChannel.cs'; Old='!EvidenceManifest.Matches(response.GetProperty("binding"), binding)'; New='response.ValueKind == JsonValueKind.Null' },
    @{ Name='M-B4-sequence'; Group='M-B4'; File='adapters/ObservationChannel.cs'; Old='next != sequence + 1'; New='next < sequence' },
    @{ Name='M-B5-snapshots'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='!interval.SubscriptionStartedBeforeInstall'; New='interval.Start > interval.End' },
    @{ Name='M-B5-gap'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='record.RecordId != ++expected'; New='(expected = record.RecordId) < 0' },
    @{ Name='M-B5-evaluation'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='snapshot.State != 1'; New='snapshot.State == 0' },
    @{ Name='M-B5-reboot'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='interval.Before.Boot != interval.After.Boot'; New='interval.After.Boot == null' },
    @{ Name='M-D2-S2-unknown-event'; Group='M-B5'; File='adapters/SacAdapter.cs'; Old='!new[] { 3033, 3034, 3076, 3077, 3089, 3099 }.Contains(record.Id)'; New='record.Id < 0' },
    @{ Name='M-B6-deny-only'; Group='M-B6'; File='adapters/TokenObserver.cs'; Old='group.Sid == "S-1-5-32-544"'; New='group.Sid == "S-1-5-32-544" && (group.Attributes & 0x10) == 0' },
    @{ Name='M-B6-disabled-luid'; Group='M-B6'; File='adapters/TokenObserver.cs'; Old='privilege.Name == "SeShutdownPrivilege" || privilege.Name == "SeRemoteShutdownPrivilege"'; New='(privilege.Name == "SeShutdownPrivilege" || privilege.Name == "SeRemoteShutdownPrivilege") && (privilege.Attributes & 2) != 0' },
    @{ Name='M-B7-marker'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='|| measurement.NativeSucceeded ||'; New='|| measurement.NativeSucceeded && measurement.NativeError == 0 ||' },
    @{ Name='M-B7-engine'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='measurement.EngineSpawned || measurement.JobStarted'; New='measurement.EngineSpawned && measurement.JobStarted' },
    @{ Name='M-B7-success-deny'; Group='M-B7'; File='adapters/S4FaultLauncher.cs'; Old='!measurement.SuccessAdjustAccessGranted'; New='measurement.SuccessToken == null' },
    @{ Name='M-B8-hash'; Group='M-B8'; File='CaptureWriter.cs'; Old='hash.AppendData(buffer, 0, read);'; New='hash.AppendData(new byte[] { 0 });' },
    @{ Name='M-B8-empty'; Group='M-B8'; File='CaptureWriter.cs'; Old='if (total == 0)'; New='if (total < 0)' },
    @{ Name='M-B8-reserved'; Group='M-B8'; File='CaptureWriter.cs'; Old='|| name == "request.json" || name == "result.json" || name == "collector.log"'; New='|| name == "unused-reserved-file"' },
    @{ Name='M-B9-input-selection'; Group='M-B9'; File='WitnessCodec.cs'; Old='!Equal(request.GetProperty("inputs"), enrollment.GetProperty("inputs"))'; New='!Equal(request.GetProperty("inputs"), request.GetProperty("inputs"))' },
    @{ Name='M-B10-cleanup'; Group='M-B10'; File='adapters/CaseRunner.cs'; Old='if (!ResourceRecovery.ConfirmAbsent(resources, reapers))'; New='if (resources.Length < 0)' },
    @{ Name='M-B10-final-cleanup'; Group='M-B10'; File='adapters/CaseRunner.cs'; Old='if (!ResourceRecovery.ConfirmAbsent(absent.Select(entry => entry.Resource), reapers))'; New='if (absent.Count < 0)' },
    @{ Name='M-B10-finalize'; Group='M-B10'; File='adapters/CaseRunner.cs'; Old='operations.Finalize(binding);'; New='GC.KeepAlive(binding);' },
    @{ Name='M-B10-flush'; Group='M-B10'; File='adapters/ResultWriter.cs'; Old='file.Write(bytes); file.Flush(true);'; New='file.Write(bytes); file.Flush(false);' },
    @{ Name='M-B11-production-double'; Group='M-B11'; File='WitnessCollector.csproj'; Old='**/*.selfcheck.cs'; New='*.selfcheck.cs' },
    @{ Name='M-B12-witness-host'; Group='M-B12'; File='adapters/CollectionEntry.cs'; Old='if (witnessEnrollmentPresent)'; New='if (witnessEnrollmentPresent && args.Length == 0)' },
    @{ Name='M-B12-destroy'; Group='M-B12'; File='adapters/AssetsCollector.cs'; Old='var before = measurements.ReadAssets(request.Assets);'; New='System.IO.Directory.Delete(request.Output, true); var before = measurements.ReadAssets(request.Assets);' },
    @{ Name='M-B13-enrolled-rewrite'; Group='M-B13'; File='adapters/CaseRunner.cs'; Old='if (caseId == "locked-build") operations.AssertEnrolledInputsUnchanged();'; New='GC.KeepAlive(operations);'; Count=2 }
)
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
function Invoke-Check([string] $Root, [string] $GroupName, [string] $Scratch, [string] $Log) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $pwsh; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File', "$Root/infra/windows-signing/collector/adapters/Adapters.mutants.ps1", '-Selfcheck', '-Group', $GroupName, '-Output', $Scratch)) { $start.ArgumentList.Add($arg) }
    $start.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR')) { $value = [Environment]::GetEnvironmentVariable($name); if ($value) { $start.Environment[$name] = $value } }
    $start.Environment['TMPDIR']=$Output; $start.Environment['TEMP']=$Output; $start.Environment['TMP']=$Output
    $child = [Diagnostics.Process]::Start($start)
    try {
        $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(120000)) { $child.Kill(); $child.WaitForExit(); throw 'Existing check deadline exceeded' }
        $text=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult(); [IO.File]::WriteAllText($Log,$text)
        return @{ Code=$child.ExitCode; Text=$text }
    } finally { $child.Dispose() }
}
$summary=@()
try {
    $baseline=Invoke-Check $checkout 'all' "$Output/green" "$Output/green.log"
    if ($baseline.Code -ne 0) { throw 'Green baseline required before mutation' }
    foreach ($mutant in $mutants) {
        $root=Join-Path $Output ($mutant.Name + '/source')
        $null=[IO.Directory]::CreateDirectory("$root/infra/windows-signing")
        $null=[IO.Directory]::CreateDirectory("$root/scripts/windows-signing-witness")
        Copy-Item -LiteralPath $collector -Destination "$root/infra/windows-signing/collector" -Recurse
        $null=[IO.Directory]::CreateDirectory("$root/infra/windows-signing/boundary")
        foreach ($file in @('SigningProcess.cs','WindowsSigningProcessApi.cs')) { Copy-Item -LiteralPath "$collector/../boundary/$file" -Destination "$root/infra/windows-signing/boundary/$file" }
        Copy-Item -LiteralPath "$checkout/scripts/windows-signing-witness/plan.json" -Destination "$root/scripts/windows-signing-witness/plan.json"
        try {
            $file="$root/infra/windows-signing/collector/$($mutant.File)"; $source=[IO.File]::ReadAllText($file)
            $expected=if ($mutant.ContainsKey('Count')) { $mutant['Count'] } else { 1 }
            if (($source.Split(@($mutant.Old), [StringSplitOptions]::None)).Length -ne $expected+1) { throw "Mutation anchor count: $($mutant.Name)" }
            $changed=$source.Replace($mutant.Old,$mutant.New)
            if ($mutant.ContainsKey('SecondOld')) {
                if (($changed.Split(@($mutant.SecondOld), [StringSplitOptions]::None)).Length -ne 2) { throw 'Second mutation anchor must be unique' }
                $changed=$changed.Replace($mutant.SecondOld,$mutant.SecondNew)
            }
            [IO.File]::WriteAllText($file,$changed)
            $result=Invoke-Check $root $mutant.Group "$Output/$($mutant.Name)/run" "$Output/$($mutant.Name).log"
            $killed=$result.Code -ne 0 -and $result.Text.Contains('ADAPTER_TEST_ASSEMBLY_COMPILED') -and $result.Text.Contains('ADAPTER_BEHAVIOR_FAILURE')
            $summary+=@{ name=$mutant.Name; group=$mutant.Group; killed=$killed; exitCode=$result.Code }
            Write-Output "$($mutant.Name) killed=$killed"
            if (-not $killed) { throw "Mutant survived or did not fail behaviorally: $($mutant.Name)" }
        } finally { if (Test-Path -LiteralPath $root) { [IO.Directory]::Delete($root,$true) } }
    }
} finally { [IO.File]::WriteAllText("$Output/summary.json",(ConvertTo-Json -InputObject @($summary) -Depth 5)) }
Write-Output "ADAPTER_MUTANTS_KILLED $($summary.Count) RELEASE_HOLD"
