// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot-tolerance controls: G8 (boots that skip recovery lose nothing) and G-RO (engine-level query_only). The R3-R6 hazard witnesses
// ride with the boot build (fix/1019-boot-tolerance), not here.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { holdVenuePost, moveVenuePost, recoverVenuePosts } from "./venue-post-held.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));
const NOTE = "Murage restarted before this goal finished.";
const seedGoal = (store: Store, threadId: string, runId: string) => store.appendMessage(threadId, {
  role: "bot", kind: "goal.run", text: "Goal in progress: coordinating.",
  goalRun: { runId, goal: "Ship the notes", status: "working", coordinatorBotId: "lead-1", coordinatorName: "Lead", turnCount: 1, maxTurns: 13, startedAt: 1 },
});
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

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
