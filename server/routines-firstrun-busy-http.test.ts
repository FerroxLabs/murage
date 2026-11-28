// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy, the first run of a new routine on the real path (owner: routines.ts dispatch; the task side is index.ts's createTask
// option over store.createTask; the gate side is the database's own refusal, unchanged). A booted server whose messages.db refuses every write
// (another connection holds the write lock: DatabaseBusyError, isDatabaseBusy). The first run opens the routine's conversation: the roster write
// commits and its later database step is refused (RosterPostCommitError wrapping the busy error). That is contention, never a failed run: the
// run stays queued with its owner told it waits, and starts once the database is free, in the conversation the refused attempt opened.
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopApi, fakeClaudeDump, home } from "./testing/index-harness.ts";

const dbFile = () => join(home, ".murage", "messages.db");
let holder: DatabaseSync | undefined;
function closeGate(): void { holder = new DatabaseSync(dbFile()); holder.exec("PRAGMA busy_timeout = 5000"); holder.exec("BEGIN IMMEDIATE"); }
function openGate(): void { try { holder?.exec("ROLLBACK"); } finally { holder?.close(); holder = undefined; } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const runsOf = async (routineId: string) => ((await desktopApi("GET", "/api/routines")).body.runs as any[]).filter(r => r.routineId === routineId).sort((a, b) => a.createdAt - b.createdAt);
const tasksOf = async (botId: string) => ((await desktopApi("GET", "/api/bots")).body.bots as any[]).find(b => b.id === botId)?.tasks?.length ?? 0;

it("a first run whose conversation could not be fully recorded waits for the database instead of failing, and starts in the one conversation it opened", async () => {
  const bot = (await desktopApi("POST", "/api/bots")).body.bot;
  const routine = (await desktopApi("POST", "/api/routines", { name: "First run busy", prompt: "Check the first run.", target: "bot", botId: bot.id, runOn: "ember", enabled: true,
    schedule: { type: "daily", time: "10:00", weekdays: [1, 2, 3, 4, 5] } })).body.routine;
  const tasksBefore = await tasksOf(bot.id);
  rmSync(fakeClaudeDump, { force: true });
  closeGate();
  try {
    expect((await desktopApi("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await sleep(6_000);
    const run = (await runsOf(routine.id))[0];
    expect(run.status, `error: ${run.error}`).toBe("queued");
    expect(run.error).toBeUndefined();
    expect(run.attention ?? "").toContain("Waiting for the database");
    expect(await tasksOf(bot.id)).toBe(tasksBefore + 1); // the refused attempts reuse one conversation; each used to open another
  } finally { openGate(); }
  await expect.poll(async () => (await runsOf(routine.id))[0]?.status, { timeout: 90_000, interval: 500 }).toBe("running");
  expect(await tasksOf(bot.id)).toBe(tasksBefore + 1); // one conversation for the run, not one per refused attempt
}, 200_000);
