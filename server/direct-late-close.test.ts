// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// RETAINED -> RELEASED_LATE: a direct run kept after an unconfirmed teardown is
// released by the engine's later confirmed close, never by a timer.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ENGINE_CLOSED_LATE_NOTE, releaseOnLateClose } from "./direct-late-close.ts";
import { TurnTeardowns } from "./drivers/child-teardown.ts";

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 5151 }) as unknown as ChildProcess;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** One retained run: `owns` mirrors directRuns.current, `exists` the conversation. */
function retained(closed: Promise<void>, state = { owns: true, exists: true }) {
  const notes: string[] = [];
  let releases = 0;
  releaseOnLateClose({
    closed,
    owns: () => state.owns,
    threadExists: () => state.exists,
    note: () => { notes.push(ENGINE_CLOSED_LATE_NOTE); },
    release: () => { releases++; state.owns = false; },
  });
  return { state, notes, get releases() { return releases; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("direct run late close", () => {
  it("a confirmed later close releases the retained run once, with one activity line", async () => {
    const child = fakeChild();
    let confirmed = false;
    const teardowns = new TurnTeardowns(async () => confirmed);
    teardowns.track("thread", "turn", child);
    const run = retained(teardowns.closed("thread", "turn"));
    confirmed = true;
    child.emit("close", 0, null);
    await flush();
    expect(run.releases).toBe(1);
    expect(run.notes).toEqual(["Engine closed; you can continue this conversation."]);
  });

  it("1. a replacement run owns the thread: no-op", async () => {
    const run = retained(Promise.resolve(), { owns: false, exists: true });
    await flush();
    expect(run.releases).toBe(0);
    expect(run.notes).toEqual([]);
  });

  it("2. Stop already released it: no-op", async () => {
    let close!: () => void;
    const run = retained(new Promise<void>(resolve => { close = resolve; }));
    run.state.owns = false; // Stop's own confirmed close released the generation first
    close();
    await flush();
    expect(run.releases).toBe(0);
    expect(run.notes).toEqual([]);
  });

  it("3. the child never closes: stays retained, with no timer", async () => {
    vi.useFakeTimers();
    const teardowns = new TurnTeardowns(async () => false);
    teardowns.track("thread", "turn", fakeChild());
    const before = vi.getTimerCount();
    const run = retained(teardowns.closed("thread", "turn"));
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(run.releases).toBe(0);
    expect(run.notes).toEqual([]);
    expect(teardowns.pending("thread")).toBe(true);
  });

  it("4. a platform-hook veto keeps it retained even after the root process closed", async () => {
    const child = fakeChild();
    const teardowns = new TurnTeardowns(async () => false); // the hook's answer is ANDed: false
    teardowns.track("thread", "turn", child);
    const run = retained(teardowns.closed("thread", "turn"));
    child.emit("close", 0, null);
    await flush();
    expect(run.releases).toBe(0);
    expect(run.notes).toEqual([]);
  });

  it("5. duplicate callbacks are idempotent", async () => {
    const child = fakeChild();
    const teardowns = new TurnTeardowns(async () => true);
    teardowns.track("thread", "turn", child);
    const state = { owns: true, exists: true };
    // the terminal event redelivered: two retains registered for the same run
    const first = retained(teardowns.closed("thread", "turn"), state);
    const second = retained(teardowns.closed("thread", "turn"), state);
    child.emit("close", 0, null);
    child.emit("close", 0, null);
    await flush();
    expect(first.releases + second.releases).toBe(1);
    expect([...first.notes, ...second.notes]).toHaveLength(1);
  });

  it("6. after a Murage restart there is nothing to release, and nothing throws", async () => {
    const fresh = new TurnTeardowns(async () => true); // a new process tracks no child
    const closed = fresh.closed("thread", "turn");
    await expect(closed).resolves.toBeUndefined();
    const run = retained(closed, { owns: false, exists: true }); // no direct run survives a restart
    await flush();
    expect(run.releases).toBe(0);
    expect(run.notes).toEqual([]);
  });

  it("7. a late close after the thread was deleted writes nothing", async () => {
    const child = fakeChild();
    const teardowns = new TurnTeardowns(async () => true);
    teardowns.track("thread", "turn", child);
    const run = retained(teardowns.closed("thread", "turn"));
    run.state.exists = false;
    child.emit("close", 0, null);
    await flush();
    expect(run.releases).toBe(0);
    expect(run.notes).toEqual([]);
  });

  it("a release that throws is contained", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    releaseOnLateClose({ closed: Promise.resolve(), owns: () => true, threadExists: () => true, note: () => {}, release: () => { throw new Error("boom"); } });
    await flush();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("TurnTeardowns.closed", () => {
  it("is captured before the wait: a close that drops the entry still resolves it", async () => {
    const child = fakeChild();
    const teardowns = new TurnTeardowns(async () => true);
    teardowns.track("thread", "turn", child);
    const closed = teardowns.closed("thread", "turn");
    child.emit("close", 0, null);
    await flush();
    expect(teardowns.pending("thread")).toBe(false);
    await expect(closed).resolves.toBeUndefined();
  });

  it("follows the named turn's child only", async () => {
    const first = fakeChild(), second = fakeChild();
    const teardowns = new TurnTeardowns(async () => true);
    teardowns.track("thread", "turn-1", first);
    teardowns.track("thread", "turn-2", second);
    let done = false;
    void teardowns.closed("thread", "turn-1").then(() => { done = true; });
    second.emit("close", 0, null);
    await flush();
    expect(done).toBe(false);
    first.emit("close", 0, null);
    await flush();
    expect(done).toBe(true);
  });
});
