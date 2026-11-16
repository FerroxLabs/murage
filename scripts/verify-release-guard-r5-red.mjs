// SPDX-License-Identifier: AGPL-3.0-or-later
// Container only. All review repros against unchanged 8f35f086 production.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]);
const sources = JSON.parse(readFileSync(join(out, 'red-source-bytes.json'), 'utf8'));
const original = Object.fromEntries(Object.keys(sources).map(path => [path, readFileSync(path, 'utf8')]));
const report = { commit: '8f35f086f390d01384385cb0efd478d73293c804' };
try {
  for (const [path, source] of Object.entries(sources)) writeFileSync(path, source);
  const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r5.test.ts', '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'review-red.json')];
  report.args = args;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(out, 'review-red.log'), result.stdout + result.stderr);
  report.exitCode = result.status; assert.equal(result.signal, null); if (result.error) throw result.error;
  assert.equal(result.status, 1);
} finally {
  for (const [path, source] of Object.entries(original)) writeFileSync(path, source);
  report.restored = Object.entries(original).every(([path, source]) => readFileSync(path, 'utf8') === source);
  writeFileSync(join(out, 'review-red-receipt.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
