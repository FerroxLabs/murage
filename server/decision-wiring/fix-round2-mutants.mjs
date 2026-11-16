// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../shared/win-hide-child-process.mjs";
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'server/index.ts', original = readFileSync(path, 'utf8');
const dir = process.env.S4_MUTANT_EVIDENCE; if (!dir) throw Error('S4_MUTANT_EVIDENCE required');
mkdirSync(dir, { recursive: true });
const mutations = [
  ['reject-skips-cancel', 'rejected shared save',
    'await Promise.allSettled([...decisionSharedSaves.values()].filter(save => save.generation === generation).map(save => save.done));',
    'await Promise.all([...decisionSharedSaves.values()].filter(save => save.generation === generation).map(save => save.done));'],
  ['shared-record-leak', 'shared done retires|shared cancelled retires',
    'deletes.push(deleteContinuation(key))', 'deletes.push(Promise.resolve())'],
  ['wake-loses-ancestry', 'dependent wakes retain ancestry',
    'if (groups.get(row.groupId)!.has(sharedSourceIdentity(key))) continue;', '/* ignore held keys */'],
  ['completion-skips-retirement', 'shared done retires',
    'void retireForCompletion([result.request, ...(result.cancelled ?? [])])', 'void Promise.resolve([result.request, ...(result.cancelled ?? [])])'],
  ['restart-skips-retirement', 'restart retires',
    "const listed = listContinuations({ kind: 'background-job'", "if (requestId === undefined) return; const listed = listContinuations({ kind: 'background-job'"],
  ['memory-drops-authority', 'HTTP memory entry',
    'async()=>authenticatedMemoryAgentRoute(internalCapabilities,internalClaim,path,', 'async()=>memoryAgentRoute(path,'],
];
const results = [];
try {
  for (const [id, test, from, to] of mutations) {
    if (!original.includes(from)) throw Error('Missing mutation anchor ' + id);
    writeFileSync(path, original.replace(from, to));
    const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision-wiring/fix-round2.test.ts', '--maxWorkers=1', '-t', test];
    const run = spawnSync(process.execPath, [...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const output = (run.stdout ?? '') + (run.stderr ?? '');
    const killed = run.status === 1 && /AssertionError:/.test(output);
    const command = [process.execPath, ...args].join(' ');
    writeFileSync(`${dir}/${id}.log`, `${command}\n${JSON.stringify({ from, to })}\nEXIT ${run.status}\n${output}`);
    results.push({ id, killed, exit: run.status, command, log: `${id}.log` });
    writeFileSync(path, original);
    process.stdout.write(`${id}: ${killed ? 'KILLED' : 'SURVIVED/INFRA'}\n`);
  }
} finally { writeFileSync(path, original); }
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2));
if (results.some(r => !r.killed)) process.exitCode = 1;
