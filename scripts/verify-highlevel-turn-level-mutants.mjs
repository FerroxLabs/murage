// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const directory = process.env.GNL_MOUNT_MUTANT_DIR ?? 'evidence/gnl-r4/mutants';
mkdirSync(directory, { recursive: true });
const tests = ['server/highlevel/no-limits-mount.test.ts', 'server/highlevel/no-limits-mount-api.test.ts'];
const sha256 = source => createHash('sha256').update(source).digest('hex');
function run(name) {
  const result = spawnSync('node_modules/.bin/vitest', ['run', ...tests, '--reporter=json', `--outputFile=${directory}/${name}.json`], {
    encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, GNL_MOUNT_EVIDENCE_DIR: `${directory}/${name}-workflow` },
  });
  writeFileSync(`${directory}/${name}.log`, (result.stdout ?? '') + (result.stderr ?? ''));
  const report = JSON.parse(readFileSync(`${directory}/${name}.json`, 'utf8'));
  const failed = report.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => ({
    file: file.name, name: test.fullName, messages: test.failureMessages,
  })));
  return { status: result.status, passed: report.numPassedTests, failed: report.numFailedTests,
    total: report.numTotalTests, failedAssertions: failed,
    killed: result.status === 1 && failed.length > 0 && failed.every(test => test.messages.some(message => message.includes('AssertionError'))) };
}
const sourceHashes = Object.fromEntries(['server/highlevel/runtime.ts', 'server/index.ts', ...tests].map(file => [file, sha256(readFileSync(file))]));
const baseline = run('baseline');
if (baseline.status !== 0) throw new Error('Baseline failed; no mutants run');
const matrix = [];
const mutants = [
  {
    name: 'runtime-stored-profile', file: 'server/highlevel/runtime.ts',
    change: source => "import { noLimitsAppliesTo } from '../no-limits-origin.ts';\n" + source.replace(
      'nativeAccessFor(current, effectiveLevel === "unlimited")',
      'nativeAccessFor(current, noLimitsAppliesTo("owner", current as typeof current & {autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean}))'),
  },
  {
    name: 'caller-stored-profile', file: 'server/index.ts',
    change: source => source.replaceAll('highlevel.mountsFor(bot.id, highlevelLevel)', 'highlevel.mountsFor(bot.id, botPermissionMode(store.bot(bot.id)))'),
  },
];
for (const mutant of mutants) {
  const original = readFileSync(mutant.file, 'utf8'), stamp = statSync(mutant.file);
  const mutated = mutant.change(original);
  if (mutated === original) throw new Error(`Mutation anchor moved: ${mutant.name}`);
  try {
    writeFileSync(mutant.file, mutated);
    const result = run(mutant.name);
    matrix.push({ name: mutant.name, file: mutant.file, sourceBefore: sha256(original), sourceMutated: sha256(mutated), ...result });
  } finally {
    writeFileSync(mutant.file, original); utimesSync(mutant.file, stamp.atime, stamp.mtime);
  }
  matrix.at(-1).restored = sha256(readFileSync(mutant.file, 'utf8')) === sha256(original);
}
const restored = run('restored');
writeFileSync(`${directory}/summary.json`, JSON.stringify({ tests, sourceHashes, baseline, matrix, restored }, null, 2) + '\n');
if (matrix.some(row => !row.killed || !row.restored) || restored.status !== 0) process.exitCode = 1;
