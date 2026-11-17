// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { compareGate } from './verify-gnl-mounts-comparison.mjs';
const manifest = { base: 'a'.repeat(40), head: 'b'.repeat(40), files: ['server/one.test.ts', 'server/two.test.ts'] };
const report = (sha, names = manifest.files, failed = false) => ({ sha, report: { testResults: names.map(name => ({ name: '/tmp/checkout/' + name, status: failed ? 'failed' : 'passed', assertionResults: [{ fullName: 'works', status: failed ? 'failed' : 'passed', failureMessages: ['assertion'] }] })) } });
it('R6 rejects an incomplete final-head shard inventory', () => {
  expect(() => compareGate(manifest, { base: [report(manifest.base)], head: [report(manifest.head, [manifest.files[0]])] })).toThrow('head: missing reports');
});
it('R6 rejects evidence from a different head SHA', () => {
  expect(() => compareGate(manifest, { base: [report(manifest.base)], head: [report('c'.repeat(40))] })).toThrow('wrong SHA');
});
it('R6 requires zero new failures and lists inherited failures on both sides', () => {
  const inherited = compareGate(manifest, { base: [report(manifest.base, undefined, true)], head: [report(manifest.head, undefined, true)] });
  expect(inherited.admissible).toBe(true); expect(inherited.base.failures).toHaveLength(2); expect(inherited.head.failures).toHaveLength(2);
  const regression = compareGate(manifest, { base: [report(manifest.base)], head: [report(manifest.head, undefined, true)] });
  expect(regression.admissible).toBe(false); expect(regression.headOnlyFailures).toHaveLength(2);
});
it('R6 refuses duplicate report files', () => {
  expect(() => compareGate(manifest, { base: [report(manifest.base), report(manifest.base)], head: [report(manifest.head)] })).toThrow('duplicate');
});
