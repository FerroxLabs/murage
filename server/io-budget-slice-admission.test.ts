// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IoBudget } from "./io-budget.ts";
const budgets: IoBudget[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { for (const budget of budgets.splice(0)) budget.stop(); vi.useRealTimers(); });
function watching() {
  const budget = new IoBudget({ read: () => ({ at: Date.now(), fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => true, systemOverloaded: () => null, log: () => {} });
  budget.start(); budgets.push(budget); return budget;
}
it("one measured backfill slice is repaid before another periodic writer starts", () => {
  const budget = watching(); budget.noteBytes("record-keys-backfill", 128 * 1024);
  expect(budget.deferredForMs("memory-upgrade")).toBeGreaterThanOrEqual(30_000);
  expect(budget.deferredForMs("owner-turn")).toBe(0);
  expect(budget.deferredForMs("search-index", { requested: true })).toBe(0);
  vi.advanceTimersByTime(29_999); expect(budget.shouldDefer("memory-notebook")).toBe(true);
  vi.advanceTimersByTime(1); expect(budget.shouldDefer("memory-notebook")).toBe(false);
});
it("a second source cannot borrow a fresh minute while the first slice is still owed", () => {
  const budget = watching(); budget.noteBytes("record-keys-backfill", 64 * 1024);
  vi.advanceTimersByTime(5000); budget.noteBytes("memory-idle", 64 * 1024);
  expect(budget.deferredForMs("push-delivery")).toBeGreaterThanOrEqual(25_000);
  vi.advanceTimersByTime(25_000); expect(budget.shouldDefer("push-delivery")).toBe(false);
});
