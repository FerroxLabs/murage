// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy, the result side on the real path (owner: routines; the wiring is index.ts owedDeliveries / finishRoutineDelivery /
// retryOwedRoutineDeliveries; the gate side is the database's own refusal, unchanged). A booted server whose messages.db refuses every
// write (another connection holds the write lock: DatabaseBusyError, isDatabaseBusy). A queued run is cancelled over HTTP, so it settles
// with its result card still owed: the card write meets the refusal. The run stays owed, its owner is told it waits, the refusal is one
// coalesced line (the landing once the database is free: routine-owed-landing-http.test.ts).
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopApi, home, stderr as serverStderr } from "./testing/index-harness.ts";
import { routineResultId } from "./routine-delivery.ts";

const dbFile = () => join(home, ".murage", "messages.db");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let holder: DatabaseSync | undefined;
function closeGate(): void { holder = new DatabaseSync(dbFile()); holder.exec("PRAGMA busy_timeout = 5000"); holder.exec("BEGIN IMMEDIATE"); }
function openGate(): void { try { holder?.exec("ROLLBACK"); } finally { holder?.close(); holder = undefined; } }
const count = (text: string, needle: string) => text.split(needle).length - 1;
const runsOf = async (routineId: string) => ((await desktopApi("GET", "/api/routines")).body.runs as any[]).filter(r => r.routineId === routineId).sort((a, b) => a.createdAt - b.createdAt);
const cards = (runId: string) => {
  const db = new DatabaseSync(dbFile(), { readOnly: true });
  try { return count(JSON.stringify(db.prepare("SELECT * FROM messages").all()), routineResultId(runId)); } finally { db.close(); }
};

it("a settled run whose result write the database refuses stays owed: its owner is told it waits and the refusal is one coalesced line", async () => {
  const bot = (await desktopApi("POST", "/api/bots")).body.bot;
  // a routine that fails at once without touching the database (work on the Cloud VM cannot ask for approval yet): its failed result card is owed
  const routine = (await desktopApi("POST", "/api/routines", { name: "Busy result check", prompt: "Check the busy result.", target: "bot", botId: bot.id, runOn: "cloud", enabled: true,
    schedule: { type: "daily", time: "10:00", weekdays: [1, 2, 3, 4, 5] } })).body.routine;
  const markedAt = serverStderr.length;
  closeGate();
  let runId = "";
  try {
    expect((await desktopApi("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await expect.poll(async () => (await runsOf(routine.id))[0]?.status, { timeout: 20_000, interval: 250 }).toBe("failed");
    runId = (await runsOf(routine.id))[0].id;
    await sleep(3_000);
    const run = (await runsOf(routine.id))[0];
    expect(run).toMatchObject({ status: "failed", delivery: { state: "pending" }, attention: expect.stringContaining("Waiting for the database") });
    expect(count(serverStderr.slice(markedAt), "waiting for the database")).toBeLessThanOrEqual(2); // a coalesced line, not one per attempt
    expect(cards(runId)).toBe(0);
  } finally { openGate(); }
  // the card lands from the minute pass once the pause ends; that wait outlives a short suite (a server held past its busy timeout for
  // two minutes shuts down unclean on the base too), so the landing is proved at the unit level (routine-owed.test.ts, the real gate)
}, 120_000);
