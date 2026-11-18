// SPDX-License-Identifier: AGPL-3.0-or-later
// G0 (nativecrash), REC-DEFERRED-BUSY: the deferred refusal row a released attempt owes at the lease's teardown (MA-REBUILD Q2, inside G0's
// admitLedgerLease) is never silently lost on a busy database. Schedule, gate-forced: the note's transaction is busy (DatabaseBusyError, the
// shape transaction() throws after its busyMs) from the refusal until the test releases it; the teardown runs while it is still busy.
// The production admitLedgerLease is evaluated from index.ts with the real createLedgerLease, EventBus and persistLedgerRefusal.
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { wiring } from "./decision-wiring/fixture.ts";
import { EventBus } from "./harness/bus.ts";
import { createLedgerLease, LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";
import { persistLedgerRefusal } from "./ledger-persistence.ts";
import { DatabaseBusyError } from "./db-busy.ts";
import { stopCloseConfirmed } from "./contracts.ts";
import { fencedRefusalRegistry, writeHandbackRefusalNote } from "./drivers/engine-input.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { PendingTurnKeys } from "./fold-steps.ts";

const verdict = { state: "checking", reason: "not-built" } as never;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const until = async (done: () => boolean, ms: number) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); };

let serial = 0;
/** holdLease: the lease's id-bearing interrupt (its one close) parks until leaseGate opens. */
async function setup(opts: { holdLease?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const n = ++serial, threadId = `thread-${n}`, generation = `gen-${n}`, providerTurnId = `pt-${n}`;
  let openLease!: () => void; const leaseGate = new Promise<void>(r => { openLease = r; });
  const fake = makeFakeDriver();
  await fake.driver.create({ instanceId: "inst-1", displayName: undefined, environment: {}, enabled: true, config: {} });
  const instance = fake.created.get("inst-1")!.instance;
  Object.assign(instance.adapter as object, { interruptTurn: vi.fn(async () => { if (opts.holdLease) await leaseGate; return { closeConfirmed: true }; }), awaitTurnTeardown: vi.fn(async () => ({ closeConfirmed: true })) });
  const bus = new EventBus((() => {}) as never); bus.attach([instance]);
  const broadcast = vi.fn();
  const directRuns = { get: () => undefined, current: () => false, release: () => {} };
  const refusedLeases = new Map<string, unknown>();
  const noop = () => {};
  const closeTurnLineage = vi.fn(), ledgerRefusalAwaitingHandback = new Set<string>();
  const recordStopForThread = vi.fn(), cancelDirectTurnDispatch = vi.fn(), unconfirmedDirectStop = vi.fn();
  // the busy gate: while held, the refusal note's transaction throws busy; every other write goes through
  const busy = { on: true }; const noteAttempts: number[] = []; const rows: string[] = [];
  const transaction = (fn: (db: unknown) => void, opts?: { op?: string }) => {
    if (opts?.op === "ledger-refusal-note") { noteAttempts.push(Date.now()); if (busy.on) throw new DatabaseBusyError("ledger-refusal-note", 50); }
    return fn({});
  };
  const turnRefusalNotes = new Map([[providerTurnId, { note: (kind: string) => { rows.push(`refusal-row:${kind}`); }, classify: () => "unwritten", clearCause: noop }]]);
  const deferred: string[] = [];
  const deferredRefusalNotes = new (class extends Map<string, unknown> { override set(k: string, v: unknown) { deferred.push(k); return super.set(k, v); } })();
  const g = wiring(["admitLedgerLease"], {
    recordStopForThread, dropAskerWakes: noop, markSendsStopped: noop, botCalls: { cancel: noop }, stopHeldVenuePosts: () => [],
    settleVenuePostCard: noop, routines: { activeBotRunForThread: () => undefined },
    bus, broadcast, windowRuntimeEvent: (e: unknown) => e, createLedgerLease, LEDGER_REFUSAL_LINE, stopCloseConfirmed,
    database: () => db, persistLedgerRefusal, transaction, captureSource: noop, memoryDispatches: new Map(),
    store: { markTurnToolsUnrecorded: noop, appendMessage: noop, setTaskActivity: noop }, watchdog: { settle: noop, settleSetup: noop },
    refusedLeases, admittedLedgerLeases: new Map(), ledgerCompletionSources: new WeakMap(), ledgerLeasesByAdmission: new WeakMap(),
    ledgerProviderInstances: new WeakMap(), internalTurnOwners: new Map(), revokeInternalGeneration: noop, retireProviderTurn: noop,
    sendNoticeLine: (notice: string) => ({ notice }), murageLine: (m: unknown) => m, randomUUID: () => "uuid", Error,
    projectTurnLeases: { abandon: noop, markStopRequested: noop }, closeTurnLineage, directRuns,
    replySpeakerTurns: { ended: noop }, retryDelegationsWaitingOn: noop, drainQueuedSends: noop,
    botForDirectThread: () => ({ modelSelection: { instanceId: "inst-1" } }), ownerLimitContinuations: { cancel: noop },
    limitApplications: { cancel: noop }, sealDirectAttempts: noop, settleDirectAttempts: noop, finishDirectAttemptEffects: noop,
    ownWriteHolds: { stop: noop }, callSpeech: { invalidate: noop }, replyState: { invalidate: noop },
    cancelDirectTurnDispatch, stopEmailForTurn: async () => {}, emailRuntime: {}, emailGeneration: {},
    closeOpenApprovals: noop, releaseBrowserCapabilityForThread: async () => {},
    registry: { get: () => instance }, unconfirmedDirectStop, screenPollers: new Map(), finalScreenFrame: async () => {},
    rememberReleasedStoppedTurn: noop, takeReleasedStoppedTurn: () => false, // MA-REBUILD Q2: no owner Stop on this turn
    // module-level state and helpers the extracted functions close over
    stopInterrupts: new Map(), fencedRefusalRegistry, releasingEngineInput: () => true, noteRefusedLeaseTerminal: noop,
    ledgerRefusalAwaitingHandback, roomLedgerRefusalNotes: new Map(), turnRefusalNotes,
    deferredRefusalNotes, refusalStopJoins: new PendingTurnKeys(), refusalStopGenerations: new PendingTurnKeys(), refusedTerminalDecisions: new Set(), lateMemoryRedispatches: new Map(),
  });
  const admit = (released: { canRetry: boolean; hasReleasedSubmission: boolean }) => g.admitLedgerLease("bot", threadId, generation,
    { turnId: `lineage-${n}` }, instance, { seal: noop, sealFencedUnwritten: () => false, ...released });
  return { db, admit, threadId, generation, providerTurnId, busy, rows, noteAttempts, deferred, refusedLeases, closeTurnLineage,
    ledgerRefusalAwaitingHandback, openLease, transaction };
}

it("REC-DEFERRED-BUSY: a busy database at the lease teardown delays the deferred refusal row and never loses it (one row once free)", async () => {
  const t = await setup();
  const lease = t.admit({ canRetry: false, hasReleasedSubmission: true });
  lease.attach(t.providerTurnId);
  try {
    lease.onLedgerRefused(verdict);
    await flush();
    await until(() => t.noteAttempts.length > 0, 1000);
    expect(t.noteAttempts.length, "reached: the teardown told the deferred row while the database was busy").toBeGreaterThan(0);
    expect(t.deferred, "reached: the released attempt deferred its row to the teardown").toEqual([t.providerTurnId]);
    expect(t.rows, "still busy: nothing written yet").toEqual([]);
    t.busy.on = false;
    await until(() => t.rows.length > 0, 1500);
    expect(t.rows, "the owner's refusal row is written once the database is free").toEqual(["refusal-row:unwritten"]);
    await new Promise(r => setTimeout(r, 300));
    expect(t.rows, "exactly one row").toEqual(["refusal-row:unwritten"]);
  } finally { t.db.close(); }
});

// G0-W M1 (reserveWrite). Schedule, gate-forced: the refusal lands at the engine's input before the handback (no provider turn id), its
// close is held; the late handback starts its note through the real writeHandbackRefusalNote on the retrying persisted sink while the note
// transaction is busy (test-only busy seam: the injected transaction keyed by op "ledger-refusal-note"); then the close confirms. The lease
// teardown (refusedLeases.delete, closeTurnLineage, bot idle) must wait for that note's commit: reserveWrite is the only thing holding it.
it("G0-W M1: the lease teardown waits for the handback note's commit on a busy database (reserveWrite), then runs once", async () => {
  const t = await setup({ holdLease: true });
  const lease = t.admit({ canRetry: false, hasReleasedSubmission: false });
  try {
    lease.onLedgerRefused(verdict);
    await flush();
    const R = lease.fencedRefusal;
    expect(R, "reached: the lease carries its refusal").toBeDefined();
    expect(t.ledgerRefusalAwaitingHandback.has(t.generation), "reached: the refusal waits for the handback").toBe(true);
    // the handback site: attach the engine's turn id (the lease's close starts and is held), then tell the note
    lease.attach(t.providerTurnId);
    await flush();
    const handback = writeHandbackRefusalNote(R, work => persistLedgerRefusal(t.db, work),
      () => t.transaction(() => { t.rows.push("handback-note"); }, { op: "ledger-refusal-note" }), () => {});
    await until(() => t.noteAttempts.length > 0, 1000);
    expect(t.noteAttempts.length, "reached: the handback note met the busy database").toBeGreaterThan(0);
    t.openLease();
    await flush();
    await new Promise(r => setTimeout(r, 250));
    expect(t.rows, "still busy: no row yet").toEqual([]);
    expect([t.refusedLeases.has(t.generation), t.closeTurnLineage.mock.calls.length], "the teardown is held while the owner's note is owed")
      .toEqual([true, 0]);
    t.busy.on = false;
    await handback;
    await until(() => t.closeTurnLineage.mock.calls.length > 0, 1500);
    expect(t.rows, "one row: the handback note (the generic fallback joined its write)").toEqual(["handback-note"]);
    expect([t.refusedLeases.has(t.generation), t.closeTurnLineage.mock.calls.length], "after the commit the teardown runs once").toEqual([false, 1]);
  } finally { t.db.close(); }
});
