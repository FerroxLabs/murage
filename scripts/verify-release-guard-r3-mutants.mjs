// SPDX-License-Identifier: AGPL-3.0-or-later
// Container-only mutation check. Restores source even when an assertion fails.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const guard = 'server/decision/release-guard.ts', implementation = 'server/decision/implementation.ts';
const originals = new Map([guard, implementation].map(path => [path, readFileSync(path, 'utf8')]));
const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r3.test.ts', '--maxWorkers=2'];
const run = id => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const log = result.stdout + result.stderr; writeFileSync(join(out, id + '.log'), log);
  assert.equal(result.signal, null, id + ' must finish'); if (result.error) throw result.error;
  return { result, log };
};
const mutants = [
  ['literal-disk-target', guard, 'resolved.push(resolution.physical);', 'resolved.push(resolution.lexical);', /canonical destination/],
  ['empty-target-approval', guard, 'if([...fresh,...approved].some(wipe=>!wipe.resolvedTargets.length))return false;', '', /empty approval/],
  ['product-empty-target-bypass', implementation,
    "const scanUnread=scanFailed||releaseWipes===undefined||!releaseWipes.length||releaseWipes.some(wipe=>!wipe.resolvedTargets.length)||wipes.some(wipe=>wipe.class==='wipe-input-unread');",
    "const scanUnread=scanFailed||wipes.some(wipe=>wipe.class==='wipe-input-unread');", /repeated Allow/],
];
const report = { args, control: 'pending', originals: Object.fromEntries([...originals].map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])), results: [] };
try {
  assert.equal(run('control').result.status, 0, 'unmodified control must pass'); report.control = 'pass';
  for (const [id, path, anchor, replacement, failingTest] of mutants) {
    const original = originals.get(path); assert.equal(original.split(anchor).length, 2, id + ' unique anchor');
    writeFileSync(path, original.replace(anchor, replacement));
    try {
      const { result, log } = run(id); assert.equal(result.status, 1, id + ' must be killed');
      assert.match(log, /AssertionError:/); assert.match(log, failingTest);
      assert.doesNotMatch(log, /Failed to parse|SyntaxError:|Cannot find module/);
      report.results.push({ id, status: 'killed', exitCode: result.status });
    } finally { writeFileSync(path, original); }
  }
} finally {
  for (const [path, text] of originals) writeFileSync(path, text);
  report.restored = [...originals].every(([path, text]) => readFileSync(path, 'utf8') === text);
  writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
