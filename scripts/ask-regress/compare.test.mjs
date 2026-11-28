import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';

const script = new URL('./compare.py', import.meta.url).pathname;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture(change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'ask-full-gate-')); roots.push(root);
  const out = join(root, 'evidence/ask-regress/raw/full'); mkdirSync(out, { recursive: true });
  for (const phase of ['base', 'head']) {
    const sourceCommit = phase === 'base' ? 'a'.repeat(40) : 'b'.repeat(40);
    const files = [];
    for (let shard = 1; shard <= 8; shard++) {
      const file = `server/example-${shard}.test.ts`; files.push(file);
      const assertion = { fullName: 'approval stays held', status: 'passed', failureMessages: [] };
      const receipt = { phase, shard, sourceCommit, exit: 0, report: true };
      const suite = { name: `/tmp/ask-full-${phase}-${shard}/${file}`, status: 'passed', assertionResults: [assertion] };
      change({ phase, shard, receipt, suite, assertion });
      writeFileSync(join(out, `${phase}-${shard}.exit.json`), JSON.stringify(receipt));
      writeFileSync(join(out, `${phase}-${shard}.json`), JSON.stringify({ numTotalTests: 1, testResults: [suite] }));
    }
    writeFileSync(join(out, `${phase}.inventory-all.json`), JSON.stringify({ sourceCommit, files }));
  }
  const run = (extra = []) => spawnSync('python3', [script, '--base-sha', 'a'.repeat(40), '--head-sha', 'b'.repeat(40), ...extra], { cwd: root, encoding: 'utf8' });
  const summary = () => JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'));
  return { root, out, run, summary };
}
test('a complete comparison with zero new failures qualifies', () => {
  const f = fixture(); expect(f.run().status).toBe(0);
});
test('a newly failing ID cannot exit green even when every shard completed', () => {
  const f = fixture(({ phase, shard, assertion, receipt, suite }) => {
    if (phase === 'head' && shard === 4) { assertion.status = 'failed'; assertion.failureMessages = ['AssertionError: permission escaped']; receipt.exit = 1; suite.status = 'failed'; }
  });
  expect(f.run().status).toBe(1);
  expect(f.summary().newFailures).toEqual(['server/example-4.test.ts :: approval stays held :: 1']);
});
test('newly unexecuted IDs cannot qualify', () => {
  const f = fixture(({ phase, shard, assertion }) => { if (phase === 'head' && shard === 2) assertion.status = 'pending'; });
  expect(f.run().status).toBe(1);
  expect(f.summary().newlyUnexecutedIDs).toHaveLength(1);
});
test('missing reports and mixed source receipts fail closed', () => {
  const missing = fixture(); rmSync(join(missing.out, 'head-4.json'));
  expect(missing.run().status).toBe(1);
  const mixed = fixture(({ phase, shard, receipt }) => { if (phase === 'head' && shard === 2) receipt.sourceCommit = 'c'.repeat(40); });
  expect(mixed.run().status).toBe(1);
});
test('a complete report for a stale candidate SHA cannot qualify the requested head', () => {
  const f = fixture();
  const result = f.run(['--base-sha', 'a'.repeat(40), '--head-sha', 'c'.repeat(40)]);
  expect(result.status).toBe(1);
});

test.each([
  { provided: [] }, { provided: ['--base-sha', 'a'.repeat(40)] }, { provided: ['--head-sha', 'b'.repeat(40)] },
])('omitting an expected source SHA fails closed: $provided', ({ provided }) => {
  const f = fixture();
  const result = spawnSync('python3', [script, ...provided], { cwd: f.root, encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('required');
});

test('receipts from the randomized full-shard source root compare by checkout-relative file', () => {
  const f = fixture(({ phase, shard, receipt, suite }) => {
    receipt.sourceRoot = `/var/capture/.ask-full-x${shard}/${phase}`;
    suite.name = `${receipt.sourceRoot}/server/example-${shard}.test.ts`;
  });
  expect(f.run().status).toBe(0);
  expect(Object.keys(JSON.parse(readFileSync(join(f.out, 'head-tests-by-id.json'), 'utf8')))).toContain('server/example-3.test.ts :: approval stays held :: 1');
});
