param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$spec = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($spec.root)
$evidence = Join-Path $root 'evidence'
$appExe = [IO.Path]::GetFullPath($spec.executable)
$asar = Join-Path (Split-Path $appExe) 'resources\app.asar'
$toolsDir = Join-Path (Split-Path $appExe) 'resources\backup-tools\x64'
$deadline = [DateTime]::Parse($spec.deadlineUtc).ToUniversalTime()
$script:qualificationDeadline = $deadline
if ($deadline -le [DateTime]::UtcNow -or $deadline -gt [DateTime]::UtcNow.AddMinutes(60)) { throw 'Fresh root-admitted window required' }
if ($spec.candidateSha -notmatch '^[a-f0-9]{40}$' -or $spec.artifactId -eq '10329096257') { throw 'New source-matched candidate required' }
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $spec.sid) { throw 'Wrong desktop SID' }
if ((Get-Process -Id $PID).SessionId -ne $spec.sessionId -or $spec.sessionId -eq 0) { throw 'Wrong/noninteractive session' }
if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Limited token required' }
if (Test-Path (Join-Path $evidence 'invoked.json')) { throw 'No replay/adoption of prior invocation' }
function Assert-Hash([string]$File,[string]$Expected) {
  if ($Expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Artifact hash mismatch: $File" }
}
function Assert-LocalPath([string]$File) {
  if ($File -notmatch '^[A-Za-z]:\\') { throw 'Local DOS path required' }
  $cursor = $File
  while ($cursor) {
    $item = Get-Item -Force -LiteralPath $cursor
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse ancestry refused' }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }; $cursor = $parent
  }
  if (([IO.DriveInfo]::new([IO.Path]::GetPathRoot($File))).DriveFormat -ne 'NTFS') { throw 'NTFS required' }
}
Assert-LocalPath $root; Assert-LocalPath $appExe
Assert-Hash $appExe $spec.exeSha256; Assert-Hash $asar $spec.asarSha256
Assert-Hash $spec.artifactArchive $spec.artifactSha256
Assert-Hash $spec.nodeExecutable $spec.nodeSha256
foreach ($entry in $spec.fixtureFiles.PSObject.Properties) { Assert-Hash (Join-Path $PSScriptRoot $entry.Name) $entry.Value }
foreach ($required in @('run.ps1','OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs')) {
  if ($required -notin @($spec.fixtureFiles.PSObject.Properties.Name)) {throw 'Incomplete fixture closure'}
}
# Fixed raw pins copied from shared/windows-backup-tools.mjs at this source join.
Assert-Hash (Join-Path $toolsDir 'age.exe') '2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0'
Assert-Hash (Join-Path $toolsDir 'age-keygen.exe') '1549c7049be32695594bedd09bbd352a94b6013a9d5c43364f3c6cd7a09ab61c'
Assert-Hash (Join-Path $toolsDir 'LICENSE') 'afbdb4e07a359499db587ae632815809b1fc1670a92d5449af112ce9a67833a2'
foreach ($file in @($appExe,(Join-Path $toolsDir 'murage-backup-age.exe'))) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  $publisher=if ($signature.SignerCertificate) {$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)} else {''}
  if ($signature.Status -ne 'Valid' -or $publisher -ne 'Ferrox Labs, LLC') { throw 'Required Ferrox signer unavailable' }
}
if (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $appExe }).Count) { throw 'Extracted executable already in use' }
foreach ($name in @('data','user-data','home','temp','exports','keys','evidence')) { Assert-LocalPath (Join-Path $root $name) }
foreach ($name in @('roaming','local')) { [IO.Directory]::CreateDirectory((Join-Path $root "home\$name")) | Out-Null }
$childEnvironment = @{
  SystemRoot=$env:SystemRoot; WINDIR=$env:SystemRoot; SystemDrive=$env:SystemDrive;
  COMSPEC=(Join-Path $env:SystemRoot 'System32\cmd.exe');
  PATH=((Join-Path $env:SystemRoot 'System32')+';'+$env:SystemRoot);
  HOME=(Join-Path $root 'home'); USERPROFILE=(Join-Path $root 'home');
  APPDATA=(Join-Path $root 'home\roaming'); LOCALAPPDATA=(Join-Path $root 'home\local');
  TEMP=(Join-Path $root 'temp'); TMP=(Join-Path $root 'temp'); TMPDIR=(Join-Path $root 'temp');
  MURAGE_DATA_DIR=(Join-Path $root 'data'); MURAGE_USER_DATA=(Join-Path $root 'user-data')
}
$environmentBlock = (($childEnvironment.Keys | Sort-Object | ForEach-Object { "$_=$($childEnvironment[$_])" }) -join "`0")+"`0`0"
# Compiler scratch belongs to this driver; inherited SSH TEMP can name a missing drive.
$env:TEMP=Join-Path $root 'temp';$env:TMP=$env:TEMP
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedJob.cs')
. (Join-Path $PSScriptRoot 'dialogs.ps1')
Add-Type -AssemblyName System.Drawing
$job = [BackupQualificationJob]::new()
$receipt = [ordered]@{status='running';candidateSha=$spec.candidateSha;artifactId=$spec.artifactId;startedUtc=[DateTime]::UtcNow.ToString('o');steps=@()}
$ownerPid=$null;$newPid=$null
$receipt.keygenExits=@()
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'invoked.json')
function Wait-Condition([scriptblock]$Condition,[int]$Seconds=120) {
  $until=[DateTime]::UtcNow.AddSeconds($Seconds); if ($until -gt $deadline) {$until=$deadline}
  do { if (& $Condition) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $until)
  throw 'Expected outcome not observed within admitted deadline'
}
function Text-Visible([int]$OwnerPid,[string]$Text,[switch]$WindowsPath) {
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$OwnerPid)
  $nodes=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  return @($nodes | Where-Object { -not $_.Current.IsOffscreen -and $(if($WindowsPath){$_.Current.Name.IndexOf($Text,[StringComparison]::OrdinalIgnoreCase) -ge 0}else{$_.Current.Name.Contains($Text)}) }).Count -gt 0
}
function Save-Window([int]$OwnerPid,[string]$Name,[string]$File) {
  $window=Wait-OwnedElement $OwnerPid $Name
  $r=$window.Current.BoundingRectangle
  $bitmap=[Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try {
    $dc=$graphics.GetHdc()
    try { if (![BackupQualificationJob]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle,$dc,2)) { throw 'Owned window screenshot unavailable' } }
    finally { $graphics.ReleaseHdc($dc) }
    $bitmap.Save((Join-Path $evidence $File),[Drawing.Imaging.ImageFormat]::Png)
  }
  finally { $graphics.Dispose();$bitmap.Dispose() }
}
function Pick-Key([int]$OwnerPid,[string]$File) { Set-OwnedFileDialog $OwnerPid 'Choose an independent age recovery key file' $File 'Open' }
function Record-Step([string]$Name) { $receipt.steps += @{name=$Name;utc=[DateTime]::UtcNow.ToString('o');job=$job.Counts()} }
function Assert-OriginalBytes {
  $baseline=Get-Content -LiteralPath (Join-Path $evidence 'source-files.json') -Raw | ConvertFrom-Json
  foreach ($entry in $baseline.PSObject.Properties) { Assert-Hash (Join-Path (Join-Path $root 'data') $entry.Name) $entry.Value.sha256 }
}
try {
  foreach ($name in @('recovery.txt','wrong.txt')) {
    $keyPath=Join-Path $root "keys\$name"
    if (Test-Path $keyPath) {throw 'Synthetic key already exists'}
    $keyPid=$job.Start((Join-Path $toolsDir 'age-keygen.exe'),('-o "'+$keyPath+'"'),$root,$environmentBlock)
    Wait-Condition { $job.Exited($keyPid) } 30
    if ($job.ExitCode($keyPid) -ne 0) {throw 'Synthetic key generation exited unsuccessfully'}
    $receipt.keygenExits+=@{pid=$keyPid;exitCode=$job.ExitCode($keyPid)}
    if (!(Test-Path $keyPath)) {throw 'Synthetic key generation failed'}
  }
  $ownerPid=$job.Start($appExe,'--murage-backup-mode --force-renderer-accessibility',$root,$environmentBlock)
  $receipt.initialPid=$ownerPid
  $receipt.currentStep='wait-backup-heading'
  Wait-Condition { Text-Visible $ownerPid 'Backup mode' }
  $receipt.currentStep='wait-source-location'
  Wait-Condition { Text-Visible $ownerPid (Join-Path $root 'data') -WindowsPath }
  Save-Window $ownerPid 'Murage Backup mode' '01-backup-mode.png'
  Invoke-OwnedButton $ownerPid 'Create encrypted backup'
  $null=Wait-OwnedElement $ownerPid 'Save an encrypted application-data backup'
  Invoke-OwnedButton $ownerPid 'Cancel'
  Wait-Condition { $null -ne (Find-OwnedElement $ownerPid 'Create encrypted backup') }
  if (Test-Path (Join-Path $root 'exports\backup.age')) {throw 'Dialog cancellation published output'}
  if (@(Get-ChildItem -LiteralPath (Join-Path $root 'user-data') -Filter 'installation-selection-*.json').Count) {throw 'Dialog cancellation selected installation'}
  Assert-OriginalBytes
  Record-Step 'native-save-dialog-cancel'
  Invoke-OwnedButton $ownerPid 'Create encrypted backup'
  Set-OwnedFileDialog $ownerPid 'Save an encrypted application-data backup' (Join-Path $root 'exports\backup.age') 'Save'
  Pick-Key $ownerPid (Join-Path $root 'keys\recovery.txt')
  Invoke-OwnedButton $ownerPid 'Create encrypted backup'
  Wait-Condition { Text-Visible $ownerPid 'Encrypted application-data backup saved and verified:' } 600
  $archiveHash=(Get-FileHash -LiteralPath (Join-Path $root 'exports\backup.age') -Algorithm SHA256).Hash.ToLowerInvariant()
  Save-Window $ownerPid 'Murage Backup mode' '02-capture.png'
  Record-Step 'real-encrypted-capture'
  Invoke-OwnedButton $ownerPid 'Inspect encrypted backup'
  Set-OwnedFileDialog $ownerPid 'Choose an encrypted application-data backup' (Join-Path $root 'exports\backup.age') 'Open'
  Pick-Key $ownerPid (Join-Path $root 'keys\wrong.txt')
  Wait-Condition { Text-Visible $ownerPid 'The encrypted operation could not be verified.' } 180
  if (@(Get-ChildItem -LiteralPath (Join-Path $root 'user-data') -Filter 'installation-selection-*.json').Count) {throw 'Wrong key selected installation'}
  Assert-OriginalBytes
  Assert-Hash (Join-Path $root 'exports\backup.age') $archiveHash
  Save-Window $ownerPid 'Murage Backup mode' '03-wrong-key.png'
  Record-Step 'wrong-key-visible-refusal'
  Invoke-OwnedButton $ownerPid 'Inspect encrypted backup'
  Set-OwnedFileDialog $ownerPid 'Choose an encrypted application-data backup' (Join-Path $root 'exports\backup.age') 'Open'
  Pick-Key $ownerPid (Join-Path $root 'keys\recovery.txt')
  Wait-Condition { Text-Visible $ownerPid 'Backup inspected. No installation data has been changed.' } 180
  $disclosure=Wait-OwnedElement $ownerPid 'Snapshot identity'
  $disclosure.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Wait-Condition { Text-Visible $ownerPid $archiveHash }
  $pidCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$ownerPid)
  $nodes=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$pidCondition)
  $snapshotIds=@($nodes | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -match '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' } | ForEach-Object {$_.Current.Name} | Select-Object -Unique)
  if ($snapshotIds.Count -ne 1) {throw 'Visible inspected snapshot identity missing/ambiguous'}
  @{snapshotId=$snapshotIds[0];archiveSha256=$archiveHash} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'inspect-ui.json')
  Save-Window $ownerPid 'Murage Backup mode' '04-inspect.png'
  Record-Step 'real-inspect'
  Invoke-OwnedButton $ownerPid 'Restore encrypted backup separately for review'
  Invoke-OwnedButton $ownerPid 'Restore separately and restart for review'
  Wait-Condition { $job.Exited($ownerPid) } 600
  $receipt.initialExitCode=$job.ExitCode($ownerPid)
  if ($receipt.initialExitCode -ne 0) {throw 'Initial application exited unsuccessfully during relaunch'}
  $replacement=$null
  Wait-Condition {
    $candidates=@(foreach ($id in $job.ProcessIds()) {
      $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"
      if ($p -and $p.ExecutablePath -eq $appExe -and $p.CommandLine -notmatch '--type=|--murage-backup-mode') { $p }
    })
    if ($candidates.Count -eq 1) { $script:replacement=$candidates[0]; return $true }; return $false
  } 120
  $newPid=[uint32]$replacement.ProcessId; $job.Pin($newPid); $receipt.replacementPid=$newPid
  Wait-Condition { Text-Visible $newPid 'This restored installation is paused for recovery review.' }
  Save-Window $newPid 'Murage recovery' '05-restored-review.png'
  Record-Step 'owned-relaunch-paused-review'
  # Read-only verification uses ordinary Node only for SQLite/file assertions.
  $verifyPid=$job.Start($spec.nodeExecutable,('"'+(Join-Path $PSScriptRoot 'verify.mjs')+'" "'+$root+'"'),$root,$environmentBlock)
  Wait-Condition { $job.Exited($verifyPid) } 60
  $receipt.verifierExitCode=$job.ExitCode($verifyPid)
  if ($receipt.verifierExitCode -ne 0) {throw 'Offline restored-data verifier exited unsuccessfully'}
  $verified=Get-Content -LiteralPath (Join-Path $evidence 'data-verification.json') -Raw | ConvertFrom-Json
  if (!$verified.ok -or !(Text-Visible $newPid $verified.restored -WindowsPath)) {throw 'Restored UI location mismatch'}
  $acls=@(foreach ($item in @((Get-Item -Force -LiteralPath $verified.restored)) + @(Get-ChildItem -LiteralPath $verified.restored -Recurse -Force)) {
    $acl=Get-Acl -LiteralPath $item.FullName
    $allows=@($acl.Access | Where-Object {$_.AccessControlType -eq 'Allow'})
    foreach ($ace in $allows) {
      $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($sid -notin @($spec.sid,'S-1-5-18')) {throw 'Unexpected final restored allow SID'}
    }
    foreach ($requiredSid in @($spec.sid,'S-1-5-18')) {
      if (!@($allows | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $requiredSid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl}).Count) {throw 'Required private full-control ACE missing'}
    }
    @{path=$item.FullName;sddl=$acl.Sddl;protected=$acl.AreAccessRulesProtected}
  })
  $acls | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'final-acls.json')
  Assert-Hash $appExe $spec.exeSha256; Assert-Hash $asar $spec.asarSha256
  $window=Wait-OwnedElement $newPid 'Murage recovery'
  $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  Wait-Condition { $job.Counts().ActiveProcesses -eq 0 -and $job.HandlesClosed() } 45
  $receipt.replacementExitCode=$job.ExitCode($newPid)
  if ($receipt.replacementExitCode -ne 0) {throw 'Restored application did not close successfully'}
  $receipt.status='passed';$receipt.finalJob=$job.Counts();$receipt.pinnedHandlesClosed=$job.HandlesClosed()
} catch {
  $receipt.status='failed';$receipt.failure=$_.Exception.Message
  if ($ownerPid) {$receipt.initialExitedBeforeCleanup=$job.Exited($ownerPid)}
  if ($ownerPid -and $job.Exited($ownerPid)) {$receipt.initialExitCode=$job.ExitCode($ownerPid)}
  if ($newPid -and $job.Exited($newPid)) {$receipt.replacementExitCode=$job.ExitCode($newPid)}
  try {
    $uiPid=if($newPid -and !$job.Exited($newPid)){$newPid}else{$ownerPid}
    if($uiPid -and !$job.Exited($uiPid)) {
      $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$uiPid)
      $nodes=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
      @($nodes|Select-Object -First 500|ForEach-Object {
        $name=$_.Current.Name -replace 'AGE-SECRET-KEY-1[A-Z0-9]+','[REDACTED RECOVERY KEY]'
        if($name.Length -gt 1500){$name=$name.Substring(0,1500)}
        @{name=$name;type=$_.Current.ControlType.ProgrammaticName;id=$_.Current.AutomationId;offscreen=$_.Current.IsOffscreen}
      })|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $evidence 'failure-ui.json')
    }
  } catch {$receipt.uiDiagnosticFailure=$_.Exception.Message}
  $receipt.beforeCleanupJob=$job.Counts()
  $job.StopOwned()
  # Cleanup has its own bounded allowance even when the execution window expired.
  # This permits only closure observation after terminating the already-owned job.
  $cleanupUntil=[DateTime]::UtcNow.AddSeconds(15)
  do {
    if ($job.Counts().ActiveProcesses -eq 0 -and $job.HandlesClosed()) {break}
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $cleanupUntil)
  if ($job.Counts().ActiveProcesses -ne 0 -or !$job.HandlesClosed()) {$receipt.cleanupUnconfirmed=$true}
  $receipt.finalJob=$job.Counts();$receipt.pinnedHandlesClosed=$job.HandlesClosed()
  if ($ownerPid -and $job.Exited($ownerPid)) {$receipt.initialExitCode=$job.ExitCode($ownerPid)}
  if ($newPid -and $job.Exited($newPid)) {$receipt.replacementExitCode=$job.ExitCode($newPid)}
} finally {
  $receipt.finishedUtc=[DateTime]::UtcNow.ToString('o')
  $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence 'journey.json')
  $job.Dispose()
}
if ($receipt.status -ne 'passed') {exit 1}
