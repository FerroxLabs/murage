# Native build producer: win-sac-sign; SDK/tree/restore pins and build execution consumer: MAIN.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Dotnet,
    [Parameter(Mandatory)][string] $DotnetSha256,
    [Parameter(Mandatory)][string] $SdkVersion,
    [Parameter(Mandatory)][string] $Intermediate,
    [Parameter(Mandatory)][string] $PackageRoot,
    [Parameter(Mandatory)][string] $Output
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Inputs.ps1"
if (-not $IsWindows -or $SdkVersion -cnotmatch '\A10\.0\.[0-9]+\z') { throw 'Pinned Windows .NET 10 SDK required' }
Assert-Pin $Dotnet $DotnetSha256
Assert-RealPath $Intermediate $false
Assert-RealPath $PackageRoot $false
Assert-RealPath ([IO.Path]::GetDirectoryName($Output)) $false
if (-not [IO.Path]::IsPathFullyQualified($Output) -or [IO.Path]::GetFullPath($Output) -cne $Output -or (Test-Path -LiteralPath $Output)) { throw 'New absolute output required' }
$checkout = [IO.Path]::GetFullPath("$PSScriptRoot/../../..")
foreach ($root in @($checkout, $Intermediate, [IO.Path]::GetDirectoryName($Dotnet))) {
    if ($Output.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output overlaps frozen inputs' }
}
if ($Intermediate.StartsWith($checkout + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build intermediates must be outside checkout' }
# MAIN separately measures/seals the complete SDK, native compiler and restored package trees.
$versionFile = Join-Path ([IO.Path]::GetDirectoryName($Dotnet)) "sdk/$SdkVersion/dotnet.dll"
Assert-RealPath $versionFile $true
Assert-RealPath (Join-Path $Intermediate 'project.assets.json') $true
$null = New-Item -ItemType Directory -Path $Output
$scratch = Join-Path $Output 'scratch'; $null = New-Item -ItemType Directory -Path $scratch
$selection = Join-Path $scratch 'global.json'
[IO.File]::WriteAllText($selection, (@{ sdk = @{ version = $SdkVersion; rollForward = 'disable'; allowPrerelease = $false } } | ConvertTo-Json -Depth 3))
Invoke-Clean $Dotnet @('publish', "$PSScriptRoot/WitnessCollector.csproj", '--no-restore', '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '-v:diag', "-bl:$scratch\publish.binlog", "-p:BaseIntermediateOutputPath=$Intermediate\", '--output', $Output) $scratch $scratch $PackageRoot
Assert-Pin $Dotnet $DotnetSha256
$binary = Join-Path $Output 'witness-collector.exe'; Assert-RealPath $binary $true
Write-Output 'WINDOWS_WITNESS_NATIVE_CORE_BUILT RELEASE_HOLD; secure administration must approve/sign final bytes separately'
