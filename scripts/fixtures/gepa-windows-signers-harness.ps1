param([Parameter(Mandatory=$true)][string]$Repo, [Parameter(Mandatory=$true)][string]$Work)
# Runs the real native/gepa sign-list and verify scripts on a fixture PE tree. Only the two signature readers are
# replaced: Get-AuthenticodeSignature models the runner's catalog database (a catalog entry vouches for the image
# bytes whatever the embedded signature says), Get-EmbeddedPublisher reads the fixture's embedded signer.
$ErrorActionPreference = 'Stop'
$gepa = Join-Path $Repo 'native/gepa'
New-Item -ItemType Directory -Force -Path (Join-Path $Work 'evidence') | Out-Null
function New-Pe([string]$Path) {
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    $bytes = [byte[]]::new(128); $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[0x3c] = 0x40
    $bytes[0x40] = 0x50; $bytes[0x41] = 0x45; $bytes[0x44] = 0x64; $bytes[0x45] = 0x86
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}
function New-Tree([string]$Name) {
    $root = Join-Path $Work $Name
    foreach ($file in @('gepa-worker.exe', '_internal/python313.dll', '_internal/_socket.pyd', '_internal/VCRUNTIME140.dll', '_internal/vcruntime140_1.dll', '_internal/nested/VCRUNTIME140.dll')) { New-Pe (Join-Path $root $file) }
    Set-Content -LiteralPath (Join-Path $root '_internal/base_library.zip') -Value 'not an image'
    return $root
}
$script:Embedded = @{}; $script:Catalog = @{}
function Set-Signers([string]$Root, [hashtable]$Embedded, [string[]]$Catalog) {
    $script:Embedded = @{}; $script:Catalog = @{}
    foreach ($key in $Embedded.Keys) { $script:Embedded[[System.IO.Path]::GetFullPath((Join-Path $Root $key))] = $Embedded[$key] }
    foreach ($key in $Catalog) { $script:Catalog[[System.IO.Path]::GetFullPath((Join-Path $Root $key))] = $true }
}
function New-Signer([string]$Name) {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=`"$Name`"", [System.Security.Cryptography.ECDsa]::Create(), [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    return $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
}
$script:Certificates = @{}
function Get-Signer([string]$Name) { if (-not $script:Certificates[$Name]) { $script:Certificates[$Name] = New-Signer $Name }; return $script:Certificates[$Name] }
$readers = {
    function Get-AuthenticodeSignature([string]$LiteralPath) {
        $path = [System.IO.Path]::GetFullPath($LiteralPath)
        if ($script:Catalog[$path]) { return [pscustomobject]@{ Status = 'Valid'; SignatureType = 'Catalog'; SignerCertificate = (Get-Signer 'Microsoft Windows'); TimeStamperCertificate = (Get-Signer 'Timestamp') } }
        $name = $script:Embedded[$path]
        if (-not $name) { return [pscustomobject]@{ Status = 'NotSigned'; SignatureType = 'None'; SignerCertificate = $null; TimeStamperCertificate = $null } }
        return [pscustomobject]@{ Status = 'Valid'; SignatureType = 'Authenticode'; SignerCertificate = (Get-Signer $name); TimeStamperCertificate = (Get-Signer 'Timestamp') }
    }
    function Get-EmbeddedPublisher([string]$Path) { return $script:Embedded[[System.IO.Path]::GetFullPath($Path)] }
}
# Dot-source the real scripts into this scope, then let the readers above win (functions shadow cmdlets).
function Invoke-Gepa([string]$Script, [hashtable]$Arguments) {
    if (-not (Test-Path -LiteralPath (Join-Path $gepa $Script))) { return "missing $Script" }
    $source = Get-Content -Raw -LiteralPath (Join-Path $gepa $Script)
    $signers = ". (Join-Path `$PSScriptRoot 'windows-signers.ps1')"
    # Readers go after the shared helper (or, for a verifier without one, after its first statement).
    if ($source.Contains($signers)) { $source = $source.Replace($signers, ". (Join-Path '$gepa' 'windows-signers.ps1'); . `$readers") }
    else { $source = $source.Replace("`$ErrorActionPreference = 'Stop'", "`$ErrorActionPreference = 'Stop'; . `$readers") }
    $block = [scriptblock]::Create($source)
    try { & $block @Arguments; return 'ok' } catch { return $_.Exception.Message }
}
$results = [ordered]@{}
$ms = 'Microsoft Corporation'; $us = 'Ferrox Labs, LLC'
$unsigned = @{ '_internal/VCRUNTIME140.dll' = $ms; '_internal/vcruntime140_1.dll' = $ms }

# 1. The signing list holds every image except the two contents-directory redistributables, relative to the list.
$root = New-Tree 'list'; Set-Signers $root $unsigned @()
$list = Join-Path $Work 'evidence/sign-list.txt'
$results.list = Invoke-Gepa 'sign-list-windows.ps1' @{ Bundle = $root; List = $list }
$listed = Get-Content -LiteralPath $list -ErrorAction SilentlyContinue | ForEach-Object { [System.IO.Path]::GetRelativePath($root, [System.IO.Path]::GetFullPath((Join-Path (Split-Path $list) $_))).Replace('\', '/') } | Sort-Object
$results.listed = $listed -join ','
# 2. A redistributable name without Microsoft's embedded signature is refused, never signed by us.
$root = New-Tree 'list-foreign'; Set-Signers $root @{ '_internal/VCRUNTIME140.dll' = $ms } @()
$results.listForeign = Invoke-Gepa 'sign-list-windows.ps1' @{ Bundle = $root; List = (Join-Path $Work 'evidence/foreign.txt') }

# 3-8. Verify the same signed tree with and without a catalog entry for the redistributables: one verdict.
$signed = @{ 'gepa-worker.exe' = $us; '_internal/python313.dll' = $us; '_internal/_socket.pyd' = $us; '_internal/nested/VCRUNTIME140.dll' = $us } + $unsigned
$resigned = @{} + $signed; $resigned['_internal/VCRUNTIME140.dll'] = $us
# What the folder-wide signing step produced: every image, Microsoft's runtime included, carries our signature.
$allOurs = @{} + $signed; foreach ($key in $unsigned.Keys) { $allOurs[$key] = $us }
foreach ($case in @(@('good', $signed), @('resigned', $resigned), @('allOurs', $allOurs))) {
    foreach ($withCatalog in @($false, $true)) {
        $root = New-Tree "$($case[0])-$withCatalog"
        Set-Signers $root $case[1] $(if ($withCatalog) { @('_internal/VCRUNTIME140.dll', '_internal/vcruntime140_1.dll') } else { @() })
        $results["$($case[0])Catalog$withCatalog"] = Invoke-Gepa 'verify-windows.ps1' @{ Bundle = $root; Receipt = (Join-Path $Work "evidence/$($case[0])-$withCatalog.json") }
    }
}
# 9. One of our images that a catalog claims for Microsoft is refused.
$root = New-Tree 'ours-catalog'; Set-Signers $root $signed @('_internal/python313.dll')
$results.oursCatalog = Invoke-Gepa 'verify-windows.ps1' @{ Bundle = $root; Receipt = (Join-Path $Work 'evidence/ours-catalog.json') }
$receipt = Get-Content -Raw -LiteralPath (Join-Path $Work 'evidence/good-True.json') -ErrorAction SilentlyContinue | ConvertFrom-Json
$results.receipt = ($receipt | Sort-Object path | ForEach-Object { "$($_.path.Replace('\', '/'))=$($_.publisher)" }) -join ','
$results | ConvertTo-Json -Compress
