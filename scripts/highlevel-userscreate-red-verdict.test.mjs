// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { startingRedProven } from './highlevel-userscreate-red-verdict.mjs';
it('BLOCK2 rejects collection failures and green or empty baseline runs as RED evidence', () => {
  const valid = { numTotalTests: 2, numFailedTests: 2, testResults: [{ assertionResults: [
    { status: 'failed', failureMessages: ['AssertionError: default-off must send zero provider requests'] },
    { status: 'failed', failureMessages: ['AssertionError: ordinary private completion replaces the native password path'] },
  ] }] };
  expect(startingRedProven(valid, 1)).toBe(true);
  expect(startingRedProven(valid, null)).toBe(false);
  expect(startingRedProven(valid, 254)).toBe(false);
  expect(startingRedProven({ numTotalTests: 0, numFailedTests: 0, testResults: [] }, 1)).toBe(false);
  expect(startingRedProven({ numTotalTests: 2, numFailedTests: 0, testResults: [] }, 0)).toBe(false);
  expect(startingRedProven({ numTotalTests: 2, numFailedTests: 2, testResults: [{ assertionResults: [
    { status: 'failed', failureMessages: ['Cannot find module users-create-policy.ts'] },
    { status: 'failed', failureMessages: ['TypeError: method is not a function'] },
  ] }] }, 1)).toBe(false);
});
