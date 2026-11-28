// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: ownerfb-1020 owns the owner fallback; recall-s1s2 owns held dispatch; the driver lanes own the native tool relay.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runControlMurage } from '../scripts/control-murage.ts';
import { proofWorld } from './session-proof-world.ts';

// MAIN 10:22Z (a): one quiet memory line per reply, never repeated while the cause is unchanged.
const HISTORY_NOTICE = 'Some earlier messages in this conversation were left out.';
const LEFT_OUT = 'Murage left remembered details out of this reply.';
const QUOTA = 536870912, BRIM = 536870484;
const RULE = 'Fixture standing rule';
const tools = `
  process.env.FAKE_CUSTOM_TOOL_SERVER='agents';
  process.env.FAKE_CUSTOM_TOOL_FAIL_TURN='1';
  process.env.FAKE_CUSTOM_TOOL_LOG=(await import('node:path')).join(process.env.MURAGE_DATA_DIR,'native-tools.jsonl');
`;
type World = Awaited<ReturnType<typeof proofWorld>>;
type Bot = Awaited<ReturnType<World['bot']>>;
const viewRows = (world: World, threadId: string) => world.read(db =>
  Number(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts WHERE context_key LIKE ?').get(`%${threadId}%`)!.n));
// Every memory line Murage wrote in the thread: the held line, fence notes and pin notes.
const memoryLines = (rows: Array<{ role: string; kind: string; memoryNote?: string; tool?: { name: string } }>) => rows.filter(row => row.role === 'bot' && row.kind === 'activity'
  && (row.memoryNote === 'without-memory' || /pin|remember|memory/i.test(row.tool?.name ?? ''))).map(row => row.tool?.name);
const messages = async (world: World, threadId: string): Promise<Array<{ id: string; role: string; kind: string; text?: string; memoryNote?: string; tool?: { name: string } }>> =>
  (await world.api('GET', `/api/threads/${threadId}/messages?limit=100`)).messages;

function fillRecall(world: World, pinned: boolean, detachViewFrom?: string) {
  world.write(db => {
    const scope = String(db.prepare('SELECT id FROM memory_scopes LIMIT 1').get()!.id);
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES('fixture-memory',1,?,'constraint',?,'owner-statement','active',?,1,1)")
      .run(scope, RULE, Number(pinned));
    // Keep the allocated view so collection cannot free space for the next demand.
    if (detachViewFrom) db.prepare("UPDATE memory_recall_contexts SET context_key=replace(context_key,?,'fixture-detached-thread') WHERE context_key LIKE ?")
      .run(detachViewFrom, `%${detachViewFrom}%`);
    db.prepare('UPDATE memory_recall_storage SET bytes=? WHERE id=1').run(BRIM);
  });
}

function toolReceipts(world: World, text: string): Array<{ prompt: string; text: string; tool: string; isError: boolean; server: string }> {
  const file = join(world.fixture.info.dataDir, 'native-tools.jsonl');
  return (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.prompt.includes(text));
}

async function heldReply(world: World, bot: Bot, text: string) {
  const replies = async () => (await messages(world, bot.threadId)).filter(row => row.role === 'bot' && row.kind === 'text' && row.text);
  const before = (await replies()).length;
  const start = world.log().length;
  // Only this turn's receipts: a later turn's prompt may carry earlier owner texts.
  const priorCalls = toolReceipts(world, '').length;
  expect(viewRows(world, bot.threadId)).toBe(0);
  await world.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  await expect.poll(async () => (await world.api('GET', '/api/bots?messages=0')).bots.find((row: { id: string }) => row.id === bot.id)?.busy, { timeout: 45000 }).not.toBe(true);
  await expect.poll(async () => (await replies()).length, { timeout: 45000 }).toBeGreaterThan(before);
  const log = world.log().slice(start);
  expect([...log.matchAll(/turn dispatch recall=(\w+) thread=/g)].map(match => match[1])).toEqual(['held']);
  expect(log).toMatch(/phase=mounts.done .* integrations=1/);
  expect(log).not.toContain('re-preparing (');
  expect(log).not.toContain('mount-relay-sealed');
  expect(log).not.toContain('cause=consuming-http-denied');
  const calls = toolReceipts(world, '').slice(priorCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain(text);
  expect(calls[0]).toMatchObject({ server: 'agents', tool: 'murage_help', isError: false });
  // cause22 group A: the engine is handed the tool's whole answer, never a shortened or summarised one (the help text is over 8,192 characters).
  expect(() => JSON.parse(calls[0]!.text), 'the tool result reaches the engine whole').not.toThrow();
  expect(JSON.parse(calls[0]!.text).topics.length).toBeGreaterThan(0);
  expect((await replies()).at(-1)?.text).toContain(`custom tool said: ${calls[0]!.text}`);
  expect(calls[0]!.prompt).not.toContain(RULE);
  expect(viewRows(world, bot.threadId)).toBe(0);
  expect(world.read(db => Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes))).toBeLessThanOrEqual(QUOTA);
  return { log, rows: await messages(world, bot.threadId), prompt: calls[0]!.prompt };
}

for (const engine of ['claude', 'acp', 'fuigo'] as const) {
  it(`OWNERFB-W1 ${engine}: a verified owner answers through agents with recall held and pinned rules omitted`, async () => {
    const world = await proofWorld(engine, 'none', tools);
    try {
      await world.turn(await world.bot(), 'Full recall first turn.');
      fillRecall(world, true);
      const bot = await world.bot();
      const { rows } = await heldReply(world, bot, 'Owner turn while recall is unavailable.');
      // FRICTION F21 (1.0.24): the held reply shows and no memory line is written to the chat
      expect(memoryLines(rows)).toEqual([]);
      if (engine === 'fuigo') {
        const session = world.rpc().filter(row => row.method === 'session/new').at(-1);
        expect(session?.params?._meta?.['fuigo/permissionPolicySha256']).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally { await world.fixture.close(); }
  }, 240000);
}

it('OWNERFB-WLIVE: a viewless owner with checking recent files receives the tool result and an accurate notice', async () => {
  const world = await proofWorld('claude', 'none', tools);
  try {
    const first = await world.bot();
    await world.turn(first, 'Owner positive control with a view.');
    expect(viewRows(world, first.threadId)).toBeGreaterThan(0);
    expect(toolReceipts(world, 'Owner positive control with a view.')).toEqual([expect.objectContaining({ tool: 'murage_help', isError: false })]);
    fillRecall(world, false);
    const { task } = await world.api('POST', `/api/bots/${first.id}/tasks`, { title: 'Viewless fixture' });
    const bot = { id: first.id, threadId: task.threadId };
    expect(world.read(db => db.prepare("SELECT count(*) AS n FROM memory_records WHERE owner_pinned=1 AND state='active'").get()!.n)).toBe(0);
    world.write(db => {
      db.prepare("INSERT INTO memory_deny_pending_scope VALUES('fixture-other-scope',1,100)").run();
      const addFile = db.prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,'document','text/markdown',1,?,'md',1,?,?,'fixture','fixture',?,'fixture')");
      for (let index = 0; index < 50; index++) {
        const file = `checking-fixture-${index}.md`;
        addFile.run(file, file, '0'.repeat(64), bot.id, first.threadId, file);
      }
    });
    const { log, rows, prompt } = await heldReply(world, bot, 'Owner turn while recent files are checking.');
    expect(log).toContain(`fence recovery tier=0 thread=${bot.threadId} refused=none parts=0 omitted=50 cause=checking`);
    expect(prompt).not.toContain('checking-fixture-');
    // OWNERFB-W5 (FRICTION F20/F21, 1.0.24): held with 50 fence-omitted files writes no line; the recovery is the log line above.
    expect(memoryLines(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(HISTORY_NOTICE);
    expect(JSON.stringify(rows)).not.toContain(LEFT_OUT);
  } finally { await world.fixture.close(); }
}, 240000);

it('OWNERFB-WHISTORY: the held owner turn with a withheld prior message still writes its one line', async () => {
  const world = await proofWorld('claude', 'none', tools);
  try {
    const bot = await world.bot();
    await world.turn(bot, 'Full recall first turn.');
    const priorReply = (await messages(world, bot.threadId)).find(row => row.role === 'bot' && row.kind === 'text' && row.text?.startsWith('custom tool said:'));
    expect(priorReply?.text).toBeTruthy();
    fillRecall(world, true, bot.threadId);
    world.write(db => {
      db.prepare("INSERT INTO memory_tombstones VALUES('fixture-forgotten-source','source',?,1,NULL,1,'owner-forget',1)")
        .run(`message:${bot.threadId}:${priorReply!.id}`);
    });
    const { rows, prompt } = await heldReply(world, bot, 'Owner turn after a prior reply was forgotten.');
    expect(prompt).not.toContain(priorReply!.text);
    expect(memoryLines(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(HISTORY_NOTICE);
  } finally { await world.fixture.close(); }
}, 240000);

it('OWNERFB-W4: consecutive held owner turns write one line until a turn runs with recall', async () => {
  const world = await proofWorld('claude', 'none', tools);
  try {
    const bot = await world.bot();
    await world.turn(bot, 'Full recall first turn.');
    fillRecall(world, true, bot.threadId);
    for (const n of [1, 2, 3]) {
      const { rows } = await heldReply(world, bot, `Held owner turn ${n}.`);
      expect(memoryLines(rows), `after held turn ${n}`).toEqual([]);
    }
    // The cause clears: storage is free again and the next turn runs with recall.
    world.write(db => db.prepare('UPDATE memory_recall_storage SET bytes=0 WHERE id=1').run());
    const at = world.log().length;
    await world.acceptedTurn(bot, 'Owner turn with recall again.');
    expect([...world.log().slice(at).matchAll(/turn dispatch recall=(\w+) thread=/g)].map(match => match[1])).not.toContain('held');
    expect(viewRows(world, bot.threadId)).toBeGreaterThan(0);
    expect(memoryLines(await messages(world, bot.threadId))).toEqual([]);
    // The cause returns: one new line, then quiet again.
    world.write(db => {
      db.prepare("UPDATE memory_recall_contexts SET context_key=replace(context_key,?,'fixture-detached-again') WHERE context_key LIKE ?").run(bot.threadId, `%${bot.threadId}%`);
      db.prepare('UPDATE memory_recall_storage SET bytes=? WHERE id=1').run(BRIM);
    });
    await heldReply(world, bot, 'Held owner turn after recall.');
    const { rows } = await heldReply(world, bot, 'Held owner turn after recall, again.');
    expect(memoryLines(rows)).toEqual([]);
  } finally { await world.fixture.close(); }
}, 480000);

// One fence omission for "Fence fixture turn" messages only: the owed note, its write and the latch run as shipped.
const fenceFixture = `
  (await import('node:module')).registerHooks({load(url,context,next){
    const result=next(url,context);
    if (!url.endsWith('/server/index.ts')) return result;
    const needle='renderedWithheld.size + pendingWithheld.size + selectiveOmitted';
    const source=String(result.source);
    if (source.split(needle).length!==2) throw new Error('fence fixture anchor changed');
    return {...result,source:source.replace(needle,needle+' + (String(userMessage.text ?? "").includes("Fence fixture turn") ? 1 : 0)')};
  }});
`;
it('OWNERFB-W6: consecutive turns with recall that owe the same fence note write the left-out line once', async () => {
  const world = await proofWorld('claude', 'none', tools + fenceFixture);
  try {
    const bot = await world.bot();
    await world.turn(bot, 'Full recall first turn.');
    expect(memoryLines(await messages(world, bot.threadId))).toEqual([]);
    const turn = async (text: string, owes: boolean) => {
      const at = world.log().length;
      await world.acceptedTurn(bot, text);
      const log = world.log().slice(at);
      expect([...log.matchAll(/turn dispatch recall=(\w+) thread=/g)].map(match => match[1])).not.toContain('held');
      expect(new RegExp(`fence recovery tier=0 thread=${bot.threadId} `).test(log), `${text} owes the note`).toBe(owes);
      return memoryLines(await messages(world, bot.threadId));
    };
    // FRICTION F20 (1.0.24): the omission is the log line the turn helper asserts; the chat gets no left-out row
    for (const n of [1, 2, 3]) expect(await turn(`Fence fixture turn ${n}.`, true), `after turn ${n}`).toEqual([]);
    // A reply that runs with recall and owes nothing ends the run; the same cause then writes one new line.
    expect(await turn('Plain owner turn.', false)).toEqual([]);
    expect(await turn('Fence fixture turn 4.', true)).toEqual([]);
  } finally { await world.fixture.close(); }
}, 480000);

// "Redispatch fixture turn" attempts 0 and 1 are refused at the send check before their note is written (the shipped
// MEMORY_CONTEXT_REVOKED path); attempt 2 sends. Claim, rebuild tiers and note writes run as shipped.
const redispatchFixture = `
  (await import('node:module')).registerHooks({load(url,context,next){
    const result=next(url,context);
    if (!url.endsWith('/server/index.ts')) return result;
    const needle='refreshPreparedReplayProof(replayProof);';
    const source=String(result.source);
    if (source.split(needle).length!==2) throw new Error('redispatch fixture anchor changed');
    return {...result,source:source.replace(needle,'if (String(userMessage.text ?? "").includes("Redispatch fixture turn") && (opts?.memoryRedispatch ?? 0) < 2) throw new Error("fixture refusal"); '+needle)};
  }});
`;
it('OWNERFB-W7: a reply whose earlier attempts claimed but never wrote their note still gets its one line', async () => {
  const world = await proofWorld('claude', 'none', tools + fenceFixture + redispatchFixture);
  try {
    const bot = await world.bot();
    await world.turn(bot, 'Full recall first turn.');
    expect(memoryLines(await messages(world, bot.threadId))).toEqual([]);
    // Not acceptedTurn: the tier-2 attempt is the message-only dispatch, which logs that it starts without recalled memory.
    const replies = async () => (await messages(world, bot.threadId)).filter(row => row.role === 'bot' && row.kind === 'text' && row.text).length;
    const before = await replies(), at = world.log().length;
    await world.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Fence fixture turn. Redispatch fixture turn.' });
    await expect.poll(replies, { timeout: 45000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await world.api('GET', '/api/bots?messages=0')).bots.find((row: { id: string }) => row.id === bot.id)?.busy, { timeout: 15000 }).not.toBe(true);
    const log = world.log().slice(at);
    expect([...log.matchAll(new RegExp(`fence recovery tier=(\\d) thread=${bot.threadId} `, 'g'))].map(match => match[1])).toEqual(['0', '1', '2']);
    // FRICTION F20 (1.0.24): all three tiers logged above, and none of them wrote a row
    expect(memoryLines(await messages(world, bot.threadId))).toEqual([]);
  } finally { await world.fixture.close(); }
}, 240000);

it('OWNERFB-W3: a non-owner channel turn on the brim-full store receives its refusal without dispatch', async () => {
  const world = await proofWorld('claude', 'none', tools);
  try {
    await world.turn(await world.bot(), 'Full recall first turn.');
    fillRecall(world, true);
    const bot = await world.bot();
    const run = (args: string[]) => runControlMurage([...args, '--url', world.fixture.info.url], { env: { MURAGE_DATA_DIR: world.fixture.info.dataDir } });
    const { channel } = await run(['new-channel', '--name', 'Fixture room', '--members', bot.id]) as { channel: { id: string } };
    const at = world.log().length;
    const text = 'Non-owner channel turn while recall is unavailable.';
    await run(['send-channel', '--channel', channel.id, '--text', text]);
    await run(['wait', '--channel', channel.id, '--timeout', '20']);
    const rows = JSON.stringify(await run(['messages', '--channel', channel.id, '--limit', '30']));
    expect(rows).toContain("Murage couldn't start this reply. Send it again.");
    expect(rows).not.toContain('pinned memory');
    expect(rows).not.toContain('still catching up');
    expect(world.log().slice(at)).not.toContain('turn dispatch recall=');
    expect(toolReceipts(world, text)).toHaveLength(0);
  } finally { await world.fixture.close(); }
}, 240000);
