// SPDX-License-Identifier: AGPL-3.0-or-later
// T7 (STALLS-FINAL-DESIGN 3.4, database.ts invariant 5): a long writer declares itself and brackets itself in the log. The root-set VACUUM
// logs a start line before its worker starts and its end line after; the writer hold is in force in between and released after. The same
// for an optional index built off the main thread.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, holdWritersForIndexBuild, writersHeldForIndexBuild } = await import("../database.ts");
const { reclaimRootSetsWhenIdle, setReadTimeJudgeRetired } = await import("./root-set-reclaim.ts");
const { migrateMemorySchema } = await import("./schema.ts");
const { buildOptionalIndexOffThread, OPTIONAL_INDEXES, optionalIndexReady } = await import("./optional-index.ts");

const open = { ownerIdleMs: () => 60 * 60_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
let events: string[] = [];
const dirs: string[] = [], dbs: DatabaseSync[] = [];
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  events = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { events.push(`log ${String(args[0])} held=${writersHeldForIndexBuild()}`); });
});
afterEach(() => {
  vi.restoreAllMocks(); setReadTimeJudgeRetired(false); holdWritersForIndexBuild(false);
  for (const db of dbs.splice(0)) try { db.close(); } catch { /* closed */ }
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
const hold = (on: boolean) => { holdWritersForIndexBuild(on); events.push(`hold ${on}`); };
const at = (pattern: RegExp) => events.findIndex(event => pattern.test(event));

it("the VACUUM logs its start before the worker and its end after, with the writer hold in force only in between", async () => {
  // a certified file made without incremental vacuum, holding a small v6-shaped member table: the hand-back drops it, then rewrites the file
  const dir = mkdtempSync(join(tmpdir(), "reclaim-bracket-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL");
  migrateMemorySchema(db);
  db.prepare(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<2000) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id)
    SELECT 'rs:'||printf('%060d',i/700),'thread-'||printf('%029d',i%97),'message-'||printf('%028d',i) FROM c`).run();
  setReadTimeJudgeRetired(true);
  expect(await reclaimRootSetsWhenIdle(db, open, { freeDiskBytes: () => null, hold })).toBe("done");
  const start = at(/^log \[memory\] handing back space: rewriting the file \(\d+ MB live\) held=false$/);
  const end = at(/^log \[memory\] handing back space: rewrote the file in \d+ ms held=false$/);
  expect(start, events.join("\n")).toBeGreaterThan(-1);
  expect(at(/^hold true$/)).toBeGreaterThan(start);
  expect(at(/^hold false$/)).toBeGreaterThan(at(/^hold true$/));
  expect(end).toBeGreaterThan(at(/^hold false$/));
  expect(writersHeldForIndexBuild()).toBe(false);
}, 120_000);

it("an optional index built off the main thread brackets itself the same way", async () => {
  const dir = mkdtempSync(join(tmpdir(), "optidx-bracket-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  const index = OPTIONAL_INDEXES[0]!;
  let heldDuring = false;
  const watch = (on: boolean) => { hold(on); if (on) heldDuring = writersHeldForIndexBuild(); };
  expect(await buildOptionalIndexOffThread(db, index, { retries: 0, hold: watch })).toBe(true);
  expect(optionalIndexReady(db, index.name)).toBe(true);
  const start = at(new RegExp(`^log \\[memory\\] index build start name=${index.name} held=false$`));
  const end = at(new RegExp(`^log \\[memory\\] index build done name=${index.name} ms=\\d+ held=false$`));
  expect(start, events.join("\n")).toBeGreaterThan(-1);
  expect(at(/^hold true$/)).toBeGreaterThan(start);
  expect(heldDuring).toBe(true);
  expect(end).toBeGreaterThan(at(/^hold false$/));
  expect(writersHeldForIndexBuild()).toBe(false);
});
