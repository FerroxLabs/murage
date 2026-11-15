# Owner: wg-proof. Tests both installed Windows PowerShell 5.1 and PowerShell 7.
param([string] $GuardDirectory)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'driver.mjs'))
if ($GuardDirectory) { $arguments += @('--guard-directory', $GuardDirectory) }
& node @arguments
exit $LASTEXITCODE
