[CmdletBinding()]
param([string]$Fixture,[ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,[int]$OldPid)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:COMPUTERNAME -ine 'gate-win-nogit' -or $env:USERNAME -cne 'murage-gate'){throw 'Only gate-owned default profile may install'}
$installed=Join-Path $env:LOCALAPPDATA 'Programs\Murage\Murage.exe'
$deadline=[DateTime]::UtcNow.AddSeconds(240)
$found=$null
try {
  do {
    foreach($p in @(Get-Process | Where-Object {$_.Id -ne $OldPid -and $_.Path -eq $installed -and $_.MainWindowHandle -ne 0})) {
      if($p.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){continue}
      if($p.StartTime.ToUniversalTime() -lt [DateTime]::UtcNow.AddMinutes(-5)){continue}
      $found=$p;break
    }
    if($found){break};Start-Sleep -Milliseconds 250
  }while([DateTime]::UtcNow -lt $deadline)
  if(-not $found){throw 'Updater did not relaunch installed app on the gate desktop'}
  $actual=(Get-Item -LiteralPath $installed).VersionInfo.ProductVersion
  if($actual -ne $Version){throw "Installed version $actual differs from fixture $Version"}
  $signature=Get-AuthenticodeSignature -LiteralPath $installed
  if($signature.Status -ne 'Valid'){throw 'Installed app signature invalid'}
  $proof=@{pid=$found.Id;oldPid=$OldPid;path=$installed;version=$actual;sessionId=$found.SessionId;window=$found.MainWindowHandle.ToInt64();sha256=(Get-FileHash -LiteralPath $installed).Hash;signature=$signature.Status.ToString()}
  $proof | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Fixture 'evidence\relaunch.json') -Encoding UTF8
  $proof | ConvertTo-Json -Compress
} finally {
  # Ownership is proved by the enclosing job. Never kill a process found by path.
}
