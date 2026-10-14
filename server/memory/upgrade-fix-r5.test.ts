// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fix round for the fourth upgrade-ui review (lanes/upgui-review/r4/REPORT.md): one test per finding that lives in the memory layer.
// P1 (publication outbox) and P3 (Keep gate) are in procedure-landing.test.ts; the client findings are in src/state/open-cards.test.ts.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, afterEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { legacyFile } from "./testing/legacy-file-model.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
beforeEach(() => thawRootSetWritesForTest(true));
afterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { advanceMemoryShapeMarks, validateMemorySchema } from "./schema.ts";
import { COLLECT_EXAMINE_SETS, collectRootSetsSlice, compactRootSetsStep, maintainLineageStorage } from "./root-set-compaction.ts";
import { teamLessonsRenderSql } from "./lessons.ts";
import { LAZY_ROOT_MIN } from "./root-set-handles.ts";
import { ROOT_SET_CEILING } from "./replay-lineage.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
const scope = () => database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('s-ws','workspace','ws','[]',0)").run();

// ── 3. idle shape refresh: references off, and a capped tail behind a cursor ───────────────────────────────────────────────────────
it("P2-3: the idle shape refresh reads a capped tail past each mark and none of the whole-table reference proofs", () => {
  scope(); closeDatabase();
  const db = database();
  const mark = () => Number((JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent)) as { marks: Record<string, number> }).marks["memory_scopes.audience"]);
  const start = mark();
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO memory_scopes VALUES(?, 'bot', ?, '[]', 0)").run(`s-extra-${i}`, `extra-${i}`);
  const newest = Number(db.prepare("SELECT max(rowid) AS n FROM memory_scopes").get()!.n);
  // a dangling reference only the reference sweep can see
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO memory_evidence VALUES('ghost',1,'ghost',1,0,0)").run();
  expect(advanceMemoryShapeMarks(db, 4)).toBe(true);
  expect(mark()).toBe(start + 4); // the marks are the cursor: four rowids, not the tail
  expect(advanceMemoryShapeMarks(db, 4)).toBe(true);
  expect(mark()).toBe(start + 8);
  expect(advanceMemoryShapeMarks(db, 4)).toBe(true);
  expect(mark()).toBe(newest);
  expect(() => validateMemorySchema(db)).toThrow(/INVALID_MEMORY_REFERENCE/); // the full check still sees it: the idle one never ran it
});

// ── 3. dead-card recovery: point reads by message id ───────────────────────────────────────────────────────────────────────────────
it("P2-3: the dead-card sweep reads each card by its message id and never loads a thread", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
  const start = source.indexOf("async function sweepCardsOfDeadRun");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  expect(body).toContain("readMessage(threadId, message.id)");
  expect(body).not.toMatch(/messagesFor\(/);
});

// ── 3. root collection: a persisted cursor over examined sets, and large sets cut away in chunks ─────────────────────────────────
const addSets = (db: ReturnType<typeof database>, count: number, referenced: boolean, prefix: string) => {
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1) INSERT INTO memory_root_sets(set_id,size) SELECT ?2||printf('%07d',i),1 FROM k`).run(count, prefix);
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?2||printf('%07d',i),'t','m'||?2||i FROM k`).run(count, prefix);
  if (referenced) db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1) INSERT INTO memory_output_roots(thread_id,message_id,set_id) SELECT 't','o'||?2||i,?2||printf('%07d',i) FROM k`).run(count, prefix);
};

it("P2-3: collecting nothing examines a bounded slice per call and resumes from the cursor; unreferenced sets behind a long referenced run are still found", () => {
  scope();
  const db = database();
  addSets(db, 1_300, true, "a"); addSets(db, 5, false, "z");
  const first = collectRootSetsSlice(db);
  expect(first).toMatchObject({ removed: 0, examined: COLLECT_EXAMINE_SETS, wrapped: false });
  const second = collectRootSetsSlice(db);
  expect(second.examined).toBe(COLLECT_EXAMINE_SETS);
  let removed = 0, slices = 2, wrapped = false;
  while (!wrapped && slices++ < 20) { const slice = collectRootSetsSlice(db); expect(slice.examined).toBeLessThanOrEqual(COLLECT_EXAMINE_SETS); removed += slice.removed; wrapped = slice.wrapped; }
  expect(removed).toBe(5);
  expect(wrapped).toBe(true);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()!.n)).toBe(1_300);
});

it("P2-3: a large unreferenced set is cut away in bounded chunks, the set row first, and the cursor finishes draining it", () => {
  scope();
  const db = database();
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES('big',9000)").run();
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<9000) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'big','t','m'||printf('%05d',i) FROM k`).run();
  const members = () => Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members WHERE set_id='big'").get()!.n);
  const one = collectRootSetsSlice(db, { rows: 4_000 });
  expect(one).toMatchObject({ removed: 1, draining: true });
  expect(members()).toBe(5_000); // one chunk, not the set
  expect(db.prepare("SELECT 1 FROM memory_root_sets WHERE set_id='big'").get()).toBeUndefined();
  expect(collectRootSetsSlice(db, { rows: 4_000 })).toMatchObject({ draining: true });
  expect(members()).toBe(1_000);
  expect(collectRootSetsSlice(db, { rows: 4_000 }).draining).toBe(false);
  expect(members()).toBe(0);
});

it("P2-3: the idle storage pass does not checkpoint the log on the serving thread", async () => {
  const source = readFileSync(join(import.meta.dirname, "root-set-compaction.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function maintainLineageStorage"));
  const code = body.split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
  expect(code).not.toMatch(/truncateWal\(|wal_checkpoint/);
  scope();
  const db = database();
  await expect(maintainLineageStorage({ database: () => db, idle: () => true, pauseMs: 0 })).resolves.toBeTruthy();
});

// ── 4. per-turn: the team-lesson read follows the active lessons, never the retired history ───────────────────────────────────────
it("P2-4: the team-lesson read searches the existing (bot_id, state) index and scans no part of the lesson table, and still finds what names the bot", () => {
  const db = database();
  const insert = db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,recipients,kind,text,origin,state,created_at) VALUES(?,1,?,?,?,'note',?,'typed',?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 3_000; i++) insert.run(`old-${i}`, `author${i % 3}`, "team", '["reader"]', `retired ${i}`, "retired", i);
  insert.run("live-1", "author1", "team", '["reader","other"]', "Use the shared glossary.", "active", 5_000);
  insert.run("live-2", "author2", "team", '["other"]', "Not for the reader.", "active", 5_001);
  db.exec("COMMIT");
  const sql = teamLessonsRenderSql("");
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("reader", "reader", 8).map(row => String(row.detail)).join(" | ");
  expect(plan, plan).not.toMatch(/SCAN (memory_lessons|l)\b/);
  expect(plan, plan).toMatch(/SEARCH memory_lessons USING (COVERING )?INDEX memory_lessons_bot_state \(bot_id=\? AND state=\?\)/);
  expect(db.prepare(sql).all("reader", "reader", 8).map(row => String(row.id))).toEqual(["live-1"]);
});

// ── 4. replay: the lazy threshold sits below what the replay admits, and a lazy set's rows are counted by its first full walk ──────
it("P2-4: a set the replay admits can be a lazy handle (the threshold is below the ceiling)", () => {
  expect(LAZY_ROOT_MIN).toBeLessThan(ROOT_SET_CEILING);
});

// ── 5. worklist enumeration: a chunk's inserts, count and cursor commit together ──────────────────────────────────────────────────
it("P2-5: an interruption between a chunk's inserts and its cursor leaves no uncounted worklist rows, and the total comes out exact", () => {
  scope();
  const db = legacyFile(database()); // the conversion is retired on v10; this is the 1.0.1-shaped file it still runs on
  addSets(db, 100, true, "e");
  db.exec("DELETE FROM memory_root_set_compaction; INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,0,0,'',1)");
  // the cursor write of the first chunk fails after its inserts
  db.exec("CREATE TEMP TRIGGER zz_boom BEFORE UPDATE ON memory_root_set_compaction BEGIN SELECT RAISE(ABORT,'interrupted'); END");
  expect(() => compactRootSetsStep(db, { chunkRows: 50, maxMs: 60_000 })).toThrow(/interrupted/);
  db.exec("DROP TRIGGER zz_boom");
  expect(Number(db.prepare("SELECT count(*) AS n FROM upgrade_root_set_worklist").get()!.n)).toBe(0); // rolled back with the cursor
  while (compactRootSetsStep(db, { chunkRows: 50, maxMs: 60_000 }).remaining);
  const row = db.prepare("SELECT total,done,finished_at FROM memory_root_set_compaction WHERE id=1").get()!;
  expect(Number(row.total)).toBe(100);
  expect(Number(row.done)).toBe(100);
  expect(row.finished_at).not.toBeNull();
});
