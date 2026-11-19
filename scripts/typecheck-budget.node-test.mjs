// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { budgets, checkPeak, effectiveCap, heapCap, root } from './typecheck-budget.mjs';
import { inventory, programsIn, validateAllocation } from './typecheck-inventory.mjs';

test('all measured compiler peaks and workflow allocations have headroom', () => {
  validateAllocation();
  for (const entry of Object.values(budgets.programs)) if (entry.recordedPeakMiB !== null) checkPeak(entry.recordedPeakMiB, entry.capMiB);
});

test('memory growth and lowered workflow caps fail closed', () => {
  assert.throws(() => checkPeak(2868, 4096), /exceeds/);
  checkPeak(2867, 4096);
  assert.throws(() => checkPeak(NaN, 4096), /exceeds/);
  const row = inventory().find(row => row.program === 'server');
  assert.ok(row, 'full server check is wired');
  assert.throws(() => validateAllocation([{ ...row, configuredCapMiB: 6144 }]), /requires/);
  assert.equal(heapCap('--max-old-space-size=4096'), 4096);
});

test('1.0.20: large release runners declare the ubuntu compiler cap; the 70% rule holds against it', () => {
  const entry = budgets.programs['server-build'];
  // The rehearsal peak on macos-15-xlarge failed the recorded cap and passes the declared one.
  assert.throws(() => checkPeak(3022.7, entry.capMiB), /exceeds/);
  const cap = effectiveCap(entry, { MURAGE_TYPECHECK_CAP_MIB: '8192', NODE_OPTIONS: '--max-old-space-size=8192' });
  assert.equal(cap, 8192);
  checkPeak(3022.7, cap);
  assert.throws(() => checkPeak(5735, cap), /exceeds/);
  assert.equal(effectiveCap(entry, {}), entry.capMiB);
  assert.throws(() => effectiveCap(entry, { MURAGE_TYPECHECK_CAP_MIB: '4096', NODE_OPTIONS: '--max-old-space-size=8192' }), /below the recorded/);
  assert.throws(() => effectiveCap(entry, { MURAGE_TYPECHECK_CAP_MIB: '8192', NODE_OPTIONS: '--max-old-space-size=4300' }), /needs NODE_OPTIONS/);
  assert.throws(() => effectiveCap(entry, { MURAGE_TYPECHECK_CAP_MIB: '8192' }), /needs NODE_OPTIONS/);
  const rows = inventory().filter(row => row.program === 'server-build');
  for (const [file, job] of [['release.yml', 'mac'], ['release.yml', 'windows'], ['release.yml', 'linux'], ['ci.yml', 'package-linux']]) {
    const row = rows.find(row => row.file.endsWith(file) && row.job === job);
    assert.ok(row, `${file}:${job} runs server-build`);
    assert.equal(row.declaredCapMiB, 8192, `${file}:${job}`);
    assert.equal(row.configuredCapMiB, 8192, `${file}:${job}`);
  }
  const mac = rows.find(row => row.file.endsWith('release.yml') && row.job === 'mac');
  assert.equal(mac.ramMiB, 14 * 1024);
  // A declared cap on a 7 GB macOS runner, or without the heap to back it, fails the static check.
  assert.throws(() => validateAllocation([{ ...mac, ramMiB: 7 * 1024 }]), /60% of runner RAM/);
  assert.throws(() => validateAllocation([{ ...mac, configuredCapMiB: 4300 }]), /requires 8192/);
  assert.throws(() => validateAllocation([{ ...mac, configuredCapMiB: null }]), /without a NODE_OPTIONS/);
  assert.throws(() => validateAllocation([{ ...mac, declaredCapMiB: 4096 }]), /below the recorded/);
});

test('package indirection inventories all production compilers', () => {
  assert.deepEqual(new Set(programsIn('pnpm package:linux:offline').map(row => row.program)), new Set(['frontend-build', 'server-build', 'server-emit', 'companion-build']));
  assert.ok(programsIn('pnpm exec tsc -p tsconfig.server.json').some(row => !row.managed && row.program === 'tsconfig.server.json'));
});

test('PR quality and release gate run the same complete check on Linux', () => {
  const load = file => parse(readFileSync(`${root}/.github/workflows/${file}`, 'utf8'));
  const ci = load('ci.yml');
  const release = load('release.yml');
  assert.ok('pull_request' in ci.on);
  const quality = ci.jobs.quality.steps.find(step => step.run === 'pnpm typecheck');
  const gate = release.jobs['ci-gate'].steps.find(step => step.run === 'pnpm typecheck');
  assert.equal(quality.if, undefined);
  assert.equal(quality['continue-on-error'], undefined);
  assert.match(quality.env.MURAGE_TYPECHECK_MODE, /matrix.os == 'ubuntu-24.04' && 'full'/);
  assert.equal(gate.env.MURAGE_TYPECHECK_MODE, 'full');
  assert.equal(gate.if, undefined);
  assert.equal(gate['continue-on-error'], undefined);
  assert.equal(release.jobs['ci-gate']['runs-on'], 'ubuntu-24.04');
  assert.ok(ci.jobs.required.needs.includes('quality'));
  assert.ok(release.jobs.stage.needs.includes('ci-gate'));
  const scripts = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).scripts;
  assert.equal(scripts.typecheck, 'node scripts/typecheck-budget.mjs full');
  assert.match(scripts.build, /^node scripts\/typecheck-budget.mjs production && vite build$/);
});

test('emission can only follow real checks over the same production configuration', () => {
  assert.equal(budgets.programs['server-build'].typecheckOnly, true);
  assert.equal(budgets.programs['server-build'].emitProgram, 'server-emit');
  assert.equal(budgets.programs['server-emit'].config, budgets.programs['server-build'].config);
  assert.deepEqual(Object.entries(budgets.programs).filter(([, entry]) => entry.noCheck).map(([name]) => name), ['server-emit']);
  assert.ok(!budgets.groups.full.includes('server-emit'));
});

test('release inventory requires every native wipe matrix member', async () => {
  const { FULL_RUN_JOBS, REQUIRED_JOB, judgeRun } = await import('./release-ci-gate.mjs');
  const matrix = 'wipe proof (${{ matrix.os }})';
  const jobs = FULL_RUN_JOBS.filter(name => name !== matrix).map(name => ({ name, conclusion: 'success' }));
  jobs.push({ name: REQUIRED_JOB, conclusion: 'success' });
  const members = ['macos-latest', 'ubuntu-24.04', 'windows-latest'].map(os => ({ name: `wipe proof (${os})`, conclusion: 'success' }));
  assert.equal(judgeRun([...jobs, ...members]).proof, 'full');
  for (const member of members) {
    assert.equal(judgeRun([...jobs, ...members.filter(job => job !== member)]).proof, 'incomplete');
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      assert.equal(judgeRun([...jobs, ...members.filter(job => job !== member), { ...member, conclusion }]).proof, 'incomplete');
    }
  }
});
