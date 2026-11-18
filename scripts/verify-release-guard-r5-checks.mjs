// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const rows = [];
for (const [id, args] of [
  ['frontend-types', ['node_modules/typescript/bin/tsc', '-b']],
  ['backend-types', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']],
  ['lint', ['node_modules/oxlint/bin/oxlint', 'server/decision/implementation.ts', 'server/decision/wipe-fingerprint.ts', 'server/no-limits-code.ts', 'server/no-limits-wipe.ts', 'server/shell/segments.ts', 'server/decision/release-guard-r2.test.ts', 'server/decision/release-guard-r3.test.ts', 'server/decision/release-guard-r5.test.ts', 'scripts/verify-release-guard-r5-baseline.mjs', 'scripts/verify-release-guard-r5-red.mjs', 'scripts/verify-release-guard-r5-live.mjs', 'scripts/verify-release-guard-r5-mutants.mjs', 'scripts/verify-release-guard-r5-isolated.mjs', 'scripts/verify-release-guard-r5-checks.mjs']],
]) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(out, id + '.log'), result.stdout + result.stderr);
  rows.push({ id, args, exitCode: result.status, signal: result.signal, error: result.error?.message });
}
writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify(rows));
if (rows.some(row => row.exitCode !== 0)) process.exitCode = 1;
