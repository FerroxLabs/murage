// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export function compareReds(candidate, base) {
  const lines = text => new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const c = lines(candidate), b = lines(base);
  return { NEW: [...c].filter(s => !b.has(s)).sort(), BASE: [...c].filter(s => b.has(s)).sort(), FIXED: [...b].filter(s => !c.has(s)).sort() };
}
export function smoothVerdict(text, code) {
  const matches = [...text.matchAll(/^(PASS|FAIL): (\d+) of (\d+) rows pass\.$/gm)];
  if (matches.length !== 1 || +matches[0][3] !== 63) return { result: 'UNVERIFIED', reason: 'Missing or ambiguous 63-row verdict' };
  const [, status, passed] = matches[0];
  if (status === 'FAIL' && +passed < 63 && code === 1) return { result: 'FAIL', passed: +passed, total: 63 };
  if (status === 'PASS' && +passed === 63 && code === 0) return { result: 'PASS', passed: 63, total: 63 };
  return { result: 'UNVERIFIED', reason: 'Worker exit and verdict disagree' };
}
export function webVerdict(report, sha, code) {
  if (code === null) return 'UNVERIFIED';
  // run.mjs returns 0 for release PASS, 1 for release FAIL/UNVERIFIED.
  // A valid route report cannot rescue timeout, crash, or mismatched exit.
  if (!report || !['PASS', 'FAIL', 'UNVERIFIED'].includes(report.verdict) ||
      code !== (report.verdict === 'PASS' ? 0 : 1)) return 'FAIL';
  if (report.tree !== sha || report.mode !== '--fake') return 'UNVERIFIED';
  return ['PASS', 'FAIL', 'UNVERIFIED'].includes(report.routeVerdict) ? report.routeVerdict : 'FAIL';
}
export function fixtureVerdict(report, code, pattern) {
  if (code === null) return 'UNVERIFIED';
  const selected = report?.testResults?.flatMap(t => t.assertionResults ?? [])
    .filter(t => !pattern || new RegExp(pattern).test(t.fullName));
  return code === 0 && report?.numFailedTests === 0 && selected?.length > 0 &&
    selected.every(t => t.status === 'passed') ? 'PASS' : 'FAIL';
}
