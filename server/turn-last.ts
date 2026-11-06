// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The last row of each turn (turn_first.last_rowid, 1.0.18): with the turn's first row it bounds the rows a read of one turn
// looks at (message-db.ts turnRows, turnTextRows), so reading an older turn costs that turn's own span and never grows with
// the history written after it. A leaf module (only node:sqlite types), so the downgrade steps can import it without a cycle.
//
// What keeps the bound true:
//  - turn_last_msg: every row inserted into messages that carries a turn id raises its turn's last row (and lowers its first), in the
//    row's own statement, whichever build wrote it (an earlier build running on this file included). It reads the JSON only behind
//    json_valid(), so a row with damaged JSON is still written (it simply names no turn).
//  - turn_last_fill: a turn_first row inserted without a last row (an earlier build's fill or writer, which knows only first_rowid)
//    takes the newest row of messages at that moment: every row of that turn written so far is at or before it, and every later one
//    raises it through turn_last_msg.
//  - the floor (transcript_index_state "turn_last_floor"): the newest row of messages when the triggers were last made (a file from
//    before them, or one whose triggers a downgrade dropped). A row written while the triggers were absent is at or before it, so
//    until the walk below ends a turn that began at or before the floor is read up to MAX(last, floor): bounded by the upgrade point,
//    never by the history since.
//  - the walk (message-walker.ts WALKED "turn_last", one background pass over the rows, restarted whenever the floor is recorded
//    again): it files every row of the history through TURN_SPAN_UPSERT. Once it has ended, every turn's last row is exact and a turn
//    from before the upgrade costs its own span, like any other.
import type { DatabaseSync } from "node:sqlite";

export const TURN_LAST_COLUMN = "last_rowid";
/** The transcript_index_state row holding the floor (done = 1, cursor = the floor's rowid). */
export const TURN_LAST_FLOOR = "turn_last_floor";
/** The transcript_index_state row of the walk that makes every last row exact (a name in message-walker.ts WALKED). */
export const TURN_LAST_WALK = "turn_last";
/** The triggers 1.0.18 adds for the last row of a turn: no earlier build knows them, so every downgrade drops them first. */
export const TURN_LAST_TRIGGERS = ["turn_last_msg", "turn_last_fill"] as const;

/** The upsert every app writer of turn_first uses (message-db.ts, branch-fill.ts, message-walker.ts): first goes down, last goes up,
 * and a row already right is not written again. Parameters: thread_id, turn_id, first_rowid, last_rowid. */
export const TURN_SPAN_UPSERT = `INSERT INTO turn_first(thread_id, turn_id, first_rowid, last_rowid) VALUES (?, ?, ?, ?)
  ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid), last_rowid = MAX(COALESCE(last_rowid, excluded.last_rowid), excluded.last_rowid)
  WHERE first_rowid > excluded.first_rowid OR last_rowid IS NULL OR last_rowid < excluded.last_rowid`;

const TURN_LAST_MSG_DDL = `CREATE TRIGGER IF NOT EXISTS turn_last_msg AFTER INSERT ON messages
  WHEN CASE WHEN json_valid(NEW.json) THEN json_type(NEW.json, '$.turnId') = 'text' AND json_extract(NEW.json, '$.turnId') <> '' ELSE 0 END
BEGIN
  INSERT INTO turn_first(thread_id, turn_id, first_rowid, last_rowid) VALUES (NEW.thread_id, json_extract(NEW.json, '$.turnId'), NEW.rowid, NEW.rowid)
    ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid), last_rowid = MAX(COALESCE(last_rowid, excluded.last_rowid), excluded.last_rowid)
    WHERE first_rowid > excluded.first_rowid OR last_rowid IS NULL OR last_rowid < excluded.last_rowid;
END`;

const TURN_LAST_FILL_DDL = `CREATE TRIGGER IF NOT EXISTS turn_last_fill AFTER INSERT ON turn_first WHEN NEW.last_rowid IS NULL
BEGIN
  UPDATE turn_first SET last_rowid = MAX(NEW.first_rowid, COALESCE((SELECT MAX(rowid) FROM messages), 0)) WHERE thread_id = NEW.thread_id AND turn_id = NEW.turn_id;
END`;

const present = (db: DatabaseSync, type: string, name: string): boolean => db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name) !== undefined;
const hasLastColumn = (db: DatabaseSync): boolean => (db.prepare("PRAGMA table_info(turn_first)").all() as Array<{ name: string }>).some((column) => column.name === TURN_LAST_COLUMN);

/** Appends turn_first.last_rowid (ALTER TABLE on every file, a fresh one included, so a migrated and a fresh table keep one definition
 * text) and makes the triggers. When the column, a trigger or the floor is missing, the floor is recorded first, in the same savepoint:
 * every row written without the triggers is at or before it, and the walk starts over (a file with no message has nothing to walk).
 * Needs messages, turn_first and transcript_index_state. Idempotent. */
export function ensureTurnLast(db: DatabaseSync): void {
  const columnKept = hasLastColumn(db);
  if (!columnKept) db.exec(`ALTER TABLE turn_first ADD COLUMN ${TURN_LAST_COLUMN} INTEGER`);
  const floorKept = db.prepare("SELECT 1 AS x FROM transcript_index_state WHERE name = ? AND done = 1").get(TURN_LAST_FLOOR) !== undefined;
  if (columnKept && floorKept && TURN_LAST_TRIGGERS.every((name) => present(db, "trigger", name))) return;
  db.exec("SAVEPOINT turn_last");
  try {
    db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, (SELECT COALESCE(MAX(rowid), 0) FROM messages), 0)").run(TURN_LAST_FLOOR);
    db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, NOT EXISTS (SELECT 1 FROM messages), 0, 0)").run(TURN_LAST_WALK);
    db.exec(TURN_LAST_MSG_DDL);
    db.exec(TURN_LAST_FILL_DDL);
    db.exec("RELEASE turn_last");
  } catch (error) {
    try { db.exec("ROLLBACK TO turn_last"); db.exec("RELEASE turn_last"); } catch { /* already rolled back */ }
    throw error;
  }
}

/** The highest rowid a read of one turn must look at, given its kept first and last rows: last when the turn began after the floor or
 * the walk has ended (a turn the walk found no readable row for ends where it began), MAX(last, floor) when it began at or before the
 * floor and the walk is still going, and null (read on to the newest row, as before the column) when no bound is known (no floor kept
 * and no last row). One keyed read of the state. */
export function turnSpanEnd(db: DatabaseSync, first: number, last: number | null): number | null {
  const state = db.prepare("SELECT (SELECT cursor FROM transcript_index_state WHERE name = ? AND done = 1) AS floor, (SELECT done FROM transcript_index_state WHERE name = ?) AS walked").get(TURN_LAST_FLOOR, TURN_LAST_WALK) as { floor: number | null; walked: number | null };
  const kept = last === null ? null : Number(last);
  if (state.floor === null || first > Number(state.floor)) return kept;
  if (Number(state.walked) === 1) return kept ?? first;
  return Math.max(kept ?? 0, Number(state.floor));
}

/** Drops the triggers (no earlier build knows them; an earlier build's database check refuses an object it does not know). */
export function dropTurnLastTriggers(db: DatabaseSync): number {
  let dropped = 0;
  for (const name of TURN_LAST_TRIGGERS) if (present(db, "trigger", name)) { db.exec(`DROP TRIGGER ${name}`); dropped++; }
  return dropped;
}

/** Every earlier build: the triggers, the column, the floor and the walk's marker leave, whatever the target, in one transaction (a
 * savepoint inside the caller's). A later 1.0.18 start makes them again, records a new floor and walks again, so whatever the earlier
 * build wrote stays in the bound. */
export function downgradeTurnLastTo117(db: DatabaseSync): { dropped: number } {
  const triggers = TURN_LAST_TRIGGERS.filter((name) => present(db, "trigger", name));
  const table = present(db, "table", "turn_first");
  const column = table && hasLastColumn(db);
  const state = present(db, "table", "transcript_index_state");
  if (!triggers.length && !column && !(state && db.prepare("SELECT 1 AS x FROM transcript_index_state WHERE name IN (?, ?)").get(TURN_LAST_FLOOR, TURN_LAST_WALK))) return { dropped: 0 };
  const outer = db.isTransaction;
  db.exec(outer ? "SAVEPOINT turn_last_downgrade" : "BEGIN IMMEDIATE");
  try {
    const dropped = dropTurnLastTriggers(db);
    if (column) db.exec(`ALTER TABLE turn_first DROP COLUMN ${TURN_LAST_COLUMN}`);
    if (state) db.prepare("DELETE FROM transcript_index_state WHERE name IN (?, ?)").run(TURN_LAST_FLOOR, TURN_LAST_WALK);
    db.exec(outer ? "RELEASE turn_last_downgrade" : "COMMIT");
    return { dropped: dropped + (column ? 1 : 0) };
  } catch (error) {
    try { if (outer) { db.exec("ROLLBACK TO turn_last_downgrade"); db.exec("RELEASE turn_last_downgrade"); } else db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}
