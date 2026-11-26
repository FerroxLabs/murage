// SPDX-License-Identifier: AGPL-3.0-or-later
// Container-only source snapshot: mutation/live qualification cannot race broad verification.
import { cpSync, readFileSync, mkdtempSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
const mode = process.argv[2];
if (!['live', 'mutants', 'candidate', 'supplementary-baseline', 'paired', 'final'].includes(mode)) throw Error('qualification mode required');
const root = resolve('.'), out = resolve(process.argv[3]), scratch = mkdtempSync(join(tmpdir(), 'release-r5-' + mode + '-'));
try {
  cpSync(root, scratch, { recursive: true, filter: path => !['node_modules', '.git', 'lane-evidence'].includes(relative(root, path).split('/')[0]) });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
  const args = mode === 'final' ? ['scripts/verify-release-guard-r5-final.mjs', out] : mode === 'paired' ? ['scripts/verify-release-guard-r5-paired.mjs', out] : mode === 'supplementary-baseline' ? ['scripts/verify-release-guard-r5-baseline.mjs', out] : mode === 'candidate' ? ['node_modules/vitest/vitest.mjs', 'run', ...JSON.parse(readFileSync(join(out, 'selected-files.json'), 'utf8')), '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, 'candidate.json')] : ['scripts/verify-release-guard-r5-' + mode + '.mjs', out];
  const result = spawnSync(process.execPath, args, { cwd: scratch, stdio: 'inherit', timeout: 720000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { safeWipeSync(scratch); }
