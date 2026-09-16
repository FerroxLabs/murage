# Artifact-only staging. Never starts an app, keygen, job or scheduled task.
param([Parameter(Mandatory=$true)][string]$Parent,[Parameter(Mandatory=$true)][string]$ApplicationZip,[Parameter(Mandatory=$true)][string]$ZipSha256)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$candidate=Join-Path $Parent 'candidate-d70fe5a145d0'
if((Get-FileHash -LiteralPath $ApplicationZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ZipSha256){throw 'Application ZIP SHA mismatch'}
if(Test-Path -LiteralPath $candidate){throw 'Candidate directory already exists; do not overwrite/adopt'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($ApplicationZip)
try {
  foreach($entry in $zip.Entries) {
    $name=$entry.FullName.Replace('/','\')
    if([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or $name.Split('\') -contains '..'){throw 'Unsafe application ZIP entry'}
    $target=[IO.Path]::GetFullPath((Join-Path $candidate $name))
    if(!$target.StartsWith($candidate+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Application ZIP entry escapes candidate'}
  }
} finally {$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($ApplicationZip,$candidate)
$executables=@(Get-ChildItem -LiteralPath $candidate -Filter 'Murage.exe' -Recurse -File)
if($executables.Count -ne 1){throw 'Expected one application executable'}
$exe=$executables[0].FullName
$asar=Join-Path (Split-Path $exe) 'resources\app.asar'
$fixture=Join-Path $Parent 'fixture'
$hashes=[ordered]@{}
foreach($name in @('run.ps1','OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs')) {
  $hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $fixture $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest=[ordered]@{
  root=(Join-Path $Parent 'real-main-qualification');executable=$exe;
  candidateSha='d70fe5a145d06fe57b16dc6b58e19893ff24cb81';workflowRunId='34801308201';artifactId='10331553736';
  artifactWrapperSha256='4dc46bd304e7ede7bcd6ac8c90004a9cdaf8e343da84816247edd175978fcfb1';
  artifactArchive=$ApplicationZip;artifactSha256=$ZipSha256;
  exeSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();
  asarSha256=(Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant();
  nodeExecutable='C:\Program Files\nodejs\node.exe';nodeSha256='b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3';
  sid='S-1-5-21-3954847422-1325544036-2038804778-1001';sessionId=1;deadlineUtc='2026-09-14T03:56:00Z';fixtureFiles=$hashes
}
$manifestPath=Join-Path $Parent 'journey-manifest.json'
if(Test-Path -LiteralPath $manifestPath){throw 'Manifest already exists'}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
[pscustomobject]@{manifest=$manifestPath;candidate=$candidate;executable=$exe;appStarted=$false;utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
