# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run from MAIN's prepared Windows checkout; no engines, sign-ins or downloads.
[CmdletBinding()]
param([string]$ReportDirectory = '')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$oldCI = $env:CI
$printed = $false
Push-Location $root
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This gate requires a Windows host.' }
    $pin = (Get-Content -LiteralPath (Join-Path $root '.nvmrc') -Raw).Trim().TrimStart('v')
    $version = (& node -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch ('^' + [regex]::Escape($pin) + '(\.|$)')) {
        throw "Use Node $pin from .nvmrc (found $version)."
    }
    if (!(Test-Path -LiteralPath 'node_modules/vitest/vitest.mjs')) { throw 'Install the locked repository dependencies before running the gate.' }
    if (!$ReportDirectory) { $ReportDirectory = Join-Path $root '.test-tmp\win-gate' }
    $ReportDirectory = Join-Path $ReportDirectory ([guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $ReportDirectory -Force
    $ReportDirectory = (Resolve-Path $ReportDirectory).Path
    [Console]::Error.WriteLine("Windows test evidence: $ReportDirectory")
    $report = Join-Path $ReportDirectory 'vitest.json'
    $manifest = Join-Path $PSScriptRoot 'files.json'
    $files = @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json)
    if (!$files.Count) { throw 'The Windows gate file inventory is empty.' }
    foreach ($file in $files) {
        if (!(Test-Path -LiteralPath (Join-Path $root $file))) { throw "Missing gate file: $file" }
    }
    $env:CI = '1' # Never create/update missing snapshots at the release gate.
    # The link tests use both ordinary file links and directory junctions.
    # Fail a misconfigured rig explicitly; never convert it to a skipped suite.
    & node (Join-Path $PSScriptRoot 'preflight.mjs') $ReportDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Windows fixture prerequisites failed (Git and Developer Mode file symlinks are required).' }
    & node 'node_modules/vitest/vitest.mjs' run --config vite.config.ts '--tags-filter=!nightly && !perf-budget' --reporter=json "--outputFile=$report" @files
    $testExit = $LASTEXITCODE
    & node (Join-Path $PSScriptRoot 'result.mjs') $report $manifest $testExit
    $resultExit = $LASTEXITCODE
    $printed = $true
    if ($resultExit -ne 0) { exit 1 }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if (!$printed) { Write-Output 'WINTEST-RESULT files=0 pass=0 fail=1 skipped=0' }
    exit 1
} finally {
    $env:CI = $oldCI
    Pop-Location
}
exit 0
