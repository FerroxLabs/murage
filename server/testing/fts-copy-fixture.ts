// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fixtures for the copy-settle tests (SMOOTH-FTS-MERGE R6 section 3, T9-T12, T14, T15). Kept and deleted rows are written in the
// SAME transaction, so they share a segment (a mixed segment), and the delete leaves tombstones. The residue detector works only
// for a deleted text that is ONE trigram whose first character no other term starts with (FTS5 prefix-compresses terms in leaf
// pages, so a trigram inside a longer word is not a contiguous byte run): a row whose text is exactly `жжж`, `ффф` or `щщщ`.
// Kept rows are ASCII.
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const DELETED_TEXT = { zh: "жжж", ef: "ффф", shcha: "щщщ" } as const;

/** The live file's merge setting while R6 batch 1 runs (automerge 0, deletemerge 0): a delete leaves its tombstones in place. */
export function holdMerges(db: DatabaseSync): void {
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)");
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 0)");
}

let nextAt = 1;
/** One transaction: `kept` ASCII rows in `keptThread` and `deleted` rows whose text is exactly `text` in `deletedThread`, each with
 * its messages_fts row keyed by messages.rowid. */
export function seedMixed(db: DatabaseSync, options: { keptThread: string; deletedThread: string; kept: number; deleted: number; text: string }): void {
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)");
  const index = db.prepare("INSERT INTO messages_fts(rowid,t) VALUES (?,?)");
  db.exec("BEGIN");
  try {
    const total = options.kept + options.deleted, step = Math.max(1, Math.floor(total / Math.max(1, options.deleted)));
    let deleted = 0;
    for (let i = 0; i < total; i++) {
      // the deleted rows are spread through the kept ones, so every leaf of the segment is mixed
      const kept = !(deleted < options.deleted && (i % step === 0 || total - i <= options.deleted - deleted));
      if (!kept) deleted++;
      const thread = kept ? options.keptThread : options.deletedThread;
      const text = kept ? `kept note ${nextAt.toString(36)} alpha ${((nextAt * 7919) % 99991).toString(36)}` : options.text;
      const at = nextAt++;
      const id = `${thread}-m${at}`;
      const rowid = Number(insert.run(thread, id, at, "user", "text", text, JSON.stringify({ id, at, role: "user", kind: "text", text })).lastInsertRowid);
      index.run(rowid, text);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** The owner's delete of a whole thread, as deleteThread does it: messages rows and their index rows, one transaction. */
export function deleteThreadRows(db: DatabaseSync, threadId: string): number {
  db.exec("BEGIN");
  try {
    const rows = db.prepare("SELECT rowid AS r FROM messages WHERE thread_id=?").all(threadId).map(row => Number(row.r));
    const drop = db.prepare("DELETE FROM messages_fts WHERE rowid=?");
    for (const rowid of rows) drop.run(rowid);
    db.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
    db.exec("COMMIT");
    return rows.length;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** True when any raw messages_fts_data block holds the text's bytes. */
export function ftsBlocksHold(db: DatabaseSync, text: string): boolean {
  const needle = Buffer.from(text, "utf8");
  return db.prepare("SELECT block FROM messages_fts_data").all().some(row => row.block instanceof Uint8Array && Buffer.from(row.block).includes(needle));
}

/** True when the file's bytes hold the text (a missing file holds nothing). */
export function fileHolds(path: string, text: string): boolean {
  return existsSync(path) && readFileSync(path).includes(Buffer.from(text, "utf8"));
}

/** Rollback-journal mode in the header (bytes 18 and 19 are 1; WAL is 2). */
export function headerIsRollback(path: string): boolean {
  const header = readFileSync(path).subarray(0, 20);
  return header[18] === 1 && header[19] === 1;
}

export const sidecarsOf = (path: string) => ["-journal", "-wal", "-shm"].filter(suffix => existsSync(`${path}${suffix}`));
export const keptRows = (db: DatabaseSync, thread: string) => Number(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?").get(thread)?.n);
export const indexRows = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM messages_fts_docsize").get()?.n);
