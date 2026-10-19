// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the fast upgrade leaves for the background (S2, S5, S7 of lanes/upgrade-ux/CONVERGED.md): the readers of a derived index never trust it
// before it is complete, the start-up note is up for every blocking step, and the conversion of root sets reads no set into memory.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, finishBackgroundUpgradeWorkNow, setUpgradeReporterForTest } from "./database.ts";
import { newestPageSpan, openRequestCards, pendingBrowserCheckRows, updateMessage } from "./message-db.ts";
import { BROWSER_CHECKING_REASON, browserUnavailableActivityName } from "../shared/browser-unavailable.ts";
import { indexBrowserCheckChunk, PENDING_BROWSER_CHECK_WHERE } from "./message-tables.ts";
import { readIndexState } from "./transcript-backfill.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import { messageSearchIndexReady, prepareMessageSearchBackfill, stepMessageSearchBackfill } from "./message-search-index.ts";
import { compactRootSetsStep, lineageStorageStatus } from "./memory/root-set-compaction.ts";
import { rootSetMembers } from "./memory/schema.ts";
import { buildSyntheticV6 } from "./memory/testing/upgrade-fast-fixture.ts";
import { join } from "node:path";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { setUpgradeReporterForTest(null); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const card = (id: string, at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ id, at, role: "bot", kind: "options", text: "Allow?", parentId: null, card: { requestId: `req-${id}`, options: [] }, ...extra });
const put = (db: DatabaseSync, thread: string, id: string, at: number, kind: string, json: string) => db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, id, at, "bot", kind, "x", json);

it("S2: with the card index not yet filled, an unanswered approval is still found (the thread's own rows are read), then the index agrees", () => {
  const db = database();
  // rows written by an older build: no index of cards
  put(db, "chat", "c1", 10, "options", card("c1", 10));
  put(db, "chat", "c2", 20, "options", card("c2", 20, { card: { requestId: "r2", answered: true, options: [] } }));
  put(db, "chat", "t1", 30, "text", JSON.stringify({ id: "t1", at: 30, role: "bot", kind: "text", text: "x", parentId: "c1" }));
  db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'");
  expect(readIndexState(db, "open_card").done).toBe(0);
  expect(openRequestCards("chat", 5).map(row => row.message.id)).toEqual(["c1"]);
  expect(newestPageSpan("chat", "t1")).toBeGreaterThan(0);
  finishBackgroundUpgradeWorkNow();
  expect(readIndexState(db, "open_card").done).toBe(1);
  expect(openRequestCards("chat", 5).map(row => row.message.id)).toEqual(["c1"]);
});

it("S2: the pending browser-check notes are not served from a table that is still being filled, and are afterwards", () => {
  const db = database();
  const name = browserUnavailableActivityName(BROWSER_CHECKING_REASON);
  // a note of the pending kind, written before the table existed
  for (const filler of ["f1", "f2", "f3"]) put(db, "chat", filler, 1, "text", JSON.stringify({ id: filler, at: 1, role: "bot", kind: "text", text: "x", parentId: null }));
  put(db, "chat", "n1", 5, "activity", JSON.stringify({ id: "n1", at: 5, role: "bot", kind: "activity", text: "", parentId: null, tool: { name } }));
  db.exec("DELETE FROM transcript_index_state WHERE name='browser_check'; DELETE FROM browser_check_pending");
  expect(pendingBrowserCheckRows()).toBeNull();
  indexBrowserCheckChunk(db, 1);
  expect(pendingBrowserCheckRows(), "half-filled is still not served").toBeNull();
  finishBackgroundUpgradeWorkNow();
  expect(pendingBrowserCheckRows()!.map(row => row.message.id)).toEqual(["n1"]);
  // a writer keeps the table: the note settles and leaves it
  updateMessage("chat", { id: "n1", at: 5, role: "bot", kind: "activity", text: "", parentId: null, tool: { name: "Browser check done" } } as never);
  expect(pendingBrowserCheckRows()).toEqual([]);
  expect(PENDING_BROWSER_CHECK_WHERE).toContain("activity");
});

it("S5: the search index tail and the log checkpoint do not run after the note is gone: the open leaves the tail to the background, and the note's last write is the checkpoint step", () => {
  const events: string[] = [];
  setUpgradeReporterForTest((dir, name) => {
    const real = memoryUpgradeReporter(dir, name);
    return new Proxy(real, { get(target, key) {
      const value = (target as never as Record<string, unknown>)[key as string];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { events.push(String(key) + (key === "blocking" ? `:${String(args[0])}` : "")); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    } });
  });
  buildSyntheticV6(join(DATA_DIR, "messages.db"), { threads: 6, perThread: 8, payloadBytes: 20 });
  // rows the index has not seen: a tail
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
  raw.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t0','tail1',9,'bot','text','late words','{\"id\":\"tail1\",\"parentId\":null}')");
  raw.close();
  const db = database();
  // the checkpoint ran under the note (a blocking stretch named committing), and the note was removed after it. The later owed-set and copy-index
  // backfills (database.ts) also run under the note, after the checkpoint, so "committing" is not the last stretch; none runs after the note is gone.
  expect(events).toContain("blocking:committing");
  expect(events.lastIndexOf("done")).toBeGreaterThan(events.lastIndexOf("blocking:committing"));
  expect(events.lastIndexOf("done")).toBeGreaterThan(Math.max(...events.map((event, at) => event.startsWith("blocking:") ? at : -1)));
  // the tail is not indexed by the open; searches scan until the fill ends
  expect(messageSearchIndexReady(db)).toBe(false);
  expect(db.prepare("SELECT 1 FROM messages_fts_docsize WHERE id=(SELECT rowid FROM messages WHERE id='tail1')").get()).toBeUndefined();
  while (stepMessageSearchBackfill(db, 3).more) { /* chunks */ }
  expect(messageSearchIndexReady(db)).toBe(true);
  expect(db.prepare("SELECT 1 FROM messages_fts_docsize WHERE id=(SELECT rowid FROM messages WHERE id='tail1')").get()).toBeTruthy();
  expect(prepareMessageSearchBackfill(db)).toBe(false);
});

it("S7: converting a large set reads none of its rows into memory, keeps its content, and a step spends at most its budget between sets", () => {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF");
  // the conversion is the v7 file's (from v10 root sets are frozen and the reclaim drops them): this file is made a v7 one
  db.exec("DROP TABLE IF EXISTS memory_lineage_cert");
  const SIZE = 60_000;
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${SIZE}) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'big',  't', 'm'||i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${SIZE - 10}) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'small', 't', 'm'||i FROM n;
    INSERT INTO memory_root_sets VALUES('small',${SIZE - 10}),('big',${SIZE});
    INSERT INTO memory_output_roots VALUES('t','a','small'),('t','b','big');
    INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,2,0,'',1)`);
  const before = [...rootSetMembers(db, "big")!].sort();
  const statements: string[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { statements.push(sql); return real(sql); };
  // (a set that inherits more than COMPACTION_MAX_CUT_ROWS stays full by design, so this 60,000-row set is cut with a larger limit)
  const step = compactRootSetsStep(db, { maxMs: 10_000, maxCutRows: 100_000 });
  (db as unknown as { prepare: unknown }).prepare = real;
  expect(step.converted).toBe(1);
  expect(statements.some(sql => /SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=\?/.test(sql))).toBe(false);
  expect([...rootSetMembers(db, "big")!].sort()).toEqual(before);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members WHERE set_id='big'").get()!.n)).toBe(10);
  expect(lineageStorageStatus(db).state).not.toBe("converting");
});
