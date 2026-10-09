// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it } from "vitest";
import { logEligibilityBatch, longOp, oldestLongOp, rateLimited, reportLoopLag, reportSlowSql, resetObserveWindows, runningLongOps, setObserveSink, startLoopLagMonitor, stopLoopLagMonitor } from "./observe.ts";

let lines: string[];
beforeEach(() => { lines = []; resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => { stopLoopLagMonitor(); setObserveSink(); });

it("a line is written once per window and says how many it folded in", () => {
  expect(rateLimited("k", 1000, n => `a more=${n}`, 0)).toBe(true);
  expect(rateLimited("k", 1000, n => `a more=${n}`, 10)).toBe(false);
  expect(rateLimited("k", 1000, n => `a more=${n}`, 20)).toBe(false);
  expect(rateLimited("k", 1000, n => `a more=${n}`, 1500)).toBe(true);
  expect(lines).toEqual(["a more=0", "a more=2"]);
});

it("a registered long operation is named while it runs and gone after, even when it throws", () => {
  longOp("vacuum", () => { expect(runningLongOps()).toEqual(["vacuum"]); expect(oldestLongOp()).toBe("vacuum"); });
  expect(() => longOp("boom", () => { throw new Error("x"); })).toThrow("x");
  expect(runningLongOps()).toEqual([]);
});

it("a slow statement is one line per operation per minute, with its source", () => {
  reportSlowSql("SELECT ? FROM memory_jobs", 120, "memory-worker");
  reportSlowSql("SELECT ? FROM memory_jobs", 130, "memory-worker");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[sqlite\] slow op=SELECT \? FROM memory_jobs ms=120 source=memory-worker$/);
});

it("the loop-lag line appears only when p99 is over the threshold and names the biggest holder", async () => {
  startLoopLagMonitor(3_600_000, 100);
  await new Promise(resolve => setTimeout(resolve, 80));  // the monitor's own timer is running before the block
  expect(reportLoopLag(100)).toBeUndefined();   // (a reset drops the next sample, so the monitor is primed again before the block)
  await new Promise(resolve => setTimeout(resolve, 80));
  const end = performance.now() + 250; while (performance.now() < end) { /* a step that holds the loop */ }
  reportSlowSql("INSERT ? INTO memory_records", 250, "memory-worker");
  await new Promise(resolve => setTimeout(resolve, 60));
  const line = reportLoopLag(100);
  expect(line).toMatch(/^\[loop\] lag p50=\d+ p99=\d+ max=\d+ topSource=sqlite:memory-worker$/);
  expect(lines).toContain(line);
});

it("the eligibility line carries counts and a version, nothing else", () => {
  logEligibilityBatch("2026.10", { keep: 40, ask: 3, refuse: 1, unknown: 0 });
  logEligibilityBatch("a b\nsecret", { keep: 1, ask: 0, refuse: 0, unknown: 0 });
  expect(lines).toEqual(["[memory] eligibility rule=2026.10 keep=40 ask=3 refuse=1 unknown=0", "[memory] eligibility rule=unversioned keep=1 ask=0 refuse=0 unknown=0"]);
});
