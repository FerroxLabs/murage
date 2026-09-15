param([Parameter(Mandatory=$true)][string]$Extension)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$prior='C:\Users\seand\AppData\Local\Temp\murage-b20-real-main-20260914-025600'
$candidate=Join-Path $prior 'candidate-d70fe5a145d0'
if($Extension -ne (Join-Path $prior 'extension-20260914-035100')){throw 'Unexpected extension root'}
$deadline='2026-09-14T04:21:55.6960312Z'
if([DateTime]::UtcNow -ge [DateTime]::Parse($deadline).ToUniversalTime()){throw 'Extension deadline elapsed'}
if(Test-Path -LiteralPath (Join-Path $Extension 'lpac-extension-invoked.txt')){throw 'Extension already prepared'}
if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($candidate,[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Candidate process exists'}
$manifest=Get-Content -LiteralPath (Join-Path $prior 'journey-manifest.json') -Raw|ConvertFrom-Json
if($manifest.candidateSha -ne 'd70fe5a145d06fe57b16dc6b58e19893ff24cb81' -or $manifest.artifactId -ne '10331553736' -or $manifest.executable -ne (Join-Path $candidate 'Murage.exe')){throw 'Exact signed candidate binding mismatch'}
function Assert-UnchangedCode {
  if((Get-FileHash -LiteralPath $manifest.executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.exeSha256){throw 'Executable bytes changed'}
  if((Get-FileHash -LiteralPath (Join-Path $candidate 'resources\app.asar') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.asarSha256){throw 'ASAR bytes changed'}
}
Assert-UnchangedCode
if((Get-FileHash -LiteralPath $manifest.nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.nodeSha256){throw 'Existing Node identity changed'}
$protectedPaths=@($prior,(Join-Path $prior 'real-main-qualification\data'),(Join-Path $prior 'real-main-qualification\user-data'))
$protectedAclBefore=@{}
foreach($p in $protectedPaths){$protectedAclBefore[$p]=(Get-Acl -LiteralPath $p).Sddl}
foreach($item in @((Get-Item -Force -LiteralPath $candidate))+@(Get-ChildItem -LiteralPath $candidate -Recurse -Force)) {
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Candidate reparse point refused before ACL operation'}
}
$baseline=Get-Content -LiteralPath (Join-Path $prior 'real-main-qualification\evidence\source-files.json') -Raw|ConvertFrom-Json
foreach($entry in $baseline.PSObject.Properties) {
  if((Get-FileHash -LiteralPath (Join-Path (Join-Path $prior 'real-main-qualification\data') $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value.sha256){throw 'Prior synthetic source changed'}
}
[DateTime]::UtcNow.ToString('o')|Set-Content -LiteralPath (Join-Path $Extension 'lpac-extension-invoked.txt')
$icacls='C:\Windows\System32\icacls.exe'
& $icacls $candidate /save (Join-Path $Extension 'code-acl-before.txt') /T /L /Q
if($LASTEXITCODE -ne 0){throw 'Code ACL snapshot failed'}
# Exact existing NSIS customInstall grant. No ancestor or data ACL is touched.
& $icacls $candidate /grant '*S-1-15-2-2:(OI)(CI)(RX)' /T /L /Q
if($LASTEXITCODE -ne 0){throw 'Installer-equivalent code RX grant failed'}
& $icacls $candidate /save (Join-Path $Extension 'code-acl-after.txt') /T /L /Q
if($LASTEXITCODE -ne 0){throw 'Post-grant code ACL snapshot failed'}
foreach($p in $protectedPaths){if((Get-Acl -LiteralPath $p).Sddl -ne $protectedAclBefore[$p]){throw 'Non-code ACL changed'}}
$checked=0
foreach($item in @((Get-Item -Force -LiteralPath $candidate))+@(Get-ChildItem -LiteralPath $candidate -Recurse -Force)) {
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Candidate reparse point refused'}
  $acl=Get-Acl -LiteralPath $item.FullName
  if(!@($acl.Access|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-15-2-2' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute}).Count){throw 'Code RX grant missing'}
  $checked++
}
Assert-UnchangedCode
$fixture=Join-Path $Extension 'fixture'
$root=Join-Path $Extension 'real-main-qualification'
& $manifest.nodeExecutable (Join-Path $fixture 'seed.bundled.mjs') $root
if($LASTEXITCODE -ne 0){throw 'Fresh extension seed failed'}
& $manifest.nodeExecutable (Join-Path $fixture 'seed-check.mjs') $root
if($LASTEXITCODE -ne 0){throw 'Fresh extension seed integrity failed'}
$manifest.root=$root;$manifest.deadlineUtc=$deadline
foreach($entry in $manifest.fixtureFiles.PSObject.Properties) {
  $manifest.fixtureFiles.($entry.Name)=(Get-FileHash -LiteralPath (Join-Path $fixture $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $Extension 'journey-manifest.json')
@{ok=$true;explicitUserExtension=$true;startUtc='2026-09-14T03:51:55.6960312Z';deadlineUtc=$deadline;priorRounds=2;priorCorrections=2;confirmationRunsAllowed=1;code=$candidate;codeEntriesVerified=$checked;originalSeedUnchanged=$true;codeBytesUnchanged=$true;newSeed=$root;finishedUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Extension 'lpac-extension-preparation.json')
Get-Content -LiteralPath (Join-Path $Extension 'lpac-extension-preparation.json') -Raw
