// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Going back to 1.0.1 while 1.0.2's background search fill is unfinished. 1.0.1 resumes its index from the highest indexed rowid and trusts
// every row below it; 1.0.2 keeps the fill's own place (transcript_index_state 'search_fts'), because a live write of an unfinished run
// indexes its row beyond the rows not yet filled. The downgrade drops that place, so it must leave an index that 1.0.1's own resume
// completes. The resume run here is 1.0.1's shipped code (server/testing/message-search-index-1.0.1.ts, from the 1.0.1 release commit).
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { prepareMessageSearchBackfill, stepMessageSearchBackfill } from "./message-search-index.ts";
import { backfillMessageSearchIndex as resumeAs101 } from "./testing/message-search-index-1.0.1.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

const indexed = (db: DatabaseSync) => db.prepare("SELECT id FROM messages_fts_docsize ORDER BY id").all().map((row) => Number(row.id));
const searchableRows = (db: DatabaseSync) => db.prepare("SELECT rowid AS r FROM messages WHERE kind IN ('text','activity') ORDER BY rowid").all().map((row) => Number(row.r));
const hasStateTable = (db: DatabaseSync) => db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='transcript_index_state'").get() !== undefined;
function emptyHistory(db: DatabaseSync) {
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
}

it("an unfinished fill (row 1 filled, row 4 indexed live, rows 2 and 3 pending): after going back, 1.0.1's resume indexes rows 2 and 3", () => {
  const db = database();
  emptyHistory(db);
  for (let r = 1; r <= 4; r++) db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?, 'ts', ?, ?, 'user', 'text', ?, '{}')").run(r, `s${r}`, r, `searchable words ${r}`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  expect(stepMessageSearchBackfill(db, 1).more).toBe(true); // row 1 filled, cursor 1
  db.prepare("INSERT INTO messages_fts(rowid, t) VALUES (4, 'searchable words 4')").run(); // a live write of this run indexed row 4 itself
  expect(Number(db.prepare("SELECT cursor FROM transcript_index_state WHERE name='search_fts'").get()!.cursor)).toBe(1);

  downgradeApplicationSchemaTo101(db, DATA_DIR);
  expect(hasStateTable(db)).toBe(false); // the fill's place is gone: only the index itself tells 1.0.1 where to resume
  expect(indexed(db)).toEqual([1]); // the live entry above the cursor went with it
  resumeAs101(db); // what 1.0.1 runs at start
  expect(indexed(db)).toEqual([1, 2, 3, 4]);
});

it("a finished fill keeps every entry, and 1.0.1's resume has nothing to add", () => {
  const db = database();
  emptyHistory(db);
  for (let r = 1; r <= 6; r++) db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?, 'ts', ?, ?, 'user', 'text', ?, '{}')").run(r, `s${r}`, r, `searchable words ${r}`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  for (let guard = 0; guard < 20 && stepMessageSearchBackfill(db, 2).more; guard++);
  expect(Number(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_fts'").get()!.done)).toBe(1);
  downgradeApplicationSchemaTo101(db, DATA_DIR);
  expect(indexed(db)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(resumeAs101(db)).toBe(0);
});

it("at scale: 100,000 live entries above an unfinished fill's cursor are removed in a bounded downgrade, and 1.0.1 completes the index", () => {
  const db = database();
  emptyHistory(db);
  // 130,000 rows: an activity row every 9th, frames with nothing to index every 13th
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<130000)
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json)
    SELECT i, 'big', 'm'||i, 1700000000000+i, 'bot',
      CASE WHEN i % 13 = 0 THEN 'screen' WHEN i % 9 = 0 THEN 'activity' ELSE 'text' END,
      CASE WHEN i % 13 = 0 OR i % 9 = 0 THEN NULL ELSE 'searchable line '||i END,
      CASE WHEN i % 9 = 0 AND i % 13 <> 0 THEN '{"tool":{"name":"Ran step '||i||'"}}' ELSE '{}' END FROM n`);
  // the fill reached row 20,000; rows above it were indexed by live writes (every searchable row past 30,000), rows 20,001-30,000 are pending
  db.exec(`INSERT INTO messages_fts(rowid, t) SELECT rowid, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') ELSE text END FROM messages
    WHERE (rowid <= 20000 OR rowid > 30000) AND kind IN ('text','activity')`);
  db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('search_fts', 0, 20000, 0)").run();
  const above = Number(db.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize WHERE id > 20000").get()!.n);
  expect(above).toBeGreaterThan(90_000);

  const began = performance.now();
  downgradeApplicationSchemaTo101(db, DATA_DIR);
  const downgradeMs = performance.now() - began;
  expect(Number(db.prepare("SELECT MAX(id) AS top FROM messages_fts_docsize").get()!.top)).toBeLessThanOrEqual(20000);
  const resumeBegan = performance.now();
  const added = resumeAs101(db);
  const resumeMs = performance.now() - resumeBegan;
  console.log("downgrade with an unfinished search fill", { liveEntriesRemoved: above, downgradeMs: Math.round(downgradeMs), resumeAs101Ms: Math.round(resumeMs), added });
  expect(indexed(db)).toEqual(searchableRows(db));
  expect(downgradeMs).toBeLessThan(15_000);
}, 300_000);
