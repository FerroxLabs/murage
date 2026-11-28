// Owner: wg-proof, safety boundary and review-regression producer/consumer.
// Run only in the assigned networkless container. All negative targets are temp fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { here, installPosix, psQuote as q } from './adapter.mjs';
import { execute } from './process.mjs';
import { assertTempRoot, snapshot } from './safety.mjs';
import { safeWipe } from '../testing/safe-wipe.mjs';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wipe-proof-'));
  try { return await run(root); }
  finally { await assertTempRoot(root); await safeWipe(root); }
}

test('H1: filesystem backends refuse outside removal and both move endpoints', () => fixture(async root => {
  const tree = path.join(root, 'tree'), outside = path.join(root, 'outside');
  await fs.mkdir(tree); await fs.mkdir(outside);
  const sentinel = path.join(outside, 'sentinel'); await fs.writeFile(sentinel, 'unchanged');
  const inside = path.join(tree, 'inside'); await fs.writeFile(inside, 'inside');
  const script = path.join(root, 'probe.ps1');
  await fs.writeFile(script, `$ErrorActionPreference='Stop'\n. ${q(path.join(here, 'windows/disk-fixture.ps1'))}\n` +
    `$rejected=0\n` +
    `try { Remove-Item -LiteralPath ${q(sentinel)} -Force } catch { $rejected++ }\n` +
    `try { Move-Item -LiteralPath ${q(inside)} -Destination ${q(path.join(outside, 'moved'))} } catch { $rejected++ }\n` +
    `try { Move-Item -LiteralPath ${q(sentinel)} -Destination ${q(path.join(tree, 'stolen'))} } catch { $rejected++ }\n` +
    `if ($rejected -ne 3) { exit 42 }\n` +
    `foreach ($name in @('Remove-Item','Move-Item')) {\n` +
    `foreach ($cmd in @(Get-Command $name -All -CommandType Cmdlet)) { if ($cmd.ImplementingType.Namespace -ne 'WipeProof') { exit 43 } }\n` +
    `if (Get-Command ('Microsoft.PowerShell.Management\\'+$name) -ErrorAction Ignore) { exit 44 }\n}\n`);
  const result = await execute(process.env.WIPE_PROOF_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script],
    { ...process.env, WIPE_PROOF_TREE: tree, WIPE_PROOF_BACKEND: path.join(root, 'backend') }, tree);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal(await fs.readFile(inside, 'utf8'), 'inside');
}));

test('M1: Windows tree oracle rejects a silently ignored benign delete', async () => {
  const driver = await fs.readFile(path.join(here, 'windows/driver.mjs'), 'utf8');
  const expression = driver.match(/const ok = ([\s\S]*?);\n\s+report\(engine.name/)[1];
  let treeMatches;
  try { ({ treeMatches } = await import('./windows/assertions.mjs')); } catch {}
  const before = { 'benign': 'directory', 'benign/build': 'directory', home: 'directory', 'home/child0': 'directory', 'home/child0/keep': 'hash' };
  const accepts = (test, after) => vm.runInNewContext(expression, {
    test, before, after, treeMatches, expected: 0, refused: false, outsideOk: true,
    outcome: { code: 0, error: false, timedOut: false, stderr: '' }, stdout: '',
    requests: [], backend: [], app: { faults: [] }, equal: (a,b) => JSON.stringify(a) === JSON.stringify(b),
  });
  // Exercise the driver's actual result expression, including its old bypass flags.
  assert.equal(accepts({ changedBenign: true, remove: ['benign/build'] }, before), false);
  assert.equal(accepts({ changedProtected: true, remove: ['home/child0'] }, before), false);
  const after = { ...before }; delete after['benign/build'];
  assert.equal(accepts({ changedBenign: true, remove: ['benign/build'] }, after), true);
});

test('M2: process output overflow is explicit and unsuccessful', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const result = await execute(process.execPath, ['-e', `process.${stream}.write('x'.repeat(100000));`], process.env, os.tmpdir());
    assert.equal(result.overflow, true);
    assert.equal(result.error, true);
    assert.ok(Buffer.byteLength(result[stream]) <= 65536);
  }
  const exact = await execute(process.execPath, ['-e', "process.stdout.write('x'.repeat(65536));"], process.env, os.tmpdir());
  assert.equal(exact.overflow, false);
  assert.equal(exact.stdout.length, 65536);
});

test('H1-boundary: positive mutations work; links, mixed lists, unsafe roots and providers refuse', () => fixture(async root => {
  const tree = path.join(root, 'tree'), outside = path.join(root, 'outside');
  await fs.mkdir(tree); await fs.mkdir(outside);
  const caseTwin = process.platform !== 'win32' ? path.join(root, 'TREE') : null;
  if (caseTwin) { await fs.mkdir(caseTwin); await fs.writeFile(path.join(caseTwin, 'keep'), 'case-sensitive sibling'); }
  await fs.writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await fs.mkdir(path.join(tree, 'build')); await fs.writeFile(path.join(tree, 'build', 'output'), 'fixture');
  await fs.mkdir(path.join(tree, 'retained')); await fs.writeFile(path.join(tree, 'retained', 'keep'), 'keep');
  await fs.symlink(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const script = path.join(root, 'probe.ps1');
  await fs.writeFile(script, `$ErrorActionPreference='Stop'\n. ${q(path.join(here, 'windows/disk-fixture.ps1'))}\n` +
    `Remove-Item -LiteralPath ${q(path.join(tree, 'build'))} -Recurse -Force\n` +
    `Move-Item -LiteralPath ${q(path.join(tree, 'retained'))} -Destination ${q(path.join(tree, 'moved'))}\n` +
    `$rejected=0\n` +
    `try { Remove-Item -LiteralPath ${q(path.join(tree, 'link'))} -Recurse -Force } catch { $rejected++ }\n` +
    `try { Remove-Item -LiteralPath @(${q(path.join(tree, 'moved'))},${q(outside)}) -Recurse -Force } catch { $rejected++ }\n` +
    `try { Remove-Item -LiteralPath Env:WIPE_PROOF_TREE } catch { $rejected++ }\n` +
    `try { Set-Item -Path ${q(path.join(outside, 'sentinel'))} -Value bad } catch { $rejected++ }\n` +
    (caseTwin ? `try { Remove-Item -LiteralPath ${q(caseTwin)} -Recurse -Force } catch { $rejected++ }\n` : '') +
    `$env:WIPE_PROOF_TREE=${q(path.parse(root).root)}\ntry { Remove-Item -LiteralPath ${q(tree)} -Recurse -Force } catch { $rejected++ }\n` +
    `if ($rejected -ne ${caseTwin ? 6 : 5}) { exit 45 }\n`);
  const outcome = await execute(process.env.WIPE_PROOF_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script],
    { ...process.env, WIPE_PROOF_TREE: tree, WIPE_PROOF_BACKEND: path.join(root, 'backend') }, tree);
  assert.equal(outcome.code, 0, JSON.stringify(outcome));
  const after = await snapshot(tree);
  assert.equal(after.build, undefined); assert.equal(after.retained, undefined);
  assert.equal(after['moved/keep']?.length, 64);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  if (caseTwin) assert.equal(await fs.readFile(path.join(caseTwin, 'keep'), 'utf8'), 'case-sensitive sibling');
}));

test('M3: adapter includes the production request serializer', () => fixture(async root => {
  const source = path.join(root, 'source'), destination = path.join(root, 'installed'); await fs.mkdir(source);
  for (const name of ['guard.sh', 'guard-lib.sh', 'guard-request.sh']) await fs.writeFile(path.join(source, name), name);
  await installPosix(destination, source);
  assert.equal(await fs.readFile(path.join(destination, 'guard-request.sh'), 'utf8'), 'guard-request.sh');
}));

test('M4: device witnesses kill a classifier with device matching removed', () => fixture(async root => {
  const driver = await fs.readFile(path.join(here, 'posix/driver.mjs'), 'utf8');
  assert.match(driver, /proveDevices\(/, 'the harness must actually run device-classification witnesses');
  const { proveDevices } = await import('./posix/device-proof.mjs');
  const good = path.join(root, 'good.sh'), bad = path.join(root, 'bad.sh');
  await fs.writeFile(good, 'wg_device() { case $wg_path in /dev/sda|/dev/nvme0n1|/dev/rdisk0) return 0;; *) return 1;; esac; }\n');
  await fs.writeFile(bad, 'wg_device() { return 1; }\n');
  const control = await proveDevices(good), mutant = await proveDevices(bad);
  assert.equal(control.every(x => x.ok), true);
  assert.equal(mutant.filter(x => !x.ok).length, 3);
  if (process.env.WIPE_PROOF_DEVICE_LIBRARY) {
    const published = await fs.readFile(process.env.WIPE_PROOF_DEVICE_LIBRARY, 'utf8');
    const productControl = await proveDevices(process.env.WIPE_PROOF_DEVICE_LIBRARY);
    assert.equal(productControl.every(x => x.ok), true);
    assert.ok(published.includes('wg_device() {'));
    await fs.writeFile(bad, published.replace('wg_device() {', 'wg_device() { return 1; # mutant: omit device detection'));
    const productMutant = await proveDevices(bad);
    assert.equal(productMutant.filter(x => !x.ok).length, 3);
  }
}));
