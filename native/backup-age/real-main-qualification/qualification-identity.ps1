function Resolve-QualificationAccountSid([string]$Account) {
  try {
    return [Security.Principal.NTAccount]::new($Account).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {
    throw 'Qualification account could not be resolved'
  }
}

function Confirm-QualificationProfile([string]$Account,[string]$DesktopSid,[string]$ProfileRoot) {
  if ((Resolve-QualificationAccountSid $Account) -ne $DesktopSid) {
    throw 'Qualification account and desktop SID do not match'
  }

  try {
    $key = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $DesktopSid
    $registered = Get-ItemPropertyValue -LiteralPath $key -Name ProfileImagePath -ErrorAction Stop
    if ($registered -isnot [string] -or $registered -notmatch '^[A-Za-z]:[\\/]' -or $ProfileRoot -notmatch '^[A-Za-z]:[\\/]') {
      throw 'Expected drive-absolute paths'
    }
    $registered = [IO.Path]::GetFullPath($registered)
    $provided = [IO.Path]::GetFullPath($ProfileRoot)
  } catch {
    throw 'Qualification profile could not be resolved from ProfileList'
  }
  if (![string]::Equals($registered,$provided,[StringComparison]::Ordinal)) {
    throw 'Qualification profile root does not match ProfileList'
  }
  return $registered
}
