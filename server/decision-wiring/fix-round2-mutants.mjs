// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../shared/win-hide-child-process.mjs";
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { verifyDecisionMutant } from '../../scripts/test-truth/decision-mutant.test-helper.mjs';
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
const witness = 'server/decision-wiring/fix-round2.test.ts';
const intended = {
  'reject-skips-cancel': ['expect(cancelRequests).toHaveBeenCalledWith({ kind: \'generation\', threadId: \'t\', generation: \'g\' }, \'cancelled\')'],
  'shared-record-leak': ['expect(f.deleteContinuation).toHaveBeenCalledWith(f.key)'],
  'wake-loses-ancestry': ['expect(f.saved.size).toBe(1)'],
  'completion-skips-retirement': ['expect(f.saved.size).toBe(0)'],
  'restart-skips-retirement': ['expect(f.saved.size).toBe(0)'],
  'memory-drops-authority': ['expect(/authenticatedMemoryAgentRoute\\(internalCapabilities,\\s*internalClaim,\\s*path,/.test(source)).toBe(true)'],
};
const results = [];
try {
  for (const [id, test, from, to] of mutations) {
    if (!original.includes(from)) throw Error('Missing mutation anchor ' + id);
    const changed = original.replace(from, to);
    const args = ['node_modules/vitest/vitest.mjs', 'run', witness, '--maxWorkers=1', '-t', test];
    const result = await verifyDecisionMutant({ id, dir, args, file: witness, assertions: intended[id], mutate: () => writeFileSync(path, changed), restore: () => writeFileSync(path, original) });
    results.push({ ...result, command: [process.execPath, ...args].join(' '), mutation: { from, to } });
    process.stdout.write(`${id}: ${result.killed ? 'KILLED' : 'SURVIVED/INFRA'}\n`);
  }
} finally { writeFileSync(path, original); }
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2));
if (results.some(r => !r.killed)) process.exitCode = 1;
