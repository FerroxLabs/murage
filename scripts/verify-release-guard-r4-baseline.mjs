// SPDX-License-Identifier: AGPL-3.0-or-later
// Container-only before/after comparison; exact candidate bytes restored in finally.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const out = resolve(process.argv[2]);
const baseline = JSON.parse(readFileSync(join(out, 'baseline-source-bytes.json'), 'utf8'));
const originals = Object.fromEntries(Object.keys(baseline).map(path => [path, existsSync(path) ? readFileSync(path, 'utf8') : null]));
const report = { baseline: '8299f8d83a07db35e9531775330d5d79b9ab8f50', sourceHashes: Object.fromEntries(Object.entries(baseline).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])) };
try {
  for (const [path, text] of Object.entries(baseline)) writeFileSync(path, text);
  const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r2.test.ts', 'server/decision/release-guard-r3.test.ts', 'server/no-limits-segment-design.test.ts', 'scripts/no-limits-live/mandatory-wipe.test.mjs', '--maxWorkers=2'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(out, 'baseline-existing-tests.log'), result.stdout + result.stderr);
  assert.equal(result.signal, null); if (result.error) throw result.error;
  report.args = args; report.exitCode = result.status;
} finally {
  for (const [path, text] of Object.entries(originals)) { if (text === null) unlinkSync(path); else writeFileSync(path, text); }
  report.restored = Object.entries(originals).every(([path, text]) => text === null ? !existsSync(path) : readFileSync(path, 'utf8') === text);
  writeFileSync(join(out, 'baseline-comparison.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
