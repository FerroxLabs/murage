import { afterEach, describe, expect, it, vi } from "vitest";
import { readPlanUsage } from "./plan-usage-read";
import type { PlanUsageReport } from "./plan-usage-view";

const report = (refreshing: boolean, percent = 72): PlanUsageReport => ({
  serverNow: 1_000, omitted: 0, nextCursor: null, cloud: false,
  accounts: [{ id: "0", engine: "Codex", bot: null, status: "current", checkedAt: 1_000, freshUntil: 601_000, refreshing,
    windows: [{ label: "plan", usedPercent: percent, resetsAt: null, windowSeconds: null, limitReached: false }] }],
});

afterEach(() => vi.useRealTimers());
describe("plan usage read completion", () => {
  it.each(["stale", "unavailable", "deferred"] as const)("rejects an HTTP 200 with a %s engine result", async (status) => {
    const failed = report(false);
    failed.accounts[0].status = status;
    const take = vi.fn();
    await expect(readPlanUsage(vi.fn().mockResolvedValue(failed), take, new AbortController().signal, true)).rejects.toThrow();
    expect(take).toHaveBeenCalledWith(failed, expect.any(Number));
  });
  it("keeps Refresh pending until the completed GET replaces the old POST reading", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(report(true)).mockResolvedValueOnce(report(true)).mockResolvedValueOnce(report(false, 81));
    const take = vi.fn();
    let finished = false;
    const work = readPlanUsage(read, take, new AbortController().signal, true).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await work;
    expect(take.mock.lastCall?.[0]).toEqual(report(false, 81));
    expect(read.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ["/api/plan-usage/refresh", "POST"], ["/api/plan-usage", "GET"], ["/api/plan-usage", "GET"],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("follows an already-running read on mount, without requesting new demand", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(report(true)).mockResolvedValueOnce(report(false));
    const work = readPlanUsage(read, vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await work;
    expect(read.mock.calls.every(([path, init]) => path === "/api/plan-usage" && init.method === "GET")).toBe(true);
  });
  it("cancels the follow-up timer when the card leaves", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue(report(true));
    const work = readPlanUsage(read, vi.fn(), controller.signal, true);
    const rejected = expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not publish a late response after cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const read = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const take = vi.fn();
    const work = readPlanUsage(read, take, controller.signal);
    const rejected = expect(work).rejects.toThrow();
    controller.abort();
    finish(report(false));
    await rejected;
    expect(take).not.toHaveBeenCalled();
  });
  it("surfaces a failed follow-up and stops reading", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(report(true)).mockRejectedValueOnce(new Error("offline"));
    const work = readPlanUsage(read, vi.fn(), new AbortController().signal, true);
    const rejected = expect(work).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds an indefinitely queued read", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(report(true));
    const work = readPlanUsage(read, vi.fn(), new AbortController().signal, true);
    const rejected = expect(work).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await rejected;
    expect(read.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
