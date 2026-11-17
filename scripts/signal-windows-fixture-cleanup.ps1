# Only the exact description grants authority to remove a local test account.
# A msgsig* name alone is never sufficient, even on a disposable runner.
function Select-SignalFixtureAccounts {
  param([object[]]$Users)
  $Users | Where-Object {
    $_.Name -like 'msgsig*' -and
    $_.Description -ceq 'Disposable Signal foreign-owner test fixture'
  }
}

function Remove-SignalFixtureAccounts {
  foreach ($user in @(Select-SignalFixtureAccounts @(Get-LocalUser -ErrorAction Stop))) {
    $sid = $user.SID.Value
    if ($sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') {
      throw 'Invalid Signal fixture local account SID.'
    }
    # Delete profiles by the selected account's SID, never by a path/name glob.
    # Keep the marked account until its profiles are gone so an interrupted
    # cleanup can be selected safely again on the next run.
    $filter = "SID = '$sid'"
    foreach ($profile in @(Get-CimInstance -ClassName Win32_UserProfile -Filter $filter -ErrorAction Stop)) {
      if ($profile.Loaded -or $profile.Special) {
        throw "Signal fixture profile is loaded or special: $sid"
      }
      $path = $profile.LocalPath
      if ([string]::IsNullOrWhiteSpace($path)) { throw "Signal fixture profile has no path: $sid" }
      Remove-CimInstance -InputObject $profile -ErrorAction Stop
      if (Test-Path -LiteralPath $path -ErrorAction Stop) {
        throw "Signal fixture profile directory remains: $path"
      }
    }
    if (@(Get-CimInstance -ClassName Win32_UserProfile -Filter $filter -ErrorAction Stop).Count -ne 0) {
      throw "Signal fixture profile registration remains: $sid"
    }
    Remove-LocalUser -SID $user.SID -ErrorAction Stop
  }
}

function Assert-NoSignalFixtureResidue {
  # Read-only name checks also catch unmarked accounts and orphaned directories.
  # Those are reported, never deleted: their fixture provenance is unknown.
  $users = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -like 'msgsig*' })
  $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop | Where-Object {
    (Split-Path -Leaf $_.LocalPath) -like 'msgsig*'
  })
  $profileRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -Name ProfilesDirectory -ErrorAction Stop).ProfilesDirectory
  if ([string]::IsNullOrWhiteSpace($profileRoot)) { throw 'Windows profile root is unavailable.' }
  $profileRoot = [Environment]::ExpandEnvironmentVariables($profileRoot)
  $directories = @(Get-ChildItem -LiteralPath $profileRoot -Directory -Force -Filter 'msgsig*' -ErrorAction Stop)
  if ($users.Count -or $profiles.Count -or $directories.Count) {
    throw "Signal fixture residue: $($users.Count) msgsig* accounts, $($profiles.Count) registered profiles, $($directories.Count) profile directories."
  }
}
