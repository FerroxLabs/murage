// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { heldStep, logEligibilityBatch, longOp, noteActiveTask, noteLoopHolder, oldestLongOp, rateLimited, reportLoopLag, reportSlowSql, resetObserveWindows, runningLongOps, setObserveSink, startLoopLagMonitor, startLoopStallWatch, stopLoopLagMonitor, stopLoopStallWatch } from "./observe.ts";

let lines: string[];
beforeEach(() => { lines = []; resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => { stopLoopLagMonitor(); stopLoopStallWatch(); setObserveSink(); });

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

it("a main-thread block over the threshold is one stall line at once, naming what held the thread", async () => {
  startLoopStallWatch(150, 20);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(lines.filter(line => line.startsWith("[loop] stall"))).toEqual([]);
  const restore = noteActiveTask("memory.publish");
  const end = performance.now() + 400; while (performance.now() < end) { /* a step that holds the loop */ }
  noteLoopHolder("memory.worker-message.deferred", 390);
  await new Promise(resolve => setTimeout(resolve, 60));
  restore();
  const stalls = lines.filter(line => line.startsWith("[loop] stall"));
  expect(stalls).toHaveLength(1);
  expect(stalls[0]).toMatch(/^\[loop\] stall blocked=\d+ms holder=memory\.worker-message\.deferred:390ms active=memory\.publish(?: gc=\d+ms)?$/); // (a collector pause inside the block is named after it)
  expect(Number(/blocked=(\d+)/.exec(stalls[0]!)![1])).toBeGreaterThan(150);
});


it("a stall names the step that held the loop longest IN ALL: a thousand short calls outweigh one long one", async () => {
  startLoopStallWatch(150, 20);
  await new Promise(resolve => setTimeout(resolve, 60));
  const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* work */ } };
  heldStep("one.slow", () => busy(60));
  for (let i = 0; i < 200; i++) heldStep("many.short", () => busy(1.5));
  await new Promise(resolve => setTimeout(resolve, 60));
  const stalls = lines.filter(line => line.startsWith("[loop] stall"));
  expect(stalls).toHaveLength(1);
  const match = /holder=many\.short:(\d+)msx200 others=one\.slow:(\d+)ms/.exec(stalls[0]!);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThanOrEqual(290);
});

it("slow lineage statements are reported under their own source, not as unattributed", async () => {
  const { ioBudget } = await import("./io-budget.ts");
  ioBudget.note("WITH direct(b) AS MATERIALIZED (SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=?)", 80, true);
  ioBudget.note("SELECT 1 FROM memory_session_roots WHERE thread_id=?", 70, true);
  const slow = lines.filter(line => line.startsWith("[sqlite] slow"));
  expect(slow).toHaveLength(2);
  for (const line of slow) expect(line).toMatch(/source=lineage$/);
});

it("rc13: a slow statement no source claims is named after the step running, else after its caller, never unattributed", async () => {
  const { ioBudget } = await import("./io-budget.ts");
  // inside a named step (rc13 real-data run: the continuity pass's reads, a 1032 ms `sqlite:unattributed` holder)
  heldStep("memory.pip.threads", () => ioBudget.note("SELECT s.speaker FROM memory_sources s WHERE s.thread_id=?", 90, true));
  // in no step at all (the owner-tail backfill's 714 ms page): the first frame outside the database layer
  const unclaimedCaller = () => ioBudget.note("SELECT id,version,created_at FROM memory_records WHERE (id,version)>(?,?)", 80, true);
  unclaimedCaller();
  const slow = lines.filter(line => line.startsWith("[sqlite] slow"));
  expect(slow).toHaveLength(2);
  expect(slow[0]).toMatch(/source=step:memory\.pip\.threads$/);
  expect(slow[1]).toMatch(/source=caller:observe\.test\.ts:\d+/);
  for (const line of slow) expect(line).not.toMatch(/source=none|unattributed/);
});

it("MURAGE_STALL_MS sets the stall threshold within 50..60000 ms and falls back to 1000 otherwise", async () => {
  const { stallThresholdFromEnv, stallTickFor } = await import("./observe.ts");
  expect(stallThresholdFromEnv(undefined)).toBe(1_000);
  expect(stallThresholdFromEnv("250")).toBe(250);
  expect(stallThresholdFromEnv("50")).toBe(50);
  expect(stallThresholdFromEnv("60000")).toBe(60_000);
  for (const bad of ["49", "60001", "abc", "", " ", "NaN", "-5", "Infinity"]) expect(stallThresholdFromEnv(bad)).toBe(1_000);
  expect(stallThresholdFromEnv("250.9")).toBe(250);
  // the tick is finer than the threshold so a 250 ms block is measured
  expect(stallTickFor(250)).toBe(50);
  expect(stallTickFor(1_000)).toBe(200);
  expect(stallTickFor(50)).toBe(25);
  expect(stallTickFor(60_000)).toBe(250);
  const previous = process.env.MURAGE_STALL_MS;
  process.env.MURAGE_STALL_MS = "250";
  try {
    vi.resetModules();
    const fresh = await import("./observe.ts");
    expect(fresh.STALL_THRESHOLD_MS).toBe(250);
  } finally { if (previous === undefined) delete process.env.MURAGE_STALL_MS; else process.env.MURAGE_STALL_MS = previous; vi.resetModules(); }
});

it("a 250 ms threshold with its tied tick reports a 400 ms block", async () => {
  const { stallTickFor } = await import("./observe.ts");
  startLoopStallWatch(250, stallTickFor(250));
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(lines.filter(line => line.startsWith("[loop] stall"))).toEqual([]);
  const end = performance.now() + 450; while (performance.now() < end) { /* a block */ }
  await new Promise(resolve => setTimeout(resolve, 120));
  const stalls = lines.filter(line => line.startsWith("[loop] stall"));
  expect(stalls).toHaveLength(1);
  expect(Number(/blocked=(\d+)/.exec(stalls[0]!)![1])).toBeGreaterThan(250);
});

// T9 (STALLS-FINAL-DESIGN section 4): a stall line says how much of the block was the garbage collector (`gc=<ms>`), which separates work
// outside any named step from a collector pause; the holder text is unchanged otherwise.
it("a block with forced collections inside it is a stall line that names the collector's share", async () => {
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  startLoopStallWatch(150, 20);
  await new Promise(resolve => setTimeout(resolve, 60));
  // a heap with something to collect, then a 300 ms block that collects it several times
  let garbage: unknown[] = Array.from({ length: 200_000 }, (_, i) => ({ i, s: `item ${i}` }));
  heldStep("memory.pip.pending", () => {
    const end = performance.now() + 300;
    while (performance.now() < end) { garbage = Array.from({ length: 100_000 }, (_, i) => ({ i })); gc(); }
  });
  expect(garbage).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 80));
  const stall = lines.find(line => line.startsWith("[loop] stall"));
  expect(stall).toMatch(/^\[loop\] stall blocked=\d+ms holder=memory\.pip\.pending:\d+ms gc=\d+ms$/);
});

it("a block that allocates nothing keeps the holder text as it was (gc, if any, only appended)", async () => {
  startLoopStallWatch(150, 20);
  await new Promise(resolve => setTimeout(resolve, 60));
  heldStep("memory.publish", () => { const end = performance.now() + 300; while (performance.now() < end) { /* no allocation */ } });
  await new Promise(resolve => setTimeout(resolve, 80));
  const stall = lines.find(line => line.startsWith("[loop] stall"));
  expect(stall).toMatch(/^\[loop\] stall blocked=\d+ms holder=memory\.publish:\d+ms(?: gc=\d+ms)?$/);
});
