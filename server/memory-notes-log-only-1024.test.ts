// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: q1024-forgetracerace owns these witnesses and the log-only memory notes (FRICTION-1025 F20 + F21); recall-s1s2 owns held
// dispatch; oneindex owns the scope-set read this fixture faults.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { proofWorld } from './session-proof-world.ts';

// F21: a turn whose recall is not ready still answers (held: nothing recalled, no memory mount). Through 1.0.23 the chat then got the
// row "Memory wasn't ready, so this reply didn't use what I remember [or my pinned rules]."; from 1.0.24 that is the dispatch log line
// only. Since ONEINDEX (no built view) the one production cause left is a lost recall view (policy.ts memoryAccess: RecallViewLost),
// so the fixture raises exactly that, at that line, while its flag file exists. Everything after it is the shipped path: readiness
// ends held, the turn is rebuilt held, dispatched, answered and stored.
const lostView = `
  { const fs=await import('node:fs'), path=await import('node:path');
  globalThis.__recallViewLost=()=>fs.existsSync(path.join(process.env.MURAGE_DATA_DIR,'recall-view-lost'));
  (await import('node:module')).registerHooks({load(url,context,next){
    const result=next(url,context);
    if (!url.endsWith('/server/memory/policy.ts')) return result;
    const needle='if(!rosterSeats(claim.botId,claim.threadId,currentRoster))throw new RecallViewLost();';
    const source=String(result.source);
    if (source.split(needle).length!==2) throw new Error('lost view fixture anchor changed');
    return {...result,source:source.replace(needle,'if(globalThis.__recallViewLost?.() || !rosterSeats(claim.botId,claim.threadId,currentRoster))throw new RecallViewLost();')};
  }}); }
`;
type World = Awaited<ReturnType<typeof proofWorld>>;
type Row = { id: string; role: string; kind: string; text?: string; memoryNote?: string; tool?: { name: string } };
const messages = async (world: World, threadId: string): Promise<Row[]> => (await world.api('GET', `/api/threads/${threadId}/messages?limit=100`)).messages;
const replies = (rows: Row[]) => rows.filter(row => row.role === 'bot' && row.kind === 'text' && row.text);
// Every memory line a build through 1.0.23 could write for a held turn: by its mark and by its words.
const memoryRows = (rows: Row[]) => rows.filter(row => row.memoryNote === 'without-memory' || /Memory wasn't ready|left out|remembered context/i.test(row.tool?.name ?? '')).map(row => row.tool?.name);
const pinRule = (world: World) => world.write(db => db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES('fixture-memory',1,?,'constraint','Fixture standing rule','owner-statement','active',1,1,1)")
  .run(String(db.prepare('SELECT id FROM memory_scopes LIMIT 1').get()!.id)));

for (const pinned of [true, false]) it(`MEMNOTE-W1 direct (pinned rule=${pinned}): a held owner turn answers and writes no memory row; the held dispatch is the log line`, async () => {
  const world = await proofWorld('claude', 'none', lostView);
  try {
    if (pinned) pinRule(world);
    const bot = await world.bot();
    await world.turn(bot, 'Full recall first turn.');
    const before = replies(await messages(world, bot.threadId)).length, at = world.log().length;
    writeFileSync(join(world.fixture.info.dataDir, 'recall-view-lost'), '');
    await world.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Owner turn while recall is unavailable.' });
    await expect.poll(async () => replies(await messages(world, bot.threadId)).length, { timeout: 45000 }).toBe(before + 1);
    await expect.poll(async () => (await world.api('GET', '/api/bots?messages=0')).bots.find((row: { id: string }) => row.id === bot.id)?.busy, { timeout: 15000 }).not.toBe(true);
    const rows = await messages(world, bot.threadId);
    expect(memoryRows(rows)).toEqual([]);
    // the turn this row is about really ran held, once, and its reply is in the chat after the owner's line
    expect([...world.log().slice(at).matchAll(/turn dispatch recall=(\w+) thread=(\S+)/g)].map(match => [match[1], match[2]])).toEqual([['held', bot.threadId]]);
    expect(rows.findIndex(row => row.text === 'Owner turn while recall is unavailable.')).toBeLessThan(rows.indexOf(replies(rows).at(-1)!));
  } finally { await world.fixture.close(); }
}, 240000);

const room = async (world: World) => {
  pinRule(world);
  const bot = await world.bot();
  const group = (await world.api('POST', '/api/groups', { name: 'Notes room', memberIds: [bot.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: bot.id } } })).group;
  const thread = String(group.threadId);
  const say = async (text: string, want: number) => {
    await world.api('POST', `/api/groups/${group.id}/messages`, { threadId: thread, text });
    await expect.poll(async () => replies(await messages(world, thread)).length, { timeout: 45000 }).toBe(want);
    await expect.poll(async () => Boolean((await world.api('GET', '/api/bots?messages=0')).groups.find((row: { threadId: string }) => row.threadId === thread)?.busyBotId), { timeout: 30000 }).toBe(false);
    return messages(world, thread);
  };
  return { thread, say };
};

// F20, room: a member's turn whose pinned rule the room fence leaves out (tier 0, no rebuild). Through 1.0.23 every such reply carried
// the row "Murage left remembered details out of this reply."; from 1.0.24 the omission is the fence recovery log line only.
it('MEMNOTE-W2 room: a reply the room fence left a remembered detail out of writes no memory row; the omission is the log line', async () => {
  const world = await proofWorld('claude', 'none', lostView);
  try {
    const { thread, say } = await room(world);
    const at = world.log().length;
    const rows = await say('Room turn with a pinned rule left out.', 1);
    expect(memoryRows(rows)).toEqual([]);
    expect([...world.log().slice(at).matchAll(/\[memory\] fence recovery tier=(\d) thread=(\S+) .*omitted=(\d+)/g)].map(match => [match[1], match[2], match[3]])).toEqual([['0', thread, '1']]);
    expect(rows.findIndex(row => row.text === 'Room turn with a pinned rule left out.')).toBeLessThan(rows.indexOf(replies(rows).at(-1)!));
  } finally { await world.fixture.close(); }
}, 240000);

it('MEMNOTE-W3 room: a held owner turn in a room answers and writes no memory row; the held dispatch is the log line', async () => {
  const world = await proofWorld('claude', 'none', lostView);
  try {
    const { thread, say } = await room(world);
    const before = new Set((await say('Room turn with recall.', 1)).map(row => row.id));
    const at = world.log().length;
    writeFileSync(join(world.fixture.info.dataDir, 'recall-view-lost'), '');
    const rows = await say('Room turn while recall is unavailable.', 2);
    expect(memoryRows(rows.filter(row => !before.has(row.id)))).toEqual([]);
    expect([...world.log().slice(at).matchAll(/turn dispatch recall=(\w+) thread=(\S+)/g)].map(match => [match[1], match[2]])).toEqual([['held', thread]]);
    expect(rows.findIndex(row => row.text === 'Room turn while recall is unavailable.')).toBeLessThan(rows.indexOf(replies(rows).at(-1)!));
  } finally { await world.fixture.close(); }
}, 240000);
