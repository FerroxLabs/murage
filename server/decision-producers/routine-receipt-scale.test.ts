import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutineManager, type RoutineRequestReceipt } from '../routines.ts';
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestStore } from '../routine-requests.ts';
import { AUTOMATION_UNDO_WINDOW_MS } from '../../shared/routine-request.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

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
    messages.set(r.requestId, { id: r.messageId, card: { title: 'Fixture', subtitle: '', options: [], answered: 'Allowed' } });
  }
  const byMessage = new Map([...messages.values()].map(message => [message.id, message]));
  const store: RoutineRequestStore = {
    messagesFor: vi.fn(() => { throw new Error('history read'); }),
    // TODO(s2p-r5): exercise the real known-message-ID store lookup once H2 is specified.
    cardForRequest: vi.fn((_thread, id) => messages.get(id)),
    appendMessage: () => { throw new Error('unexpected append'); },
    patchMessage: vi.fn((_thread, id, patch) => {
      const message = byMessage.get(id)!;
      message.card = patch.card; return message;
    }),
  };
  const visits: string[] = [];
  const service = new RoutineRequestService({ store, routines, now: () => clock.now, onVisit: (source, id) => visits.push(`${source}:${id}`) });
  const disk = () => JSON.parse(readFileSync(file, 'utf8')).routineRequestReceipts as RoutineRequestReceipt[];
  return { service, routines, store, messages, visits, clock, disk };
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
    expect(f.store.cardForRequest).toHaveBeenCalledTimes(n);
    expect(f.store.messagesFor).not.toHaveBeenCalled();
    expect(f.disk().map(r => r.requestId)).toEqual(receipts.filter((_, i) => i % 2).reverse().map(r => r.requestId));
    console.info(`T2d N=${n} numericReads=${reads} commits=${commit.mock.calls.length}`);
    decisions.lookup.mockClear();
  }
  expect(counts[1]! / counts[0]!).toBeLessThanOrEqual(12);
});

it('T2c fixed P,U rotation shares 64 visits and drops 32 receipts in one commit', () => {
  const parked = Array.from({ length: 64 }, (_, i) => receipt(`p${i}`));
  const undo = Array.from({ length: 1000 }, (_, i) => receipt(`u${i}`));
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
  expect(f.disk()).toHaveLength(1064 - 32);
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
