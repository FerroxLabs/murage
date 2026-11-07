# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# WIN-BACKUP-RT-1018, CI only (ci.yml, "Round trip as a standard Windows user"). Runs as the local standard user that
# step creates, started with Start-Process -Credential, and runs ONE test file: the real Windows backup round trip,
# whose helper refuses an elevated token. Its exit code is the test's exit code. It holds no secret: the settings file
# names only folders, the node.exe to use and the test switches.
param([Parameter(Mandatory = $true)][string]$Settings)
$ErrorActionPreference = 'Stop'
$values = Get-Content -Raw -LiteralPath $Settings | ConvertFrom-Json
# The child starts with its own profile's environment, so the test switches are set here, from the settings file.
foreach ($name in @('TEMP', 'TMP', 'CI', 'MURAGE_TEST_WIN_BACKUP_TOOLS', 'MURAGE_TEST_REQUIRE_WIN_BACKUP_RT', 'MURAGE_TEST_RT_MUTANT')) {
  $value = [string]$values.$name
  if ($value) { Set-Item -LiteralPath "Env:$name" -Value $value } else { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
}
$env:PATH = (Split-Path -Parent $values.NODE) + ';C:\Windows\System32;C:\Windows'
Set-Location -LiteralPath $values.WORKSPACE
Write-Output ('Standard-user round trip as ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
& 'C:\Windows\System32\whoami.exe' /groups | Select-String -SimpleMatch 'Mandatory Label' | ForEach-Object { Write-Output ('Token: ' + $_.Line.Trim()) }
& $values.NODE 'node_modules/vitest/vitest.mjs' run 'server/installation-windows-backup-roundtrip.test.ts'
exit $LASTEXITCODE
