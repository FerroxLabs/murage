# Native-core self-check owner: win-sac-sign; actual Windows boundary witness owner: MAIN.
$ErrorActionPreference = 'Stop'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $PSHOME $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' })
$start.ArgumentList.Add('-NoProfile'); $start.ArgumentList.Add('-NonInteractive'); $start.ArgumentList.Add('-File')
$start.ArgumentList.Add("$PSScriptRoot/SigningLease.selfcheck.ps1")
$start.Environment.Clear(); $start.Environment['POWERSHELL_TELEMETRY_OPTOUT'] = '1'
$start.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($start)
$child.WaitForExit()
if ($child.ExitCode -ne 0) { throw 'Lease checks failed' }
$child.Dispose()
Add-Type -Path @(Get-ChildItem "$PSScriptRoot/*.cs" | ForEach-Object FullName)
$checks = [ProcessChecks]::Run().GetAwaiter().GetResult()
Write-Output "process assertions $checks"
$checks = [SessionChecks]::Run().GetAwaiter().GetResult()
Write-Output "session assertions $checks"
$checks = [RunnerGateChecks]::Run().GetAwaiter().GetResult()
Write-Output "runner gate assertions $checks"
$checks = [NetworkChecks]::Run().GetAwaiter().GetResult()
Write-Output "network and host assertions $checks"
