// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The background search fill runs on the main thread, a chunk at a time, while the owner uses the app (the first start on a history the
// index has not seen, or a thread written straight into the file). A piece of it must cost its own rows and never the history: the piece
// read used to go through the (kind, thread, at) index and sort every text and activity row past the cursor, which held the event loop
// for 0.1 to 1.3 s per piece on the owner's 103k-message history and for ~150 ms per piece on a 200k-row thread here.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { prepareMessageSearchBackfill, stepMessageSearchBackfill } from "./message-search-index.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

it("each step of the search fill over a 200,000-row history stays short, crosses a long run of rows with nothing to index, and indexes every searchable row", () => {
  const db = database();
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  // rows 1..200000 in one thread: text rows, an activity row every 7th, and rows 100001..110000 frames with nothing to index
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200000)
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json)
    SELECT i, 'big', 'm'||i, 1700000000000+i, 'bot',
      CASE WHEN i BETWEEN 100001 AND 110000 THEN 'screen' WHEN i % 7 = 0 THEN 'activity' ELSE 'text' END,
      CASE WHEN i BETWEEN 100001 AND 110000 OR i % 7 = 0 THEN NULL ELSE 'searchable line '||i END,
      CASE WHEN i % 7 = 0 AND i NOT BETWEEN 100001 AND 110000 THEN '{"tool":{"name":"Ran step '||i||'"}}' ELSE '{}' END FROM n`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  let worst = 0, steps = 0;
  for (;;) {
    const began = performance.now();
    const step = stepMessageSearchBackfill(db);
    worst = Math.max(worst, performance.now() - began);
    steps++;
    if (!step.more || worst > 250) break; // the old read would take minutes over this history: stop at the first long step
  }
  console.log("search fill over 200,000 rows", { steps, worstStepMs: Math.round(worst) });
  expect(worst).toBeLessThan(100);
  const indexed = Number((db.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get() as { n: number }).n);
  const searchable = Number((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('text','activity')").get() as { n: number }).n);
  expect(indexed).toBe(searchable);
  expect(db.prepare("SELECT 1 FROM messages_fts_docsize WHERE id BETWEEN 100001 AND 110000").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM messages_fts_docsize WHERE id = 110001").get()).toBeTruthy();
  const state = db.prepare("SELECT done, cursor FROM transcript_index_state WHERE name='search_fts'").get() as { done: number; cursor: number };
  expect(Number(state.done)).toBe(1);
  expect(Number(state.cursor)).toBe(200000);
}, 120_000);

it("a step counts its indexing and its commit in its time: long rows (a pasted document each) never hold the loop past the bound", () => {
  const db = database();
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  // 400 rows of ~200,000 characters each (80 MB of text, every trigram distinct enough to cost its indexing), with a short row between some
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<400)
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json)
    SELECT i, 'docs', 'd'||i, 1700000000000+i, 'user', 'text',
      CASE WHEN i % 10 = 0 THEN 'short line '||i ELSE 'doc '||i||' '||lower(hex(randomblob(100000))) END, '{}' FROM n`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  const times: number[] = [];
  for (;;) {
    const began = performance.now();
    const step = stepMessageSearchBackfill(db);
    times.push(performance.now() - began);
    if (!step.more || times.at(-1)! > 1_000) break; // the old step read and indexed up to 100 such rows at once: stop at the first long one
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log("search fill over 400 rows of 200,000 characters", { steps: times.length, worstStepMs: Math.round(sorted.at(-1)!), p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)]!) });
  expect(sorted.at(-1)!).toBeLessThan(100);
  expect(Number((db.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get() as { n: number }).n)).toBe(400);
  expect(Number((db.prepare("SELECT done FROM transcript_index_state WHERE name='search_fts'").get() as { done: number }).done)).toBe(1);
}, 300_000);
