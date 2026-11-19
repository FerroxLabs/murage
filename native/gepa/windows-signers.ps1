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
    $script:EmbeddedPublisherError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try { $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($Path)) }
        catch {
            $reason = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
            $script:EmbeddedPublisherError = "attempt ${attempt}: $($reason.GetType().FullName) 0x$('{0:X8}' -f $reason.HResult) $($reason.Message)"
            if ($attempt -lt 5) { Start-Sleep -Milliseconds 400 }
            continue
        }
        try { return $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
        finally { $certificate.Dispose() }
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

# A Microsoft redistributable is admitted only with Microsoft's own embedded signature, validated either through that
# signature (then timestamped) or through a Microsoft catalog that vouches for the same image bytes.
function Assert-MicrosoftRedistributable([System.IO.FileInfo]$File) {
    $embedded = Get-EmbeddedPublisher $File.FullName
    if ($embedded -ceq $script:CompatibilityPublisher) { return Assert-PinnedCompatibilityRuntime $File }
    if ($embedded -ne $script:MicrosoftPublisher) { Write-RedistributableDiagnostics $File $embedded; throw "Microsoft redistributable without Microsoft's embedded signature: $($File.Name)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne 'Valid') { throw "Invalid Microsoft redistributable signature: $($File.Name)" }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($signature.SignatureType -eq 'Catalog') {
        if ($publisher -notin @($script:MicrosoftPublisher, 'Microsoft Windows')) { throw "Unexpected Microsoft redistributable catalog signer: $($File.Name)" }
    } elseif ($publisher -ne $script:MicrosoftPublisher -or -not $signature.TimeStamperCertificate) { throw "Unexpected Microsoft redistributable signer: $($File.Name)" }
    return $embedded
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
# pinned bytes, and a valid, timestamped embedded Authenticode signature (never a catalog) whose subject is that CN with
# O=Microsoft Corporation. The hash is read again after the signature so both verdicts are about the same bytes.
function Assert-PinnedCompatibilityRuntime([System.IO.FileInfo]$File) {
    $name = $script:CompatibilityRuntimeNames | Where-Object { $_ -ieq $File.Name } | Select-Object -First 1
    if (-not $name -or $File.Directory.Name -ne '_internal') { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Compatibility-signed Microsoft redistributable is not a pinned VC++ runtime name: $($File.Name)" }
    $pin = $script:PinnedRuntime[$name]
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant() -cne $pin) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Compatibility-signed Microsoft redistributable is not the pinned runtime: $($File.Name)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or -not $signature.TimeStamperCertificate -or -not $signature.SignerCertificate) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Invalid pinned VC++ runtime signature: $($File.Name)" }
    $commonName = Get-SubjectAttribute $signature.SignerCertificate '2.5.4.3'
    $organization = Get-SubjectAttribute $signature.SignerCertificate '2.5.4.10'
    if ($commonName.Count -ne 1 -or $commonName[0] -cne $script:CompatibilityPublisher -or $organization.Count -ne 1 -or $organization[0] -cne $script:MicrosoftPublisher) { Write-RedistributableDiagnostics $File $script:CompatibilityPublisher; throw "Unexpected pinned VC++ runtime signer: $($File.Name)" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant() -cne $pin) { throw "Compatibility-signed Microsoft redistributable is not the pinned runtime: $($File.Name)" }
    return $script:CompatibilityPublisher
}
