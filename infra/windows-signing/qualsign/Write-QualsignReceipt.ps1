# packs.sha512.json pins are the NuGet .nupkg.metadata contentHash (sha512 of the nupkg with its signature entry stripped),
# NOT the catalog packageHash or a raw download hash. Re-verify: dotnet restore, then read each pack's .nupkg.metadata.
# Receipt/pack producer: winsac-qualsign; fetched-file verifier: winsac-qualsign-verifier; approval/pin consumer: MAIN.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Bind','Packs','PreSign','Verify','Receipt')][string] $Mode)
$ErrorActionPreference = 'Stop'

function Get-Sha256([string] $Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Save-Json([string] $Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12) + "`n")
}
function Write-OutputValue([string] $Name, [string] $Value) {
    if ($Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Invalid output value' }
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$Name=$Value`n")
}
function Get-CertificateTable([byte[]] $Bytes) {
    if ($Bytes.Length -lt 64 -or [BitConverter]::ToUInt16($Bytes,0) -ne 0x5a4d) { throw 'Invalid DOS header' }
    [long]$pe = [BitConverter]::ToUInt32($Bytes,0x3c)
    $optional = $pe + 24
    if ($pe -lt 64 -or $optional + 152 -gt $Bytes.Length -or [BitConverter]::ToUInt32($Bytes,$pe) -ne 0x4550) { throw 'Invalid PE32+ header' }
    $length = [BitConverter]::ToUInt16($Bytes,$pe+20)
    if ($length -lt 152 -or $optional + $length -gt $Bytes.Length -or [BitConverter]::ToUInt16($Bytes,$optional) -ne 0x20b -or [BitConverter]::ToUInt32($Bytes,$optional+108) -lt 5) { throw 'Invalid PE32+ header' }
    $offset = [BitConverter]::ToUInt32($Bytes,$optional+144)
    $size = [BitConverter]::ToUInt32($Bytes,$optional+148)
    if (($offset -eq 0) -ne ($size -eq 0) -or ($size -gt 0 -and ($size -lt 8 -or $offset % 8 -ne 0 -or $offset -lt $optional + $length -or [long]$offset + $size -gt $Bytes.Length))) { throw 'Invalid certificate table' }
    @{offset=$offset; size=$size}
}
function Get-RdnValue($Name, [string] $Oid) {
    $values = @($Name.EnumerateRelativeDistinguishedNames() | Where-Object {
        if ($_.HasMultipleElements) { throw 'Multi-valued identity RDN refused' }
        $_.GetSingleElementType().Value -eq $Oid
    } | ForEach-Object { $_.GetSingleElementValue() })
    if ($values.Count -ne 1) { throw 'Exactly one identity RDN required' }
    $values[0]
}
function Assert-LeafIdentity($Leaf, $Root, [string[]] $Ekus) {
    foreach ($name in @('QUALSIGN_EXPECTED_SUBJECT','QUALSIGN_EXPECTED_ISSUER_PREFIX','QUALSIGN_EXPECTED_ROOT_CN','QUALSIGN_EXPECTED_ROOT_SHA256','QUALSIGN_EXPECTED_EKU')) {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw 'Approved identity variables required' }
    }
    if ((Get-RdnValue $Leaf.SubjectName '2.5.4.3') -cne $env:QUALSIGN_EXPECTED_SUBJECT -or (Get-RdnValue $Leaf.SubjectName '2.5.4.10') -cne $env:QUALSIGN_EXPECTED_SUBJECT) { throw 'Approved leaf CN and O required' }
    if ((Get-RdnValue $Leaf.IssuerName '2.5.4.3') -cnotmatch ('\A' + [regex]::Escape($env:QUALSIGN_EXPECTED_ISSUER_PREFIX) + '(AOC|EOC) CA [0-9]{2}\z') -or (Get-RdnValue $Leaf.IssuerName '2.5.4.10') -cne 'Microsoft Corporation') { throw 'Approved issuer required' }
    $rootHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Root.RawData)).ToLowerInvariant()
    if ($env:QUALSIGN_EXPECTED_ROOT_SHA256 -cnotmatch '\A[0-9a-f]{64}\z' -or (Get-RdnValue $Root.SubjectName '2.5.4.3') -cne $env:QUALSIGN_EXPECTED_ROOT_CN -or $rootHash -cne $env:QUALSIGN_EXPECTED_ROOT_SHA256) { throw 'Approved root required' }
    if ($env:QUALSIGN_EXPECTED_SUBJECT -cne 'Ferrox Labs, LLC' -or $env:QUALSIGN_EXPECTED_ISSUER_PREFIX -cne 'Microsoft ID Verified CS ' -or $env:QUALSIGN_EXPECTED_ROOT_CN -cne 'Microsoft Identity Verification Root Certificate Authority 2020') { throw 'Measured identity pins required' }
    $required = @($env:QUALSIGN_EXPECTED_EKU.Split(','))
    $approved = @('1.3.6.1.5.5.7.3.3','1.3.6.1.4.1.311.97.1.0','1.3.6.1.4.1.311.97.694597467.326663264.393302725.691001577')
    if ((($required | Sort-Object) -join ',') -cne (($approved | Sort-Object) -join ',')) { throw 'Measured EKU pins required' }
    foreach ($oid in $Ekus) { if ($oid.StartsWith('1.3.6.1.4.1.311.97.', [StringComparison]::Ordinal) -and $approved -cnotcontains $oid) { throw 'Unexpected account EKU' } }
    foreach ($oid in $required) { if ($Ekus -cnotcontains $oid) { throw 'Required approved EKU missing' } }
}
function Get-DerSha256($Certificate) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Certificate.RawData)).ToLowerInvariant()
}
# Rebuilds the signer's chain offline, trusting only the pinned root, so every link signature is verified; the supplied chain must equal it exactly.
# Evaluated at the leaf's issuance time: current-time validity stays with Authenticode and Verify's online build.
function Get-SignedChain($Leaf, [object[]] $Chain) {
    if ($Chain.Count -lt 2) { throw 'Approved chain length required' }
    $root = $Chain[$Chain.Count-1]
    if ($env:QUALSIGN_EXPECTED_ROOT_SHA256 -cnotmatch '\A[0-9a-f]{64}\z' -or (Get-DerSha256 $root) -cne $env:QUALSIGN_EXPECTED_ROOT_SHA256) { throw 'Approved root required' }
    $offline = [Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        $offline.ChainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
        $null = $offline.ChainPolicy.CustomTrustStore.Add($root)
        for ($n = 1; $n -lt $Chain.Count - 1; $n++) { $null = $offline.ChainPolicy.ExtraStore.Add($Chain[$n]) }
        $offline.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $offline.ChainPolicy.DisableCertificateDownloads = $true
        $offline.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
        $offline.ChainPolicy.VerificationTime = $Leaf.NotBefore
        if (-not $offline.Build($Leaf)) { throw 'Signed certificate chain required' }
        $signed = @($offline.ChainElements | ForEach-Object { [Security.Cryptography.X509Certificates.X509Certificate2]::new($_.Certificate.RawData) })
    } finally { $offline.Dispose() }
    if ((@($signed | ForEach-Object { Get-DerSha256 $_ }) -join ',') -cne (@($Chain | ForEach-Object { Get-DerSha256 $_ }) -join ',')) { throw 'Supplied chain differs from the signed chain' }
    ,$signed
}
# Chain order leaf, issuer, PCA 2021, root. The PCA pin is the SHA-256 of its raw DER, read from the public v1.0.18 Authenticode chain.
function Assert-SignerChain($Leaf, [object[]] $Chain, [string[]] $Ekus) {
    Assert-ChainPins $Leaf (Get-SignedChain $Leaf $Chain) $Ekus
}
function Assert-ChainPins($Leaf, [object[]] $Chain, [string[]] $Ekus) {
    if ($Chain.Count -ne 4) { throw 'Approved chain length required' }
    if ((Get-DerSha256 $Chain[0]) -cne (Get-DerSha256 $Leaf)) { throw 'Chain leaf mismatch' }
    for ($n = 0; $n -lt $Chain.Count - 1; $n++) { if ([Convert]::ToHexString($Chain[$n].IssuerName.RawData) -cne [Convert]::ToHexString($Chain[$n+1].SubjectName.RawData)) { throw 'Linked chain required' } }
    if ((Get-RdnValue $Chain[2].SubjectName '2.5.4.3') -cne 'Microsoft ID Verified Code Signing PCA 2021' -or (Get-DerSha256 $Chain[2]) -cne '3d29798cc5d3f0644a7e0dc9cb1cade523ea5ec83b335109b605bfeaa7d5f5c1') { throw 'Approved intermediate required' }
    Assert-LeafIdentity $Leaf $Chain[$Chain.Count-1] $Ekus
}
function Get-LeafEkus($Leaf) {
    @($Leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages | ForEach-Object { $_.Value } } | Sort-Object -Unique)
}
function Assert-Packs($Assets, $Pins, [string] $PackageRoot) {
    $actual = @($Assets.project.frameworks.psobject.Properties | ForEach-Object { $_.Value.downloadDependencies } | ForEach-Object {
        if ($_.version -cnotmatch '\A\[([^,\[\]]+)(?:, \1)?\]\z') { throw 'Exact pack version required' }
        [pscustomobject]@{id=$_.name.ToLowerInvariant(); version=$Matches[1]}
    })
    $expected = @($Pins)
    $names = @($actual | ForEach-Object { "$($_.id)/$($_.version)" })
    $pinned = @($expected | ForEach-Object { "$($_.id)/$($_.version)" })
    if ($actual.Count -eq 0 -or $actual.Count -ne $expected.Count -or @($names | Sort-Object -Unique).Count -ne $actual.Count -or @($names | Where-Object { $pinned -cnotcontains $_ }).Count -ne 0) {
        $unpinned = @($names | Where-Object { $pinned -cnotcontains $_ } | ForEach-Object {
            $metaPath = Join-Path $PackageRoot "$_/.nupkg.metadata"
            $hash = if (Test-Path -LiteralPath $metaPath) { (Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json).contentHash } else { 'no-metadata' }
            "$_ sha512=$hash"
        })
        $unused = @($pinned | Where-Object { $names -cnotcontains $_ })
        throw "Exact download pack set required: downloaded=$($actual.Count) pinned=$($expected.Count) unpinned=[$($unpinned -join '; ')] unused-pins=[$($unused -join '; ')]"
    }
    foreach ($pack in $actual) {
        $pin = @($expected | Where-Object { $_.id -ceq $pack.id -and $_.version -ceq $pack.version })
        if ($pin.Count -ne 1) { throw "Exact download pack pin required: $($pack.id)/$($pack.version) matches $($pin.Count) pins" }
        if ($pin[0].sha512 -cnotmatch '\A[A-Za-z0-9+/]{86}==\z') { throw "Exact download pack pin format required: $($pack.id)/$($pack.version)" }
        $metadata = Get-Content -LiteralPath (Join-Path $PackageRoot "$($pack.id)/$($pack.version)/.nupkg.metadata") -Raw | ConvertFrom-Json
        if ($metadata.source -cne 'https://api.nuget.org/v3/index.json') { throw 'NuGet pack source mismatch' }
        if ($metadata.contentHash -cne $pin[0].sha512) { throw "Download pack content hash mismatch: $($pack.id)/$($pack.version) pinned=$($pin[0].sha512) metadata=$($metadata.contentHash)" }
    }
}

$bindPath = Join-Path $env:RUNNER_TEMP 'bind.json'
$folder = Join-Path $env:RUNNER_TEMP 'tosign'
$file = Join-Path $folder 'witness-collector.exe'
$paths = [ordered]@{
    collector='infra/windows-signing/collector'
    signingProcess='infra/windows-signing/boundary/SigningProcess.cs'
    processApi='infra/windows-signing/boundary/WindowsSigningProcessApi.cs'
    plan='scripts/windows-signing-witness/plan.json'
    workflow='.github/workflows/windows-qualsign.yml'
    helper='infra/windows-signing/qualsign/Write-QualsignReceipt.ps1'
    packs='infra/windows-signing/qualsign/packs.sha512.json'
}
if ($Mode -eq 'Bind') {
    $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
    $subject = ($event.head_commit.message -split '\r?\n')[0]
    if ($subject -cnotmatch '\AQUALSIGN collector ([0-9a-f]{40})\z') { throw 'Invalid dev SHA' }
    $devSha = $Matches[1]
    if ($env:GITHUB_SHA -cnotmatch '\A[0-9a-f]{40}\z' -or $event.head_commit.id -cne $env:GITHUB_SHA -or $env:GITHUB_REF_NAME -cnotmatch '\Aci/try-[0-9a-f]{12}\z') { throw 'Invalid public commit or ref' }
    $headSha = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $headSha -cne $env:GITHUB_SHA) { throw 'Checkout SHA mismatch' }
    $parents = & git rev-list --parents -n1 HEAD
    if ($LASTEXITCODE -ne 0 -or ($parents -split ' ').Count -ne 2) { throw 'Single parent required' }
    $hashes = [ordered]@{}
    foreach ($entry in $paths.GetEnumerator()) {
        $value = & git rev-parse "HEAD:$($entry.Value)"
        if ($LASTEXITCODE -ne 0 -or $value -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Missing bound input' }
        $hashes[$entry.Key] = $value
    }
    $bind = [ordered]@{publicSha=$env:GITHUB_SHA; devSha=$devSha; treeHashes=$hashes; lockFileSha256=(Get-Sha256 'infra/windows-signing/collector/packages.lock.json')}
    if ($env:QUALSIGN_BIND) {
        $previous = $env:QUALSIGN_BIND | ConvertFrom-Json
        $expected = @('dev_sha','dev_sha12','collector','signingProcess','processApi','plan','workflow','helper','lock_sha256','packs_sha256','sdk_version','dotnet_sha256','unsigned_sha256')
        if ((($previous.psobject.Properties.Name | Sort-Object) -join ',') -cne (($expected | Sort-Object) -join ',')) { throw 'Exact signing output set required' }
        foreach ($name in @('dev_sha') + @($paths.Keys | Where-Object { $_ -ne 'packs' })) { if ($previous.$name -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Invalid bound hash' } }
        foreach ($name in @('lock_sha256','packs_sha256','dotnet_sha256','unsigned_sha256')) { if ($previous.$name -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Invalid signing digest' } }
        if ($previous.dev_sha -cne $devSha -or $previous.dev_sha12 -cne $devSha.Substring(0,12) -or $previous.sdk_version -cne '10.0.115' -or $previous.lock_sha256 -cne $bind.lockFileSha256 -or $previous.packs_sha256 -cne (Get-Sha256 'infra/windows-signing/qualsign/packs.sha512.json')) { throw 'Signing output binding mismatch' }
        foreach ($name in @($paths.Keys | Where-Object { $_ -ne 'packs' })) { if ($previous.$name -cne $hashes[$name]) { throw 'Bound input mismatch' } }
        $bind.sdkVersion=$previous.sdk_version; $bind.dotnetSha256=$previous.dotnet_sha256
        $bind.unsignedSha256=$previous.unsigned_sha256; $bind.packsSha256=$previous.packs_sha256
    }
    Save-Json $bindPath $bind
    foreach ($name in @($paths.Keys | Where-Object { $_ -ne 'packs' })) { Write-OutputValue $name $hashes[$name] }
    Write-OutputValue 'lock_sha256' $bind.lockFileSha256
} elseif ($Mode -eq 'Packs') {
    $assets = Get-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'obj/project.assets.json') -Raw | ConvertFrom-Json
    $pinPath = 'infra/windows-signing/qualsign/packs.sha512.json'
    $pins = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json
    $packageRoot = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $HOME '.nuget/packages' }
    Assert-Packs $assets $pins $packageRoot
    $bind = Get-Content -LiteralPath $bindPath -Raw | ConvertFrom-Json -AsHashtable
    $bind.packsSha256 = Get-Sha256 $pinPath
    Save-Json $bindPath $bind
    Write-OutputValue 'packs_sha256' $bind.packsSha256
} elseif ($Mode -eq 'PreSign' -or $Mode -eq 'Verify') {
    $entries = @(Get-ChildItem -LiteralPath $folder -Force -Recurse)
    if ($entries.Count -ne 1 -or $entries[0].Name -cne 'witness-collector.exe' -or $entries[0].PSIsContainer -or ($entries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Collector only' }
    $table = Get-CertificateTable ([IO.File]::ReadAllBytes($file))
    $bind = Get-Content -LiteralPath $bindPath -Raw | ConvertFrom-Json -AsHashtable
    if ($Mode -eq 'PreSign') {
        if ($table.offset -ne 0 -or $table.size -ne 0) { throw 'Certificate table must be empty' }
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        Write-Output "Pre-sign Authenticode status: $($signature.Status)"
        if ($signature.Status -ne 'NotSigned') { throw 'Collector must be NotSigned' }
        $bind.unsignedSha256 = Get-Sha256 $file
        Save-Json $bindPath $bind
        Write-OutputValue 'unsigned_sha256' $bind.unsignedSha256
    } else {
        if ($env:ACTIONS_ID_TOKEN_REQUEST_URL -or $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN -or $env:AZURE_FEDERATED_TOKEN) { throw 'Verification job holds signing credential' }
        if ($table.size -eq 0) { throw 'Embedded certificate table required' }
        $signtool = "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
        $signtool = (Resolve-Path -LiteralPath $signtool).Path
        foreach ($root in @($env:GITHUB_WORKSPACE,$env:RUNNER_TEMP)) {
            if (-not $root -or $signtool.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Windows SDK signtool outside workspace and temp required' }
        }
        $signtoolHash = Get-Sha256 $signtool
        & $signtool verify /pa /all /v /tw $file
        if ($LASTEXITCODE -ne 0) { throw 'Signtool verification failed' }
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        $leaf = $signature.SignerCertificate
        if ($signature.Status -ne 'Valid' -or $null -eq $leaf) { throw 'Valid embedded signer required' }
        $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
        try {
            $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
            $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
            if (-not $chain.Build($leaf)) { throw 'Approved online certificate chain required' }
            $ekus = Get-LeafEkus $leaf
            $chainCerts = @($chain.ChainElements | ForEach-Object { $_.Certificate })
            Assert-SignerChain $leaf $chainCerts $ekus
            $signed = Get-Sha256 $file
            if ($signed -ceq $bind.unsignedSha256) { throw 'Signing did not change bytes' }
            $verified = @{signedSha256=$signed; leafDerSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($leaf.RawData)).ToLowerInvariant(); subject=$leaf.Subject; issuer=$leaf.Issuer; ekus=$ekus; chainSubjects=@($chainCerts | ForEach-Object { $_.Subject }); chainDer=@($chainCerts | ForEach-Object { [Convert]::ToBase64String($_.RawData) }); notBefore=$leaf.NotBefore.ToUniversalTime().ToString('O'); notAfter=$leaf.NotAfter.ToUniversalTime().ToString('O'); signtoolExit=0; signtoolPath=$signtool; signtoolSha256=$signtoolHash}
            Save-Json (Join-Path $env:RUNNER_TEMP 'verification.json') $verified
            Write-OutputValue 'signed_sha256' $signed
        } finally { $chain.Dispose() }
    }
} elseif ($Mode -eq 'Receipt') {
    $bind = Get-Content -LiteralPath $bindPath -Raw | ConvertFrom-Json -AsHashtable
    $verified = Get-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
    $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
    if (($event.head_commit.message -split '\r?\n')[0] -cne "QUALSIGN collector $($bind.devSha)" -or $event.head_commit.id -cne $bind.publicSha) { throw 'Invalid SHA binding' }
    if ($bind.devSha -cnotmatch '\A[0-9a-f]{40}\z' -or $bind.publicSha -cne $env:GITHUB_SHA -or $bind.sdkVersion -cne '10.0.115' -or $bind.treeHashes.Count -ne 7) { throw 'Invalid SHA binding' }
    foreach ($name in $paths.Keys) {
        $current = & git rev-parse "HEAD:$($paths[$name])"
        if ($LASTEXITCODE -ne 0 -or $current -cne $bind.treeHashes[$name]) { throw 'Bound input mismatch' }
    }
    foreach ($value in @($bind.lockFileSha256,$bind.packsSha256,$bind.dotnetSha256,$bind.unsignedSha256,$verified.signedSha256,$verified.leafDerSha256,$verified.signtoolSha256)) {
        if ($value -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Invalid receipt digest' }
    }
    if ((Get-Sha256 $file) -cne $verified.signedSha256 -or $verified.signedSha256 -ceq $bind.unsignedSha256 -or $verified.signtoolExit -ne 0 -or -not $verified.subject -or -not $verified.issuer -or $verified.ekus -cnotcontains '1.3.6.1.5.5.7.3.3') { throw 'Invalid verification receipt' }
    # Re-run the full identity guard on the file's own Authenticode signer and the recorded chain before any receipt exists.
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    $leaf = $signature.SignerCertificate
    if ($signature.Status -ne 'Valid' -or $null -eq $leaf -or (Get-DerSha256 $leaf) -cne $verified.leafDerSha256) { throw 'Receipt signer mismatch' }
    $chainCerts = @($verified.chainDer | ForEach-Object { [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String([string] $_)) })
    $ekus = Get-LeafEkus $leaf
    Assert-SignerChain $leaf $chainCerts $ekus
    if ($verified.subject -cne $leaf.Subject -or $verified.issuer -cne $leaf.Issuer -or (@($verified.chainSubjects) -join "`n") -cne (@($chainCerts | ForEach-Object { $_.Subject }) -join "`n") -or (@($verified.ekus) -join ',') -cne ($ekus -join ',')) { throw 'Invalid verification receipt' }
    $receipt = [ordered]@{schema='qualsign-collector-v1'; role='qualification-collector'; release='HOLD'; publication='none'; core='PARTIAL'; pass=$false; guard='qualsign-not-release-v1'}
    foreach ($map in @($bind,$verified)) { foreach ($key in $map.Keys) { $receipt[$key]=$map[$key] } }
    $receipt.repository=$env:GITHUB_REPOSITORY; $receipt.workflowPath='.github/workflows/windows-qualsign.yml'
    $receipt.runId=$env:GITHUB_RUN_ID; $receipt.runAttempt=$env:GITHUB_RUN_ATTEMPT; $receipt.job='verify-collector'
    $receipt.signedArtifactName="qualsign-signed-$($bind.devSha.Substring(0,12))-$env:GITHUB_RUN_ATTEMPT"
    $receiptPath = Join-Path $folder 'qualsign-receipt.json'
    Save-Json $receiptPath $receipt
    $digest = Get-Sha256 $receiptPath
    Write-OutputValue 'receipt_sha256' $digest
    [IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, "Signed SHA-256: $($verified.signedSha256)`n`nReceipt SHA-256: $digest`n")
}
