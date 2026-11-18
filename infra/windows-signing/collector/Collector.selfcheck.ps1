# Codec/check producer: win-sac-sign; native Windows/adapters and qualification consumer: MAIN.
$ErrorActionPreference = 'Stop'
$references = @(Get-ChildItem "$PSHOME/ref/*.dll" | ForEach-Object FullName)
if ($references.Count -eq 0) { throw 'Reference assemblies required' }
$sources = @("$PSScriptRoot/WitnessCodec.cs", "$PSScriptRoot/HeldFile.cs", "$PSScriptRoot/Program.cs", "$PSScriptRoot/../boundary/SigningProcess.cs", "$PSScriptRoot/../boundary/WindowsSigningProcessApi.cs", "$PSScriptRoot/Codec.selfcheck.cs", "$PSScriptRoot/ResourceJournal.cs", "$PSScriptRoot/CaptureWriter.cs", "$PSScriptRoot/ProcessReaper.cs", "$PSScriptRoot/Runtime.selfcheck.cs")
$sources += @(Get-ChildItem "$PSScriptRoot/adapters/*.cs" -ErrorAction SilentlyContinue | ForEach-Object FullName)
$sources += @(Get-ChildItem "$PSScriptRoot/reapers/*.cs" -ErrorAction SilentlyContinue | ForEach-Object FullName)
$sources += @(Get-ChildItem "$PSScriptRoot/*.cs" | Where-Object { $_.Name -in @('RecoveryEntry.cs', 'ReaperRegistry.cs', 'Supervisor.cs') } | ForEach-Object FullName)
Add-Type -Path $sources -ReferencedAssemblies $references
$count = [CollectorChecks]::Run()
$runtimeCount = [RuntimeChecks]::Run()
Write-Output "collector journal/recovery assertions $runtimeCount; RELEASE_HOLD"
foreach ($script in Get-ChildItem "$PSScriptRoot/*.ps1") {
    $tokens = $null; $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) { throw 'Collector script parse failed' }
}
$absent = Join-Path ([IO.Path]::GetTempPath()) ('collector-absent-' + [Guid]::NewGuid().ToString('N'))
$rejected = $false
try { & "$PSScriptRoot/Build.ps1" -Dotnet "$absent/dotnet.exe" -DotnetSha256 ('0' * 64) -SdkVersion '10.0.100' -Intermediate "$absent/obj" -PackageRoot "$absent/packages" -Output "$absent/output" }
catch { $rejected = $true }
if (-not $rejected -or (Test-Path -LiteralPath $absent)) { throw 'Build accepted missing trusted inputs' }
$count++
$rejected = $false
try { & "$PSScriptRoot/Enroll.ps1" -Collector "$absent/collector.exe" -CollectorSha256 ('0' * 64) -Template "$absent/template.json" -TemplateSha256 ('0' * 64) -PackageRoot "$absent/packages" -Destination "$absent/enrollment.json" }
catch { $rejected = $true }
if (-not $rejected -or (Test-Path -LiteralPath $absent)) { throw 'Enrollment accepted missing trusted inputs' }
$count++
Write-Output "collector codec assertions $count; native Windows/adapters unqualified; RELEASE_HOLD"
