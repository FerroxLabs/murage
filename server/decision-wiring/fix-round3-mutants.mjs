// SPDX-License-Identifier: AGPL-3.0-or-later
import { withHideInherit } from '../../shared/win-hide-child-process.mjs';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'server/index.ts', original = readFileSync(path, 'utf8');
const dir = process.env.S4_MUTANT_EVIDENCE; if (!dir) throw Error('S4_MUTANT_EVIDENCE required'); mkdirSync(dir, { recursive: true });
const mutants = [
  ['M1-history-sweep', 'R1 RED|R15 RED', original.slice(original.indexOf('    const listed = listContinuations('), original.indexOf('    sharedRetireCursor = listed.next;')), `    const listed = { keys: database().prepare("SELECT id, from_bot_id FROM room_requests WHERE from_bot_id IS NOT NULL AND state IN ('done','failed','expired','cancelled','unknown')").all().map(row => ({kind:'background-job', id:'shared-peer:'+row.id, botId:row.from_bot_id, threadId:requestSourceThread(row.id)})) };\n`],
  ['M2-descendant-walk', 'R2 RED', 'if (groups.get(row.groupId)!.has(sharedSourceIdentity(key))) continue;', `if (database().prepare(\`WITH RECURSIVE descendants(id, state) AS (
      SELECT id, state FROM room_requests WHERE parent_id=?
      UNION SELECT r.id, r.state FROM room_requests r JOIN descendants d ON r.parent_id=d.id
    ) SELECT 1 FROM descendants WHERE state IN ('queued','running','waiting_owner','waiting_bot') LIMIT 1\`).get(String(row.id))) continue;`],
  ['M3-parent-children', 'R3 guard|R2 RED', 'if (groups.get(row.groupId)!.has(sharedSourceIdentity(key))) continue;', `if (database().prepare("SELECT id FROM room_requests WHERE parent_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").get(row.id)) continue;`],
  ['M4-climb-past-ask', 'R5 RED|R12 RED', "if (row.verb !== 'wake') break;\n    row = row.parentId ? lookup", "row = row.parentId ? lookup"],
  ['M5-any-wake-holds', 'R4 guard', 'if (groups.get(row.groupId)!.has(sharedSourceIdentity(key))) continue;', "if (database().prepare(\"SELECT id FROM room_requests WHERE group_id=? AND state IN ('queued','running','waiting_owner','waiting_bot') AND verb='wake'\").get(row.groupId)) continue;"],
  ['M6-no-retry-chain', 'R3 guard', "row = row.parentId ? lookup(row.parentId) : null;", "row = seen.size < 2 && row.parentId ? lookup(row.parentId) : null;"],
  ['M7-orphan-skip', 'R6 RED', "if (row && !isTerminalRoomRequestState(row.state)) continue;", "if (!row || !isTerminalRoomRequestState(row.state)) continue;"],
  ['M9-cursor-stuck', 'R9 RED', 'sharedRetireCursor = listed.next;', 'sharedRetireCursor = undefined;'],
  ['M10-broad-filter', 'R10 RED', "namespace: 'shared-peer', after: sharedRetireCursor", "namespace: undefined, after: sharedRetireCursor"],
  ['M11-sweep-blocks', 'R11 RED', '  resumeAllProjectCloses(); deliverOwedSharedResults(); roomDispatcher.tick();', '  await retireDecisionSharedSources();\n  resumeAllProjectCloses(); deliverOwedSharedResults(); roomDispatcher.tick();'],
  ['M12-no-save-wait', 'R14 guard', '  await Promise.allSettled(requests.map(request => awaitSharedChainSaves(request)));', '  /* omitted chain save barrier */'],
  ['M13-completion-skip', 'completion guard', 'void retireForCompletion([result.request, ...(result.cancelled ?? [])])', 'void Promise.resolve([result.request, ...(result.cancelled ?? [])])'],
  ['M12-cancelled-save-dropped', 'history gate: cancellation', 'requests.map(request => awaitSharedChainSaves(request))', 'requests.slice(0, 1).map(request => awaitSharedChainSaves(request))'],
  ['completion-no-dedup', 'completion guard cancelled wakes deduplicate', 'keys.set(sharedSourceIdentity(source.key), source.key)', 'keys.set(String(keys.size), source.key)'],
  ["M14-use-side-drift", 'R12 RED', '  const captured = governingSharedSource(request)?.captured;', `  let row = request, captured; const seen = new Set(); while(row && seen.size < 50 && !seen.has(row.id)) { seen.add(row.id); const threadId = requestSourceThread(row.id); if(threadId && row.fromBotId) captured=readContinuation({kind:'background-job',id:'shared-peer:'+row.id,botId:row.fromBotId,threadId}); if(captured) break; row=row.parentId?roomRequest(database(),row.parentId):null; }`],
  ['M15-stale-cache', 'R13 guard', '  // No continuation read or hold cache survives this await phase.', `  const earlyGroups = new Map(); for (const key of keys) { const row=roomRequest(database(),key.id.slice(12)); if(row && !earlyGroups.has(row.groupId)) earlyGroups.set(row.groupId,heldKeys(row.groupId)); }\n  // No continuation read or hold cache survives this await phase.`],
  ['M16-boot-unbounded', 'R15 RED', 'page < pages', 'page < Infinity'],
  ['M17-cap-returns', 'R18 guard', 'if (groups.get(row.groupId)!.has(sharedSourceIdentity(key))) continue;', `if (Number(database().prepare("SELECT count(*) AS n FROM room_requests WHERE group_id=? AND state IN ('queued','running','waiting_owner','waiting_bot') AND verb='wake'").get(row.groupId).n)>500 || groups.get(row.groupId)!.has(sharedSourceIdentity(key))) continue;`],
  ['M18-h16-dropped', 'R17 RED', 'routineRequests.afterSettle(record.threadId, record.chatMessageId);', ';'],
  ['M19-h16-unguarded', 'R17 RED', "if (port.kind === 'routine') {", 'if (true) {'],
  ['M20-barrier-own-id', 'R19 RED', 'chainIds(request).map(id => decisionSharedSaves.get(id)?.done)', '[decisionSharedSaves.get(request.id)?.done]'],
  ['M21-early-wins', 'R19b RED', 'Object.assign(opts, sharedTurnOptions(request));', 'Object.assign(opts, { ...sharedTurnOptions(request), ...opts });'],
];
const results = [];
try {
  for (const [id, test, from, to] of mutants) {
    if (!original.includes(from)) throw Error('Missing anchor ' + id);
    let changed = original.replace(from, to);
    if (id === 'M15-stale-cache') changed = changed.replace('const groups = new Map<string, Set<string>>();', 'const groups = earlyGroups;');
    writeFileSync(path, changed);
    const before = `${dir}/before.tmp`, after = `${dir}/after.tmp`;
    writeFileSync(before, original); writeFileSync(after, changed);
    const diff = spawnSync('diff', ['-u', '--label', 'a/server/index.ts', '--label', 'b/server/index.ts', before, after], { encoding: 'utf8' });
    writeFileSync(`${dir}/${id}.patch`, diff.stdout); unlinkSync(before); unlinkSync(after);
    const args = ['node_modules/vitest/vitest.mjs', 'run', 'server/decision-wiring/fix-round3.test.ts', '--maxWorkers=1', '-t', test];
    const run = spawnSync(process.execPath, [...args], withHideInherit({ encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }));
    const output = (run.stdout ?? '') + (run.stderr ?? '');
    const killed = run.status === 1 && /AssertionError:/.test(output);
    const command = [process.execPath, ...args].join(' ');
    writeFileSync(`${dir}/${id}.log`, `${command}\nEXIT ${run.status}\n${output}`);
    results.push({ id, killed, exit: run.status, command, patch: `${id}.patch`, log: `${id}.log` });
    writeFileSync(path, original);
    process.stdout.write(`${id}: ${killed ? 'KILLED' : 'SURVIVED/INFRA'}\n`);
  }
} finally { writeFileSync(path, original); }
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2));
if (results.some(r => !r.killed)) process.exitCode = 1;
