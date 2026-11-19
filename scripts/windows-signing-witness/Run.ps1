# Pack launcher owner: win-sac-sign; existing tagged box, pinned runtimes and collector enrollment owner: MAIN.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$Node,
 [Parameter(Mandatory)][string]$NodeSha256,
 [Parameter(Mandatory)][string]$Enrollment,
 [Parameter(Mandatory)][string]$EnrollmentSha256,
 [Parameter(Mandatory)][string]$Output,
 [ValidateSet('run','verify','cleanup')][string]$Mode='run'
)
$ErrorActionPreference='Stop'
# Check the caller before clearing the child's environment; otherwise CI markers disappear.
if ($Mode -ne 'verify') {
 foreach ($name in @('CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_WORKFLOW','GITHUB_JOB','RUNNER_ENVIRONMENT','TF_BUILD','BUILD_BUILDID')) {
  if ($null -ne [Environment]::GetEnvironmentVariable($name)) { throw 'WINDOWS_WITNESS_WITNESS_IN_CI' }
 }
}
if (-not $IsWindows -or [Environment]::OSVersion.Version.Build -lt 22000) { throw 'Existing Windows 11 box required' }
# Membership includes a filtered administrator's deny-only SID.
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try {
 if (@($identity.Groups | Where-Object Value -eq 'S-1-5-32-544').Count -ne 0) { throw 'A true standard account is required' }
} finally { $identity.Dispose() }
if (-not [IO.Path]::IsPathFullyQualified($Node) -or $NodeSha256 -cnotmatch '^[a-f0-9]{64}$' -or
 (Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $NodeSha256) { throw 'MAIN pinned Node required' }
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=$Node
$start.WorkingDirectory=$PSScriptRoot
$start.UseShellExecute=$false
$start.Environment.Clear()
$start.Environment['SystemRoot']=$env:SystemRoot
$start.Environment['WINDIR']=$env:SystemRoot
$start.Environment['PATH']=(Split-Path -Parent $Node)
foreach ($arg in @((Join-Path $PSScriptRoot 'run.mjs'),$Mode,$Enrollment,$EnrollmentSha256,$Output)) { $start.ArgumentList.Add($arg) }
$child=[Diagnostics.Process]::Start($start)
try { $child.WaitForExit(); $code=$child.ExitCode } finally { $child.Dispose() }
if ((Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant() -cne $NodeSha256) { throw 'Node changed during witness' }
exit $code
