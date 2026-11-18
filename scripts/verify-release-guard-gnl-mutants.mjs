// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in an isolated test checkout/container. Always restores the source.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const target = 'server/decision/release-guard.ts';
const original = readFileSync(target, 'utf8');
const out = resolve(process.argv[2] ?? 'lane-evidence/nolim-release-guard/mutants');
mkdirSync(out, { recursive: true });
const anchor = 'if(!fresh.wipes?.length||approved&&wipeEvidenceCovers(fresh.wipes,approved.inspection.wipes??[]))return RELEASE;';
assert.equal(original.split(anchor).length, 2, 'release predicate must be uniquely pinned');
const run = () => spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
  'server/decision/release-guard.test.ts', 'server/decision/release-guard-gnl-1019.test.ts',
  'scripts/no-limits-live/mandatory-ruling.test.mjs', '--maxWorkers=2'],
{ encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const results = [];
try {
  const control = run(); writeFileSync(join(out, 'control.log'), control.stdout + control.stderr);
  assert.equal(control.status, 0, 'unmodified regression control must pass');
  for (const [id, replacement] of [
    ['protected-only-hold', 'if(approved?approvedEvidenceCovers(fresh,approved.inspection):fresh.decisions.length===0)return RELEASE;'],
    ['wipe-bypass', 'if(true)return RELEASE;'],
  ]) {
    writeFileSync(target, original.replace(anchor, replacement));
    const result = run(); writeFileSync(join(out, `${id}.log`), result.stdout + result.stderr);
    assert.equal(result.signal, null, `${id} must finish normally`);
    assert.equal(result.status, 1, `${id} must be killed by an assertion failure`);
    assert.match(result.stdout + result.stderr, /AssertionError:/, `${id} must fail on behavior`);
    results.push({ id, status: 'killed', exitCode: result.status });
    writeFileSync(target, original);
  }
} finally { writeFileSync(target, original); }
writeFileSync(join(out, 'results.json'), JSON.stringify({ control: 'pass', results, restored: readFileSync(target, 'utf8') === original }, null, 2) + '\n');
console.log(JSON.stringify({ control: 'pass', results, restored: true }));
