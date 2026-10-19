// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Filmed on 1.0.1: a past routine run (the "Rehearsal") could not be deleted
// from the Routines calendar. Deleting one past run removes only that run's
// record, keeps the routine and every other run, holds across a restart, and
// leaves a run that is still going to Cancel.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager } from "./routines.ts";
import { routineRunsDir, routineRunsFileName } from "./routine-runs-journal.ts";
import { frameChangesInbox } from "./inbox-version.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-rundelete-")); dirs.push(dir); return dir; };

const START = new Date(2026, 9, 12, 8, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

function manager(file: string, emitted: Array<Record<string, unknown>> = []) {
  return new RoutineManager({
    file, now: () => START, botState: () => "ready",
    createTask: () => ({ threadId: "thread-1" }),
    startTurn: async () => {},
    emit: (payload) => { emitted.push(payload); },
  });
}

function seeded() {
  const dir = tempDir(), file = join(dir, "routines.json");
  const template = manager(join(tempDir(), "routines.json"));
  const made = template.create({ name: "Morning briefing", prompt: "Read mail", botId: "bot-1", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: START + DAY } });
  const routine = JSON.parse(JSON.stringify(made));
  writeFileSync(file, JSON.stringify({ version: 1, routines: [routine], runs: [], routineRequestReceipts: [] }, null, 2));
  const run = (id: string, status: string, offset: number) => ({ id, routineId: routine.id, routineName: routine.name, prompt: "Read mail", durationMinutes: 30, attachments: [], target: "bot", botId: "bot-1", runOn: "ember",
    scheduledFor: START - DAY + offset, status, manual: true, triggerSource: "manual", threadId: "thread-1", createdAt: START - DAY + offset,
    ...(status === "queued" ? {} : { startedAt: START - DAY + offset, finishedAt: START - DAY + offset + 1, output: "done" }) });
  mkdirSync(routineRunsDir(dir), { recursive: true });
  writeFileSync(join(routineRunsDir(dir), routineRunsFileName(routine.id)), [run("run-rehearsal", "completed", 0), run("run-later", "failed", 10), run("run-queued", "queued", 20)].map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { file, routineId: routine.id as string };
}

describe("deleting a past routine run", () => {
  it("removes only that run, keeps the routine, and stays gone after a restart", () => {
    const { file, routineId } = seeded();
    const emitted: Array<Record<string, unknown>> = [];
    const m = manager(file, emitted);
    expect(m.listRuns().map((run) => run.id).sort()).toEqual(["run-later", "run-queued", "run-rehearsal"]);

    expect(m.deleteRun("run-rehearsal")).toMatchObject({ id: "run-rehearsal", routineId });
    expect(m.listRuns().map((run) => run.id).sort()).toEqual(["run-later", "run-queued"]);
    expect(m.listRoutines().map((routine) => routine.id)).toEqual([routineId]);
    expect(emitted).toContainEqual({ kind: "routine.run.deleted", runId: "run-rehearsal", routineId });
    // the badge and the roll-ups hear of it, as they do for a run change
    expect(frameChangesInbox({ kind: "routine.run.deleted" })).toBe(true);

    const reopened = manager(file);
    expect(reopened.listRuns().map((run) => run.id).sort()).toEqual(["run-later", "run-queued"]);
    expect(reopened.listRoutines().map((routine) => routine.id)).toEqual([routineId]);
  });

  it("refuses a run that is still going, and an unknown run", () => {
    const { file } = seeded();
    const m = manager(file);
    expect(() => m.deleteRun("run-queued")).toThrow(/Cancel it first/);
    try { m.deleteRun("run-queued"); } catch (error) { expect((error as { status?: number }).status).toBe(409); }
    expect(m.deleteRun("no-such-run")).toBeNull();
    expect(m.listRuns()).toHaveLength(3);
  });
});
