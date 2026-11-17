// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]);
const read = name => JSON.parse(readFileSync(join(out, name), 'utf8'));
const ids = data => data.testResults.flatMap(file => {
  const path = file.name.replace(/^.*?\/(server|scripts)\//, '$1/');
  const rows = file.assertionResults.filter(test => test.status === 'failed').map(test => path + ' > ' + test.fullName);
  if (file.status === 'failed' && !file.assertionResults.length) rows.push(path + ' > SUITE_ERROR');
  return rows;
}).sort();
const base = read('baseline.json'), candidate = read('candidate.json'), old = new Set(ids(base)), failures = ids(candidate);
const newFailures = failures.filter(id => !old.has(id));
const fixed = [...old].filter(id => !failures.includes(id));
const counts = data => ({ files: data.testResults.length, passed: data.numPassedTests, failed: data.numFailedTests, pending: data.numPendingTests, suitesWithoutAssertions: data.testResults.filter(file => file.status === 'failed' && !file.assertionResults.length).length });
const report = { baseline: read('baseline-receipt.json').commit, base: counts(base), candidate: counts(candidate), baselineFailures: [...old], candidateFailures: failures, newFailures, newCount: newFailures.length, fixed };
assert.equal(base.testResults.length, read('baseline-selected-files.json').length, 'all baseline selections ran');
assert.equal(candidate.testResults.length, read('selected-files.json').length, 'all candidate selections ran');
writeFileSync(join(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
assert.equal(newFailures.length, 0, 'no new failure IDs');
