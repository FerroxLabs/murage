# SPDX-License-Identifier: AGPL-3.0-or-later
# Owners: wg-winproof owns this launcher; wg-text owns the text checker it calls.
# One command in Windows PowerShell 5.1 or PowerShell 7:
#   & .\server\wipe-proof\windows-gate\run-windows.ps1
# From cmd: powershell -NoProfile -File server\wipe-proof\windows-gate\run-windows.ps1
# Only Node executes. Corpus command strings are never passed to a shell.
[CmdletBinding()]
param([string]$SummaryPath = (Join-Path ([IO.Path]::GetTempPath()) ('wipe-windows-gate-' + [Guid]::NewGuid().ToString('N') + '.json')))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This launcher requires Windows. Use node run.mjs for Linux classification evidence.'
    }
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodePath = $nodeCommand.Source
    $nodeVersion = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') {
        throw 'Cannot read the Node version.'
    }
    if ([int]$Matches[1] -lt 24) {
        throw 'Node 24 or newer is required. Install Node 24+, then run this command again.'
    }
    $runner = Join-Path $PSScriptRoot 'run.mjs'
    $previousVersion = [Environment]::GetEnvironmentVariable('WINDOWS_GATE_POWERSHELL_VERSION', 'Process')
    try {
        $env:WINDOWS_GATE_POWERSHELL_VERSION = $PSVersionTable.PSVersion.ToString()
        & $nodePath $runner --summary $summaryPath
        $gateExit = $LASTEXITCODE
    }
    finally {
        [Environment]::SetEnvironmentVariable('WINDOWS_GATE_POWERSHELL_VERSION', $previousVersion, 'Process')
    }
    Write-Host ('Summary: ' + $summaryPath)
    if ($gateExit -ne 0) { exit 1 }
    exit 0
}
catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
