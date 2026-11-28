// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy, the landing of an owed result after the database frees, on the real path (owner: routines; the wiring is
// index.ts setInterval -> retryOwedRoutineDeliveries -> owedDeliveries.retry, the pause in routine-owed.ts; the gate side is the
// database's own refusal, unchanged). The same booted scenario as routine-owed-http.test.ts (that file keeps the production clock and
// proves the write at the settle itself): another connection holds the write lock, a cloud run fails at once, its card is refused and
// stays owed with the note. The gate stays shut for some 12 passes of a short test clock (MURAGE_TEST_ROUTINE_OWED_MS, routine-owed.ts
// OWED_PASS_MS; the server never sits past its busy timeout), so the pause on the direct routes has grown to its 8-pass ceiling. Then
// the gate opens inside that pause: the real minute pass's probe writes the card at its next pass, not when the pause ends, marks it
// sent, and the note leaves with it; the pass never writes it a second time.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.hoisted(() => { process.env.MURAGE_TEST_ROUTINE_OWED_MS = "2000"; });
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
  // rows that carry the run's result id (a card row names its id in more than one column)
  try { return (db.prepare("SELECT * FROM messages").all() as unknown[]).filter(row => JSON.stringify(row).includes(routineResultId(runId))).length; } finally { db.close(); }
};

it("an owed result the database refused lands once at the next minute pass after the database frees, inside the pause, marked sent, the waiting note gone", async () => {
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
    // 23 s past the settle refusal: the waits were 1, 2, 4 and 8 passes (2 s each) with a refusal under 20 s, so the pause runs to 30 s or more
    await sleep(23_000);
    const run = (await runsOf(routine.id))[0];
    expect(run).toMatchObject({ status: "failed", delivery: { state: "pending" }, attention: expect.stringContaining("Waiting for the database") });
    expect(count(serverStderr.slice(markedAt), "waiting for the database")).toBeLessThanOrEqual(2); // a coalesced line, not one per attempt
    expect(cards(runId)).toBe(0);
  } finally { openGate(); }
  // the gate is open: the next pass (at most one test pass, 2 s, away) probes and writes the card, some 6 s or more before the pause ends
  await expect.poll(() => cards(runId), { timeout: 3_500, interval: 100 }).toBe(1);
  await expect.poll(async () => (await runsOf(routine.id))[0]?.delivery?.state, { timeout: 10_000, interval: 250 }).toBe("sent");
  expect((await runsOf(routine.id))[0].attention ?? "").not.toContain("Waiting for the database");
  await sleep(3_000);
  expect(cards(runId)).toBe(1);
}, 120_000);
