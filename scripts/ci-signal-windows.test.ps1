# No local accounts, profiles or files are changed by this test. All operating
# system account/profile commands below are in-memory doubles in script scope.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'signal-windows-fixture-cleanup.ps1')
$script:passed = 0
$description = 'Disposable Signal foreign-owner test fixture'
$fixtureSid = 'S-1-5-21-100-200-300-1001'
$otherSid = 'S-1-5-21-100-200-300-1002'

function Assert-Equal($Actual, $Expected) {
  if (($Actual | ConvertTo-Json -Depth 8 -Compress) -cne ($Expected | ConvertTo-Json -Depth 8 -Compress)) {
    throw "Expected $($Expected | ConvertTo-Json -Compress); got $($Actual | ConvertTo-Json -Compress)"
  }
  $script:passed++
}
function Assert-Reject([scriptblock]$Action, [string]$Message) {
  $caught = $null
  try { & $Action } catch { $caught = $_ }
  if ($null -eq $caught -or $caught.Exception.Message -notlike "*$Message*") {
    throw "Expected rejection containing '$Message'; got '$caught'"
  }
  $script:passed++
}
function New-User($Name, $Description, $Sid = $fixtureSid) {
  [pscustomobject]@{ Name = $Name; Description = $Description; SID = [pscustomobject]@{ Value = $Sid } }
}
function New-Profile($Sid, $Path) {
  [pscustomobject]@{ SID = $Sid; LocalPath = $Path; Loaded = $false; Special = $false }
}
function Reset-Fixture {
  $script:users = @()
  $script:profiles = @()
  $script:directories = @()
  $script:remainingPaths = @()
  $script:events = @()
  $script:failProfileRemoval = $false
  $script:keepRegistration = $false
  $script:failEnumeration = $false
}
function Get-LocalUser {
  [CmdletBinding()]param()
  if ($script:failEnumeration) { throw 'Enumeration failed' }
  $script:users
}
function Get-CimInstance {
  [CmdletBinding()]param($ClassName, $Filter)
  Assert-Equal $ClassName 'Win32_UserProfile'
  if ($Filter) {
    $script:profiles | Where-Object { $Filter -ceq "SID = '$($_.SID)'" }
  } else { $script:profiles }
}
function Remove-CimInstance {
  [CmdletBinding()]param($InputObject)
  $script:events += 'profile:' + $InputObject.SID
  if ($script:failProfileRemoval) { throw 'Profile removal failed' }
  if (-not $script:keepRegistration) {
    $script:profiles = @($script:profiles | Where-Object { $_ -ne $InputObject })
  }
}
function Remove-LocalUser {
  [CmdletBinding()]param($SID)
  $script:events += 'account:' + $SID.Value
  $script:users = @($script:users | Where-Object { $_.SID.Value -cne $SID.Value })
}
function Test-Path {
  [CmdletBinding()]param($LiteralPath)
  $LiteralPath -in $script:remainingPaths
}
function Get-ItemProperty {
  [CmdletBinding()]param($LiteralPath, $Name)
  Assert-Equal $LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  Assert-Equal $Name 'ProfilesDirectory'
  [pscustomobject]@{ ProfilesDirectory = 'C:\Users' }
}
function Get-ChildItem {
  [CmdletBinding()]param($LiteralPath, [switch]$Directory, [switch]$Force, $Filter)
  Assert-Equal $LiteralPath 'C:\Users'
  Assert-Equal $Directory.IsPresent $true
  Assert-Equal $Force.IsPresent $true
  Assert-Equal $Filter 'msgsig*'
  $script:directories
}

# Description is an exact, case-sensitive authority marker. Near matches,
# missing descriptions, and the same marker on other account names cannot win.
$candidates = @(
  (New-User 'msgsigold' $description),
  (New-User 'MSGSIGuppercase' $description),
  (New-User 'msgsig' $description),
  (New-User 'msgsigordinary' 'Personal account'),
  (New-User 'msgsigempty' ''),
  (New-User 'msgsignull' $null),
  (New-User 'msgsigcase' $description.ToLowerInvariant()),
  (New-User 'msgsigspace' ($description + ' ')),
  (New-User 'msgsigprefix' ($description + ' extra')),
  (New-User 'other' $description),
  (New-User 'xmsgsigold' $description)
)
Assert-Equal @(Select-SignalFixtureAccounts @()) @()
Assert-Equal @((Select-SignalFixtureAccounts $candidates).Name) @('msgsigold', 'MSGSIGuppercase', 'msgsig')

# Stale fixtures are removed by SID, including profiles in a relocated root.
# Accounts with the same prefix but no exact marker, and their profiles, survive.
Reset-Fixture
$script:users = @($candidates[0], (New-User 'msgsigordinary' 'Personal account' $otherSid))
$script:profiles = @(
  (New-Profile $fixtureSid 'D:\Relocated\fixture'),
  (New-Profile $fixtureSid 'D:\Relocated\fixture.backup'),
  (New-Profile $otherSid 'C:\Users\msgsigordinary')
)
Remove-SignalFixtureAccounts
Assert-Equal $script:events @("profile:$fixtureSid", "profile:$fixtureSid", "account:$fixtureSid")
Assert-Equal @($script:users.Name) @('msgsigordinary')
Assert-Equal @($script:profiles.SID) @($otherSid)
Assert-Reject { Assert-NoSignalFixtureResidue } '1 msgsig* accounts, 1 registered profiles'
Assert-Equal $script:events @("profile:$fixtureSid", "profile:$fixtureSid", "account:$fixtureSid")

Reset-Fixture
$script:users = @((New-User 'msgsigold' $description))
Remove-SignalFixtureAccounts
Assert-Equal $script:events @("account:$fixtureSid")
Assert-NoSignalFixtureResidue

# A profile failure must retain the marked account for the next startup sweep.
foreach ($failure in @('loaded', 'special', 'remove', 'directory', 'registration', 'path')) {
  Reset-Fixture
  $script:users = @((New-User 'msgsigold' $description))
  $profile = New-Profile $fixtureSid 'C:\Users\msgsigold'
  $script:profiles = @($profile)
  switch ($failure) {
    'loaded' { $profile.Loaded = $true; $message = 'loaded or special' }
    'special' { $profile.Special = $true; $message = 'loaded or special' }
    'remove' { $script:failProfileRemoval = $true; $message = 'Profile removal failed' }
    'directory' { $script:remainingPaths = @($profile.LocalPath); $message = 'profile directory remains' }
    'registration' { $script:keepRegistration = $true; $message = 'profile registration remains' }
    'path' { $profile.LocalPath = ''; $message = 'profile has no path' }
  }
  Assert-Reject { Remove-SignalFixtureAccounts } $message
  Assert-Equal @($script:users.Name) @('msgsigold')
  Assert-Equal @($script:events | Where-Object { $_ -like 'account:*' }) @()
}
Reset-Fixture
$script:users = @((New-User 'msgsigold' $description "bad' OR SID = 'other"))
Assert-Reject { Remove-SignalFixtureAccounts } 'Invalid Signal fixture local account SID'
Assert-Equal $script:events @()

# Final assertions are read-only, and fail independently for accounts,
# registered profiles (even outside C:\Users) and orphaned profile directories.
foreach ($kind in @('account', 'profile', 'directory')) {
  Reset-Fixture
  switch ($kind) {
    'account' { $script:users = @((New-User 'msgsigpersonal' 'Personal account')); $message = '1 msgsig* accounts' }
    'profile' { $script:profiles = @((New-Profile $otherSid 'D:\Profiles\msgsigorphan')); $message = '1 registered profiles' }
    'directory' { $script:directories = @([pscustomobject]@{ Name = 'msgsigorphan' }); $message = '1 profile directories' }
  }
  Assert-Reject { Assert-NoSignalFixtureResidue } $message
  Assert-Equal $script:events @()
}
Reset-Fixture
$script:failEnumeration = $true
Assert-Reject { Remove-SignalFixtureAccounts } 'Enumeration failed'
Assert-Reject { Assert-NoSignalFixtureResidue } 'Enumeration failed'

# Parse the entry point as shipped, including its actual finally blocks.
foreach ($name in @('ci-signal-windows.ps1', 'signal-windows-fixture-cleanup.ps1', 'ci-signal-windows.test.ps1')) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$errors)
  Assert-Equal @($errors) @()
  if ($name -eq 'ci-signal-windows.ps1') {
    $entryAst = $ast
  }
}
# Keep the cleanup wired before creation and in finally, with the residue
# assertion in its own finally so cleanup exceptions cannot bypass it.
$qualification = @($entryAst.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
Assert-Equal $qualification.Count 1
Assert-Equal $qualification[0].Body.Statements[0].Extent.Text 'Remove-SignalFixtureAccounts'
$cleanup = $qualification[0].Finally.Statements[-1]
Assert-Equal ($cleanup -is [Management.Automation.Language.TryStatementAst]) $true
Assert-Equal $cleanup.Body.Statements.Count 1
Assert-Equal $cleanup.Body.Statements[0].Extent.Text 'Remove-SignalFixtureAccounts'
Assert-Equal $cleanup.Finally.Statements[-1].Extent.Text 'Assert-NoSignalFixtureResidue'
Write-Host "Signal fixture cleanup: $script:passed assertions passed (OS commands mocked)."
