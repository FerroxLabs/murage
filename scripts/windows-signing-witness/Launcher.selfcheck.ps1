# Launcher/check producer owner: win-sac-sign; real Windows caller/execution consumer owner: MAIN.
$ErrorActionPreference = 'Stop'
$count = 0
$names = @('CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_WORKFLOW','GITHUB_JOB','RUNNER_ENVIRONMENT','TF_BUILD','BUILD_BUILDID')
$original = @{}
foreach ($name in $names) {
 $original[$name] = [Environment]::GetEnvironmentVariable($name)
 [Environment]::SetEnvironmentVariable($name, $null)
}
try {
foreach ($mode in @('run', 'cleanup')) {
 foreach ($name in $names) {
  $previous = [Environment]::GetEnvironmentVariable($name)
  try {
   [Environment]::SetEnvironmentVariable($name, 'false')
   $rejected = $false
   try {
    & "$PSScriptRoot/Run.ps1" -Mode $mode -Node 'C:\Absent\node.exe' -NodeSha256 ('0' * 64) -Enrollment 'C:\Absent\enrollment.json' -EnrollmentSha256 ('0' * 64) -Output 'C:\Absent\output'
   } catch { $rejected = $_.Exception.Message -ceq 'WINDOWS_WITNESS_WITNESS_IN_CI' }
   if (-not $rejected) { throw 'WINDOWS_WITNESS_LAUNCHER_MUTANT_SURVIVED' }
   $count++
  } finally { [Environment]::SetEnvironmentVariable($name, $previous) }
 }
}
} finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $original[$name]) } }
Write-Output "WINDOWS_WITNESS_LAUNCHER_CHECKS $count RELEASE_HOLD"
