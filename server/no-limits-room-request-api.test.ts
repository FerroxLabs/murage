// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { fixtureDisplayApi } from './testing/display-fixture.ts';

let fixture: VerificationServer, desktop: Record<string, string>;
const evidence: unknown[] = [];
const evidenceDir = process.env.W1MED_ROOM_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'room-workflow-evidence-'));
const instrumentation = `
const fs=await import('node:fs'),path=await import('node:path');
const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');
const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
cfg.instances.verification.environment={FAKE_CLAUDE_PERM_INPUT_FILE:path.join(process.env.MURAGE_DATA_DIR,'permission-input.json')};
fs.writeFileSync(file,JSON.stringify(cfg));
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 let source=fs.readFileSync(new URL(url),'utf8');
 source="import {bindHumanThread as fixtureBind,observeVerifiedHuman as fixtureObserve,linkHumanBinding as fixtureLink,resolveHumanBinding as fixtureResolve} from './human-principals.ts';import {ownerMemoryTicket as fixtureTicket} from './memory/authority.ts';\\n"+source;
 const anchor='let group = store.createGroup(name, memberIds.filter(id => !stagedMembers.includes(id)), false, section, setup);';
 if(!source.includes(anchor))throw Error('room principal fixture anchor missing');
 source=source.replace(anchor,anchor+\`
 if(name==='F4 another person'){
  const id=fixtureObserve({platform:'telegram',authorityId:'w1med-fixture',userId:group.id,connectionId:'w1med-fixture'});
  fixtureLink(fixtureTicket(),{bindingId:id,expectedRevision:1,as:'person'});
  fixtureBind(group.threadId,fixtureResolve(id));
  // Model a verified channel delivery from that linked person. The desktop
  // send route correctly refuses impersonation, so this fixture uses the
  // same durable queued-member dispatch a channel delivery reaches.
  const gate=join(DATA_DIR,'person-room-go-'+group.id);
  const timer=setInterval(()=>{
   if(!existsSync(gate))return;
   clearInterval(timer);
   store.appendMessage(group.threadId,{role:'user',kind:'text',text:'__fixture_permission_tool__ F4 another person',origin:'unproven'});
   queueRoomMemberTurn(group,group.threadId,store.bot(memberIds[0]),{admit:false,reason:'bot_thread_ceiling',retry:'queue',line:'fixture admission wait'},0);
   roomDispatcher.tick();
  },10);timer.unref();
 }
 \`);
 const queueAnchor='  if (!orchestration && !pendingRoomTurnRequests.has(roomRequestKey) && !roomTurnRequests.has(roomRequestKey)) {';
 if(!source.includes(queueAnchor))throw Error('room admission fixture anchor missing');
 source=source.replace(queueAnchor,queueAnchor+\`
    if(group.name==='F4 owner'){
      queueRoomMemberTurn(group,threadId,bot,{admit:false,reason:'bot_thread_ceiling',retry:'queue',line:'fixture admission wait'},hop);
      leaveRound();
      setTimeout(()=>roomDispatcher.tick(),0);
      return true;
    }
 \`);
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
async function rawApi(method: string, path: string, body?: unknown, proven = true) {
  const response = await fetch(fixture.info.url + path, { method, signal: AbortSignal.timeout(40000),
    headers: { ...(proven ? desktop : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const out = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, proven, ...out });
  return out;
}
// Fixture repair under MAIN c3-decision INT-CONFLICT-DEFAULT: preserve
// original principal and workflow assertions through observed public handles.
const api=fixtureDisplayApi(()=>join(fixture.info.dataDir,'messages.db'),rawApi);
const messages = async (thread: string) => (await api('GET', `/api/threads/${thread}/messages?limit=200`)).body.messages as any[];
const openCard = (rows: any[]) => rows.find(m => m.kind === 'options' && m.card?.requestId && m.card.answered === undefined);
async function makeRoom(name: string) {
  const instances = await api('GET', '/api/instances');
  const model = instances.body.instances.find((i: any) => i.instanceId === 'verification').models.options[0].id;
  const made = await api('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  expect((await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' })).status).toBe(200);
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const room = await api('POST', '/api/groups', { name, memberIds: [bot.id],
    setup: { bulletin: '', defaultResponder: { kind: 'member', botId: bot.id } }, channelProject: { goal: 'Verify room permissions with a fake engine' } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  return room.body.group;
}
async function send(room: any, command: string, proven = true) {
  writeFileSync(join(fixture.info.dataDir, 'permission-input.json'), JSON.stringify({ command }));
  if (room.name === 'F4 another person') {
    writeFileSync(join(fixture.info.dataDir, 'person-room-go-' + room.id), 'go');
    evidence.push({ channelDispatch: 'verified linked person', groupId: room.id });
  } else {
    expect((await api('POST', `/api/groups/${room.id}/messages`, { text: '__fixture_permission_tool__ F4 room request' }, proven)).status).toBe(202);
  }
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation, dumpLog: true });
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret', undefined, false)).body.secret };
}, 120000);
afterAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  if (fixture) writeFileSync(join(evidenceDir, 'server.log'), readFileSync(fixture.info.logPath));
  writeFileSync(join(evidenceDir, 'workflow.json'), JSON.stringify({ fixture: fixture?.info, evidence },
    (key, value) => /token|secret|credential|authorization/i.test(key) ? '[redacted]' : value, 2));
  await fixture?.close();
});
it('keeps room workflow evidence outside the repository', () => {
  const path = relative(process.cwd(), evidenceDir);
  expect(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)).toBe(true);
});
it('F4 authenticated owner room request runs at No limits; wipe still asks', async () => {
  const room = await makeRoom('F4 owner');
  await send(room, 'touch /fixture/room-note');
  await expect.poll(async () => (await messages(room.threadId)).some(m => m.text?.includes('permission: allowed')), { timeout: 30000 }).toBe(true);
  expect(openCard(await messages(room.threadId))).toBeUndefined();
  const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, origin, from_kind, source_message_id FROM room_requests WHERE group_id=? AND verb='room_turn'").all(room.id);
    evidence.push({ ownerRoomRequests: rows });
    expect(rows.some(row => row.origin === 'desktop' && row.from_kind === 'owner' && typeof row.source_message_id === 'string')).toBe(true);
  } finally { db.close(); }
  // Wait for the first member request to release the room before the next send.
  await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).body.groups.find((g: any) => g.id === room.id)?.busyBotId ?? null, { timeout: 20000 }).toBeNull();
  await send(room, 'rm -rf ~');
  await expect.poll(async () => Boolean(openCard(await messages(room.threadId))), { timeout: 30000 }).toBe(true);
  const card = openCard(await messages(room.threadId));
  expect((await api('POST', `/api/threads/${room.threadId}/respond`, { requestId: card.card.requestId, behavior: 'deny' })).status).toBe(200);
});
it.each([['another person', true], ['guest', false]] as const)('F4 %s room turn stays Ask on a No limits bot', async (person, proven) => {
  const room = await makeRoom('F4 ' + person);
  await send(room, 'touch /fixture/room-note', proven);
  await expect.poll(async () => Boolean(openCard(await messages(room.threadId))), { timeout: 30000 }).toBe(true);
  const rows = await messages(room.threadId), card = openCard(rows);
  expect(rows.some(m => m.text?.includes('permission: allowed'))).toBe(false);
  expect((await api('POST', `/api/threads/${room.threadId}/respond`, { requestId: card.card.requestId, behavior: 'deny' })).status).toBe(200);
});
