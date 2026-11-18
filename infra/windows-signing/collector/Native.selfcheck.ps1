# Native check producer owner: win-sac-sign; isolated Windows execution/evidence consumer owner: MAIN.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $OutputParent)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows required' }
. "$PSScriptRoot/Inputs.ps1"
Assert-RealPath $OutputParent $false
. "$PSScriptRoot/Collector.selfcheck.ps1"
$count = 0
function Assert-Check([bool] $Pass) {
    if (-not $Pass) { throw 'COLLECTOR_NATIVE_MUTANT_SURVIVED' }
    $script:count++
}
function Assert-Rejected([scriptblock] $Action) {
    $refused = $false
    try { & $Action } catch { $refused = $true }
    Assert-Check $refused
}
$scratch = Join-Path $OutputParent ('collector-native-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($scratch)
$child = $null
try {
    $file = Join-Path $scratch 'capture.json'
    [IO.File]::WriteAllText($file, 'neutral observation')
    $held = [Murage.Witness.HeldFile]::new($file, 1024)
    try {
        Assert-Rejected { [IO.File]::WriteAllText($file, 'substituted') }
        Assert-Rejected { [IO.File]::Move($file, (Join-Path $scratch 'renamed.json')) }
        Assert-Rejected { [IO.Directory]::Move($scratch, "$scratch-moved") }
    } finally { $held.Dispose() }
    $link = Join-Path $scratch 'hardlink.json'
    $null = New-Item -ItemType HardLink -Path $link -Target $file
    Assert-Rejected { $bad = [Murage.Witness.HeldFile]::new($file, 1024); $bad.Dispose() }
    [IO.File]::Delete($link)
    $target = Join-Path $scratch 'target'; $null = [IO.Directory]::CreateDirectory($target)
    [IO.File]::WriteAllText((Join-Path $target 'capture.json'), 'neutral observation')
    $junction = Join-Path $scratch 'junction'
    $null = New-Item -ItemType Junction -Path $junction -Target $target
    try { Assert-Rejected { $bad = [Murage.Witness.HeldFile]::new((Join-Path $junction 'capture.json'), 1024); $bad.Dispose() } }
    finally { [IO.Directory]::Delete($junction) }
    $writer = [Murage.Witness.CaptureWriter]::new($scratch)
    try {
        $input = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('neutral policy observation'))
        try { $capture = $writer.Write('policy.json', $input) } finally { $input.Dispose() }
        try { Assert-Check ($capture.Bytes.Length -gt 0) } finally { $capture.Dispose() }
        $input = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('second observation'))
        try { Assert-Rejected { $bad = $writer.Write('policy.json', $input); $bad.Dispose() } } finally { $input.Dispose() }
    } finally { $writer.Dispose() }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $PSHOME 'pwsh.exe'; $start.UseShellExecute = $false
    $start.WorkingDirectory = $scratch; $start.CreateNoWindow = $true
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30')) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    $start.Environment['SystemRoot'] = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
    $start.Environment['WINDIR'] = $start.Environment['SystemRoot']
    $start.Environment['TEMP'] = $scratch; $start.Environment['TMP'] = $scratch
    $child = [Diagnostics.Process]::Start($start)
    $creation = $child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
    $resource = [Murage.Witness.RunResource]::new('process', $child.Id.ToString([Globalization.CultureInfo]::InvariantCulture), $creation)
    $wrong = [Murage.Witness.RunResource]::new('process', $resource.Id, ([long]::Parse($creation) + 1).ToString([Globalization.CultureInfo]::InvariantCulture))
    $reaper = [Murage.Witness.ProcessReaper]::new()
    Assert-Check (-not $reaper.Absent($resource))
    Assert-Check ($reaper.Absent($wrong))
    Assert-Rejected { $reaper.Destroy($wrong) }
    Assert-Check (-not $child.HasExited)
    $reaper.Destroy($resource)
    Assert-Check ($child.WaitForExit(5000))
    Assert-Check ($reaper.Absent($resource))
    $reaper.Destroy($resource)
    Assert-Check ($reaper.Absent($resource))
    $packageRoot = Join-Path $scratch 'packages'; $null = [IO.Directory]::CreateDirectory($packageRoot)
    $failure = $null
    try { Invoke-Clean (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile', '-NonInteractive', '-Command', "1..80 | ForEach-Object { 'neutral-line-' + `$_ }; [Console]::Error.WriteLine('neutral-tail-marker'); exit 7") $scratch $scratch $packageRoot } catch { $failure = $_.Exception.Message }
    Assert-Check ($null -ne $failure -and $failure.StartsWith('Pinned child refused: exit 7', [StringComparison]::Ordinal))
    Assert-Check ($failure.Contains('neutral-tail-marker') -and $failure.Contains('neutral-line-80') -and -not $failure.Contains('neutral-line-1' + "`n"))
    $count += [NativeRecoveryChecks]::Run($scratch, (Join-Path $PSHOME 'pwsh.exe'))
} finally {
    if ($null -ne $child) {
        try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } finally { $child.Dispose() }
    }
    foreach ($owned in @($scratch, "$scratch-moved")) { if ([IO.Directory]::Exists($owned)) { [IO.Directory]::Delete($owned, $true) } }
}
Write-Output "WINDOWS_WITNESS_NATIVE_ADAPTER_CHECKS $count RELEASE_HOLD"
