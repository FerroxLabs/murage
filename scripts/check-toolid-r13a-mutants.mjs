// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Networkless container only. Mutations affect private copies, never the checkout.
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const evidence = resolve(process.argv[2] ?? 'evidence/bld5-toolid-s4a');
const scratch = mkdtempSync(join(tmpdir(), 'r13a-parity-mutants-'));
const mutations = [
  ['cut-to-run',
    'if (!owner && (!reads.length || reads.some(read => read.state !== "clean"))) return { verdict: "card", cls: "cut", approve: null };',
    'if (!owner && (!reads.length || reads.some(read => read.state !== "clean"))) return { verdict: "run", cls: "", approve: "mutant" };'],
  ['effect-to-cut',
    'return { verdict: "card", cls, approve: null };',
    'return { verdict: "card", cls: "cut", approve: null };'],
];
const results = [];
try {
  for (const mutation of [null, ...mutations]) {
    assert.ok(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) < 85);
    const [id, before, after] = mutation ?? ['baseline'];
    const work = join(scratch, id);
    mkdirSync(join(work, 'server/testing'), { recursive: true });
    mkdirSync(join(work, 'shared'));
    for (const name of readdirSync(join(root, 'server'))) {
      if ((name.startsWith('no-limits-') && name.endsWith('.ts')) || ['code-lexer.ts', 'python-unicode-names.json'].includes(name)) {
        cpSync(join(root, 'server', name), join(work, 'server', name));
      }
    }
    cpSync(join(root, 'server/testing/no-limits-parity.ts'), join(work, 'server/testing/no-limits-parity.ts'));
    cpSync(join(root, 'server/testing/fixtures/no-limits-r12'), join(work, 'server/testing/fixtures/no-limits-r12'), { recursive: true });
    cpSync(join(root, 'shared/no-limits-decision.ts'), join(work, 'shared/no-limits-decision.ts'));
    symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
    writeFileSync(join(work, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(work, 'vitest.config.mjs'), "export default { test: { environment: 'node', include: ['server/no-limits-code.test.ts', 'server/no-limits-parity.test.ts'], maxWorkers: 1, fileParallelism: false } };\n");
    if (mutation) {
      const file = join(work, 'shared/no-limits-decision.ts');
      const source = readFileSync(file, 'utf8');
      assert.equal(source.split(before).length, 2, 'unique mutation anchor');
      writeFileSync(file, source.replace(before, after));
      writeFileSync(join(evidence, `${id}-anchor.json`), JSON.stringify({ file: 'shared/no-limits-decision.ts', before, after }, null, 2) + '\n');
    }
    const reportPath = join(evidence, `${id}-parity-tests.json`);
    const comparisonPath = join(evidence, `${id}-parity-rows.json`);
    const run = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', work,
      '--config', join(work, 'vitest.config.mjs'), '--reporter=json', `--outputFile=${reportPath}`], {
      cwd: work, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TOOLID_PARITY_REPORT: comparisonPath },
    });
    writeFileSync(join(evidence, `${id}-parity.log`), run.stdout + run.stderr);
    assert.equal(run.error, undefined);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const comparisons = JSON.parse(readFileSync(comparisonPath, 'utf8'));
    assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0);
    assert.equal(report.numPendingTests, 0);
    const parity = report.testResults.flatMap(suite => suite.assertionResults)
      .filter(test => test.ancestorTitles.includes('r1.2.1 judge.py port parity'));
    assert.equal(parity.length, 141);
    assert.equal(comparisons.compared, 141);
    const failures = parity.filter(test => test.status === 'failed');
    assert.equal(failures.length, comparisons.looser_count);
    assert.ok(failures.every(test => test.failureMessages.every(message => message.includes('must be at least as strict'))));
    if (mutation) {
      assert.equal(run.status, 1);
      assert.ok(failures.length > 0, 'a looser-than-oracle mutant must go RED');
    } else {
      assert.equal(run.status, 0);
      assert.equal(failures.length, 0);
    }
    results.push({ mutant: id, result: mutation ? 'KILLED' : 'PASS', test_status: run.status,
      tests: report.numTotalTests, failed: report.numFailedTests, parity_rows: parity.length,
      looser_rows: failures.length, over_strict_rows: comparisons.count,
      failed_ids: failures.map(test => /^['"]?([A-Za-z0-9_-]+)['"]? /.exec(test.title)?.[1]) });
  }
  writeFileSync(join(evidence, 'parity-mutants.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(join(evidence, 'parity-mutants.json'));
} finally {
  assert.ok(scratch.startsWith(join(tmpdir(), 'r13a-parity-mutants-')));
  safeWipeSync(scratch);
}
