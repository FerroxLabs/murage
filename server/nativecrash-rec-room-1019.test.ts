// SPDX-License-Identifier: AGPL-3.0-or-later
// G0-W W5 room witnesses (r4 item 3): REC-ROOM (a room member's engine-input refusal tells ONE room row through R.write) and REC-RETRY-ROOM
// (the same on the "after-submission-uncertain" branch, roomResendRow, with a busy rollback injected on the first persist attempt: the retry
// lands exactly one durable room row). Production code under test: admitLedgerLease (present() room branch -> persistNote -> R.write ->
// persistLedgerRefusal) and the member's room closure from runGroupMemberTurnDispatch (roomResendRow + its roomLedgerRefusalNotes entry),
// both evaluated from index.ts; the tx scope is the real one (a rollback drops afterCommit work and never latches).
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { wiring } from "./decision-wiring/fixture.ts";
import { EventBus } from "./harness/bus.ts";
import { createLedgerLease, LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";
import { persistLedgerRefusal } from "./ledger-persistence.ts";
import { DatabaseBusyError } from "./db-busy.ts";
import { stopCloseConfirmed } from "./contracts.ts";
import { fencedRefusalRegistry, latchAfterCommit } from "./drivers/engine-input.ts";
import { afterCommit, scopedTx } from "./tx-scope.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";
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
  const busy = { on: true, rollbacks: 1 }; const noteAttempts: number[] = []; const rows: string[] = [];
  const transaction = (fn: (db: unknown) => void, opts?: { op?: string }) => scopedTx(() => {
    fn({});
    // a busy writer rolls the note's transaction back after its work ran (the REC-RETRY shape): nothing it registered for the commit lands
    if (opts?.op === "ledger-refusal-note") { noteAttempts.push(Date.now()); if (busy.rollbacks > 0) { busy.rollbacks--; throw new DatabaseBusyError("ledger-refusal-note", 50); } }
  });
  // a room member registers no direct-turn note: the room branch of present() is the one under test
  const turnRefusalNotes = new Map<string, never>();
  const roomLedgerRefusalNotes = new Map<string, () => void>();
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
    rememberReleasedStoppedTurn: noop,
    // module-level state and helpers the extracted functions close over
    stopInterrupts: new Map(), fencedRefusalRegistry, releasingEngineInput: () => true, noteRefusedLeaseTerminal: noop,
    ledgerRefusalAwaitingHandback, roomLedgerRefusalNotes, turnRefusalNotes,
    deferredRefusalNotes, refusalStopJoins: new PendingTurnKeys(), refusalStopGenerations: new PendingTurnKeys(), refusedTerminalDecisions: new Set(), lateMemoryRedispatches: new Map(),
  });
  const admit = (released: { canRetry: boolean; hasReleasedSubmission: boolean }) => g.admitLedgerLease("bot", threadId, generation,
    { turnId: `lineage-${n}` }, instance, { seal: noop, sealFencedUnwritten: () => false, ...released });
  return { db, admit, threadId, generation, providerTurnId, busy, rows, noteAttempts, deferred, refusedLeases, closeTurnLineage,
    ledgerRefusalAwaitingHandback, openLease, transaction, roomLedgerRefusalNotes, broadcast };
}


/** The member's room closure, exactly as runGroupMemberTurnDispatch declares it (roomResendRow, its latch, the roomLedgerRefusalNotes entry). */
const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const roomStart = indexSource.indexOf("  let roomResendPosted = false;\n  const roomResendRow = () => {");
const roomSet = indexSource.indexOf("  roomLedgerRefusalNotes.set(internalGeneration, tell => {", roomStart);
const roomEnd = indexSource.indexOf("\n  });\n", roomSet) + "\n  });\n".length;
if (roomStart < 0 || roomSet < 0 || roomEnd < roomSet) throw new Error("REC-ROOM must evaluate the current production room closure");
const roomClosure = ts.transpileModule(indexSource.slice(roomStart, roomEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function memberRoom(t: Awaited<ReturnType<typeof setup>>, kind: string) {
  const roomRows: string[] = [];
  const deps = {
    latchAfterCommit, threadId: t.threadId, internalGeneration: t.generation, roomLedgerRefusalNotes: t.roomLedgerRefusalNotes, ROOM_LEDGER_REFUSAL_NOTES_MAX: 64,
    // a store row is durable only when its transaction commits
    store: { appendMessage: (_thread: string, line: { memoryNote?: string; tool?: { name: string } }) => { afterCommit(() => { roomRows.push(line.memoryNote ?? line.tool!.name); }); } },
    murageLine: (line: unknown) => line, bot: { id: "bot", name: "Member", color: "blue", modelSelection: { instanceId: "inst-1" } },
    roomResendSource: undefined, instance: { driverKind: "fake" }, engineNameOf: () => "Fixture", turnRefusedLine: (_engine: string, k: string) => `refused:${k}`,
    submissionRefusalKind: () => kind, submissionBoundary: { canRetry: false },
  };
  // MA-REBUILD Q2: the member tells the row at its engine teardown (runGroupMemberTurnDispatch's teardownConfirmed hook calls this)
  const teardown = new Function(...Object.keys(deps), `${roomClosure}\nreturn () => deferredRoomRefusalNote?.();`)(...Object.values(deps)) as () => void;
  return { roomRows, teardown };
}

it("REC-RETRY-ROOM: a busy rollback of the first room resend write does not latch; the retry lands exactly one durable room row", async () => {
  const t = await setup();
  const { roomRows, teardown } = memberRoom(t, "after-submission-uncertain");
  expect(t.roomLedgerRefusalNotes.has(t.generation), "reached: the member registered its room note").toBe(true);
  const lease = t.admit({ canRetry: false, hasReleasedSubmission: false });
  lease.attach(t.providerTurnId);
  try {
    lease.onLedgerRefused(verdict);
    await flush();
    expect(roomRows, "Q2: nothing is told before the member's engine teardown").toEqual([]);
    teardown();
    await flush();
    await until(() => t.noteAttempts.length >= 2, 1500);
    expect(t.noteAttempts.length, "reached: the first attempt rolled back busy and the write was retried").toBeGreaterThanOrEqual(2);
    await until(() => roomRows.length > 0, 1000);
    await new Promise(r => setTimeout(r, 200));
    expect(roomRows, "exactly one durable room row (the resend line)").toEqual(["resend"]);
    expect(lease.fencedRefusal?.written, "R.written latched at that commit").toBe(true);
  } finally { t.db.close(); }
});

it("REC-ROOM: a room member's engine-input refusal tells one room row (the refusal line from the member) through R.write, never the host status line", async () => {
  const t = await setup();
  t.busy.rollbacks = 0;
  const { roomRows, teardown } = memberRoom(t, "before-submission");
  const lease = t.admit({ canRetry: false, hasReleasedSubmission: false });
  lease.attach(t.providerTurnId);
  try {
    lease.onLedgerRefused(verdict);
    await flush();
    expect(roomRows, "Q2: nothing is told before the member's engine teardown").toEqual([]);
    teardown();
    await flush();
    await until(() => roomRows.length > 0, 1000);
    await new Promise(r => setTimeout(r, 200));
    expect(roomRows, "one room row").toEqual(["error: refused:before-submission"]);
    expect(t.rows, "no other note").toEqual([]);
    expect(lease.fencedRefusal?.written, "told through R.write").toBe(true);
    expect(t.roomLedgerRefusalNotes.has(t.generation), "the entry is consumed").toBe(false);
  } finally { t.db.close(); }
});
