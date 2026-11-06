// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 T15: the downgrade settles the live file's search index before the older build sees it, in the order of
// R6 section 4: the app-schema step (trimUnfinishedSearchFill) commits; secure_delete; orphans; optimize until settled; VACUUM;
// the probe again; automerge 4 and deletemerge 10; the memory step; a checked wal_checkpoint(TRUNCATE); only then the search_merge
// row leaves, by name. A crash at any point leaves a file that is owed or settled, and a rerun converges.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeInstallationMemorySchema, type DowngradeSearchPoint } from "./installation-memory-downgrade.ts";
import { prepareMessageSearchBackfill, stepMessageSearchBackfill } from "./message-search-index.ts";
import { backfillMessageSearchIndex as resumeAs101 } from "./testing/message-search-index-1.0.1.ts";
import { ftsSettled } from "./settle-copy.ts";
import { DELETED_TEXT, deleteThreadRows, fileHolds, ftsBlocksHold, holdMerges, keptRows, seedMixed } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const open: DatabaseSync[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } } closeDatabase(); });
const file = () => join(DATA_DIR, "messages.db");

/** The live file as R6 batch 1 leaves it: merges held, a deleted thread's tombstones owed, the marker row in `state`. */
function owedInstallation(marker: 0 | 1 | null = 0) {
  const db = database();
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 400, deleted: 80, text: DELETED_TEXT.zh });
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 200, deleted: 40, text: DELETED_TEXT.zh });
  deleteThreadRows(db, "gone");
  if (marker !== null) db.prepare("INSERT INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_merge',?,0,0) ON CONFLICT(name) DO UPDATE SET done=excluded.done").run(marker);
  expect(ftsSettled(db)).toBe("owed");
  expect(ftsBlocksHold(db, DELETED_TEXT.zh)).toBe(true);
  closeDatabase();
}
function reopen() { const db = new DatabaseSync(file()); open.push(db); return db; }
const markerOf = (db: DatabaseSync) => db.prepare("SELECT done FROM transcript_index_state WHERE name='search_merge'").get()?.done;
const config = (db: DatabaseSync) => Object.fromEntries(db.prepare("SELECT k,v FROM messages_fts_config WHERE k IN ('automerge','deletemerge')").all().map(row => [String(row.k), Number(row.v)]));

function expectSettledLiveFile(kept = 600) {
  const db = reopen();
  expect(ftsSettled(db)).toBe("settled");
  expect(ftsBlocksHold(db, DELETED_TEXT.zh)).toBe(false);
  expect(config(db)).toEqual({ automerge: 4, deletemerge: 10 });
  expect(keptRows(db, "kept")).toBe(kept);
  expect(markerOf(db)).toBeUndefined();
  db.close(); open.splice(open.indexOf(db), 1);
  expect(fileHolds(file(), DELETED_TEXT.zh)).toBe(false);
  expect(fileHolds(`${file()}-wal`, DELETED_TEXT.zh)).toBe(false);
}

it("T15: a downgrade to 10 settles and vacuums the live index, writes the older defaults and removes the marker after the checkpoint", () => {
  owedInstallation(0);
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  expectSettledLiveFile();
});

it.each<DowngradeSearchPoint>(["optimized", "config-restored", "checkpointed"])("T15: a crash after %s leaves the file owed or settled, and the rerun converges", point => {
  owedInstallation(0);
  expect(() => downgradeInstallationMemorySchema(DATA_DIR, 10, { at: at => { if (at === point) throw Object.assign(new Error("CRASH_INJECTED"), { code: "CRASH_INJECTED" }); } })).toThrow(/CRASH_INJECTED/);
  const db = reopen();
  // the marker is still there at every crash point (it leaves only after the checkpoint), so the next start pays any debt
  expect(markerOf(db)).toBe(0);
  expect(["settled", "owed"]).toContain(ftsSettled(db));
  if (point !== "optimized") expect(ftsSettled(db)).toBe("settled");
  db.close(); open.splice(open.indexOf(db), 1);
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  expectSettledLiveFile();
});

it.each<0 | 1>([0, 1])("T15: the marker (done=%s) survives a failed checkpoint and leaves after a good one", done => {
  owedInstallation(done);
  const reader = reopen();
  // a read snapshot taken after the VACUUM and before the memory step's writes holds the log, so the TRUNCATE cannot finish
  const hold = (point: DowngradeSearchPoint) => { if (point === "config-restored") { reader.exec("BEGIN"); reader.prepare("SELECT count(*) AS n FROM messages").get(); } };
  expect(() => downgradeInstallationMemorySchema(DATA_DIR, 10, { at: hold })).toThrow(expect.objectContaining({ code: "WAL_CHECKPOINT_INCOMPLETE" }));
  reader.exec("COMMIT");
  expect(markerOf(reader)).toBe(done);
  reader.close(); open.splice(open.indexOf(reader), 1);
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  expectSettledLiveFile();
}, 60_000);

it("T15: the TRUNCATE after the marker delete is checked: a held log fails the downgrade, and the rerun leaves a standalone settled file", () => {
  owedInstallation(0);
  const reader = reopen();
  // a read snapshot taken after the first TRUNCATE (an empty log) holds the marker delete's frame out of the file
  const hold = (point: DowngradeSearchPoint) => { if (point === "checkpointed") { reader.exec("BEGIN"); reader.prepare("SELECT count(*) AS n FROM messages").get(); } };
  let deleted = false;
  expect(() => downgradeInstallationMemorySchema(DATA_DIR, 10, { at: point => { hold(point); if (point === "marker-deleted") deleted = true; } })).toThrow(expect.objectContaining({ code: "WAL_CHECKPOINT_INCOMPLETE" }));
  expect(deleted).toBe(true);
  reader.exec("COMMIT");
  expect(markerOf(reader)).toBeUndefined();
  reader.close(); open.splice(open.indexOf(reader), 1);
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  expectSettledLiveFile();
}, 60_000);

it("T15: no marker and no index rows to settle: the downgrade still runs its steps and writes the older defaults", () => {
  database();
  closeDatabase();
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  const db = reopen();
  expect(ftsSettled(db)).toBe("settled");
  expect(config(db)).toEqual({ automerge: 4, deletemerge: 10 });
});

it("T15: an unfinished search_fts fill on a to<=6 run: the trimmed entries' tombstones settle, and 1.0.1 resumes and searches", () => {
  const db = database();
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  holdMerges(db);
  for (let r = 1; r <= 40; r++) db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?, 'ts', ?, ?, 'user', 'text', ?, '{}')").run(r, `s${r}`, r, `searchable words ${r}`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  expect(stepMessageSearchBackfill(db, 10).more).toBe(true); // rows 1-10 filled, cursor 10
  // live writes of this run indexed rows above the cursor: kept rows and a thread the owner then deleted, in the same transactions
  db.exec("BEGIN");
  for (let r = 41; r <= 140; r++) {
    const gone = r % 5 === 0;
    db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?, ?, ?, ?, 'user', 'text', ?, '{}')").run(r, gone ? "gone" : "ts", `s${r}`, r, gone ? DELETED_TEXT.ef : `searchable words ${r}`);
    db.prepare("INSERT INTO messages_fts(rowid, t) VALUES (?, ?)").run(r, gone ? DELETED_TEXT.ef : `searchable words ${r}`);
  }
  db.exec("COMMIT");
  deleteThreadRows(db, "gone");
  expect(Number(db.prepare("SELECT cursor FROM transcript_index_state WHERE name='search_fts'").get()!.cursor)).toBe(10);
  expect(ftsSettled(db)).toBe("owed");
  closeDatabase();

  downgradeInstallationMemorySchema(DATA_DIR, 6);
  const after = reopen();
  expect(after.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='transcript_index_state'").get()).toBeUndefined();
  expect(ftsSettled(after)).toBe("settled");
  expect(ftsBlocksHold(after, DELETED_TEXT.ef)).toBe(false);
  expect(config(after)).toEqual({ automerge: 4, deletemerge: 10 });
  expect(Number(after.prepare("SELECT MAX(id) AS top FROM messages_fts_docsize").get()!.top)).toBeLessThanOrEqual(10);
  resumeAs101(after); // what 1.0.1 runs at start
  const searchable = after.prepare("SELECT rowid AS r FROM messages WHERE kind='text' ORDER BY rowid").all().map(row => Number(row.r));
  expect(after.prepare("SELECT id FROM messages_fts_docsize ORDER BY id").all().map(row => Number(row.id))).toEqual(searchable);
  expect(Number(after.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get('"wor"')?.n)).toBeGreaterThan(0);
  after.close(); open.splice(open.indexOf(after), 1);
  expect(fileHolds(file(), DELETED_TEXT.ef)).toBe(false);
});
