// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bounded form of a turn's sources (server/steer-lineage.ts). A turn carries every line of its own conversation up to the newest one when it
// began, however long that conversation is (a resumed session holds far more than its replay window). Naming each of those lines would grow with
// the conversation, so the turn names a range instead: "every line of thread T up to message X, as it stood at hold-log entry S". Whether the
// range still holds is one indexed question, whose cost follows what happened since the turn began, never how long the conversation is:
//
//   is there an entry in the hold log for thread T after S, at a stored position no later than X's?
//
// The hold log (turn_source_holds) is written in the same transaction as the change it records, by triggers on the transcript and by memory's
// forget (server/memory/forget.ts):
//   - a line bots may be shown is withheld from them (withheldFromBots set, "forgotten" included), or its copy link changes;
//   - a stored line is replaced under the same id (it would move out of the range: recorded at its old place, fail closed);
//   - memory forgets the message a source was captured from;
//   - and for each of these, every copy of that line (turn_source_copies, kept by the triggers as copies are written, every original of a
//     copy of a copy included), so a copy in T whose original elsewhere is withheld, forgotten or deleted holds T's range too.
// X itself must still be stored: a deleted conversation takes the range with it. Owner lines are never sources and never logged.
import type { DatabaseSync } from "node:sqlite";
import { database } from "./database.ts";
import { copyFieldsChanged } from "./message-copy-fields.ts";
import type { SourceRange } from "./released-text.ts";

export type { SourceRange };

/** A range as a running turn keeps it: with X's stored position, so lines it later takes in are placed without asking again. */
export interface HeldRange extends SourceRange { position: number }

/** The 1.0.2 objects this module adds (server/installation-app-schema-downgrade.ts drops them; the snapshot accepts them). */
export const TURN_SOURCE_HOLD_TABLES = ["turn_source_copies", "turn_source_holds"] as const;
export const TURN_SOURCE_HOLD_INDEXES = ["turn_source_copies_copy", "turn_source_holds_thread"] as const;
export const TURN_SOURCE_HOLD_TRIGGERS = ["turn_source_copy_d", "turn_source_copy_i", "turn_source_hold_r", "turn_source_hold_u"] as const;

/** Every copy of the line (thread, id), as hold-log rows: the copy's thread and its stored position. */
const copiesOf = (thread: string, id: string) => `SELECT thread_id, position FROM turn_source_copies WHERE origin_thread=${thread} AND origin_id=${id}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_source_holds (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turn_source_holds_thread ON turn_source_holds(thread_id, seq, position);
CREATE TABLE IF NOT EXISTS turn_source_copies (origin_thread TEXT NOT NULL, origin_id TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(origin_thread, origin_id, thread_id, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS turn_source_copies_copy ON turn_source_copies(thread_id, id);
CREATE TRIGGER IF NOT EXISTS turn_source_hold_u AFTER UPDATE ON messages
 WHEN NEW.role IS NOT 'user' AND ${copyFieldsChanged("OLD.json", "NEW.json")}
  AND NOT CASE WHEN json_valid(OLD.json) AND json_valid(NEW.json)
   THEN json_extract(OLD.json,'$.copyOf') IS json_extract(NEW.json,'$.copyOf') AND COALESCE(json_extract(NEW.json,'$.withheldFromBots'),0) IN (0) ELSE 0 END
 BEGIN
  INSERT INTO turn_source_holds(thread_id, position) VALUES (NEW.thread_id, NEW.rowid);
  INSERT INTO turn_source_holds(thread_id, position) ${copiesOf("NEW.thread_id", "NEW.id")};
 END;
CREATE TRIGGER IF NOT EXISTS turn_source_hold_r BEFORE INSERT ON messages
 WHEN EXISTS (SELECT 1 FROM messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id AND o.role IS NOT 'user')
 BEGIN
  INSERT INTO turn_source_holds(thread_id, position) SELECT thread_id, rowid FROM messages WHERE thread_id=NEW.thread_id AND id=NEW.id;
  INSERT INTO turn_source_holds(thread_id, position) ${copiesOf("NEW.thread_id", "NEW.id")};
 END;
CREATE TRIGGER IF NOT EXISTS turn_source_copy_i AFTER INSERT ON messages
 WHEN instr(NEW.json,'copyOf')>0 AND json_valid(NEW.json) AND json_type(NEW.json,'$.copyOf.messageIds')='array'
 BEGIN
  INSERT OR REPLACE INTO turn_source_copies(origin_thread, origin_id, thread_id, id, position)
   SELECT json_extract(NEW.json,'$.copyOf.threadId'), j.value, NEW.thread_id, NEW.id, NEW.rowid FROM json_each(NEW.json,'$.copyOf.messageIds') j
   WHERE j.type='text' AND json_type(NEW.json,'$.copyOf.threadId')='text';
  INSERT OR REPLACE INTO turn_source_copies(origin_thread, origin_id, thread_id, id, position)
   SELECT c.origin_thread, c.origin_id, NEW.thread_id, NEW.id, NEW.rowid FROM json_each(NEW.json,'$.copyOf.messageIds') j
   JOIN turn_source_copies c ON c.thread_id=json_extract(NEW.json,'$.copyOf.threadId') AND c.id=j.value WHERE j.type='text';
 END;
CREATE TRIGGER IF NOT EXISTS turn_source_copy_d AFTER DELETE ON messages
 BEGIN
  INSERT INTO turn_source_holds(thread_id, position) ${copiesOf("OLD.thread_id", "OLD.id")};
  DELETE FROM turn_source_copies WHERE origin_thread=OLD.thread_id AND origin_id=OLD.id;
  DELETE FROM turn_source_copies WHERE thread_id=OLD.thread_id AND id=OLD.id;
 END;
`;

const BACKFILL_MARKER = "turn_source_copies";

/** Creates the hold log, the copy index and their triggers. Idempotent. */
export function initializeTurnSourceHolds(db: DatabaseSync): void {
  db.exec(SCHEMA);
  // The log's first entry is numbered from the clock, so a log made again (after a downgrade dropped it) starts above every entry the old one
  // handed out: a range taken against the old log is older than the new log's first entry, and fails closed (rangeHolds).
  db.prepare("INSERT INTO turn_source_holds(seq, thread_id, position) SELECT ?, '', 0 WHERE NOT EXISTS (SELECT 1 FROM turn_source_holds)").run(Date.now() * 1000);
}

/** Whether copies written before the copy index existed are in it yet (`backfillTurnSourceCopies`). */
export function turnSourceCopiesBackfilled(db: DatabaseSync): boolean {
  try { return Boolean((db.prepare("SELECT done FROM transcript_index_state WHERE name=?").get(BACKFILL_MARKER) as { done?: number } | undefined)?.done); }
  catch { return false; }
}

/** Copies stored before the copy index existed, put in it once (every original of a copy of a copy too, as deep as the copy walk goes). It reads
 * every stored row once, so server/database.ts runs it inside the reported upgrade work; the marker is written in the same transaction. */
export function backfillTurnSourceCopies(db: DatabaseSync): void {
  if (turnSourceCopiesBackfilled(db)) return;
  db.exec("SAVEPOINT turn_source_copies_backfill");
  try {
    db.exec(`INSERT OR REPLACE INTO turn_source_copies(origin_thread, origin_id, thread_id, id, position)
      SELECT json_extract(m.json,'$.copyOf.threadId'), j.value, m.thread_id, m.id, m.rowid FROM messages m, json_each(m.json,'$.copyOf.messageIds') j
      WHERE instr(m.json,'copyOf')>0 AND json_valid(m.json) AND json_type(m.json,'$.copyOf.messageIds')='array' AND json_type(m.json,'$.copyOf.threadId')='text' AND j.type='text'`);
    // a copy of a copy rests on every original up the chain (the copy walk goes at most 8 deep: server/result-egress.ts)
    for (let depth = 0; depth < 8; depth++) {
      const added = db.prepare(`INSERT OR IGNORE INTO turn_source_copies(origin_thread, origin_id, thread_id, id, position)
        SELECT up.origin_thread, up.origin_id, c.thread_id, c.id, c.position FROM turn_source_copies c JOIN turn_source_copies up ON up.thread_id=c.origin_thread AND up.id=c.origin_id`).run();
      if (Number(added.changes) === 0) break;
    }
    db.prepare("INSERT INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, 0, 0) ON CONFLICT(name) DO UPDATE SET done=1").run(BACKFILL_MARKER);
    db.exec("RELEASE turn_source_copies_backfill");
  } catch (error) { db.exec("ROLLBACK TO turn_source_copies_backfill"); db.exec("RELEASE turn_source_copies_backfill"); throw error; }
}

/** The newest hold-log entry: a turn that begins now is unaffected by every entry up to it. */
export function holdLogNow(db: DatabaseSync = database()): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM turn_source_holds").get() as { seq: number };
  return Number(row.seq);
}

/** The range of `threadId` a turn that begins now carries: every line up to the newest stored one. Undefined for a conversation with no lines. */
export function threadRangeNow(threadId: string, db: DatabaseSync = database()): HeldRange | undefined {
  const newest = db.prepare("SELECT id, rowid AS position FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId) as { id: string; position: number } | undefined;
  if (!newest) return undefined;
  return { threadId, upTo: newest.id, position: Number(newest.position), since: holdLogNow(db) };
}

/** Where a line is stored in its conversation, or undefined when it is not stored. */
export function storedPosition(threadId: string, messageId: string, db: DatabaseSync = database()): number | undefined {
  const row = db.prepare("SELECT rowid AS position FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId) as { position: number } | undefined;
  return row ? Number(row.position) : undefined;
}

/** What the hold check has cost since the counter was reset: the statements it ran and the rows they returned. */
const cost = { statements: 0, rows: 0 };
export function rangeHoldCost(reset = false): { statements: number; rows: number } {
  const seen = { ...cost };
  if (reset) { cost.statements = 0; cost.rows = 0; }
  return seen;
}

/** The hold query: the log's index on (thread_id, seq, position) answers it from the entries after `since` in that thread alone. */
export const RANGE_HOLD_SQL = "SELECT 1 AS held FROM turn_source_holds WHERE thread_id=? AND seq>? AND position<=? LIMIT 1";
/** And the log's first entry (the rowid's own minimum): a range taken before this log began cannot be checked against it. */
const RANGE_CHECK_SQL = `SELECT (SELECT MIN(seq) FROM turn_source_holds) AS first, EXISTS (${RANGE_HOLD_SQL}) AS held`;

/** Whether every line of the range still stands: X is still stored, and nothing in the range was withheld, forgotten, replaced, or had its
 * original taken away since the range was taken. Two indexed statements whatever the conversation's length; any error fails closed. */
export function rangeHolds(range: SourceRange, db: DatabaseSync = database()): boolean {
  try {
    cost.statements++;
    const upTo = db.prepare("SELECT rowid AS position FROM messages WHERE thread_id=? AND id=?").get(range.threadId, range.upTo) as { position: number } | undefined;
    if (!upTo) return false;
    cost.rows++;
    cost.statements++;
    const check = db.prepare(RANGE_CHECK_SQL).get(range.threadId, range.since, Number(upTo.position)) as { first: number | null; held: number };
    cost.rows++;
    if (check.first === null || range.since < Number(check.first)) return false;
    return Number(check.held) === 0;
  } catch { return false; }
}

/** Memory forgot these captured sources: the messages they were captured from, and every copy of those, join the hold log in the same
 * transaction (server/memory/forget.ts). A source that names no stored message adds nothing. */
export function holdForgottenSources(db: DatabaseSync, sourceIds: readonly string[]): void {
  if (!sourceIds.length) return;
  const lines = db.prepare(`SELECT m.thread_id AS thread_id, m.id AS id, m.rowid AS position, m.role AS role FROM memory_sources s
    JOIN messages m ON m.thread_id=s.thread_id AND m.id=s.message_id WHERE s.id=?`);
  const hold = db.prepare("INSERT INTO turn_source_holds(thread_id, position) VALUES (?, ?)");
  const copies = db.prepare(`INSERT INTO turn_source_holds(thread_id, position) ${copiesOf("?", "?")}`);
  for (const sourceId of new Set(sourceIds)) {
    const line = lines.get(sourceId) as { thread_id: string; id: string; position: number; role: string } | undefined;
    if (!line || line.role === "user") continue;
    hold.run(line.thread_id, line.position);
    copies.run(line.thread_id, line.id);
  }
}

/** The stored messages captured sources were taken from, as lines a turn can carry (owner lines marked: they are never sources). A source that
 * names no stored message (an imported document, a deleted conversation) is left out: its text is checked by memory's own rules. */
export function memorySourceLines(sourceIds: readonly string[], db: DatabaseSync = database()): Array<{ threadId: string; id: string; role: string }> {
  const read = db.prepare("SELECT m.thread_id AS thread_id, m.id AS id, m.role AS role FROM memory_sources s JOIN messages m ON m.thread_id=s.thread_id AND m.id=s.message_id WHERE s.id=?");
  const lines: Array<{ threadId: string; id: string; role: string }> = [];
  for (const sourceId of new Set(sourceIds)) {
    const row = read.get(sourceId) as { thread_id: string; id: string; role: string } | undefined;
    if (row) lines.push({ threadId: row.thread_id, id: row.id, role: row.role });
  }
  return lines;
}
