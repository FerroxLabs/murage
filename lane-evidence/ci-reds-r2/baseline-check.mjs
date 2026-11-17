import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const dir = 'lane-evidence/ci-reds-r2/';
const original = JSON.parse(readFileSync(dir + 'baseline-inputs.json', 'utf8'));
const fixed = Object.fromEntries(Object.keys(original).map(file => [file, readFileSync(file, 'utf8')]));
const run = label => {
  const result = spawnSync('node_modules/.bin/vitest', ['run', 'server/no-powershell-spawn.test.ts', 'server/channels/signal/transport.test.ts'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = result.stdout + result.stderr;
  writeFileSync(dir + label + '.log', output);
  assert.equal(result.status, 1, label + ' must reproduce the existing failed check');
  return { exit: result.status, failures: [...output.matchAll(/^ FAIL +(.+)$/gm)].map(match => match[1]).sort() };
};
let baseline, current;
try {
  current = run('current-comparison');
  for (const [file, source] of Object.entries(original)) writeFileSync(file, source);
  baseline = run('baseline-comparison');
} finally {
  for (const [file, source] of Object.entries(fixed)) writeFileSync(file, source);
}
assert.equal(current.failures.length, 12);
assert.deepEqual(current.failures, baseline.failures);
writeFileSync(dir + 'comparison.json', JSON.stringify({ baselineCommit: 'b45d7db77897a5ae38bc6f0356c3048998799a3d', restoredFiles: Object.keys(fixed), baseline, current, conclusion: 'Identical 12 failing test names before and after the Signal array fix. All temporary source changes restored.' }, null, 2) + '\n');
console.log('Confirmed identical 12 pre-existing failures; final sources restored.');
