// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy (owner: routines; the gate side is wal-maintenance.ts assertWalWriteAdmission, unchanged): a foreground write the
// database refuses never drops a routine run's marker or result. The gate here is the REAL assertWalWriteAdmission on a retained log past the
// admission size (a sparse file), not a stub that throws.
import { mkdtempSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WAL_ADMISSION_BYTES, assertWalWriteAdmission } from "./wal-maintenance.ts";
import { RosterPostCommitError } from "./store.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import { resetObserveWindows, setObserveSink } from "./observe.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
let lines: string[] = [];
beforeEach(() => { lines = []; resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => { setObserveSink(); vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** A retained log past the admission size with no worker copy: the production refusal (DatabaseBusyError wal-recovery). */
function gate() {
  const dir = mkdtempSync(join(tmpdir(), "murage-busy-")); dirs.push(dir);
  const file = join(dir, "messages.db");
  writeFileSync(file, ""); writeFileSync(`${file}-wal`, "");
  truncateSync(`${file}-wal`, WAL_ADMISSION_BYTES + 4096);
  return { dir, file, calls: 0, check() { this.calls++; assertWalWriteAdmission(file); }, open() { truncateSync(`${file}-wal`, 0); } };
}

function harness(g: ReturnType<typeof gate>) {
  let now = Date.UTC(2026, 10, 27, 9);
  const dir = mkdtempSync(join(tmpdir(), "murage-busy-r-")); dirs.push(dir);
  const started: string[] = []; const markers: string[] = []; const emitted: unknown[] = [];
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"), now: () => now, emit: (payload) => emitted.push(payload), botState: () => "ready", goalState: () => "ready",
    createTask: () => ({ threadId: `thread-${started.length + markers.length + 1}` }),
    createGoalTask: () => ({ threadId: "goal" }),
    startTurn: async (botId) => { started.push(botId); },
    startGoal: async () => {},
    taskExists: () => true,
    onRunDispatch: (run) => { g.check(); markers.push(run.id); },
  };
  const manager = new RoutineManager(options);
  const due = (botId: string) => { const r = manager.create({ botId, name: `Due ${botId}`, prompt: `Work ${botId}`, schedule: { type: "once", at: now + 60_000 } }); now += 120_000; return r; };
  return { manager, options, started, markers, emitted, due, advance: (ms: number) => { now += ms; },
    run: (botId: string) => manager.listRuns().find((r: RoutineRun) => r.botId === botId)! };
}

it("1: a refused run marker keeps the run queued and says so; no turn starts without it; one write per delay, not per run per tick", async () => {
  const g = gate(); const h = harness(g);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const bot of ["a", "b", "c"]) h.due(bot);
  await flush(); await h.manager.tick(); await flush();
  const afterFirst = g.calls;
  // the marker was refused: no engine turn started without its divider, and the run waits (owner-visible)
  expect(h.started).toEqual([]);
  const refused = h.manager.listRuns().filter(r => String(r.attention ?? "").includes("Waiting for the database"));
  expect(refused).toHaveLength(1);
  expect(refused[0]!.status).toBe("queued");
  // and the app is told (the run's update carrying the waiting note went out)
  expect(JSON.stringify(h.emitted)).toContain("Waiting for the database");
  expect(afterFirst).toBe(1); // the pass stopped at the first refusal; b and c did not meet the gate
  // ticks inside the delay do not meet the gate again
  for (let i = 0; i < 5; i++) { h.advance(100); await h.manager.tick(); await flush(); }
  expect(g.calls).toBe(afterFirst);
  expect(errors.mock.calls.filter(c => String(c[0]).includes("run marker failed"))).toEqual([]);
  expect(lines.filter(l => l.includes("run marker waiting for the database")).length).toBe(1);
  // the gate opens: after the delay every run starts, each with its marker exactly once, and the note is gone
  g.open(); h.advance(120_000);
  await h.manager.tick(); await flush(); await h.manager.tick(); await flush(); await h.manager.tick(); await flush();
  expect(h.markers.sort()).toEqual(h.manager.listRuns().map(r => r.id).sort());
  expect(h.started.sort()).toEqual(["a", "b", "c"]);
  expect(h.manager.listRuns().filter(r => r.attention !== undefined)).toEqual([]);
  expect(h.manager.listRuns().every(r => r.status === "running")).toBe(true);
});

it("2: the waiting note of an owed result leaves in the same save that marks it sent, so a crash or restart never leaves it on a delivered run", async () => {
  const g = gate(); g.open(); const h = harness(g);
  h.options.startTurn = async () => { throw new Error("engine refused"); };
  h.due("a");
  await flush(); await h.manager.tick(); await flush();
  const run = h.manager.listRuns().find(r => r.botId === "a")!;
  expect(run.status).toBe("failed");
  h.manager.recordRunDelivery(run.id, "chat-1");
  h.manager.noteResultWaiting(run.id);
  expect(h.manager.runById(run.id)?.attention).toContain("Waiting for the database");
  h.manager.markRunDelivered(run.id);
  // a process that starts from the saved file sees it sent and without the note
  const restarted = new RoutineManager({ ...h.options });
  expect(restarted.runById(run.id)).toMatchObject({ delivery: { state: "sent" } });
  expect(restarted.runById(run.id)?.attention).toBeUndefined();
});

it("3: a first run whose conversation was committed but its later database step refused (RosterPostCommitError over the busy error) stays queued, says so, and starts when the gate opens", async () => {
  const g = gate(); const h = harness(g);
  h.options.createTask = () => { try { g.check(); } catch (error) { throw new RosterPostCommitError(error, []); } return { threadId: "thread-first" }; };
  h.due("a");
  await flush(); await h.manager.tick(); await flush();
  const refused = h.run("a");
  expect(refused.status).toBe("queued");
  expect(refused.error).toBeUndefined();
  expect(refused.attention ?? "").toContain("Waiting for the database");
  expect(h.started).toEqual([]);
  // ticks inside the delay do not meet the gate again
  const calls = g.calls;
  for (let i = 0; i < 5; i++) { h.advance(100); await h.manager.tick(); await flush(); }
  expect(g.calls).toBe(calls);
  g.open(); h.advance(120_000);
  for (let i = 0; i < 3; i++) { await h.manager.tick(); await flush(); }
  expect(h.started).toEqual(["a"]);
  expect(h.run("a").status).toBe("running");
  expect(h.run("a").attention).toBeUndefined();
});

it("4: the waiting note of an owed result is never written to disk, so a rollback to v1.0.20 (which sends the result without taking it off) cannot leave it on a sent result", async () => {
  const g = gate(); g.open(); const h = harness(g);
  h.options.startTurn = async () => { throw new Error("engine refused"); };
  h.due("a");
  await flush(); await h.manager.tick(); await flush();
  const run = h.run("a");
  h.manager.recordRunDelivery(run.id, "chat-1");
  h.manager.noteResultWaiting(run.id);
  expect(h.manager.runById(run.id)?.attention).toContain("Waiting for the database"); // the owner sees it now
  const dir = dirname(h.options.file!);
  const onDisk = () => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => readFileSync(join(entry.parentPath, entry.name), "utf8")).join("\n");
  expect(onDisk()).not.toContain("Waiting for the database");
  // the older version reads that file, sends the result and marks it sent in its own way (state only)
  const older = new RoutineManager({ ...h.options });
  expect(older.runById(run.id)).toMatchObject({ delivery: { state: "pending" } });
  expect(older.runById(run.id)?.attention).toBeUndefined();
});
