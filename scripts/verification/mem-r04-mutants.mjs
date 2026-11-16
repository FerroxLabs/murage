// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: mem-r04-1019 (mutations, isolated execution and evidence).
// Run inside an isolated test container; reports go to stdout, scratch stays outside the repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const early = '  // Admission passed the refused-lease guard: receipts must join only this generation.\n  supersedeMemberTurns(turnLineage);\n';
const late = '        addTurnParents(turnLineage, turnShownRefs);\n';
const fence = '  accounting: "release" | "check-only" = "check-only"): void {\n';
const mutants = [
  {
    id: 'R04-retire-too-late', file: 'server/index.ts',
    changes: [[early, ''], [late, late + '        supersedeMemberTurns(turnLineage);\n']],
    test: 'server/memory/pip-continuity-delivery.test.ts', pattern: 'R04 fresh admission',
  },
  {
    id: 'R04-bypass-retained-fence', file: 'server/memory/send-fence.ts',
    changes: [[fence, fence + '  return;\n']],
    test: 'server/drivers/engine-release-atomic.test.ts', pattern: 'actual engine frame owns one writer transaction',
  },
];
const scratch = mkdtempSync(join(tmpdir(), 'memory-retirement-mutants-'));
function run(spec, phase) {
  const report = join(scratch, `${spec.id}-${phase}.json`);
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', spec.test,
    '-t', spec.pattern, '--reporter=json', `--outputFile=${report}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${spec.id}: runner error`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  const cases = data.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.fullName.includes(spec.pattern));
  assert.ok(cases.length > 0, `${spec.id}: no witness executed`);
  assert.ok(data.testResults.every(file => !file.message), `${spec.id}: suite runtime error`);
  assert.doesNotMatch(result.stderr, /Vitest caught .*unhandled/i, `${spec.id}: unhandled error`);
  const failures = cases.filter(test => test.status === 'failed');
  const errors = failures.flatMap(test => test.failureMessages.map(message => message.trimStart().split('\n')[0]));
  console.log(JSON.stringify({ mutant: spec.id, phase, exit: result.status,
    tests: cases.map(test => ({ name: test.fullName, status: test.status })), errors }));
  if (phase === 'mutant') {
    assert.notEqual(result.status, 0, `${spec.id}: mutant survived`);
    assert.ok(errors.some(error => /^AssertionError:/.test(error)), `${spec.id}: no assertion kill`);
    assert.ok(errors.every(error => /^AssertionError:/.test(error)), `${spec.id}: non-assertion failure`);
  } else {
    assert.equal(result.status, 0, `${spec.id}: control failed`);
    assert.ok(cases.every(test => test.status === 'passed'), `${spec.id}: control did not pass`);
  }
}
try {
  for (const spec of mutants) {
    const original = readFileSync(spec.file, 'utf8');
    let changed = original;
    for (const [from, to] of spec.changes) {
      assert.equal(changed.split(from).length - 1, 1, `${spec.id}: mutation must match once`);
      changed = changed.replace(from, to);
    }
    run(spec, 'control');
    try { writeFileSync(spec.file, changed); run(spec, 'mutant'); }
    finally { writeFileSync(spec.file, original); }
    assert.equal(readFileSync(spec.file, 'utf8'), original);
    run(spec, 'restored');
  }
} finally { rmSync(scratch, { recursive: true }); }
