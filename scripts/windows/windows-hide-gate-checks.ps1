Set-StrictMode -Version Latest
function Assert-WindowsHideDesktop($Desktop) {
  if ($Desktop.session -ne $Desktop.activeSession -or $Desktop.activeSession -eq [uint32]::MaxValue -or $Desktop.session -eq 0 -or $Desktop.inputDesktop -cne 'Default' -or $Desktop.threadDesktop -cne 'Default' -or $Desktop.windowStation -cne 'WinSta0') { throw 'Observer is not on the interactive WinSta0 Default input desktop' }
}
function Assert-WindowsHideControl($Control) {
  if (-not $Control.seen -or -not $Control.closed -or $Control.samples -lt 1 -or @($Control.observations).Count -lt 1 -or @($Control.errors).Count -gt 0) { throw 'Visible console positive control was not observed and closed' }
}
function Assert-WindowsHideManifest([string]$Executable, [string]$Commit, [string]$Retain) {
  if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Commit must be a full lowercase build SHA' }
  if ([IO.Path]::GetFileName($Executable) -ine 'Murage.exe') { throw 'Scenario executable must be the manifest Murage.exe' }
  $package = Split-Path -Parent $Executable
  $manifestPath = Join-Path $package 'resources/windows-hide-package-manifest.json'
  $rawBytes = [IO.File]::ReadAllBytes($manifestPath)
  $raw = [Text.Encoding]::UTF8.GetString($rawBytes).TrimStart([char]0xfeff)
  $manifest = $raw | ConvertFrom-Json
  $embedded = Get-Content -LiteralPath (Join-Path $package 'resources/ui/build-commit.json') -Raw | ConvertFrom-Json
  if ($manifest.schema -ne 1 -or $manifest.commit -cne $Commit -or $embedded.commit -cne $Commit) { throw 'Package build commit does not match -Commit' }
  $required = @('Murage.exe', 'resources/app.asar', 'resources/ui/build-commit.json')
  $required += @(Get-ChildItem -LiteralPath (Join-Path $package 'resources') -File -Recurse | Where-Object { $_.Extension -in @('.js','.mjs','.cjs','.ts') } | ForEach-Object { $_.FullName.Substring($package.Length + 1).Replace('\','/') })
  if (-not ($required | Where-Object { $_ -like 'resources/server/*.js' })) { throw 'Missing bundled server entries' }
  $expected = @($required | Sort-Object -Unique)
  $seen = @{}
  foreach ($entry in $manifest.files) {
    if ([string]::IsNullOrEmpty($entry.path) -or $entry.path.Split('/') -contains '..' -or $entry.path.StartsWith('/') -or $seen.ContainsKey($entry.path) -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid or duplicate manifest entry' }
    if ($entry.path -cnotin $expected) { throw "Unexpected manifest entry: $($entry.path)" }
    $seen[$entry.path] = $true
    $file = Join-Path $package $entry.path
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw "Package hash mismatch: $($entry.path)" }
  }
  if ($seen.Count -ne $expected.Count) { throw 'Package manifest inventory is incomplete' }
  # Retain the exact verified bytes, not a caller-supplied summary.
  [IO.File]::WriteAllBytes($Retain, $rawBytes)
  return [ordered]@{ commit=$manifest.commit; files=$seen.Count; sha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash; retained=$Retain }
}
