// The scheduler notice: shown while stalled, kept through a failed check, cleared on recovery,
// and no timer left behind on unmount. The repo has no DOM environment, so the watcher (what the
// page's hook runs inside its effect) is driven with fake timers and the notice is rendered to markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { RoutineSchedulerNotice, watchRoutineScheduler, SCHEDULER_CHECK_MS } = await import("./RoutineSchedulerNotice");

const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("RoutineSchedulerNotice", () => {
  it("renders the warning only when late", () => {
    expect(renderToStaticMarkup(createElement(RoutineSchedulerNotice, { late: false }))).toBe("");
    const html = renderToStaticMarkup(createElement(RoutineSchedulerNotice, { late: true }));
    expect(html).toContain('data-testid="routine-scheduler-late"');
    expect(html).toContain("Routines are running late");
  });
});

describe("watchRoutineScheduler", () => {
  it("reports a stalled status on the first check", async () => {
    const seen: boolean[] = [];
    const stop = watchRoutineScheduler(async () => true, (late) => seen.push(late));
    await flush();
    expect(seen).toEqual([true]);
    stop();
  });

  it("checks again every 30 seconds, keeps the notice through a failed request, and clears it on recovery", async () => {
    const answers: Array<boolean | Error> = [true, new Error("offline"), true, false];
    const load = vi.fn(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; });
    let shown = false;
    const stop = watchRoutineScheduler(load, (late) => { shown = late; });
    await flush();
    expect([load.mock.calls.length, shown]).toEqual([1, true]);
    await vi.advanceTimersByTimeAsync(SCHEDULER_CHECK_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect([load.mock.calls.length, shown]).toEqual([2, true]); // the failed request leaves the notice up
    await vi.advanceTimersByTimeAsync(SCHEDULER_CHECK_MS);
    expect([load.mock.calls.length, shown]).toEqual([3, true]);
    await vi.advanceTimersByTimeAsync(SCHEDULER_CHECK_MS);
    expect([load.mock.calls.length, shown]).toEqual([4, false]); // healthy again
    stop();
  });

  it("stops checking and ignores a late answer after unmount", async () => {
    let release!: (late: boolean) => void;
    const load = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const onChange = vi.fn();
    const stop = watchRoutineScheduler(load, onChange);
    stop();
    release(true);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SCHEDULER_CHECK_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
