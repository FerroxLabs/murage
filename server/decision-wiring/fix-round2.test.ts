// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixture } from './round3-fixture.ts';
import { expect, it, vi } from 'vitest';
import { source, wiring, routine } from './fixture.ts';

it('round2: rejected shared save still cancels before deleting transport and provenance', async () => {
  let reject!: (error: Error) => void;
  const done = new Promise<void>((_resolve, fail) => { reject = fail; });
  const provenance = new Map([['g', { botId: 'b' }]]);
  const targets = new Map([['target', { target: { threadId: 't', generation: 'g' } }]]);
  let finishCancellation!: () => void;
  const cancelled = new Promise<void>(resolve => { finishCancellation = resolve; });
  const cancelRequests = vi.fn(() => {
    expect(provenance.has('g')).toBe(true);
    expect(targets.has('target')).toBe(true);
    return cancelled;
  });
  const { releaseDecisionProvenance } = wiring(['releaseDecisionProvenance'], {
    decisionSharedSaves: new Map([['request', { generation: 'g', done }]]), cancelRequests,
    decisionProvenance: provenance, decisionRequestTargets: targets,
    decisionAuthorities: new Map(), decisionQueuePorts: new Map(), deleteContinuation: async () => {},
  });
  const released = releaseDecisionProvenance('t', 'g').catch((error: unknown) => error);
  reject(new Error('fake disk failure'));
  await new Promise(resolve => setImmediate(resolve));
  expect(cancelRequests).toHaveBeenCalledWith({ kind: 'generation', threadId: 't', generation: 'g' }, 'cancelled');
  expect(provenance.has('g')).toBe(true);
  expect(targets.has('target')).toBe(true);
  finishCancellation();
  await released;
  expect(provenance.size).toBe(0);
  expect(targets.size).toBe(0);
});

function lifecycle() {
  const f = fixture();
  f.insert('request', 'running', 'ask', undefined, true);
  f.saved.set(JSON.stringify(f.key('request')), { actor: 'owner-routine', initiator: routine });
  const changed = async (api: ReturnType<typeof f.make>, state: string, id = 'request') => {
    f.db.prepare('UPDATE room_requests SET state=? WHERE id=?').run(state, id);
    api.afterRoomCompletion({ request: f.row(id), wakes: [] });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { ...f, deleteContinuation: f.globals.deleteContinuation, changed, key: f.key('request') };
}

it.each(['done', 'cancelled'])('round2: shared %s retires its durable ancestry', async state => {
  const f = lifecycle();
  try {
    await f.changed(f.make(), state);
    expect(f.saved.size).toBe(0);
    expect(f.deleteContinuation).toHaveBeenCalledWith(f.key);
  } finally { f.db.close(); }
});

it('round2: dependent wakes retain ancestry through consumption, then retire the chain', async () => {
  const f = lifecycle();
  try {
    f.insert('wake', 'queued', 'wake', 'request');
    const api = f.make();
    await f.changed(api, 'done');
    expect(f.saved.size).toBe(1);
    // Recreate process-local wiring while the durable request tree and S1
    // boundary survive. Boot must keep the consumed parent's queued wake.
    const restarted = f.make();
    await restarted.retireDecisionSharedSources?.();
    expect(f.saved.size).toBe(1);
    expect(restarted.sharedTurnOptions({ id: 'wake', verb: 'wake', parentId: 'request', toBotId: 'recipient' }).decisionRoutineSource).toMatchObject({ sourceRunId: 'run' });
    await f.changed(restarted, 'done', 'wake');
    expect(f.saved.size).toBe(0);
  } finally { f.db.close(); }
});

it('round2: restart retires terminal leftovers and preserves queued ancestry', async () => {
  const f = lifecycle();
  try {
    f.db.exec("UPDATE room_requests SET state='queued'");
    let api = f.make();
    // Exercise the same retirement entry the production boot and sweep await.
    await api.retireDecisionSharedSources?.();
    expect(f.saved.size).toBe(1);
    f.db.exec("UPDATE room_requests SET state='unknown'");
    api = f.make();
    await api.retireDecisionSharedSources?.();
    expect(f.saved.size).toBe(0);
    expect(/await retireDecisionSharedSources\(undefined, 10\);\s*pruneTerminalRoomRequests\(db, Date\.now\(\)\)/.test(source)).toBe(true);
  } finally { f.db.close(); }
});

it('round2: HTTP memory entry calls the authenticated s2m authority route', () => {
  expect(/authenticatedMemoryAgentRoute\(internalCapabilities,\s*internalClaim,\s*path,/.test(source)).toBe(true);
  expect(/memory\/http-authority\.ts/.test(source)).toBe(true);
  expect(source).toContain('import { authenticatedMemoryAgentRoute } from "./memory/http-authority.ts";');
  expect(/async\(\)=>memoryAgentRoute\(path,/.test(source)).toBe(false);
});
