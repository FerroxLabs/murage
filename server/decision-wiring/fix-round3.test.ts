// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutineManager, type RoutineRequestReceipt } from '../routines.ts';
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestStore } from '../routine-requests.ts';
import { ProducerApprovalQueue } from '../narrow-denials.ts';
import type { ProducerQueuePort } from '../decision/index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { source, routine, wiringBlock, wiringCallArg } from './fixture.ts';
import { fixture, deferred, flush } from './round3-fixture.ts';

it('R1 RED sweep operations and plans are independent of completed history', async () => {
  async function run(n: number) {
    const f = fixture();
    try {
      f.insert('open', 'queued', 'ask', undefined, true); f.insert('held', 'done', 'ask', undefined, true); f.insert('wake', 'queued', 'wake', 'held');
      for (let i = 0; i < n; i++) {
        f.insert(`old${i}`); f.insert(`w${i}`, 'done', 'wake', 'held'); f.insert(`a${i}`, 'done', 'ask', 'held'); f.insert(`c${i}`, 'done', 'wake', 'open');
      }
      await f.make().retireDecisionSharedSources();
      expect(f.saved.size).toBe(2); f.plan(); console.log('R1 ops', n, JSON.stringify(f.ops)); return { ...f.ops };
    } finally { f.close(); }
  }
  expect(await run(10_000)).toEqual(await run(10));
});
it('R2 RED completion operations and plans are independent of siblings and grandchildren', async () => {
  async function run(n: number) {
    const f = fixture();
    try {
      f.insert('C', 'done', 'ask', undefined, true); f.insert('W', 'done', 'wake', 'C');
      for (let i = 0; i < n; i++) { f.insert(`s${i}`, 'done', 'wake', 'C'); f.insert(`g${i}`, 'done', 'wake', `s${i}`); }
      const api = f.make(); api.afterRoomCompletion({ request: f.row('W'), wakes: [] }); await flush();
      expect(f.saved.size).toBe(0); f.plan(); console.log('R2 ops', n, JSON.stringify(f.ops)); return { ...f.ops };
    } finally { f.close(); }
  }
  expect(await run(10_000)).toEqual(await run(10));
});
it('R3 guard retry wake chains keep the source until completion', async () => {
  const f = fixture(); try {
    f.insert('C', 'done', 'ask', undefined, true); f.insert('W1', 'failed', 'wake', 'C'); f.insert('W2', 'queued', 'wake', 'W1');
    const api = f.make(); await api.retireDecisionSharedSources(); expect(f.saved.size).toBe(1);
    f.db.prepare("UPDATE room_requests SET state='done' WHERE id='W2'").run();
    api.afterRoomCompletion({ request: f.row('W2'), wakes: [] }); await flush(); expect(f.saved.size).toBe(0);
  } finally { f.close(); }
});
it('R4 guard a wake resolving to C2 does not hold C', async () => {
  const f = fixture(); try {
    f.insert('C', 'done', 'ask', undefined, true); f.insert('C2', 'done', 'ask', undefined, true); f.insert('W', 'queued', 'wake', 'C2');
    await f.make().retireDecisionSharedSources(); expect([...f.saved.keys()]).toEqual([JSON.stringify(f.key('C2'))]);
  } finally { f.close(); }
});
it('R5 RED an uncaptured intervening ask stops inheritance', async () => {
  const f = fixture(); try {
    f.insert('P', 'done', 'ask', undefined, true); f.insert('A', 'done', 'ask', 'P'); f.insert('W', 'queued', 'wake', 'A');
    await f.make().retireDecisionSharedSources(); expect(f.saved.size).toBe(0);
  } finally { f.close(); }
});
it('R6 RED a pruned orphan continuation is deleted', async () => {
  const f = fixture(); try {
    f.saved.set(JSON.stringify(f.key('gone')), {}); await f.make().retireDecisionSharedSources(); expect(f.saved.size).toBe(0);
  } finally { f.close(); }
});
it('R7 guard crash delete failure is retried on restart and idempotent', async () => {
  const f = fixture(); try {
    f.insert('C', 'done', 'ask', undefined, true);
    f.globals.deleteContinuation.mockImplementationOnce(() => Promise.reject(Error('fixture disk')));
    await f.make().retireDecisionSharedSources().catch(() => {}); expect(f.saved.size).toBe(1);
    await f.make().retireDecisionSharedSources(undefined, 10); expect(f.saved.size).toBe(0);
    const deletes = f.globals.deleteContinuation.mock.calls.length;
    await f.make().retireDecisionSharedSources(); expect(f.globals.deleteContinuation).toHaveBeenCalledTimes(deletes);
  } finally { f.close(); }
});
it('R9 RED continuation pages advance after deletions', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 250; i++) f.insert(`C${String(i).padStart(3, '0')}`, 'done', 'ask', undefined, true);
    const api = f.make(); for (let i = 0; i < 3; i++) await api.retireDecisionSharedSources();
    const calls = f.globals.listContinuations.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toHaveLength(3); expect(calls.map((c: any) => c.limit)).toEqual([100, 100, 100]);
    expect(calls[1].after).toBe(JSON.stringify(f.key('C099'))); expect(calls[2].after).toBe(JSON.stringify(f.key('C199')));
    expect(f.saved.size).toBe(0);
  } finally { f.close(); }
});
it('R10 RED listing uses exactly the closed shared-peer namespace', async () => {
  const f = fixture(); try {
    f.saved.set(JSON.stringify(f.key('wake', 'asker-wake')), {});
    f.saved.set(JSON.stringify({ ...f.key('other'), id: 'other:job' }), {});
    await f.make().retireDecisionSharedSources();
    expect(f.globals.listContinuations).toHaveBeenCalledWith({ kind: 'background-job', namespace: 'shared-peer', after: undefined, limit: 100 });
    expect(f.saved.size).toBe(2);
  } finally { f.close(); }
});
it('R11 RED dispatch precedes retirement and retirement is single flight', async () => {
  const hold = deferred(), retire = vi.fn(() => hold.done), tick = vi.fn(), pump = vi.fn();
  const callback = wiringCallArg('guardedWriter', 'room-sweep', {
    roomEngine: { ready: true }, retireDecisionSharedSources: retire, roomDispatcher: { tick }, pumpSharedWork: pump,
    resumeAllProjectCloses: vi.fn(), deliverOwedSharedResults: vi.fn(), projectCardExecutor: { pump: vi.fn() },
    store: { hasPendingWork: () => false }, sharedRetireRunning: false,
  });
  const first = callback(); await flush(); expect(tick).toHaveBeenCalledTimes(1); expect(pump).toHaveBeenCalledTimes(1);
  const second = callback(); await flush(); expect(retire).toHaveBeenCalledTimes(1);
  hold.resolve(); await Promise.all([first, second]);
});
it('R12 RED use and retirement resolve the same key for direct retry and ask-stop shapes', async () => {
  for (const middle of ['wake', 'ask']) {
    const f = fixture(); try {
      f.insert('P', 'done', 'ask', undefined, true); f.insert('A', 'failed', middle, 'P'); const w = f.insert('W', 'queued', 'wake', 'A');
      const api = f.make(), options = api.sharedTurnOptions(w);
      await api.retireDecisionSharedSources();
      expect(f.saved.has(JSON.stringify(f.key('P')))).toBe(options.decisionRoutineSource?.sourceRunId === 'P');
      if (middle === 'wake') expect(options.decisionRoutineSource?.sourceRunId).toBe('P');
    } finally { f.close(); }
  }
});
it('R13 guard retry committed during another candidate save is visible to the fresh hold check', async () => {
  const f = fixture(), pending = deferred(); try {
    f.insert('C1', 'done', 'ask', undefined, true); f.insert('C2', 'done', 'ask', undefined, true); f.insert('W', 'failed', 'wake', 'C2');
    f.saves.set('C2', pending); const running = f.make().retireDecisionSharedSources(); await flush();
    f.insert('retry', 'queued', 'wake', 'W'); pending.resolve(); await running;
    expect([...f.saved.keys()]).toEqual([JSON.stringify(f.key('C2'))]);
  } finally { pending.resolve(); f.close(); }
});
it('R14 guard completing during a pending save waits before continuation reads', async () => {
  const f = fixture(), pending = deferred(); try {
    f.insert('R', 'done', 'ask');
    f.saves.set('R', { done: pending.done.then(() => f.saved.set(JSON.stringify(f.key('R')), { actor: 'owner-routine', initiator: {} })) });
    const api = f.make(); api.afterRoomCompletion({ request: f.row('R'), wakes: [] }); await flush();
    expect(f.globals.readContinuation).not.toHaveBeenCalled(); pending.resolve(); await flush(); expect(f.saved.size).toBe(0);
  } finally { pending.resolve(); f.close(); }
});
it('R15 RED crash backlog operations are page bounded including boot budget', async () => {
  async function run(n: number, pages: number) {
    const f = fixture(); try {
      for (let i = 0; i < n; i++) f.insert(`C${String(i).padStart(5, '0')}`, 'done', 'ask', undefined, true);
      await f.make().retireDecisionSharedSources(undefined, pages); f.plan();
      expect(f.ops.examined).toBeLessThanOrEqual(101 * pages); expect(f.ops.deletes).toBe(100 * pages);
      console.log('R15 ops', n, pages, JSON.stringify(f.ops)); return { ...f.ops };
    } finally { f.close(); }
  }
  expect(await run(200, 1)).toEqual(await run(5000, 1));
  expect(await run(2000, 10)).toEqual(await run(5000, 10));
  expect(source).toMatch(/await retireDecisionSharedSources\(undefined, 10\);\s*pruneTerminalRoomRequests/);
});
it('R16 guard seeded transitions preserve the live-key leftover bound', async () => {
  const f = fixture(); let seed = 193; const random = () => (seed = (seed * 16807) % 2147483647);
  try {
    const api = f.make(); const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (!ids.length || random() % 3 === 0) { const id = `C${i}`; ids.push(id); f.insert(id, 'queued', 'ask', undefined, true); }
      else {
        const parent = ids[random() % ids.length];
        if (random() % 2) { const id = `W${i}`; ids.push(id); f.insert(id, 'queued', 'wake', parent); }
        else f.db.prepare('UPDATE room_requests SET state=? WHERE id=?').run(random() % 2 ? 'done' : 'cancelled', parent);
      }
      await api.retireDecisionSharedSources(undefined, 10);
      const open = ids.filter(id => !f.globals.isTerminalRoomRequestState(f.row(id).state));
      expect(f.saved.size).toBeLessThanOrEqual(open.length);
      const holds = new Set(open.map(id => api.sharedTurnOptions(f.row(id)).decisionRoutineSource?.sourceRunId));
      for (const k of f.saved.keys()) { const id = JSON.parse(k).id.slice(12); if (!open.includes(id)) expect(holds.has(id)).toBe(true); }
    }
  } finally { f.close(); }
});
it('R18 guard 501 open wakes hold only their exact source', async () => {
  const f = fixture(); try {
    f.insert('C_hot', 'done', 'ask', undefined, true); f.insert('C_cold', 'done', 'ask', undefined, true);
    for (let i = 0; i < 501; i++) f.insert(`W${i}`, 'queued', 'wake', 'C_hot');
    await f.make().retireDecisionSharedSources();
    expect([...f.saved.keys()]).toEqual([JSON.stringify(f.key('C_hot'))]);
    console.log('R18 ops (501 open wakes plus bounded climbs)', JSON.stringify(f.ops));
  } finally { f.close(); }
});
for (const test of ['R19 RED deferred ancestor', 'R19b RED competing provisional source', 'R20 guard deferred own save']) {
  it(test + ' is authoritatively refreshed before dispatch', async () => {
    const f = fixture(), pending = deferred(); try {
      f.insert('C', 'done', 'ask'); const w = f.insert('W', 'queued', 'wake', 'C');
      const id = test.startsWith('R20') ? 'W' : 'C';
      f.saves.set(id, { done: pending.done.then(() => f.saved.set(JSON.stringify(f.key(id)), { actor: 'owner-routine', initiator: { sourceRunId: id } })) });
      const api = f.make();
      const block = wiringBlock('startTurn', 'if (opts?.sharedWorkRun)', { ...f.globals, ...api });
      const provisional = { ...api.sharedTurnOptions(w), sharedWorkRun: { request: w }, ...(test.startsWith('R19b') ? { decisionRoutineSource: { sourceRunId: 'stale-provisional' } } : {}) };
      if (test.startsWith('R19b')) expect(Object.hasOwn(provisional, 'decisionRoutineSource')).toBe(true);
      const running = block(provisional); await flush(); pending.resolve();
      expect((await running).decisionRoutineSource?.sourceRunId).toBe(id);
    } finally { pending.resolve(); f.close(); }
  });
}
it.each(['done', 'cancelled'])('completion guard %s retires through afterRoomCompletion', async state => {
  const f = fixture(); try {
    const request = f.insert('C', state, 'ask', undefined, true); const api = f.make();
    api.afterRoomCompletion({ request, wakes: [] }); await flush(); expect(f.saved.size).toBe(0);
  } finally { f.close(); }
});
// DESIGN-S4-F2-r3 D: real service, terminal S1 card, applied receipt.
// The Store double serializes each write/read so assertions inspect persisted
// state rather than a mutated object shared with the service.
it('R17 RED real routine settle persists appliedAt for Allowed recovery and guards other deliveries', async () => {
  const evidence: unknown[] = [];
  for (const state of ['accepted', 'already', 'rejected', 'failed']) for (const kind of ['routine', 'email']) {
    for (const label of ['Allowed', 'allow']) {
      const f = routineSettleFixture(label);
      try {
        const { wrapped, error } = settleWrapper(f.service, state, kind);
        expect(await wrapped.respond({ approvalId: 'approval' }, {}, {})).toEqual({ state });
        const stamps = kind === 'routine' && ['accepted', 'already'].includes(state);
        expect(f.read().card?.answeredAt).toBe(stamps ? 1700 : undefined);
        expect(f.read().card).toEqual({ ...f.initial.card, ...(stamps ? { answeredAt: 1700 } : {}) });
        expect(f.patches()).toBe(stamps ? 1 : 0);
        expect(error).not.toHaveBeenCalled();
        evidence.push({ state, kind, label, persisted: f.read(), patches: f.patches() });
        // Recovery redelivery cannot rewrite an already stamped card.
        await wrapped.respond({ approvalId: 'approval' }, {}, {});
        expect(f.patches()).toBe(stamps ? 1 : 0);
      } finally { f.close(); }
    }
  }
  if (process.env.S4_R17_EVIDENCE) writeFileSync(process.env.S4_R17_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
});

it('R17 RED real afterSettle throw preserves the acknowledgement and logs once', async () => {
  const f = routineSettleFixture('Allowed');
  try {
    f.store.messageById = () => { throw Error('fixture point read failure'); };
    const { wrapped, error } = settleWrapper(f.service, 'already', 'routine');
    await expect(wrapped.respond({ approvalId: 'approval' }, {}, {})).resolves.toEqual({ state: 'already' });
    expect(f.read().card?.answeredAt).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('[decision] routine settle stamp failed');
  } finally { f.close(); }
});

it.each(['open', 'unapplied', 'undone', 'wrong-thread', 'wrong-message', 'missing'])(
  'R17 guard real afterSettle skips %s receipts/cards', async variant => {
    const f = routineSettleFixture(variant === 'open' ? undefined : 'Allowed', variant);
    try {
      const { wrapped } = settleWrapper(f.service, 'already', 'routine');
      await wrapped.respond({ approvalId: 'approval' }, {}, {});
      expect(f.read().card?.answeredAt).toBeUndefined();
      expect(f.patches()).toBe(0);
    } finally { f.close(); }
  },
);

function settleWrapper(service: RoutineRequestService, state: string, kind: string, port?: ProducerQueuePort) {
  let wrapped: any;
  const error = vi.fn();
  const register = wiringCallArg('installProducerBindings', 'registerQueue', {
    decisionQueuePorts: new Map(), bindDecisionQueueSync: undefined, installQueueSources: (ports: any[]) => { wrapped = ports[0]; return () => {}; },
    releaseDecisionQueueProof: async () => {}, readApproval: () => ({ threadId: 'thread', chatMessageId: 'card' }),
    routineRequests: service, console: { error },
  });
  register(port ?? { kind, respond: async () => ({ state }) });
  return { wrapped, error };
}

function routineSettleFixture(answered: string | undefined, variant?: string, history = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'murage-r17-'));
  const file = join(dir, 'routines.json');
  const receipt: RoutineRequestReceipt = { requestId: 'request', messageId: 'card', threadId: 'thread', botId: 'bot', action: 'pause',
    fingerprintVersion: 1, fingerprint: 'a'.repeat(64), resultId: 'routine', appliedAt: 1700, appliedUpdatedAt: 1700 };
  if (variant === 'unapplied') delete receipt.appliedAt;
  if (variant === 'undone') receipt.undoneAt = 1800;
  if (variant === 'wrong-thread') receipt.threadId = 'other';
  if (variant === 'wrong-message') receipt.messageId = 'other';
  const settled = Array.from({ length: history }, (_, i) => ({ ...receipt, requestId: `settled-${i}`, messageId: `settled-${i}`, undoneAt: 1800 }));
  writeFileSync(file, JSON.stringify({ version: 1, routines: [], routineRequestReceipts: variant === 'missing' ? [] : [...settled, receipt] }));
  const routines = new RoutineManager({ file, now: () => 2000, botState: () => 'busy', createTask: () => null, startTurn: async () => {} });
  const initial: RoutineRequestMessage = { id: 'card', card: { title: 'Fixture', subtitle: '', options: [], answered, dismissed: true,
    requestId: 'request', routineRequest: { version: 1, requestId: 'request', botId: 'bot', threadId: 'thread', createdAt: 1000,
      operation: { action: 'pause', routineId: 'routine', expectedUpdatedAt: 1000 } } } };
  let persisted = JSON.stringify(initial), patches = 0;
  const read = (): RoutineRequestMessage => JSON.parse(persisted);
  const patchMessagePoint: RoutineRequestStore['patchMessage'] = (threadId, id, patch) => {
    expect([threadId, id]).toEqual(['thread', 'card']); patches++;
    persisted = JSON.stringify({ ...read(), ...patch }); return read();
  };
  const store: RoutineRequestStore = {
    messagesFor: () => { throw Error('R17 must not scan conversation history'); },
    messageById: (threadId, id, options) => {
      expect(options).toEqual({ buildIndex: false });
      return threadId === 'thread' && id === 'card' ? read() : undefined;
    },
    cardForRequest: (threadId, requestId) => threadId === 'thread' && requestId === 'request' ? read() : undefined,
    appendMessage: () => { throw Error('unexpected append'); }, patchMessage: patchMessagePoint,
  };
  const service = new RoutineRequestService({ store, routines, now: () => 2000 });
  return { service, store, routines, initial, read, dir, patches: () => patches, close: () => removeTempDirSync(dir) };
}

it('R17 real accepted queue replay repairs the card on already without re-executing', async () => {
  const f = routineSettleFixture('Allowed');
  try {
    const item = { kind: 'routine', approvalId: 'approval', ref: 'request', epoch: 'epoch',
      call: { tool: 'routine_request', approval: { queueRef: 'request', epoch: 'epoch', action: {} } } };
    const file = join(f.dir, 'queue.json');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ item, state: 'accepted', answerId: 'stable', answer: { behavior: 'allow' } }] }));
    const execute = vi.fn(() => { throw Error('accepted replay must not execute'); });
    const queue = new ProducerApprovalQueue('routine', file, execute);
    const { wrapped } = settleWrapper(f.service, 'already', 'routine', queue);
    expect(await wrapped.respond(item, { behavior: 'allow' }, { answerId: 'stable' })).toEqual({ state: 'already' });
    expect(f.read().card?.answeredAt).toBe(1700);
    expect(f.patches()).toBe(1); expect(execute).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it('R17 history gate repairs already with equal point reads at 10 and 10,000 settled receipts', async () => {
  async function run(history: number) {
    const f = routineSettleFixture('Allowed', undefined, history);
    try {
      expect(f.routines.routineRequestReceipt(`settled-${history - 1}`)).toBeDefined();
      const point = vi.spyOn(f.store, 'messageById'), card = vi.spyOn(f.store, 'cardForRequest');
      const receipt = vi.spyOn(f.routines, 'routineRequestReceipt');
      const { wrapped } = settleWrapper(f.service, 'already', 'routine');
      expect(await wrapped.respond({ approvalId: 'approval' }, {}, {})).toEqual({ state: 'already' });
      expect(f.read().card?.answeredAt).toBe(1700); expect(f.patches()).toBe(1);
      const work = { point: point.mock.calls.length, cards: card.mock.calls.length, receipts: receipt.mock.calls.length, patches: f.patches() };
      expect(work.point).toBeLessThanOrEqual(2); expect(work.receipts).toBe(2);
      console.log('R17 history ops', history, JSON.stringify(work));
      return work;
    } finally { f.close(); }
  }
  expect(await run(10_000)).toEqual(await run(10));
});

it('completion guard cancelled wakes deduplicate their governing source', async () => {
  const f = fixture(); try {
    f.insert('C', 'done', 'ask', undefined, true);
    const request = f.insert('W1', 'cancelled', 'wake', 'C');
    const cancelled = [f.insert('W2', 'cancelled', 'wake', 'C')];
    f.make().afterRoomCompletion({ request, cancelled, wakes: [] }); await flush();
    expect(f.globals.deleteContinuation).toHaveBeenCalledTimes(1);
    expect(f.saved.size).toBe(0);
  } finally { f.close(); }
});

it.each(['page', 'boot', 'orphan', 'governing-source', 'cancellation', 'sweep-dispatch', 'dispatch-refresh'])(
  'history gate: %s does equal work at 10 and 10,000 settled rows', async scenario => {
    async function run(history: number) {
      const f = fixture(), ancestor = deferred(), own = deferred();
      try {
        for (let i = 0; i < history; i++) f.insert(`history${i}`);
        const api = f.make();
        if (scenario === 'page' || scenario === 'boot') {
          const backlog = scenario === 'page' ? 250 : 1100;
          for (let i = 0; i < backlog; i++) f.insert(`C${String(i).padStart(5, '0')}`, 'done', 'ask', undefined, true);
          await api.retireDecisionSharedSources(undefined, scenario === 'page' ? 1 : 10);
          expect(f.ops.lists).toBe(scenario === 'page' ? 1 : 10);
          expect(f.ops.deletes).toBe(scenario === 'page' ? 100 : 1000);
          expect(f.ops.examined).toBe(scenario === 'page' ? 101 : 1010);
        } else if (scenario === 'orphan') {
          f.saved.set(JSON.stringify(f.key('pruned')), {});
          await api.retireDecisionSharedSources();
          expect(f.saved.size).toBe(0);
          expect(f.ops.deletes).toBe(1);
        } else if (scenario === 'governing-source') {
          f.insert('P', 'done', 'ask', undefined, true);
          f.insert('A', 'done', 'ask', 'P'); f.insert('W', 'queued', 'wake', 'A');
          f.insert('C', 'done', 'ask', undefined, true); f.insert('held', 'queued', 'wake', 'C');
          await api.retireDecisionSharedSources();
          expect([...f.saved.keys()]).toEqual([JSON.stringify(f.key('C'))]);
          expect(f.ops.deletes).toBe(1);
        } else if (scenario === 'cancellation') {
          f.insert('C', 'done', 'ask', undefined, true);
          const request = f.insert('W1', 'cancelled', 'wake', 'C');
          const cancelled = [f.insert('W2', 'cancelled', 'wake', 'C')];
          f.saves.set('C', ancestor); f.saves.set('W2', own);
          api.afterRoomCompletion({ request, cancelled, wakes: [] }); await flush();
          expect(f.ops.reads).toBe(0); ancestor.resolve(); await flush();
          expect(f.ops.reads).toBe(0); own.resolve(); await flush();
          expect(f.saved.size).toBe(0); expect(f.ops.deletes).toBe(1);
        } else if (scenario === 'sweep-dispatch') {
          const events: string[] = [];
          const retire = vi.fn(async () => { events.push('retire'); await api.retireDecisionSharedSources(); await own.done; });
          const callback = wiringCallArg('guardedWriter', 'room-sweep', {
            roomEngine: { ready: true }, retireDecisionSharedSources: retire, sharedRetireRunning: false,
            roomDispatcher: { tick: () => events.push('dispatch') }, pumpSharedWork: () => events.push('pump'),
            resumeAllProjectCloses: vi.fn(), deliverOwedSharedResults: vi.fn(), projectCardExecutor: { pump: vi.fn() },
            store: { hasPendingWork: () => false },
          });
          const first = callback(); await flush();
          expect(events).toEqual(['dispatch', 'pump', 'retire']);
          const second = callback(); await flush(); expect(retire).toHaveBeenCalledTimes(1);
          own.resolve(); await Promise.all([first, second]); await flush();
          await callback(); await flush(); expect(retire).toHaveBeenCalledTimes(2);
        } else {
          f.insert('C', 'done', 'ask'); const request = f.insert('W', 'queued', 'wake', 'C');
          f.saves.set('C', { done: ancestor.done.then(() => f.saved.set(JSON.stringify(f.key('C')), {
            actor: 'owner-routine', initiator: { ...routine, sourceRunId: 'C' },
          })) });
          const block = wiringBlock('startTurn', 'if (opts?.sharedWorkRun)', { ...f.globals, ...api });
          const opts = { ...api.sharedTurnOptions(request), sharedWorkRun: { request }, decisionRoutineSource: { sourceRunId: 'provisional' } };
          let dispatched = false;
          const dispatch = block(opts).then((refreshed: any) => { dispatched = true; return refreshed; });
          await flush(); expect(dispatched).toBe(false); ancestor.resolve();
          expect(await dispatch).toBe(opts);
          expect(opts.decisionRoutineSource.sourceRunId).toBe('C');
        }
        f.plan(); console.log('history gate', scenario, history, JSON.stringify(f.ops));
        return { ...f.ops };
      } finally { ancestor.resolve(); own.resolve(); f.close(); }
    }
    expect(await run(10_000)).toEqual(await run(10));
  },
);

it.each(['throw', 'reject'])('retirement isolates a deletion %s and keeps paging at both history sizes', async failure => {
  async function run(history: number) {
    const f = fixture();
    try {
      for (let i = 0; i < history; i++) f.insert(`history${i}`);
      for (let i = 0; i < 150; i++) f.insert(`C${String(i).padStart(3, '0')}`, 'done', 'ask', undefined, true);
      f.globals.deleteContinuation.mockImplementationOnce(() => {
        if (failure === 'throw') throw Error('fixture deletion failure');
        return Promise.reject(Error('fixture deletion failure'));
      });
      const api = f.make();
      await api.retireDecisionSharedSources(); expect(f.saved.size).toBe(51);
      await api.retireDecisionSharedSources(); expect([...f.saved.keys()]).toEqual([JSON.stringify(f.key('C000'))]);
      await api.retireDecisionSharedSources(); expect(f.saved.size).toBe(0);
      expect(f.globals.console.error).toHaveBeenCalledTimes(1);
      f.plan(); console.log('deletion isolation', failure, history, JSON.stringify(f.ops));
      return { ...f.ops };
    } finally { f.close(); }
  }
  expect(await run(10_000)).toEqual(await run(10));
});

it('chain walks stop at asks, cycles, and 50 rows without awaiting a save outside the chain', async () => {
  const f = fixture(), outside = deferred();
  try {
    for (let i = 0; i <= 50; i++) f.insert(`W${i}`, 'done', 'wake', `W${i + 1}`, i === 50);
    const api = f.make(), request = f.row('W0');
    expect(api.chainIds(request)).toEqual(Array.from({ length: 50 }, (_, i) => `W${i}`));
    f.saves.set('W50', outside);
    expect(await Promise.race([api.awaitSharedChainSaves(request).then(() => true), flush().then(() => false)])).toBe(true);
    expect(f.ops.reads).toBe(0);
    expect(api.governingSharedSource(request)).toBeUndefined(); expect(f.ops.reads).toBe(50);
    f.db.prepare("UPDATE room_requests SET parent_id='W0' WHERE id='W1'").run();
    expect(api.chainIds(request)).toEqual(['W0', 'W1']);
    f.db.prepare("UPDATE room_requests SET verb='ask' WHERE id='W1'").run();
    expect(api.chainIds(request)).toEqual(['W0', 'W1']);
    const key = f.key('W50');
    expect(api.sharedSourceIdentity(key)).toBe(api.sharedSourceIdentity({ threadId: key.threadId, kind: key.kind, id: key.id, botId: key.botId }));
  } finally { outside.resolve(); f.close(); }
});
