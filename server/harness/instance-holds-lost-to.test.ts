// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IDX4-ENGINE-RETIRE-1018 P1: a hold that already lost to a turn that is STILL running reports that instance busy at once. It raises no
// gate and waits for nothing, so new turns are never blocked by a wait that cannot succeed. The deletion is still skipped (busy), never
// forced, and it is retried only when every turn on the instance has ended (`whenFree`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceHolds } from "./instance-holds.ts";

const X = "claude";
const idleOf = async () => undefined;

async function settled<T>(promise: Promise<T>, ms: number): Promise<{ done: boolean; value?: T }> {
  let state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => { state = { done: true, value }; });
  await vi.advanceTimersByTimeAsync(ms);
  return state;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A holds object whose first hold has already lost to the running turn "A". */
async function lostToA(holds = new InstanceHolds()) {
  holds.noteStarted(X, "A");
  const first = holds.hold([X], 1000, idleOf);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await first).busy).toEqual([X]);
  return holds;
}

describe("a hold that already lost to a running turn", () => {
  it("(a) the first hold waits its budget against a running turn and reports busy", async () => {
    const holds = new InstanceHolds();
    holds.noteStarted(X, "A");
    const first = holds.hold([X], 1000, idleOf);
    expect(holds.isHeld(X)).toBe(true);
    expect((await settled(first, 999)).done).toBe(false);
    const result = await settled(first, 1);
    expect(result.done).toBe(true);
    expect(result.value?.busy).toEqual([X]);
    expect(holds.isHeld(X)).toBe(false);
  });

  it("(b) the next hold reports busy at once: no gate, no wait, and a new turn is admitted without waiting", async () => {
    const holds = await lostToA();
    const second = holds.hold([X], 4000, idleOf);
    expect(holds.isHeld(X)).toBe(false); // red before: held for the whole 4 s
    const admitted = holds.admit(X, "B");
    const gated = await settled(Promise.all([second, admitted]), 20);
    expect(gated.done).toBe(true);
    expect(gated.value?.[0].busy).toEqual([X]);
    expect(holds.runningTurns(X)).toBe(2); // A and B
  });

  it("(c) deletion stays deferred while ANY turn runs, and is woken only when every turn has ended: none is lost", async () => {
    const holds = await lostToA();
    const since = Date.now();
    const woke = vi.fn();
    holds.whenFree([X], since, woke);
    await settled(holds.hold([X], 4000, idleOf), 20); // busy at once
    await holds.admit(X, "B"); // a new turn started while the deletion was owed
    holds.noteEnded(X, "A");
    expect(woke).not.toHaveBeenCalled(); // B still runs: not free
    holds.noteEnded(X, "B");
    expect(woke).toHaveBeenCalledTimes(1);
    const third = await settled(holds.hold([X], 4000, idleOf), 0);
    expect(third.done).toBe(true);
    expect(third.value?.busy).toEqual([]); // the retry now gets the engine
    third.value?.release();
    expect(holds.isHeld(X)).toBe(false);
  });

  it("(d) a turn the hold has not lost to keeps the full ladder wait", async () => {
    const holds = await lostToA();
    holds.noteEnded(X, "A");
    holds.noteStarted(X, "C");
    const next = holds.hold([X], 1000, idleOf);
    expect(holds.isHeld(X)).toBe(true);
    expect((await settled(next, 999)).done).toBe(false);
    expect((await settled(next, 1)).value?.busy).toEqual([X]);
  });

  it("(e) the same thread started again (a new `since`) is a new turn: full wait", async () => {
    const holds = new InstanceHolds();
    holds.watch(X, () => false);
    await lostToA(holds);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(holds.runningTurns(X)).toBe(0); // A pruned: no session, older than 30 s
    holds.watch(X, () => true);
    holds.noteStarted(X, "A"); // a fresh turn on the same thread
    const next = holds.hold([X], 1000, idleOf);
    expect(holds.isHeld(X)).toBe(true);
    expect((await settled(next, 999)).done).toBe(false);
    expect((await settled(next, 1)).value?.busy).toEqual([X]);
  });

  it("(f) a turn pruned by the probe no longer short-circuits: the next hold succeeds", async () => {
    const holds = new InstanceHolds();
    holds.watch(X, () => false);
    await lostToA(holds);
    await vi.advanceTimersByTimeAsync(31_000);
    const next = await settled(holds.hold([X], 1000, idleOf), 0);
    expect(next.done).toBe(true);
    expect(next.value?.busy).toEqual([]);
    next.value?.release();
  });

  it("(g) only the lost instance is skipped; the others of the same call are held and released as before", async () => {
    const holds = await lostToA();
    const closed: string[] = [];
    const released: string[] = [];
    const result = await settled(holds.hold([X, "codex"], 4000, async (id) => { closed.push(id); return { confirmed: true, release: () => { released.push(id); } }; }), 0);
    expect(result.value?.busy).toEqual([X]);
    expect(closed).toEqual(["codex"]);
    expect(holds.isHeld("codex")).toBe(true);
    expect(holds.isHeld(X)).toBe(false);
    result.value?.release();
    expect(released).toEqual(["codex"]);
    expect(holds.isHeld("codex")).toBe(false);
  });

  it("(h) holdNow and an ordinary hold on another instance are untouched", async () => {
    const holds = await lostToA();
    const release = holds.holdNow([X]);
    expect(holds.isHeld(X)).toBe(true);
    release();
    expect(holds.isHeld(X)).toBe(false);
  });
});
