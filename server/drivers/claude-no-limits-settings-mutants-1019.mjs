// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in the disposable network-none test container. Each mutant changes
// the real production reader/driver and is restored before the next command.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
assert.ok(process.env.CI, 'Use the isolated test container');
const directory = process.env.GNL_ENGINE_EVIDENCE ?? '.gnl-engine-evidence/mutants';
mkdirSync(directory, { recursive: true });
const claude = 'server/drivers/claude.ts';
const git = 'server/no-limits-wipe-git.ts';
const wipe = 'server/no-limits-wipe.ts';
const driverTest = 'server/drivers/claude-no-limits-settings-1019.test.ts';
const gitTest = 'server/no-limits-git-nonmutating-1019.test.ts';
const mergeTest = 'server/decision/no-limits-merge-rulings.test.ts';
const mutants = [
  ['signin-hold', claude, 'const noLimits = (turn.permissionNow?.() ?? turn).noLimits === true;', 'const noLimits = false;', driverTest, 'No limits launches'],
  ['signin-stale-level', claude, 'const noLimits = (turn.permissionNow?.() ?? turn).noLimits === true;', 'const noLimits = turn.noLimits === true;', driverTest, 'sign-in'],
  ['saved-disallowed-tools', claude, '...(nativeTools.disallowedTools ?? []),', '...(config.disallowedTools ?? []),', driverTest, 'saved tool deny|reusing a thread'],
  ['saved-tool-allowlist', claude, 'else if (nativeTools.tools !== undefined) args.push("--tools", nativeTools.tools.filter((tool) => !CLAUDE_SEARCH_TOOLS.has(tool)).join(","));', 'else if (config.tools !== undefined) args.push("--tools", config.tools.filter((tool) => !CLAUDE_SEARCH_TOOLS.has(tool)).join(","));', driverTest, 'saved native tool allowlist|reusing a thread'],
  ['git-nonmutating-fallthrough', wipe, 'if(nonmutating)continue;', 'if(nonmutating && false)continue;', gitTest, 'Git nonmutating intent run'],
  ['git-option-value-confusion', git, 'if(values.has(arg)){index++;continue;}', 'if(false && values.has(arg)){index++;continue;}', gitTest, 'Git nonmutating intent card'],
  ['git-merge-gate-dry-run', wipe, 'if(nonmutating)continue;', 'if(nonmutating && false)continue;', mergeTest, 'H6 Git push dry runs'],
];
const run = (name, files, pattern) => {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, ...(pattern ? ['-t', pattern] : [])], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(directory, `${name}.log`), output);
  return { result, output };
};
const baseline = run('green', [driverTest, gitTest, mergeTest]);
assert.equal(baseline.result.status, 0, 'Unmutated production path must be green');
const report = [];
for (const [name, file, before, after, test, pattern] of mutants) {
  const source = readFileSync(file, 'utf8');
  assert.equal(source.split(before).length, 2, `${name}: unique production anchor`);
  try {
    writeFileSync(file, source.replace(before, after));
    const { result, output } = run(name, [test], pattern);
    assert.equal(result.status, 1, `${name}: mutant must fail assertions`);
    assert.match(output, /AssertionError/, `${name}: an assertion must kill the mutant`);
    report.push({ name, file, test, pattern, status: result.status, killed: true });
    console.log(`KILLED ${name} ${test}`);
  } finally { writeFileSync(file, source); }
}
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
