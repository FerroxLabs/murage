// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, symlinkSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startingRedProven } from './highlevel-userscreate-red-verdict.mjs';
const root = resolve('.test-tmp/afix-bld-hl-userscreate');
const baseline = join(root, 'starting-tree');
const test = 'server/highlevel/users-create-starting.test.ts';
if (!existsSync(join(baseline, 'node_modules'))) symlinkSync(resolve('node_modules'), join(baseline, 'node_modules'), 'dir');
copyFileSync(test, join(baseline, test));
const reportPath = join(root, 'starting-red.json');
// Never let an executable/setup failure reuse a report from an earlier run.
if (existsSync(reportPath)) unlinkSync(reportPath);
const run = spawnSync('pnpm', ['exec', 'vitest', 'run', test, '--reporter=json', '--outputFile=' + reportPath],
  { cwd: baseline, encoding: 'utf8', timeout: 120_000 });
writeFileSync(join(root, 'starting-red.log'), run.stdout + run.stderr);
if (!existsSync(reportPath)) throw new Error('Starting commit failed before producing a test report.');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (run.error || !startingRedProven(report, run.status)) throw new Error('Starting commit did not demonstrate two behavioral assertion failures.');
writeFileSync(join(root, 'starting-red-verdict.json'), JSON.stringify({ base: '0567676f107f5e8690b94841fd96a050b3da2748',
  exit: run.status, collected: report.numTotalTests, failedAssertions: report.numFailedTests, behavioralRed: true }, null, 2));
console.log('PASS starting-commit RED: two collected behavioral assertion failures');
