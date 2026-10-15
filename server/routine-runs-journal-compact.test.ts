// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 bgwork (Fable r1 P1-1): incremental saves compact their own journal, so scheduled work alone
// never makes a file grow with uptime.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ failRename: false }));
vi.mock("./atomic.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./atomic.ts")>();
  return { ...real, writeFileAtomic: (...args: Parameters<typeof real.writeFileAtomic>) => { if (fault.failRename) throw new Error("simulated crash during compaction"); return real.writeFileAtomic(...args); } };
});

const { RoutineRunsJournal, routineRunsDir, routineRunsFileName } = await import("./routine-runs-journal.ts");

const dirs: string[] = [];
afterEach(() => { fault.failRename = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-compact-")); dirs.push(dir); return dir; };
const lines = (dir: string, routineId: string) => readFileSync(join(routineRunsDir(dir), routineRunsFileName(routineId)), "utf8").split("\n").filter(Boolean);
const run = (n: number, routineId = "r1") => ({ id: `run-${n}`, routineId, status: "completed", output: "x".repeat(200), scheduledFor: n });

function tick(journal: InstanceType<typeof RoutineRunsJournal>, n: number, routineId = "r1") {
  journal.append({ runs: [run(n, routineId)], routines: [{ id: routineId, nextRunAt: n } as { id: string }], removed: n > 5 ? [run(n - 5, routineId)] : [] });
}

describe("incremental journal compaction", () => {
  it("keeps the file bounded over 10,000 one-minute occurrences", () => {
    const dir = tempDir();
    const journal = new RoutineRunsJournal(dir);
    journal.load(undefined, "gen-1");
    for (let n = 1; n <= 10_000; n++) tick(journal, n);
    const count = lines(dir, "r1").length;
    // live: one state line + 5 runs; bound is 2 * live + 50 plus the append that crossed it
    expect(count).toBeLessThanOrEqual(2 * 6 + 50 + 3);
    const fresh = new RoutineRunsJournal(dir);
    const runs = fresh.load(undefined, "gen-1") as Array<{ id: string }>;
    expect(runs.map(r => r.id).sort()).toEqual([9996, 9997, 9998, 9999, 10000].map(n => `run-${n}`).sort());
    expect(fresh.routineStates.get("r1")).toMatchObject({ nextRunAt: 10_000 });
  });

  it("a crash during compaction loses nothing", () => {
    const dir = tempDir();
    const journal = new RoutineRunsJournal(dir);
    journal.load(undefined, "gen-1");
    fault.failRename = true;
    for (let n = 1; n <= 200; n++) expect(() => tick(journal, n)).not.toThrow();
    const before = readFileSync(join(routineRunsDir(dir), routineRunsFileName("r1")), "utf8");
    expect(before.split("\n").filter(Boolean).length).toBeGreaterThan(100); // compaction could not run
    expect(readdirSync(routineRunsDir(dir)).filter(name => !name.endsWith(".jsonl") || name.includes("tmp"))).toEqual([]);
    const crashed = new RoutineRunsJournal(dir);
    expect((crashed.load(undefined, "gen-1") as Array<{ id: string }>).length).toBe(5);
    expect(crashed.routineStates.get("r1")).toMatchObject({ nextRunAt: 200 });
    fault.failRename = false;
    tick(journal, 201);
    expect(lines(dir, "r1").length).toBeLessThan(20);
    const after = new RoutineRunsJournal(dir);
    expect((after.load(undefined, "gen-1") as unknown[]).length).toBe(5);
    expect(after.routineStates.get("r1")).toMatchObject({ nextRunAt: 201 });
  });
});
