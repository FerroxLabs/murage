import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReds, smoothVerdict, webVerdict, fixtureVerdict } from './judge.mjs';
test('registry diff preserves inherited reds, new reds, and fixes independently', () => {
  assert.deepEqual(compareReds('suite :: new\nsuite :: old\nsuite :: old\n', 'suite :: fixed\nsuite :: old\n'),
    { NEW: ['suite :: new'], BASE: ['suite :: old'], FIXED: ['suite :: fixed'] });
  assert.deepEqual(compareReds('', ''), { NEW: [], BASE: [], FIXED: [] });
});
test('smoothness requires one complete 63-row verdict agreeing with worker exit', () => {
  assert.equal(smoothVerdict('PASS: 63 of 63 rows pass.\n', 0).result, 'PASS');
  assert.equal(smoothVerdict('FAIL: 52 of 63 rows pass.\n', 1).result, 'FAIL');
  for (const [text, code] of [['PASS: 63 of 63 rows pass.', 255], ['PASS: 62 of 63 rows pass.', 0],
    ['FAIL: 52 of 64 rows pass.', 1], ['', 0], ['PASS: 63 of 63 rows pass.\nPASS: 63 of 63 rows pass.', 0]]) {
    assert.equal(smoothVerdict(text, code).result, 'UNVERIFIED');
  }
});
test('web route proof must bind the candidate and fake mode; release verdict cannot stand in for route verdict', () => {
  assert.equal(webVerdict({ tree: 'candidate', mode: '--fake', routeVerdict: 'PASS', verdict: 'UNVERIFIED' }, 'candidate', 1), 'PASS');
  assert.equal(webVerdict({ tree: 'other', mode: '--fake', routeVerdict: 'PASS', verdict: 'UNVERIFIED' }, 'candidate', 1), 'UNVERIFIED');
  assert.equal(webVerdict({ tree: 'candidate', mode: '--live', routeVerdict: 'PASS', verdict: 'UNVERIFIED' }, 'candidate', 1), 'UNVERIFIED');
  assert.equal(webVerdict({ tree: 'candidate', mode: '--fake', verdict: 'PASS' }, 'candidate', 0), 'FAIL');
});
test('BLOCK-2 web exit contract rejects timeouts, crashes, missing reports and disagreeing exits', () => {
  const report = { tree: 'candidate', mode: '--fake', routeVerdict: 'PASS', verdict: 'UNVERIFIED' };
  for (const code of [0, 2, 124, 125, 137, 143, undefined]) assert.equal(webVerdict(report, 'candidate', code), 'FAIL');
  assert.equal(webVerdict(report, 'candidate', null), 'UNVERIFIED');
  assert.equal(webVerdict(undefined, 'candidate', 1), 'FAIL');
  assert.equal(webVerdict({ ...report, verdict: 'PASS' }, 'candidate', 0), 'PASS');
  assert.equal(webVerdict({ ...report, verdict: 'FAIL', routeVerdict: 'FAIL' }, 'candidate', 1), 'FAIL');
});
test('empty, failed, skipped, missing, timed out and filtered fixture results fail closed', () => {
  const report = { numFailedTests: 0, testResults: [{ assertionResults: [
    { fullName: 'ssh/cd fixture', status: 'passed' }, { fullName: 'compound fixture', status: 'pending' },
  ] }] };
  assert.equal(fixtureVerdict(report, 0, 'ssh/cd'), 'PASS');
  assert.equal(fixtureVerdict(report, 0), 'FAIL');
  assert.equal(fixtureVerdict(report, 0, 'no matches'), 'FAIL');
  assert.equal(fixtureVerdict(report, 124, 'ssh/cd'), 'FAIL');
  assert.equal(fixtureVerdict(undefined, 0), 'FAIL');
  assert.equal(fixtureVerdict(undefined, null), 'UNVERIFIED');
});
