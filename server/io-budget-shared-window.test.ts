// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IoBudget, IO_BUDGET_IDLE_BYTES_PER_MINUTE } from "./io-budget.ts";
const MB = 1024 * 1024;
const opened: IoBudget[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { for (const budget of opened.splice(0)) budget.stop(); vi.useRealTimers(); });
function watching() {
  const lines: string[] = [];
  const budget = new IoBudget({ read: () => ({ at: Date.now(), fsWriteBlocks: 0, cpuMicros: 0 }),
    isIdle: () => true, systemOverloaded: () => null, log: line => lines.push(line) });
  budget.start(); opened.push(budget); return { budget, lines };
}
it("separate periodic writers share the idle allowance before the next watchdog sample", () => {
  const { budget } = watching();
  budget.noteBytes("memory-idle", IO_BUDGET_IDLE_BYTES_PER_MINUTE * 0.6);
  budget.noteBytes("record-keys-backfill", IO_BUDGET_IDLE_BYTES_PER_MINUTE * 0.6);
  expect(budget.shouldDefer("search-index")).toBe(true);
  expect(budget.deferredForMs("memory-upgrade")).toBeGreaterThan(0);
});
it("an oversized background slice leaves debt across watchdog samples", () => {
  const { budget } = watching(); budget.noteBytes("memory-idle", 2 * MB);
  vi.advanceTimersByTime(60_001);
  expect(budget.shouldDefer("search-index")).toBe(true);
});
it("background debt never defers an owner turn or its explicit route write", () => {
  const { budget } = watching(); budget.noteBytes("memory-idle", 100 * MB);
  expect(budget.shouldDefer("owner-turn")).toBe(false);
  expect(budget.deferredForMs("route:POST /api/bots/:id/messages")).toBe(0);
});
it("background work becomes eligible again as its measured debt is repaid", () => {
  const { budget } = watching(); budget.noteBytes("memory-idle", 300 * 1024);
  expect(budget.shouldDefer("search-index")).toBe(true);
  vi.advanceTimersByTime(90_000);
  expect(budget.shouldDefer("search-index")).toBe(false);
});
it("a short owner turn retains the active budget until that sample ends, then idle returns", () => {
  const { budget, lines } = watching();
  budget.noteForegroundActivity(); budget.noteBytes("owner-turn", 10 * MB);
  vi.advanceTimersByTime(60_000); expect(lines).toEqual([]);
  budget.noteBytes("memory-idle", 2 * MB); vi.advanceTimersByTime(60_000);
  expect(lines).toHaveLength(1); expect(lines[0]).toContain("writing 2.0 MB/min (budget 1)");
});
it("an active sample above fifty MB still reports its writing", () => {
  const { budget, lines } = watching();
  budget.noteForegroundActivity(); budget.noteBytes("owner-turn", 60 * MB);
  vi.advanceTimersByTime(60_000);
  expect(lines).toHaveLength(1); expect(lines[0]).toContain("writing 60.0 MB/min (budget 50)");
});
it("admission does not suppress diagnostics for an already written oversized idle slice", () => {
  const { budget, lines } = watching(); budget.noteBytes("memory-idle", 2 * MB);
  vi.advanceTimersByTime(60_000);
  expect(lines).toHaveLength(1); expect(lines[0]).toContain("writing 2.0 MB/min (budget 1)");
});
