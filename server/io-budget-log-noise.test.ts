// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { IoBudget, IO_BUDGET_MAX_SCALE, type IoReading } from "./io-budget.ts";

describe("io-budget diagnostic rate", () => {
  it.each(["writing", "cpu", "both"])("limits %s bursts across changing sources without skipping accounting or backoff", (kind) => {
    let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
    const lines: string[] = [];
    const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), bytesPerMinute: 1, cpuMinutes: 1, systemOverloaded: () => null });
    budget.tick();
    const trip = (at: number) => {
      const elapsed = at - reading.at;
      reading = { at, fsWriteBlocks: reading.fsWriteBlocks + (kind === "cpu" ? 0 : 1), cpuMicros: reading.cpuMicros + (kind === "writing" ? 0 : elapsed * 1000) };
      budget.note(`SELECT source_${at}`, 1);
      return budget.tick();
    };
    for (let at = 10; at <= 60_000; at += 10) expect(trip(at)?.tripped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("suppressed=0");
    expect(budget.pollScale()).toBe(IO_BUDGET_MAX_SCALE);
    expect(budget.shouldDefer("SELECT source_60000")).toBe(true);
    expect(trip(60_010)?.source).toBe("SELECT source_60010");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("suppressed=5999");
    trip(120_010);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("suppressed=0");
  });

  it.each(["cpu", "both"])("logs the first %s diagnostic immediately after writing and limits repeats separately", (kind) => {
    let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
    const lines: string[] = [];
    const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), bytesPerMinute: 1, cpuMinutes: 1, systemOverloaded: () => null });
    budget.tick();
    const trip = (at: number, cpu: boolean) => {
      const elapsed = at - reading.at;
      reading = { at, fsWriteBlocks: reading.fsWriteBlocks + (!cpu || kind === "both" ? 1 : 0), cpuMicros: reading.cpuMicros + (cpu ? elapsed * 1000 : 0) };
      budget.note(cpu ? "SELECT cpu_work" : "SELECT write_work", 5);
      expect(budget.tick()?.tripped).toBe(true);
    };
    trip(10, false);
    trip(20, false); // a suppressed write must not hide the first CPU fault
    trip(30, true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("writing");
    expect(lines[1]).toContain("cpu 100%");
    expect(lines[1]).toContain("top statements: 5ms x1 SELECT cpu_work");
    expect(lines[1]).toContain("suppressed=0");
    trip(40, true);
    expect(lines).toHaveLength(2);
    trip(60_010, false);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("writing");
    expect(lines[2]).toContain("suppressed=1");
    trip(60_020, true); // the CPU category's own minute has not elapsed
    expect(lines).toHaveLength(3);
    trip(60_030, true);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain("cpu 100%");
    expect(lines[3]).toContain("suppressed=2");
  });

  it("caps diagnostic size even with unbounded source names and keyed statements", () => {
    let at = 0;
    const lines: string[] = [];
    const budget = new IoBudget({ read: () => ({ at, fsWriteBlocks: 0, cpuMicros: 0 }), log: line => lines.push(line), bytesPerMinute: 1, systemOverloaded: () => null });
    budget.tick();
    budget.noteBytes("source".repeat(20_000), 100);
    budget.note("SELECT " + "📝".repeat(20_000), 1, true);
    at = 60_000;
    expect(budget.tick()?.tripped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("…; suppressed=0");
    // Three capped categories per minute remain comfortably below the 10 MB/min noise ceiling.
    expect(Buffer.byteLength(lines[0]!)).toBeLessThan(20_000);
  });
});
