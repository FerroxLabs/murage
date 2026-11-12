import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertGateReport } from './signal-gate-report.mjs';

const temporary = [];
afterEach(() => temporary.splice(0).forEach(path => removeTempDirSync(path)));
function fixture(list = 'gate-post-g0.txt') {
  const gate = new URL(`../ci/${list}`, import.meta.url);
  const rows = readFileSync(gate, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  const result = { success: true, testResults: rows.map(([file, name]) => ({
    name: `C:\\murage-ci\\${file.replaceAll('/', '\\')}`,
    assertionResults: [{ fullName: name, status: 'passed' }],
  })) };
  const dir = mkdtempSync(join(tmpdir(), 'signal-gate-report-')); temporary.push(dir);
  const report = join(dir, 'report.json');
  return { result, check() { writeFileSync(report, JSON.stringify(result)); return assertGateReport(gate, report); } };
}
it.each([['gate-post-g0.txt', 5], ['gate-signal-native-windows.txt', 11]])('accepts all named cases in %s', (list, count) => {
  const f = fixture(list);
  f.result.testResults[0].assertionResults.push({ fullName: 'unselected unrelated test', status: 'pending' });
  expect(f.check()).toBe(`${count} passed / 0 failed / 0 skipped (selected gates)`);
});
it.each(['missing', 'skipped', 'failed', 'duplicate', 'wrong-file', 'extra', 'suite-failure'])(
  'refuses incomplete qualification despite a zero test-process exit: %s', fault => {
    const f = fixture();
    const suite = f.result.testResults[0], test = suite.assertionResults[0];
    if (fault === 'missing') f.result.testResults.shift();
    if (fault === 'skipped') test.status = 'pending';
    if (fault === 'failed') test.status = 'failed';
    if (fault === 'duplicate') suite.assertionResults.push({ ...test });
    if (fault === 'wrong-file') suite.name += '.other';
    if (fault === 'extra') suite.assertionResults.push({ fullName: 'unexpected test', status: 'passed' });
    if (fault === 'suite-failure') f.result.success = false;
    expect(f.check).toThrow();
  },
);
