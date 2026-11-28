// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy, real path (owner: routines; gate side: wal-maintenance.ts assertWalWriteAdmission, unchanged): a booted server whose
// messages.db log is past the admission size (the production refusal, DatabaseBusyError wal-recovery). A routine run's marker and result
// are never dropped and never retried against the refusing gate on every tick: their owner sees that they wait, and each lands once
// when the gate opens.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopApi, fakeClaudeDump, home, stderr as serverStderr } from "./testing/index-harness.ts";

const dbFile = () => join(home, ".murage", "messages.db");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The database refuses every owner write: another connection holds the write lock (the same DatabaseBusyError class the log-admission
 * gate throws, isDatabaseBusy). Deterministic: no worker copy or checkpoint can lift it before the test does. */
let holder: DatabaseSync | undefined;
function closeGate(): void {
  holder = new DatabaseSync(dbFile());
  holder.exec("PRAGMA busy_timeout = 5000");
  holder.exec("BEGIN IMMEDIATE");
}
function openGate(): void { try { holder?.exec("ROLLBACK"); } finally { holder?.close(); holder = undefined; } }
const count = (text: string, needle: string) => text.split(needle).length - 1;
const runsOf = async (routineId: string) => ((await desktopApi("GET", "/api/routines")).body.runs as any[]).filter(r => r.routineId === routineId).sort((a, b) => a.createdAt - b.createdAt);
async function enginePid(): Promise<number> {
  let pid = 0;
  await expect.poll(() => { try { pid = JSON.parse(readFileSync(fakeClaudeDump, "utf8")).pid; } catch { pid = 0; } return pid; }, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);
  return pid;
}
const finishEngine = (pid: number) => writeFileSync(join(home, "finish-fake", String(pid)), "finish");

it("a refused run marker waits visibly with bounded writes and lands once when the database is free", async () => {
  const bot = (await desktopApi("POST", "/api/bots")).body.bot;
  const routine = (await desktopApi("POST", "/api/routines", { name: "Busy marker check", prompt: "Check the busy marker.", target: "bot", botId: bot.id, runOn: "ember", enabled: true,
    schedule: { type: "daily", time: "10:00", weekdays: [1, 2, 3, 4, 5] } })).body.routine;
  // run 1 with the gate open: it opens the routine's own conversation (later runs reuse it) and completes
  rmSync(fakeClaudeDump, { force: true });
  expect((await desktopApi("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
  finishEngine(await enginePid());
  await expect.poll(async () => (await runsOf(routine.id))[0]?.status, { timeout: 60_000, interval: 250 }).toBe("completed");
  await expect.poll(async () => (await runsOf(routine.id))[0]?.delivery?.state, { timeout: 30_000, interval: 250 }).toBe("sent");

  // ---- the marker: run 2 meets the refusing gate
  const markedAt = serverStderr.length;
  rmSync(fakeClaudeDump, { force: true });
  closeGate();
  try {
    expect((await desktopApi("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await sleep(8_000);
    const second = (await runsOf(routine.id))[1];
    // the owner is told it waits; the run is queued, not started and not failed
    expect(second).toMatchObject({ status: "queued", attention: expect.stringContaining("Waiting for the database") });
    // not an error stack on every retry: the refusal is one coalesced line a minute
    expect(count(serverStderr.slice(markedAt), "run marker failed")).toBe(0);
    expect(existsSync(fakeClaudeDump)).toBe(false);
  } finally { openGate(); }
  await expect.poll(async () => (await runsOf(routine.id))[1]?.status, { timeout: 90_000, interval: 500 }).toBe("running");
  const second = (await runsOf(routine.id))[1];
  expect(second.attention).toBeUndefined();
  const markers = () => {
    const db = new DatabaseSync(dbFile(), { readOnly: true });
    try { return count(JSON.stringify(db.prepare("SELECT * FROM messages WHERE thread_id = ?").all(second.threadId)), "Run now: Busy marker check"); } finally { db.close(); }
  };
  expect(markers()).toBe(2); // run 1 and run 2: each once

}, 240_000);
