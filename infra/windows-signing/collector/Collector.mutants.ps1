# Mutant/check producer owner: win-sac-sign; Windows API mutation execution/evidence consumer owner: MAIN.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $Output, [switch] $Native)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Inputs.ps1"
if (-not [IO.Path]::IsPathFullyQualified($Output) -or [IO.Path]::GetFullPath($Output) -cne $Output -or (Test-Path -LiteralPath $Output)) { throw 'New absolute evidence directory required' }
$checkout = [IO.Path]::GetFullPath("$PSScriptRoot/../../..")
$relative = [IO.Path]::GetRelativePath($checkout, $Output)
if (-not $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { throw 'Evidence must be outside checkout' }
if ($Native -and -not $IsWindows) { throw 'Native mutants require Windows' }
$mutants = @(
    @{ Name='journal-run-binding'; File='ResourceJournal.cs'; Old='row.RunNonce != runNonce'; New='false'; Old2='row.Binding.RunNonce != runNonce'; New2='false' },
    @{ Name='journal-chain'; File='ResourceJournal.cs'; Old='row.Previous != state.Previous'; New='false' },
    @{ Name='journal-sequence'; File='ResourceJournal.cs'; Old='row.Sequence != state.Sequence + 1'; New='false' },
    @{ Name='journal-request-binding'; File='ResourceJournal.cs'; Old='!WitnessCodec.Hex(RequestSha256, 64)'; New='false' },
    @{ Name='journal-duplicate-resource'; File='ResourceJournal.cs'; Old='if (entry != null) throw WitnessCodec.Reject("RESOURCE_REPLAY");'; New='if (false) throw WitnessCodec.Reject("RESOURCE_REPLAY");' },
    @{ Name='journal-torn-tail'; File='ResourceJournal.cs'; Old='state.TornTail = start != bytes.Length'; New='state.TornTail = false' },
    @{ Name='reaper-trust-destroyed'; File='ResourceJournal.cs'; Old='state.Created.Reverse()'; New='state.Remaining.Reverse()' },
    @{ Name='reaper-trust-destroy-return'; File='ResourceJournal.cs'; Old='if (!reaper.Absent(resource)) { complete = false; Failure(resource, "reap"); }'; New='GC.KeepAlive(resource);' },
    @{ Name='reaper-stop-after-error'; File='ResourceJournal.cs'; Old='if (!reaper.Absent(resource)) reaper.Destroy(resource);'; New='try { if (!reaper.Absent(resource)) reaper.Destroy(resource); } catch { return false; }' },
    @{ Name='reaper-foreign-resource'; File='ResourceJournal.cs'; Old='state.Created.Reverse()'; New='state.Created.Concat(new[] { new RunResource("process", "200", "5678") }).Reverse()' },
    @{ Name='capture-empty'; File='CaptureWriter.cs'; Old='if (total == 0)'; New='if (total < 0)' },
    @{ Name='capture-byte-hash'; File='CaptureWriter.cs'; Old='hash.AppendData(buffer, 0, read);'; New='hash.AppendData(new byte[] { 0 });' },
    @{ Name='capture-reserved-name'; File='CaptureWriter.cs'; Old='|| name == "request.json" || name == "result.json" || name == "collector.log"'; New='|| false' },
    @{ Name='recovery-error-details'; File='ResourceJournal.cs'; Old='Console.Error.WriteLine(JsonSerializer.Serialize('; New='GC.KeepAlive(JsonSerializer.Serialize(' },
    @{ Name='M-A1'; File='ResourceJournal.cs'; Old='Destroyed = destroyed, Reaped = !destroyed'; New='Destroyed = false, Reaped = !destroyed' },
    @{ Name='M-A2'; File='ResourceJournal.cs'; Old='entry.Binding != row.Binding'; New='false' },
    @{ Name='M-A3'; File='ResourceJournal.cs'; Old='entry.Binding != row.Binding'; New='entry.Binding.CaseNonce != row.Binding.CaseNonce' },
    @{ Name='M-A4'; File='ResourceJournal.cs'; Old='                transition();'; New='                GC.KeepAlive(row);' },
    @{ Name='M-A5'; File='ResourceJournal.cs'; Old='state.Created.Reverse()'; New='state.Remaining.Reverse()' },
    @{ Name='M-A6'; File='ReaperRegistry.cs'; Old='? reaper : throw WitnessCodec.Reject("REAPER_MISSING")'; New='? reaper : For("process")' },
    @{ Name='M-A7'; File='reapers/FileReaper.cs'; Old='if (file.Identity != identity) { Foreign(resource); return; }'; New='if (resource == null) { Foreign(resource); return; }' },
    @{ Name='M-A8'; File='reapers/JobReaper.cs'; Old='bool empty = job == null || job.ActiveProcesses == 0;'; New='bool empty = true;' },
    @{ Name='job-member-incarnation'; File='reapers/JobReaper.cs'; Old='member == null || processes.Absent(member)'; New='member == null' },
    @{ Name='M-A9'; File='reapers/ServiceStateReaper.cs'; Old='return api.Read(resource.Id) == baseline;'; New='return api.Read(resource.Id) is ServiceBaseline actual && (actual with { StartType = baseline.StartType }) == baseline;' },
    @{ Name='M-A10'; File='reapers/TaskReaper.cs'; Old='if (actual != expected) { Foreign(resource); return; }'; New='if (resource == null) { Foreign(resource); return; }'; Old2='api.Delete(resource.Id, expected);'; New2='api.Delete(resource.Id, actual);' },
    @{ Name='M-A11'; File='Supervisor.cs'; Old='bool exited = collector.WaitUntil(expires);'; New='bool exited = true;' },
    @{ Name='M-A12'; File='Supervisor.cs'; Old='if (exited && finalized()) return true;'; New='if (exited) return true;' },
    @{ Name='M-A13'; File='ReaperRegistry.cs'; Old='WitnessCodec.Text(doc.RootElement, "runNonce") != RunNonce'; New='false' }

)
if ($Native) {
    $mutants = @(
        @{ Name='process-incarnation'; File='ProcessReaper.cs'; Old='if (process.Creation != id.Creation) { Retained.Add(resource); throw WitnessCodec.Reject("PROCESS_REUSED"); }'; New='if (process == null) { throw WitnessCodec.Reject("PROCESS_REUSED"); }' },
        @{ Name='process-terminate'; File='ProcessReaper.cs'; Old='process.Terminate((int)remaining);'; New='return;' },
        @{ Name='held-ancestor'; File='HeldFile.cs'; Old='foreach (var parent in ancestors) Open(parent, true);'; New='foreach (var parent in Array.Empty<string>()) Open(parent, true);' },
        @{ Name='held-hardlink'; File='HeldFile.cs'; Old='info.Links != 1'; New='false' },
        @{ Name='held-reparse'; File='HeldFile.cs'; Old='(info.Attributes & 0x400) != 0'; New='false' }
    )
}
$null = [IO.Directory]::CreateDirectory($Output)
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$summary = @()
function Invoke-Checks([string] $Root, [string] $Log) {
    $script = if ($Native) { 'Native.selfcheck.ps1' } else { 'Collector.selfcheck.ps1' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $pwsh; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.WorkingDirectory = $Root; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File', (Join-Path $Root "collector/$script"))) { $start.ArgumentList.Add($arg) }
    if ($Native) { $start.ArgumentList.Add('-OutputParent'); $start.ArgumentList.Add($Output) }
    $start.Environment.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR')) { $start.Environment[$name] = [Environment]::GetEnvironmentVariable($name) }
    $start.Environment['TEMP'] = $Output; $start.Environment['TMP'] = $Output; $start.Environment['TMPDIR'] = $Output
    $child = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(120000)) { $child.Kill(); $child.WaitForExit(); throw 'Mutant check exceeded existing test deadline' }
        $text = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText($Log, $text)
        return @{ Code=$child.ExitCode; Text=$text }
    } finally { $child.Dispose() }
}
try {
    $baseline = Invoke-Checks ([IO.Path]::GetFullPath("$PSScriptRoot/..")) (Join-Path $Output 'baseline.log')
    if ($baseline.Code -ne 0) { throw 'Baseline checks must pass before mutation' }
    foreach ($mutant in $mutants) {
        $root = Join-Path $Output $mutant.Name
        $null = [IO.Directory]::CreateDirectory($root)
        Copy-Item -LiteralPath $PSScriptRoot -Destination (Join-Path $root 'collector') -Recurse
        $null = [IO.Directory]::CreateDirectory((Join-Path $root 'boundary'))
        foreach ($file in @('SigningProcess.cs', 'WindowsSigningProcessApi.cs')) { Copy-Item -LiteralPath "$PSScriptRoot/../boundary/$file" -Destination (Join-Path $root "boundary/$file") }
        try {
            $file = Join-Path $root "collector/$($mutant.File)"; $source = [IO.File]::ReadAllText($file)
            if (($source.Split(@($mutant.Old), [StringSplitOptions]::None)).Length -ne 2) { throw 'Mutation anchor must be unique' }
            $source = $source.Replace($mutant.Old, $mutant.New)
            if ($mutant.ContainsKey('Old2')) {
                if (($source.Split(@($mutant.Old2), [StringSplitOptions]::None)).Length -ne 2) { throw 'Second mutation anchor must be unique' }
                $source = $source.Replace($mutant.Old2, $mutant.New2)
            }
            [IO.File]::WriteAllText($file, $source)
            $result = Invoke-Checks $root (Join-Path $Output "$($mutant.Name).log")
            $killed = $result.Code -ne 0 -and $result.Text -match 'COLLECTOR_(RUNTIME_MUTANT_SURVIVED|NATIVE_MUTANT_SURVIVED)'
            $summary += @{ name=$mutant.Name; killed=$killed; exitCode=$result.Code }
            Write-Output "$($mutant.Name): killed=$killed"
            if (-not $killed) { throw 'Mutant survived or failed without a behavioral assertion' }
        } finally { [IO.Directory]::Delete($root, $true) }
    }
} finally { [IO.File]::WriteAllText((Join-Path $Output 'summary.json'), (ConvertTo-Json -InputObject @($summary) -Depth 5)) }
Write-Output "WINDOWS_WITNESS_MUTANTS_KILLED $($summary.Count) RELEASE_HOLD"
