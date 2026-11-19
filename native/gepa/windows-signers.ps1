# Shared by sign-list-windows.ps1 and verify-windows.ps1 (dot-sourced).
# Microsoft's Visual C++ runtime ships in the PyInstaller tree exactly as python.org redistributes it. We never re-sign
# it: it keeps Microsoft's embedded signature and the verifier requires exactly that. Every other image must be ours.
# Why the embedded certificate is read separately: Get-AuthenticodeSignature consults the machine's catalog database
# first, and a catalog hash ignores the embedded signature. A re-signed VCRUNTIME140.dll therefore reads as Ferrox on a
# runner image without that catalog entry and as Microsoft on one with it. The embedded signer does not depend on the
# runner image.
$script:MicrosoftRedistributables = @('VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_2.dll')
$script:FerroxPublisher = 'Ferrox Labs, LLC'
$script:MicrosoftPublisher = 'Microsoft Corporation'

function Test-NativeImageName([System.IO.FileInfo]$File) {
    return $File.Extension -in @('.exe', '.dll', '.pyd')
}

# Only PyInstaller's contents directory may hold them; the same name anywhere else must be ours.
function Test-MicrosoftRedistributable([string]$Root, [System.IO.FileInfo]$File) {
    $relative = [System.IO.Path]::GetRelativePath($Root, $File.FullName)
    return [System.IO.Path]::GetDirectoryName($relative) -eq '_internal' -and $script:MicrosoftRedistributables -contains $File.Name
}

# Signer of the embedded Authenticode signature only (never a catalog), or $null when the file has none.
function Get-EmbeddedPublisher([string]$Path) {
    try { $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($Path)) }
    catch { return $null }
    try { return $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
    finally { $certificate.Dispose() }
}

# A Microsoft redistributable is admitted only with Microsoft's own embedded signature, validated either through that
# signature (then timestamped) or through a Microsoft catalog that vouches for the same image bytes.
function Assert-MicrosoftRedistributable([System.IO.FileInfo]$File) {
    $embedded = Get-EmbeddedPublisher $File.FullName
    if ($embedded -ne $script:MicrosoftPublisher) { throw "Microsoft redistributable without Microsoft's embedded signature: $($File.Name)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne 'Valid') { throw "Invalid Microsoft redistributable signature: $($File.Name)" }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($signature.SignatureType -eq 'Catalog') {
        if ($publisher -notin @($script:MicrosoftPublisher, 'Microsoft Windows')) { throw "Unexpected Microsoft redistributable catalog signer: $($File.Name)" }
    } elseif ($publisher -ne $script:MicrosoftPublisher -or -not $signature.TimeStamperCertificate) { throw "Unexpected Microsoft redistributable signer: $($File.Name)" }
    return $embedded
}
