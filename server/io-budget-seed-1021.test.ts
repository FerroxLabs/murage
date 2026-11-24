// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owners: recall-scope (recall-seed: the first build of recall views) and message-search (search-seed: the first index of existing
// messages); consumer owner: cause18e-overbudget (the io watchdog's minute verdict, io-budget.ts IO_SEED_BUDGETS).
// PERF-SPEC 0edba926a6: on a first start over imported history the idle minute (budget 1 MB) printed `writing 24.0 MB/min ... source:
// recall-build` and `writing 65.0 MB/min ... source: INSERT INTO messages` (the search index's own writes, with no name of their own).
// One-time seed work has a NAMED budget: its bytes are taken off the judged minute up to a per-minute room and a per-process total, and every
// minute that uses it prints a `[io-budget] seed:` line. Past the total, or for any other source, the minute trips exactly as before.
import { describe, expect, it } from "vitest";
import { IoBudget, type IoReading } from "./io-budget.ts";

const MINUTE = 60_000, MB = 1048576, MB_BLOCKS = 2048; // 1 MB in 512-byte blocks

function rig() {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const lines: string[] = [], scales: number[] = [];
  const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), onScale: scale => scales.push(scale), isIdle: () => true, systemOverloaded: () => null });
  /** One idle minute in which the process wrote `writeMb` in all, `sources` of it attributed by name. */
  const minute = (writeMb: number, sources: Record<string, number> = {}) => {
    for (const [name, mb] of Object.entries(sources)) budget.noteBytes(name, mb * MB);
    reading = { at: reading.at + MINUTE, fsWriteBlocks: reading.fsWriteBlocks + Math.round(writeMb * MB_BLOCKS), cpuMicros: reading.cpuMicros + 0.05 * MINUTE * 1000 };
    return budget.tick();
  };
  budget.tick();
  const over = () => lines.filter(line => /^\[io-budget\] (writing|cpu)/.test(line));
  const seed = () => lines.filter(line => line.startsWith("[io-budget] seed:"));
  return { budget, lines, scales, minute, over, seed };
}

describe("io-budget: named one-time seed budgets", () => {
  it("W-SEED-NAMED: the first build of recall views is judged under its named seed budget and says so", () => {
    const { budget, scales, minute, over, seed } = rig();
    const verdict = minute(12.4, { "recall-seed": 12 });
    expect(over(), "no over-budget line for the minute the views were first built").toEqual([]);
    expect(verdict?.tripped, "the minute did not trip").toBe(false);
    expect(seed(), "the minute that used the seed budget prints one named line").toHaveLength(1);
    expect(seed()[0]).toMatch(/^\[io-budget\] seed: recall-seed wrote 12\.0 MB \(first build of recall views\): 12\.0 MB under its one-time seed budget, 20\.0 of 32 MB left; judged 0\.4 MB\/min against the budget of 1 without them$/);
    expect(scales, "no poller was slowed for it").toEqual([]);
    expect(budget.pollScale()).toBe(1);
  });
  it("W-SEED-ONCE: the budget is per process: once it is used up the same writes trip as before", () => {
    const { minute, over, seed } = rig();
    expect(minute(30.2, { "recall-seed": 30 })?.tripped, "30 MB of the 32 MB seed budget").toBe(false);
    // 2 MB are left: of the next 20 MB, 18 are judged against the idle minute
    const verdict = minute(20.2, { "recall-seed": 20 });
    expect(verdict?.tripped, "past the per-process total the minute trips").toBe(true);
    expect(over(), "one over-budget line").toHaveLength(1);
    expect(over()[0]).toMatch(/^\[io-budget\] writing 18\.2 MB\/min \(budget 1, 2\.0 MB\/min planned not counted\); source: recall-seed/);
    expect(seed().at(-1)).toMatch(/recall-seed wrote 20\.0 MB \(first build of recall views\): 2\.0 MB under its one-time seed budget, 0\.0 of 32 MB left/);
    expect(minute(5.1, { "recall-seed": 5 })?.tripped, "nothing is left: every later byte counts").toBe(true);
  });
  it("W-SEED-HONEST: a seed minute still trips on what is not seed work, and names the seed bytes it did not count", () => {
    const { minute, over, seed } = rig();
    const verdict = minute(20, { "recall-seed": 12, "recall-build": 8 });
    expect(verdict?.tripped, "8 MB of ordinary rebuilds in the same minute").toBe(true);
    // the line blames the writer that was judged, not the seed source whose bytes were excused
    expect(over()[0]).toMatch(/^\[io-budget\] writing 8\.0 MB\/min \(budget 1, 12\.0 MB\/min planned not counted\); source: recall-build;/);
    expect(verdict?.source, "the deferred source is the judged writer").toBe("recall-build");
    expect(seed()).toHaveLength(1);
  });
  it("W-SEED-SEARCH: the search index's first build has its own name and room; the same bytes with no name trip", () => {
    const named = rig();
    expect(named.minute(65.3, { "search-seed": 65 })?.tripped, "65 MB of first search indexing, named").toBe(false);
    expect(named.over()).toEqual([]);
    expect(named.seed()[0]).toMatch(/^\[io-budget\] seed: search-seed wrote 65\.0 MB \(first search index of existing messages\): 65\.0 MB under its one-time seed budget, 4031\.0 of 4096 MB left/);
    const unnamed = rig();
    expect(unnamed.minute(65.3)?.tripped, "the same minute with no named source").toBe(true);
    expect(unnamed.over()[0]).toMatch(/^\[io-budget\] writing 65\.3 MB\/min \(budget 1\)/);
    expect(unnamed.seed()).toEqual([]);
  });
  it("a name that is not a seed source gets no room", () => {
    const { minute, over, seed } = rig();
    expect(minute(12.4, { "recall-build": 12 })?.tripped).toBe(true);
    expect(over()[0]).toMatch(/^\[io-budget\] writing 12\.4 MB\/min \(budget 1\); source: recall-build/);
    expect(seed()).toEqual([]);
  });
});
