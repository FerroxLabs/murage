# Stage only on MAIN's disposable PC. Never replace an existing installation.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PackageZip,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows required' }
. (Join-Path $PSScriptRoot 'gate-paths.ps1')
$root = 'C:\murage-ci'
[void](Assert-GatePath $PSScriptRoot)
[void](Assert-GatePath $PackageZip)
[void](Assert-GatePath $root)
$target = Join-Path $root 'app'
[void](Assert-GatePath $target)
$zip = (Resolve-Path -LiteralPath $PackageZip).Path
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if ($actual -ne $Sha256) { throw "Package SHA256 mismatch: expected $Sha256, got $actual" }
if (Test-Path -LiteralPath $target) { throw "$target already exists; use a fresh disposable PC/staging directory" }
New-GateDirectory $root
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Staging root must not be a reparse point' }
$staging = Join-Path $root ('unpack-' + [Guid]::NewGuid().ToString('N'))
New-GateDirectory $staging
$archive = $null
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $Sha256) { throw 'Package changed before extraction' }
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    # Reject traversal, NTFS streams, device names, aliases and Unix symlinks.
    if ([IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or $name -match '[\x00-\x1f]') { throw "Unsafe ZIP path: $name" }
    foreach ($part in $name.TrimEnd('\').Split('\')) {
      if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw "Unsafe ZIP component: $name" }
    }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "ZIP symlink refused: $name" }
    $destination = [IO.Path]::GetFullPath((Join-Path $staging $name))
    if (-not $destination.StartsWith($staging + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "ZIP escaped staging: $name" }
    if (-not $seen.Add($destination.TrimEnd('\'))) { throw "Duplicate ZIP path: $name" }
    [void](Assert-GatePath $destination)
    if ($name.EndsWith('\')) { New-Item -ItemType Directory -Path $destination -Force | Out-Null; continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
  }
  $archive.Dispose(); $archive = $null
  $candidates = @(Get-ChildItem -LiteralPath $staging -Filter Murage.exe -File -Recurse)
  if ($candidates.Count -ne 1) { throw 'ZIP must contain exactly one Murage.exe' }
  $appRoot = $candidates[0].DirectoryName
  if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'resources\app.asar') -PathType Leaf)) { throw 'Missing packaged resources/app.asar' }
  $version = $candidates[0].VersionInfo.ProductVersion
  if ($version -notmatch '^1\.0\.19(?:$|[.+-])') { throw 'Expected a Murage 1.0.19 candidate' }
  $exeHash = (Get-FileHash -LiteralPath $candidates[0].FullName -Algorithm SHA256).Hash
  $provenanceFile=Join-Path $appRoot 'resources\build-provenance.json'
  [void](Assert-GatePath $provenanceFile)
  $provenance=Get-Content -LiteralPath $provenanceFile -Raw | ConvertFrom-Json
  if($provenance.commit -notmatch '^[a-f0-9]{40}$'){throw 'Missing package build provenance'}
  [void](Assert-GatePath $target)
  Move-Item -LiteralPath $appRoot -Destination $target
  # Keep wrapper paths short for the Task Scheduler action. The repository
  # checkout containing this script is the source of the gate and driver.
  $scripts = Split-Path -Parent $PSScriptRoot
  foreach ($name in @('run-interactive.ps1', 'desktop-task.ps1', 'owned-process.ps1', 'gate-paths.ps1', 'run-ledger.ps1', 'gate-admission.ps1', 'ownership.ps1', 'finalize-receipt.ps1', 'gate-task-helper.ps1')) {
    $source = Join-Path $PSScriptRoot $name
    $destination = Join-Path $root $name
    [void](Assert-GatePath $source);[void](Assert-GatePath $destination)
    if ([IO.Path]::GetFullPath($source) -ne $destination) { Copy-Item -LiteralPath $source -Destination $destination }
  }
  $gateSource=Assert-GatePath (Join-Path $scripts 'windows-hide-desktop-gate.ps1')
  $gateDestination=Assert-GatePath (Join-Path $root 'windows-hide-desktop-gate.ps1')
  Copy-Item -LiteralPath $gateSource -Destination $gateDestination
  [void](Assert-GatePath (Join-Path $root 'stage.json'))
  [ordered]@{
    commit=$provenance.commit; appManifest=@(Get-AppManifest $target)
    package=$zip; packageSha256=$actual; executable=(Join-Path $target 'Murage.exe')
    executableSha256=$exeHash; version=$version; stagedAt=[DateTime]::UtcNow.ToString('O')
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $root 'stage.json') -Encoding UTF8
  Get-Content -LiteralPath (Join-Path $root 'stage.json') -Raw
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  if (Test-Path -LiteralPath $staging) { [void](Assert-GatePath $staging); Remove-Item -LiteralPath $staging -Recurse -Force }
}
