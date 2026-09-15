param([Parameter(Mandatory=$true)][string]$Bundle, [Parameter(Mandatory=$true)][string]$Receipt)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Bundle).Path
$rows = @()
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
    $stream = [System.IO.File]::OpenRead($file.FullName)
    $reader = [System.IO.BinaryReader]::new($stream)
    try {
        $mz = $stream.Length -ge 64 -and $reader.ReadUInt16() -eq 0x5a4d
        if (-not $mz) {
            if ($file.Extension -in @('.exe', '.dll', '.pyd')) { throw "Invalid native image: $($file.Name)" }
            continue
        }
        if ($file.Extension -notin @('.exe', '.dll', '.pyd')) { throw "Uncovered native extension: $($file.Name)" }
        if ($file.Extension -eq '.exe' -and $file.FullName -ne (Join-Path $root 'gepa-worker.exe')) { throw 'Unexpected executable in GEPA tree' }
        $stream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ($offset -gt $stream.Length - 6) { throw 'Invalid PE header offset' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Native image is not AMD64' }
    } finally { $reader.Dispose(); $stream.Dispose() }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { throw "Invalid or untimestamped signature: $($file.Name)" }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($publisher -ne 'Ferrox Labs, LLC') { throw "Unexpected native publisher: $($file.Name)" }
    $rows += @{ path = [System.IO.Path]::GetRelativePath($root, $file.FullName); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant(); publisher = $publisher }
}
if ($rows.Count -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $root 'gepa-worker.exe'))) { throw 'Missing GEPA native worker' }
$rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Receipt -Encoding utf8
