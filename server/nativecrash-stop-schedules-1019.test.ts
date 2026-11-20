// SPDX-License-Identifier: AGPL-3.0-or-later
// LLS Stop schedules (nativecrash r4 item 4): STOP-ORD, STOP-RACE, STOP-AFTER-CANCEL, STOP-ADOPT-FAIL and BUS-COMPAT.
// Every schedule is forced by gates (deferred promises the test resolves), never by timing. The production admitLedgerLease,
// interruptDirectThread, stopDirectThreadForOwner and refusedTurnOf are evaluated from index.ts (decision-wiring fixture); the bus is the
// real EventBus, the lease the real createLedgerLease, the refusal registry the real one. Only process-wide stores are stubbed.
import { describe, expect, it, vi } from "vitest";
import { wiring } from "./decision-wiring/fixture.ts";
import { EventBus } from "./harness/bus.ts";
import { AdmittedEventBus } from "./testing/admitted-event-bus.ts";
import { createLedgerLease, LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";
import { stopCloseConfirmed, type RuntimeEvent, type SourceContext } from "./contracts.ts";
import { EngineInputRevoked, fencedRefusalRegistry, refusalFor, type CloseResult } from "./drivers/engine-input.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { PendingTurnKeys } from "./fold-steps.ts";
import { expectPisStop } from "./testing/nativecrash-harness.ts";

const gate = <T = void>() => { let open!: (v: T) => void; let fail!: (e: unknown) => void; const closed = new Promise<T>((r, j) => { open = r; fail = j; }); return { closed, open, fail }; };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const settled = async (p: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> => {
  let state: "pending" | "resolved" | "rejected" = "pending";
  void p.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  await flush();
  return state;
};
const verdict = { state: "checking", reason: "not-built" } as never;
let serial = 0;

type StopAnswer = { closeConfirmed: boolean };
async function fakeInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({ instanceId: "inst-1", displayName: undefined, environment: {}, enabled: true, config: {} });
  return fake.created.get("inst-1")!.instance;
}

/** holdBrowser: Stop parks in releaseBrowserCapabilityForThread. holdLease: the lease's id-bearing interrupt parks. holdStop: the Stop's
 *  id-less interrupt parks and answers what the test opens it with. */
/** engineInput (JOINT RULING STOP-VS-REFUSAL H1): the refusal is raised at the engine's own input. "deferred": a released attempt's D7 note is
 *  owed at the lease's teardown (Q2); "l2": refused before the handback, the generic row is the L2 no-handback fallback. leaseConfirmed: the
 *  lease's id-bearing interrupt answer. attach false: the engine's turn id is attached by the test. */
async function setup(opts: { holdBrowser?: boolean; holdLease?: boolean; holdStop?: boolean; teardownConfirmed?: boolean;
  engineInput?: "deferred" | "l2"; leaseConfirmed?: boolean; attach?: boolean } = {}) {
  const n = ++serial, threadId = `thread-${n}`, generation = `gen-${n}`, providerTurnId = `pt-${n}`;
  const instance = await fakeInstance();
  const leaseGate = gate(), stopGate = gate<StopAnswer>(), browserGate = gate(), browserReached = gate(), stopReached = gate();
  const interruptTurn = vi.fn(async (_threadId: string, turnId?: string): Promise<StopAnswer> => {
    if (turnId !== undefined) { if (opts.holdLease) await leaseGate.closed; return { closeConfirmed: opts.leaseConfirmed ?? true }; }
    stopReached.open();
    return opts.holdStop ? stopGate.closed : { closeConfirmed: true };
  });
  const awaitTurnTeardown = vi.fn(async () => ({ closeConfirmed: opts.teardownConfirmed ?? true }));
  Object.assign(instance.adapter as object, { interruptTurn, awaitTurnTeardown });
  const bus = new EventBus((() => {}) as never); bus.attach([instance]);
  const cancelTurn = vi.spyOn(bus, "cancelTurn"), refuseTurn = vi.spyOn(bus, "refuseTurn"), admitNewTurn = vi.spyOn(bus, "admitNewTurn");
  const delivered: RuntimeEvent[] = []; bus.subscribe(event => { delivered.push(event); });
  const broadcast = vi.fn();
  const run = { botId: "bot", threadId, generation, phase: "running", providerTurnId };
  let current: typeof run | undefined = run;
  const directRuns = { get: () => current, current: (r: typeof run) => current === r, release: () => { current = undefined; } };
  const refusedLeases = new Map<string, unknown>();
  const noop = () => {};
  const recordStopForThread = vi.fn(), cancelDirectTurnDispatch = vi.fn(() => ({ phase: "running" }));
  const unconfirmedDirectStop = vi.fn(() => Object.assign(new Error("unconfirmed"), { code: "provider_stop_unconfirmed" }));
  // the refusal rows the owner can read: the D7 note (deferred) and the generic status line (L2)
  const rows: string[] = [];
  const appendMessage = vi.fn((_thread: string, message: { text?: string }) => { if (message?.text === LEDGER_REFUSAL_LINE) rows.push("generic-row"); });
  const deferredRefusalNotes = new Map<string, unknown>();
  /** The D7 note the handback moves into deferredRefusalNotes for a released attempt (index.ts handback, Q2). */
  const refusalNote = { note: () => { rows.push("refusal-note"); }, classify: () => "unwritten", clearCause: noop };
  const engineInput = opts.engineInput ? {
    releasingEngineInput: () => true,
    turnRefusalNotes: new Map(opts.engineInput === "deferred" ? [[providerTurnId, refusalNote]] : []),
  } : {};
  const g = wiring(["admitLedgerLease", "interruptDirectThread", "stopDirectThreadForOwner", "refusedTurnOf", "joinRefusedStop"], {
    recordStopForThread, dropAskerWakes: noop, markSendsStopped: noop, botCalls: { cancel: noop }, stopHeldVenuePosts: () => [],
    settleVenuePostCard: noop, routines: { activeBotRunForThread: () => undefined },
    bus, broadcast, windowRuntimeEvent: (e: unknown) => e, createLedgerLease, LEDGER_REFUSAL_LINE, stopCloseConfirmed,
    database: () => ({}), persistLedgerRefusal: (_db: unknown, work: () => void) => { work(); return Promise.resolve(); },
    transaction: (fn: (db: unknown) => void) => fn({}), captureSource: noop, memoryDispatches: new Map(),
    store: { markTurnToolsUnrecorded: noop, appendMessage, setTaskActivity: noop }, watchdog: { settle: noop, settleSetup: noop },
    refusedLeases, admittedLedgerLeases: new Map(), ledgerCompletionSources: new WeakMap(), ledgerLeasesByAdmission: new WeakMap(),
    ledgerProviderInstances: new WeakMap(), internalTurnOwners: new Map(), revokeInternalGeneration: noop, retireProviderTurn: noop,
    sendNoticeLine: (notice: string) => ({ notice }), murageLine: (m: unknown) => m, randomUUID: () => "uuid", Error,
    projectTurnLeases: { abandon: noop, markStopAsked: noop, releaseClosed: noop, markStopRequested: noop }, trackStopAskedInterrupt: noop, closeTurnLineage: noop, directRuns,
    replySpeakerTurns: { ended: noop }, retryDelegationsWaitingOn: noop, drainQueuedSends: noop,
    botForDirectThread: () => ({ modelSelection: { instanceId: "inst-1" } }), ownerLimitContinuations: { cancel: noop },
    limitApplications: { cancel: noop }, sealDirectAttempts: noop, settleDirectAttempts: noop, finishDirectAttemptEffects: noop,
    ownWriteHolds: { stop: noop }, callSpeech: { invalidate: noop }, replyState: { invalidate: noop },
    cancelDirectTurnDispatch, stopEmailForTurn: async () => {}, emailRuntime: {}, emailGeneration: {},
    closeOpenApprovals: noop, releaseBrowserCapabilityForThread: async () => { if (opts.holdBrowser) { browserReached.open(); await browserGate.closed; } },
    registry: { get: () => instance }, unconfirmedDirectStop, screenPollers: new Map(), finalScreenFrame: async () => {},
    rememberReleasedStoppedTurn: noop,
    // module-level state and helpers the extracted functions close over
    stopInterrupts: new Map(), fencedRefusalRegistry, releasingEngineInput: () => false, noteRefusedLeaseTerminal: noop,
    // present() reads hidden chief proposals (a32f9b9fe8) and the seal reads the confirmed owner Stops (fable-attnisoh4): unbound, both threw
    // inside the lease's own try and quarantined the refusal before it was told (every memoryRefused here read 0)
    chiefProposals: { ignores: () => false }, confirmedStopGenerations: new PendingTurnKeys(), takeReleasedStoppedTurn: () => false,
    ledgerRefusalAwaitingHandback: new Set(), roomLedgerRefusalNotes: new Map(), turnRefusalNotes: new Map(),
    deferredRefusalNotes, refusalStopJoins: new PendingTurnKeys(), refusalStopGenerations: new PendingTurnKeys(), refusedTerminalDecisions: new Set(), lateMemoryRedispatches: new Map(),
    ...engineInput,
  });
  const lease = g.admitLedgerLease("bot", threadId, generation, { turnId: `lineage-${n}` }, instance,
    { seal: noop, sealFencedUnwritten: () => false, canRetry: false, hasReleasedSubmission: opts.engineInput === "deferred" });
  if (opts.attach !== false) lease.attach(providerTurnId);
  const source = admitNewTurn.mock.results[0]!.value as SourceContext;
  const terminals = () => broadcast.mock.calls.map(([m]) => m?.event).filter(e => e?.type === "turn.completed");
  const counts = () => ({
    cancelTurn: cancelTurn.mock.calls.length, recordStop: recordStopForThread.mock.calls.length, stopNote: cancelDirectTurnDispatch.mock.calls.length,
    stopInterrupts: interruptTurn.mock.calls.filter(c => c[1] === undefined).length,
    leaseInterrupts: interruptTurn.mock.calls.filter(c => c[1] !== undefined).length,
    memoryRefused: terminals().filter(e => e.stopReason === "memory_refused").length,
    otherTerminals: terminals().filter(e => e.stopReason !== "memory_refused").length + delivered.filter(e => e.type === "turn.completed").length,
    refuseTurn: refuseTurn.mock.results.map(r => (r.value as unknown[]).length), unconfirmed: unconfirmedDirectStop.mock.calls.length,
    dupTerminalRejected: bus.dupTerminalRejected,
  });
  /** The provider's own completion of the stopped turn, arriving on the turn's source. */
  const providerCancelled = () => bus.publish({ type: "turn.completed", eventId: `cancelled-${n}`, provider: "fake", threadId, turnId: providerTurnId,
    createdAt: new Date().toISOString(), ok: false, stopReason: "cancelled" } as RuntimeEvent, source);
  const ownerStop = (): Promise<void> => g.stopDirectThreadForOwner({ id: "bot" }, threadId);
  return { g, lease, threadId, generation, providerTurnId, rows, deferredRefusalNotes, refusalNote, refusedLeases, leaseGate, stopGate, browserGate, browserReached, stopReached, counts, providerCancelled, ownerStop };
}

describe("STOP-ORD: the owner Stop route after a claimed refusal joins it", () => {
  it("lease-closed refusal (teardown held): no cancelTurn, no stop signal, no stop note, no Stop interrupt; Stop pends until the teardown", async () => {
    const t = await setup({ holdLease: true });
    t.lease.onLedgerRefused(verdict);
    await flush();
    expect(t.refusedLeases.has(t.generation), "reached: the lease verdict is set before Stop").toBe(true);
    expect(t.counts().leaseInterrupts, "reached: the lease's close is in flight and held").toBe(1);
    const stopping = t.ownerStop();
    expect(await settled(stopping), "Stop joins the held teardown").toBe("pending");
    const held = t.counts();
    expect(held, JSON.stringify(held)).toMatchObject({ cancelTurn: 0, recordStop: 0, stopNote: 0, stopInterrupts: 0, leaseInterrupts: 1 });
    t.leaseGate.open();
    expect(await settled(stopping)).toBe("resolved");
    t.providerCancelled();
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ cancelTurn: 0, recordStop: 0, stopNote: 0, stopInterrupts: 0, leaseInterrupts: 1,
      memoryRefused: 1, otherTerminals: 0, unconfirmed: 0, dupTerminalRejected: 1 });
  });

  it("driver-claimed refusal (the AC1/CX3 shape: closer driver, close held): the owner Stop takes no step of its own", async () => {
    const t = await setup();
    const R = refusalFor(new EngineInputRevoked(verdict), "test.driver.claim", { engine: "fixture", threadId: t.threadId,
      binding: { identity: { dispatchGeneration: t.generation } } as never, owner: {}, target: {} })!;
    expect([R.kind, R.closer, fencedRefusalRegistry.byGeneration(t.generation) === R], "reached: a driver-claimed turn refusal for g").toEqual(["turn", "driver", true]);
    const driverClose = gate<CloseResult>();
    void R.close(() => driverClose.closed);
    const stopping = t.ownerStop();
    expect(await settled(stopping), "Stop joins the driver's held close").toBe("pending");
    driverClose.open({ confirmed: true });
    expect(await settled(stopping)).toBe("resolved");
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ cancelTurn: 0, recordStop: 0, stopNote: 0, stopInterrupts: 0, leaseInterrupts: 0, unconfirmed: 0 });
  });
});

describe("STOP-RACE: the refusal lands while Stop is parked before its interrupt", () => {
  it("Stop first, parked on the browser release; refusal with its teardown held; release the browser: no Stop interrupt, Stop pends; then one memory_refused", async () => {
    const t = await setup({ holdBrowser: true, holdLease: true });
    const stopping = t.ownerStop();
    await t.browserReached.closed;
    expect(t.counts(), "reached: Stop ran its cancel and note before parking").toMatchObject({ cancelTurn: 1, recordStop: 1, stopNote: 1, stopInterrupts: 0 });
    t.lease.onLedgerRefused(verdict);
    await flush();
    expect(t.counts().leaseInterrupts, "reached: the lease's close is in flight and held").toBe(1);
    t.browserGate.open();
    expect(await settled(stopping), "Stop joins the held teardown (S1')").toBe("pending");
    const held = t.counts();
    expect(held.stopInterrupts, `no lookup interrupt while R.teardown is pending ${JSON.stringify(held)}`).toBe(0);
    t.leaseGate.open();
    expect(await settled(stopping)).toBe("resolved");
    t.providerCancelled();
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ cancelTurn: 1, stopInterrupts: 0, leaseInterrupts: 1, memoryRefused: 1, otherTerminals: 0,
      unconfirmed: 0, dupTerminalRejected: 1 });
  });
});

describe("STOP-AFTER-CANCEL: Stop is past its cancel and inside its interrupt when the refusal fires", () => {
  it("the lease adopts the Stop's interrupt (one interruptTurn for g); one memory_refused; the provider's cancelled completion is dropped", async () => {
    const t = await setup({ holdStop: true });
    const stopping = t.ownerStop();
    await t.stopReached.closed;
    expect(t.counts(), "reached: cancelTurn ran and the Stop interrupt is in flight").toMatchObject({ cancelTurn: 1, stopInterrupts: 1, leaseInterrupts: 0 });
    t.lease.onLedgerRefused(verdict);
    await flush();
    const held = t.counts();
    expect(held, `the refusal is told before the provider completes, with no second interrupt ${JSON.stringify(held)}`)
      .toMatchObject({ stopInterrupts: 1, leaseInterrupts: 0, memoryRefused: 1, refuseTurn: [1] });
    t.providerCancelled();
    t.stopGate.open({ closeConfirmed: true });
    expect(await settled(stopping)).toBe("resolved");
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ cancelTurn: 1, stopInterrupts: 1, leaseInterrupts: 0, memoryRefused: 1, otherTerminals: 0,
      unconfirmed: 0, dupTerminalRejected: 1 });
    expect(t.lease.fencedRefusal?.closer).toBe("lease");
    expect(await t.lease.fencedRefusal!.teardown).toEqual({ confirmed: true });
    // MODEL-PIS: a pi refusal lands at exactly this point (inside the Stop's interruptTurn); this end state is the PIS expectation
    expectPisStop({ stopSignal: end.recordStop, stopNote: end.stopNote, interruptTurn: end.stopInterrupts + end.leaseInterrupts,
      memoryRefused: end.memoryRefused, cancelledTerminals: end.otherTerminals, dupTerminalRejected: end.dupTerminalRejected, unconfirmedStop: end.unconfirmed });
  });
});

describe("STOP-AFTER-CANCEL (Stop finished): the refusal fires after a confirmed Stop, before the provider's completion", () => {
  it("the finished Stop interrupt is the lease's close (still one interruptTurn for g); one memory_refused; the cancelled completion is dropped", async () => {
    const t = await setup();
    await t.ownerStop();
    await flush();
    expect(t.counts(), "reached: Stop ran to its end, nothing refused yet").toMatchObject({ cancelTurn: 1, stopInterrupts: 1, leaseInterrupts: 0, memoryRefused: 0, unconfirmed: 0 });
    t.lease.onLedgerRefused(verdict);
    await flush();
    t.providerCancelled();
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ cancelTurn: 1, stopInterrupts: 1, leaseInterrupts: 0, memoryRefused: 1, otherTerminals: 0,
      unconfirmed: 0, dupTerminalRejected: 1 });
    expect(await t.lease.fencedRefusal!.teardown).toEqual({ confirmed: true });
  });
  it("control: a Stop the engine did not confirm is not adopted afterwards; the lease closes the turn itself", async () => {
    const t = await setup({ holdStop: true });
    const stopping = t.ownerStop();
    await t.stopReached.closed;
    t.stopGate.open({ closeConfirmed: false });
    expect(await settled(stopping), "an unrefused, unconfirmed Stop keeps its own error").toBe("rejected");
    expect(t.counts().unconfirmed).toBe(1);
    t.lease.onLedgerRefused(verdict);
    await flush();
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ stopInterrupts: 1, leaseInterrupts: 1, memoryRefused: 1 });
  });
});

describe("STOP-ADOPT-FAIL: the adopted Stop interrupt does not confirm the close", () => {
  // JOINT RULING STOP-VS-REFUSAL (fable-attnisoh4 F2): a Stop that joined a refusal's close is a fact only once that close is CONFIRMED; joined
  // and unconfirmed it answers 409 provider_stop_unconfirmed with its one chip (it used to resolve as if the engine had stopped).
  it("unconfirmed answer (held kill): the joined Stop is not a fact (one unconfirmed-Stop error), stop-failed, one memory_refused, the thread stays quarantined", async () => {
    const t = await setup({ holdStop: true, teardownConfirmed: false });
    const stopping = t.ownerStop();
    await t.stopReached.closed;
    t.lease.onLedgerRefused(verdict);
    await flush();
    expect(t.counts(), "reached: adopted, nothing settled yet").toMatchObject({ stopInterrupts: 1, leaseInterrupts: 0, unconfirmed: 0 });
    expect(await settled(stopping)).toBe("pending");
    t.stopGate.open({ closeConfirmed: false });
    expect(await settled(stopping), "a joined Stop whose close is unconfirmed is not a fact").toBe("rejected");
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ stopInterrupts: 1, leaseInterrupts: 0, memoryRefused: 1, otherTerminals: 0, unconfirmed: 1 });
    expect(await t.lease.fencedRefusal!.teardown).toEqual({ confirmed: false, reason: "stop-failed" });
    expect(t.lease.fencedRefusal!.outcome).toBe("termination-failed");
    expect(t.refusedLeases.has(t.generation), "the unconfirmed close keeps the quarantine").toBe(true);
  });

  it("rejected interrupt: the same join (one unconfirmed-Stop error, stop-failed, one memory_refused)", async () => {
    const t = await setup({ holdStop: true, teardownConfirmed: false });
    const stopping = t.ownerStop();
    await t.stopReached.closed;
    t.lease.onLedgerRefused(verdict);
    await flush();
    t.stopGate.fail(new Error("engine gone"));
    expect(await settled(stopping)).toBe("rejected");
    const end = t.counts();
    expect(end, JSON.stringify(end)).toMatchObject({ stopInterrupts: 1, leaseInterrupts: 0, memoryRefused: 1, unconfirmed: 1 });
    expect(await t.lease.fencedRefusal!.teardown).toEqual({ confirmed: false, reason: "stop-failed" });
  });
});

// JOINT RULING STOP-VS-REFUSAL INVARIANT (fable review H1): "no turn ever ends with neither a refusal row nor a confirmed Stop". An owner Stop
// that joins an engine-input refusal's close is a fact only if that close is CONFIRMED; joined and unconfirmed it answers 409 with its one
// chip (unconfirmedDirectStop), and its join marks must not then hide the refusal row as "the owner stopped first".
describe("STOP-JOIN-UNCONFIRMED: a joined Stop whose close is not confirmed never hides the engine-input refusal row", () => {
  it("deferred note (Q2): 409 + one chip, and the refusal's one row is told when the engine later confirms the close", async () => {
    const t = await setup({ holdLease: true, engineInput: "deferred", leaseConfirmed: false, teardownConfirmed: false });
    t.lease.onLedgerRefused(verdict);
    await flush();
    expect(t.counts().leaseInterrupts, "reached: the lease's close is in flight and held").toBe(1);
    const stopping = t.ownerStop();
    let error: { code?: string } | undefined; void stopping.catch(e => { error = e; });
    expect(await settled(stopping), "the Stop joins the held close").toBe("pending");
    t.leaseGate.open();
    expect(await settled(stopping), "a joined Stop whose close is unconfirmed is not a fact").toBe("rejected");
    expect(error?.code).toBe("provider_stop_unconfirmed");
    expect(t.counts().unconfirmed, "one unconfirmed chip").toBe(1);
    expect(await t.lease.fencedRefusal!.teardown).toEqual({ confirmed: false, reason: "stop-failed" });
    // the deferred row is owed at the lease's teardown: the engine confirms the close late (A5)
    t.lease.fencedRefusal!.confirmedLate();
    await flush();
    expect(t.rows, "exactly one refusal row explains the end").toEqual(["refusal-note"]);
    expect(t.counts().unconfirmed).toBe(1);
  });

  it("L2 (refused before the handback, no handback): 409 + one chip, and the generic refusal row is written once", async () => {
    const t = await setup({ holdLease: true, engineInput: "l2", attach: false, leaseConfirmed: false, teardownConfirmed: false });
    t.lease.onLedgerRefused(verdict);
    await flush();
    const stopping = t.ownerStop();
    let error: { code?: string } | undefined; void stopping.catch(e => { error = e; });
    expect(await settled(stopping), "the Stop joins the refusal's pending close").toBe("pending");
    t.lease.attach(t.providerTurnId);
    await flush();
    expect(t.counts().leaseInterrupts, "reached: the lease's close of the attached turn is in flight and held").toBe(1);
    t.leaseGate.open();
    expect(await settled(stopping)).toBe("rejected");
    expect(error?.code).toBe("provider_stop_unconfirmed");
    expect(t.counts().unconfirmed, "one unconfirmed chip").toBe(1);
    await flush();
    expect(t.rows, "exactly one refusal row explains the end").toEqual(["generic-row"]);
  });

  it("L2 + handback Q2 note (refused before the handback, the handback defers the note): 409 + one chip, and the deferred note is told once", async () => {
    const t = await setup({ holdLease: true, engineInput: "l2", attach: false, leaseConfirmed: false, teardownConfirmed: false });
    t.lease.onLedgerRefused(verdict);
    await flush();
    const stopping = t.ownerStop();
    let error: { code?: string } | undefined; void stopping.catch(e => { error = e; });
    expect(await settled(stopping), "the Stop joins the refusal's pending close").toBe("pending");
    // the handback (index.ts, Q2): a released attempt's note is deferred to the engine's teardown; with R the L2 fallback stays armed for it
    t.lease.attach(t.providerTurnId);
    t.deferredRefusalNotes.set(t.providerTurnId, t.refusalNote);
    await flush();
    expect(t.counts().leaseInterrupts, "reached: the lease's close of the attached turn is in flight and held").toBe(1);
    t.leaseGate.open();
    expect(await settled(stopping)).toBe("rejected");
    expect(error?.code).toBe("provider_stop_unconfirmed");
    expect(t.counts().unconfirmed, "one unconfirmed chip").toBe(1);
    await flush();
    expect(t.rows, "exactly one refusal row explains the end: the deferred note, not the generic line").toEqual(["refusal-note"]);
  });
});

describe("BUS-COMPAT: the fixture bus (terminal, then cancelTurn) under S2 arbitration", () => {
  const event = (type: string, turnId: string, eventId: string, over: object = {}): RuntimeEvent =>
    ({ type, eventId, turnId, provider: "fake", providerInstanceId: "p1", threadId: "thread-compat", createdAt: new Date().toISOString(), ...over }) as RuntimeEvent;
  it("each fixture turn delivers its one terminal in order; a consumed turn's source is dead and cannot disturb the next turn", async () => {
    const bus = new AdmittedEventBus((() => {}) as never);
    const admitted = vi.spyOn(bus, "admitNewTurn");
    const seen: string[] = []; bus.subscribe(e => { seen.push(String(e.eventId)); });
    const completed1 = event("turn.completed", "t1", "c1", { ok: true });
    bus.publish(event("turn.started", "t1", "s1"));
    bus.publish(completed1);
    const first = admitted.mock.results[0]!.value as SourceContext;
    expect(bus.audienceFor(completed1).filter(e => e.event.type === "turn.completed"), "the fixture terminal reaches its audience").toHaveLength(1);
    bus.publish(event("turn.started", "t2", "s2"));
    const second = admitted.mock.results[1]!.value as SourceContext;
    expect(second).not.toBe(first);
    // late traffic on the consumed first source: rejected before intake, the duplicate terminal counted
    const intake = vi.spyOn(bus.collector, "intake");
    bus.publish(event("item.completed", "t1", "late-item"), first);
    bus.publish(event("turn.completed", "t1", "late-done", { ok: false }), first);
    expect(bus.dupTerminalRejected).toBe(1);
    expect(intake.mock.calls.length, "nothing of a consumed source reaches intake").toBe(0);
    expect(bus.refuseTurn("thread-compat", first), "a consumed source owes no refusal").toEqual([]);
    // the live second turn still owns the thread: its refusal is the one terminal
    expect(bus.refuseTurn("thread-compat", second)).toHaveLength(1);
    bus.publish(event("turn.completed", "t2", "c2", { ok: true }), second);
    expect(seen).toEqual(["s1", "c1", "s2"]);
    expect(bus.dupTerminalRejected).toBe(2);
  });
});
