param([Parameter(Mandatory=$true)][string]$Bundle, [Parameter(Mandatory=$true)][string]$Receipt,
    [Parameter(Mandatory=$true)][string]$SigningManifest, [Parameter(Mandatory=$true)][string]$ExpectedSha256)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Bundle).Path
if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $SigningManifest).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Untrusted signing projection' }
$projection = Get-Content -Raw -LiteralPath $SigningManifest | ConvertFrom-Json
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
        if ($file.Extension -eq '.exe' -and $file.FullName -ne (Join-Path $root 'gepa-worker.exe')) { throw 'Unexpected executable in GEPA tree' }
        $stream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ($offset -gt $stream.Length - 6) { throw 'Invalid PE header offset' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Native image is not AMD64' }
    } finally { $reader.Dispose(); $stream.Dispose() }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $relative = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
    $name = 'resources/gepa-worker/' + $relative
    $pins = @($projection.sources | Where-Object { $_.path -ceq $name })
    $records = @($projection.records | Where-Object { $_.path -ceq $name })
    if ($pins.Count -ne 1 -or $records.Count -ne 1) { throw 'Missing or duplicate source/final record' }
    $pin = $pins[0]; $record = $records[0]
    if ($pin.target -cne 'win32-x64' -or $pin.version -cne $record.version -or $pin.sourceSha256 -cne $record.sourceSha256 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant() -cne $record.finalSha256) { throw 'Signing projection mismatch' }
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode') { throw "Invalid embedded signature: $($file.Name)" }
    $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($record.disposition -ceq 'signed') {
        if ($publisher -cne 'Ferrox Labs, LLC' -or -not $signature.TimeStamperCertificate) { throw 'Production publisher/timestamp required' }
    } elseif ($record.disposition -ceq 'preserved') {
        if ($publisher -cnotin $pin.publishers -or $record.sourceSha256 -cne $record.finalSha256) { throw 'Vendor preservation mismatch' }
    } else { throw 'Unknown signing disposition' }
    $rows += @{ path = [System.IO.Path]::GetRelativePath($root, $file.FullName); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant(); publisher = $publisher }
}
if ($rows.Count -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $root 'gepa-worker.exe'))) { throw 'Missing GEPA native worker' }
if ($rows.Count -ne @($projection.sources).Count -or $rows.Count -ne @($projection.records).Count) { throw 'Signing projection path-set mismatch' }
$rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Receipt -Encoding utf8
