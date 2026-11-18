# Signal B3 qualification. Run only on a disposable elevated Windows test runner.
# Production never transfers ownership; only fresh test fixtures do so.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'signal-windows-fixture-cleanup.ps1')
$account = 'msgsig' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$oldSid = $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID
$oldQualification = $env:MURAGE_TEST_WINDOWS_QUALIFICATION
$testExit = 1
try {
  Remove-SignalFixtureAccounts
  $password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $account -Password $password -Description 'Disposable Signal foreign-owner test fixture' -AccountNeverExpires
  $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID = $user.SID.Value
  $env:MURAGE_TEST_WINDOWS_QUALIFICATION = '1'
  & pnpm exec vitest run --config scripts/signal-runtime.test-config.mjs server/channels/signal/storage.test.ts server/channels/signal/process-host.test.ts
  $testExit = $LASTEXITCODE
} finally {
  $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID = $oldSid
  $env:MURAGE_TEST_WINDOWS_QUALIFICATION = $oldQualification
  try {
    Remove-SignalFixtureAccounts
  } finally {
    # A cleanup failure or any unproven orphan must fail qualification, even
    # when Vitest succeeded. Never remove an account just because of its name.
    Assert-NoSignalFixtureResidue
  }
}
exit $testExit
