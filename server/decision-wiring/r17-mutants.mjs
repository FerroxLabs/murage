// SPDX-License-Identifier: AGPL-3.0-or-later
import {verifyDecisionMutant} from '../../scripts/test-truth/decision-mutant.test-helper.mjs';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = process.env.S4_MUTANT_EVIDENCE; if (!dir) throw Error('S4_MUTANT_EVIDENCE required');
mkdirSync(dir, { recursive: true });
const mutants = [
  ['M18-dropped-wrapper-stamp', 'server/index.ts', 'routineRequests.afterSettle(record.threadId, record.chatMessageId);', ';', 'R17 RED real routine settle'],
  ['M19-unguarded-kind', 'server/index.ts', "if (port.kind === 'routine') {", 'if (true) {', 'R17 RED real routine settle'],
  ['M19-unguarded-state', 'server/index.ts', "if (result.state === 'accepted' || result.state === 'already') {\n          await releaseDecisionQueueProof(item);", 'if (true) {\n          await releaseDecisionQueueProof(item);', 'R17 RED real routine settle'],
  ['M19-propagated-throw', 'server/index.ts', "} catch (error) { console.error('[decision] routine settle stamp failed', error); }", '} catch (error) { throw error; }', 'R17 RED real afterSettle throw'],
  ['R17-dropped-hook-stamp', 'server/routine-requests.ts', '    this.stampApplied(threadId, messageId, requestId);', '    return;', 'R17 RED real routine settle'],
  ['M22-label-literal', 'server/routine-requests.ts', "typeof card.answered !== 'string'", "card.answered !== 'allow'", 'R17 RED real routine settle'],
  ['M21-early-wins', 'server/index.ts', 'Object.assign(opts, sharedTurnOptions(request));', 'Object.assign(opts, { ...sharedTurnOptions(request), ...opts });', 'R19b RED'],
];
const results = [];
for (const [id, path, from, to, test] of mutants) {
  const original = readFileSync(path, 'utf8');
  if (original.split(from).length !== 2) throw Error(`Expected unique mutation anchor: ${id}`);
  const changed = original.replace(from, to);
  try {
    // Save an exact, standalone patch without relying on the working tree base.
    const before = `${dir}/${id}.before`, after = `${dir}/${id}.after`;
    writeFileSync(before, original); writeFileSync(after, changed);
    const patch = spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, before, after], { encoding: 'utf8' });
    writeFileSync(`${dir}/${id}.patch`, patch.stdout);
    unlinkSync(before); unlinkSync(after);
    const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision-wiring/fix-round3.test.ts', '--maxWorkers=1', '-t', test];
    const assertion = id==='M21-early-wins' ? 'expect((await running).decisionRoutineSource?.sourceRunId).toBe(id)' : id==='M19-propagated-throw' ? "await expect(wrapped.respond({ approvalId: 'approval' }, {}, {})).resolves.toEqual({ state: 'already' })" : 'expect(f.read().card?.answeredAt).toBe(stamps ? 1700 : undefined)';
    const result = await verifyDecisionMutant({id,dir,args,file:'server/decision-wiring/fix-round3.test.ts',assertions:[assertion],
      mutate:()=>writeFileSync(path,changed),restore:()=>writeFileSync(path,original)});
    const {killed} = result;
    results.push({...result,patch:`${id}.patch`});
    console.log(`${id}: ${killed ? 'KILLED' : 'SURVIVED/INFRA'}`);
  } finally { writeFileSync(path, original); }
}
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
