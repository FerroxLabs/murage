# Owners: 19k2 loader/script; 19j native witnesses; 19h8 restart witnesses; MAIN/Beast native execution and evidence.
# Prepared Node 24, pnpm dependencies, Node headers and Visual Studio C++ tools are required. No downloads.
param([Parameter(Mandatory=$true)][string]$Tip,[string]$Repo='D:\murage-ci\walf4\src',[Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $Repo
$repoPath=(Get-Location).ProviderPath
$evidencePath=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Evidence)
# Resolve existing ancestors natively so junctions and 8.3 aliases cannot hide checkout evidence.
$physical=@'
const fs = require('node:fs'), path = require('node:path');
function physical(input) {
  let current = path.resolve(input), suffix = [];
  for (;;) {
    try { fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || current === path.dirname(current)) throw error;
      suffix.unshift(path.basename(current)); current = path.dirname(current); continue;
    }
    return path.resolve(fs.realpathSync.native(current), ...suffix);
  }
}
console.log(JSON.stringify(process.argv.slice(2).map(physical)));
'@
$resolved=$physical | node - $repoPath $evidencePath
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve checkout and evidence paths' }
$paths=$resolved | ConvertFrom-Json
$repoRoot=$paths[0].TrimEnd('\')
$evidenceRoot=$paths[1]
if ($evidenceRoot.Equals($repoRoot,[StringComparison]::OrdinalIgnoreCase) -or $evidenceRoot.StartsWith($repoRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be outside the checkout' }
$head=git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $Tip) { throw 'Use an isolated checkout of the exact requested tip' }
$dirty=git status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Use a clean checkout' }
if ((node -p 'process.platform') -ne 'win32') { throw 'Native Windows Node is required' }
if ([int]((node --version).TrimStart('v').Split('.')[0]) -ne 24) { throw 'Node 24 is required' }
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
node scripts/build-engine-exclusion.mjs *> (Join-Path $evidenceRoot 'native-build.log')
if ($LASTEXITCODE -ne 0) { throw 'Native addon build failed' }
$vitest=Join-Path $repoRoot 'node_modules\vitest\vitest.mjs'
for ($i=1;$i -le 20;$i++) {
  $json=Join-Path $evidenceRoot "f4-windows-$i.json"
  node $vitest run -c vitest.wal.config.ts server/engine-exclusion-meter-copy.test.ts server/engine-exclusion-meter-native.test.ts --reporter=json "--outputFile=$json" *> (Join-Path $evidenceRoot "f4-windows-$i.log")
  if ($LASTEXITCODE -ne 0) { throw "F4 Windows run $i failed" }
  $results=Get-Content -Raw -LiteralPath $json | ConvertFrom-Json
  if (-not $results.success -or $results.numPassedTests -ne 9 -or $results.numPendingTests -ne 1 -or $results.numFailedTests -ne 0 -or $results.numTotalTests -ne 10) { throw 'Expected 9 passed and 1 skipped' }
  $required=@($results.testResults.assertionResults | Where-Object { $_.title -match 'P5-native-reject|W-same-file-native|symlink|junction' })
  if ($required.Count -ne 6 -or @($required | Where-Object { $_.status -ne 'passed' }).Count) { throw 'Required native and alias witnesses must RUN and PASS 6-of-6' }
}
$restartRequired=30
for ($i=1;$i -le 20;$i++) {
  $restartJson=Join-Path $evidenceRoot "restart-windows-$i.json"
  node $vitest run --pool=forks server/wal-restart.test.ts server/wal-maintenance.test.ts -t '^W-(INDEX|RESTART)' --reporter=json "--outputFile=$restartJson" *> (Join-Path $evidenceRoot "restart-windows-$i.log")
  if ($LASTEXITCODE -ne 0) { throw "Restart Windows run $i failed" }
  $restart=Get-Content -Raw -LiteralPath $restartJson | ConvertFrom-Json
  $restartWitnesses=@($restart.testResults.assertionResults | Where-Object { $_.title -match '^W-(INDEX|RESTART)' })
  if (-not $restart.success -or $restart.numFailedTests -ne 0 -or $restart.numPassedTests -ne $restartRequired -or $restartWitnesses.Count -ne $restartRequired -or @($restartWitnesses | Where-Object { $_.status -ne 'passed' }).Count) { throw 'All 30 required restart/index witnesses must RUN and PASS' }
}
$rootsJson=Join-Path $evidenceRoot 'protected-roots.json'
node $vitest run server/engine-exclusion-protected-roots.test.ts --reporter=json "--outputFile=$rootsJson" *> (Join-Path $evidenceRoot 'protected-roots.log')
if ($LASTEXITCODE -ne 0) { throw 'Protected-root witnesses failed' }
$roots=Get-Content -Raw -LiteralPath $rootsJson | ConvertFrom-Json
$standIn=@($roots.testResults.assertionResults | Where-Object { $_.title -match 'W-stand-in-win32' -and $_.status -eq 'passed' })
if (-not $roots.success -or $roots.numFailedTests -ne 0 -or $roots.numPendingTests -ne 0 -or $standIn.Count -ne 1) { throw 'Protected-root and Windows stand-in witnesses must RUN and PASS' }
"TIP $Tip; Windows native F4 x20 PASS; 9 passed / 1 skipped / 6-of-6 per run; restart/index 30-of-30 x20 PASS; protected roots PASS" | Set-Content (Join-Path $evidenceRoot 'WINDOWS-F4.txt')
