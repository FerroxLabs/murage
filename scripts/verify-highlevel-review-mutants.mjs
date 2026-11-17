// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only inside the isolated, network-none verification container.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const directory = '.afix-evidence/mutants';
mkdirSync(directory, { recursive: true });
const mutants = [
  { name: 'H1-stored-bot-mount-policy', file: 'server/highlevel/runtime.ts', from: 'turnNoLimits ?? noLimitsAppliesTo', to: 'noLimitsAppliesTo', tests: ['server/highlevel/owner-turn-api.test.ts'], filter: 'AFIX H1' },
  { name: 'H1-task-capped-by-profile', file: 'server/index.ts', from: '  // The authenticated conversation settings may explicitly exceed the bot default.', to: '  if (hasNoLimits(settings) && !noLimitsAppliesTo(origin,profile ?? settings)) settings = permissionsForOrigin(settings,false);', tests: ['server/highlevel/owner-turn-api.test.ts'], filter: 'AFIX H1' },
  { name: 'H2-lower-chief-overwrites-bot', file: 'server/permission-inheritance.ts', from: 'if(value.noLimits!==true)return value;', to: '// Mutant: lower levels also replace the stored fallback.', tests: ['server/highlevel/no-limits-review-repairs.test.ts'], filter: 'AFIX H2' },
  { name: 'H3-deleted-full-access-cases', file: 'server/drivers/no-limits-provider-release-1019.test.ts', from: "for(const engine of engines)it(`C7 ${engine} Full access preserves its changed-target release`,()=>run(engine,true,true,'full'),30000);", to: '', command: ['scripts/verify-highlevel-review-coverage.mjs'] },
  { name: 'M1-unbounded-policy-inventory', file: 'server/highlevel/actions.ts', from: 'detail.basis !== "owner_exact_review" && this.#rows.size >= ACTION_MAX_POLICY_IDENTITIES', to: 'false', tests: ['server/highlevel/policy-capacity.test.ts'], filter: 'AFIX M1' },
];
const results = [];
for (const mutant of mutants) {
  const original = readFileSync(mutant.file, 'utf8');
  const changed = original.replace(mutant.from, mutant.to);
  if (original === changed) throw Error('Missing mutant anchor: ' + mutant.name);
  try {
    writeFileSync(mutant.file, changed);
    const result = spawnSync(process.execPath, mutant.command ?? ['node_modules/vitest/vitest.mjs', 'run', ...mutant.tests, '-t', mutant.filter], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    const log = (result.stdout ?? '') + (result.stderr ?? '');
    writeFileSync(`${directory}/${mutant.name}.log`, log);
    const killed = result.status === 1 && /AssertionError/.test(log);
    results.push({ name: mutant.name, status: result.status, signal: result.signal, killed });
    writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2) + '\n');
    console.log(mutant.name, killed ? 'KILLED' : 'SURVIVED');
    if (!killed) process.exitCode = 1;
  } finally { writeFileSync(mutant.file, original); }
}
