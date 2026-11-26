# Artifact-only staging. Never starts an app, keygen, job or scheduled task.
param([Parameter(Mandatory=$true)][string]$Account,[Parameter(Mandatory=$true)][string]$DesktopSid,[Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][string]$Parent,[Parameter(Mandatory=$true)][string]$ApplicationZip,[Parameter(Mandatory=$true)][string]$ZipSha256)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'qualification-identity.ps1')
. (Join-Path $PSScriptRoot 'qualification-paths.ps1')
$ProfileRoot=Confirm-QualificationProfile $Account $DesktopSid $ProfileRoot
$admitted=Resolve-QualificationAdmitted $ProfileRoot 'murage-b20-real-main-20260914-025600'
if(![string]::Equals([IO.Path]::GetFullPath($Parent),$admitted,[StringComparison]::Ordinal)){throw 'Parent is not the admitted directory'}
$Parent=$admitted
# S1: fixture pins come from the repo copies; each Temp copy is opened no-follow and must match before anything is written.
$hashes=[ordered]@{}
foreach($name in @('run.ps1','OwnedJob.cs','dialogs.ps1','seed.ts','verify.mjs')) {
  $hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$lease=New-QualificationLease -Root $ProfileRoot -Directory $admitted
try {
foreach($name in $hashes.Keys){ Add-QualificationPin $lease ('fixture\'+$name) $hashes[$name] }
Test-QualificationOutputs $lease -Outputs @('journey-manifest.json')
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
$manifest=[ordered]@{
  root=(Join-Path $Parent 'real-main-qualification');executable=$exe;
  candidateSha='d70fe5a145d06fe57b16dc6b58e19893ff24cb81';workflowRunId='34801308201';artifactId='10331553736';
  artifactWrapperSha256='4dc46bd304e7ede7bcd6ac8c90004a9cdaf8e343da84816247edd175978fcfb1';
  artifactArchive=$ApplicationZip;artifactSha256=$ZipSha256;
  exeSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();
  asarSha256=(Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant();
  nodeExecutable='C:\Program Files\nodejs\node.exe';nodeSha256='b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3';
  sid=$DesktopSid;sessionId=1;deadlineUtc='2026-09-14T03:56:00Z';fixtureFiles=$hashes
}
# S2: serialize once, write through the CREATE_NEW no-follow handle, hash the same buffer.
$manifestBytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 6)+"`r`n")
Reserve-QualificationOutputs $lease
Write-QualificationOutput $lease 'journey-manifest.json' $manifestBytes
$manifestSha256=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($manifestBytes)).Replace('-','').ToLowerInvariant()
} finally { Close-QualificationLease $lease }
# S3: relative names only.
[pscustomobject]@{manifest='<admitted>\journey-manifest.json';manifestSha256=$manifestSha256;candidate='<admitted>\candidate-d70fe5a145d0';executable=('<admitted>\'+$exe.Substring($Parent.Length+1));appStarted=$false;utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
