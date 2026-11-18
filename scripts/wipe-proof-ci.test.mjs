// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: wg-proof owns the Windows launcher (run-windows.ps1); the CI lane owns its caller (ci/wipe-proof.mjs).
// The launcher writes its summary to the -SummaryPath it is given and to a random temp file otherwise, so the CI caller
// must pass a path and read that same path back. The real run needs Windows; this keeps the two sides in step everywhere.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** Every way the CI caller and the Windows launcher disagree about where the summary file is. */
export function summaryContract(caller, launcher) {
  const problems = [];
  if (!/^param\(\[string\]\$SummaryPath\b/m.test(launcher)) problems.push('launcher takes no -SummaryPath');
  if (!/--summary \$summaryPath\b/i.test(launcher)) problems.push('launcher does not write the summary to -SummaryPath');
  if (!caller.includes("summaryFile = path.join(proof, 'summary.windows.json');")) problems.push('summary file is not inside the scratch proof directory');
  if (!caller.includes(`const summaryArg = summaryFile.replaceAll("'", "''");`)) problems.push('launcher argument is not the quoted summary file');
  if (!caller.includes("& '${launcher}' -SummaryPath '${summaryArg}'; exit $LASTEXITCODE")) problems.push('caller does not pass -SummaryPath');
  if (!caller.includes("JSON.parse(await fs.readFile(summaryFile, 'utf8'))")) problems.push('caller does not read the summary file it passed');
  if ((caller.match(/summary\.windows\.json/g) ?? []).length !== 1) problems.push('summary file is named in more than one place');
  return problems;
}

it('T-WIPE-PROOF-SUMMARY-PATH: the Windows proof caller passes -SummaryPath and reads that same file', () => {
  expect(summaryContract(read('ci/wipe-proof.mjs'), read('server/wipe-proof/windows-gate/run-windows.ps1'))).toEqual([]);
});

it.each([
  ['caller', " -SummaryPath '${summaryArg}'", ''],
  ['caller', "fs.readFile(summaryFile, 'utf8')", "fs.readFile(path.join(scratch, 'server/wipe-proof/windows-gate/summary.windows.json'), 'utf8')"],
  ['caller', "path.join(proof, 'summary.windows.json')", "path.join(os.tmpdir(), 'summary.windows.json')"],
  ['caller', `summaryFile.replaceAll("'", "''")`, `launcher.replaceAll("'", "''")`],
  ['launcher', 'param([string]$SummaryPath', 'param([string]$Unused'],
  ['launcher', '--summary $summaryPath', '--summary (Join-Path $PSScriptRoot summary.windows.json)'],
])('T-WIPE-PROOF-SUMMARY-PATH mutant: a %s that drops "%s" goes red', (side, anchor, replacement) => {
  const sources = { caller: read('ci/wipe-proof.mjs'), launcher: read('server/wipe-proof/windows-gate/run-windows.ps1') };
  expect(sources[side]).toContain(anchor);
  sources[side] = sources[side].replace(anchor, replacement);
  expect(summaryContract(sources.caller, sources.launcher).length).toBeGreaterThan(0);
});
