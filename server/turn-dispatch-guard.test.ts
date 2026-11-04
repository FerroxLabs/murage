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
