import { expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { guardTurnDispatch, TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";
const api = existsSync(new URL("./ledger-refusal.ts", import.meta.url)) ? await import("./ledger-refusal.ts") : undefined;
const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
const BUDGET_REFUSAL_LINE = "I stopped this turn because it grew past a safety limit. Nothing was removed from memory.";
const createLedgerRefusal: typeof import("./ledger-refusal.ts").createLedgerRefusal = (...args) => {
  expect(api?.createLedgerRefusal, "T-LEDGER-STOP requires the admission-owned once-only refusal lifecycle").toBeTypeOf("function");
  expect(api?.createLedgerRefusal, "BUILD-FIX 21 requires a generation-bound seal/interrupt/settlement latch").toBeTypeOf("function");
  return api!.createLedgerRefusal(...args);
};

it("refusal diagnostics name the bounded verdict without retaining arbitrary text", () => {
  expect(api!.ledgerRefusalCause({ state: "checking", reason: "not-built" })).toBe("checking:not-built");
  expect(api!.ledgerRefusalCause({ state: "withheld", reason: "deny-memory" })).toBe("withheld:deny-memory");
  expect(api!.ledgerRefusalCause({ state: "checking", reason: "fixture private words" } as never)).toBe("invalid-verdict");
});

// red-at-4df086541: cleanup failures and all stop outcomes lacked a shared
// terminal latch. Assert every finalizer attempt, exact first reason and the
// original five-second quarantine bound, including concurrent completion.
it.each(["confirmed", "unconfirmed", "rejected", "thrown", "timeout"].flatMap(stop =>
  ["none", "seal", "settle", "present", "confirmed"].map(fault => ({ stop, fault }))))(
  "T-LEDGER-STOP finalizer $fault/stop $stop", async ({ fault, stop }) => {
    vi.useFakeTimers();
    const order: string[] = [];
    const port = (name: string) => vi.fn(() => { order.push(name); if (fault === name) throw new Error("fixture finalizer"); });
    const seal = port("seal"), settle = port("settle"), present = port("present"), confirmed = port("confirmed"), quarantine = vi.fn();
    const interrupt = vi.fn(() => {
      order.push("interrupt");
      if (stop === "thrown") throw new Error("fixture stop");
      if (stop === "rejected") return Promise.reject(new Error("fixture stop"));
      if (stop === "timeout") return new Promise<boolean>(() => {});
      return Promise.resolve(stop === "confirmed");
    });
    try {
      const lease = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "original", lineageTurnIds: ["L"], adapterLeaseId: "original" },
        { seal, settle, present, confirmed, quarantine, interrupt });
      lease.onLedgerRefused({ state: "checking", reason: "retained-over" });
      lease.completed(); lease.onLedgerRefused({ state: "checking", reason: "lookup-error" });
      expect(order.slice(0, 2)).toEqual(["seal", "interrupt"]);
      expect(settle).toHaveBeenCalledExactlyOnceWith("memory-refused", { state: "checking", reason: "retained-over" });
      expect(present).toHaveBeenCalledExactlyOnceWith(LEDGER_REFUSAL_LINE);
      await vi.advanceTimersByTimeAsync(4999);
      if (stop === "timeout" && fault === "none") expect(quarantine).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const quarantined = stop !== "confirmed" || fault !== "none";
      expect(quarantine).toHaveBeenCalledTimes(quarantined ? 1 : 0);
      expect(confirmed).toHaveBeenCalledTimes(stop === "confirmed" ? 1 : 0);
      expect(lease.state).toBe("settled"); expect(lease.quarantined).toBe(quarantined);
      expect(seal).toHaveBeenCalledTimes(1); expect(interrupt).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledTimes(1); expect(present).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

// red-at-4df086541: refusal persistence inside the response savepoint was
// rolled back with the rejected provenance; a latched settlement could not retry.
it.each(["commit", "rollback"])("T-LEDGER-STOP persists once outside nested attribution %s", async outcome => {
  const { DatabaseSync } = await import("node:sqlite");
  const { scopedTx } = await import("./tx-scope.ts");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settlements(reason TEXT); CREATE TABLE notices(line TEXT)");
  const seal = vi.fn(), interrupt = vi.fn(async () => true);
  const lease = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal, interrupt, quarantine: vi.fn(),
    settle: reason => { db.prepare("INSERT INTO settlements VALUES(?)").run(reason); },
    present: line => { db.prepare("INSERT INTO notices VALUES(?)").run(line); },
  });
  try {
    const run = () => scopedTx(() => {
      db.exec("BEGIN");
      try {
        scopedTx(() => {
          db.exec("SAVEPOINT answer");
          lease.onLedgerRefused({ state: "checking", reason: "lookup-error" });
          expect(seal).toHaveBeenCalledTimes(1); expect(interrupt).toHaveBeenCalledTimes(1);
          db.exec("ROLLBACK TO answer; RELEASE answer");
          throw new Error("fixture refusal");
        });
      } catch {
        lease.completed();
        expect(db.prepare("SELECT count(*) AS n FROM settlements").get()!.n).toBe(0);
        db.exec(outcome === "commit" ? "COMMIT" : "ROLLBACK");
        if (outcome === "rollback") throw new Error("outer rollback");
      }
    });
    if (outcome === "rollback") expect(run).toThrow("outer rollback"); else run();
    await Promise.resolve(); await Promise.resolve();
    lease.completed(); lease.onLedgerRefused({ state: "checking", reason: "pending" });
    expect(db.prepare("SELECT reason FROM settlements").all()).toEqual([{ reason: "memory-refused" }]);
    expect(db.prepare("SELECT line FROM notices").all()).toEqual([{ line: LEDGER_REFUSAL_LINE }]);
  } finally { db.close(); }
});

// red-at-4df086541: late provider hand-back could enter acceptance and let
// completion/replacement settle the wrong owner. Exercise the real dispatch
// guard with the admission lease, including the unchanged five-second limit.
it.each(["direct", "room", "proposal"])("T-LEDGER-STOP %s late hand-back stays sealed after timeout", async route => {
  expect(api?.createLedgerLease, "hand-back must retain its admission lifecycle").toBeTypeOf("function");
  vi.useFakeTimers();
  const boundary = new TurnSubmissionBoundary(), accepted = vi.fn(), present = vi.fn(), settle = vi.fn(), newer = vi.fn();
  const replacement = api!.createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "new", lineageTurnIds: ["new"], adapterLeaseId: "new" }, {
    seal: newer, interrupt: async () => { newer(); return true; }, present: newer, settle: newer, quarantine: newer,
  });
  replacement.attach("provider-new");
  const interrupt = vi.fn(async () => true), quarantine = vi.fn();
  const lease = api!.createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: route, lineageTurnIds: ["old"], adapterLeaseId: route }, {
    seal: () => boundary.seal(Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" })),
    interrupt, present, settle, quarantine,
  });
  let handBack!: (value: { turnId: string }) => void;
  const sending = new Promise<{ turnId: string }>(resolve => { handBack = resolve; });
  boundary.started();
  const guarded = guardTurnDispatch(sending, () => false, async value => {
    lease.attach(value.turnId);
    await lease.teardownConfirmed;
  }, value => {
    lease.attach(value.turnId);
    boundary.assertNotRefused();
    accepted();
  });
  const rejected = expect(guarded).rejects.toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" });
  try {
    lease.onLedgerRefused({ state: "checking", reason: "pending" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
    handBack({ turnId: "provider-old" });
    await rejected;
    lease.completed(); lease.onLedgerRefused({ state: "checking", reason: "lookup-error" });
    expect(interrupt).toHaveBeenCalledExactlyOnceWith("provider-old");
    expect(accepted).not.toHaveBeenCalled(); expect(newer).not.toHaveBeenCalled();
    expect(replacement.state).toBe("open"); expect(replacement.providerTurnId).toBe("provider-new");
    expect(boundary.canRetry).toBe(false);
    expect(settle).toHaveBeenCalledTimes(1); expect(present).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

// red-at-4df086541: native refusal had no localized once-only settlement.
it.each(["toolTurnRefused", "stepTurnRefused"] as const)("native notice %s wins before all terminal races", async code => {
  expect(api?.createLedgerLease, "native notices require the common settlement latch").toBeTypeOf("function");
  const { SEND_NOTICE_ENGLISH } = await import("../shared/send-notice.ts");
  const present = vi.fn(), settle = vi.fn();
  const lease = api!.createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: code, lineageTurnIds: ["L"], adapterLeaseId: code }, {
    seal: vi.fn(), interrupt: async () => false, present, settle, quarantine: vi.fn(),
  });
  lease.admissionNotLaunched(code);
  lease.onLedgerRefused({ state: "checking", reason: "not-built" });
  lease.admissionNotLaunched(code === "toolTurnRefused" ? "stepTurnRefused" : "toolTurnRefused");
  lease.completed();
  await lease.teardownConfirmed;
  expect(present).toHaveBeenCalledExactlyOnceWith(SEND_NOTICE_ENGLISH[code], code);
  expect(settle).toHaveBeenCalledTimes(1);
});

// red-at-4df086541: setup needs a positive pre-invocation proof; a retained
// refusal after invocation must never turn into a setup retry.
it("T-LEDGER-STOP separates bounded preparation rebuild from a running refusal", async () => {
  const { TurnSubmissionBoundary } = await import("./turn-dispatch-guard.ts");
  const boundary = new TurnSubmissionBoundary();
  expect(boundary.refusePreparation, "setup refusal must preserve the bounded rebuild proof").toBeTypeOf("function");
  const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  expect(boundary.refusePreparation(refusal)).toBe(true);
  expect(boundary.canRetry).toBe(true);
  expect(() => boundary.beforeSubmit(() => {})).toThrow("MEMORY_CONTEXT_REVOKED");
  const running = new TurnSubmissionBoundary(); running.started();
  expect(running.refusePreparation(refusal)).toBe(false);
  running.seal(refusal); expect(running.canRetry).toBe(false);
});

// red-at-4df086541: admission refusal had no exact no-launch confirmation and
// could leave a room waiting forever for a provider id that cannot exist.
it("T-LEDGER-STOP confirms refused admission without interrupting another turn", async () => {
  expect(api?.createLedgerLease, "admission owns teardown proof before provider hand-back").toBeTypeOf("function");
  const interrupt = vi.fn(async () => true), confirmed = vi.fn(), quarantine = vi.fn(), settle = vi.fn();
  const lease = api!.createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal: vi.fn(), interrupt, confirmed, quarantine, settle, present: vi.fn(),
  });
  lease.admissionNotLaunched();
  lease.onLedgerRefused({ state: "checking", reason: "not-built" });
  await lease.teardownConfirmed;
  expect(interrupt).not.toHaveBeenCalled(); expect(quarantine).not.toHaveBeenCalled();
  expect(confirmed).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
  expect(() => lease.attach("unexpected-child")).toThrow("MEMORY_CONTEXT_REVOKED");
});

// red-at-4df086541: a kill request followed by pool hand-back could certify closure.
it("T-LEDGER-STOP keeps a requested child stop unconfirmed across pool detach", async () => {
  const { EventEmitter } = await import("node:events");
  const { ChildTeardown } = await import("./drivers/child-teardown.ts");
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const teardown = new ChildTeardown(child as import("node:child_process").ChildProcess,
    async () => true, () => ({ pending: null, settledAt: null }), () => new Promise(() => {}));
  teardown.markStopRequested(); teardown.detach();
  expect(teardown.closed, "pool hand-back is not evidence of stopped process closure").toBe(false);
  child.emit("close", 0); await Promise.resolve();
  expect(teardown.closed).toBe(true);
});

// red-at-4df086541: an unknown exact turn used to inherit the empty-thread success result.
it("T-LEDGER-STOP refuses an unknown exact teardown lease", async () => {
  const { TurnTeardowns } = await import("./drivers/child-teardown.ts");
  const teardowns = new TurnTeardowns();
  expect(await teardowns.wait("T", "unseen", { closeMs: 1, maxMs: 1 })).toEqual({ closeConfirmed: false, reason: "stop-failed" });
});

// red-at-4df086541: terminal refusal and provider completion did not share one latch.
it.each(["provider-event", "tool", "proxy-failure", "stream", "timeout"])("T-LEDGER-STOP-ALL %s cannot settle a refused lease twice", source => {
  const settle = vi.fn(), present = vi.fn();
  const lease = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: source, lineageTurnIds: ["L"], adapterLeaseId: source }, {
    seal: vi.fn(), interrupt: async () => false, settle, present, quarantine: vi.fn(),
  });
  lease.onLedgerRefused({ state: "checking", reason: "lookup-error" });
  lease.completed(); lease.onLedgerRefused({ state: "checking", reason: "pending" }); lease.completed();
  expect(settle).toHaveBeenCalledTimes(1); expect(present).toHaveBeenCalledExactlyOnceWith(LEDGER_REFUSAL_LINE);
  expect(lease.verdict).toEqual({ state: "checking", reason: "lookup-error" });
});

// red-at-4df086541: T-LEDGER-STOP lifecycle unit; transport-specific integration remains separately required.
it("seals before interruption and settles concurrent refusals once", async () => {
  const order: string[] = [], settle = vi.fn(), present = vi.fn();
  let complete!: (confirmed: boolean) => void;
  const handler = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "A" }, {
    seal: () => order.push("seal"), interrupt: () => { order.push("interrupt"); return new Promise(resolve => { complete = resolve; }); },
    settle, present, quarantine: vi.fn(),
  });
  handler.onLedgerRefused({ state: "checking", reason: "retained-over" });
  handler.onLedgerRefused({ state: "checking", reason: "lookup-error" });
  expect(order).toEqual(["seal", "interrupt"]);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(present).toHaveBeenCalledExactlyOnceWith(LEDGER_REFUSAL_LINE);
  complete(true); await Promise.resolve(); await Promise.resolve();
  expect(settle).toHaveBeenCalledTimes(1);
});

// red-at-4df086541: a never-resolving stop cannot reopen the lease or postpone
// settlement. The design's five-second deadline is unchanged.
it("T-LEDGER-STOP quarantines exactly at the unconfirmed-stop deadline", async () => {
  vi.useFakeTimers();
  try {
    const quarantine = vi.fn(), settle = vi.fn(), present = vi.fn();
    const handler = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "old", lineageTurnIds: ["L"], adapterLeaseId: "old-lease" }, {
      seal: vi.fn(), interrupt: () => new Promise(() => {}), settle, present, quarantine,
    });
    handler.onLedgerRefused({ state: "checking", reason: "retained-budget" });
    // 1.0.21 cause22 row 4: this verdict is the release budget (bookkeeping); it is told with the budget line, never the context line
    expect(settle).toHaveBeenCalledOnce(); expect(present).toHaveBeenCalledExactlyOnceWith(BUDGET_REFUSAL_LINE);
    await vi.advanceTimersByTimeAsync(4999); expect(quarantine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(quarantine).toHaveBeenCalledOnce();
    expect(handler.quarantined).toBe(true); expect(settle).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

// red-at-4df086541: unconfirmed teardown remains quarantined after the once-only settlement.
it("quarantines an unconfirmed lease", async () => {
  const quarantine = vi.fn(), settle = vi.fn();
  const handler = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "old", lineageTurnIds: ["L"], adapterLeaseId: "old-lease" }, {
    seal: vi.fn(), interrupt: async () => false, settle, present: vi.fn(), quarantine,
  });
  handler.onLedgerRefused({ state: "checking", reason: "lookup-error" });
  await Promise.resolve(); await Promise.resolve();
  expect(quarantine).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
  expect(handler.identity.dispatchGeneration).toBe("old");
});
// red-at-4df086541: failed cleanup/presentation cannot erase the terminal latch.
it("keeps the first verdict and quarantines once even when teardown ports throw", () => {
  const interrupt = vi.fn(() => { throw new Error("stop failed"); }), quarantine = vi.fn(() => { throw new Error("quarantine persistence failed"); });
  const settle = vi.fn(() => { throw new Error("settlement persistence failed"); }), present = vi.fn();
  const handler = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "old", lineageTurnIds: ["L"], adapterLeaseId: "old-lease" }, {
    seal: () => { throw new Error("seal persistence failed"); }, interrupt, settle, present, quarantine,
  });
  handler.onLedgerRefused({ state: "checking", reason: "retained-budget" });
  handler.onLedgerRefused({ state: "checking", reason: "lookup-error" });
  expect(handler.state).toBe("settled"); expect(handler.quarantined).toBe(true);
  expect(handler.verdict).toEqual({ state: "checking", reason: "retained-budget" });
  expect(interrupt).toHaveBeenCalledTimes(1); expect(quarantine).toHaveBeenCalledTimes(1);
  // 1.0.21 cause22 row 4: the first verdict (the release budget) picks the line; a later verdict never changes it
  expect(settle).toHaveBeenCalledTimes(1); expect(present).toHaveBeenCalledExactlyOnceWith(BUDGET_REFUSAL_LINE);
});

// red-at-4df086541: no admitted immutable lease survived asynchronous provider hand-back.
it("T-LEDGER-STOP interrupts the original late hand-back and rejects retargeting", async () => {
  expect(api?.createLedgerLease, "provider hand-back must attach to the original admitted lease").toBeTypeOf("function");
  const interrupt = vi.fn(async () => true), settle = vi.fn(), seal = vi.fn();
  const lease = api!.createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "old", lineageTurnIds: ["L"], adapterLeaseId: "old" }, {
    interrupt, settle, seal, present: vi.fn(), quarantine: vi.fn(),
  });
  lease.onLedgerRefused({ state: "checking", reason: "pending" });
  expect(seal).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
  expect(interrupt).not.toHaveBeenCalled();
  lease.attach("provider-old");
  await Promise.resolve(); await Promise.resolve();
  expect(interrupt).toHaveBeenCalledExactlyOnceWith("provider-old");
  expect(() => lease.attach("provider-new")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(lease.providerTurnId).toBe("provider-old");
  expect(settle).toHaveBeenCalledTimes(1);
});

// red-at-4df086541: requested interruption was not a confirmed teardown.
it("T-EXTERNAL-STOP times out without reopening a pending external lease", async () => {
  vi.useFakeTimers();
  try {
    const quarantine = vi.fn(), present = vi.fn(), settle = vi.fn();
    const lease = createLedgerRefusal({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "A" }, {
      seal: vi.fn(), interrupt: () => new Promise(() => {}), settle, present, quarantine,
    });
    lease.onLedgerRefused({ state: "checking", reason: "pending" });
    await vi.advanceTimersByTimeAsync(5001);
    expect(lease.quarantined).toBe(true); expect(lease.state).toBe("settled");
    expect(quarantine).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledExactlyOnceWith(LEDGER_REFUSAL_LINE);
  } finally { vi.useRealTimers(); }
});
