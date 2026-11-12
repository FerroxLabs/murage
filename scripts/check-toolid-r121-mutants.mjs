// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run inside the job's networkless test container. Mutate only private copies.
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(root, 'evidence/cfix-toolid-s4a');
const scratch = mkdtempSync(join(tmpdir(), 'cfix-toolid-r121-'));
const mutations = [
  ['JM14', 'server/no-limits-code.ts',
    'const failure = () => { classes.push("cut");',
    'const failure = () => { /* exception -> run */', 'R121-exception-empty'],
  ['JM15', 'server/no-limits-python.ts',
    'const twins = reader?.twins ?? [], literals = reader?.literals ?? [];',
    'const twins: Twin[] = [], literals: string[] = [];', 'R121-exception-root'],
];
const records = ['mutant\tstatus\tparity_rows\tmismatches\tfailed_ids'];
try {
  for (const mutation of [null, ...mutations]) {
    assert.ok(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) < 85, 'load < 85');
    const [id, file, before, after, witness] = mutation ?? ['BASELINE'];
    const work = join(scratch, id);
    mkdirSync(join(work, 'server/testing/fixtures'), { recursive: true });
    for (const name of readdirSync(join(root, 'server'))) {
      if (name.startsWith('no-limits-') && name.endsWith('.ts') || ['code-lexer.ts', 'python-unicode-names.json'].includes(name))
        cpSync(join(root, 'server', name), join(work, 'server', name));
    }
    cpSync(join(root, 'server/testing/fixtures/no-limits-r12'), join(work, 'server/testing/fixtures/no-limits-r12'), { recursive: true });
    writeFileSync(join(work, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(work, 'vitest.config.mjs'), "export default { test: { environment: 'node', include: ['server/no-limits-code.test.ts'], fileParallelism: false, maxWorkers: 1 } };\n");
    symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
    if (mutation) {
      const source = readFileSync(join(work, file), 'utf8');
      assert.equal(source.split(before).length, 2, `${id} unique anchor`);
      writeFileSync(join(work, file), source.replace(before, after));
      writeFileSync(join(evidence, `${id}-anchor.json`), JSON.stringify({ file, before, after, witness }, null, 2) + '\n');
    }
    const reportPath = join(evidence, `${id}-r121.json`);
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', work,
      '--config', join(work, 'vitest.config.mjs'), '--reporter=json', `--outputFile=${reportPath}`],
      { cwd: work, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(evidence, `${id}-r121.log`), result.stdout + result.stderr);
    assert.equal(result.error, undefined);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal((report.numRuntimeErrorTestSuites ?? 0), 0);
    assert.equal(report.numPendingTests, 0);
    const parity = report.testResults.flatMap(s => s.assertionResults).filter(a => a.ancestorTitles.includes('r1.2.1 judge.py port parity'));
    assert.equal(parity.length, 141);
    assert.ok(parity.every(a => ['passed', 'failed'].includes(a.status)));
    const failed = parity.filter(a => a.status === 'failed');
    assert.ok(failed.every(a => a.failureMessages.every(message => message.includes('AssertionError: expected'))));
    const ids = failed.map(a => /^['"]?([A-Za-z0-9_-]+)['"]? /.exec(a.title)?.[1]);
    if (mutation) { assert.equal(result.status, 1); assert.ok(ids.includes(witness)); }
    else { assert.equal(result.status, 0); assert.equal(failed.length, 0); }
    records.push([id, mutation ? 'KILLED' : 'PASS', parity.length, failed.length, ids.join(',')].join('\t'));
    console.log(records.at(-1));
  }
  writeFileSync(join(evidence, 'r121-mutants.tsv'), records.join('\n') + '\n');
} finally {
  assert.ok(realpathSync(scratch).startsWith(join(tmpdir(), 'cfix-toolid-r121-')));
  safeWipeSync(scratch);
}
