// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute complete failing suites against the saved af48a0ee source bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const out = resolve(process.argv[2]);
const baseline = JSON.parse(readFileSync(join(out, 'baseline-sources.json'), 'utf8'));
const originals = new Map(Object.keys(baseline.sources).map(path => [path, readFileSync(path, 'utf8')]));
let result;
try {
  for (const [path, source] of Object.entries(baseline.sources)) writeFileSync(path, source);
  result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'server/no-limits-segment-design.test.ts', 'scripts/no-limits-live/mandatory-wipe.test.mjs', '--maxWorkers=2'],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const log = result.stdout + result.stderr;
  writeFileSync(join(out, 'baseline-known-failures.log'), log);
  assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.match(log, /5 failed/); assert.match(log, /round2-word-RED/); assert.match(log, /lost-live-record/);
} finally {
  for (const [path, source] of originals) writeFileSync(path, source);
  writeFileSync(join(out, 'baseline-comparison.json'), JSON.stringify({ baseline: baseline.revision,
    sources: Object.fromEntries(Object.entries(baseline.sources).map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])),
    status: result?.status, restored: [...originals].every(([path, source]) => readFileSync(path, 'utf8') === source) }, null, 2) + '\n');
}
console.log('af48a0ee baseline reproduces the same five failures; candidate sources restored');
