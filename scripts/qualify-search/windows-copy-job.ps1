# SPDX-License-Identifier: AGPL-3.0-or-later
# Definition only; never invoked by the Linux smoke runner. Runner rule confines
# all writes to D:\murage-ci or C:\murage-ci.
param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$LegacyReport,[string]$Root='D:\murage-ci')
$ErrorActionPreference='Stop'
if ($Root -notin @('D:\murage-ci','C:\murage-ci')) { throw 'Unapproved runner directory' }
$Job=Join-Path $Root ('search-qual-'+[guid]::NewGuid().ToString('N'))
$Evidence=Join-Path $Root ('search-evidence-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Job,$Evidence | Out-Null
try {
  tar -xf $Archive -C $Job
  if ($LASTEXITCODE -ne 0) { throw 'archive extraction failed' }
  Push-Location $Job
  try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'install failed' }
    $env:MURAGE_QUAL='q2-103k';$env:MURAGE_QUAL_EVIDENCE=$Evidence;$env:MURAGE_QUAL_LEGACY_REPORT=$LegacyReport
    pnpm vitest run --config scripts/qualify-search/vitest.config.ts --tags-filter=qual
    if ($LASTEXITCODE -ne 0) { throw '103k qualification failed' }
    $ResetReport=Join-Path $Evidence 'q2-windows-reset.json'
    pnpm vitest run server/search-index-r3.test.ts server/search-index-r3-crash.test.ts server/search-index-review-recovery.test.ts -t "T-RESET-HANDSHAKE|C15'|T-REC-|T-SCRUB-" --reporter=json --outputFile=$ResetReport
    if ($LASTEXITCODE -ne 0) { throw 'reset qualification failed' }
    node scripts/qualify-search/check-reset-set.mjs $ResetReport
    if ($LASTEXITCODE -ne 0) { throw 'reset qualification set incomplete' }
  } finally { Pop-Location }
} finally {
  # Keep result hashes and numeric reports under the approved runner root.
  Remove-Item -Recurse -Force -LiteralPath $Job
  Write-Output "Removed qualification folder; evidence: $Evidence"
}
# Windows disk-full omitted by R-2: creating a VHD is outside the runner rule.
