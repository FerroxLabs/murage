// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Vitest's assertion rows are the unit, not its nested suite counters.
 * A missing/empty/skipped file or a broken runner adds a failure, never a pass.
 */
export function summarizeWinTests(report, expectedFiles, processExit) {
  if (!Array.isArray(report?.testResults) || !Array.isArray(expectedFiles) || !expectedFiles.length) throw Error('Missing Vitest results or file inventory');
  const normalize = path => path.replaceAll('\\', '/').toLowerCase();
  const expected = expectedFiles.map(normalize);
  if (new Set(expected).size !== expected.length) throw Error('Duplicate gate inventory entry');
  const seen = new Set();
  let pass = 0, fail = 0, skipped = 0, infrastructure = false;
  for (const file of report.testResults) {
    if (typeof file.name !== 'string' || !Array.isArray(file.assertionResults)) throw Error('Malformed Vitest file result');
    const name = normalize(file.name);
    const key = expected.find(path => name === path || name.endsWith(`/${path}`));
    if (!key || seen.has(key)) infrastructure = true;
    else seen.add(key);
    let filePass = 0, fileFail = 0;
    for (const row of file.assertionResults) {
      if (row.status === 'passed') { pass++; filePass++; }
      else if (row.status === 'failed') { fail++; fileFail++; }
      else if (['pending', 'skipped', 'todo', 'disabled'].includes(row.status)) skipped++;
      else throw Error('Unknown Vitest assertion status');
    }
    if ((!filePass && !fileFail) || (file.status !== 'passed' && !fileFail)) infrastructure = true;
  }
  if (seen.size !== expected.length || report.success !== true || report.numFailedTestSuites > 0 || report.numFailedTests > 0 || processExit !== 0) infrastructure = true;
  if (infrastructure && fail === 0) fail = 1;
  return { line: `WINTEST-RESULT files=${seen.size} pass=${pass} fail=${fail} skipped=${skipped}`, exitCode: fail ? 1 : 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [report, manifest, code] = process.argv.slice(2);
    const result = summarizeWinTests(JSON.parse(readFileSync(report, 'utf8')), JSON.parse(readFileSync(manifest, 'utf8')), Number(code));
    console.log(result.line);
    process.exitCode = result.exitCode;
  } catch {
    console.error('Windows gate could not read a complete Vitest report');
    console.log('WINTEST-RESULT files=0 pass=0 fail=1 skipped=0');
    process.exitCode = 1;
  }
}
