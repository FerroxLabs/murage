// SPDX-License-Identifier: AGPL-3.0-or-later
// Container only; mutants run in a private snapshot and restore exact bytes.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
const root = resolve('.'), out = resolve(process.argv[2]);
const scratch = mkdtempSync(join(tmpdir(), 'release-r7-checks-')); mkdirSync(out, { recursive: true });
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
  const manifest = JSON.parse(readFileSync(join(out, 'final-source-sha256.json'), 'utf8'));
  for (const [path, expected] of Object.entries(manifest)) assert.equal(hash(readFileSync(join(scratch, path))), expected, path);
  const tests = ['server/decision/release-guard-r2.test.ts', 'server/decision/release-guard-r3.test.ts', 'server/decision/release-guard-r4.test.ts', 'server/decision/release-guard-r5.test.ts', 'server/decision/release-guard-r6.test.ts'];
  const starting = JSON.parse(readFileSync(join(out, 'starting-source-bytes.json'), 'utf8'));
  const originals = Object.fromEntries(Object.keys(starting).map(path => [path, readFileSync(join(scratch, path))]));
  try {
    for (const [path, text] of Object.entries(starting)) writeFileSync(join(scratch, path), text);
    run('final-tests-red', ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r6.test.ts', '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'final-tests-red.json')], 1);
  } finally {
    for (const [path, text] of Object.entries(originals)) writeFileSync(join(scratch, path), text);
    writeFileSync(join(out, 'red-restoration.json'), JSON.stringify({ commit: '1fc13b4a4818fe82e90d638f66de8f32a994becd', restored: Object.entries(originals).every(([path, text]) => hash(readFileSync(join(scratch, path))) === hash(text)), startingHashes: Object.fromEntries(Object.entries(starting).map(([path, text]) => [path, hash(text)])) }, null, 2) + '\n');
  }
  run('focused', ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'focused.json')]);
  const mutants = [
    ['delete-fail-open', 'server/no-limits-wipe.ts', () => starting['server/no-limits-wipe.ts']],
    ['missing-before-parent-absent', 'server/wipe-path.ts', text => text.replace(" && !stack.some(next => 'part' in next && next.part === '..')", '')],
    ['loop-fail-open', 'server/no-limits-wipe.ts', text => text.replace("if(error instanceof Error&&error.message", "if((error)?.code==='ELOOP')return null;\n if(error instanceof Error&&error.message")],
    ['permission-fail-open', 'server/no-limits-wipe.ts', text => text.replace("if(error instanceof Error&&error.message", "if((error)?.code==='EACCES')return null;\n if(error instanceof Error&&error.message")],
    ['absent-cleanup-cards', 'server/wipe-path.ts', text => text.replace("if (allowAbsent === 'delete' &&", "if (allowAbsent === 'disabled-delete' &&")],
  ];
  for (const [id, path, mutate] of mutants) {
    const original = readFileSync(join(scratch, path), 'utf8'), changed = mutate(original); assert.notEqual(changed, original);
    writeFileSync(join(out, id + '-source.txt'), changed);
    try {
      writeFileSync(join(scratch, path), changed);
      const log = run(id, ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r6.test.ts', '-t', 'R7 H1', '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, id + '.json')], 1);
      const report = JSON.parse(readFileSync(join(out, id + '.json'), 'utf8'));
      assert.ok(report.numFailedTests > 0);
      assert.ok(report.testResults.flatMap(file => file.assertionResults).some(test => test.failureMessages.some(message => message.includes('AssertionError:'))));
      assert.doesNotMatch(log, /Failed to parse|SyntaxError:|Cannot find module/);
    } finally {
      writeFileSync(join(scratch, path), original);
      assert.equal(readFileSync(join(scratch, path), 'utf8'), original);
      results.at(-1).restored = true;
    }
  }
  run('backend-types', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']);
  run('lint', ['node_modules/oxlint/bin/oxlint', 'server/wipe-path.ts', 'server/no-limits-wipe.ts', 'server/decision/release-guard-r6.test.ts', 'scripts/verify-release-guard-r7-checks.mjs', 'scripts/verify-release-guard-r7-live.mjs']);
} finally {
  writeFileSync(join(out, 'checks-results.json'), JSON.stringify(results, null, 2) + '\n');
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
