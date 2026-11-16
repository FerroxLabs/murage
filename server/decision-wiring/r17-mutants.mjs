// SPDX-License-Identifier: AGPL-3.0-or-later
import { withHideInherit } from '../../shared/win-hide-child-process.mjs';
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
    writeFileSync(path, changed);
    // Save an exact, standalone patch without relying on the working tree base.
    const before = `${dir}/${id}.before`, after = `${dir}/${id}.after`;
    writeFileSync(before, original); writeFileSync(after, changed);
    const patch = spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, before, after], { encoding: 'utf8' });
    writeFileSync(`${dir}/${id}.patch`, patch.stdout);
    unlinkSync(before); unlinkSync(after);
    const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision-wiring/fix-round3.test.ts', '--maxWorkers=1', '-t', test];
    const run = spawnSync(process.execPath, [...args], withHideInherit({ encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }));
    const output = (run.stdout ?? '') + (run.stderr ?? '');
    const killed = run.status === 1 && /AssertionError:/.test(output);
    writeFileSync(`${dir}/${id}.log`, `${[process.execPath, ...args].join(' ')}\nEXIT ${run.status}\n${output}`);
    results.push({ id, killed, exit: run.status, patch: `${id}.patch`, log: `${id}.log` });
    console.log(`${id}: ${killed ? 'KILLED' : 'SURVIVED/INFRA'}`);
  } finally { writeFileSync(path, original); }
}
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2) + '\n');
if (results.some(result => !result.killed)) process.exitCode = 1;
