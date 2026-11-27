// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: the CI lane owns the proof caller (ci/run-real-proof.mjs); wg-wiring owns the wrapper (server/drivers/murage-exec).
// The Git Bash wipe proof runs every command through the real wrapper. The Linux fixture checks that W2 accepts
// both Windows spellings of the wrapper and refuses a turn map outside its folder.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fastPathBlocks, fastPathBudgetMs, medianBlock } from '../server/wipe-proof/adapter.mjs';

const file = name => new URL(`../${name}`, import.meta.url);
const read = name => readFileSync(file(name), 'utf8');

/** Every way the proof caller stops naming the wrapper the way production does, or loses the timing budget. */
export function seamContract(runner, driver) {
  const problems = [];
  if (!runner.includes('import { murageExecPrefix, writeExecEnvFile } from')) problems.push('caller does not import the production prefix');
  if (!runner.includes('[murageExecPrefix(), command],')) problems.push('wrapper is not named by the production prefix');
  if (/installMurageExec\s*\(/.test(runner)) problems.push('wrapper is named by its native install path');
  if (!driver.includes("execute(executable, ['-c', shell === 'fish' && test.fish ? test.fish : test.command], env, tree);")) problems.push('driver has no direct shell call for the caller to replace');
  if (!driver.includes("posixStatus } from '../adapter.mjs'")) problems.push('driver import the caller extends is gone');
  if (!runner.includes(`"'fast-path-at-most-10ms', overheadMs <= fastPathBudgetMs(process.platform, median(timings.real))"`)) problems.push('fast path is not held to the shared budget');
  if (!driver.includes("'fast-path-under-5ms', overheadMs < 5")) problems.push('driver timing row the caller replaces is gone');
  if (!driver.includes('for (let block = 0; block < fastPathBlocks; block++) {')) problems.push('fast path is timed in one block');
  if (!driver.includes('const { timings, overheadMs } = medianBlock(blocks);')) problems.push('fast path is not judged on the median block');
  return problems;
}

it('T-WIPE-GITBASH-SEAM: the proof caller names the wrapper exactly as Claude is handed it', () => {
  expect(seamContract(read('ci/run-real-proof.mjs'), read('server/wipe-proof/posix/driver.mjs'))).toEqual([]);
});

it.each([
  ['[murageExecPrefix(), command],', '[installMurageExec(), command],'],
  ['[murageExecPrefix(), command],', "[murageExecPrefix().replaceAll('/', path.sep), command],"],
  ['import { murageExecPrefix, writeExecEnvFile } from', 'import { installMurageExec, writeExecEnvFile } from'],
  ['overheadMs <= fastPathBudgetMs(process.platform, median(timings.real))"', 'overheadMs <= 10"'],
])('T-WIPE-GITBASH-SEAM mutant: a caller without "%s" goes red', (anchor, replacement) => {
  const runner = read('ci/run-real-proof.mjs');
  expect(runner).toContain(anchor);
  expect(seamContract(runner.replace(anchor, replacement), read('server/wipe-proof/posix/driver.mjs')).length).toBeGreaterThan(0);
});

// The real wrapper under a real Bash, with the two MSYS commands it asks (uname, cygpath) answered as Git Bash answers
// them. Drive X: is a folder of the fixture. The wrapper is started as `bash <path> <command>`, as the proof starts it.
describe.skipIf(process.platform !== 'linux')('the real wrapper under Git Bash spellings', () => {
  function run(wrapper, mapFolder = 'W') {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wipe-gitbash-')));
    try {
      const drive = join(root, 'drive'), start = join(root, 'start'), work = join(root, 'work');
      const key = 'a'.repeat(24);
      mkdirSync(join(drive, 'W', 'env'), { recursive: true }); mkdirSync(start); mkdirSync(work);
      copyFileSync(file('server/drivers/murage-exec'), join(drive, 'W', 'murage-exec-fixture'));
      copyFileSync(file('server/drivers/murage-exec.shapes'), join(drive, 'W', 'murage-exec-fixture.shapes'));
      chmodSync(join(drive, 'W', 'murage-exec-fixture'), 0o755);
      const ownedMap = join(drive, 'W', 'env', key);
      writeFileSync(ownedMap,
        [`MURAGE_EXEC_CWD=${work}`, 'MURAGE_EXEC_SHELL=/bin/sh', 'MURAGE_EXEC_PROVEN=0', 'PATH=/usr/bin:/bin', 'WITNESS=from-the-map']
          .map(pair => pair + '\0').join(''));
      mkdirSync(join(drive, 'foreign', 'env'), { recursive: true });
      copyFileSync(ownedMap, join(drive, 'foreign', 'env', key));
      // A drive path opens from the start folder in either spelling, as it does natively under MSYS.
      symlinkSync(drive, join(start, 'X:'));
      symlinkSync(join(drive, 'W', 'murage-exec-fixture'), join(start, 'X:\\W\\murage-exec-fixture'));
      const map = `X:\\${mapFolder}\\env\\${key}`;
      symlinkSync(join(drive, mapFolder, 'env', key), join(start, map));
      const cygpath = `() { local v; for v in "$@"; do :; done; v=\${v//\\\\//}; case $v in X:*) v="$FIXTURE_DRIVE\${v#?:}" ;; esac; printf '%s\\n' "$v"; }`;
      const result = spawnSync('/bin/bash', [wrapper, 'printf "%s\\n" "ran:$WITNESS"'], {
        cwd: start, encoding: 'utf8', timeout: 20000,
        env: { PATH: '/usr/bin:/bin', MURAGE_EXEC_ENV_FILE: map, FIXTURE_DRIVE: drive,
          'BASH_FUNC_uname%%': '() { echo MINGW64_NT-10.0-26100; }', 'BASH_FUNC_cygpath%%': cygpath },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it.each([
    ['forward slashes', 'X:/W/murage-exec-fixture'],
    ['backslashes', 'X:\\W\\murage-exec-fixture'],
  ])('T-WIPE-GITBASH-W2: %s run the command with the turn map', (_spelling, wrapper) => {
    expect(run(wrapper)).toEqual({ status: 0, stdout: 'ran:from-the-map\n', stderr: '' });
  });

  it('T-WIPE-GITBASH-W2: a foreign turn map is refused before the command runs', () => {
    const refused = run('X:\\W\\murage-exec-fixture', 'foreign');
    expect(refused.status).toBe(126);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toBe("murage-exec: the turn environment is not Murage's\n");
  });
});

it.each([
  ['const { timings, overheadMs } = medianBlock(blocks);', 'const { timings, overheadMs } = blocks.at(-1);'],
  ['for (let block = 0; block < fastPathBlocks; block++) {', 'for (let block = 0; block < 1; block++) {'],
])('T-WIPE-FAST-BLOCKS mutant: a driver with "%s" changed goes red', (anchor, replacement) => {
  const driver = read('server/wipe-proof/posix/driver.mjs');
  expect(driver).toContain(anchor);
  expect(seamContract(read('ci/run-real-proof.mjs'), driver.replace(anchor, replacement)).length).toBeGreaterThan(0);
});

describe('T-WIPE-FAST-BLOCKS: the fast path is judged on the median of independent blocks, never widened', () => {
  const judge = overheads => medianBlock(overheads.map(overheadMs => ({ overheadMs }))).overheadMs;
  it('an odd number of at least three blocks, so the median is one measured block', () => {
    expect(fastPathBlocks).toBeGreaterThanOrEqual(3);
    expect(fastPathBlocks % 2).toBe(1);
  });
  it('one block spoiled by host load (the 11.07 ms macOS row) does not fail a 5 ms shim', () => {
    for (const order of [[11.07, 5.12, 5.3], [5.12, 11.07, 5.3], [5.12, 5.3, 11.07]]) expect(judge(order)).toBe(5.3);
    expect(judge([11.07, 5.12, 5.3])).toBeLessThanOrEqual(fastPathBudgetMs('darwin', 3.99));
  });
  it('a shim over budget in most blocks still fails the unchanged 10 ms ruling', () => {
    expect(judge([11.07, 10.5, 5.12])).toBe(10.5);
    expect(judge([11.07, 10.5, 5.12])).toBeGreaterThan(fastPathBudgetMs('darwin', 3.99));
    expect(judge([12, 11, 10.01])).toBeGreaterThan(fastPathBudgetMs('linux', 2));
  });
});

describe('T-WIPE-GITBASH-FAST: the fast-path budget', () => {
  it('is the plain 10 ms ruling on every host but Git Bash', () => {
    expect(fastPathBudgetMs('linux', 1.98)).toBe(10);
    expect(fastPathBudgetMs('darwin', 3.99)).toBe(10);
    expect(fastPathBudgetMs('linux', 500)).toBe(10);
  });
  it('adds one measured process image under Git Bash, and nothing more', () => {
    // Public CI medians of the two Windows runs: direct 24.31 / 23.39 ms, overhead 10.07 / 10.02 ms.
    expect(fastPathBudgetMs('win32', 24.3056)).toBeCloseTo(22.1528, 4);
    expect(10.0721).toBeLessThanOrEqual(fastPathBudgetMs('win32', 24.3056));
    expect(10.0162).toBeLessThanOrEqual(fastPathBudgetMs('win32', 23.3922));
    // A shim that cost a second extra image (a whole direct call of overhead) is still refused.
    expect(24.3056).toBeGreaterThan(fastPathBudgetMs('win32', 24.3056));
    expect(23.3922).toBeGreaterThan(fastPathBudgetMs('win32', 23.3922));
  });
});
