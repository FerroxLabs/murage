// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { withRecallBudget, noteRecallMode, takeRecallMode } from "./recall-budget.ts";
import { PreDispatchTimer, resetTurnLineCount, SLOW_TURN_LINE_MS, TURN_LINE_SAMPLE } from "./turn-spans.ts";

it("adds named spans up, leaves the rest as other, and writes the documented fields", () => {
  const lines: string[] = [];
  const timer = new PreDispatchTimer(line => lines.push(line));
  const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* work */ } };
  timer.sync("recall", () => busy(20));
  timer.sync("assert.dispatch", () => busy(10));
  timer.sync("assert.images", () => busy(5));
  timer.sync("replay.filter", () => busy(8));
  timer.sync("primer", () => busy(4));
  busy(15);
  const summary = timer.summary({ route: "flux", engine: "claudeAgent", resumed: true, recallMode: "hybrid" });
  expect(summary).toMatchObject({ route: "flux", engine: "claudeAgent", resumed: "true", recallMode: "hybrid" });
  expect(Number(summary.recall)).toBeGreaterThanOrEqual(19);
  expect(Number(summary.assert)).toBeGreaterThanOrEqual(14);
  expect(Number(summary.replayFilter)).toBeGreaterThanOrEqual(7);
  expect(Number(summary.other)).toBeGreaterThanOrEqual(14);
  expect(Number(summary.pre)).toBeGreaterThanOrEqual(Number(summary.recall) + Number(summary.assert) + Number(summary.other));
});

it("writes a line for every slow turn and for one in fifty of the rest", () => {
  resetTurnLineCount();
  const lines: string[] = [];
  const quick = () => new PreDispatchTimer(line => lines.push(line));
  let written = 0;
  for (let n = 0; n < TURN_LINE_SAMPLE * 2; n++) if (quick().finish({})) written++;
  expect(written).toBe(2);
  expect(lines[0]).toMatch(/^\[memory\] turn route=native engine=unknown resumed=false pre=\d+ recall=\d+ recallMode=lexical assert=\d+ replayFilter=\d+ other=\d+ loopP99=\d+/);
  const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(SLOW_TURN_LINE_MS + 50);
  try {
    const slow = new PreDispatchTimer(line => lines.push(line));
    const before = lines.length;
    expect(slow.finish({ recallMode: "skipped", skippedReason: "budget" })).toBe(true);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toContain("recallMode=skipped:budget");
  } finally { clock.mockRestore(); }
});

it("a spans line carries the spans it has no field for, by name", () => {
  resetTurnLineCount();
  const lines: string[] = [];
  for (let n = 0; n < TURN_LINE_SAMPLE; n++) { const t = new PreDispatchTimer(line => lines.push(line)); t.sync("primer", () => {}); t.finish({}); }
  expect(lines.some(line => / primer=\d+/.test(line))).toBe(true);
});

it("an overlapped recall that is back in time is used, a late one is skipped, a failure still fails", async () => {
  vi.useFakeTimers();
  try {
    const fast = withRecallBudget(Promise.resolve("bundle"), 300);
    await expect(fast).resolves.toEqual({ value: "bundle" });
    const never = new Promise<string>(() => {});
    const late = withRecallBudget(never, 300);
    await vi.advanceTimersByTimeAsync(301);
    await expect(late).resolves.toEqual({ skipped: "budget" });
    const failing = withRecallBudget(Promise.reject(new Error("MEMORY_CONTEXT_REVOKED")), 300);
    await expect(failing).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  } finally { vi.useRealTimers(); }
  noteRecallMode("t", "hybrid");
  expect(takeRecallMode("t")).toBe("hybrid");
  expect(takeRecallMode("t")).toBeUndefined();
});
