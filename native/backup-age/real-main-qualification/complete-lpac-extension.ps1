# Read-only confirmation of the already-applied grant, then fresh data/manifest.
# No icacls grant, application launch or job creation is present here.
param([Parameter(Mandatory=$true)][string]$Extension)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$prior='C:\Users\seand\AppData\Local\Temp\murage-b20-real-main-20260914-025600'
if($Extension -ne (Join-Path $prior 'extension-20260914-035100')){throw 'Unexpected extension path'}
$deadline='2026-09-14T04:21:55.6960312Z'
if([DateTime]::UtcNow -ge [DateTime]::Parse($deadline).ToUniversalTime()){throw 'Extension expired'}
$candidate=Join-Path $prior 'candidate-d70fe5a145d0'
$beforeFile=Join-Path $Extension 'code-acl-before.txt';$afterFile=Join-Path $Extension 'code-acl-after.txt'
foreach($file in @($beforeFile,$afterFile)){if((Get-Item -LiteralPath $file).Length -lt 100){throw 'ACL snapshot empty'}}
function Describe-Dacl([string]$Sddl,[bool]$RegularFile) {
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  $other=[Collections.Generic.List[object]]::new();$target=0
  foreach($ace in $descriptor.DiscretionaryAcl) {
    if($ace -is [Security.AccessControl.KnownAce] -and $ace.SecurityIdentifier.Value -eq 'S-1-15-2-2') {
      if($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $ace.AccessMask -ne 0x1200a9){throw 'Unexpected restricted-package ACE rights/type'}
      $target++
    } else {
      $bytes=[byte[]]::new($ace.BinaryLength);$ace.GetBinaryForm($bytes,0)
      $flags=[int]$ace.AceFlags
      if($RegularFile){$bytes[1]=$bytes[1] -band 252}
      $other.Add(@{key=[Convert]::ToBase64String($bytes);flags=$flags})
    }
  }
  return @{other=$other.ToArray();target=$target;protected=($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)}
}
$before=[IO.StreamReader]::new($beforeFile,[Text.Encoding]::Unicode)
$after=[IO.StreamReader]::new($afterFile,[Text.Encoding]::Unicode)
$entries=0;$fileInheritanceMetadataChanges=0
try {
  while(!$before.EndOfStream) {
    $beforePath=$before.ReadLine();if($beforePath -eq '' -and $before.EndOfStream){break}
    $afterPath=$after.ReadLine()
    if($beforePath -ne $afterPath -or !$beforePath.StartsWith('candidate-d70fe5a145d0',[StringComparison]::OrdinalIgnoreCase)){throw 'ACL snapshot path mismatch'}
    $item=Get-Item -Force -LiteralPath (Join-Path $prior $beforePath)
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse code entry refused'}
    $regularFile=!$item.PSIsContainer
    $a=Describe-Dacl $before.ReadLine() $regularFile;$b=Describe-Dacl $after.ReadLine() $regularFile
    if($a.protected -ne $b.protected -or $a.other.Count -ne $b.other.Count){throw 'Non-target ACE count/protection changed'}
    $remaining=[Collections.Hashtable]::new([StringComparer]::Ordinal)
    foreach($ace in $b.other){if(!$remaining.ContainsKey($ace.key)){$remaining[$ace.key]=[Collections.Generic.List[int]]::new()};$remaining[$ace.key].Add($ace.flags)}
    foreach($ace in ($a.other|Sort-Object @{Expression={$_.flags};Descending=$true})) {
      if(!$remaining.ContainsKey($ace.key)){throw "Non-target ACE rights/type/object/condition changed: $beforePath"}
      $flags=$remaining[$ace.key];$match=$flags.IndexOf($ace.flags)
      if($match -lt 0 -and $regularFile){for($i=0;$i -lt $flags.Count;$i++){if(($ace.flags -band $flags[$i]) -eq $ace.flags -and (($ace.flags -bxor $flags[$i]) -band 252) -eq 0){$match=$i;break}}}
      if($match -lt 0){throw "Non-target inheritance changed beyond permitted file OI/CI addition: $beforePath"}
      if($flags[$match] -ne $ace.flags){$fileInheritanceMetadataChanges++}
      $flags.RemoveAt($match)
    }
    if($a.target -ne 0 -or $b.target -lt 1){throw 'Expected new code RX grant absent or prior grant unexpected'}
    $entries++
  }
  if(!$after.EndOfStream -or $entries -ne 12248){throw 'ACL snapshot inventory mismatch'}
} finally {$before.Dispose();$after.Dispose()}
$classification=Get-Content -LiteralPath (Join-Path $prior 'classification-readonly.json') -Raw|ConvertFrom-Json
foreach($row in $classification.acls) {
  if(!$row.path.StartsWith($candidate,[StringComparison]::OrdinalIgnoreCase) -and (Get-Acl -LiteralPath $row.path).Sddl -cne $row.sddl){throw 'Ancestor ACL changed'}
  $old=[Security.AccessControl.RawSecurityDescriptor]::new($row.sddl)
  $current=[Security.AccessControl.RawSecurityDescriptor]::new((Get-Acl -LiteralPath $row.path).Sddl)
  if($old.Owner.Value -ne $current.Owner.Value -or $old.Group.Value -ne $current.Group.Value){throw 'Recorded owner/group changed'}
}
$manifest=Get-Content -LiteralPath (Join-Path $prior 'journey-manifest.json') -Raw|ConvertFrom-Json
foreach($pair in @(@($manifest.executable,$manifest.exeSha256),@((Join-Path $candidate 'resources\app.asar'),$manifest.asarSha256),@($manifest.nodeExecutable,$manifest.nodeSha256))) {
  if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pair[1]){throw 'Code/Node byte identity changed'}
}
$baseline=Get-Content -LiteralPath (Join-Path $prior 'real-main-qualification\evidence\source-files.json') -Raw|ConvertFrom-Json
foreach($entry in $baseline.PSObject.Properties) {
  if((Get-FileHash -LiteralPath (Join-Path (Join-Path $prior 'real-main-qualification\data') $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value.sha256){throw 'Prior synthetic bytes changed'}
}
$root=Join-Path $Extension 'real-main-qualification';$fixture=Join-Path $Extension 'fixture'
& $manifest.nodeExecutable (Join-Path $fixture 'seed.bundled.mjs') $root
if($LASTEXITCODE -ne 0){throw 'Fresh seed failed'}
& $manifest.nodeExecutable (Join-Path $fixture 'seed-check.mjs') $root
if($LASTEXITCODE -ne 0){throw 'Fresh seed integrity failed'}
$manifest.root=$root;$manifest.deadlineUtc=$deadline
foreach($entry in $manifest.fixtureFiles.PSObject.Properties){$manifest.fixtureFiles.($entry.Name)=(Get-FileHash -LiteralPath (Join-Path $fixture $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant()}
$manifest|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $Extension 'journey-manifest.json')
@{ok=$true;explicitUserExtension=$true;startUtc='2026-09-14T03:51:55.6960312Z';deadlineUtc=$deadline;confirmationRunsAllowed=1;priorRounds=2;priorCorrections=2;priorPreparationFailure='IdentityNotMappedException during account-name translation after successful code grant';readOnlyCorrection='RawSecurityDescriptor SID and binary ACE comparison, with explicitly admitted regular-file-only OI/CI additions';aclEntriesCompared=$entries;fileOnlyInheritanceMetadataChanges=$fileInheritanceMetadataChanges;nonTargetEffectiveAccessPreserved=$true;directoryInheritancePreserved=$true;recordedOwnersGroupsUnchanged=$true;ancestorAclsUnchanged=$true;originalSeedBytesUnchanged=$true;originalDataUserDataAclComparison='passed in initial preparation before SID translation failure';codeBytesUnchanged=$true;aclBeforeSha256=(Get-FileHash -LiteralPath $beforeFile -Algorithm SHA256).Hash.ToLowerInvariant();aclAfterSha256=(Get-FileHash -LiteralPath $afterFile -Algorithm SHA256).Hash.ToLowerInvariant();newSeed=$root;finishedUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Extension 'lpac-extension-preparation.json')
Get-Content -LiteralPath (Join-Path $Extension 'lpac-extension-preparation.json') -Raw
