// SPDX-License-Identifier: AGPL-3.0-or-later
// q1022-ordfiles (the owner's Mac, 11-23..11-24: ~80 idle lines a day "writing 1-25 MB/min (budget 1); source: ordinary-files"). A minute is
// judged on the largest of the OS count, the meter and the named sources, but it was blamed on the largest NAMED source. Database bytes no
// source's transaction took (takeWrittenBytes leaves database buckets out: a WAL copy, a worker thread's own connection) and an OS count
// above the meter had no name, so an idle minute was blamed on the one small writer it also saw: the health log's ~800-byte append.
// These rows drive IoBudget.tick with injected readings (line format only). The production-meter witnesses for the same paths
// (database bytes no source took; OS bytes above the meter; the first reading) are server/io-budget-meter-1022.test.ts.
import { describe, expect, it } from "vitest";
import { IoBudget, IO_BUDGET_INTERVAL_MS, type IoReading } from "./io-budget.ts";

const MB = 1024 * 1024;
function rig(databaseMoved: () => Array<[string, number]> = () => []) {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const lines: string[] = [];
  const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), isIdle: () => true, systemOverloaded: () => null, databaseBuckets: databaseMoved });
  budget.tick();
  const minute = (osBytes: number, named: Record<string, number>) => {
    for (const [source, bytes] of Object.entries(named)) budget.noteBytes(source, bytes);
    reading = { at: reading.at + IO_BUDGET_INTERVAL_MS, fsWriteBlocks: reading.fsWriteBlocks + osBytes / 512, cpuMicros: reading.cpuMicros };
    return budget.tick();
  };
  return { lines, minute, budget };
}

describe("q1022-ordfiles: an idle minute is blamed on what wrote it", () => {
  it("W-UNNAMED: 8 MB the OS counted beside an 800-byte health append is not blamed on ordinary-files", () => {
    let moved: Array<[string, number]> = [];
    const { lines, minute } = rig(() => { const m = moved; moved = []; return m; });
    moved = [["database:/fixture/messages.db", 8 * MB]];
    const verdict = minute(8 * MB, { "ordinary-files": 800 });
    expect(verdict?.tripped).toBe(true);
    expect(lines[0]).toMatch(/^\[io-budget\] writing 8\.0 MB\/min \(budget 1\); source: unnamed \(meter: database:messages\.db\); bytes: os 8\.0 MB, meter 0\.0 MB, named 0\.0 MB \(ordinary-files 0\.0\), unnamed 8\.0 MB \(meter by file: database:messages\.db 8\.0\);/);
    // the deferral key is unchanged (the top named source): the line names the bytes, the control does not move
    expect(verdict?.source).toBe("ordinary-files");
  });
  it("W-UNNAMED-OS: an OS count above every meter (no database file moved) is named as unnamed, never as the small named writer", () => {
    const { lines, minute } = rig();
    expect(minute(5 * MB, { "ordinary-files": 800 })?.tripped).toBe(true);
    expect(lines[0]).toContain("; source: unnamed; bytes: os 5.0 MB");
  });
  it("W-NAMED-HEAVY: a named writer whose copy-back the meter also counted keeps the blame and its deferral", () => {
    let moved: Array<[string, number]> = [];
    const { lines, minute, budget } = rig(() => { const m = moved; moved = []; return m; });
    moved = [["database:/fixture/messages.db", 9 * MB]];
    expect(minute(9 * MB, { "memory-capture": 5 * MB })?.source).toBe("memory-capture");
    expect(lines[0]).toContain("; source: memory-capture; bytes: os 9.0 MB, meter 0.0 MB, named 5.0 MB (memory-capture 5.0), unnamed 4.0 MB (meter by file: database:messages.db 9.0);");
    expect(budget.shouldDefer("memory-capture")).toBe(true);
  });
  it("a named writer that wrote the minute keeps the blame (and its share is in the split)", () => {
    const { lines, minute } = rig();
    expect(minute(6 * MB, { "ordinary-files": 6 * MB })?.source).toBe("ordinary-files");
    expect(lines[0]).toContain("; source: ordinary-files; bytes: os 6.0 MB, meter 0.0 MB, named 6.0 MB (ordinary-files 6.0), unnamed 0.0 MB;");
  });
});
