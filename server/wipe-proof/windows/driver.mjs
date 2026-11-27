import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { here, product, installWindows, psQuote as q } from '../adapter.mjs';
import { assertTempRoot, assertTarget, snapshot, equal } from '../safety.mjs';
import { startApp } from '../app.mjs';
import { treeMatches } from './assertions.mjs';
import { execute } from '../process.mjs';
import { safeWipe } from '../../testing/safe-wipe.mjs';
const argv = process.argv.slice(2);
if (process.platform !== 'win32') { console.error('FAIL windows-required'); process.exit(2); }
let source = product.powershell;
if (argv.length) {
  if (argv.length !== 2 || argv[0] !== '--guard-directory') { console.error('FAIL arguments'); process.exit(2); }
  source = path.resolve(argv[1]);
}
const results = [], unavailable = [];
const report = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
let sandbox, app;
try {
  sandbox = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wipe-proof-'));
  await assertTempRoot(sandbox);
  const tree = path.join(sandbox, 'tree'), protectedRoot = path.join(tree, 'home'), benign = path.join(tree, 'benign');
  const control = path.join(sandbox, 'control'), outside = path.join(sandbox, 'outside');
  await fs.mkdir(control); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel'), 'unchanged');
  const outsideBefore = await snapshot(sandbox, [tree, control]);
  const shim = path.join(control, 'shim'), real = path.join(control, 'real'), guardFile = path.join(control, 'guard.json');
  await installWindows(shim, source); await fs.mkdir(real);
  const backendLog = path.join(control, 'backend.txt'), script = path.join(control, 'case.ps1');
  const realTools = {};
  for (const tool of ['format', 'diskpart']) {
    const file = path.join(real, tool + '.cmd'); realTools[tool] = file;
    await fs.writeFile(file, '@echo off\r\n"' + process.execPath + '" "' + path.join(here, 'fixture-tool.mjs') + '" ' + tool + ' %*\r\nexit /b %errorlevel%\r\n');
  }
  const token = randomUUID(), threadId = 'fixture-thread', socket = '\\\\.\\pipe\\murage-wipe-' + randomUUID().replaceAll('-', '');
  app = await startApp(socket, tree, token, threadId);
  const config = { v: 1, socket, threadId, token, roots: [protectedRoot], client: [process.execPath, product.client], realTools, off: false };
  const baseEnv = { ...process.env, PATH: shim + ';' + real + ';' + process.env.PATH,
    MURAGE_WIPE_GUARD: guardFile, MURAGE_WIPE_GUARD_OFF: '', WIPE_PROOF_TREE: tree, WIPE_PROOF_BACKEND: backendLog };
  const engines = [];
  for (const [name, executable, major] of [['powershell-5.1', 'powershell.exe', 5], ['powershell-7', 'pwsh.exe', 7]]) {
    const probe = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], baseEnv, control);
    const version = probe.stdout.trim().split('.').map(Number);
    if (probe.code === 0 && version[0] === major && (major !== 5 || version[1] === 1)) engines.push({ name, executable });
    else { unavailable.push(name); console.log('UNAVAILABLE ' + name); }
  }
  if (!engines.length) throw Error('no-powershell');
  const prelude = `$ErrorActionPreference='Stop'\n$PROTECTED=${q(protectedRoot)}\n$BENIGN=${q(benign)}\n` +
    `. ${q(path.join(here, 'windows/disk-fixture.ps1'))}\n` +
    `$fixtureRemove=Get-Command Remove-Item -CommandType Cmdlet\n$fixtureMove=Get-Command Move-Item -CommandType Cmdlet\n$OUTSIDE=${q(outside)}\n` +
    // If a disk shim fails to read its guard it may ONLY fall back to this empty
    // fixture System32. A real disk executable is never a possible fallback.
    `$env:SystemRoot=${q(path.join(control, 'empty-system'))}\n` +
    `foreach ($tool in @('format','diskpart')) {\n` +
    `$resolved = (Get-Command -Name $tool -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source\n` +
    `if (![string]::Equals($resolved, (Join-Path ${q(shim)} ($tool+'.cmd')), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe external tool resolution' }\n}\n`;
  await fs.mkdir(path.join(control, 'empty-system', 'System32'), { recursive: true });
  const guardLoad = `. ${q(path.join(shim, 'guard.ps1'))}\n`;
  const cases = [
    { name: 'outside-remove-backend', command: 'try { & $fixtureRemove -LiteralPath (Join-Path $OUTSIDE sentinel) -Force; exit 99 } catch { if ($_.Exception.Message -notlike "*fixture outside tree*") { throw } }' },
    { name: 'outside-move-destination-backend', command: 'try { & $fixtureMove -LiteralPath (Join-Path $BENIGN build) -Destination (Join-Path $OUTSIDE moved); exit 99 } catch { if ($_.Exception.Message -notlike "*fixture outside tree*") { throw } }' },
    { name: 'outside-move-source-backend', command: 'try { & $fixtureMove -LiteralPath (Join-Path $OUTSIDE sentinel) -Destination (Join-Path $BENIGN stolen); exit 99 } catch { if ($_.Exception.Message -notlike "*fixture outside tree*") { throw } }' },
    { name: 'literal-root', command: 'Remove-Item -Recurse -Force $PROTECTED', match: true },
    { name: 'variable-root', command: '$p=$PROTECTED; Remove-Item -LiteralPath $p -Recurse -Force', match: true },
    { name: 'pipeline-root', command: 'Get-Item -LiteralPath $PROTECTED | Remove-Item -Recurse -Force', match: true },
    { name: 'pipeline-children', command: 'Get-ChildItem -LiteralPath $PROTECTED | Remove-Item -Recurse -Force', match: true },
    { name: 'pipeline-location', command: 'Set-Location $PROTECTED; Get-Location | Remove-Item -Recurse -Force', match: true },
    { name: 'relative-quoted-wildcard', command: 'Set-Location $PROTECTED; Remove-Item -Recurse -Force "*"', match: true },
    { name: 'relative-dot-wildcard', command: 'Set-Location $PROTECTED; Remove-Item -Recurse -Force .\\*', match: true },
    { name: 'wildcard-protected-name', command: 'Remove-Item -Recurse -Force (Join-Path (Split-Path $PROTECTED) "ho[m]e")', match: true },
    { name: 'long-list-last', command: '@(1..9 | ForEach-Object { Join-Path $BENIGN "missing$_" }) + @($PROTECTED) | ForEach-Object { if (Test-Path $_) { Remove-Item -Recurse -Force $_ } }', match: true },
    { name: 'move-root', command: 'Move-Item $PROTECTED (Join-Path $BENIGN moved)', match: true },
    ...['ri', 'rm', 'rmdir', 'del', 'erase', 'rd'].map(alias => ({ name: 'alias-' + alias, command: `${alias} -Recurse -Force $PROTECTED`, match: true })),
    ...['mi', 'mv', 'move'].map(alias => ({ name: 'alias-' + alias, command: `${alias} $PROTECTED (Join-Path $BENIGN moved)`, match: true })),
    { name: 'benign-build', command: 'Remove-Item -Recurse -Force (Join-Path $BENIGN build)', remove: ['benign/build'] },
    { name: 'benign-spaces', command: 'Remove-Item -LiteralPath (Join-Path $BENIGN "space dir") -Recurse -Force', remove: ['benign/space dir'] },
    { name: 'pipeline-first-child', command: 'Get-ChildItem $PROTECTED | Sort-Object Name | Select-Object -First 1 | Remove-Item -Recurse -Force', remove: ['home/child0'] },
    { name: 'printed-source', command: 'Write-Output "Remove-Item -Recurse"', stdout: 'Remove-Item -Recurse\n' },
    { name: 'allow-root', command: 'Remove-Item -Recurse -Force $PROTECTED', match: true, allow: true, remove: ['home'] },
    { name: 'app-unreachable', command: 'Remove-Item -Recurse -Force $PROTECTED', variant: 'unreachable', refused: true },
    { name: 'wrong-reply-id', command: 'Remove-Item -Recurse -Force $PROTECTED', match: true, decision: 'wrong-id' },
    { name: 'disconnect', command: 'Remove-Item -Recurse -Force $PROTECTED', match: true, decision: 'disconnect' },
    ...['missing', 'malformed', 'off', 'env-off'].map(variant => ({ name: 'fail-open-' + variant, command: 'Remove-Item -Recurse -Force $PROTECTED', variant, remove: ['home'] })),
    ...['Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition'].flatMap(tool => [
      { name: tool + '-deny', command: `${tool} -Path (Join-Path $PROTECTED device)`, match: true, disk: true },
      { name: tool + '-allow-fixture', command: `${tool} -Path (Join-Path $PROTECTED device)`, match: true, disk: true, allow: true, backend: 1, stdout: 'fixture disk backend\n' },
    ]),
    ...['format', 'diskpart'].flatMap(tool => [
      { name: tool + '-deny-before-exec', command: `& ${q(tool)} (Join-Path $PROTECTED device); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`, match: true, external: true },
      { name: tool + '-allow-sentinel', command: `& ${q(tool)} (Join-Path $PROTECTED device); exit $LASTEXITCODE`, match: true, external: true, allow: true, backend: 1 },
      { name: tool + '-unreachable', command: `& ${q(tool)} (Join-Path $PROTECTED device); exit $LASTEXITCODE`, external: true, variant: 'unreachable', refused: true },
    ]),
  ];
  async function reset(test) {
    await fs.mkdir(tree, { recursive: true }); await assertTarget(sandbox, tree); await safeWipe(tree);
    await fs.mkdir(protectedRoot, { recursive: true }); await fs.mkdir(benign);
    for (let i = 0; i < 10; i++) await fs.mkdir(path.join(protectedRoot, 'child' + i));
    await fs.writeFile(path.join(protectedRoot, 'child0', 'keep'), 'protected');
    for (const name of ['build', 'space dir']) await fs.mkdir(path.join(benign, name));
    await fs.writeFile(backendLog, '');
    await fs.writeFile(guardFile, test.variant === 'malformed' ? '{' : JSON.stringify({ ...config, off: test.variant === 'off',
      socket: test.variant === 'unreachable' ? '\\\\.\\pipe\\murage-wipe-' + randomUUID().replaceAll('-', '') : socket }));
  }
  for (const engine of engines) {
    for (const test of cases) {
      await reset(test);
      const before = await snapshot(tree), requestStart = app.requests.length;
      const env = { ...baseEnv };
      if (test.variant === 'missing') delete env.MURAGE_WIPE_GUARD;
      if (test.variant === 'env-off') env.MURAGE_WIPE_GUARD_OFF = '1';
      app.script([test.decision ?? (test.allow ? 'allow' : 'deny')]);
      // Catch proxy errors only to expose BOTH process status and LASTEXITCODE.
      const body = prelude + guardLoad + `try {\n${test.command}\n} catch {\n` +
        `if ($global:LASTEXITCODE -eq 126) { [Console]::Error.WriteLine('fixture refusal 126'); exit 1 }; throw\n}\n`;
      await fs.writeFile(script, body);
      const outcome = await execute(engine.executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], env, tree, 30000);
      const requests = app.requests.slice(requestStart);
      const backend = (await fs.readFile(backendLog, 'utf8')).trim().split('\n').filter(Boolean);
      const after = await snapshot(tree);
      const refused = test.refused || test.match && !test.allow;
      const expected = refused ? test.external ? 126 : 1 : 0;
      const outsideOk = equal(outsideBefore, await snapshot(sandbox, [tree, control]));
      const stdout = outcome.stdout.replaceAll('\r\n', '\n');
      const ok = outcome.code === expected && !outcome.timedOut && !outcome.error &&
        requests.length === (test.match ? 1 : 0) && backend.length === (test.backend ?? 0) &&
        stdout === (test.stdout ?? '') && (!refused || test.external || outcome.stderr.includes('fixture refusal 126')) &&
        treeMatches(before, after, test) &&
        outsideOk && app.faults.length === 0;
      report(engine.name + '/' + test.name, ok, { exit: outcome.code, expectedExit: expected, requests: requests.length, backendCalls: backend.length, outsideOk, overflow: outcome.overflow });
    }
    await reset({}); app.script(['deny']);
    const requestStart = app.requests.length;
    // Same runspace timing avoids measuring PowerShell startup as proxy overhead.
    await fs.writeFile(script, prelude + guardLoad + `
$path = Join-Path $BENIGN missing
1..10 | ForEach-Object { Remove-Item -LiteralPath $path -Force -ErrorAction Ignore }
$real = [Diagnostics.Stopwatch]::StartNew()
1..200 | ForEach-Object { Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $path -Force -ErrorAction Ignore }
$real.Stop()
$proxy = [Diagnostics.Stopwatch]::StartNew()
1..200 | ForEach-Object { Remove-Item -LiteralPath $path -Force -ErrorAction Ignore }
$proxy.Stop()
@{ overheadMs = ($proxy.Elapsed.TotalMilliseconds - $real.Elapsed.TotalMilliseconds)/200 } | ConvertTo-Json -Compress
`);
    const timing = await execute(engine.executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], baseEnv, tree, 30000);
    let overheadMs; try { overheadMs = JSON.parse(timing.stdout).overheadMs; } catch {}
    report(engine.name + '/fast-path-under-5ms', timing.code === 0 && !timing.error && !timing.timedOut && Number.isFinite(overheadMs) && overheadMs < 5 && app.requests.length === requestStart, { overheadMs });
  }
} catch { report('fixture-setup-or-run', false); }
finally {
  if (app) await app.close();
  if (sandbox) { await assertTempRoot(sandbox); await safeWipe(sandbox); }
}
const summary = { kind: 'wipe-proof-windows', mode: 'production-guard-with-inert-disk-cmdlets',
  passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, unavailable,
  productionQualified: !results.some(x => !x.ok) && unavailable.length === 0, cases: results };
console.log(JSON.stringify(summary)); process.exitCode = summary.failed ? 1 : 0;
