// Run only in the isolated network-disabled verification container.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const cases = [
  { name: 'startup-source-snapshot-skipped', path: 'server/inbox-routine-lifecycle.ts', from: 'const runs = this.source.listRuns().slice(0, ROUTINE_ROW_LIMIT);', to: 'const runs: RoutineRun[] = [];', test: 'reconstructs the production rollup' },
  { name: 'hook-not-called', path: 'server/routines.ts', from: '    inboxRollupOnRunTerminal(run, this);', to: '    // MUTANT: terminal hook omitted', test: 'counts terminal transitions' },
  { name: 'pushBadge-legacy-after-ready', path: 'server/index.ts', from: 'inboxRollupBadgeAccess(database(), store, routines, inboxRoutineRuns), { cache: true });', to: '(inboxRollupBadgeAccess(database(), store, routines, inboxRoutineRuns), { ...inboxAccessFor(store, "companion"), routineRuns: inboxRoutineRuns() }), { cache: true });', test: 'does fixed work' },
];
const results = [];
for (const mutant of cases) {
  const original = readFileSync(mutant.path, 'utf8');
  if (!original.includes(mutant.from)) throw Error(`Missing mutation target: ${mutant.name}`);
  try {
    writeFileSync(mutant.path, original.replace(mutant.from, mutant.to));
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', 'server/inbox-routine-lifecycle.test.ts', '--maxWorkers=1', '-t', mutant.test], { encoding: 'utf8' });
    const output = run.stdout + run.stderr;
    writeFileSync(`lane-evidence/inbox-rollup/mutant-${mutant.name}.log`, output);
    const killed = run.status !== 0 && output.includes('AssertionError');
    results.push({ name: mutant.name, exit: run.status, killed });
    if (!killed) throw Error(`Mutant not killed by assertion: ${mutant.name}`);
  } finally { writeFileSync(mutant.path, original); }
}
writeFileSync('lane-evidence/inbox-rollup/production-mutants.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
