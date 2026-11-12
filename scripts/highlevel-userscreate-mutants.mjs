// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = process.env.USERSCREATE_MUTANT_DIR ?? '.test-tmp/bld-hl-userscreate/mutants'; mkdirSync(root, { recursive: true });
const hash = text => createHash('sha256').update(text).digest('hex');
const variants = [
  { id: 'BLOCK1-secret-log-during-transport', file: 'server/highlevel/client.ts',
    from: 'completion.secret = generatePrivateUserPassword();',
    to: "completion.secret = generatePrivateUserPassword(); console.log(completion.secret.toString('ascii'));",
    test: 'server/highlevel/users-create-host.test.ts', name: 'intercepts actual process output', assertion: 'A secret reached a protected sink.' },
  { id: 'BLOCK2-collection-failure-counted-as-red', file: 'scripts/highlevel-userscreate-red-verdict.mjs',
    from: "return exitCode === 1 && report.numTotalTests === 2 && report.numFailedTests === 2",
    to: "return exitCode !== 0 || report.numTotalTests === 2 && report.numFailedTests === 2",
    test: 'scripts/highlevel-userscreate-red-verdict.test.mjs', name: 'BLOCK2 rejects collection failures', assertion: 'expected true to be false' },
  { id: 'secret-echo-result', file: 'server/highlevel/client.ts',
    from: 'return userCreatePublicResponse(raw, reviewed);',
    to: "return { ...userCreatePublicResponse(raw, reviewed), privatePassword: completion.secret?.toString('ascii') };",
    test: 'server/highlevel/users-create-private.test.ts', name: 'one bounded TLS call', assertion: 'A secret reached a protected sink.' },
  { id: 'replacement-create-on-restart', file: 'server/highlevel/host.ts',
    from: "    const ctx = this.#context(claim, current, this.#deps.signals.signalFor(claim), row.tool, args, undefined, spec, 'ownership');",
    to: `    const ctx = this.#context(claim, current, this.#deps.signals.signalFor(claim), row.tool, args, undefined, spec, 'ownership');
    if (row.operation === 'users.create') {
      const run = { locationId: row.locationId, companyId: row.companyId };
      const replacement = HeldRequest.freeze(spec, { path: '/users/', resource: 'location:' + row.locationId, body: { kind: 'json', value: args } }, run);
      await this.#deps.client.sendHeldWithPrivatePassword({ ...ctx, onDispatch: async () => {} }, replacement, replacement.frozen.requestDigest);
    }`,
    test: 'server/highlevel/users-create-host.test.ts', name: 'restart after interrupted settlement', assertion: 'expected 1 to be +0' },
  { id: 'missing-finally-clear', file: 'server/highlevel/client.ts',
    from: 'completion.secret?.fill(0);', to: '/* omitted secret clearing */',
    test: 'server/highlevel/users-create-private.test.ts', name: 'one bounded TLS call', assertion: 'expected false to be true' },
  { id: 'recipient-flag-default-true', file: 'server/highlevel/users-create-policy.ts',
    from: "return env.HL_USERSCREATE_RECIPIENT_VERIFIED === 'true';", to: "return env.HL_USERSCREATE_RECIPIENT_VERIFIED !== 'false';",
    test: 'server/highlevel/users-create-private.test.ts', name: 'recipient flag is strictly opt in', assertion: 'expected true to be false' },
];
const results = [];
for (const variant of variants) {
  const original = readFileSync(variant.file, 'utf8');
  if (original.split(variant.from).length !== 2) throw new Error(`Mutation target is not unique: ${variant.id}`);
  const run = () => spawnSync('pnpm', ['exec', 'vitest', 'run', variant.test, '-t', variant.name], { encoding: 'utf8', timeout: 120_000 });
  const baseline = run();
  writeFileSync(`${root}/${variant.id}-baseline.log`, baseline.stdout + baseline.stderr);
  if (baseline.status !== 0) throw new Error(`Baseline failed: ${variant.id}`);
  let mutant;
  try { writeFileSync(variant.file, original.replace(variant.from, variant.to)); mutant = run(); }
  finally { writeFileSync(variant.file, original); }
  const log = mutant.stdout + mutant.stderr;
  writeFileSync(`${root}/${variant.id}.log`, log);
  const killed = mutant.status !== 0 && !mutant.error && log.includes(variant.assertion);
  results.push({ id: variant.id, baselineExit: baseline.status, mutantExit: mutant.status, killed,
    assertion: variant.assertion, before: hash(original), after: hash(readFileSync(variant.file, 'utf8')) });
  writeFileSync(`${root}/results.json`, JSON.stringify(results, null, 2));
  console.log(`${variant.id}: ${killed ? 'KILLED' : 'OPEN'}`);
  if (!killed) process.exitCode = 1;
}
