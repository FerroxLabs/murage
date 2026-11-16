# Enrollment freeze producer: win-sac-sign; protected public-reference selection/install consumer: MAIN.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Collector,
    [Parameter(Mandatory)][string] $CollectorSha256,
    [Parameter(Mandatory)][string] $Template,
    [Parameter(Mandatory)][string] $TemplateSha256,
    [Parameter(Mandatory)][string] $Destination
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Inputs.ps1"
if (-not $IsWindows) { throw 'Existing admitted Windows host required' }
Assert-Pin $Collector $CollectorSha256; Assert-Pin $Template $TemplateSha256
$parent = [IO.Path]::GetDirectoryName($Destination); Assert-RealPath $parent $false
if (-not [IO.Path]::IsPathFullyQualified($Destination) -or [IO.Path]::GetFullPath($Destination) -cne $Destination -or (Test-Path -LiteralPath $Destination) -or (Test-Path -LiteralPath "$Destination.sha256")) { throw 'New absolute enrollment required' }
$checkout = [IO.Path]::GetFullPath("$PSScriptRoot/../../..")
if ($Destination.StartsWith($checkout + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Enrollment must stay outside checkout' }
Invoke-Clean $Collector @('--validate-enrollment', $Template, '--sha256', $TemplateSha256) ([IO.Path]::GetDirectoryName($Collector)) $parent
Assert-Pin $Collector $CollectorSha256; Assert-Pin $Template $TemplateSha256
$bytes = [IO.File]::ReadAllBytes($Template)
if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $TemplateSha256) { throw 'Template changed' }
$stream = [IO.FileStream]::new($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
$digest = [Text.Encoding]::ASCII.GetBytes($TemplateSha256 + "`n")
$stream = [IO.FileStream]::new("$Destination.sha256", [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($digest); $stream.Flush($true) } finally { $stream.Dispose() }
Write-Output 'WINDOWS_WITNESS_PUBLIC_ENROLLMENT_FROZEN RELEASE_HOLD; protected installation and independent pin selection remain MAIN duties'
