// cause23 (TRIAGE-STOPS-1122 row 3): the owner types mid-turn while the running session is checking:pending.
// Owners: steer door decision (steer-door.ts) and these witnesses: cause23-steerpending. Proof producer: session-proof.ts (memory owners).
// The real receipt and the real proof over a real database decide the state; the door is the one the send route in index.ts calls.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database, closeDatabase } from '../database.ts';
import { continuationMemoryRevoked, resetSessionHolds } from './disclosures.ts';
import { verdictStore } from './verdict-store.ts';
import { MemoryDispatchReceipt } from './dispatch.ts';
import { buildMemoryBundle } from './bundle.ts';
import { LineageAllowance, recordSessionRoots } from './replay-lineage.ts';
import { commitRevoke } from './revoke-commit.ts';
import { resetRevokeWriteBudget, revokePaceTestHooks } from './revoke-budget.ts';
import { setScopeFlowEdgesRecorded } from './revoke-marker.ts';
import { freshDataDir, accessFor } from './testing/recall-fixture.ts';
import { CONTENT, WritetimeFixture, stampFreshSession } from './testing/writetime-fixture.ts';
import { sessionKeyOf } from './session-incarnation.ts';
import { initializeFreshSessionProof } from './session-proof.ts';
import { noteSessionFrame } from './session-proof-schema.ts';
import { clearResetWatch, continuationResetCounts } from './reset-watch.ts';
import { steerDoor } from './steer-door.ts';
import { openTurnLineage, closeTurnLineage, addTurnParents } from './lineage-write.ts';
import { prepareRetainedFence, assertRetainedFence } from './send-fence.ts';
import { refsLookup } from './deny-read.ts';
import type { LineageRef } from './lineage-types.ts';
import { steerWithQuoteLineage } from '../steer-lineage.ts';

beforeEach(() => { freshDataDir('active'); resetSessionHolds(); resetRevokeWriteBudget(); setScopeFlowEdgesRecorded(true); revokePaceTestHooks.osUnknown = true; clearResetWatch(); });
afterEach(() => { vi.restoreAllMocks(); revokePaceTestHooks.osUnknown = false; setScopeFlowEdgesRecorded(false); clearResetWatch(); closeDatabase(); });
const key = sessionKeyOf('thread', 'engine', 'fixture-session');
// The proven running session of continuation-settle.test.ts: one delivered frame, its references complete.
function session() {
  const db = database(), f = new WritetimeFixture(db);
  f.cert(true).ready('thread', true).owner('thread', 'shown-owner-line', 20).ready('other', true).owner('other', 'other-owner-line', 25);
  db.exec('UPDATE memory_lsn SET next=100 WHERE id=1');
  stampFreshSession(db, key.threadId, key.driverInstance, key.nativeSession);
  db.prepare('UPDATE memory_session_lineage SET first_lsn=10,last_lsn=90 WHERE thread_id=?').run('thread');
  recordSessionRoots(key.threadId, key.driverInstance, key.nativeSession, { roots: new Set(), over: false });
  noteSessionFrame(db, key, false);
  initializeFreshSessionProof(key, accessFor().access, () => {
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) SELECT 'fixture-receipt',?,?,?,'[]','[]',policy_revision,deletion_epoch,0,'delivered',1 FROM memory_meta WHERE id=1").run(key.threadId, key.driverInstance, key.nativeSession);
    noteSessionFrame(db, key, true);
  });
  db.prepare('UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance=? AND native_session=?').run(key.threadId, key.driverInstance, key.nativeSession);
  return { db, f };
}
// The running turn's receipt, resuming that session (as index.ts builds it for a resumed direct turn).
async function runningReceipt() {
  const access = accessFor().access;
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle('', access, { async search() { return { hits: [], vectorRows: 0 }; } }, { allowance: LineageAllowance.tool() }), access, key.driverInstance);
  receipt.resumes(key.nativeSession);
  return receipt;
}
const door = (receipt: MemoryDispatchReceipt, ownerKeepsPending: boolean) =>
  steerDoor({ state: receipt.steerState(), tainted: () => false, ownerKeepsPending, threadId: key.threadId, engine: key.driverInstance });
const logged = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map(call => String(call[0])).join("\n");

it('C23-W3 an owner steer while the session is checking:pending is steered: no reset line, no reset counted, the continuation kept', async () => {
  const w = session();
  w.f.pending('thread', 1);
  const receipt = await runningReceipt();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const lose = vi.spyOn(verdictStore, 'loseHold');
  expect(receipt.steerState()).toBe('pending');
  expect(door(receipt, true)).toBe(true);
  expect(continuationResetCounts()).toEqual([]);
  expect(logged(warn)).not.toMatch(/continuation reset|steer-refused session-invalid/);
  expect(logged(warn)).toContain('memory steer kept thread=thread engine=engine reason=checking:pending');
  // the session's hold is not consumed: the next owner turn still keeps it under the same verdict (continuation kept, resumed)
  expect(lose).not.toHaveBeenCalled();
  const why: { reason?: string; kept?: boolean } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, accessFor().access, why, true)).toBe(false);
  expect(why).toEqual({ reason: 'checking:pending', kept: true });
});

it('C23-W3b a steer under checking:pending that the owner rule does not cover (not an owner turn, or a quote) is deferred, never counted as a reset', async () => {
  const w = session();
  w.f.pending('thread', 1);
  const receipt = await runningReceipt();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(door(receipt, false)).toBe(false);
  expect(continuationResetCounts()).toEqual([]);
  expect(logged(warn)).toContain('memory steer deferred thread=thread engine=engine reason=checking-pending');
  expect(logged(warn)).not.toMatch(/continuation reset/);
});

it('C23-W3c a settled revoke of a line the session held still refuses the owner steer and resets: nothing crosses the boundary', async () => {
  const w = session();
  commitRevoke(w.db, { kind: 'line', threadId: 'thread', messageIds: ['shown-owner-line'], cause: 'edit' }, { inline: false });
  // the turn's own check finishes the revoke's walk: a settled deny, which the owner rule never keeps
  const settled: { reason?: string; kept?: boolean } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, accessFor().access, settled, true)).toBe(true);
  expect(settled.kept).toBeUndefined();
  const receipt = await runningReceipt();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(receipt.steerState()).toBe('refused');
  expect(door(receipt, true)).toBe(false);
  expect(continuationResetCounts()).toMatchObject([{ threadId: 'thread', count: 1, reasons: ['steer-refused session-invalid'] }]);
  expect(logged(warn)).toContain('memory continuation reset thread=thread engine=engine reason=steer-refused session-invalid');
});

it('C23-W3d a proven session steers with no line at all, and a sealed one is refused as sealed, not as a reset', async () => {
  session();
  const receipt = await runningReceipt();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(receipt.steerState()).toBe('holds');
  expect(receipt.steerable()).toBe(true);
  expect(door(receipt, false)).toBe(true);
  expect(warn).not.toHaveBeenCalled();
  expect(steerDoor({ state: 'refused', tainted: () => true, ownerKeepsPending: true, threadId: key.threadId, engine: key.driverInstance })).toBe(false);
  expect(logged(warn)).toContain('reason=steer-refused sealed');
  expect(continuationResetCounts()).toEqual([]);
});

it('C23-W3e the send route keeps a pending steer only for the running owner-keep turn and only for the words alone; the flag is set only by an owner-keep dispatch', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toContain('if (ownerMayKeepPending) turnOutputRoots.get(threadId)!.ownerKeepsPending = true;');
  // the route's own predicate, taken from index.ts and run against a running-turn map
  const at = source.indexOf('const steerOwnerKeepsPending = (): boolean =>');
  expect(at).toBeGreaterThan(0);
  const code = ts.transpileModule(source.slice(at, source.indexOf('\n', at)) + '\nreturn steerOwnerKeepsPending;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const keeps = (running: object | undefined, replyTo: object | undefined) =>
    (new Function('replyTo', 'turnOutputRoots', 'threadId', code)(replyTo, new Map(running ? [['thread', running]] : []), 'thread') as () => boolean)();
  expect(keeps({ ownerKeepsPending: true }, undefined)).toBe(true);
  expect(keeps({ ownerKeepsPending: true }, { id: 'quoted-reply' })).toBe(false);
  expect(keeps({}, undefined)).toBe(false);
  expect(keeps(undefined, undefined)).toBe(false);
  expect(source).toContain('steerDoor({ state: steerSessionState(), tainted: steerSessionTainted, ownerKeepsPending: steerOwnerKeepsPending(),');
});

// cause23 r2 (ASTRA + FABLE BLOCK High on e9df209076): the door keeps the owner's steer, then the steer's real write must not refuse it.
// The running turn holds context the engine already has; a revoke walk over its thread is still pending. Real retained ledger, real
// send fence, real deny reader, the real steer write (steerWithQuoteLineage -> steerBusyDesk -> steerBuilt); only the engine is a recorder.
const heldRef = (): LineageRef => ({ kind: 'prefix', threadId: 'T', headLsn: 90, held: 80, shown: ['safe'] });
const writes: WritetimeFixture[] = [];
afterEach(() => { for (const f of writes.splice(0)) f.close(); });
function runningTurn(continuePending?: () => boolean) {
  const f = new WritetimeFixture(); writes.push(f);
  f.cert(true).ready('T', true).reply('T', 'safe', 85, { turnLsn: 70 });
  const refused = vi.fn();
  const turn = openTurnLineage(f.db, { threadId: 'T', turnId: `running-${writes.length}` });
  prepareRetainedFence(turn, CONTENT, refused, f.db, continuePending);
  addTurnParents(turn, [heldRef()]);
  expect(() => assertRetainedFence(turn, f.db)).not.toThrow();
  f.job(1, 50).pending('*', 1);
  expect(refsLookup(f.db, [heldRef()], CONTENT)).toMatchObject({ state: 'checking', reason: 'pending' });
  const sent: unknown[] = [];
  const engine = { capabilities: { queueing: true }, steer: async (_thread: string, text: unknown, beforeWrite?: () => void) => { beforeWrite?.(); sent.push(text); return true; } };
  const steer = () => steerWithQuoteLineage(engine, 'T', 'and use the side door', true, { holds: () => true, steerId: 'owner-steer', lineage: undefined, turn, reader: CONTENT });
  return { f, turn, refused, sent, steer, close: () => closeTurnLineage(turn) };
}

it('C23-W4 an owner steer while the held context is checking:pending is written: steered, no fence refusal, no reset, the turn keeps running', async () => {
  const told = vi.fn(() => true);
  const w = runningTurn(told);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const held = structuredClone(w.turn.parents);
    const delivery = await w.steer().catch((error: unknown) => error);
    expect(delivery).toBe('steer');
    // the steer's own write consulted the owner hook (the A-5 continue at the engine-input fence), before any later release
    expect(told).toHaveBeenCalled();
    expect(w.refused).not.toHaveBeenCalled();
    expect(JSON.stringify(w.sent)).toContain('and use the side door');
    // the held context is unchanged and the running turn is still open: its next release continues under A-5 as before
    expect(w.turn.parents).toEqual(held);
    expect(() => assertRetainedFence(w.turn, w.f.db)).not.toThrow();
    expect(continuationResetCounts()).toEqual([]);
    expect(logged(warn)).not.toMatch(/continuation reset|retained fence refused/);
  } finally { w.close(); }
});

it('C23-W4b guard: the same steer on a turn with no owner hook (any other audience) is still refused at the write, the engine gets nothing', async () => {
  const w = runningTurn();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const delivery = await w.steer().catch((error: unknown) => error);
    expect(delivery).not.toBe('steer');
    expect(w.sent).toEqual([]);
    expect(w.refused).toHaveBeenCalledTimes(1);
  } finally { w.close(); }
});
