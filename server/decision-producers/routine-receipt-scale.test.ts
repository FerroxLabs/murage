import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutineManager, type RoutineRequestReceipt } from '../routines.ts';
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestStore } from '../routine-requests.ts';
import { AUTOMATION_UNDO_WINDOW_MS } from '../../shared/routine-request.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { readRoutinesWithRuns } from '../routine-runs-journal.ts';

const decisions = vi.hoisted(() => ({ records: new Map<string, any>(), lookup: vi.fn() }));
vi.mock('../decision/index.ts', () => ({ lookupApproval: decisions.lookup, readApproval: vi.fn() }));
const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  decisions.records.clear();
  decisions.lookup.mockImplementation((_thread, message) => decisions.records.get(message) ?? null);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
const at = 1_800_000_000_000;
function receipt(id: string, appliedAt = at): RoutineRequestReceipt {
  return { requestId: id, messageId: `message-${id}`, threadId: 'thread', botId: 'bot', action: 'pause',
    fingerprintVersion: 1, fingerprint: 'a'.repeat(64), resultId: `routine-${id}`, appliedAt, appliedUpdatedAt: appliedAt,
    before: { enabled: true } as RoutineRequestReceipt['before'] };
}
function fixture(receipts: RoutineRequestReceipt[]) {
  const dir = mkdtempSync(join(tmpdir(), 'murage-s2p-receipts-')); dirs.push(dir);
  const file = join(dir, 'routines.json');
  // Match RoutineManager's newest-first insertion order, without N setup commits.
  writeFileSync(file, JSON.stringify({ version: 1, routines: [], routineRequestReceipts: [...receipts].reverse() }));
  const clock = { now: at };
  const routines = new RoutineManager({ file, now: () => clock.now, botState: () => 'busy', createTask: () => null, startTurn: async () => {} });
  const messages = new Map<string, RoutineRequestMessage>();
  for (const r of receipts) {
    decisions.records.set(r.messageId, { state: 'answered', delivery: 'accepted' });
    messages.set(r.requestId, { id: r.messageId, card: { title: 'Fixture', subtitle: '', options: [], answered: 'Allowed', requestId: r.requestId, routineRequest: { fixture: true } as any } });
  }
  const byMessage = new Map([...messages.values()].map(message => [message.id, message]));
  const store: RoutineRequestStore = {
    messagesFor: vi.fn(() => { throw new Error('history read'); }),
    messageById: vi.fn((_thread, id) => byMessage.get(id)),
    cardForRequest: vi.fn((_thread, id) => messages.get(id)),
    appendMessage: () => { throw new Error('unexpected append'); },
    patchMessage: vi.fn((_thread, id, patch) => {
      const message = byMessage.get(id)!;
      message.card = patch.card; return message;
    }),
  };
  const visits: string[] = [];
  const service = new RoutineRequestService({ store, routines, now: () => clock.now, onVisit: (source, id) => visits.push(`${source}:${id}`) });
  // MAIN RULING INT-CONFLICT-DEFAULT c0261fd8c6: observe the durable receipt journal.
  const disk = () => readRoutinesWithRuns(file).routineRequestReceipts as RoutineRequestReceipt[];
  return { service, routines, store, messages, visits, clock, disk, file };
}

it('T2d crash reconcile has linear internal receipt reads and exactly one atomic commit', () => {
  const counts: number[] = [];
  for (const n of [200, 2000]) {
    const receipts = Array.from({ length: n }, (_, i) => receipt(`${i}`, i % 2 ? at : at - AUTOMATION_UNDO_WINDOW_MS - 1));
    const f = fixture(receipts);
    const internal = f.routines as any;
    let reads = 0;
    internal.routineRequestReceipts = new Proxy(internal.routineRequestReceipts, {
      get(target, property, receiver) { if (typeof property === 'string' && /^\d+$/.test(property)) reads++; return Reflect.get(target, property, receiver); },
    });
    const commit = vi.spyOn(internal, 'commitMutation');
    const single = vi.spyOn(f.routines, 'routineRequestReceipt');
    const forget = vi.spyOn(f.routines, 'forgetRoutineRequestReceipt');
    f.service.reconcileAtStartup();
    counts.push(reads);
    expect(reads).toBeLessThanOrEqual(8 * n);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled();
    expect(decisions.lookup).toHaveBeenCalledTimes(n);
    expect(f.store.messageById).toHaveBeenCalledTimes(n);
    expect(f.store.cardForRequest).not.toHaveBeenCalled();
    expect(f.store.messagesFor).not.toHaveBeenCalled();
    expect(f.disk().map(r => r.requestId)).toEqual(receipts.filter((_, i) => i % 2).slice(-256).reverse().map(r => r.requestId));
    console.info(`T2d N=${n} numericReads=${reads} commits=${commit.mock.calls.length}`);
    decisions.lookup.mockClear();
  }
  expect(counts[1]! / counts[0]!).toBeLessThanOrEqual(12);
});

it('T2c fixed P,U rotation shares 64 visits and drops 32 receipts in one commit', () => {
  const parked = Array.from({ length: 64 }, (_, i) => receipt(`p${i}`));
  const undo = Array.from({ length: 192 }, (_, i) => receipt(`u${i}`));
  const f = fixture([...parked, ...undo]);
  for (const r of parked) decisions.records.set(r.messageId, { state: 'answered', delivery: 'pending' });
  f.service.reconcileAtStartup();
  f.clock.now += AUTOMATION_UNDO_WINDOW_MS;
  const commit = vi.spyOn(f.routines as any, 'commitMutation');
  decisions.lookup.mockClear();
  f.service.sweepReceipts();
  expect(f.visits).toEqual(Array.from({ length: 32 }, (_, i) => [`parkQ:p${i}`, `undoQ:u${i}`]).flat());
  expect(decisions.lookup).toHaveBeenCalledTimes(64);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(f.disk()).toHaveLength(256 - 32);
  f.visits.length = 0;
  f.service.sweepReceipts();
  expect(f.visits.filter(v => v.startsWith('parkQ:'))).toEqual(parked.slice(32).map(r => `parkQ:${r.requestId}`));
  for (const r of parked.slice(0, 10)) decisions.records.set(r.messageId, { state: 'answered', delivery: 'accepted' });
  f.visits.length = 0;
  f.service.sweepReceipts(); f.service.sweepReceipts();
  const parkQueue = (f.service as any).receiptQueues.parkQ;
  const stillParked = new Set(Array.from({ length: parkQueue.length }, (_, i) => parkQueue.at(i).receipt.requestId));
  for (const r of parked.slice(0, 10)) {
    expect(f.visits).toContain(`parkQ:${r.requestId}`);
    expect(stillParked.has(r.requestId)).toBe(false);
  }
});

it('T2f failed bulk save leaves every source head tracked for retry and restart', () => {
  const f = fixture([receipt('p'), receipt('u')]);
  decisions.records.set('message-p', { state: 'answered', delivery: 'failed' });
  f.service.reconcileAtStartup(); f.clock.now += AUTOMATION_UNDO_WINDOW_MS;
  const save = vi.spyOn(f.routines as any, 'save').mockImplementationOnce(() => { throw new Error('fixture disk failure'); });
  const before = f.disk();
  f.service.sweepReceipts(f.clock.now, 2);
  expect(f.disk()).toEqual(before);
  const first = [...f.visits]; f.visits.length = 0;
  f.service.sweepReceipts(f.clock.now, 2);
  expect(f.visits).toEqual(first);
  expect(f.disk().map(r => r.requestId)).toEqual(['p']);
  save.mockRestore();
  f.service.reconcileAtStartup();
  expect(f.disk().map(r => r.requestId)).toEqual(['p']);
});

it('startup bulk failure retains rejected heads until a successful tick', () => {
  const f = fixture([receipt('expired', at - AUTOMATION_UNDO_WINDOW_MS - 1)]);
  vi.spyOn(f.routines as any, 'save').mockImplementationOnce(() => { throw new Error('fixture crash'); });
  f.service.reconcileAtStartup(); expect(f.disk()).toHaveLength(1);
  f.service.sweepReceipts(); expect(f.disk()).toHaveLength(0);
});

it('M22 stamp guard is label-free, idempotent, terminal-only and never rewrites action payload', () => {
  for (const label of ['Allowed', 'allow', 'fixture-terminal']) {
    const r = receipt(label), f = fixture([r]);
    const card = f.messages.get(r.requestId)!.card!;
    card.answered = label;
    const payload = { fixture: 'immutable' }; Object.assign(card, { routineRequest: payload });
    (f.service as any).stampApplied('thread', r.messageId, r.requestId);
    expect(f.messages.get(r.requestId)!.card).toEqual({ ...card, answeredAt: at });
    expect(f.messages.get(r.requestId)!.card!.routineRequest).toBe(payload);
    (f.service as any).stampApplied('thread', r.messageId, r.requestId);
    expect(f.store.patchMessage).toHaveBeenCalledTimes(1);
  }
  for (const state of ['open', 'unapplied', 'undone', 'equal'] as const) {
    const r = receipt(state); if (state === 'unapplied') { delete r.appliedAt; delete r.resultId; }
    if (state === 'undone') r.undoneAt = at;
    const f = fixture([r]), card = f.messages.get(r.requestId)!.card!;
    if (state === 'open') delete card.answered;
    if (state === 'equal') card.answeredAt = at;
    (f.service as any).stampApplied('thread', r.messageId, r.requestId);
    expect(f.store.patchMessage).not.toHaveBeenCalled();
  }
});

it('stamp failure does not turn a committed execution into a delivery failure; startup heals', () => {
  const r = receipt('heal'), f = fixture([r]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(f.store.patchMessage).mockImplementationOnce(() => { throw new Error('fixture stamp failure'); });
  expect(() => (f.service as any).stampApplied('thread', r.messageId, r.requestId)).not.toThrow();
  expect(console.warn).toHaveBeenCalledWith('routine-stamp-failed');
  expect(f.messages.get(r.requestId)!.card!.answeredAt).toBeUndefined();
  f.service.reconcileAtStartup();
  expect(f.messages.get(r.requestId)!.card!.answeredAt).toBe(at);
});

it('a post-commit card read failure retains the receipt and heals on restart', () => {
  const r = receipt('read-failure'), f = fixture([r]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(f.store.messageById!).mockImplementationOnce(() => { throw new Error('fixture card read failure'); });
  expect(() => (f.service as any).stampApplied('thread', r.messageId, r.requestId)).not.toThrow();
  expect(console.warn).toHaveBeenCalledWith('routine-stamp-failed');
  expect(f.messages.get(r.requestId)!.card!.answeredAt).toBeUndefined();
  expect(f.routines.routineRequestReceipt(r.requestId)).toEqual(r);
  expect((f.service as any).byId.has(r.requestId)).toBe(true);
  f.service.reconcileAtStartup();
  expect(f.messages.get(r.requestId)!.card!.answeredAt).toBe(at);
  expect(f.disk()).toEqual([r]);
});

it('a missing stamp write retains the committed receipt and heals on restart', () => {
  const r = receipt('missing-stamp'), f = fixture([r]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(f.store.patchMessage).mockReturnValueOnce(null);
  expect(() => (f.service as any).stampApplied('thread', r.messageId, r.requestId)).not.toThrow();
  expect(console.warn).toHaveBeenCalledWith('routine-stamp-failed');
  expect(f.messages.get(r.requestId)!.card!.answeredAt).toBeUndefined();
  expect(f.routines.routineRequestReceipt(r.requestId)).toEqual(r);
  expect((f.service as any).byId.has(r.requestId)).toBe(true);
  f.service.reconcileAtStartup();
  expect(f.messages.get(r.requestId)!.card!.answeredAt).toBe(at);
  expect(f.disk()).toEqual([r]);
});

it('T2g a newly unprotected parked head due exactly now joins the fixed rotation', () => {
  const f = fixture([receipt('boundary')]);
  decisions.records.set('message-boundary', { state: 'answered', delivery: 'pending' });
  f.service.reconcileAtStartup();
  decisions.records.set('message-boundary', { state: 'answered', delivery: 'accepted' });
  f.clock.now += AUTOMATION_UNDO_WINDOW_MS;
  const commit = vi.spyOn(f.routines as any, 'commitMutation');
  f.service.sweepReceipts(f.clock.now, 2);
  expect(f.visits).toEqual(['parkQ:boundary', 'undoQ:boundary']);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(f.disk()).toHaveLength(0);
});

function state(f: ReturnType<typeof fixture>): string {
  const service = f.service as any;
  return JSON.stringify({ queues: service.receiptQueues, byId: [...service.byId], disk: readFileSync(f.file, 'utf8') });
}
it('T2k-b legacy 257 protected plus 1 accepted refuses with byte-identical queues, map and file; expiry still reaches every parked entry', () => {
  const f = fixture(Array.from({ length: 258 }, (_, i) => receipt(`legacy-${i}`)));
  for (let i = 0; i < 258; i++) decisions.records.set(`message-legacy-${i}`, { state: 'answered', delivery: 'pending' });
  f.service.reconcileAtStartup();
  // Settlement happens without a tick: the planner can reclaim one but needs three.
  decisions.records.set('message-legacy-257', { state: 'answered', delivery: 'accepted' });
  f.visits.length = 0;
  const before = state(f), commit = vi.spyOn(f.routines as any, 'commitMutation');
  expect((f.service as any).makeRoom?.(1)).toBe('full');
  expect(state(f)).toBe(before); expect(commit).not.toHaveBeenCalled();
  expect(f.visits.filter(v => v.startsWith('admit:'))).toHaveLength(258);
  f.visits.length = 0;
  for (let i = 0; i < 6; i++) f.service.sweepReceipts();
  expect(new Set(f.visits.filter(v => v.startsWith('parkQ:'))).size).toBe(258);
});
it('T2m missing card retains a valid applied not-undone Undo receipt', () => {
  const r = receipt('missing'), f = fixture([r]);
  vi.mocked(f.store.messageById!).mockReturnValue(undefined); vi.mocked(f.store.cardForRequest!).mockReturnValue(undefined);
  f.service.reconcileAtStartup();
  expect(f.disk()).toEqual([r]); expect((f.service as any).receiptQueues.undoQ.length).toBe(1);
  expect((f.service as any).byId.size).toBe(1);
});
it('T2h absent by-id accessor skips stamp without any history fallback and keeps the receipt', () => {
  const f = fixture([receipt('no-accessor')]); delete f.store.messageById;
  expect(() => (f.service as any).stampApplied('thread', 'message-no-accessor', 'no-accessor')).not.toThrow();
  expect(f.store.cardForRequest).not.toHaveBeenCalled(); expect(f.store.messagesFor).not.toHaveBeenCalled();
  expect(f.store.patchMessage).not.toHaveBeenCalled(); expect(f.disk()).toHaveLength(1);
});
it('T2i startup bounds all receipts, including 64 protected and 255 accepted Undo receipts', () => {
  const accepted = Array.from({ length: 255 }, (_, i) => receipt(`a${i}`));
  const pending = Array.from({ length: 64 }, (_, i) => receipt(`p${i}`));
  const f = fixture([...accepted, ...pending]);
  for (const r of pending) decisions.records.set(r.messageId, { state: 'answered', delivery: 'pending' });
  f.service.reconcileAtStartup();
  expect((f.service as any).byId.size).toBe(256); expect(f.disk()).toHaveLength(256);
  expect(f.disk().some(r => r.requestId === 'a62')).toBe(false); expect(f.disk().some(r => r.requestId === 'a63')).toBe(true);
  for (const r of pending) { decisions.records.set(r.messageId, { state: 'answered', delivery: 'accepted' }); (f.service as any).stampApplied(r.threadId, r.messageId, r.requestId); expect((f.service as any).byId.size).toBe(256); }
});
it('T2k failed admission bulk save leaves every head and map unchanged', () => {
  const f = fixture(Array.from({ length: 256 }, (_, i) => receipt(`p${i}`)));
  for (let i = 0; i < 256; i++) decisions.records.set(`message-p${i}`, { state: 'answered', delivery: 'pending' });
  f.service.reconcileAtStartup(); decisions.records.set('message-p0', { state: 'answered', delivery: 'accepted' });
  const before = state(f);
  vi.spyOn(f.routines as any, 'save').mockImplementationOnce(() => { throw new Error('fixture disk failure'); });
  expect((f.service as any).makeRoom?.(1)).toBe('failed'); expect(state(f)).toBe(before);
  expect((f.service as any).makeRoom?.(1)).toBe('room'); expect(f.disk()).toHaveLength(255);
});

it('startup over-cap save failure makes one attempt and retains every head until the next pass', () => {
  const f = fixture(Array.from({ length: 300 }, (_, i) => receipt(`retry-${i}`)));
  const before = f.disk();
  vi.spyOn(f.routines as any, 'save').mockImplementationOnce(() => { throw new Error('fixture startup save failure'); });
  const commit = vi.spyOn(f.routines as any, 'commitMutation');
  f.service.reconcileAtStartup();
  expect(commit).toHaveBeenCalledTimes(1); expect(f.disk()).toEqual(before);
  expect((f.service as any).byId.size).toBe(300);
  expect((f.service as any).receiptQueues.undoQ.length).toBe(300);
  f.service.reconcileAtStartup();
  expect(f.disk()).toHaveLength(256); expect((f.service as any).byId.size).toBe(256);
});
