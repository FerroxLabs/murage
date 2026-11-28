param([Parameter(Mandatory=$true)][string]$Repo, [Parameter(Mandatory=$true)][string]$Work)
# Runs the real native/gepa sign-list and verify scripts on a fixture PE tree. Only the two signature readers are
# replaced: Get-AuthenticodeSignature models the runner's catalog database (a catalog entry vouches for the image
# bytes whatever the embedded signature says), Get-EmbeddedPublisher / Get-EmbeddedCertificate read the fixture's
# embedded signer. Get-FileHash
# is real; the pinned-runtime cases swap the repo's pins for the fixture bytes' sha256, and one case keeps the repo pins.
$ErrorActionPreference = 'Stop'
$gepa = Join-Path $Repo 'native/gepa'
New-Item -ItemType Directory -Force -Path (Join-Path $Work 'evidence') | Out-Null
# Each fixture image's bytes carry its relative path, so every file has its own sha256 (the same in every tree).
function New-Pe([string]$Path, [string]$Tag) {
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    $bytes = [byte[]]::new(128); $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[0x3c] = 0x40
    $bytes[0x40] = 0x50; $bytes[0x41] = 0x45; $bytes[0x44] = 0x64; $bytes[0x45] = 0x86
    [System.Text.Encoding]::UTF8.GetBytes($Tag).CopyTo($bytes, 0x50)
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}
function New-Tree([string]$Name, [string[]]$Extra = @()) {
    $root = Join-Path $Work $Name
    foreach ($file in @('gepa-worker.exe', '_internal/python313.dll', '_internal/_socket.pyd', '_internal/VCRUNTIME140.dll', '_internal/vcruntime140_1.dll', '_internal/nested/VCRUNTIME140.dll') + $Extra) { New-Pe (Join-Path $root $file) $file }
    Set-Content -LiteralPath (Join-Path $root '_internal/base_library.zip') -Value 'not an image'
    return $root
}
$script:Embedded = @{}; $script:Catalog = @{}
# A catalog list marks entries signed by CN=Microsoft Windows (no O); a catalog hashtable maps each path to
# @{ Subject = <catalog signer DN>; Status = <status, default Valid> }.
function Set-Signers([string]$Root, [hashtable]$Embedded, $Catalog) {
    $script:Embedded = @{}; $script:Catalog = @{}
    foreach ($key in $Embedded.Keys) { $script:Embedded[[System.IO.Path]::GetFullPath((Join-Path $Root $key))] = $Embedded[$key] }
    if ($Catalog -is [hashtable]) { foreach ($key in $Catalog.Keys) { $script:Catalog[[System.IO.Path]::GetFullPath((Join-Path $Root $key))] = $Catalog[$key] } }
    else { foreach ($key in @($Catalog)) { $script:Catalog[[System.IO.Path]::GetFullPath((Join-Path $Root $key))] = $true } }
}
function New-FixtureRoot {
    $key = [System.Security.Cryptography.ECDsa]::Create()
    $root = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Fixture Root', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $root.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
    return $root.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-2), [DateTimeOffset]::UtcNow.AddDays(2))
}
$fixtureRoot = New-FixtureRoot
$otherRoot = New-FixtureRoot
$rootHash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
function New-Signer([string]$Name, [bool]$Alternate) {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=`"$Name`"", [System.Security.Cryptography.ECDsa]::Create(), [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    if ($Name -in @('Microsoft Corporation', 'Microsoft Windows')) {
        $root = if ($Alternate) { $otherRoot } else { $fixtureRoot }
        return $request.Create($root, [DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1), [Guid]::NewGuid().ToByteArray())
    }
    return $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
}
function New-SignerDn([string]$Subject) {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($Subject, [System.Security.Cryptography.ECDsa]::Create(), [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    return $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
}
# Ordinal keys: subjects differing only in case (O=microsoft corporation) must get their own certificate.
$script:Certificates = [hashtable]::new([StringComparer]::Ordinal); $script:SubjectCertificates = [hashtable]::new([StringComparer]::Ordinal)
function Get-SignerDn([string]$Subject) { if (-not $script:SubjectCertificates[$Subject]) { $script:SubjectCertificates[$Subject] = New-SignerDn $Subject }; return $script:SubjectCertificates[$Subject] }
function Get-Signer([string]$Name, [bool]$Alternate = $false) { $key = "${Alternate}:$Name"; if (-not $script:Certificates[$key]) { $script:Certificates[$key] = New-Signer $Name $Alternate }; return $script:Certificates[$key] }
$readers = {
    $script:MicrosoftSignerRootSha256 = @($fixtureRoot.GetCertHashString($rootHash))
    function New-MicrosoftSignerChain {
        $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.TrustMode = [System.Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
        $chain.ChainPolicy.CustomTrustStore.Add($fixtureRoot) | Out-Null
        $chain.ChainPolicy.CustomTrustStore.Add($otherRoot) | Out-Null
        return $chain
    }
    function Get-AuthenticodeSignature([string]$LiteralPath) {
        $path = [System.IO.Path]::GetFullPath($LiteralPath)
        $catalog = $script:Catalog[$path]
        if ($catalog -is [hashtable] -and $catalog.ContainsKey('Alternate')) { return [pscustomobject]@{ Status = 'Valid'; SignatureType = 'Catalog'; SignerCertificate = (Get-Signer 'Microsoft Windows' $catalog.Alternate); TimeStamperCertificate = (Get-Signer 'Timestamp') } }
        if ($catalog -is [hashtable]) { return [pscustomobject]@{ Status = $(if ($catalog.Status) { $catalog.Status } else { 'Valid' }); SignatureType = 'Catalog'; SignerCertificate = (Get-SignerDn $catalog.Subject); TimeStamperCertificate = (Get-Signer 'Timestamp') } }
        if ($catalog) { return [pscustomobject]@{ Status = 'Valid'; SignatureType = 'Catalog'; SignerCertificate = (Get-Signer 'Microsoft Windows'); TimeStamperCertificate = (Get-Signer 'Timestamp') } }
        $name = $script:Embedded[$path]
        # A full signature record: embedded signer plus what Get-AuthenticodeSignature reports for it.
        if ($name -is [hashtable]) { return [pscustomobject]@{ Status = $name.Status; SignatureType = $name.Type; SignerCertificate = (Get-SignerDn $name.Subject); TimeStamperCertificate = $(if ($name.Timestamped) { Get-Signer 'Timestamp' } else { $null }) } }
        if (-not $name) { return [pscustomobject]@{ Status = 'NotSigned'; SignatureType = 'None'; SignerCertificate = $null; TimeStamperCertificate = $null } }
        $alternate = $name -eq 'AlternateMicrosoft'
        $publisher = if ($alternate) { 'Microsoft Corporation' } else { $name }
        return [pscustomobject]@{ Status = 'Valid'; SignatureType = 'Authenticode'; SignerCertificate = (Get-Signer $publisher $alternate); TimeStamperCertificate = (Get-Signer 'Timestamp') }
    }
    function Get-EmbeddedPublisher([string]$Path) { $value = $script:Embedded[[System.IO.Path]::GetFullPath($Path)]; if ($value -is [hashtable]) { return $value.Embedded }; if ($value -eq 'AlternateMicrosoft') { return 'Microsoft Corporation' }; return $value }
    # A fresh copy each call: the helper disposes what it reads. EmbeddedSubject (default Subject) is the embedded
    # signer's DN; an empty EmbeddedSubject models a file whose embedded certificate cannot be read.
    function Get-EmbeddedCertificate([string]$Path) {
        $value = $script:Embedded[[System.IO.Path]::GetFullPath($Path)]
        if ($value -is [hashtable]) {
            $subject = if ($value.ContainsKey('EmbeddedSubject')) { $value.EmbeddedSubject } else { $value.Subject }
            if (-not $subject) { return $null }
            return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Get-SignerDn $subject).RawData)
        }
        if (-not $value) { return $null }
        $alternate = $value -eq 'AlternateMicrosoft'
        $publisher = if ($alternate) { 'Microsoft Corporation' } else { $value }
        return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Get-Signer $publisher $alternate).RawData)
    }
    if ($script:PinOverride) { $script:PinnedRuntime = $script:PinOverride }
}
$script:PinOverride = $null
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

# This alternate root has the same subject and is also trusted by the fixture chain builder.
# One Microsoft DLL per invocation, with both roots in the fixture's trust store.
$dll = '_internal/MSVCP140.dll'
$root = Join-Path $Work 'root-pins'
New-Pe (Join-Path $root 'gepa-worker.exe') 'worker'
New-Pe (Join-Path $root $dll) 'runtime'
foreach ($case in @('PinnedEmbedded', 'OtherEmbedded', 'PinnedCatalog', 'OtherCatalog', 'OtherEmbeddedUnderCatalog')) {
    $embedded = if ($case -in @('OtherEmbedded', 'OtherEmbeddedUnderCatalog')) { 'AlternateMicrosoft' } else { $ms }
    $catalog = if ($case -match 'Catalog') { @{ $dll = @{ Alternate = ($case -eq 'OtherCatalog') } } } else { @() }
    Set-Signers $root @{ 'gepa-worker.exe' = $us; $dll = $embedded } $catalog
    $results["${case}Verify"] = Invoke-Gepa 'verify-windows.ps1' @{ Bundle = $root; Receipt = (Join-Path $Work "evidence/$case.json") }
    $results["${case}List"] = Invoke-Gepa 'sign-list-windows.ps1' @{ Bundle = $root; List = (Join-Path $Work "evidence/$case.txt") }
}

# 10-. Microsoft Windows Software Compatibility Publisher: admitted only for the pinned bytes of the two runtime names.
$cp = 'Microsoft Windows Software Compatibility Publisher'
function New-Compat([hashtable]$Change = @{}) {
    $record = @{ Embedded = $cp; Subject = "CN=$cp, O=Microsoft Corporation, L=Redmond, C=US"; Type = 'Authenticode'; Status = 'Valid'; Timestamped = $true }
    foreach ($key in $Change.Keys) { $record[$key] = $Change[$key] }
    return $record
}
function Get-Sha([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
$results.repoPins = & { . (Join-Path $gepa 'windows-signers.ps1'); ($script:PinnedRuntime.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ',' }
$probe = New-Tree 'pins-probe'
$fixturePins = @{ 'VCRUNTIME140.dll' = (Get-Sha (Join-Path $probe '_internal/VCRUNTIME140.dll')); 'VCRUNTIME140_1.dll' = (Get-Sha (Join-Path $probe '_internal/vcruntime140_1.dll')) }
$compatSigned = @{} + $signed; $compatSigned['_internal/VCRUNTIME140.dll'] = (New-Compat); $compatSigned['_internal/vcruntime140_1.dll'] = (New-Compat)
function Invoke-Compat([string]$Name, [hashtable]$Signers, [hashtable]$Pins, [string[]]$Extra = @(), $Catalog = @(), [string]$CopyPinnedTo = '') {
    $root = New-Tree $Name $Extra
    if ($CopyPinnedTo) { Copy-Item -Force -LiteralPath (Join-Path $root '_internal/VCRUNTIME140.dll') -Destination (Join-Path $root $CopyPinnedTo) }
    Set-Signers $root $Signers $Catalog
    $script:PinOverride = $Pins
    try {
        $verify = Invoke-Gepa 'verify-windows.ps1' @{ Bundle = $root; Receipt = (Join-Path $Work "evidence/$Name.json") }
        $list = Invoke-Gepa 'sign-list-windows.ps1' @{ Bundle = $root; List = (Join-Path $Work "evidence/$Name-list.txt") }
    } finally { $script:PinOverride = $null }
    $results["${Name}"] = $verify; $results["${Name}List"] = $list
    return $root
}
# GREEN: both runtime names, exact pinned bytes, valid timestamped embedded Authenticode, CN + O=Microsoft Corporation.
$null = Invoke-Compat 'compatPinned' $compatSigned $fixturePins
$receipt = Get-Content -Raw -LiteralPath (Join-Path $Work 'evidence/compatPinned.json') -ErrorAction SilentlyContinue | ConvertFrom-Json
$results.compatReceipt = ($receipt | Sort-Object path | ForEach-Object { "$($_.path.Replace('\', '/'))=$($_.publisher)" }) -join ','
$compatList = Join-Path $Work 'evidence/compatPinned-list.txt'; $compatRoot = Join-Path $Work 'compatPinned'
$listed = Get-Content -LiteralPath $compatList -ErrorAction SilentlyContinue | ForEach-Object { [System.IO.Path]::GetRelativePath($compatRoot, [System.IO.Path]::GetFullPath((Join-Path (Split-Path $compatList) $_))).Replace('\', '/') } | Sort-Object
$results.compatListed = $listed -join ','
# One runtime on the Microsoft Corporation rule beside one compat-signed runtime (mixed tree) is also admitted.
$mixed = @{} + $compatSigned; $mixed['_internal/vcruntime140_1.dll'] = $ms
$null = Invoke-Compat 'compatMixed' $mixed $fixturePins
# RED: the repo's real pins (python.org bytes) against other bytes.
$one = @{} + $signed; $one['_internal/VCRUNTIME140.dll'] = (New-Compat)
$null = Invoke-Compat 'compatRepoPins' $one $null
# RED: any other hash under the right name (VCRUNTIME140.dll pinned to another file's bytes; the two pins swapped).
$null = Invoke-Compat 'compatOtherHash' $one @{ 'VCRUNTIME140.dll' = (Get-Sha (Join-Path $probe '_internal/python313.dll')); 'VCRUNTIME140_1.dll' = $fixturePins['VCRUNTIME140_1.dll'] }
$null = Invoke-Compat 'compatSwapped' $one @{ 'VCRUNTIME140.dll' = $fixturePins['VCRUNTIME140_1.dll']; 'VCRUNTIME140_1.dll' = $fixturePins['VCRUNTIME140.dll'] }
# RED: the compat leaf on another name, even carrying VCRUNTIME140.dll's exact pinned bytes.
foreach ($other in @('MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_2.dll')) {
    $withOther = @{} + $signed; $withOther["_internal/$other"] = (New-Compat)
    $null = Invoke-Compat "compatName$($other.Replace('.dll', ''))" $withOther $fixturePins @("_internal/$other") @() "_internal/$other"
}
$ours = @{} + $signed; $ours['_internal/python313.dll'] = (New-Compat)
$null = Invoke-Compat 'compatOurName' $ours $fixturePins @() @() '_internal/python313.dll'
$nested = @{} + $signed; $nested['_internal/nested/VCRUNTIME140.dll'] = (New-Compat)
$null = Invoke-Compat 'compatNested' $nested $fixturePins @() @() '_internal/nested/VCRUNTIME140.dll'
# RED: pinned bytes, but not a valid, timestamped, embedded Authenticode signature by exactly CN + O=Microsoft Corporation.
$variants = [ordered]@{
    compatCatalog = $null
    compatUntimestamped = @{ Timestamped = $false }
    compatHashMismatch = @{ Status = 'HashMismatch' }
    compatNotSigned = @{ Status = 'NotSigned'; Type = 'None' }
    compatNoOrg = @{ Subject = "CN=$cp" }
    compatContoso = @{ Subject = "CN=$cp, O=Contoso" }
    compatTwoOrgs = @{ Subject = "CN=$cp, O=Microsoft Corporation, O=Contoso" }
    compatOrgCase = @{ Subject = "CN=$cp, O=microsoft corporation" }
    compatOtherLeaf = @{ Subject = 'CN=Microsoft Corporation, O=Microsoft Corporation' }
    compatLookalikeLeaf = @{ Subject = "CN=$cp Ltd, O=Microsoft Corporation" }
    compatEmbeddedCase = @{ Embedded = $cp.ToLowerInvariant() }
}
foreach ($variant in $variants.Keys) {
    $case = @{} + $signed; $case['_internal/VCRUNTIME140.dll'] = $(if ($variants[$variant]) { New-Compat $variants[$variant] } else { New-Compat })
    $null = Invoke-Compat $variant $case $fixturePins @() $(if ($variant -eq 'compatCatalog') { @('_internal/VCRUNTIME140.dll') } else { @() })
}
# MAIN 23:22Z ruling: the same pinned, compat-embedded bytes read through a Microsoft catalog (CN=Microsoft Windows or
# Microsoft Corporation, O=Microsoft Corporation) are admitted; any other catalog signer, other bytes, a status other
# than Valid, or an embedded signer that is not exactly CN + O=Microsoft Corporation stays refused.
$winCat = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
$corpCat = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
$bothCatalog = @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $winCat }; '_internal/vcruntime140_1.dll' = @{ Subject = $winCat } }
$catRoot = Invoke-Compat 'catWindows' $compatSigned $fixturePins @() $bothCatalog
$catList = Join-Path $Work 'evidence/catWindows-list.txt'
$listed = Get-Content -LiteralPath $catList -ErrorAction SilentlyContinue | ForEach-Object { [System.IO.Path]::GetRelativePath($catRoot, [System.IO.Path]::GetFullPath((Join-Path (Split-Path $catList) $_))).Replace('\', '/') } | Sort-Object
$results.catWindowsListed = $listed -join ','
$receipt = Get-Content -Raw -LiteralPath (Join-Path $Work 'evidence/catWindows.json') -ErrorAction SilentlyContinue | ConvertFrom-Json
$results.catReceipt = ($receipt | Sort-Object path | ForEach-Object { "$($_.path.Replace('\', '/'))=$($_.publisher)" }) -join ','
$null = Invoke-Compat 'catCorporation' $one $fixturePins @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $corpCat } }
$null = Invoke-Compat 'catOrganizationFallback' $one $fixturePins @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = 'O=Microsoft Corporation, C=US' } }
$catSigners = [ordered]@{
    catOtherName = 'CN=Contoso, O=Microsoft Corporation'
    catOtherOrg = 'CN=Microsoft Windows, O=Contoso'
    catNoOrg = 'CN=Microsoft Windows'
    catTwoOrgs = 'CN=Microsoft Windows, O=Microsoft Corporation, O=Contoso'
    catOrgCase = 'CN=Microsoft Windows, O=microsoft corporation'
    catLookalike = 'CN=Microsoft Windows Ltd, O=Microsoft Corporation'
    catCompatLeaf = "CN=$cp, O=Microsoft Corporation"
    catSelfName = 'CN=Ferrox Labs, O=Ferrox Labs'
}
foreach ($variant in $catSigners.Keys) { $null = Invoke-Compat $variant $one $fixturePins @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $catSigners[$variant] } } }
$null = Invoke-Compat 'catRepoPins' $one $null @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $winCat } }
$null = Invoke-Compat 'catOtherHash' $one @{ 'VCRUNTIME140.dll' = (Get-Sha (Join-Path $probe '_internal/python313.dll')); 'VCRUNTIME140_1.dll' = $fixturePins['VCRUNTIME140_1.dll'] } @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $winCat } }
foreach ($status in @('HashMismatch', 'NotSigned', 'UnknownError', 'NotTrusted')) { $null = Invoke-Compat "catStatus$status" $one $fixturePins @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $winCat; Status = $status } } }
$embeddedVariants = [ordered]@{ catEmbeddedContoso = "CN=$cp, O=Contoso"; catEmbeddedNoOrg = "CN=$cp"; catEmbeddedMissing = '' }
foreach ($variant in $embeddedVariants.Keys) {
    $case = @{} + $signed; $case['_internal/VCRUNTIME140.dll'] = (New-Compat @{ EmbeddedSubject = $embeddedVariants[$variant] })
    $null = Invoke-Compat $variant $case $fixturePins @() @{ '_internal/VCRUNTIME140.dll' = @{ Subject = $winCat } }
}
# A Microsoft catalog never admits a compat-embedded copy of the runtime outside _internal or under another name.
$withOther = @{} + $signed; $withOther['_internal/MSVCP140.dll'] = (New-Compat)
$null = Invoke-Compat 'catNameMSVCP140' $withOther $fixturePins @('_internal/MSVCP140.dll') @{ '_internal/MSVCP140.dll' = @{ Subject = $winCat } } '_internal/MSVCP140.dll'
# RED: the pin file itself admits exactly the two names, lowercase hex, both present.
. (Join-Path $gepa 'windows-signers.ps1')
$badPins = [ordered]@{
    pinsExtraName = @{ 'VCRUNTIME140.dll' = $fixturePins['VCRUNTIME140.dll']; 'VCRUNTIME140_1.dll' = $fixturePins['VCRUNTIME140_1.dll']; 'MSVCP140.dll' = $fixturePins['VCRUNTIME140.dll'] }
    pinsUpperHex = @{ 'VCRUNTIME140.dll' = $fixturePins['VCRUNTIME140.dll'].ToUpperInvariant(); 'VCRUNTIME140_1.dll' = $fixturePins['VCRUNTIME140_1.dll'] }
    pinsMissing = @{ 'VCRUNTIME140.dll' = $fixturePins['VCRUNTIME140.dll'] }
    pinsNameCase = @{ 'vcruntime140.dll' = $fixturePins['VCRUNTIME140.dll']; 'VCRUNTIME140_1.dll' = $fixturePins['VCRUNTIME140_1.dll'] }
}
foreach ($bad in $badPins.GetEnumerator()) {
    $path = Join-Path $Work "evidence/$($bad.Key).json"
    @{ sha256 = $bad.Value } | ConvertTo-Json | Set-Content -LiteralPath $path
    $results[$bad.Key] = try { Read-PinnedRuntime $path | Out-Null; 'ok' } catch { $_.Exception.Message }
}
$results | ConvertTo-Json -Compress
