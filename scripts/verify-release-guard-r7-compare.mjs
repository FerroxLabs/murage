// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]);
const read = path => JSON.parse(readFileSync(join(out, path), 'utf8'));
const ids = data => data.testResults.flatMap(file => {
  const path = file.name.replace(/^.*?\/(server|scripts)\//, '$1/');
  const rows = file.assertionResults.filter(test => test.status === 'failed').map(test => path + ' > ' + test.fullName);
  if (file.status === 'failed' && !rows.length) rows.push(path + ' > SUITE_ERROR');
  return rows;
}).sort();
const pendingIds = data => data.testResults.flatMap(file => file.assertionResults.filter(test => !['passed', 'failed'].includes(test.status)).map(test => file.name.replace(/^.*?\/(server|scripts)\//, '$1/') + ' > ' + test.fullName)).sort();
const report = { baseline: 'af48a0ee0f188793768d1143e604250b3df73d86', finalHashes: read('final-source-sha256.json'), shards: [], baselineFailures: [], candidateFailures: [], baselinePending: [], candidatePending: [] };
for (let index = 1; index <= 6; index++) {
  const dir = 'shard-' + index, receipt = read(dir + '/receipt.json'), final = receipt;
  assert.equal(receipt.baseline, report.baseline); assert.equal(receipt.restored, true);
  for (const [saved, mode] of [[receipt, 'baseline'], [final, 'candidate']]) {
    const run = saved.runs.find(run => run.mode === mode);
    assert.ok(run && [0, 1].includes(run.exitCode), dir + ' completed ' + mode);
    assert.equal(run.signal, null); assert.equal(run.error, undefined);
    assert.match(readFileSync(join(out, dir, mode + '.log'), 'utf8'), /JSON report written to/, dir + ' fresh ' + mode + ' report');
  }
  assert.equal(final.baseline, report.baseline);
  for (const [path, expected] of Object.entries(report.finalHashes)) {
    // A shard executes its selected tests against every shared product source.
    if (path.includes('.test.') && !receipt.selected.includes(path)) continue;
    assert.equal(final.candidateHashes[path], expected, dir + ' final product/test bytes: ' + path);
  }
  assert.deepEqual(final.selected, receipt.selected);
  const base = read(dir + '/baseline.json'), candidate = read(dir + '/candidate.json');
  const check = (data, selected) => {
    assert.equal(data.testResults.length, selected.length, dir + ' every selected file ran');
    const paths = data.testResults.map(file => file.name.replace(/^.*?\/(server|scripts)\//, '$1/')).sort();
    assert.deepEqual(paths, [...selected].sort(), dir + ' selected paths');
  };
  check(base, receipt.baseSelected); check(candidate, receipt.selected);
  const counts = data => ({ files: data.testResults.length, passed: data.numPassedTests, failed: data.numFailedTests, pending: data.numPendingTests });
  report.shards.push({ id: dir, base: counts(base), candidate: counts(candidate) });
  report.baselineFailures.push(...ids(base)); report.candidateFailures.push(...ids(candidate));
  report.baselinePending.push(...pendingIds(base)); report.candidatePending.push(...pendingIds(candidate));
}
const sum = mode => Object.fromEntries(['files', 'passed', 'failed', 'pending'].map(key => [key, report.shards.reduce((n, shard) => n + shard[mode][key], 0)]));
report.base = sum('base'); report.candidate = sum('candidate');
assert.equal(report.base.files, 69, 'all 69 baseline files');
assert.equal(report.candidate.files, 74, 'all 74 selected candidate files');
const baseIds = new Set(report.baselineFailures);
report.newFailures = report.candidateFailures.filter(id => !baseIds.has(id)); report.newCount = report.newFailures.length;
report.newPending = report.candidatePending.filter(id => !report.baselinePending.includes(id));
report.fixed = report.baselineFailures.filter(id => !report.candidateFailures.includes(id));
writeFileSync(join(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ base: report.base, candidate: report.candidate, newCount: report.newCount, newFailures: report.newFailures }));
assert.equal(report.newCount, 0, '0 NEW failure IDs');
assert.equal(report.newPending.length, 0, 'no newly unexecuted test IDs');
