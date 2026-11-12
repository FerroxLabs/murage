import { readFileSync } from 'node:fs';

// Validate selected cases individually; Vitest can exit zero for a skipped suite.
export function assertGateReport(gatePath, reportPath) {
  const expected = readFileSync(gatePath, 'utf8').split(/\r?\n/)
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const assertions = report.testResults.flatMap(suite => suite.assertionResults.map(test => ({
    file: suite.name.replaceAll('\\', '/'), name: test.fullName.trim(), status: test.status,
  })));
  for (const [file, name] of expected) {
    const found = assertions.filter(test => test.file.endsWith('/' + file) && test.name === name);
    if (found.length !== 1 || found[0].status !== 'passed') {
      throw new Error(`Required gate did not pass exactly once: ${file}: ${name}`);
    }
  }
  const executed = assertions.filter(test => !['pending', 'skipped', 'todo', 'disabled'].includes(test.status));
  if (!report.success || executed.length !== expected.length || executed.some(test => test.status !== 'passed')) {
    throw new Error(`Expected only ${expected.length} passing gates; report failed or executed extra cases`);
  }
  return `${expected.length} passed / 0 failed / 0 skipped (selected gates)`;
}
