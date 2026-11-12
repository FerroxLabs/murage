// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { summarizeWinTests } from './result.mjs';
const files = ['server/a.test.ts', 'server/b.test.ts'];
const result = () => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [
  { name: 'C:\\checkout\\server\\a.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'pending' }] },
  { name: 'C:\\checkout\\server\\b.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }] },
] });
it('counts assertions once per file with Windows paths', () => {
  expect(summarizeWinTests(result(), files, 0)).toEqual({ line: 'WINTEST-RESULT files=2 pass=2 fail=0 skipped=1', exitCode: 0 });
});
it('fails on a failed assertion even when the process exits zero', () => {
  const report = result(); report.testResults[0].assertionResults[0].status = 'failed';
  expect(summarizeWinTests(report, files, 0)).toEqual({ line: 'WINTEST-RESULT files=2 pass=1 fail=1 skipped=1', exitCode: 1 });
});
it.each(['missing', 'empty', 'suite', 'process', 'report', 'duplicate', 'unrequested'])('fails closed for %s', failure => {
  const report = result();
  if (failure === 'missing') report.testResults.pop();
  if (failure === 'empty') report.testResults[0].assertionResults = [];
  if (failure === 'suite') { report.testResults[0].status = 'failed'; report.numFailedTestSuites = 1; }
  if (failure === 'report') report.success = false;
  if (failure === 'duplicate') report.testResults[1] = report.testResults[0];
  if (failure === 'unrequested') report.testResults[1].name = 'C:/checkout/server/c.test.ts';
  const summary = summarizeWinTests(report, files, failure === 'process' ? 1 : 0);
  expect(summary.exitCode).toBe(1);
  expect(Number(/ fail=(\d+)/.exec(summary.line)[1])).toBeGreaterThan(0);
});
it('treats todo and skipped assertions as skipped, never passed', () => {
  const report = result(); report.testResults[0].assertionResults.push({ status: 'todo' }, { status: 'skipped' });
  expect(summarizeWinTests(report, files, 0).line).toBe('WINTEST-RESULT files=2 pass=2 fail=0 skipped=3');
});
it('rejects malformed report data', () => {
  expect(() => summarizeWinTests({}, files, 0)).toThrow();
  const report = result(); report.testResults[0].assertionResults[0].status = 'unknown';
  expect(() => summarizeWinTests(report, files, 0)).toThrow();
});
