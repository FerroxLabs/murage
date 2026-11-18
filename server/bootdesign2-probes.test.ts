// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot-tolerance probes. R3-R6 are the hazard witnesses that ride with the boot build (this branch): each asserts what a held-and-retried
// boot write needs. G8 and G-RO are the controls (skip + restart loses nothing; engine-level query_only).
import { mkdirSync, readFileSync, readdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it, vi } from "vitest";
import { WAL_ADMISSION_BYTES } from "./wal-maintenance.ts";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction, withBusyBudget } from "./database.ts";
import { Store } from "./store.ts";
import { reconcileTeamIdentities } from "./team-lifecycle.ts";
import { holdVenuePost, moveVenuePost, recoverVenuePosts } from "./venue-post-held.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));
const NOTE = "Murage restarted before this goal finished.";
const seedGoal = (store: Store, threadId: string, runId: string) => store.appendMessage(threadId, {
  role: "bot", kind: "goal.run", text: "Goal in progress: coordinating.",
  goalRun: { runId, goal: "Ship the notes", status: "working", coordinatorBotId: "lead-1", coordinatorName: "Lead", turnCount: 1, maxTurns: 13, startedAt: 1 },
});
// The real admission gate (wal-maintenance.ts:59) refuses with DatabaseBusyError("wal-recovery") when the retained log is at the ceiling
// and no worker has copied it: a sparse extension of the live -wal is that state with no mock (SQLite ignores the zero tail).
const refuseAtGate = () => {
  const file = (database() as unknown as { location(): string | null }).location()
    ?? join(DATA_DIR, readdirSync(DATA_DIR).find((name) => name.endsWith(".db"))!);
  database().exec("CREATE TABLE IF NOT EXISTS probe_touch(v); INSERT INTO probe_touch VALUES (1)");
  truncateSync(file + "-wal", WAL_ADMISSION_BYTES);
};
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it("R6 floor provenance: a floor refusal inside withBusyBudget keeps op 'wal-recovery'", () => {
  fresh(); refuseAtGate();
  let caught: { op?: string } | undefined;
  try { withBusyBudget(1000, "boot-mark", (db) => db.exec("SELECT 1")); } catch (error) { caught = error as { op?: string }; }
  expect(caught?.op).toBe("wal-recovery");
});

it("R3 venue post: a row moved to posted while its card settle is refused is still found by the next recovery", () => {
  const store = fresh(); const db = database();
  holdVenuePost(db, { id: "vp-a", botId: "b1", threadId: "t-1to1", origin: "desktop", requestMessageId: "m1", requestHash: "h", venueId: "g1",
    targetThreadId: "t-room", text: "Hello room", stableId: "vp-a", lineage: "[]" });
  moveVenuePost(db, "vp-a", "held", "posting");
  refuseAtGate();
  expect(() => transaction((inner) => inner.exec("SELECT 1"))).toThrow(/busy|wal-recovery/i);
  const moved = recoverVenuePosts(db, () => true);           // raw UPDATE: not behind the admission gate
  expect(moved.map((row) => row.state)).toEqual(["posted"]);
  expect(() => store.appendMessage("t-1to1", { role: "bot", kind: "activity", text: "Posted" })).toThrow(); // the settle is refused
  expect(recoverVenuePosts(db, () => true).map((row) => row.id)).toEqual(["vp-a"]); // gate state irrelevant: raw read + raw UPDATE
});

it("R4 team identities: a refused save, then a retry, leaves the reconciled roster on disk", () => {
  const store = fresh(); const bot = store.createBot();
  const room = store.createGroup("Desk", [bot.id]);
  room.partitionedFor = { [bot.id]: { kind: "isolated" } };   // the live record (patchGroup does not take partition markers), as execution-audience.test.ts does
  const patch = vi.spyOn(store, "patchBot").mockImplementationOnce(() => { throw Object.assign(new Error("database or disk is full"), { errcode: 13 }); });
  expect(() => reconcileTeamIdentities(store)).toThrow(/disk is full/);
  patch.mockRestore();
  reconcileTeamIdentities(store);                            // the held retry
  closeDatabase();
  const onDisk = (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<{ id: string; sharedWith?: { teams?: unknown[] } }>)
    .find((row) => row.id === bot.id);
  expect(store.bot(bot.id)?.partitionedAt).toBeDefined();   // memory says reconciled
  expect((onDisk as { partitionedAt?: number } | undefined)?.partitionedAt).toBeDefined();
});

it("R5 group goals: a deferred reconcile replayed after serving starts leaves a goal started in this run working", () => {
  const store = fresh(); const bot = store.createBot(); const room = store.createGroup("Launch", [bot.id]);
  seedGoal(store, room.threadId, "orphan-before-boot");
  const live = seedGoal(store, room.threadId, "started-after-listen");
  store.closeBootRecoveries();                               // listen (MAIN 2026-11-17 Q1 (a): the production listen callback makes this call; W10 witnesses it)
  store.reconcileInterruptedGroupGoals(undefined, NOTE, 99); // the held entry drains late
  expect(store.messagesFor(room.threadId).find((message) => message.id === live.id)?.goalRun?.status).toBe("working");
});

it("G8 skip + restart: boots that skip recovery (quit, refused restart) lose nothing; the next normal boot settles", () => {
  const first = fresh(); const bot = first.createBot(); const room = first.createGroup("Launch", [bot.id]);
  const card = seedGoal(first, room.threadId, "orphan");
  holdVenuePost(database(), { id: "vp-b", botId: bot.id, threadId: bot.threadId, origin: "desktop", requestMessageId: "m2", requestHash: "h", venueId: room.id,
    targetThreadId: room.threadId, text: "Hi", stableId: "vp-b", lineage: "[]" });
  moveVenuePost(database(), "vp-b", "held", "posting");
  closeDatabase();                                            // quit while refused: no recovery ran
  fresh(); closeDatabase();                                   // restart under continued refusal: recovery skipped again, quit
  const normal = fresh();
  expect(normal.reconcileInterruptedGroupGoals(undefined, NOTE, 7)).toBe(1);
  expect(normal.messagesFor(room.threadId).find((message) => message.id === card.id)?.goalRun?.status).toBe("failed");
  expect(recoverVenuePosts(database(), () => false).map((row) => [row.id, row.state])).toEqual([["vp-b", "held"]]);
});

it("G-RO query_only refuses a raw UPDATE at the engine and still lets a checkpoint run", () => {
  const dir = join(DATA_DIR, "ro"); mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "x.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v); INSERT INTO t VALUES (1)");
  db.exec("PRAGMA query_only=ON");
  let code: unknown;
  try { db.prepare("UPDATE t SET v=2").run(); } catch (error) { code = (error as { errcode?: number }).errcode; }
  expect(code).toBe(8);                                       // SQLITE_READONLY
  expect(() => db.exec("PRAGMA wal_checkpoint(TRUNCATE)")).not.toThrow();
  expect((db.prepare("SELECT v FROM t").get() as { v: number }).v).toBe(1);
  db.close();
});
