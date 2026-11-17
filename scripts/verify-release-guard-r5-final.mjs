// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]); const results = [];
for (const [id, args] of [
 ['focused', ['node_modules/vitest/vitest.mjs', 'run', 'server/decision/release-guard-r2.test.ts', 'server/decision/release-guard-r3.test.ts', 'server/decision/release-guard-r4.test.ts', 'server/decision/release-guard-r5.test.ts', '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'current-focused.json')]],
 ['live', ['scripts/verify-release-guard-r5-live.mjs', join(out, 'current-live')]],
 ['backend-types', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']],
 ['lint', ['node_modules/oxlint/bin/oxlint', 'server/no-limits-shell.ts', 'server/no-limits-wipe.ts', 'server/decision/release-guard-r5.test.ts', 'scripts/verify-release-guard-r5-final.mjs', 'scripts/verify-release-guard-r5-isolated.mjs', 'scripts/verify-release-guard-r5-compare.mjs', 'scripts/verify-release-guard-r5-paired.mjs']],
]) {
 const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
 writeFileSync(join(out, 'current-' + id + '.log'), result.stdout + result.stderr);
 results.push({ id, args, exitCode: result.status, signal: result.signal, error: result.error?.message });
 if (result.status !== 0) { process.exitCode = 1; break; }
}
writeFileSync(join(out, 'current-checks.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
