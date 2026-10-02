// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { IO_BUDGET_MAX_SCALE, IoBudget, type IoReading } from "./io-budget.ts";

const MINUTE = 60_000;
/** 1 MB written per minute = 2048 blocks of 512 bytes. */
const MB = 2048;

function rig(options: Partial<ConstructorParameters<typeof IoBudget>[0]> = {}) {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const lines: string[] = [], scales: number[] = [];
  const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), onScale: scale => scales.push(scale), ...options });
  const minute = (writeMb: number, cpu: number) => {
    reading = { at: reading.at + MINUTE, fsWriteBlocks: reading.fsWriteBlocks + writeMb * MB, cpuMicros: reading.cpuMicros + cpu * MINUTE * 1000 };
    return budget.tick();
  };
  budget.tick();
  return { budget, lines, scales, minute };
}

describe("io-budget", () => {
  it("stays quiet while the process is calm", () => {
    const { lines, scales, minute, budget } = rig();
    for (let i = 0; i < 30; i++) expect(minute(5, 0.1)?.tripped).toBe(false);
    expect(lines).toEqual([]); expect(scales).toEqual([]); expect(budget.pollScale()).toBe(1);
  });

  it("logs the top statements and halves the poll rate above 50 MB a minute", () => {
    const { lines, scales, minute, budget } = rig();
    budget.note("SELECT cheap", 1);
    budget.note("WITH raw AS (  SELECT m.rowid\n FROM messages m)", 400);
    budget.note("WITH raw AS (  SELECT m.rowid\n FROM messages m)", 300);
    expect(minute(60, 0.1)?.tripped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[io-budget\] writing 60\.0 MB\/min/);
    expect(lines[0]).toContain("700ms x2 WITH raw AS ( SELECT m.rowid FROM messages m)");
    expect(scales).toEqual([2]); expect(budget.pollScale()).toBe(2);
    minute(60, 0.1); minute(60, 0.1); minute(60, 0.1); minute(60, 0.1);
    expect(budget.pollScale()).toBe(IO_BUDGET_MAX_SCALE);
  });

  it("trips on 80 percent cpu only after three minutes in a row", () => {
    const { lines, minute, budget } = rig();
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.2)?.tripped).toBe(false); // a calm minute resets the run
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.95)?.tripped).toBe(true);
    expect(lines[0]).toMatch(/cpu 95% for 3 min/); expect(budget.pollScale()).toBe(2);
  });

  it("backs the poll rate off again after ten calm minutes", () => {
    const { scales, minute, budget } = rig();
    minute(60, 0.1); expect(budget.pollScale()).toBe(2);
    for (let i = 0; i < 9; i++) minute(1, 0.1);
    expect(budget.pollScale()).toBe(2);
    minute(1, 0.1); expect(budget.pollScale()).toBe(1);
    expect(scales).toEqual([2, 1]);
  });

  it("never throws into the app, whatever the sampler or a listener does", () => {
    const budget = new IoBudget({ read: () => { throw new Error("no usage"); } });
    expect(budget.tick()).toBeNull();
    const { minute } = rig({ onScale: () => { throw new Error("listener broke"); } });
    expect(() => minute(60, 0.1)).not.toThrow();
  });
});
