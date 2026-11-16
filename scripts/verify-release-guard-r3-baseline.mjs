// SPDX-License-Identifier: AGPL-3.0-or-later
// Compare entire failing suites with exact starting production bytes. Container only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const out = resolve(process.argv[2]);
const baseline = JSON.parse(readFileSync(join(out, 'baseline-source-bytes.json'), 'utf8'));
const originals = Object.fromEntries(Object.keys(baseline).map(path => [path, readFileSync(path, 'utf8')]));
const sha = text => createHash('sha256').update(text).digest('hex');
const report = { baseline: '27c9d841eaa1733fe2a41f97d746527f045f255c', baselineSources: Object.fromEntries(Object.entries(baseline).map(([path, text]) => [path, sha(text)])) };
try {
  for (const [path, text] of Object.entries(baseline)) writeFileSync(path, text);
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'server/no-limits-segment-design.test.ts', 'scripts/no-limits-live/mandatory-wipe.test.mjs', '--maxWorkers=2'], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(out, 'baseline-known-failures.log'), result.stdout + result.stderr);
  assert.equal(result.signal, null); assert.equal(result.status, 1);
  report.exitCode = result.status;
} finally {
  for (const [path, text] of Object.entries(originals)) writeFileSync(path, text);
  report.restored = Object.entries(originals).every(([path, text]) => readFileSync(path, 'utf8') === text);
  writeFileSync(join(out, 'baseline-comparison.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
