// SPDX-License-Identifier: AGPL-3.0-or-later
// Container snapshot only. Compare one complete shard before/after af48a0ee.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const out = resolve(process.argv[2]);
const baseline = spawnSync(process.execPath, ['scripts/verify-release-guard-r5-baseline.mjs', out], { stdio: 'inherit', timeout: 480000 });
if (baseline.error) throw baseline.error;
if (baseline.status !== 0) throw Error('baseline orchestration failed');
const files = JSON.parse(readFileSync(join(out, 'selected-files.json'), 'utf8'));
const candidate = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'candidate.json')], { stdio: 'inherit', timeout: 480000 });
writeFileSync(join(out, 'paired-receipt.json'), JSON.stringify({ baselineExit: baseline.status, candidateExit: candidate.status, signal: candidate.signal, error: candidate.error?.message }, null, 2) + '\n');
if (candidate.error) throw candidate.error;
process.exitCode = candidate.status ?? 1;
