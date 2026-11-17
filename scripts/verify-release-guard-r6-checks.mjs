// SPDX-License-Identifier: AGPL-3.0-or-later
// Container-only assertions, source-restored mutants, and isolated live fixture.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
const root = resolve('.'), out = resolve(process.argv[2]), mode = process.argv[3] ?? 'checks';
const scratch = mkdtempSync(join(tmpdir(), 'release-r6-checks-')); mkdirSync(out, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const results = [];
const run = (id, args, expected = 0) => {
  const result = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const log = result.stdout + result.stderr; writeFileSync(join(out, id + '.log'), log);
  results.push({ id, args, exitCode: result.status, signal: result.signal, error: result.error?.message });
  assert.equal(result.signal, null, id + ' completed'); if (result.error) throw result.error;
  assert.equal(result.status, expected, id + ' exit'); return log;
};
try {
  cpSync(root, scratch, { recursive: true, filter: path => !['node_modules', '.git', 'lane-evidence', 'dist', 'dist-server'].includes(relative(root, path).split('/')[0]) });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
  if (mode === 'live') run('live', ['scripts/verify-release-guard-r6-live.mjs', join(out, 'live')]);
  else {
    const start = JSON.parse(readFileSync(join(out, 'starting-source-bytes.json'), 'utf8'));
    const originals = Object.fromEntries(Object.keys(start).map(path => [path, readFileSync(join(scratch, path))]));
    try {
      for (const [path, text] of Object.entries(start)) writeFileSync(join(scratch, path), text);
      run('final-tests-red', ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r6.test.ts', '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'final-tests-red.json')], 1);
    } finally {
      for (const [path, text] of Object.entries(originals)) writeFileSync(join(scratch, path), text);
      writeFileSync(join(out, 'final-red-restoration.json'), JSON.stringify({ commit: '04d1a120c8cdfea44a93d9ce588639fd381b2bdc', restored: Object.entries(originals).every(([path, text]) => hash(readFileSync(join(scratch, path))) === hash(text)), startingHashes: Object.fromEntries(Object.entries(start).map(([path, text]) => [path, hash(text)])) }, null, 2) + '\n');
    }
    const tests = ['server/decision/release-guard-r2.test.ts', 'server/decision/release-guard-r3.test.ts', 'server/decision/release-guard-r4.test.ts', 'server/decision/release-guard-r5.test.ts', 'server/decision/release-guard-r6.test.ts'];
    run('focused', ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'final-focused.json')]);
    const mutants = [
      ['H1-lexical-collapse', 'server/no-limits-shell.ts', text => text.replace('resolve&&!physicalPaths?', 'resolve?'), 'R6 H1 (review dd|physical dd)'],
      ['H1-native-shortcut', 'server/wipe-path.ts', text => text.slice(0, text.indexOf('export function')) + "export function physicalWipePath(token: string, cwd?: string) { return realpathSync.native(isAbsolute(token) ? token : cwd + '/' + token); }\n", 'R6 H1 permission'],
      ['M1-probe-collision', 'server/decision/wipe-fingerprint.ts', () => start['server/decision/wipe-fingerprint.ts'], 'R6 M1'],
    ];
    for (const [id, path, mutate, pattern] of mutants) {
      const original = readFileSync(join(scratch, path), 'utf8'), changed = mutate(original); assert.notEqual(changed, original);
      writeFileSync(join(out, id + '-source.txt'), changed);
      try {
        writeFileSync(join(scratch, path), changed);
        const log = run(id, ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r6.test.ts', '-t', pattern, '--maxWorkers=2'], 1);
        assert.match(log, /AssertionError:/); assert.doesNotMatch(log, /Failed to parse|SyntaxError:|Cannot find module/);
      } finally {
        writeFileSync(join(scratch, path), original);
        assert.equal(readFileSync(join(scratch, path), 'utf8'), original);
      }
    }
    run('retained-mutants', ['scripts/verify-release-guard-r5-mutants.mjs', join(out, 'retained-mutants')]);
    run('backend-types', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']);
    run('lint', ['node_modules/oxlint/bin/oxlint', 'server/wipe-path.ts', 'server/no-limits-shell.ts', 'server/no-limits-wipe.ts', 'server/no-limits-code.ts', 'server/decision/wipe-fingerprint.ts', 'server/decision/release-guard-r6.test.ts', 'server/no-limits-code.test.ts', 'server/decision/main-addendum.test.ts', 'server/decision/faults.test.ts', 'scripts/verify-release-guard-r6-paired.mjs', 'scripts/verify-release-guard-r6-compare.mjs', 'scripts/verify-release-guard-r6-checks.mjs', 'scripts/verify-release-guard-r6-live.mjs', 'scripts/verify-release-guard-r5-mutants.mjs']);
  }
} finally {
  writeFileSync(join(out, mode + '-results.json'), JSON.stringify(results, null, 2) + '\n');
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
