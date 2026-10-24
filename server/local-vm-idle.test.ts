import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_VM_IDLE_LONG_MS, LOCAL_VM_IDLE_SHORT_MS, LocalVmIdleTimer, localVmIdleWindowMs, taskMayReturn } from "./local-vm-idle.ts";

describe("LocalVmIdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suspends only after a complete idle window", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("renews the deadline on activity", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("never suspends active work and retries after another full window", async () => {
    let busy = true;
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => busy, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("can be cancelled after a manual stop", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);
    idle.touch();
    idle.cancel();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).not.toHaveBeenCalled();
  });

  it("re-arms after a transient suspension failure", async () => {
    const suspend = vi.fn().mockRejectedValueOnce(new Error("runtime unavailable")).mockResolvedValue(undefined);
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it("frees an unused VM after the short window, but keeps it for an overnight routine", () => {
    expect(localVmIdleWindowMs(false)).toBe(LOCAL_VM_IDLE_SHORT_MS);
    expect(localVmIdleWindowMs(true)).toBe(LOCAL_VM_IDLE_LONG_MS);
    expect(LOCAL_VM_IDLE_SHORT_MS).toBeLessThan(LOCAL_VM_IDLE_LONG_MS);
  });

  it("recycles at the short window when nothing could come back", async () => {
    let routine = false;
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(() => localVmIdleWindowMs(routine), () => false, suspend, LOCAL_VM_IDLE_SHORT_MS);
    idle.touch();
    await vi.advanceTimersByTimeAsync(LOCAL_VM_IDLE_SHORT_MS - 1);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("waits out the long window once a routine is switched on, and recycles after it", async () => {
    let routine = false;
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(() => localVmIdleWindowMs(routine), () => false, suspend, LOCAL_VM_IDLE_SHORT_MS);
    idle.touch();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    routine = true; // switched on while the first look is pending
    await vi.advanceTimersByTimeAsync(LOCAL_VM_IDLE_SHORT_MS - 30 * 60_000);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LOCAL_VM_IDLE_LONG_MS - LOCAL_VM_IDLE_SHORT_MS - 1);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("a routine switched off while the long window is running is noticed at the first look", async () => {
    let routine = true;
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(() => localVmIdleWindowMs(routine), () => false, suspend, LOCAL_VM_IDLE_SHORT_MS);
    idle.touch();
    routine = false;
    await vi.advanceTimersByTimeAsync(LOCAL_VM_IDLE_SHORT_MS);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("counts a pending snooze or an owed wake as work that may return", () => {
    expect(taskMayReturn({}, 1_000)).toBe(false);
    expect(taskMayReturn({ snoozedUntil: 500 }, 1_000)).toBe(false);
    expect(taskMayReturn({ snoozedUntil: 5_000 }, 1_000)).toBe(true);
    expect(taskMayReturn({ askerWakes: { owed: [] } }, 1_000)).toBe(true);
  });
});
