// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';

let fixture: VerificationServer, desktop: Record<string, string>;
const evidence: unknown[] = [];
const evidenceDir = process.env.GNL_ROOM_EVIDENCE ?? (process.env.MURAGE_TEST_EVIDENCE_DIR??'/tmp/murage-test-evidence')+'/room';
// Seed a real guest binding and channel-origin room message. All authentication,
// permission policy, room dispatch, ask admission and queue draining are real.
const instrumentation = `
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 const fs=process.getBuiltinModule('node:fs');let source=fs.readFileSync(new URL(url),'utf8');
 source="import {bindHumanThread as fixtureBind,observeVerifiedHuman as fixtureObserve,linkHumanBinding as fixtureLink,resolveHumanBinding as fixtureResolve} from './human-principals.ts';import {ownerMemoryTicket as fixtureTicket} from './memory/authority.ts';\\n"+source;
 const taskAnchor='const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined);';
 if(!source.includes(taskAnchor))throw Error('switch task seed anchor missing');
 source=source.replace(taskAnchor,taskAnchor+\`
 if(task && (body.title==='R6 guest destination'||body.title==='R7 guest source')){const id=fixtureObserve({platform:'telegram',authorityId:'r6-fixture',userId:task.threadId,connectionId:'r6-fixture'});fixtureLink(fixtureTicket(),{bindingId:id,expectedRevision:1,as:'person'});fixtureBind(task.threadId,fixtureResolve(id));}
 if(task && body.title==='R6 shared destination'){task.sharedWork={teamId:'r6-other-team',createdAt:1};}
 if(task && body.title==='R7 guest source'){const text='__fixture_hold_authority__ R7_GUEST_DIRECT_SOURCE';const msg=store.appendMessage(task.threadId,{role:'user',kind:'text',text,origin:'unproven'});setTimeout(()=>void startTurn(bot.id,text,{threadId:task.threadId,notOwnerAudience:true,commsDepth:1,userMessage:msg}),0);}
 \`);
 const anchor='let group = store.createGroup(name, memberIds.filter(id => !stagedMembers.includes(id)), false, section, setup);';
 if(!source.includes(anchor))throw Error('guest seed anchor missing');
 source=source.replace(anchor,anchor+\`
 if(name.startsWith('R4 guest')){const id=fixtureObserve({platform:'telegram',authorityId:'r4-fixture',userId:group.id,connectionId:'r4-fixture'});fixtureLink(fixtureTicket(),{bindingId:id,expectedRevision:1,as:'person'});fixtureBind(group.threadId,fixtureResolve(id));store.appendMessage(group.threadId,{role:'user',kind:'text',text:'__fixture_hold_authority__ R4_GUEST_SOURCE_'+group.id,origin:'unproven'});setTimeout(()=>void runGroupMemberTurn(group.id,group.threadId,memberIds[0],0),0);}
 \`);
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
async function api(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, { method, signal: AbortSignal.timeout(40000), headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, ...out }); return out;
}
async function bot(name: string, noLimits = false) {
  const instances = await api('GET', '/api/instances');
  const model = instances.body.instances.find((i: any) => i.instanceId === 'verification').models.options[0].id;
  const made = await api('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } });
  expect(made.status).toBe(201);
  const b = made.body.bot;
  expect((await api('PATCH', `/api/bots/${b.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off', section: name, sharedWith: { mode: 'none', teams: [] } })).status).toBe(200);
  if (noLimits) expect((await raiseLevel(api, b.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  return b;
}
async function group(b: any, name: string, project = true) {
  const made = await api('POST', '/api/groups', { name, memberIds: [b.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: b.id } }, ...(project ? { channelProject: { goal: 'Verify owner cross-project asks' } } : {}) });
  expect(made.status, JSON.stringify(made.body)).toBe(201); return made.body.group;
}
function findDump(marker: string): any {
  try { const lines = readFileSync(fixture.fixtureDumpLogPath, 'utf8').trim().split('\n'); const line = lines.findLast(line => line.includes(marker)); return line && withTurnSecrets(JSON.parse(line)); } catch { return undefined; }
}
async function dump(marker: string) {
  await expect.poll(() => Boolean(findDump(marker)), { timeout: 25000 }).toBe(true);
  const found = findDump(marker); evidence.push({ marker, pid: found.pid, threadId: found.mcpConfig?.mcpServers?.agents?.env?.MURAGE_THREAD_ID }); return found;
}
const finish = (turn: any) => writeFileSync(join(fixture.fixtureFinishGateDir, String(turn.pid)), 'finish');
async function startRoom(b: any, room: any, marker: string) {
  expect((await api('POST', `/api/groups/${room.id}/messages`, { text: '__fixture_hold_authority__ ' + marker })).status).toBe(202);
  const turn = await dump(marker), env = turn.mcpConfig.mcpServers.agents.env;
  expect(env.MURAGE_THREAD_ID).toBe(room.threadId);
  expect(room.threadId).not.toBe(b.threadId);
  expect((await api('GET', `/api/bots/${b.id}`)).body.bot.tasks.some((task: any) => task.threadId === room.threadId)).toBe(false);
  return { turn, auth: { authorization: 'Bearer ' + env.MURAGE_COMMS_TOKEN } };
}
function ledger(id: string) {
  const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
  try { return { request: db.prepare('SELECT * FROM room_requests WHERE id=?').get(id), queue: db.prepare('SELECT * FROM pending_delegations WHERE id=?').get(id) }; } finally { db.close(); }
}
async function noCards(threadId: string) {
  expect((await api('GET', `/api/threads/${threadId}/messages?limit=200`)).body.messages.filter((m: any) => m.card && !m.card.intake && !m.card.answered)).toEqual([]);
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation, dumpLog: true });
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret', undefined, {})).body.secret };
}, 120000);
afterAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  if (fixture) writeFileSync(join(evidenceDir, 'server.log'), readFileSync(fixture.info.logPath));
  writeFileSync(join(evidenceDir, 'workflows.json'), JSON.stringify({ fixture: fixture?.info, evidence }, (key, value) => /token|secret|credential|authorization/i.test(key) ? '[redacted]' : value, 2));
if(fixture){try{writeFileSync(evidenceDir+'/mount-observations.json',JSON.stringify(readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').map(line=>{const dump=JSON.parse(line);return {pid:dump.pid,prompt:dump.prompt,mounts:Object.keys(dump.fixtureMounts??{})};}),null,2));}catch{/* No engine may have reached its prompt. */}}
  await fixture?.close();
});

it('a stopped room ask keeps its one cancelled outcome when the synchronous reply settles again', async () => {
  const source = await bot('Stopped ask source', true), target = await bot('Stopped ask target');
  await group(target, 'Stopped ask target project');
  const room = await group(source, 'Stopped ask source project');
  const t = await startRoom(source, room, 'STOPPED_ASK_SOURCE');
  const marker = '__fixture_hold_authority__ STOPPED_ASK_TARGET';
  // Cancellation may return the fence's plain-text refusal; it is not a successful tool result to parse as JSON.
  const pending = fetch(fixture.info.url + '/api/internal/ask-bot', {
    method: 'POST', signal: AbortSignal.timeout(40000), headers: { ...t.auth, 'content-type': 'application/json' },
    body: JSON.stringify({ fromBotId: source.id, fromThreadId: room.threadId, toBotId: target.id, message: marker }),
  }).then(async response => ({ status: response.status, text: await response.text() }));
  let peer: any;
  try {
    peer = await dump(marker);
    const requests = async () => (await api('GET', `/api/groups/${room.id}/requests`)).body.requests;
    const asks = (await requests()).filter((row: any) => row.verb === 'ask' && row.fromBotId === source.id && row.toBotId === target.id);
    expect(asks).toHaveLength(1);
    expect(asks[0].state).toBe('running');
    expect((await api('POST', `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
    await pending;
    const settled = await requests();
    expect(settled.filter((row: any) => row.id === asks[0].id)).toMatchObject([
      { state: 'cancelled', outcomeNote: 'cancelled with the request that asked' },
    ]);
    expect(settled.filter((row: any) => row.verb === 'ask')).toHaveLength(1);
    expect(settled.filter((row: any) => row.verb === 'wake')).toEqual([]);
  } finally { if (peer) finish(peer); finish(t.turn); await pending; }
}, 70000);

it('H1 owner No limits ask from a real project room starts an outside-project target', async () => {
  const source = await bot('R4 immediate source', true), target = await bot('R4 immediate target');
  const other = await group(target, 'R4 immediate target project'), room = await group(source, 'R4 immediate source project');
  expect(other.id).not.toBe(room.id);
  const t = await startRoom(source, room, 'R4_IMMEDIATE_SOURCE');
  const marker = '__fixture_hold_authority__ R4_IMMEDIATE_TARGET';
  const pending = api('POST', '/api/internal/ask-bot', { fromBotId: source.id, fromThreadId: room.threadId, toBotId: target.id, message: marker }, t.auth);
  try {
    const peer = await dump(marker);
    expect(peer.mcpConfig.mcpServers.agents.env.MURAGE_THREAD_ID).toBe(target.threadId);
    finish(peer);
    const out = await pending;
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.error).toBeUndefined(); expect(out.body.startCode).toBeUndefined();
    await noCards(room.threadId);
  } finally { finish(t.turn); await pending; }
}, 70000);

it.each([true, false])('H2 owner No limits busy ask persists admission and drains after source ends (project=%s)', async (project) => {
  const source = await bot('R4 queued source', true), target = await bot('R4 queued target');
  await group(target, 'R4 queued target project'); const room = await group(source, 'R4 queued source project', project);
  expect((await api('POST', `/api/bots/${target.id}/messages`, { text: '__fixture_hold_authority__ R4_BUSY_TARGET_' + project })).status).toBe(202);
  const busy = await dump('R4_BUSY_TARGET_' + project), t = await startRoom(source, room, 'R4_QUEUED_SOURCE_' + project);
  const marker = '__fixture_hold_authority__ R4_DRAINED_TARGET_' + project;
  try {
    const queued = await api('POST', '/api/internal/ask-bot', { fromBotId: source.id, fromThreadId: room.threadId, toBotId: target.id, message: marker }, t.auth);
    expect(queued.status, JSON.stringify(queued.body)).toBe(200); expect(queued.body.busy).toBe(true); expect(queued.body.taskId).toBeTruthy();
    const stored = ledger(queued.body.taskId); evidence.push({ admission: stored });
    expect(stored.request?.parent_id).toBeTruthy(); expect(stored.request?.state).toBe('queued');
    expect(JSON.parse(String(stored.request?.execution_audience))).toMatchObject({ kind: 'home', admission: {
      kind: 'owner-no-limits-admitted', principal: { personId: 'workspace-owner', bindingId: 'local', revision: 1 },
      requestId: queued.body.taskId, fromBotId: source.id, sourceThreadId: room.threadId, toBotId: target.id,
    } });
    if (!project) {
      const parent = ledger(String(stored.request?.parent_id));
      expect(parent.request?.execution_audience).toBeNull();
    }
    expect(JSON.parse(String(stored.queue?.item)).executionAudience).toEqual(JSON.parse(String(stored.request?.execution_audience)));
    expect(findDump(marker)).toBeUndefined();
    finish(t.turn);
    // A finished source turn waits for its queued child's answer before the request completes.
    await expect.poll(() => ledger(String(stored.request?.parent_id)).request?.state, { timeout: 20000 }).toBe('waiting_bot');
    await expect.poll(() => ledger(queued.body.taskId).queue?.phase, { timeout: 15000 }).toBe('busy');
    expect(findDump(marker)).toBeUndefined();
    finish(busy);
    const peer = await dump(marker);
    expect(peer.mcpConfig.mcpServers.agents.env.MURAGE_THREAD_ID).toBe(target.threadId);
    evidence.push({ dispatched: ledger(queued.body.taskId) });
    expect(ledger(queued.body.taskId).request?.state).toBe('running');
    finish(peer);
    await expect.poll(() => ledger(queued.body.taskId).request?.state, { timeout: 20000 }).toBe('done');
    await noCards(room.threadId);
  } finally { finish(busy); finish(t.turn); }
}, 90000);

it.each([true, false])('guest room keeps its partition rules on a No limits bot (project=%s)', async (project) => {
  const source = await bot('R4 guest source', true), target = await bot('R4 guest target');
  await group(target, 'R4 other guest target project'); const room = await group(source, 'R4 guest source project', project);
  const turn = await dump('R4_GUEST_SOURCE_' + room.id);
  expect(turn.mcpConfig.mcpServers.agents.env.MURAGE_THREAD_ID).toBe(room.threadId);
  expect(turn.argv).not.toContain('bypassPermissions');
  const t = { turn, auth: { authorization: 'Bearer ' + turn.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN } };
  try {
    const out = await api('POST', '/api/internal/ask-bot', { fromBotId: source.id, fromThreadId: room.threadId, toBotId: target.id, message: '__fixture_hold_authority__ R4_GUEST_FORBIDDEN' }, t.auth);
    expect(out.status, JSON.stringify(out.body)).toBe(403);
    expect(out.body.error).toBeTruthy(); expect(out.body.busy).toBeUndefined();
    expect(findDump('R4_GUEST_FORBIDDEN')).toBeUndefined();
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM pending_delegations WHERE source_thread_id=?').get(room.threadId)?.n).toBe(0); } finally { db.close(); }
  } finally { finish(t.turn); }
}, 60000);

it.each(['owner', 'guest', 'shared'])('H3 busy owner admission drains after target switches to a %s chat', async (destination) => {
  const source = await bot('R6 switched source '+destination, true), target = await bot('R6 switched target '+destination);
  const room = await group(source, 'R6 switched source room '+destination, false);
  const busyMarker = '__fixture_hold_authority__ R6_SWITCH_BUSY_'+destination;
  expect((await api('POST', `/api/bots/${target.id}/messages`, { text: busyMarker })).status).toBe(202);
  const busy = await dump(busyMarker), t = await startRoom(source, room, 'R6_SWITCH_SOURCE_'+destination);
  const marker = '__fixture_hold_authority__ R6_SWITCH_DRAINED_'+destination;
  try {
    const queued = await api('POST', '/api/internal/ask-bot', { fromBotId: source.id, fromThreadId: room.threadId, toBotId: target.id, message: marker }, t.auth);
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body.busy).toBe(true); expect(queued.body.taskId).toBeTruthy();
    const stored = ledger(queued.body.taskId); evidence.push({ switchAdmission: stored, destination });
    expect(stored.request?.target_thread_id).toBeNull();
    expect(JSON.parse(String(stored.request?.execution_audience)).admission).toMatchObject({ toBotId: target.id });
    finish(t.turn);
    await expect.poll(() => ledger(String(stored.request?.parent_id)).request?.state, { timeout: 20000 }).toBe('waiting_bot');
    await expect.poll(() => ledger(queued.body.taskId).queue?.phase, { timeout: 15000 }).toBe('busy');
    expect(ledger(queued.body.taskId).queue?.target_thread_id).toBe(target.threadId);
    const switched = await api('POST', `/api/bots/${target.id}/tasks`, { title: 'R6 '+destination+' destination' });
    expect(switched.status, JSON.stringify(switched.body)).toBe(201);
    const switchedThread = switched.body.task.threadId;
    expect(switchedThread).not.toBe(target.threadId);
    expect((await api('GET', `/api/bots/${target.id}`)).body.bot.threadId).toBe(switchedThread);
    finish(busy);
    const peer = await dump(marker);
    const dispatchedThread = peer.mcpConfig.mcpServers.agents.env.MURAGE_THREAD_ID;
    expect(dispatchedThread).toBe(destination === 'owner' ? switchedThread : target.threadId);
    if (destination !== 'owner') expect(dispatchedThread).not.toBe(switchedThread);
    evidence.push({ switchDispatched: ledger(queued.body.taskId), destination, switchedThread, dispatchedThread });
    finish(peer);
    await expect.poll(() => ledger(queued.body.taskId).request?.state, { timeout: 20000 }).toBe('done');
    await noCards(room.threadId);
  } finally { finish(busy); finish(t.turn); }
}, 90000);


it('H4 direct owner admission drains after source ends, permission lowers and target chat switches', async () => {
  const source = await bot('R7 direct source', true), target = await bot('R7 direct target');
  const busyMarker = '__fixture_hold_authority__ R7_DIRECT_BUSY';
  expect((await api('POST', `/api/bots/${target.id}/messages`, { text: busyMarker })).status).toBe(202);
  const busy = await dump(busyMarker);
  expect((await api('POST', `/api/bots/${source.id}/messages`, { text: '__fixture_hold_authority__ R7_DIRECT_SOURCE' })).status).toBe(202);
  const sourceTurn = await dump('R7_DIRECT_SOURCE');
  const auth = { authorization: 'Bearer '+sourceTurn.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN };
  const marker = '__fixture_hold_authority__ R7_DIRECT_DRAINED';
  try {
    const queued = await api('POST', '/api/internal/ask-bot', { fromBotId: source.id, fromThreadId: source.threadId, toBotId: target.id, message: marker }, auth);
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect(queued.body.busy).toBe(true); expect(queued.body.taskId).toBeTruthy();
    const stored = ledger(queued.body.taskId); evidence.push({ directAdmission: stored });
    expect(stored.request).toBeUndefined(); expect(stored.queue).toBeTruthy();
    finish(sourceTurn);
    await expect.poll(async () => (await api('GET', `/api/bots/${source.id}`)).body.bot.busy, { timeout: 20000 }).toBe(false);
    expect((await api('PATCH', `/api/bots/${source.id}/tasks/${source.threadId}`, { noLimits: false, fullAccess: false, autoApprove: false })).status).toBe(200);
    expect((await api('PATCH', `/api/bots/${source.id}`, { noLimits: false, fullAccess: false, autoApprove: false })).status).toBe(200);
    const switched = await api('POST', `/api/bots/${target.id}/tasks`, { title: 'R7 owner destination' });
    expect(switched.status).toBe(201);
    expect(switched.body.task.threadId).not.toBe(target.threadId);
    finish(busy);
    const peer = await dump(marker);
    expect(peer.mcpConfig.mcpServers.agents.env.MURAGE_THREAD_ID).toBe(switched.body.task.threadId);
    const admitted = JSON.parse(String(stored.queue?.item)).executionAudience.admission;
    expect(admitted).toMatchObject({ kind: 'owner-no-limits-admitted', principal: { personId: 'workspace-owner', bindingId: 'local', revision: 1 }, toBotId: target.id, fromBotId: source.id, sourceThreadId: source.threadId, requestId: queued.body.taskId, level: 'no-limits' });
    expect(admitted.admittedAt).toBeGreaterThan(0);
    evidence.push({ directDispatched: ledger(queued.body.taskId), switchedThread: switched.body.task.threadId });
    finish(peer); await noCards(source.threadId);
  } finally { finish(busy); finish(sourceTurn); }
}, 90000);

it('H4 guest direct ask keeps cross-partition refusal on a No limits bot', async () => {
  const source = await bot('R7 guest direct source', true), target = await bot('R7 guest direct target');
  const task = await api('POST', `/api/bots/${source.id}/tasks`, { title: 'R7 guest source' });
  expect(task.status).toBe(201);
  const threadId = task.body.task.threadId;
  const turn = await dump('R7_GUEST_DIRECT_SOURCE');
  expect(turn.mcpConfig.mcpServers.agents.env.MURAGE_THREAD_ID).toBe(threadId);
  try {
    const out = await api('POST', '/api/internal/ask-bot', { fromBotId: source.id, fromThreadId: threadId, toBotId: target.id, message: '__fixture_hold_authority__ R7_GUEST_FORBIDDEN' }, { authorization: 'Bearer '+turn.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN });
    expect(out.status, JSON.stringify(out.body)).toBe(403);
    expect(findDump('R7_GUEST_FORBIDDEN')).toBeUndefined();
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM pending_delegations WHERE source_thread_id=?').get(threadId)?.n).toBe(0); } finally { db.close(); }
  } finally { finish(turn); }
}, 60000);
