import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForExit } from "./cleanup.ts";

// No real process or directory: signals are recorded on this owned stand-in.
function fakeChild() {
  const emitter = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
  });
  return { emitter, child: emitter as unknown as ChildProcess };
}

afterEach(() => vi.useRealTimers());

describe("waitForExit close evidence", () => {
  it("accepts an absent or already terminal child", async () => {
    await expect(waitForExit(undefined)).resolves.toBeUndefined();
    const { emitter, child } = fakeChild();
    emitter.exitCode = 0;
    await expect(waitForExit(child)).resolves.toBeUndefined();
    expect(emitter.kill).not.toHaveBeenCalled();
  });

  it("resolves graceful close and removes its listener and timer", async () => {
    vi.useFakeTimers();
    const { emitter, child } = fakeChild();
    const stopped = waitForExit(child, { signal: "SIGTERM", graceMs: 10 });
    expect(emitter.kill).toHaveBeenCalledWith("SIGTERM");
    emitter.emit("close", 0, null);
    await expect(stopped).resolves.toBeUndefined();
    expect(emitter.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emitter.kill).toHaveBeenCalledTimes(1);
  });

  it("waits for close after the forced signal", async () => {
    vi.useFakeTimers();
    const { emitter, child } = fakeChild();
    let settled = false;
    const stopped = waitForExit(child, { graceMs: 10 }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(emitter.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    emitter.emit("close", null, "SIGKILL");
    await stopped;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an unconfirmed close rather than continuing into cleanup", async () => {
    vi.useFakeTimers();
    const { emitter, child } = fakeChild();
    const cleanup = vi.fn();
    const result = waitForExit(child, { signal: "SIGTERM", graceMs: 10 }).then(
      () => { cleanup(); return { status: "resolved" }; },
      (error: Error & { code?: string }) => ({ status: "rejected", code: error.code }),
    );
    await vi.advanceTimersByTimeAsync(2_010);
    expect(await result).toEqual({ status: "rejected", code: "CHILD_EXIT_UNCONFIRMED" });
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitter.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(emitter.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    emitter.emit("close", 0, null);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("rejects a forced-signal exception without leaving observation behind", async () => {
    vi.useFakeTimers();
    const { emitter, child } = fakeChild();
    const denied = new Error("fixture signal denied");
    emitter.kill.mockImplementation(() => { throw denied; });
    const result = waitForExit(child, { graceMs: 10 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe(denied);
    expect(emitter.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule escalation after synchronous close", async () => {
    vi.useFakeTimers();
    const { emitter, child } = fakeChild();
    emitter.kill.mockImplementation(() => { emitter.emit("close", 0, null); return true; });
    await waitForExit(child, { signal: "SIGTERM", graceMs: 10 });
    expect(vi.getTimerCount()).toBe(0);
    expect(emitter.listenerCount("close")).toBe(0);
  });
});
