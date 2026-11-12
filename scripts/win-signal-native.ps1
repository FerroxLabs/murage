# Exactly the 11 real Windows cases in ci/gate-signal-native-windows.txt.
# Run on MAIN's disposable Desktop checkout, in elevated 64-bit PowerShell.
#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([string]$Repo = 'C:\murage-ci')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit PowerShell.' }
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
@'
if (process.platform !== "win32" || Number(process.versions.node.split(".")[0]) < 24) process.exit(1);
console.log(process.version, process.platform, process.arch);
'@ | & $node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Native Windows Node 24+ is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $Repo 'node_modules\vitest\vitest.mjs'))) {
  throw 'Provision dependencies first: pnpm install --frozen-lockfile --ignore-scripts'
}
$gatePath = Join-Path $Repo 'ci\gate-signal-native-windows.txt'
$rows = @(Get-Content -LiteralPath $gatePath | Where-Object { $_ -and -not $_.StartsWith('#') })
if ($rows.Count -ne 11) { throw 'Expected exactly 11 native Windows gates.' }
$names = @($rows | ForEach-Object { ($_ -split "`t", 2)[1] })
$pattern = '^(?:' + (($names | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$'
$files = @($rows | ForEach-Object { ($_ -split "`t", 2)[0] } | Select-Object -Unique)
$runId = [guid]::NewGuid().ToString('N')
$evidence = Join-Path $Repo ('evidence\signal-native-windows\' + $runId)
$scratch = Join-Path $Repo ('.signal-native-' + $runId)
$account = 'msgsig' + $runId.Substring(0, 10)
$created = $false
$transcribing = $false
$saved = @{}
$variables = @('TEMP', 'TMP', 'MURAGE_DATA_DIR', 'MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID', 'MURAGE_TEST_WINDOWS_QUALIFICATION')
foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
New-Item -ItemType Directory -Path $evidence, $scratch | Out-Null
$report = Join-Path $evidence 'vitest.json'
Push-Location $Repo
try {
  $env:TEMP = $scratch
  $env:TMP = $scratch
  $env:MURAGE_DATA_DIR = Join-Path $scratch 'app-data'
  # This local fixture user never logs in and has no Signal account.
  $password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $account -Password $password -Description 'Disposable Signal owner qualification fixture' -AccountNeverExpires
  $created = $true
  $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID = $user.SID.Value
  $env:MURAGE_TEST_WINDOWS_QUALIFICATION = '1'
  $arguments = @('node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/signal-runtime.test-config.mjs') + $files + @(
    '--no-file-parallelism', '--testNamePattern', $pattern, '--reporter=verbose', '--reporter=json', "--outputFile=$report"
  )
  Start-Transcript -LiteralPath (Join-Path $evidence 'vitest.log') | Out-Null
  $transcribing = $true
  & $node @arguments
  $testExit = $LASTEXITCODE
  if ($testExit -ne 0) { throw "Native Windows Vitest failed ($testExit); evidence: $evidence" }
  @'
import { assertGateReport } from "./scripts/signal-gate-report.mjs";
console.log(assertGateReport(process.argv[2], process.argv[3]));
'@ | & $node --input-type=module - $gatePath $report
  if ($LASTEXITCODE -ne 0) { throw 'Native qualification incomplete: missing, skipped, failed or extra executed cases.' }
  '11 passed / 0 failed / 0 skipped (selected gates)' | Tee-Object -FilePath (Join-Path $evidence 'summary.txt')
} finally {
  # Test finally/afterEach restores foreign owners, removes reparse tags and
  # deletes fixtures. Remove only this run's scratch; preserve all evidence.
  if ($transcribing) { Stop-Transcript -ErrorAction Continue | Out-Null }
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  try {
    if ($created) { Remove-LocalUser -Name $account }
  } finally {
    try { Remove-Item -LiteralPath $scratch -Recurse -Force } finally { Pop-Location }
  }
}
Write-Host "Native Windows qualification complete. Evidence: $evidence"
