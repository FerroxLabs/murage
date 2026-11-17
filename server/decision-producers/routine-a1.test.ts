import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture, d } from '../decision/fixture.ts';
import type { QueueRecoverySource, SynchronousQueueDelivery, PendingQueueApproval } from '../decision/types.ts';
import { RoutineManager, type RoutineRequestReceipt } from '../routines.ts';
import { RoutineRequestService } from '../routine-requests.ts';
import { DATA_DIR } from '../config.ts';
import { CARD_TERMINAL_FIELDS } from '../../shared/permission-card.ts';
import { measureReads } from '../testing/bounded-reads.ts';
import { transaction } from '../database.ts';
import { initializeApprovals } from '../decision/records.ts';
import { readRoutineRequestReceipts } from '../routine-runs-journal.ts';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });
const busy = 'Your earlier changes are still being confirmed. Try again in a moment.';
const proposal = { action: 'create', routine: { name: 'Fixture', instructions: 'Fixture task', schedule: { type: 'weekly', time: '09:00', weekdays: ['monday'] } } };
function setup() {
  const f = fixture('ask'); disposers.push(f.dispose);
  const file = join(DATA_DIR, 'a1-routines.json');
  const clock = { now: Date.now() };
  const makeRoutines = () => new RoutineManager({ file, now: () => clock.now, botState: () => 'busy', createTask: () => null, startTurn: async () => {} });
  let routines = makeRoutines();
  const visits: string[] = [];
  const makeService = () => new RoutineRequestService({ turnOutsideRead: () => null, store: f.store, routines, now: () => clock.now, onVisit: (source, id) => visits.push(`${source}:${id}`) });
  let service = makeService();
  const bind = () => {
    const q = service.approvalQueue();
    const source: QueueRecoverySource = {
      kind: q.kind, pendingApprovals: () => q.pendingApprovals(),
      reopen: (item: PendingQueueApproval) => item.kind === 'routine' && item.proof === 'trusted'
        ? { kind: 'service', service: 'routine', claim: f.claim, call: item.call } : undefined,
      base: q.base,
      respond: (item, answer, options) => q.respond(item, answer, options),
      cancel: (item, reason) => q.cancel(item, reason), renew: (item, identity) => q.renew(item, identity),
    };
    const sync: SynchronousQueueDelivery = { kind: q.kind, respondNow: (item, answer, options) => q.respondNow(item, answer, options) };
    const undoSources = d.installQueueSources([source]), undoSync = d.installSynchronousQueueDeliveries([sync]);
    const dispose = () => { undoSync(); undoSources(); }; disposers.push(dispose); return dispose;
  };
  let unbind = bind();
  let proposalNumber = 0;
  const propose = async (proof = 'trusted') => {
    const p = await service.propose({ botId: 'b', threadId: 't', authority: { claim: f.claim, proof }, proposal: { ...proposal, routine: { ...proposal.routine, instructions: `Fixture task ${proposalNumber++}` } } });
    if (!p.applied) {
      const record = d.lookupApproval('t', p.messageId)!;
      expect(record.state).toBe('open'); expect(record.queue?.kind).toBe('routine');
    }
    return p;
  };
  // MAIN RULING INT-CONFLICT-DEFAULT c0261fd8c6: observe the durable receipt journal.
  // Observe the real durable receipts after every Allow. Reconstructing all
  // routine definitions and run history here made this cap test a disk/CPU
  // throughput test as its 400 unrelated definitions accumulated.
  const disk = () => readRoutineRequestReceipts(file) as unknown as RoutineRequestReceipt[];
  const seed = (n = 256) => {
    const receipts = Array.from({ length: n }, (_, i): RoutineRequestReceipt => ({ requestId: `seed-${i}`, messageId: `seed-message-${i}`, botId: 'b', threadId: 'seed-thread', action: 'pause', fingerprintVersion: 1, fingerprint: 'a'.repeat(64), resultId: `r-${i}`, appliedAt: clock.now, appliedUpdatedAt: clock.now, before: { enabled: true } as any }));
    writeFileSync(file, JSON.stringify({ version: 1, routines: [], routineRequestReceipts: receipts.reverse() }));
    routines = makeRoutines(); unbind(); service = makeService(); unbind = bind();
    // Real records from the installed decision engine, cloned for the bounded seed.
    const columns = f.db.prepare('PRAGMA table_info(approval_records)').all().map((r: any) => r.name as string);
    return { receipts, columns };
  };
  return { f, file, clock, visits, propose, disk, seed, get service() { return service; }, get routines() { return routines; },
    restart: () => { unbind(); routines = makeRoutines(); service = makeService(); unbind = bind(); } };
}
function seedProtected(f: ReturnType<typeof setup>, n = 256) {
  // A genuine template keeps the S1 storage contract in the fixture.
  const template = f.f.db.prepare('SELECT * FROM approval_records LIMIT 1').get() as any;
  const { receipts, columns } = f.seed(n);
  const insert = f.f.db.prepare(`INSERT INTO approval_records(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
  transaction(() => { for (const r of receipts) {
    const row = { ...template, id: r.requestId, request_key: r.requestId, request_id: r.requestId, thread_id: r.threadId, chat_message_id: r.messageId, state: 'answered', delivery: 'pending', queue_ref: r.requestId };
    insert.run(...columns.map(c => row[c]));
  } });
  f.service.reconcileAtStartup(); f.visits.length = 0;
}

function appendHistory(f: ReturnType<typeof setup>, count: number, prefix: string) {
  const insert = f.f.db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)');
  transaction(() => {
    for (let i = 0; i < count; i++) {
      const row = { id: `${prefix}-${i}`, at: f.clock.now, role: 'bot', kind: 'text', text: 'fixture' };
      insert.run('t', row.id, row.at, row.role, row.kind, JSON.stringify(row));
    }
  });
}

it.each(['async', 'sync'] as const)('T1a %s Allow stamps numeric execution time without changing the protected action', async path => {
  const f = setup(), p = await f.propose(), record = d.lookupApproval('t', p.messageId)!;
  if (path === 'async') await d.answerApproval(record.ref, { behavior: 'allow' });
  else expect(d.answerApprovalSync(record.ref, { behavior: 'allow' }).state).toBe('accepted');
  expect(d.readApproval(record.ref.approvalId)?.delivery).toBe('accepted');
  const card = f.f.store.messageById('t', p.messageId)!.card!, receipt = f.routines.routineRequestReceipt(p.requestId)!;
  // MAIN RULING INT-CONFLICT-DEFAULT 28229c65af 8bfe905cabf: service receipts use canonical allow; execution and immutable-action checks stay.
  expect(card.answered).toBe('allow'); expect(typeof card.answeredAt).toBe('number'); expect(typeof receipt.appliedAt).toBe('number');
  expect(card.answeredAt).toBe(receipt.appliedAt);
  expect(card.routineRequest).not.toHaveProperty('appliedAt'); expect(card.routineRequest).not.toHaveProperty('resultId');
  const paths = CARD_TERMINAL_FIELDS.map(k => `'$.${k}'`).join(',');
  expect(f.f.db.prepare(`SELECT R.presented_action IS json_remove(json_extract(M.json,'$.card'),${paths}) AS same FROM approval_records R JOIN messages M ON M.thread_id=R.thread_id AND M.id=R.chat_message_id WHERE R.id=?`).get(record.ref.approvalId)!.same).toBe(1);
});
it('T1b repeated Allow and replay execute once; T1c Undo restores absence', async () => {
  const f = setup(), p = await f.propose();
  expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'allow' }).state).toBe('applied');
  expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'allow' }).state).toBe('already_settled');
  expect(f.disk()).toHaveLength(1);
  expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'undo' }).state).toBe('undone');
  expect(f.f.store.messageById('t', p.messageId)!.card!.answered).toBe('undone');
});
it('T1d recovery uses the explicit bound adapter; unverifiable proofs are cancelled', async () => {
  const f = setup(), p = await f.propose();
  f.restart(); await d.recover();
  expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'allow' }).state).toBe('applied');
  const other = await f.propose('untrusted');
  const queue = f.service.approvalQueue();
  const cancel = vi.spyOn(queue, 'cancel'); await d.recover();
  expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ ref: other.requestId }), 'unverifiable');
});
it('T1e failed apply never stamps a successful execution time', async () => {
  const f = setup(), p = await f.propose();
  vi.spyOn(f.routines, 'create').mockImplementation(() => { throw new Error('fixture apply failure'); });
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
  expect(f.f.store.messageById('t', p.messageId)!.card!.answeredAt).toBeUndefined();
  expect(d.lookupApproval('t', p.messageId)?.delivery).toBe('failed');
});
it('T1f No limits executes directly', async () => {
  const f = setup(); f.f.setLevel('unlimited'); expect((await f.propose()).applied).toBe(true);
});

it.each(['accepted', 'pending', 'async', 'direct'] as const)('T2k cap admission %s', async mode => {
  const f = setup(); await f.propose(); seedProtected(f);
  if (mode === 'accepted') f.f.db.prepare("UPDATE approval_records SET delivery='accepted' WHERE thread_id='seed-thread'").run();
  if (mode === 'direct') f.f.setLevel('unlimited');
  const before = readFileSync(f.file, 'utf8');
  const commit = vi.spyOn(f.routines as any, 'commitMutation');
  if (mode === 'direct') {
    await expect(f.propose()).rejects.toMatchObject({ status: 409, message: busy });
  } else {
    const p = await f.propose();
    if (mode === 'async') {
      await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
      expect(d.lookupApproval('t', p.messageId)?.delivery).toBe('failed');
      expect(f.f.store.messagesFor('t').some(m => m.text?.includes('Nothing was confirmed.'))).toBe(true);
    } else {
      const result = f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'allow' });
      if (mode === 'accepted') {
        expect(result.state).toBe('applied'); expect((f.service as any).byId.size).toBe(256); expect(f.disk()).toHaveLength(256);
        expect(f.disk().some(r => r.requestId === 'seed-0')).toBe(false); expect(f.visits).toEqual(['admit:seed-0']); return;
      }
      expect(result).toMatchObject({ state: 'invalid', status: 409, error: busy });
      expect(d.lookupApproval('t', p.messageId)?.state).toBe('open'); expect(f.f.store.messageById('t', p.messageId)!.card!.answered).toBeUndefined();
      expect(f.visits.filter(v => v.startsWith('admit:'))).toHaveLength(256);
    }
  }
  expect(readFileSync(f.file, 'utf8')).toBe(before); expect(commit).not.toHaveBeenCalled(); expect((f.service as any).byId.size).toBe(256);
});

it.each([true, false])('T2l buried terminal card heals by id and supports Undo, loaded=%s', async loaded => {
  const f = setup(), p = await f.propose();
  const real = f.f.store.patchMessage.bind(f.f.store);
  const patch = vi.spyOn(f.f.store, 'patchMessage');
  // MAIN RULING INT-CONFLICT-DEFAULT 8bfe905cab / 6e2c2b41763: terminal display uses patchMessagePoint.
  // Inject at the execution stamp itself, after the unchanged real terminal write.
  patch.mockImplementation((...args) => {
    if (args[2].card && 'answeredAt' in args[2].card) throw new Error('fixture stamp failure');
    return real(...args);
  });
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' }); patch.mockRestore();
  expect(d.lookupApproval('t', p.messageId)?.delivery).toBe('accepted');
  expect(f.f.store.messageById('t', p.messageId)!.card!.answeredAt).toBeUndefined();
  appendHistory(f, 5100, 'later');
  (f.f.store as any).threads.delete('t');
  if (loaded) f.f.store.messagesFor('t');
  f.restart();
  const card = vi.spyOn(f.f.store, 'cardForRequest'), all = vi.spyOn(f.f.store, 'messagesFor'), byId = vi.spyOn(f.f.store, 'messageById');
  f.service.reconcileAtStartup();
  expect(card).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled(); expect(byId).toHaveBeenCalledTimes(1);
  expect(f.f.store.messageById('t', p.messageId)!.card!.answeredAt).toBe(f.disk()[0]!.appliedAt);
  expect((f.service as any).receiptQueues.undoQ.length).toBe(1);
  expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'undo' }).state).toBe('undone');
});

it('H2 cold loaded 20000-row reconcile performs zero message walks and exactly one primary-key read', async () => {
  const f = setup(), p = await f.propose();
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
  appendHistory(f, 20000, 'cold');
  (f.f.store as any).threads.delete('t'); const rows = f.f.store.messagesFor('t');
  let walks = 0;
  const tracked = new Proxy(rows, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) walks++; return Reflect.get(target, key, receiver); } });
  (f.f.store as any).threads.get('t').messages = tracked;
  f.restart();
  const { reads } = await measureReads('t', join(DATA_DIR, 'messages.db'), () => f.service.reconcileAtStartup());
  expect(walks).toBe(0);
  const keyed = Object.entries(reads.bySql).filter(([sql]) => /SELECT .* FROM messages WHERE thread_id = \? AND id = \?/.test(sql));
  expect(keyed.reduce((sum, [, read]) => sum + read.statements, 0)).toBe(1);
  console.info('H2 cold', JSON.stringify({ walks, keyed }));
});

it('T2b 400 Allows without a tick stay at cap on disk and in memory; each later admission visits one parked receipt', async () => {
  const f = setup();
  for (let i = 0; i < 400; i++) {
    const p = await f.propose(); f.visits.length = 0;
    expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'allow' }).state).toBe('applied');
    expect((f.service as any).byId.size).toBeLessThanOrEqual(256); expect(f.disk().length).toBeLessThanOrEqual(256);
    expect(f.visits.filter(v => v.startsWith('admit:'))).toHaveLength(i < 256 ? 0 : 1);
  }
});
const counters: object[] = [];
it.each([[100, 300], [20000, 300], [100, 3000], [20000, 3000]])('T2j whole async Allow rows=%i history=%i', async (rows, history) => {
    const f = setup(); await f.propose(); seedProtected(f, history);
    // Historical receipts have already been evicted before the measured turn.
    f.routines.reconcileRoutineRequestReceipts(f.routines.routineRequestReceiptSnapshot().slice(0, 256));
    f.service.reconcileAtStartup();
    expect(f.disk()).toHaveLength(256);
    f.f.db.prepare("UPDATE approval_records SET delivery='accepted' WHERE thread_id='seed-thread'").run();
    appendHistory(f, rows, 'history');
    const p = await f.propose();
    const record = d.lookupApproval('t', p.messageId)!;
    const all = vi.spyOn(f.f.store, 'messagesFor'), card = vi.spyOn(f.f.store, 'cardForRequest'), byId = vi.spyOn(f.f.store, 'messageById');
    const lookup = vi.spyOn(d, 'lookupApproval'), commit = vi.spyOn(f.routines as any, 'commitMutation');
    let getTraps = 0;
    const internal = f.routines as any;
    internal.routineRequestReceipts = new Proxy(internal.routineRequestReceipts, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) getTraps++; return Reflect.get(target, key, receiver); } });
    f.visits.length = 0;
    const { reads } = await measureReads('t', join(DATA_DIR, 'messages.db'), () => d.answerApproval(record.ref, { behavior: 'allow' }));
    const count = { messageRows: Object.entries(reads.bySql).filter(([sql]) => /^SELECT .*FROM messages\b/.test(sql)).reduce((sum, [, v]) => sum + v.rows, 0), messagesFor: all.mock.calls.length, cardForRequest: card.mock.calls.length, messageById: byId.mock.calls.length, lookupApproval: lookup.mock.calls.length, admit: f.visits.filter(v => v.startsWith('admit:')).length, commitMutation: commit.mock.calls.length, getTraps };
    console.info(`T2j rows=${rows} history=${history}`, JSON.stringify(count));
    expect(d.readApproval(record.ref.approvalId)?.delivery).toBe('accepted');
    expect(count.messagesFor).toBe(0); expect(count.cardForRequest).toBe(0); expect(count.messageById).toBeLessThanOrEqual(2);
    expect(count.admit).toBe(1); expect(count.lookupApproval).toBeLessThanOrEqual(2); expect(count.commitMutation).toBeLessThanOrEqual(3); expect(count.getTraps).toBeLessThanOrEqual(8 * 256);
    counters.push(count); expect(count).toEqual(counters[0]);
    vi.restoreAllMocks();
    // Release each installation before the next independent cell.
    for (const dispose of disposers.splice(0).reverse()) dispose();
});

it('T2a proposal does not sweep receipt history or transcript history', async () => {
  const f = setup();
  const sweep = vi.spyOn(f.service, 'sweepReceipts');
  const snapshot = vi.spyOn(f.routines, 'routineRequestReceiptSnapshot');
  const all = vi.spyOn(f.f.store, 'messagesFor');
  await f.propose();
  expect(sweep).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
});

it('T2k-b resolve refuses legacy 257 protected plus 1 accepted without changing any receipt state', async () => {
  const f = setup(); await f.propose(); seedProtected(f, 258);
  f.f.db.prepare("UPDATE approval_records SET delivery='accepted' WHERE id='seed-257'").run();
  const p = await f.propose();
  const state = () => JSON.stringify({ queues: (f.service as any).receiptQueues, byId: [...(f.service as any).byId], disk: readFileSync(f.file, 'utf8') });
  const before = state(); f.visits.length = 0;
  expect(f.service.resolve({ botId: 'b', threadId: 't', requestId: p.requestId, behavior: 'allow' })).toMatchObject({ state: 'invalid', status: 409, error: busy });
  expect(state()).toBe(before); expect(d.lookupApproval('t', p.messageId)?.state).toBe('open');
  expect(f.visits.filter(v => v.startsWith('admit:'))).toHaveLength(258);
});


it('T1b negative control rejects routineRequest.appliedAt on a terminal card through the real Store', async () => {
  const f = setup(), p = await f.propose();
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
  const before = f.f.store.messageById('t', p.messageId, { buildIndex: false })!;
  expect(typeof before.card!.answeredAt).toBe('number');
  const persisted = () => f.f.db.prepare('SELECT json FROM messages WHERE thread_id=? AND id=?').get('t', p.messageId)!.json;
  const diskBefore = persisted();
  expect(() => f.f.store.patchMessage('t', p.messageId, {
    card: { ...before.card!, routineRequest: { ...before.card!.routineRequest!, appliedAt: before.card!.answeredAt } },
  })).toThrow('card-action-changed');
  expect(persisted()).toBe(diskBefore);
  expect(f.f.store.messageById('t', p.messageId, { buildIndex: false })!.card).toEqual(before.card);
});

it('refreshes the v2 settlement trigger before a terminal routine payload can change through SQL', async () => {
  const f = setup(), p = await f.propose();
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
  // The prior v2 guard allowed routine receipt fields after settlement.
  // Keep its version/connection markers while modelling that permissive write.
  f.f.db.exec(`DROP TRIGGER approval_card_update;
    CREATE TRIGGER approval_card_update /* card-result-v2 murage_approval_guard */
    BEFORE UPDATE ON messages BEGIN SELECT 1; END;`);
  initializeApprovals(f.f.db);
  const disk = () => f.f.db.prepare('SELECT json FROM messages WHERE thread_id=? AND id=?').get('t', p.messageId)!.json;
  const before = disk();
  expect(() => f.f.db.prepare(`UPDATE messages SET json=json_set(json,'$.card.routineRequest.appliedAt',123) WHERE thread_id=? AND id=?`)
    .run('t', p.messageId)).toThrow('card-action-changed');
  expect(disk()).toBe(before);
});

// The Proxy counts every numeric array access, including native findIndex and
// index construction. Warm the *same Proxy* before measuring the warm case.
function trackLoadedRows(f: ReturnType<typeof setup>, warm: boolean, messageId: string) {
  (f.f.store as any).threads.delete('t');
  const rows = f.f.store.messagesFor('t');
  let walks = 0;
  const tracked = new Proxy(rows, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) walks++;
    return Reflect.get(target, key, receiver);
  } });
  (f.f.store as any).threads.get('t').messages = tracked;
  if (warm) f.f.store.messageById('t', messageId);
  walks = 0;
  return { tracked, walks: () => walks };
}

const loadedAllowCounters = new Map<boolean, object>();
it.each([[100, false], [20000, false], [100, true], [20000, true]] as const)(
  'R1 loaded whole async Allow rows=%i warm=%s has bounded message work', async (rows, warm) => {
    const f = setup();
    appendHistory(f, rows, 'loaded-allow');
    const p = await f.propose(), record = d.lookupApproval('t', p.messageId)!;
    const tracked = trackLoadedRows(f, warm, p.messageId);
    const all = vi.spyOn(f.f.store, 'messagesFor'), byId = vi.spyOn(f.f.store, 'messageById');
    const { reads } = await measureReads('t', join(DATA_DIR, 'messages.db'), () => d.answerApproval(record.ref, { behavior: 'allow' }));
    const count = {
      walks: tracked.walks(), messageById: byId.mock.calls.length,
      messageRows: Object.entries(reads.bySql).filter(([sql]) => /^SELECT .*FROM messages\b/.test(sql)).reduce((sum, [, read]) => sum + read.rows, 0),
    };
    console.info('R1 loaded Allow', JSON.stringify({ rows, warm, ...count }));
    expect(count.walks).toBeLessThanOrEqual(32);
    expect(count.messageById).toBeLessThanOrEqual(2);
    expect(all).not.toHaveBeenCalled();
    if (!loadedAllowCounters.has(warm)) loadedAllowCounters.set(warm, count);
    expect(count).toEqual(loadedAllowCounters.get(warm));
    expect(d.readApproval(record.ref.approvalId)?.delivery).toBe('accepted');
    const current = f.f.store.messageById('t', p.messageId, { buildIndex: false })!;
    expect(current.card!.answeredAt).toBe(f.routines.routineRequestReceipt(p.requestId)!.appliedAt);
    if (warm) expect(tracked.tracked.at(-1)).toEqual(current);
    // A later explicit transcript read must see both writes, including after a cold-cache invalidation.
    expect(f.f.store.messagesFor('t').find(m => m.id === p.messageId)).toEqual(current);
  },
);

it.each([false, true])('R1 loaded reconcile heal warm=%s never walks history', async warm => {
  const f = setup();
  appendHistory(f, 10000, 'before-heal');
  const p = await f.propose();
  const real = f.f.store.patchMessage.bind(f.f.store);
  const patch = vi.spyOn(f.f.store, 'patchMessage');
  patch.mockImplementation((...args) => {
    if (args[2].card && 'answeredAt' in args[2].card) throw new Error('fixture stamp failure');
    return real(...args);
  });
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
  patch.mockRestore();
  expect(f.f.store.messageById('t', p.messageId, { buildIndex: false })!.card!.answeredAt).toBeUndefined();
  appendHistory(f, 10000, 'loaded-heal');
  const tracked = trackLoadedRows(f, warm, p.messageId);
  f.restart();
  const all = vi.spyOn(f.f.store, 'messagesFor'), byId = vi.spyOn(f.f.store, 'messageById');
  const { reads } = await measureReads('t', join(DATA_DIR, 'messages.db'), () => f.service.reconcileAtStartup());
  const keyed = Object.entries(reads.bySql).filter(([sql]) => /^SELECT .* FROM messages WHERE thread_id = \? AND id = \?/.test(sql)).reduce((sum, [, read]) => sum + read.statements, 0);
  console.info('R1 loaded heal', JSON.stringify({ warm, walks: tracked.walks(), keyed }));
  if (warm) expect(tracked.walks()).toBeLessThanOrEqual(32);
  else expect(tracked.walks()).toBe(0);
  expect(keyed).toBe(warm ? 0 : 1);
  expect(all).not.toHaveBeenCalled(); expect(byId).toHaveBeenCalledTimes(1);
  const current = f.f.store.messageById('t', p.messageId, { buildIndex: false })!;
  expect(current.card!.answeredAt).toBe(f.routines.routineRequestReceipt(p.requestId)!.appliedAt);
  expect((f.service as any).receiptQueues.undoQ.length).toBe(1);
  expect(current.parentId).toBe('before-heal-9999');
  if (warm) expect(tracked.tracked[10000]).toEqual(current);
  expect(f.f.store.messagesFor('t').find(m => m.id === p.messageId)).toEqual(current);
});

it('R2 missing legacy card is read exactly once during reconciliation and remains protected', async () => {
  const f = setup(), p = await f.propose();
  await d.answerApproval(d.lookupApproval('t', p.messageId)!.ref, { behavior: 'allow' });
  f.f.db.prepare('DELETE FROM approval_records').run();
  f.f.db.prepare('DELETE FROM messages WHERE thread_id=? AND id=?').run('t', p.messageId);
  (f.f.store as any).threads.delete('t');
  f.restart();
  const byId = vi.spyOn(f.f.store, 'messageById');
  const { reads } = await measureReads('t', join(DATA_DIR, 'messages.db'), () => f.service.reconcileAtStartup());
  const keyed = Object.entries(reads.bySql).filter(([sql]) => /^SELECT .* FROM messages WHERE thread_id = \? AND id = \?/.test(sql)).reduce((sum, [, read]) => sum + read.statements, 0);
  expect(byId).toHaveBeenCalledTimes(1); expect(keyed).toBe(1);
  expect(f.disk()).toHaveLength(1);
  expect((f.service as any).receiptQueues.parkQ.length).toBe(1);
});
