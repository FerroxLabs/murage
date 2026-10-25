// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SELF-OVERLOAD-105 item 1b: bytes a writer with its own budget planned (the revoke marker's, revoke-budget.ts) are taken off the minute
// before the io watchdog's verdict. 1.0.4 tripped every idle minute the marker ran at its 20 MB/min allowance (the idle budget is 1 MB/min),
// scaled every poller down 8x and deferred the memory worker behind "messages.db".
import { describe, expect, it } from "vitest";
import { IoBudget, type IoReading } from "./io-budget.ts";

const MINUTE = 60_000;
const MB_BLOCKS = 2048; // 1 MB in 512-byte blocks

function rig(idle: boolean) {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const lines: string[] = [], scales: number[] = [];
  const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), onScale: scale => scales.push(scale), isIdle: () => idle, systemOverloaded: () => null });
  const minute = (writeMb: number) => {
    reading = { at: reading.at + MINUTE, fsWriteBlocks: reading.fsWriteBlocks + Math.round(writeMb * MB_BLOCKS), cpuMicros: reading.cpuMicros + 0.05 * MINUTE * 1000 };
    return budget.tick();
  };
  budget.tick();
  return { budget, lines, scales, minute };
}

describe("io-budget: planned bytes", () => {
  it("fail-before: the marker's planned bytes exist and are not counted against the idle budget", () => {
    const { budget, lines, scales, minute } = rig(true);
    expect(typeof (budget as { setPlannedBytes?: unknown }).setPlannedBytes).toBe("function");
    // 20 MB a minute, 19.6 MB of it the marker's own budgeted writes: under the 1 MB idle budget once they are taken off
    budget.setPlannedBytes(() => 19.6 * 1048576);
    for (let i = 0; i < 5; i++) expect(minute(20)?.tripped).toBe(false);
    expect(lines).toEqual([]); expect(scales).toEqual([]); expect(budget.pollScale()).toBe(1);
  });
  it("the same minute without a planned reader trips, as before", () => {
    const { budget, lines, minute } = rig(true);
    expect(minute(20)?.tripped).toBe(true);
    expect(lines[0]).toMatch(/^\[io-budget\] writing 20\.0 MB\/min \(budget 1\)/);
    expect(budget.pollScale()).toBe(2);
  });
  it("writes beyond the planned share still trip, and the line says what was not counted", () => {
    const { budget, lines, minute } = rig(true);
    budget.setPlannedBytes(() => 10 * 1048576);
    expect(minute(20)?.tripped).toBe(true);
    expect(lines[0]).toMatch(/writing 10\.0 MB\/min \(budget 1, 10\.0 MB\/min planned not counted\)/);
  });
  it("the marker's actual bytes beyond its plan still trip: 20 MB planned, 45 MB written, idle budget 1 MB", () => {
    const { budget, lines, minute } = rig(true);
    budget.setPlannedBytes(() => 20 * 1048576);
    expect(minute(45)?.tripped).toBe(true);
    expect(lines[0]).toMatch(/writing 25\.0 MB\/min \(budget 1, 20\.0 MB\/min planned not counted\)/);
  });
  it("another writer over the active budget still trips while the marker keeps to its plan: 19.6 MB planned, 80 MB written, budget 50", () => {
    const { budget, lines, minute } = rig(false);
    budget.setPlannedBytes(() => 19.6 * 1048576);
    expect(minute(30)?.tripped).toBe(false); // the marker alone, within its plan, under the active budget
    expect(minute(80)?.tripped).toBe(true); // 60.4 MB from everyone else
    expect(lines[0]).toMatch(/writing 60\.4 MB\/min \(budget 50/);
  });
  it("a reader is believed for at most its cap: a claim of 500 MB planned under a 25 MB cap hides nothing", () => {
    const { budget, lines, minute } = rig(true);
    budget.setPlannedBytes(() => 500 * 1048576, 25 * 1048576);
    expect(minute(60)?.tripped).toBe(true);
    expect(lines[0]).toMatch(/writing 35\.0 MB\/min \(budget 1, 25\.0 MB\/min planned not counted\)/);
  });
  it("a reader that throws or returns nonsense counts as zero planned", () => {
    const { budget, minute } = rig(true);
    budget.setPlannedBytes(() => { throw new Error("no ledger"); });
    expect(minute(20)?.tripped).toBe(true);
    budget.setPlannedBytes(() => Number.NaN);
    expect(minute(20)?.tripped).toBe(true);
    budget.setPlannedBytes(null);
    expect(minute(20)?.tripped).toBe(true);
  });
});
