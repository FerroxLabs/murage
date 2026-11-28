// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-routinebusy, a room-goal run's first start on the real path (owner: routines.ts dispatch; the task side is index.ts's
// createGoalTask option over store.createGroupTask; the gate side is the database's own refusal, unchanged). A booted server whose messages.db
// refuses every write (another connection holds the write lock). The goal's room task is added to the live room before its save, and the
// save's database step is refused: the run stays queued with its owner told it waits, and every refused attempt reuses the one room task it
// opened (each used to open another), then starts in it once the database is free.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { desktopApi, home } from "./testing/index-harness.ts";

const dbFile = () => join(home, ".murage", "messages.db");
let holder: DatabaseSync | undefined;
function closeGate(): void { holder = new DatabaseSync(dbFile()); holder.exec("PRAGMA busy_timeout = 5000"); holder.exec("BEGIN IMMEDIATE"); }
function openGate(): void { try { holder?.exec("ROLLBACK"); } finally { holder?.close(); holder = undefined; } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const runsOf = async (routineId: string) => ((await desktopApi("GET", "/api/routines")).body.runs as any[]).filter(r => r.routineId === routineId).sort((a, b) => a.createdAt - b.createdAt);
const roomTasks = async (groupId: string) => (((await desktopApi("GET", "/api/bots?messages=0")).body.groups as any[]).find(g => g.id === groupId)?.tasks ?? []) as Array<{ threadId: string }>;

it("a room-goal run whose room task could not be recorded waits for the database in one room task, and starts in it", async () => {
  const lead = (await desktopApi("POST", "/api/bots")).body.bot;
  const room = (await desktopApi("POST", "/api/groups", { name: "Goal busy room", memberIds: [lead.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
  const routine = (await desktopApi("POST", "/api/routines", { name: "Room goal busy", prompt: "Check the room goal.", target: "room-goal", groupId: room.id,
    botId: lead.id, runOn: "ember", schedule: { type: "once", at: Date.now() + 3_600_000 }, durationMinutes: 30 })).body.routine;
  const before = (await roomTasks(room.id)).length;
  closeGate();
  try {
    expect((await desktopApi("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await sleep(6_000);
    const run = (await runsOf(routine.id))[0];
    expect(run.status, `error: ${run.error}`).toBe("queued");
    expect(run.attention ?? "").toContain("Waiting for the database");
    expect((await roomTasks(room.id)).length).toBe(before + 1); // the refused attempts reuse one room task; each used to open another
  } finally { openGate(); }
  await expect.poll(async () => (await runsOf(routine.id))[0]?.status, { timeout: 90_000, interval: 500 }).not.toBe("queued");
  const run = (await runsOf(routine.id))[0];
  expect(["running", "completed"], `error: ${run.error}`).toContain(run.status); // it started, not failed in the reused task
  const tasks = await roomTasks(room.id);
  expect(tasks.length).toBe(before + 1); // one room task for the run, not one per refused attempt
  expect(tasks.some(task => task.threadId === run.threadId)).toBe(true); // and the run took it
}, 200_000);
