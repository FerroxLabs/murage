# Shared by sign-list-windows.ps1 and verify-windows.ps1 (dot-sourced).
# Microsoft's Visual C++ runtime ships in the PyInstaller tree exactly as python.org redistributes it. We never re-sign
# it: it keeps Microsoft's embedded signature and the verifier requires exactly that. Every other image must be ours.
# python.org's 3.13.15 VCRUNTIME140.dll and VCRUNTIME140_1.dll are embedded-signed by "Microsoft Windows Software
# Compatibility Publisher" (a leaf Microsoft also puts on components it did not author), not "Microsoft Corporation".
# That leaf is therefore admitted only by file identity: those two names, in _internal, with the exact sha256 pinned in
# vcruntime-pins.json (the same file build-windows.py copies against). Every other file keeps the Microsoft Corporation rule.
# Why the embedded certificate is read separately: Get-AuthenticodeSignature consults the machine's catalog database
# first, and a catalog hash ignores the embedded signature. A re-signed VCRUNTIME140.dll therefore reads as Ferrox on a
# runner image without that catalog entry and as Microsoft on one with it. The embedded signer does not depend on the
# runner image.
$script:MicrosoftRedistributables = @('VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_2.dll')
$script:FerroxPublisher = 'Ferrox Labs, LLC'
$script:MicrosoftPublisher = 'Microsoft Corporation'
$script:MicrosoftSignerRootSha256 = @(
    'DF545BF919A2439C36983B54CDFC903DFA4F37D3996D8D84B4C31EEC6F3C163E' # Microsoft Root Certificate Authority 2010
    '847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61' # Microsoft Root Certificate Authority 2011
)
$script:CompatibilityPublisher = 'Microsoft Windows Software Compatibility Publisher'
$script:CompatibilityRuntimeNames = @('VCRUNTIME140.dll', 'VCRUNTIME140_1.dll')

# Exactly one lowercase sha256 per compatibility-signed runtime name, nothing else, or the helper refuses to load.
function Read-PinnedRuntime([string]$Path) {
    $sha256 = (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json).sha256
    $pins = @{}
    foreach ($property in @($sha256.PSObject.Properties)) {
        if ($script:CompatibilityRuntimeNames -cnotcontains $property.Name -or $property.Value -isnot [string] -or $property.Value -cnotmatch '^[0-9a-f]{64}$') { throw "Invalid VC++ runtime pin: $($property.Name)" }
        $pins[$property.Name] = $property.Value
    }
    if ($pins.Count -ne $script:CompatibilityRuntimeNames.Count) { throw 'VC++ runtime pins incomplete' }
    return $pins
}
$script:PinnedRuntime = Read-PinnedRuntime (Join-Path $PSScriptRoot 'vcruntime-pins.json')

function Test-NativeImageName([System.IO.FileInfo]$File) {
    return $File.Extension -in @('.exe', '.dll', '.pyd')
}

# Only PyInstaller's contents directory may hold them; the same name anywhere else must be ours.
function Test-MicrosoftRedistributable([string]$Root, [System.IO.FileInfo]$File) {
    $relative = [System.IO.Path]::GetRelativePath($Root, $File.FullName)
    return [System.IO.Path]::GetDirectoryName($relative) -eq '_internal' -and $script:MicrosoftRedistributables -contains $File.Name
}

# Signer of the embedded Authenticode signature only (never a catalog), or $null when the file has none.
# Release runs 44602288262 and 44605573204 refused VCRUNTIME140.dll while a rerun on the same source passed, so the read is
# retried before a verdict (a freshly written image can be held open briefly by another reader). The last reader error is
# kept in $script:EmbeddedPublisherError for the refusal's diagnostics; retries never turn a missing signer into a pass.
$script:EmbeddedPublisherError = $null
function Get-EmbeddedPublisher([string]$Path) {
    $certificate = Get-EmbeddedCertificate $Path
    if (-not $certificate) { return $null }
    try { return $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
    finally { $certificate.Dispose() }
}

# The embedded Authenticode signer certificate itself (never a catalog), or $null; the caller disposes it.
function Get-EmbeddedCertificate([string]$Path) {
    $script:EmbeddedPublisherError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try { return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($Path)) }
        catch {
            $reason = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
            $script:EmbeddedPublisherError = "attempt ${attempt}: $($reason.GetType().FullName) 0x$('{0:X8}' -f $reason.HResult) $($reason.Message)"
            if ($attempt -lt 5) { Start-Sleep -Milliseconds 400 }
        }
    }
    return $null
}

# What the runner saw when a redistributable is refused: the reader error, the embedded signer, the catalog view and hash.
function Write-RedistributableDiagnostics([System.IO.FileInfo]$File, $Embedded) {
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    Write-Warning ("{0}: embedded='{1}' readerError='{2}' status={3} type={4} signer='{5}' timestamped={6} sha256={7} bytes={8}" -f $File.Name, $Embedded,
        $script:EmbeddedPublisherError, $signature.Status, $signature.SignatureType, $signer, [bool]$signature.TimeStamperCertificate,
        (Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash, $File.Length)
}

function New-MicrosoftSignerChain {
    return [System.Security.Cryptography.X509Certificates.X509Chain]::new()
}

function Test-MicrosoftSignerRoot([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    $chain = New-MicrosoftSignerChain
    try {
        $chain.ChainPolicy.DisableCertificateDownloads = $true
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        # Authenticode supplies the validity verdict, including timestamp handling. This chain supplies the root identity.
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid
        if (-not $chain.Build($Certificate) -or $chain.ChainElements.Count -lt 2) { return $false }
        $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
        return $script:MicrosoftSignerRootSha256 -ccontains $root.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
    } finally { $chain.Dispose() }
}

# Microsoft's ordinary redistributables need an embedded signer and a valid, pinned Authenticode or catalog signer.
function Assert-MicrosoftRedistributable([System.IO.FileInfo]$File) {
    $embedded = Get-EmbeddedPublisher $File.FullName
    if ($embedded -ceq $script:CompatibilityPublisher) { return Assert-PinnedCompatibilityRuntime $File }
    if ($embedded -ne $script:MicrosoftPublisher) { Write-RedistributableDiagnostics $File $embedded; throw "Microsoft redistributable without Microsoft's embedded signature: $($File.Name)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw "Invalid Microsoft redistributable signature: $($File.Name)" }
    $certificate = Get-EmbeddedCertificate $File.FullName
    try {
        if (-not $certificate -or $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne $script:MicrosoftPublisher) { throw "Microsoft redistributable without Microsoft's embedded signature: $($File.Name)" }
        if ($signature.SignatureType -eq 'Catalog') {
            $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
            if ($publisher -notin @($script:MicrosoftPublisher, 'Microsoft Windows')) { throw "Unexpected Microsoft redistributable catalog signer: $($File.Name)" }
            if (-not (Test-MicrosoftSignerRoot $signature.SignerCertificate)) { throw "Microsoft redistributable signer root is not pinned: $($File.Name)" }
        } elseif ($signature.SignatureType -ne 'Authenticode' -or -not $signature.TimeStamperCertificate -or -not $certificate.Equals($signature.SignerCertificate)) {
            throw "Unexpected Microsoft redistributable signer: $($File.Name)"
        }
        if (-not (Test-MicrosoftSignerRoot $certificate)) { throw "Microsoft redistributable signer root is not pinned: $($File.Name)" }
        return $embedded
    } finally { if ($certificate) { $certificate.Dispose() } }
}

# Single-valued subject attribute values for one OID; a multi-valued RDN anywhere in the subject is refused.
function Get-SubjectAttribute([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate, [string]$Oid) {
    $values = @()
    foreach ($rdn in $Certificate.SubjectName.EnumerateRelativeDistinguishedNames()) {
        if ($rdn.HasMultipleElements) { throw 'Multi-valued signer subject' }
        if ($rdn.GetSingleElementType().Value -eq $Oid) { $values += $rdn.GetSingleElementValue() }
    }
    return ,$values
}

# The Compatibility Publisher leaf proves only "signed by Microsoft's PKI", so it is bound to file identity: one of the
# two pinned names directly in _internal (callers check the folder through Test-MicrosoftRedistributable), the exact
# pinned bytes, and an embedded signer certificate (read from the file) whose subject is that CN with O=Microsoft
# Corporation. Get-AuthenticodeSignature must then report Valid either as that timestamped embedded Authenticode signature
# or as a Microsoft catalog (SimpleName Microsoft Windows or Microsoft Corporation, O=Microsoft Corporation) vouching for the same
# bytes. MAIN 23:22Z ruling: release run 44636264306 read the pinned VCRUNTIME140.dll as type=Catalog, signer Microsoft
# Windows, while 44616560307 read the same bytes as Authenticode; the runner's catalog database varies, the pin does not.
# The hash is checked again after signature validation. Separate path opens cannot establish continuity, so the
# release runner must keep exclusive control of the staging tree throughout.
function Test-PinnedSigner([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate, [string[]]$CommonNames) {
    if (-not $Certificate) { return $false }
    $commonName = Get-SubjectAttribute $Certificate '2.5.4.3'
    $organization = Get-SubjectAttribute $Certificate '2.5.4.10'
    return $commonName.Count -eq 1 -and $CommonNames -ccontains $commonName[0] -and $organization.Count -eq 1 -and $organization[0] -ceq $script:MicrosoftPublisher
}
function Assert-PinnedCompatibilityRuntime([System.IO.FileInfo]$File) {
    $name = $script:CompatibilityRuntimeNames | Where-Object { $_ -ieq $File.Name } | Select-Object -First 1
    if (-not $name -or $File.Directory.Name -ne '_internal') { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Compatibility-signed Microsoft redistributable is not a pinned VC++ runtime name: $($File.Name)" }
    $pin = $script:PinnedRuntime[$name]
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant() -cne $pin) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Compatibility-signed Microsoft redistributable is not the pinned runtime: $($File.Name)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    $authenticode = $signature.SignatureType -eq 'Authenticode' -and $signature.TimeStamperCertificate
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or -not ($authenticode -or $signature.SignatureType -eq 'Catalog')) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Invalid pinned VC++ runtime signature: $($File.Name)" }
    if ($authenticode -and -not (Test-PinnedSigner $signature.SignerCertificate @($script:CompatibilityPublisher))) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Unexpected pinned VC++ runtime signer: $($File.Name)" }
    if (-not $authenticode) {
        $catalogSigner = $signature.SignerCertificate
        $publisher = $catalogSigner.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        $organization = Get-SubjectAttribute $catalogSigner '2.5.4.10'
        if ($publisher -cnotin @('Microsoft Windows', $script:MicrosoftPublisher) -or $organization.Count -ne 1 -or $organization[0] -cne $script:MicrosoftPublisher) {
            Write-RedistributableDiagnostics $File $script:CompatibilityPublisher
            throw "Unexpected pinned VC++ runtime catalog signer: $($File.Name)"
        }
    }
    $embedded = Get-EmbeddedCertificate $File.FullName
    try { $embeddedOk = Test-PinnedSigner $embedded @($script:CompatibilityPublisher) } finally { if ($embedded) { $embedded.Dispose() } }
    if (-not $embeddedOk) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Unexpected pinned VC++ runtime signer: $($File.Name)" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant() -cne $pin) { throw "Compatibility-signed Microsoft redistributable is not the pinned runtime: $($File.Name)" }
    return $script:CompatibilityPublisher
}
