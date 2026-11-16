// Run only inside the job's isolated, network-disabled test container.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'server/inbox-routine-aggregate.ts';
const original = readFileSync(path, 'utf8');
const mutants = [
  ['expiry-not-decremented', 'latest !== undefined && latest.at >= now - ROUTINE_WINDOW_MS', 'latest !== undefined', 'badge recovery and expiry', 'server/inbox-routine-aggregate.badge.test.ts'],
  ['boundary-day-not-expired', 'const summary = counters.window(timeKey(cutoff));', 'const summary = counters.summary;', 'counts a terminal transition'],
  ['terminal-not-counted', '    this.remove(entry.id);', '    if (this.work.rebuilt > 0) return;\n    this.remove(entry.id);', 'counts a terminal transition'],
  ['rebuild-skipped', '    for (const entry of entries) this.upsert(entry);', '    // MUTANT: startup rebuild omitted', 'rebuilds from the durable source'],
];
const results = [];
try {
  for (const [name, from, to, test, testFile = "server/inbox-routine-aggregate.test.ts"] of mutants) {
    if (!original.includes(from)) throw Error(`Mutation target missing: ${name}`);
    writeFileSync(path, original.replace(from, to));
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', testFile, '--maxWorkers=1', '-t', test], { encoding: 'utf8' });
    const output = run.stdout + run.stderr;
    writeFileSync(`lane-evidence/inbox-rollup/mutant-${name}.log`, output);
    const killed = run.status !== 0 && output.includes('AssertionError');
    results.push({ name, exit: run.status, killed });
    if (!killed) throw Error(`Mutant not killed by assertion: ${name}`);
  }
} finally {
  writeFileSync(path, original);
  writeFileSync('lane-evidence/inbox-rollup/mutants.json', JSON.stringify(results, null, 2) + '\n');
}
console.log(JSON.stringify(results));
