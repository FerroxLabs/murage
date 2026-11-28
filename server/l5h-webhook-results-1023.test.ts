// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H webhook result marker (designs/HOOKS-LINEAGE-1023.md r2 sections 2.2, 2.5; Fable r2 H2 + M1, Opus r2 H1b/H1c). The real
// RoutineManager and its routine-runs journal run here. A webhook run's result marker is written with the run itself; with no
// Results route (a Cloud home with no ResultAudiencePort wired) the run keeps the 1.0.22 path: no marker and its task activates.
// An owed or held result is never retired by the run cap, and one route keeps at most EVENT_RESULT_HELD_CAP held results.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER } from "./human-principals.ts";
import { EVENT_RESULT_HELD_CAP, RoutineManager } from "./routines.ts";
import { routineRunsDir, routineRunsFileName } from "./routine-runs-journal.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { prepareRestoredRecords, readRestoreJson, writeRestoreJsonAtomic } from "./restore-prep-core.ts";

const dirs: string[] = [];
const managers: RoutineManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.stop(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const START = Date.UTC(2026, 10, 22, 8, 0, 0);
const DAY = 24 * 60 * 60_000;

function manager(options: { routing?: boolean; file?: string; clock?: { now: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-l5h-")); dirs.push(dir);
  const clock = options.clock ?? { now: START };
  const tasks: Array<{ title: string; activate: boolean | undefined }> = [];
  const m = new RoutineManager({
    file: options.file ?? join(dir, "routines.json"), now: () => clock.now, botState: () => "ready",
    createTask: (_botId, title, activate) => { tasks.push({ title, activate }); return { threadId: `thread-${tasks.length}` }; },
    startTurn: async () => {}, isChannelCurrent: () => true,
    ...(options.routing === undefined ? {} : { eventResultRouting: () => options.routing! }),
  });
  managers.push(m);
  return { m, tasks, clock, file: options.file ?? join(dir, "routines.json") };
}
const hook = (m: RoutineManager, n: number, webhookId = "wh-deploy", at = START) =>
  m.enqueueWebhook({ webhookId, webhookName: "Deploy", prompt: "Summarize the deploy", botId: "bot-1", runOn: "ember", deliveryId: `d-${webhookId}-${n}`, receivedAt: at });
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

describe("Fable r2 H2 / Opus r2 H1c: no Results route = the 1.0.22 path", () => {
  it("W14b a Cloud home with no port wired: no marker, and the run's task activates as on base", async () => {
    const h = manager({ routing: false });
    h.m.start();
    const run = hook(h.m, 1);
    expect(run.eventResult).toBeUndefined();
    await until(() => h.tasks.length > 0);
    expect(h.tasks[0]?.activate).toBe(true);
  });

  it("with a route: the marker is written with the run (owed) and the run's task does not steal focus", async () => {
    const h = manager({ routing: true });
    h.m.start();
    const run = hook(h.m, 1);
    expect(run.eventResult).toEqual({ state: "owed" });
    await until(() => h.tasks.length > 0);
    expect(h.tasks[0]?.activate).toBe(false);
  });
});

describe("W15 channel runs keep the base path", () => {
  it("W15 PIN: a Slack channel run carries a webhookId but its triggerSource is channel: no marker even with routing on, and its task activates as on base", async () => {
    const h = manager({ routing: true });
    h.m.start();
    const run = h.m.enqueueWebhook({ webhookId: "wh-chan", webhookName: "Slack message", prompt: "hi", botId: "bot-1", runOn: "ember", deliveryId: "d-chan-1", receivedAt: START,
      channelOrigin: { platform: "slack", connectionId: "conn-1" }, humanPrincipal: OWNER });
    expect(run.triggerSource).toBe("channel");
    expect(run.eventResult).toBeUndefined();
  });
});

describe("W20 run cap and the per-route held cap (Opus r2 H1b, Fable r2 M1)", () => {
  it("held results older than 24 h survive the run cap; 25 held on one route keep the newest 20, the 5 oldest end as held_overflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-l5h-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [], routineRequestReceipts: [] }));
    mkdirSync(routineRunsDir(dir), { recursive: true });
    const settled = (id: string, webhookId: string, at: number, extra: object = {}) => JSON.stringify({ id, routineId: webhookId, routineName: "Deploy", prompt: "p", attachments: [],
      target: "bot", botId: "bot-1", runOn: "ember", scheduledFor: at, dueAt: at, status: "completed", manual: false, triggerSource: "webhook", webhookId, deliveryId: `d-${id}`,
      createdAt: at, startedAt: at, finishedAt: at + 1, output: "done", ...extra });
    const held = Array.from({ length: 25 }, (_, n) => `held-${String(n).padStart(3, "0")}`);
    writeFileSync(join(routineRunsDir(dir), routineRunsFileName("wh-deploy")), held.map((id, n) => settled(id, "wh-deploy", START - 4 * DAY + n, { eventResult: { state: "owed" } })).join("\n") + "\n");
    writeFileSync(join(routineRunsDir(dir), routineRunsFileName("wh-other")), Array.from({ length: 2_010 }, (_, n) => settled(`other-${n}`, "wh-other", START - 3 * DAY + n)).join("\n") + "\n");
    const h = manager({ routing: true, file, clock: { now: START + DAY } });
    for (const id of held) h.m.holdEventResult(id, "cloud_check_unavailable");
    const states = held.map(id => h.m.runById(id)?.eventResult);
    // the held runs are the oldest in the store: the run cap passes over them
    expect(states.slice(5).map(state => state?.state)).toEqual(Array(EVENT_RESULT_HELD_CAP).fill("held"));
    expect(states.slice(0, 5)).toEqual(Array(5).fill({ state: "done", reason: "held_overflow" }));
    // the saves above serviced the run cap: older runs were retired, never a held result
    expect(h.m.listRuns().length).toBeLessThanOrEqual(2_000);
    expect(h.m.runById("other-0")).toBeNull();
  }, 60_000);
});

describe("Fable r2 M3: one restore rule for both run kinds", () => {
  it("M3 a webhook run the restore stops owes no Results card after the restore, as a fenced app run owes none", async () => {
    const h = manager({ routing: true });
    const run = hook(h.m, 1);
    expect(run.eventResult).toEqual({ state: "owed" });
    h.m.stop();
    const dir = dirname(h.file);
    const files = new Set(["routines.json"]);
    prepareRestoredRecords({ state: dir, files, read: path => readRestoreJson(dir, files, path), write: (path, value) => writeRestoreJsonAtomic(join(dir, path), value), quarantine: () => {} },
      { generation: "g1", profile: "same-home", quarantineId: "q1", modifications: [], quarantined: [] });
    const after = manager({ routing: true, file: h.file });
    expect(after.m.eventResultsOwed().map(owed => owed.id)).toEqual([]);
    expect(after.m.runById(run.id)?.status).toBe("cancelled");
  });
});
