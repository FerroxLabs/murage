// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 bgwork: a routine run start persists only what changed. The RC1 routine burst spent its main loop
// in RoutineManager.saveNow, which stringified every run and rewrote routines.json (every routine) on each
// scheduler tick. The bytes a run start writes must not grow with the number of routines or runs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ bytes: 0, fsyncs: 0, on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const size = (data: unknown) => typeof data === "string" ? Buffer.byteLength(data) : (data as Uint8Array)?.byteLength ?? 0;
  const wrapped = {
    ...real,
    writeSync: ((fd: number, data: unknown, ...rest: unknown[]) => { if (io.on) io.bytes += size(data); return (real.writeSync as (...args: unknown[]) => number)(fd, data, ...rest); }) as typeof real.writeSync,
    writeFileSync: ((path: unknown, data: unknown, ...rest: unknown[]) => { if (io.on) io.bytes += size(data); return (real.writeFileSync as (...args: unknown[]) => void)(path, data, ...rest); }) as typeof real.writeFileSync,
    fsyncSync: ((fd: number) => { if (io.on) io.fsyncs++; return real.fsyncSync(fd); }) as typeof real.fsyncSync,
  };
  return { ...wrapped, default: wrapped };
});

const { RoutineManager } = await import("./routines.ts");
const { routineRunsDir, routineRunsFileName, readRoutinesWithRuns } = await import("./routine-runs-journal.ts");

const dirs: string[] = [];
afterEach(() => { io.on = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-incsave-")); dirs.push(dir); return dir; };

const START = new Date(2026, 9, 12, 8, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

function manager(file: string, clock: { now: number }, started: string[] = []) {
  let task = 0;
  return new RoutineManager({
    file, now: () => clock.now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${String(++task).padStart(6, "0")}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
  });
}

/** A data folder with `routines` daily routines (all due tomorrow, one due at START+1h) and `runs` finished runs. */
function seeded(routines: number, runs: number) {
  const dir = tempDir(), file = join(dir, "routines.json"), clock = { now: START };
  // one real routine and one real finished run, as templates
  const template = manager(join(tempDir(), "routines.json"), clock);
  const made = template.create({ name: "Template", prompt: "Report", botId: "bot-1", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: START + 60 * 60_000 } });
  const routineTemplate = JSON.parse(JSON.stringify(made));
  const all = Array.from({ length: routines }, (_, index) => ({ ...routineTemplate, id: `routine-${String(index).padStart(5, "0")}`, name: `Routine ${String(index).padStart(5, "0")}`,
    nextRunAt: index === 0 ? START + 60 * 60_000 : START + DAY, schedule: { ...routineTemplate.schedule, anchorAt: index === 0 ? START + 60 * 60_000 : START + DAY } }));
  writeFileSync(file, JSON.stringify({ version: 1, routines: all, runs: [], routineRequestReceipts: [] }, null, 2));
  const journal = routineRunsDir(dir);
  mkdirSync(journal, { recursive: true });
  const byFile = new Map<string, string[]>();
  for (let index = 0; index < runs; index++) {
    const routineId = all[index % routines]!.id;
    const run = { id: `run-${String(index).padStart(7, "0")}`, routineId, routineName: "x", prompt: "Report", durationMinutes: 30, attachments: [], target: "bot", botId: "bot-1", runOn: "ember",
      scheduledFor: START - DAY + index, status: "completed", manual: false, triggerSource: "schedule", createdAt: START - DAY + index, startedAt: START - DAY + index, finishedAt: START - DAY + index + 1, output: "done" };
    const name = routineRunsFileName(routineId);
    (byFile.get(name) ?? byFile.set(name, []).get(name)!).push(JSON.stringify(run));
  }
  for (const [name, lines] of byFile) writeFileSync(join(journal, name), lines.join("\n") + "\n");
  return { file, clock };
}

/** Bytes and fsyncs from the due tick to the engine start of routine-00000. */
async function oneRunStart(routines: number, runs: number) {
  const { file, clock } = seeded(routines, runs);
  const started: string[] = [];
  const m = manager(file, clock, started);
  // the first save after a start compares everything once (it is not a run start): let it happen first,
  // so routines.json is this process's own file
  (m as unknown as { save: () => void }).save();
  clock.now = START + 60 * 60_000;
  io.bytes = 0; io.fsyncs = 0; io.on = true;
  await m.tick();
  io.on = false;
  expect(started).toHaveLength(1);
  return { bytes: io.bytes, fsyncs: io.fsyncs, file, manager: m, clock };
}

describe("routine run start writes only what changed", () => {
  it("bytes and fsyncs per run start are the same at 10 routines and at 2,000 routines with a full run history", async () => {
    const small = await oneRunStart(10, 10);
    // MAX_RUNS (2,000) caps run history across all routines: 2,000 routines x 1,000 runs each is trimmed to it at the
    // first save, so the largest history a run start can ever meet is 2,000 runs.
    const large = await oneRunStart(2_000, 2_000);
    // at the cap the start also retires the oldest finished run: one tombstone line, the same size at any scale
    expect(large.bytes).toBe(small.bytes + Buffer.byteLength(JSON.stringify({ $del: "run-0000000" }) + "\n"));
    expect(large.fsyncs).toBe(small.fsyncs);
    // one state line (cursor + the new run) and one run line for the start: a few kB, not routines.json
    expect(large.bytes).toBeLessThan(8_000);
    expect(large.fsyncs).toBeLessThanOrEqual(2);
  }, 120_000);

  it("the moved cursor and the started run survive a restart, and a later full write retires the state line", async () => {
    const { file, clock, manager: first } = await oneRunStart(10, 10);
    const due = first.listRoutines().find(routine => routine.id === "routine-00000")!;
    expect(due.nextRunAt).toBe(START + 60 * 60_000 + DAY);
    first.stop();
    // routines.json itself was not rewritten for the tick, but the state line applies on top of it
    const disk = readRoutinesWithRuns(file);
    expect(disk.routines.find((routine: { id: string }) => routine.id === "routine-00000").nextRunAt).toBe(START + 60 * 60_000 + DAY);
    const second = manager(file, clock);
    expect(second.listRoutines().find(routine => routine.id === "routine-00000")!.nextRunAt).toBe(START + 60 * 60_000 + DAY);
    const run = second.listRuns().find(item => item.routineId === "routine-00000" && item.scheduledFor === START + 60 * 60_000);
    // it was running when the process stopped: recovered as failed, exactly once, not run again
    expect(run?.status).toBe("failed");
    clock.now = START + 61 * 60_000;
    const started: string[] = [];
    const third = manager(file, clock, started);
    await third.tick();
    expect(started).toHaveLength(0);
    expect(third.listRuns().filter(item => item.routineId === "routine-00000" && item.scheduledFor === START + 60 * 60_000)).toHaveLength(1);
  }, 60_000);
});
