// SPDX-License-Identifier: AGPL-3.0-or-later
// A failing process is not necessarily behavioral RED. Require collected tests
// and the exact assertion messages from the baseline-compatible regressions.
export function startingRedProven(report, exitCode) {
  return exitCode === 1 && report.numTotalTests === 2 && report.numFailedTests === 2
    && report.testResults?.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed'
      && test.failureMessages?.some(message => message.includes('AssertionError:')
        && (message.includes('default-off must send zero provider requests')
          || message.includes('ordinary private completion replaces the native password path')))).length === 2;
}
