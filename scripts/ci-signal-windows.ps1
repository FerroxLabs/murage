# Signal B3 qualification. Run only on a disposable elevated Windows test runner.
# Production never transfers ownership; only fresh test fixtures do so.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$account = 'msgsig' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$created = $false
$oldSid = $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID
$oldQualification = $env:MURAGE_TEST_WINDOWS_QUALIFICATION
$testExit = 1
try {
  $password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $user = New-LocalUser -Name $account -Password $password -Description 'Disposable Signal foreign-owner test fixture' -AccountNeverExpires
  $created = $true
  $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID = $user.SID.Value
  $env:MURAGE_TEST_WINDOWS_QUALIFICATION = '1'
  & pnpm exec vitest run --config scripts/signal-runtime.test-config.mjs server/channels/signal/storage.test.ts server/channels/signal/process-host.test.ts
  $testExit = $LASTEXITCODE
} finally {
  $env:MURAGE_TEST_WINDOWS_FOREIGN_OWNER_SID = $oldSid
  $env:MURAGE_TEST_WINDOWS_QUALIFICATION = $oldQualification
  if ($created) { Remove-LocalUser -Name $account }
}
exit $testExit
