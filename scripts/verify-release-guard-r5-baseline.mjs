// SPDX-License-Identifier: AGPL-3.0-or-later
// Container only. Run the full selected set with exact af48a0ee source bytes.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]);
const { commit, sources } = JSON.parse(readFileSync(join(out, 'baseline-source-bytes.json'), 'utf8'));
const selected = JSON.parse(readFileSync(join(out, 'baseline-selected-files.json'), 'utf8'));
const original = Object.fromEntries(Object.keys(sources).map(path => [path, readFileSync(path, 'utf8')]));
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { commit, selected, sourceHashes: Object.fromEntries(Object.entries(sources).map(([path, source]) => [path, hash(source)])) };
try {
  for (const [path, source] of Object.entries(sources)) writeFileSync(path, source);
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...selected, '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'baseline.json')];
  report.args = args;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 720000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(out, 'baseline.log'), result.stdout + result.stderr);
  report.exitCode = result.status; assert.equal(result.signal, null); if (result.error) throw result.error;
  assert.ok([0, 1].includes(result.status));
} finally {
  for (const [path, source] of Object.entries(original)) writeFileSync(path, source);
  report.restored = Object.entries(original).every(([path, source]) => readFileSync(path, 'utf8') === source);
  writeFileSync(join(out, 'baseline-receipt.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ commit, restored: report.restored, exitCode: report.exitCode }));
