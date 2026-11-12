import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  PendingTurnCancellations,
  RetiredTurnRegistry,
  guardTurnDispatch,
  TurnSubmissionBoundary,
  isTurnEventQuarantined,
} from "./turn-dispatch-guard.ts";

describe("turn dispatch cancellation boundary", () => {
  it("retries only before adapter invocation or after a trusted refusal", () => {
    const boundary = new TurnSubmissionBoundary();
    expect(boundary.canRetry).toBe(true);
    boundary.started();
    expect(boundary.canRetry).toBe(false);
    const error = new Error("MEMORY_CONTEXT_REVOKED");
    expect(() => boundary.beforeSubmit(() => { throw error; })).toThrow(error);
    expect(boundary.canRetry).toBe(true);
    expect(() => boundary.assertNotRefused()).toThrow(error);
  });

  it("keeps successful callback and ignored callback submissions unknown", () => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    boundary.beforeSubmit(() => {});
    expect(boundary.canRetry).toBe(false);
    expect(() => boundary.assertNotRefused()).not.toThrow();
    const ignored = new TurnSubmissionBoundary();
    ignored.started();
    expect(ignored.canRetry).toBe(false);
  });

  it("propagates cleanup failure instead of making a refused turn retryable", async () => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    const refusal = new Error("MEMORY_CONTEXT_REVOKED");
    expect(() => boundary.beforeSubmit(() => { throw refusal; })).toThrow(refusal);
    const cleanupFailure = new Error("provider termination is unconfirmed");
    await expect(guardTurnDispatch(Promise.resolve({turnId:"refused"}), () => false,
      async () => { throw cleanupFailure; }, () => boundary.assertNotRefused(),
    )).rejects.toBe(cleanupFailure);
  });
  it("interrupts again after a provider setup that was cancelled while pending", async () => {
    let finishSetup!: (value: { turnId: string }) => void;
    const started = new Promise<{ turnId: string }>((resolve) => {
      finishSetup = resolve;
    });
    let cancelled = false;
    const stopAfterSetup = vi.fn(async () => {});
    const guarded = guardTurnDispatch(started, () => cancelled, stopAfterSetup);

    cancelled = true;
    finishSetup({ turnId: "turn-1" });

    await expect(guarded).resolves.toEqual({ value: { turnId: "turn-1" }, cancelled: true });
    expect(stopAfterSetup).toHaveBeenCalledOnce();
  });

  it("does not interrupt a setup that still owns its dispatch", async () => {
    const stopAfterSetup = vi.fn(async () => {});
    await expect(guardTurnDispatch(
      Promise.resolve({ turnId: "turn-2" }),
      () => false,
      stopAfterSetup,
    )).resolves.toEqual({ value: { turnId: "turn-2" }, cancelled: false });
    expect(stopAfterSetup).not.toHaveBeenCalled();
  });

  it("keeps bounded tombstones so late events cannot settle a replacement turn", () => {
    const retired = new RetiredTurnRegistry(2);
    retired.retire("turn-a");
    retired.retire("turn-b");
    expect(retired.has("turn-a")).toBe(true);
    expect(retired.has("turn-b")).toBe(true);
    expect(retired.has(undefined)).toBe(false);

    retired.retire("turn-c");
    expect(retired.has("turn-a")).toBe(false);
    expect(retired.has("turn-b")).toBe(true);
    expect(retired.has("turn-c")).toBe(true);
  });

  it("gates handshake events until every cancelled owner is retired", () => {
    const pending = new PendingTurnCancellations();
    pending.mark("thread-1", "room-a");
    pending.mark("thread-1", "room-b");
    expect(pending.has("thread-1")).toBe(true);

    pending.clear("thread-1", "room-a");
    expect(pending.has("thread-1")).toBe(true);
    pending.clear("thread-1", "room-b");
    expect(pending.has("thread-1")).toBe(false);
  });

  it("expires a hung handshake without admitting turn ids captured while it was pending", () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingTurnCancellations(100);
      const retired = new RetiredTurnRegistry();
      pending.mark("thread-1", "direct-a");

      expect(isTurnEventQuarantined(pending, retired, {
        threadId: "thread-1",
        turnId: "cancelled-turn",
      })).toBe(true);

      vi.advanceTimersByTime(100);
      expect(pending.has("thread-1")).toBe(false);
      expect(isTurnEventQuarantined(pending, retired, {
        threadId: "thread-1",
        turnId: "cancelled-turn",
      })).toBe(true);
      expect(isTurnEventQuarantined(pending, retired, {
        threadId: "thread-1",
        turnId: "replacement-turn",
      })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old expiry callback clear a renewed owner", () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingTurnCancellations(100);
      pending.mark("thread-1", "direct-a");
      vi.advanceTimersByTime(60);
      pending.mark("thread-1", "direct-a");
      vi.advanceTimersByTime(60);
      expect(pending.has("thread-1")).toBe(true);

      vi.advanceTimersByTime(40);
      expect(pending.has("thread-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a replacement until the cancelled handshake quarantine expires", async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingTurnCancellations(100);
      pending.mark("thread-1", "direct-a");
      let admitted = false;
      const waiting = pending.waitForClear("thread-1").then(() => {
        admitted = true;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(admitted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks the gate when a cancellation is renewed as waiters wake", async () => {
    const pending = new PendingTurnCancellations(30_000);
    pending.mark("thread-1", "direct-a");
    let admitted = false;
    const waiting = pending.waitForClear("thread-1").then(() => {
      admitted = true;
    });

    pending.clear("thread-1", "direct-a");
    pending.mark("thread-1", "direct-b");
    await Promise.resolve();
    expect(admitted).toBe(false);

    pending.clear("thread-1", "direct-b");
    await waiting;
    expect(admitted).toBe(true);
  });
});

it("waits for exact accepted-turn cleanup before propagating an acceptance failure",async()=>{
  const retired=new RetiredTurnRegistry();
  let finishStop!:()=>void;
  const stopped=new Promise<void>(resolve=>{finishStop=resolve;});
  let busy=true,queued=false;
  const error=new Error("MEMORY_CONTEXT_REVOKED");
  const guarded=guardTurnDispatch(Promise.resolve({turnId:"accepted-old"}),()=>false,async accepted=>{
    retired.retire(accepted.turnId);
    await stopped;
  },()=>{throw error;}).catch(cause=>{busy=false;queued=true;throw cause;});
  const rejected=expect(guarded).rejects.toBe(error);
  await Promise.resolve();await Promise.resolve();
  expect(retired.has("accepted-old")).toBe(true);
  expect(busy).toBe(true);expect(queued).toBe(false);
  finishStop();await rejected;
  expect(busy).toBe(false);expect(queued).toBe(true);
  expect(retired.has("accepted-old")).toBe(true);
});

it("validates acceptance once and does not stop an unchanged provider",async()=>{
  const stop=vi.fn(async()=>{}),accept=vi.fn();
  await expect(guardTurnDispatch(Promise.resolve({turnId:"valid"}),()=>false,stop,accept))
    .resolves.toEqual({value:{turnId:"valid"},cancelled:false});
  expect(accept).toHaveBeenCalledExactlyOnceWith({turnId:"valid"});expect(stop).not.toHaveBeenCalled();
});

// DELETE-REVOKE-SCOPE (a): a refusal at acceptance is proof that nothing was submitted only on an adapter that declares fencedWrites
// and released no write; the boundary is then sealed so the stopped adapter can never write later.
describe("sealUnwritten", () => {
  const revoked = () => new Error("MEMORY_CONTEXT_REVOKED");
  it("seals an invoked, fenced boundary with no released write: retryable, and every later write refuses before it validates", () => {
    const boundary = new TurnSubmissionBoundary();
    const notWritten = vi.fn(); boundary.onNotWritten(notWritten);
    boundary.started();
    const error = revoked();
    expect(boundary.sealUnwritten(error, true)).toBe(true);
    expect(boundary.canRetry).toBe(true);
    expect(() => boundary.assertNotRefused()).toThrow(error);
    const validate = vi.fn(), passed = vi.fn(); boundary.onPassed(passed);
    expect(() => boundary.beforeSubmit(validate)).toThrow(error);
    expect(validate).not.toHaveBeenCalled(); expect(passed).not.toHaveBeenCalled();
    expect(notWritten).toHaveBeenCalledTimes(1);
  });
  it("proves nothing without the flag, after a released write, before the adapter call, or once accepted", () => {
    for (const flag of [undefined, false]) {
      const boundary = new TurnSubmissionBoundary(); boundary.started();
      expect(boundary.sealUnwritten(revoked(), flag)).toBe(false);
      expect(boundary.canRetry).toBe(false);
      expect(() => boundary.beforeSubmit(() => {})).not.toThrow();
    }
    const released = new TurnSubmissionBoundary(); released.started();
    released.beforeSubmit(() => {});
    expect(released.sealUnwritten(revoked(), true)).toBe(false);
    expect(released.canRetry).toBe(false);
    // a released write whose adapter later said it did not happen still counts: it may have
    const unwritten = new TurnSubmissionBoundary(); unwritten.started();
    unwritten.beforeSubmit(() => {}); unwritten.notWritten();
    expect(unwritten.sealUnwritten(revoked(), true)).toBe(false);
    const fresh = new TurnSubmissionBoundary();
    expect(fresh.sealUnwritten(revoked(), true)).toBe(false);
    const accepted = new TurnSubmissionBoundary(); accepted.started(); accepted.acceptedBy(() => {});
    expect(accepted.sealUnwritten(revoked(), true)).toBe(false);
    expect(accepted.canRetry).toBe(false);
  });
  it("leaves an already refused boundary as it was", () => {
    const boundary = new TurnSubmissionBoundary(); boundary.started();
    const first = revoked();
    expect(() => boundary.beforeSubmit(() => { throw first; })).toThrow(first);
    expect(boundary.sealUnwritten(revoked(), true)).toBe(false);
    expect(() => boundary.assertNotRefused()).toThrow(first);
  });
});

it("pre-spawn validation does not release a prompt or spend an unwritten rebuild", () => {
  const boundary = new TurnSubmissionBoundary();
  const passed = vi.fn(), check = vi.fn();
  boundary.onPassed(passed);
  boundary.alsoCheck(check);
  boundary.started();
  boundary.prepare(() => boundary.beforeSubmit(() => {}));
  expect(check).toHaveBeenCalledTimes(1);
  expect(passed).not.toHaveBeenCalled();
  expect(boundary.hasReleasedSubmission).toBe(false);
  // A seal can move while the spawned process waits for MCP readiness.
  expect(() => boundary.beforeSubmit(() => { throw new Error("sealed"); })).toThrow("sealed");
  expect(boundary.canRetry).toBe(true);
  boundary.beforeSubmit(() => {});
  expect(boundary.hasReleasedSubmission).toBe(true);
  expect(passed).toHaveBeenCalledTimes(1);
});

it("preparation after a released prompt cannot authorize replay", () => {
  const boundary = new TurnSubmissionBoundary();
  boundary.started();
  boundary.beforeSubmit(() => {});
  expect(() => boundary.prepare(() => boundary.beforeSubmit(() => { throw new Error("sealed"); }))).toThrow("sealed");
  expect(boundary.hasReleasedSubmission).toBe(true);
  expect(boundary.canRetry).toBe(false);
});

it("C11 keeps prior released submissions through a later refused fence", () => {
  const boundary = new TurnSubmissionBoundary();
  const withdrawn = vi.fn(), refused = vi.fn();
  boundary.onNotWritten(withdrawn);
  boundary.started();
  boundary.acceptedBy(refused);
  boundary.beforeSubmit(() => {});
  expect(() => boundary.beforeSubmit(() => { throw new Error("revoked"); })).toThrow("revoked");
  expect(boundary.canRetry).toBe(false);
  expect(boundary.hasReleasedSubmission).toBe(true);
  expect(withdrawn).not.toHaveBeenCalled();
  expect(refused.mock.calls[0][1]).toEqual({ priorSubmissionReleased: true });
  expect(Object.isFrozen(refused.mock.calls[0][1])).toBe(true);
  boundary.notWritten();
  expect(withdrawn).toHaveBeenCalledTimes(1);
  expect(boundary.hasReleasedSubmission).toBe(true);
});


it.each(["route", "cursor", "delegation"])("c11-written-attribution survives %s refusal", async origin => {
  const { createTurnAttribution } = await import("./turn-attribution.ts");
  const row: { dispatchedIn?: string } = {};
  const unstamp = vi.fn(() => { delete row.dispatchedIn; });
  const attribution = createTurnAttribution({ stamp: (_thread, _row, turn) => { row.dispatchedIn = turn; }, unstamp });
  const boundary = new TurnSubmissionBoundary();
  attribution.begin("claim", "thread", ["owner"]);
  attribution.bind("claim", boundary);
  boundary.started(); attribution.accepted("claim", "provider-turn"); boundary.acceptedBy(() => {});
  boundary.beforeSubmit(() => {}); boundary.noteEngineWrite();
  expect(row.dispatchedIn).toBe("provider-turn");
  expect(() => boundary.beforeSubmit(() => { throw new Error(origin); })).toThrow(origin);
  expect(unstamp).not.toHaveBeenCalled();
  expect(row.dispatchedIn).toBe("provider-turn");
  expect(boundary.canRetry).toBe(false);
  expect(boundary.sealUnwritten(new Error("late"), true)).toBe(false);
  expect(boundary.hasConfirmedSubmission).toBe(true);
});

it("c11-written-attribution retains explicit unwritten withdrawal", async () => {
  const { createTurnAttribution } = await import("./turn-attribution.ts");
  const unstamp = vi.fn();
  const attribution = createTurnAttribution({ stamp: vi.fn(), unstamp });
  const boundary = new TurnSubmissionBoundary();
  attribution.begin("claim", "thread", ["owner"]); attribution.bind("claim", boundary);
  boundary.started(); attribution.accepted("claim", "provider-turn");
  boundary.beforeSubmit(() => {}); boundary.notWritten();
  expect(unstamp).toHaveBeenCalledWith("thread", "owner", "provider-turn");
  expect(boundary.canRetry).toBe(false);
  const sealed = new TurnSubmissionBoundary(); sealed.started();
  const listener = vi.fn(); sealed.onNotWritten(listener);
  expect(sealed.sealUnwritten(new Error("sealed"), true)).toBe(true);
  expect(() => sealed.beforeSubmit(() => {})).toThrow("sealed");
  expect(listener).toHaveBeenCalledTimes(1);
});

it("c11-review-10 boundary documentation limits rebuilding to verified unwritten dispatches", () => {
  const boundary = readFileSync(new URL("./turn-dispatch-guard.ts", import.meta.url), "utf8");
  const acp = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
  const acceptance = boundary.slice(boundary.indexOf("/** The server accepted"), boundary.indexOf("  acceptedBy("));
  const fence = acp.slice(acp.indexOf("// The submission fence (SendTurnInput.beforeSubmit)"), acp.indexOf("// The submission fence (SendTurnInput.beforeSubmit)") + 650);
  for (const comment of [acceptance, fence]) {
    expect(comment).toContain("prior release");
    expect(comment).toContain("verified unwritten");
  }
  expect(acceptance).not.toContain("nothing was written, so it may re-run");
  expect(fence).not.toContain("the harness re-runs it on a reset session");
});


it("setup validation releases no prompt; a refusal after readiness can rebuild, while a prior write cannot", () => {
  const boundary = new TurnSubmissionBoundary();
  const passed = vi.fn();
  boundary.onPassed(passed);
  boundary.started();
  boundary.beforePrepare(() => {});
  expect(passed).not.toHaveBeenCalled();
  expect(boundary.hasReleasedSubmission).toBe(false);
  expect(boundary.canRetry).toBe(false); // setup alone is not proof of refusal
  expect(() => boundary.beforeSubmit(() => { throw new Error("sealed during readiness"); })).toThrow();
  expect(boundary.canRetry).toBe(true);

  const released = new TurnSubmissionBoundary();
  released.started();
  released.beforeSubmit(() => {});
  expect(() => released.beforePrepare(() => { throw new Error("recovery revoked"); })).toThrow();
  expect(released.canRetry).toBe(false);
  expect(released.hasReleasedSubmission).toBe(true);
});

describe("T6a replay proof and seal", () => {
  it.each([false, true])("leaves an unknown boundary unproven (requireNoRelease=%s)", requireNoRelease => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    expect(boundary.sealForReplay(new Error("replay"), { requireNoRelease })).toBe("unproven");
    expect(boundary.canRetry).toBe(false);
    expect(boundary.refusedWith).toBeUndefined();
    boundary.beforeSubmit(() => {});
    expect(boundary.releasedWrites).toBe(1);
  });

  it("counts released writes forever and preserves the current prohibition on replay after release", () => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    boundary.beforeSubmit(() => {});
    boundary.notWritten();
    boundary.beforeSubmit(() => {});
    const refusal = new Error("refused");
    boundary.refuse(refusal);
    expect(boundary.releasedWrites).toBe(2);
    expect(boundary.sealForReplay(new Error("replay"), { requireNoRelease: true })).toBe("unproven");
    const validate = vi.fn();
    boundary.beforeSubmit(validate);
    expect(validate).toHaveBeenCalledOnce();
    expect(boundary.releasedWrites).toBe(3);
    expect(boundary.sealForReplay(new Error("replay"), { requireNoRelease: false })).toBe("unproven");
    expect(boundary.canRetry).toBe(false);
    boundary.beforeSubmit(validate);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(boundary.releasedWrites).toBe(4);
  });

  it("seals an unstarted boundary once with the first replay refusal", () => {
    const boundary = new TurnSubmissionBoundary();
    const first = new Error("first replay");
    expect(boundary.sealForReplay(first, { requireNoRelease: true })).toBe("sealed");
    expect(boundary.sealForReplay(new Error("second replay"), { requireNoRelease: true })).toBe("sealed");
    const validate = vi.fn(), check = vi.fn(), passed = vi.fn(), notWritten = vi.fn();
    boundary.alsoCheck(check); boundary.onPassed(passed); boundary.onNotWritten(notWritten);
    expect(() => boundary.beforeSubmit(validate)).toThrow(first);
    expect(() => boundary.beforeSubmit(validate)).toThrow(first);
    expect(validate).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(passed).not.toHaveBeenCalled();
    expect(notWritten).toHaveBeenCalledTimes(2);
    expect(boundary.releasedWrites).toBe(0);
  });

  it("is idempotent with sealUnwritten and preserves its refusal", () => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    const refusal = new Error("acceptance refused");
    expect(boundary.sealUnwritten(refusal, true)).toBe(true);
    expect(boundary.sealForReplay(new Error("replay"), { requireNoRelease: true })).toBe("sealed");
    expect(boundary.sealForReplay(new Error("again"), { requireNoRelease: false })).toBe("sealed");
    expect(boundary.refusedWith).toBe(refusal);
    expect(() => boundary.beforeSubmit(() => {})).toThrow(refusal);
    expect(boundary.releasedWrites).toBe(0);
  });

  it.each([undefined, null, new Error("original")])("preserves a recorded refusal even when its value is %s", refusal => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    try { boundary.beforeSubmit(() => { throw refusal; }); } catch { /* trusted refusal */ }
    expect(boundary.sealForReplay(new Error("replacement"), { requireNoRelease: true })).toBe("sealed");
    let caught: unknown = Symbol("not thrown");
    try { boundary.beforeSubmit(() => {}); } catch (error) { caught = error; }
    expect(caught).toBe(refusal);
    expect(boundary.releasedWrites).toBe(0);
  });
});


describe("replay seals with current submission evidence", () => {
  it.each([false, true])("cannot prove replay after an engine-confirmed write (requireNoRelease=%s)", requireNoRelease => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    boundary.noteEngineWrite();
    const refusal = new Error("late refusal");
    boundary.refuse(refusal);
    expect(boundary.sealForReplay(new Error("replay"), { requireNoRelease })).toBe("unproven");
    expect(boundary.hasConfirmedSubmission).toBe(true);
    expect(boundary.refusedWith).toBe(refusal);
  });

  it("allows a refused preparation to seal, and checks the seal before later setup or writes", () => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    boundary.prepare(() => boundary.beforeSubmit(() => {}));
    expect(boundary.releasedWrites).toBe(0);
    const refusal = new Error("readiness refused");
    expect(() => boundary.beforePrepare(() => { throw refusal; })).toThrow(refusal);
    expect(boundary.sealForReplay(new Error("replay"), { requireNoRelease: true })).toBe("sealed");
    const validate = vi.fn();
    expect(() => boundary.beforePrepare(validate)).toThrow(refusal);
    expect(() => boundary.beforeSubmit(validate)).toThrow(refusal);
    expect(validate).not.toHaveBeenCalled();
    expect(boundary.releasedWrites).toBe(0);
  });
});
