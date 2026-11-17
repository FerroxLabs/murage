// Real Stop/browser-release/runtime-error paths over createLedgerLease; the fixture extracts shipped index.ts code.
import { describe, expect, it, vi, afterEach } from "vitest";
import { stopCardRig } from "./decision-wiring/turn-card-fixture.ts";
const rig = (options: { attached?: boolean; running?: boolean; persistence?: "immediate" | "held" } = {}) => stopCardRig("", {}, options);
const ENGINE_LINE = "The engine closed before it answered.";
afterEach(() => vi.restoreAllMocks());

it("a continuing tool warning does not freeze the running turn's terminal result", () => {
  const r = rig();
  r.built.foldRuntimeError!({ type: "runtime.error", threadId: "T", turnId: "P", providerInstanceId: "I", eventId: "warning",
    provider: "openai-compat", message: "Optional tools are unavailable.", nonTerminal: true });
  expect(r.pushed.map(m => m.tool.name)).toEqual(["error: Optional tools are unavailable."]);
  expect(r.lease.frozenEnd).toBeUndefined();
  r.lease.onLedgerRefused({ state: "checking", reason: "not-built" });
  expect(r.lease.frozenEnd?.kind).toBe("ledger");
});

describe("owner Stop: an engine error during the browser-release wait writes no card", () => {
  it("the error lands after Stop noted the owner's cause and before the adapter interrupt: no card, no refusal, settles once", async () => {
    const r = rig();
    r.built.noteOwnerStop!("T"); // the explicit owner-Stop boundary, as the Stop routes call it before interruptDirectThread
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered;
    r.engineError();
    expect({ pushed: r.pushed, order: r.order, end: r.lease.end() }).toEqual({ pushed: [], order: ["bus.cancelTurn", "browser.release"], end: { kind: "silent" } });
    r.release();
    await stopping;
    expect({ pushed: r.pushed, appended: r.appended, calls: r.calls, order: r.order })
      .toEqual({ pushed: [], appended: [], calls: ["watchdog.settle", "bus.refuseTurn"],
        // Stop's own interrupt only: the sealed lease's interrupt port (admitLedgerLease) adopts that confirmed Stop call when the shared
        // revoke refuses it (NC+MA LLS adoption, stopInterrupts), so the closed turn is not interrupted a second time.
        order: ["bus.cancelTurn", "browser.release", "adapter.interruptTurn"] });
  });
  it("a second engine error after the interrupt still writes no card", async () => {
    const r = rig();
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.engineError(); r.release(); await stopping;
    r.engineError();
    expect({ pushed: r.pushed, appended: r.appended }).toEqual({ pushed: [], appended: [] });
  });
  it("control: the same error with no owner Stop writes the engine card once", () => {
    const r = rig();
    r.engineError();
    expect(r.pushed.map(m => m.tool.name)).toEqual([`error: ${ENGINE_LINE}`]);
    expect(r.lease.frozenEnd).toEqual({ kind: "engine", line: ENGINE_LINE });
    r.lease.onLedgerRefused({ state: "checking", reason: "not-built" });
    expect(r.lease.frozenEnd).toEqual({ kind: "engine", line: ENGINE_LINE });
  });
});

// STOP-CARD-SPEC section 5 through the shipped gate (index.ts's turnCardGate over turn-card-gate.ts), the shipped Stop
// boundary and the shipped runtime.error branch: each card path is forced while Stop is held at its await.
describe("STOP-CARD: the runtime.error card path after an owner Stop goes through the one gate", () => {
  it("W1 attached lease, held at the browser release: no card, the frozen result is silent, settles once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.engineError();
    expect({ pushed: r.pushed, frozen: r.lease.frozenEnd, cardName: r.built.runtimeErrorCardName!(ENGINE_LINE, r.lease) })
      .toEqual({ pushed: [], frozen: { kind: "silent" }, cardName: undefined });
    r.release(); await stopping;
    expect({ pushed: r.pushed, settles: r.calls.filter(c => c === "watchdog.settle").length,
      suppressed: info.mock.calls.filter(c => String(c[0]).startsWith("[turn] card-suppressed")), shown: r.shownErrors })
      .toEqual({ pushed: [], settles: 1, suppressed: [["[turn] card-suppressed site=runtime-error after=owner-stop"]], shown: [] });
  });
  it("W2 before handback: dispatching, no provider id on the lease, the engine's error arrives first: no card", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig({ attached: false });
    expect(r.lease.providerTurnId).toBeUndefined();
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.engineError("P");
    // Early events attach through the dispatch admission before the provider returns.
    expect({ pushed: r.pushed, frozen: r.lease.frozenEnd, id: r.lease.providerTurnId }).toEqual({ pushed: [], frozen: { kind: "silent" }, id: "P" });
    expect(r.lease.handedBack).toBe(false);
    r.lease.attach("P"); // sendTurn returns after the early error; its real handback releases the close.
    r.release(); await stopping.catch(() => undefined);
    r.engineError("P");
    expect(r.pushed).toEqual([]);
  });
  it("W3 a Stop with no generation yet (no run, no lease for the turn) still holds the engine's error and close back", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig({ attached: false, running: false });
    r.leases.clear();
    r.built.noteOwnerStop!("T");
    r.engineError("Q");
    expect(r.pushed).toEqual([]);
  });
  it("W14 no over-suppression: Stop turn A, admit B, B's error shows verbatim", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.release(); await stopping;
    r.admitNext("G2", "P2");
    r.engineError("P2", "The second turn's own failure.");
    expect(r.pushed.map(m => m.tool.name)).toEqual(["error: The second turn's own failure."]);
  });
  it("W14 production admission clears the current Stop hold for a later error after the new lease is cleaned up", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const byAdmission = new Map();
    const r = stopCardRig("", { ledgerLeasesByAdmission: byAdmission });
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.release(); await stopping;
    r.admitNext("G2", "P2");
    r.leases.clear(); byAdmission.clear();
    r.engineError("P2", "The second turn's own failure.");
    expect(r.pushed.map(m => m.tool.name)).toEqual(["error: The second turn's own failure."]);
  });
  it("W15 a late event of the stopped turn after B was admitted: no card (the record keeps its turn ids)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.release(); await stopping;
    r.leases.delete("G"); // the stopped lease is gone: only the Stop record can answer for its turn
    r.admitNext("G2", "P2");
    r.engineError("P");
    expect(r.pushed).toEqual([]);
  });
});

describe("STOP-CARD W13: an MCP line frozen before the Stop keeps its frozen result, only its card is held back", () => {
  it("MCP cause frozen, then Stop, then the refusal presents: no notice, the late owner-stop logged once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    r.lease.noteCause("mcp-not-ready");
    const frozen = r.lease.end();
    r.built.noteOwnerStop!("T");
    const stopping = r.built.interruptDirectThread!("B", "T", "G");
    await r.entered; r.release(); await stopping;
    expect({ frozen: r.lease.frozenEnd, same: r.lease.frozenEnd === frozen, appended: r.appended, pushed: r.pushed,
      late: warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause")) })
      .toEqual({ frozen, same: true, appended: [], pushed: [], late: [["[turn] late-cause=owner-stop after=mcp-not-ready"]] });
  });
  it("persistence held: MCP frozen, the refusal presents, Stop lands, then the writer frees: no notice, one settlement", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig({ persistence: "held" });
    r.lease.noteCause("mcp-not-ready");
    const frozen = r.lease.end();
    r.lease.onLedgerRefused({ state: "checking", reason: "not-built" }); // settles and presents; both writes wait on the busy writer
    expect({ held: r.heldWrites.length, appended: r.appended }).toEqual({ held: 2, appended: [] });
    r.built.noteOwnerStop!("T");
    r.releasePersistence();
    expect({ frozen: r.lease.frozenEnd, same: r.lease.frozenEnd === frozen, appended: r.appended, pushed: r.pushed,
      settlements: r.calls.filter(c => c === "watchdog.settle").length,
      settlementWrites: r.ops.filter(op => op === "ledger-refusal-settlement").length,
      late: warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause")) })
      .toEqual({ frozen, same: true, appended: [], pushed: [], settlements: 1, settlementWrites: 1,
        late: [["[turn] late-cause=owner-stop after=mcp-not-ready"]] });
  });
});

// M1/M6: a room Stop for one member. The record carries that member's bot and no generation, and the fold scope names the bot
// that ran the event, so the stopped member's error stays unwritten while another member's real error still shows.
describe("STOP-CARD: a room member's Stop holds back only that member's runtime.error card", () => {
  const memberError = (r: ReturnType<typeof rig>, botId: string, turnId: string, message: string) =>
    r.built.foldRuntimeError!({ type: "runtime.error", threadId: "T", turnId, eventId: "E", provider: "acp", providerInstanceId: "I", message }, undefined, { botId }, false);
  it("M1 member Y's error before handback (no lease for its turn) shows after member X was stopped", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig({ running: false });
    r.built.noteOwnerStop!("T", "X");
    memberError(r, "Y", "Y1", "Member Y's own failure.");
    expect(r.pushed.map(m => m.tool.name)).toEqual(["error: Member Y's own failure."]);
  });
  it("M6 member X's own error with no lease for its turn is held back by the Stop record alone", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig({ running: false });
    r.built.noteOwnerStop!("T", "X");
    memberError(r, "X", "X1", "Member X's failure.");
    expect({ pushed: r.pushed, frozen: r.lease.frozenEnd, suppressed: info.mock.calls.filter(c => String(c[0]).startsWith("[turn] card-suppressed")) })
      .toEqual({ pushed: [], frozen: undefined, suppressed: [["[turn] card-suppressed site=runtime-error after=owner-stop"]] });
  });
});

// L1: a presenter with no card name must not mark an error as shown, even when no Stop record silences its scope.
it("L1 an absent card name writes no card and is not counted as an error shown", () => {
  const r = rig();
  r.evaluate("", { runtimeErrorCardName: () => undefined });
  r.engineError();
  expect({ cards: r.pushed, shown: r.shownErrors }).toEqual({ cards: [], shown: [] });
});
