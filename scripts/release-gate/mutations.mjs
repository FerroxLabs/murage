// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killedMutation } from './mutation-proof.mjs';

// This runner intentionally mutates disposable copies only. The test controller's
// fake fixed /root tool paths must be isolated from the real shard installation.
if (process.env.GATE_TEST_CONTAINER !== '1' || !existsSync('/.dockerenv')) throw Error('Use the isolated test container');
const out = resolve(process.argv[2] ?? '/evidence');
if (out === '/' || out === '/dev' || out.startsWith('/dev/')) throw Error('Unsafe evidence directory');
mkdirSync(out, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url)), temp = mkdtempSync('/tmp/gate-mutants-');
const dir = join(temp, 'scripts/release-gate'); mkdirSync(dir, { recursive: true });
for (const file of readdirSync(here)) copyFileSync(join(here, file), join(dir, file));
for (const file of ['server/testing/safe-wipe.mjs', 'electron/data-dir-lease.mjs', 'electron/windows-native.mjs']) {
  const target = join(temp, file); mkdirSync(dirname(target), { recursive: true });
  copyFileSync(new URL('../../' + file, import.meta.url), target);
}
const cases = [
  ['BLOCK-1', 'gate-1019.mjs', 'orchestration.node-test.mjs', 'BLOCK-1',
    '  for (const log of shardLogs) cleanupOwnedShards(log, sha, out);', '  // Mutant: omit interrupted shard cleanup.'],
  ['BLOCK-2', 'judge.mjs', 'orchestration.node-test.mjs', 'BLOCK-2',
    "  if (!report || !['PASS', 'FAIL', 'UNVERIFIED'].includes(report.verdict) ||\n      code !== (report.verdict === 'PASS' ? 0 : 1)) return 'FAIL';", '  // Mutant: accept stale report despite abnormal exit.'],
  ['BLOCK-3', 'gate-1019.mjs', 'orchestration.node-test.mjs', 'BLOCK-3',
    "['server/browser-turn-execution.test.ts', 'server/browser-owner-wait-api.test.ts']", "['server/browser-turn-execution.test.ts']"],
  ['BLOCK-4', 'mutation-proof.mjs', 'mutation-proof.node-test.mjs', 'assertion RED',
    "return before?.code === 0 && red?.code === 1 && /AssertionError|ERR_ASSERTION/.test(red?.output ?? '') && after?.code === 0;", 'return true;'],
  ['BLOCK-5', 'gate-1019.mjs', 'inventory.node-test.mjs', 'BLOCK-5',
    'Waiting: host load > 60', ['Waiting for', 'host load to drop', 'below 60'].join(' ')],
];
const proofs = [];
try {
  for (const [finding, file, test, pattern, from, to] of cases) {
    const path = join(dir, file), original = readFileSync(path, 'utf8');
    if (original.split(from).length !== 2) throw Error(`Mutation anchor is not unique: ${finding}`);
    const execute = phase => {
      const env = { ...process.env }; delete env.GATE_MUTATION_PROOF;
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=' + pattern, join(dir, test)],
        { env, encoding: 'utf8', timeout: 60_000 });
      const output = (r.stdout ?? '') + (r.stderr ?? '');
      writeFileSync(join(out, `${finding}-${phase}.log`), output);
      return { code: r.status, output };
    };
    const before = execute('before');
    let red;
    try { writeFileSync(path, original.replace(from, to)); red = execute('red'); }
    finally { writeFileSync(path, original); }
    const after = execute('restored');
    const proof = { finding, file, from, to, implementationChanged: original !== original.replace(from, to), before, red, after };
    proofs.push(proof);
    const killed = killedMutation(proof) && /# pass [1-9]/.test(before.output) && /# pass [1-9]/.test(after.output) && /# fail [1-9]/.test(red.output);
    console.log(`${finding}: ${killed ? 'KILLED; restored GREEN' : 'INVALID PROOF'}`);
    if (!killed) process.exitCode = 1;
  }
  writeFileSync(join(out, 'mutations.json'), JSON.stringify(proofs, null, 2) + '\n');
} finally { safeWipeSync(temp); }
