param([Parameter(Mandatory=$true)][string]$Bundle, [Parameter(Mandatory=$true)][string]$List)
# Writes the files-catalog for the pinned Azure signing action: every native image in the GEPA tree except Microsoft's
# Visual C++ redistributables, which must already carry Microsoft's own signature and are never re-signed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-signers.ps1')
$root = (Resolve-Path -LiteralPath $Bundle).Path
$listPath = [System.IO.Path]::GetFullPath($List)
if ($listPath.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Signing list must be outside the GEPA tree' }
$listDirectory = [System.IO.Path]::GetDirectoryName($listPath)
New-Item -ItemType Directory -Force -Path $listDirectory | Out-Null
$sign = @()
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName) {
    if (-not (Test-NativeImageName $file)) { continue }
    if (Test-MicrosoftRedistributable $root $file) { Assert-MicrosoftRedistributable $file | Out-Null; continue }
    # The action resolves each line against the catalog file's own folder.
    $sign += [System.IO.Path]::GetRelativePath($listDirectory, $file.FullName)
}
if ($sign.Count -eq 0) { throw 'No GEPA native images to sign' }
Set-Content -LiteralPath $listPath -Value $sign -Encoding utf8NoBOM
