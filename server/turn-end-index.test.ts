// The index presenters and Stop route, driven as the shipped functions (extracted from index.ts) over the real createLedgerLease.
import { describe, expect, it, vi, afterEach } from "vitest";
import { wiring } from "./decision-wiring/fixture.ts";
import { createLedgerLease } from "./ledger-refusal.ts";
import { createTurnCardGate } from "./turn-card-gate.ts";
import { LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT, MCP_NOT_READY_TEXT } from "./turn-end.ts";
import { sendNoticeLine } from "./send-store.ts";
import { SEND_NOTICE_ENGLISH } from "../shared/send-notice.ts";

const verdict = { state: "checking", reason: "not-built" } as const;
afterEach(() => vi.restoreAllMocks());

function harness(attach = true) {
  const captured: { text: string; outcome: string }[] = [], appended: unknown[] = [], calls: string[] = [];
  const leases = new Map<string, unknown>();
  const globals = {
    bus: { admitNewTurn: () => ({}), refuseTurn: () => { calls.push("bus.refuseTurn"); return []; } },
    database: () => ({}), createLedgerLease, turnCardGate: createTurnCardGate(),
    persistLedgerRefusal: (_db: unknown, work: () => void) => { work(); return Promise.resolve(); },
    transaction: (work: (db: unknown) => void) => work({}),
    captureSource: (_db: unknown, row: { text: string; outcome: string }) => { captured.push({ text: row.text, outcome: row.outcome }); },
    store: { appendMessage: (_thread: string, message: unknown) => { appended.push(message); }, markTurnToolsUnrecorded() {}, setTaskActivity() {} },
    murageLine: (line: unknown) => line, sendNoticeLine, randomUUID: () => "id",
    admittedLedgerLeases: leases, ledgerCompletionSources: new Map(), ledgerLeasesByAdmission: new Map(), ledgerProviderInstances: new WeakMap(),
    refusedLeases: new Map(), internalTurnOwners: new Map(), memoryDispatches: new Map(), projectTurnLeases: { abandon() {} },
    watchdog: { settle: () => { calls.push("watchdog.settle"); } },
    revokeInternalGeneration() {}, retireProviderTurn() {}, closeTurnLineage() {}, retryDelegationsWaitingOn() {}, drainQueuedSends() {},
    directRuns: { get: () => undefined }, replySpeakerTurns: { ended() {} }, stopCloseConfirmed: () => true,
    broadcast: () => {}, windowRuntimeEvent: (e: unknown) => e,
    // NC+MA Q2 module state the lease's teardown reads: this fixture models no deferred refusal row
    deferredRefusalNotes: new Map(), refusedTerminalDecisions: new Set(), lateMemoryRedispatches: new Map(),
  };
  const { admitLedgerLease } = wiring(["admitLedgerLease"], globals);
  const instance = { instanceId: "I", adapter: { interruptTurn: async () => ({}), awaitTurnTeardown: async () => ({ closeConfirmed: true }) } };
  const boundary = { seal() {} };
  const lease = admitLedgerLease!("B", "T", "G", { turnId: "L" }, instance, boundary) as ReturnType<typeof createLedgerLease>;
  if (attach) lease.attach("P");
  return { lease, captured, appended, calls, leases };
}

describe("index presenters: stored source and the owner's line come from the frozen result", () => {
  it("MCP cause: the stored source and the status line are the MCP sentence", () => {
    const h = harness(); h.lease.noteCause("mcp-cloud-unavailable"); h.lease.onLedgerRefused(verdict);
    expect(h.captured).toEqual([{ text: MCP_CLOUD_UNAVAILABLE_TEXT, outcome: "memory-refused" }]);
    expect(h.appended).toEqual([{ role: "bot", kind: "text", actorKind: "murage", murage: { kind: "status" }, text: MCP_CLOUD_UNAVAILABLE_TEXT, turnId: "P" }]);
  });
  it("not-ready cause and ledger alone", () => {
    const n = harness(); n.lease.noteCause("mcp-not-ready"); n.lease.onLedgerRefused(verdict);
    expect(n.captured.map(c => c.text)).toEqual([MCP_NOT_READY_TEXT]);
    const l = harness(); l.lease.onLedgerRefused(verdict);
    expect(l.captured.map(c => c.text)).toEqual([LEDGER_REFUSAL_LINE]);
  });
  it.each(["toolTurnRefused", "stepTurnRefused"] as const)("send-notice:%s alone: the source stores the notice sentence and the stored row is the notice row", code => {
    const h = harness(false); h.lease.admissionNotLaunched(code); h.lease.onLedgerRefused(verdict);
    expect(h.captured.map(c => c.text)).toEqual([SEND_NOTICE_ENGLISH[code]]);
    expect(h.appended).toEqual([sendNoticeLine(code)]);
  });
  it.each(["toolTurnRefused", "stepTurnRefused"] as const)("send-notice:%s after the refusal settled: the ledger sentence stays, no notice row", code => {
    const h = harness(false); h.lease.onLedgerRefused(verdict); h.lease.admissionNotLaunched(code);
    expect(h.captured.map(c => c.text)).toEqual([LEDGER_REFUSAL_LINE]);
    expect(h.appended.map(m => (m as { text?: string }).text)).toEqual([LEDGER_REFUSAL_LINE]);
  });
  it.each(["toolTurnRefused", "stepTurnRefused"] as const)("send-notice:%s then the not-ready cause: the cause sentence wins in the source and the row", code => {
    const h = harness(false); h.lease.admissionNotLaunched(code); h.lease.noteCause("mcp-not-ready"); h.lease.onLedgerRefused(verdict);
    expect(h.captured.map(c => c.text)).toEqual([MCP_NOT_READY_TEXT]);
    expect(h.appended.map(m => (m as { text?: string }).text)).toEqual([MCP_NOT_READY_TEXT]);
  });
  it("an MCP cause beats an admission notice in the source and the row", () => {
    const h = harness(false); h.lease.admissionNotLaunched("toolTurnRefused"); h.lease.noteCause("mcp-cloud-unavailable"); h.lease.onLedgerRefused(verdict);
    expect(h.captured.map(c => c.text)).toEqual([MCP_CLOUD_UNAVAILABLE_TEXT]);
    expect(h.appended).toHaveLength(1); expect((h.appended[0] as { text: string }).text).toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
  });
  it("M9: Stop after an admission notice stores no line and no notice row, but settlement and terminal control still run", () => {
    const h = harness(false); h.lease.admissionNotLaunched("toolTurnRefused"); h.lease.noteCause("owner-stop"); h.lease.onLedgerRefused(verdict);
    expect(h.captured).toEqual([]); expect(h.appended).toEqual([]);
    expect(h.calls).toEqual(["watchdog.settle", "bus.refuseTurn"]);
  });
});

describe("the Stop route notes the owner's Stop on the admitted lease before the shared interrupt", () => {
  function stopRig() {
    const h = harness();
    const order: string[] = [];
    const directRuns = { get: (thread: string) => (thread === "T" ? { generation: "G" } : undefined) };
    const { stopDirectThreadForOwner, noteOwnerStop } = wiring(["stopDirectThreadForOwner", "noteOwnerStop"], {
      directRuns, internalTurnOwners: new Map(), admittedLedgerLeases: h.leases, turnCardGate: createTurnCardGate(),
      callSpeech: { invalidate() {} }, replyState: { invalidate() {} }, dropAskerWakes() {}, recordStopForThread() {}, markSendsStopped() {},
      database: () => ({}), botCalls: { cancel() {} }, stopHeldVenuePosts: () => [], settleVenuePostCard() {},
      routines: { activeBotRunForThread: () => undefined },
      cancelDirectTurnDispatch() {},
      interruptDirectThread: async () => { order.push("interrupt"); h.lease.onLedgerRefused(verdict); }, // the shared path ends by revoking: the ledger seals the turn
    });
    return { h, order, stop: stopDirectThreadForOwner!, note: noteOwnerStop! };
  }
  it("Stop button: the owner sees no refusal sentence, one settlement, and the interrupt still ran", async () => {
    const { h, order, stop } = stopRig();
    await stop({ id: "B" }, "T");
    expect(order).toEqual(["interrupt"]);
    expect(h.captured).toEqual([]); expect(h.appended).toEqual([]);
    expect(h.calls).toEqual(["watchdog.settle", "bus.refuseTurn"]);
  });
  it("the shared interrupt alone (no owner Stop, e.g. a project edit) keeps the ledger sentence", async () => {
    const { h } = stopRig();
    h.lease.onLedgerRefused(verdict);
    expect(h.captured.map(c => c.text)).toEqual([LEDGER_REFUSAL_LINE]);
  });
  it("an owner Stop that arrives after the ledger already settled changes nothing and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { h, note } = stopRig();
    h.lease.onLedgerRefused(verdict); note("T");
    expect(h.captured.map(c => c.text)).toEqual([LEDGER_REFUSAL_LINE]);
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause"))).toEqual([["[turn] late-cause=owner-stop after=ledger"]]);
  });
});
