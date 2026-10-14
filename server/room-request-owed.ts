// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";

import type { BlockingHeartbeat } from "./memory/blocking-heartbeat.ts";
import { roomRequestsTransaction } from "./room-requests.ts";
import { releaseRestoreHold } from "./restore-fence.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";

/** Work a finished room request still owes, as a set that holds ONLY the rows that owe it (Astra r12).
 *
 * Two kinds, one table so a restore, a snapshot and a prune treat them alike:
 *  - `shared_delivery`: a finished request whose result may still be owed to its requester (a shared teammate's reply).
 *    A row is put here by the database the moment a request reaches `done`/`failed` with a target thread, and leaves when
 *    the result is delivered, when the request is found not to be shared work, or when the request row is deleted.
 *  - `fanout`: a finished owner send whose room turns may not have been created yet. A row is put here when the send
 *    is `done` with its message written, and leaves, in the same statement, when its first child request is created,
 *    or when boot records a terminal decision (nothing to fan out, the member left, a restore holds it).
 *
 * Startup and the 30 s sweep read these rows and nothing else, so their cost follows pending work, never history.
 * The triggers are the single choke point: every writer of a terminal state (finish, cancel, expire, restore) is covered,
 * not just the ones that exist today. Rows from before this table existed are seeded once by `backfillRoomRequestOwed`. */
export type RoomRequestOwedKind = "shared_delivery" | "fanout";

const SHARED_OWED_WHEN = "NEW.state IN ('done','failed') AND NEW.verb!='wake' AND NEW.target_thread_id IS NOT NULL AND NEW.refusal IS NOT 'delivered'";
const FANOUT_OWED_WHEN = "NEW.verb='owner_send' AND NEW.state='done' AND NEW.result_message_id IS NOT NULL";

/** The partial index an earlier build of this release kept for the same question (finished shared results not yet delivered). The owed
 * set replaced it; it is dropped on every start, and an older archive that still carries it is accepted with exactly this text. */
export const LEGACY_SHARED_OWED_INDEX = "room_requests_shared_owed";
export const LEGACY_SHARED_OWED_INDEX_DDL = "CREATE INDEX room_requests_shared_owed ON room_requests(id) WHERE state IN ('done','failed') AND verb!='wake' AND target_thread_id IS NOT NULL AND refusal IS NOT 'delivered'";

const OWED_TABLE_DDL = `CREATE TABLE IF NOT EXISTS room_request_owed (
  kind TEXT NOT NULL CHECK(kind IN ('shared_delivery','fanout')),
  request_id TEXT NOT NULL,
  -- shared provenance, kept on the row so a moment of unavailable task or thread metadata can never erase the debt:
  -- the requester's thread once the request is known to be shared work (shared=1), and the retry schedule for a delivery that could not be decided yet
  shared INTEGER CHECK(shared IS NULL OR shared=1),
  destination_thread_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, request_id)) WITHOUT ROWID`;
const OWED_DDL = `
DROP INDEX IF EXISTS ${LEGACY_SHARED_OWED_INDEX};
${OWED_TABLE_DDL};
CREATE TABLE IF NOT EXISTS room_request_backfills (
  name TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)));
CREATE TRIGGER IF NOT EXISTS room_request_owed_shared_ins AFTER INSERT ON room_requests WHEN ${SHARED_OWED_WHEN}
  BEGIN INSERT OR IGNORE INTO room_request_owed(kind, request_id) VALUES('shared_delivery', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS room_request_owed_shared_upd AFTER UPDATE OF state, target_thread_id, refusal, verb ON room_requests WHEN ${SHARED_OWED_WHEN}
  BEGIN INSERT OR IGNORE INTO room_request_owed(kind, request_id) VALUES('shared_delivery', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS room_request_owed_shared_clear AFTER UPDATE OF state, refusal ON room_requests WHEN NEW.refusal IS 'delivered' OR NEW.state NOT IN ('done','failed')
  BEGIN DELETE FROM room_request_owed WHERE kind='shared_delivery' AND request_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS room_request_owed_fanout_ins AFTER INSERT ON room_requests WHEN ${FANOUT_OWED_WHEN}
  BEGIN INSERT OR IGNORE INTO room_request_owed(kind, request_id) VALUES('fanout', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS room_request_owed_fanout_upd AFTER UPDATE OF state, result_message_id, verb ON room_requests WHEN ${FANOUT_OWED_WHEN}
  BEGIN INSERT OR IGNORE INTO room_request_owed(kind, request_id) VALUES('fanout', NEW.id); END;
CREATE TRIGGER IF NOT EXISTS room_request_owed_fanout_child AFTER INSERT ON room_requests WHEN NEW.root_id <> NEW.id
  BEGIN DELETE FROM room_request_owed WHERE kind='fanout' AND request_id=NEW.root_id; END;
-- Classification, written when the debt is recorded and never derived from the live registry (Astra r18): a finished request owes a shared delivery only
-- if the database recorded it as shared work when it was created (a provenance row for an ask or message). Anything else (a channel turn, a bot ask,
-- an owner send, a routine, a card run) is not shared and its row is removed here, in the statement that inserted it. A shared one is stamped with its
-- destination, the SQL twin of requestSourceThread. The earlier triggers keep their exact text, so an older archive still passes snapshot inspection.
CREATE TRIGGER IF NOT EXISTS room_request_owed_classify AFTER INSERT ON room_request_owed WHEN NEW.kind='shared_delivery'
  BEGIN
    DELETE FROM room_request_owed WHERE kind='shared_delivery' AND request_id=NEW.request_id AND shared IS NOT 1
      AND NOT EXISTS (SELECT 1 FROM room_requests r JOIN shared_request_provenance p ON p.request_id=r.id WHERE r.id=NEW.request_id AND r.verb IN ('ask','message'));
    UPDATE room_request_owed SET shared=1, destination_thread_id=COALESCE(destination_thread_id,
        (SELECT COALESCE((SELECT t.target_thread_id FROM room_requests t WHERE t.id=r.parent_id), r.return_thread_id, r.root_thread_id) FROM room_requests r WHERE r.id=NEW.request_id))
      WHERE kind='shared_delivery' AND request_id=NEW.request_id;
  END;
-- The due owed rows, by retry time (settleOwedSharedResults reads LIMIT 100 of them, never the whole set).
CREATE INDEX IF NOT EXISTS room_request_owed_due ON room_request_owed(kind, retry_at, request_id);
-- By request alone (Astra r20): the room_request_owed_gone trigger and the hold retirement probe by request id, and the primary key leads with kind.
CREATE INDEX IF NOT EXISTS room_request_owed_request ON room_request_owed(request_id);
-- Retained unknown requests (Astra r16): a queued request kept because its bot or room is not known yet gets a row here, with the next
-- time it is looked at. A sweep reads only the rows that are due (bounded), never the whole retained backlog. The row leaves
-- with the queued state (dispatched, cancelled by the owner, expired) or with the request.
CREATE TABLE IF NOT EXISTS room_request_retry (
  request_id TEXT PRIMARY KEY NOT NULL,
  retry_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS room_request_retry_due ON room_request_retry(retry_at, request_id);
CREATE TRIGGER IF NOT EXISTS room_request_retry_left AFTER UPDATE OF state ON room_requests WHEN NEW.state<>'queued'
  BEGIN DELETE FROM room_request_retry WHERE request_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS room_request_retry_gone AFTER DELETE ON room_requests
  BEGIN DELETE FROM room_request_retry WHERE request_id=OLD.id; END;
CREATE TRIGGER IF NOT EXISTS room_request_owed_gone AFTER DELETE ON room_requests
  BEGIN DELETE FROM room_request_owed WHERE request_id=OLD.id; END;
-- The "dismissed by you" receipt the owner's dismissal owes the delegating bot (Astra r19): recorded in the same transaction as the dismissal and removed
-- only once the receipt has reached disk, so a receipt that could not be written is retried and never lost with the debt.
CREATE TABLE IF NOT EXISTS room_request_dismissal_receipts (request_id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS room_request_dismissal_gone AFTER DELETE ON room_requests
  BEGIN DELETE FROM room_request_dismissal_receipts WHERE request_id=OLD.id; END;
`;

export const BACKFILL_NAME = "room_request_owed_v1";
const BATCH = 2_000;

/** The rows startup and the sweep walk: only requests that owe a shared delivery. */
export const OWED_SHARED_SQL = "SELECT request_id AS id FROM room_request_owed WHERE kind='shared_delivery' ORDER BY request_id";
/** The finished owner sends boot may still have to fan out (pending set only); `has_children` rows were already fanned out. */
export const OWED_FANOUT_SQL = `SELECT o.id, o.group_id, COALESCE(o.target_thread_id, o.root_thread_id) AS thread, o.result_message_id, o.to_bot_id AS pin, o.outcome_note AS note,
  EXISTS (SELECT 1 FROM room_requests c WHERE c.root_id=o.id AND c.id <> o.id) AS has_children
  FROM room_request_owed w JOIN room_requests o ON o.id=w.request_id
  WHERE w.kind='fanout' ORDER BY o.created_at, o.id`;

/** Creates the table, the triggers and (once, in bounded batches) seeds them from rows that already exist. Idempotent:
 * on an existing 1.0.1 or 1.0.2 database the first start seeds, every later start reads one marker row and stops. */
export function initializeRoomRequestOwed(db: DatabaseSync, onProgress?: BackfillProgress, options: BackfillOptions = {}): void {
  // The classify trigger reads the provenance table: it exists before the trigger can ever fire.
  initializeSharedRequestProvenance(db);
  rebuildOwedTableIfStale(db);
  db.exec(OWED_DDL);
  // One blocking heartbeat spans the seeding and the reclassification, started only when work remains: a statement that blocks this thread
  // between the two phases must not leave the start-up note stale.
  const done = (name: string) => (db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(name) as { completed: number } | undefined)?.completed === 1;
  if (done(BACKFILL_NAME) && done(CLASSIFY_NAME)) return;
  let beat: BlockingHeartbeat | undefined;
  try { beat = options.heartbeat?.(); } catch { /* a heartbeat that cannot start leaves the work as it was */ }
  const inner: BackfillOptions = { ...options, heartbeat: undefined };
  try {
    backfillRoomRequestOwed(db, BATCH, onProgress, inner);
    reclassifyOwedV1(db, BATCH, onProgress, inner);
  } finally { try { beat?.end(); } catch { /* the note is only a note */ } }
}

export type BackfillProgress = (done: number, total: number) => void;
const REQUIRED_COLUMNS = ["id", "root_id", "verb", "state", "target_thread_id", "refusal", "result_message_id"];

/** The upgrade-time entry (database.ts, before the start-up screen is dismissed): seeds the owed set from an existing 1.0.1 history
 * under the upgrade reporter, one bounded batch at a time with `onProgress` between batches, so a heavy history shows progress
 * instead of a silent pause. A database with no room_requests table yet (a fresh install, or one from long before) is left to
 * `initializeProjectTables`, which finds nothing to backfill. Returns whether a backfill was needed. */
export function upgradeRoomRequestOwed(db: DatabaseSync, onProgress: BackfillProgress, options: BackfillOptions = {}): boolean {
  if (!tableExists(db, "room_requests")) return false;
  const columns = new Set((db.prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).map(c => c.name));
  if (!REQUIRED_COLUMNS.every(c => columns.has(c))) return false;
  // Existence and shape come BEFORE the marker: a missing marker table is "not seeded yet" (never an exception), and a completed
  // marker over a missing or older-shaped owed table is stale, so the table is rebuilt and the seeding runs here, under the reporter.
  rebuildOwedTableIfStale(db);
  const completed = (name: string) => tableExists(db, "room_request_backfills") && (db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(name) as { completed: number } | undefined)?.completed;
  if (completed(BACKFILL_NAME) && completed(CLASSIFY_NAME)) return false;
  initializeRoomRequestOwed(db, onProgress, options);
  return true;
}

const tableExists = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** The two-column owed table of the first build of this release (no provenance columns). Accepted, exactly, in an older archive. */
export const LEGACY_OWED_TABLE_DDL = `CREATE TABLE room_request_owed (
  kind TEXT NOT NULL CHECK(kind IN ('shared_delivery','fanout')),
  request_id TEXT NOT NULL,
  PRIMARY KEY(kind, request_id)) WITHOUT ROWID`;

/** The owed table of the first build of this release lacked the provenance columns. It is derived data, so it is rebuilt (and the
 * backfill record cleared so it is seeded again) rather than altered, which keeps one exact definition for snapshot inspection.
 * Runs whatever the marker says, on start-up and when a restore is prepared. A table that is absent has no completed seeding either. */
export function rebuildOwedTableIfStale(db: DatabaseSync): boolean {
  const columns = db.prepare("PRAGMA table_info(room_request_owed)").all() as Array<{ name: string }>;
  if (columns.length && columns.some(c => c.name === "destination_thread_id")) return false;
  // The triggers on room_requests write to this table, so it is recreated in the same step, never left absent.
  if (columns.length) db.exec(`DROP TABLE room_request_owed; ${OWED_TABLE_DDL}`);
  if (tableExists(db, "room_request_backfills")) db.prepare("DELETE FROM room_request_backfills WHERE name=?").run(BACKFILL_NAME);
  return true;
}

export interface BackfillOptions {
  /** Longest a slice of rows may take before the next progress note (default 500 ms). The slice shrinks to stay inside it. */
  sliceMs?: number;
  now?(): number;
  /** Starts the blocking heartbeat (server/memory/blocking-heartbeat.ts): a worker thread that keeps the start-up note moving while
   * this thread is inside one statement or commit that cannot report. Started before the first batch, ended (acknowledged) after the last. */
  heartbeat?(): BlockingHeartbeat;
}
const MIN_SLICE = 25;

/** Seeds the owed set from existing rows in time-bounded slices of at most `batch` rows, recording a cursor after each slice so a
 * crash resumes where it stopped and a finished backfill never runs again. A first note is written BEFORE any work, and one after
 * every slice, so liveness never depends on how fast the disk is: a slice that runs slow makes the next one smaller.
 * Returns the rows scanned (0 once completed). */
export function backfillRoomRequestOwed(db: DatabaseSync, batch = BATCH, onProgress?: BackfillProgress, options: BackfillOptions = {}): number {
  const mark = db.prepare("SELECT cursor, completed FROM room_request_backfills WHERE name=?").get(BACKFILL_NAME) as { cursor: number; completed: number } | undefined;
  if (mark?.completed) return 0;
  const now = options.now ?? Date.now, sliceMs = options.sliceMs ?? 500;
  let cursor = Number(mark?.cursor ?? 0), scanned = 0, step = Math.min(batch, 250);   // grows while slices are fast
  const total = onProgress ? Number((db.prepare("SELECT MAX(rowid) AS hi FROM room_requests").get() as { hi: number | null }).hi ?? 0) : 0;
  const note = (done: number) => { try { onProgress?.(done, total); } catch { /* a status note never decides the upgrade */ } };
  let beat: BlockingHeartbeat | undefined;
  try { beat = options.heartbeat?.(); } catch { /* a heartbeat that cannot start leaves the backfill as it was */ }
  try {
  note(cursor);
  for (;;) {
    const started = now();
    const last = db.prepare("SELECT MAX(rowid) AS hi, COUNT(*) AS n FROM (SELECT rowid FROM room_requests WHERE rowid>? ORDER BY rowid LIMIT ?)").get(cursor, step) as { hi: number | null; n: number };
    const nested = db.isTransaction;
    if (!nested) db.exec("BEGIN IMMEDIATE");
    let done = 0;
    try {
      if (last.hi !== null) {
        const where = (cond: string) => `rowid>? AND rowid<=? AND ${cond.replaceAll("NEW.", "")}`;
        db.prepare(`INSERT OR IGNORE INTO room_request_owed(kind, request_id) SELECT 'shared_delivery', id FROM room_requests WHERE ${where(SHARED_OWED_WHEN)}`).run(cursor, last.hi);
        db.prepare(`INSERT OR IGNORE INTO room_request_owed(kind, request_id) SELECT 'fanout', id FROM room_requests o WHERE ${where(FANOUT_OWED_WHEN)}
          AND NOT EXISTS (SELECT 1 FROM room_requests c WHERE c.root_id=o.id AND c.id <> o.id)`).run(cursor, last.hi);
        cursor = Number(last.hi); scanned += last.n;
      }
      done = last.hi === null || last.n < step ? 1 : 0;
      db.prepare("INSERT INTO room_request_backfills(name, cursor, completed) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor, completed=excluded.completed").run(BACKFILL_NAME, cursor, done);
      if (!nested) db.exec("COMMIT");
    } catch (error) { if (!nested) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
    // Progress is written after the commit and never decides the outcome: a failed note is not a failed backfill.
    note(done ? total : cursor);
    if (done) return scanned;
    const took = Math.max(1, now() - started);
    step = took > sliceMs ? Math.max(MIN_SLICE, Math.floor(step * sliceMs / took)) : took < sliceMs / 2 ? Math.min(batch, step * 2) : step;
  }
  } finally { try { beat?.end(); } catch { /* the note is only a note */ } }
}

export const CLASSIFY_NAME = "room_request_owed_classify_v1";

/** One-time reclassification of the owed rows an earlier build recorded with the broad rule (every finished non-wake request with a target
 * thread, which includes every channel turn). The classify trigger decides every row recorded from now on; this decides the rows already
 * there: a row without shared provenance is removed, the rest are stamped shared with their destination. A row an earlier build already stamped
 * shared=1 is kept as it is (that stamp is itself a durable fact). Runs in time-bounded slices keyed on `request_id` under the blocking
 * heartbeat, so liveness never depends on the size of the history; its cost follows the owed set, and the marker stops it from ever running again. */
export function reclassifyOwedV1(db: DatabaseSync, batch = BATCH, onProgress?: BackfillProgress, options: BackfillOptions = {}): number {
  const mark = db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(CLASSIFY_NAME) as { completed: number } | undefined;
  if (mark?.completed) return 0;
  const complete = () => db.prepare("INSERT INTO room_request_backfills(name, cursor, completed) VALUES(?,0,1) ON CONFLICT(name) DO UPDATE SET completed=1").run(CLASSIFY_NAME);
  if (!db.prepare("SELECT 1 AS x FROM room_request_owed WHERE kind='shared_delivery' AND shared IS NULL LIMIT 1").get()) { complete(); return 0; }
  const now = options.now ?? Date.now, sliceMs = options.sliceMs ?? 500;
  const total = onProgress ? Number((db.prepare("SELECT COUNT(*) AS n FROM room_request_owed WHERE kind='shared_delivery'").get() as { n: number }).n) : 0;
  const note = (done: number) => { try { onProgress?.(done, total); } catch { /* a status note never decides the upgrade */ } };
  let beat: BlockingHeartbeat | undefined;
  try { beat = options.heartbeat?.(); } catch { /* a heartbeat that cannot start leaves the work as it was */ }
  let after = "", visited = 0, step = Math.min(batch, 250);
  try {
    note(0);
    for (;;) {
      const started = now();
      const nested = db.isTransaction;
      if (!nested) db.exec("BEGIN IMMEDIATE");
      let last: string | undefined, seen = 0;
      try {
        const ids = db.prepare("SELECT request_id AS id FROM room_request_owed WHERE kind='shared_delivery' AND request_id>? ORDER BY request_id LIMIT ?").all(after, step) as Array<{ id: string }>;
        const provenance = db.prepare("SELECT 1 AS x FROM shared_request_provenance p JOIN room_requests r ON r.id=p.request_id WHERE p.request_id=? AND r.verb IN ('ask','message')");
        const drop = db.prepare("DELETE FROM room_request_owed WHERE kind='shared_delivery' AND request_id=? AND shared IS NULL");
        const stamp = db.prepare(`UPDATE room_request_owed SET shared=1, destination_thread_id=COALESCE(destination_thread_id,
          (SELECT COALESCE((SELECT t.target_thread_id FROM room_requests t WHERE t.id=r.parent_id), r.return_thread_id, r.root_thread_id) FROM room_requests r WHERE r.id=?))
          WHERE kind='shared_delivery' AND request_id=? AND shared IS NULL`);
        for (const { id } of ids) { if (provenance.get(id)) stamp.run(id, id); else drop.run(id); last = id; seen++; }
        if (seen < step) complete();
        if (!nested) db.exec("COMMIT");
      } catch (error) { if (!nested) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
      visited += seen;
      if (last !== undefined) after = last;
      note(visited);
      if (seen < step) return visited;
      const took = Math.max(1, now() - started);
      step = took > sliceMs ? Math.max(MIN_SLICE, Math.floor(step * sliceMs / took)) : took < sliceMs / 2 ? Math.min(batch, step * 2) : step;
    }
  } finally { try { beat?.end(); } catch { /* the note is only a note */ } }
}

/** The owed row is shared work by durable provenance (the classify trigger / v1 reclassification stamped it, or a provenance row exists), never by the
 * live registry. */
export function isOwedSharedByProvenance(db: DatabaseSync, requestId: string): boolean {
  return db.prepare("SELECT 1 AS x FROM shared_request_provenance p JOIN room_requests r ON r.id=p.request_id WHERE p.request_id=? AND r.verb IN ('ask','message')").get(requestId) !== undefined;
}

/** Clears a request from the owed set (delivered, found not shared, or a terminal fan-out decision). */
export function clearRoomRequestOwed(db: DatabaseSync, kind: RoomRequestOwedKind, requestId: string): void {
  db.prepare("DELETE FROM room_request_owed WHERE kind=? AND request_id=?").run(kind, requestId);
}

export interface OwedFanoutRow { id: string; group_id: string; thread: string; result_message_id: string; pin: string | null; note: string | null; has_children: number }

/** Walks the finished owner sends not yet fanned out and hands each to `handle` with a `decided` callback: calling it runs the
 * given work and clears the row in ONE transaction (child requests and the decision commit or roll back together); not calling it
 * leaves the row owed for the next start. Returns the rows visited, which follows pending work only. */
export function settleOwedFanouts(db: DatabaseSync, handle: (row: OwedFanoutRow, decided: (work?: () => void) => void) => void): number {
  const rows = db.prepare(OWED_FANOUT_SQL).all() as unknown as OwedFanoutRow[];
  for (const row of rows) handle(row, work => roomRequestsTransaction(db, () => { work?.(); clearRoomRequestOwed(db, "fanout", row.id); }));
  return rows.length;
}

export interface OwedSharedDeps<R extends { id: string }> {
  /** A restore holds the result: it stays owed until the owner releases it. */
  held(id: string): boolean;
  load(id: string): R | undefined;
  /** The thread the result is owed to (the requester's). */
  destination(request: R): string | undefined;
  /** A bot or channel owns this thread right now. */
  live(thread: string): boolean;
  /** The owner's deletion of this thread was recorded (owner-deletions.ts): a durable terminal decision. */
  deleted(thread: string): boolean;
  /** The delivery receipt already exists. */
  delivered(request: R, destination: string): boolean;
  deliver(request: R): void;
  now?(): number;
}

/** First retry after 30 s, doubling to an hour: an undecidable row costs one cheap check per window, never a scan. */
export const OWED_RETRY_FIRST_MS = 30_000;
export const OWED_RETRY_MAX_MS = 3_600_000;
/** How many due owed rows one pass reads. */
export const OWED_SETTLE_BATCH = 100;
/** A held row waits this long before it is looked at again (a release sets its `retry_at` to 0). */
export const OWED_HELD_RECHECK_MS = 3_600_000;
const retryDelay = (attempts: number) => Math.min(OWED_RETRY_MAX_MS, OWED_RETRY_FIRST_MS * 2 ** Math.min(attempts, 7));

interface OwedSharedRow { id: string; destination: string | null; attempts: number }

/** Q4: walks up to 100 owed shared rows whose `retry_at` is due, through `room_request_owed_due`. Every row in the set is shared work by durable
 * provenance (the database classified it when it was recorded), so nothing here asks the live registry whether it is shared. A row leaves the set
 * only on a confirmed delivery (the receipt exists, or delivery set it), a durable terminal decision (the request row is gone, the requester's
 * thread was deleted by the owner: tombstone) or the owner's dismissal. A destination the registry does not know yet, or a delivery that did not
 * go through, keeps the row (unresolved: parked, inactive) and retries later with backoff. A held row is pushed an hour out, and its release sets
 * it due. Returns the rows visited. */
export function settleOwedSharedResults<R extends { id: string }>(db: DatabaseSync, deps: OwedSharedDeps<R>): number {
  const now = (deps.now ?? Date.now)();
  const rows = db.prepare("SELECT request_id AS id, destination_thread_id AS destination, attempts FROM room_request_owed WHERE kind='shared_delivery' AND retry_at<=? ORDER BY retry_at, request_id LIMIT ?")
    .all(now, OWED_SETTLE_BATCH) as unknown as OwedSharedRow[];
  const keep = (row: OwedSharedRow) => db.prepare("UPDATE room_request_owed SET attempts=?, retry_at=? WHERE kind='shared_delivery' AND request_id=?").run(row.attempts + 1, now + retryDelay(row.attempts), row.id);
  // The debt is settled: the owed row goes and so does the restore hold that was keeping the result for the owner (nothing is left to release).
  const settle = (id: string) => { clearRoomRequestOwed(db, "shared_delivery", id); releaseRestoreHold(db, "shared_result", id); };
  for (const row of rows) {
    const request = deps.load(row.id);
    if (!request) { settle(row.id); continue; }
    const destination = row.destination ?? deps.destination(request);
    const live = Boolean(destination) && deps.live(destination!);
    // A recorded deletion settles the debt only when the destination is really gone. A conversation that is still live (the deletion was recorded but the
    // registry change never finished, for example a crash in between) is owed its result: the live destination wins over the tombstone.
    const gone = Boolean(destination) && !live && deps.deleted(destination!);
    if (gone) { settle(row.id); continue; }
    // A result a restore holds waits for the owner's release; it is looked at again in an hour (a release makes it due at once). Its terminal
    // conditions above are decided first, so a deleted requester never leaves a hold behind.
    if (deps.held(row.id)) { db.prepare("UPDATE room_request_owed SET retry_at=? WHERE kind='shared_delivery' AND request_id=?").run(now + OWED_HELD_RECHECK_MS, row.id); continue; }
    if (!destination || !live) { keep(row); continue; }
    if (row.destination !== destination) db.prepare("UPDATE room_request_owed SET destination_thread_id=? WHERE kind='shared_delivery' AND request_id=?").run(destination, row.id);
    if (deps.delivered(request, destination)) { settle(row.id); continue; }
    deps.deliver(request);
    // Delivery clears the row (the refusal marker fires the trigger); a delivery that returned without doing it is tried again later.
    if (db.prepare("SELECT 1 AS x FROM room_request_owed WHERE kind='shared_delivery' AND request_id=?").get(row.id)) keep(row);
  }
  return rows.length;
}

/** Makes the owed rows due now: one request (a release), or every row whose destination is this thread (a recorded tombstone settles it). */
export function wakeOwedSharedResults(db: DatabaseSync, by: { requestId: string } | { destinationThreadId: string }): number {
  if (!tableExists(db, "room_request_owed")) return 0;
  return "requestId" in by
    ? Number(db.prepare("UPDATE room_request_owed SET retry_at=0 WHERE kind='shared_delivery' AND request_id=? AND retry_at>0").run(by.requestId).changes)
    : Number(db.prepare("UPDATE room_request_owed SET retry_at=0 WHERE kind='shared_delivery' AND destination_thread_id=? AND retry_at>0").run(by.destinationThreadId).changes);
}

/** The owner dismisses a finished shared result that cannot be delivered (its requester is not available): the owed row is removed, the request is
 * stamped delivered so nothing records it again, and the "dismissed by you" receipt the delegating bot reads becomes a durable obligation, all in ONE
 * transaction. The receipt is then written (`receipt` answers whether it reached disk) and the obligation removed only when it did; one that failed stays
 * and is written again by `settleDismissalReceipts`, so a dismissal never leaves the bot without its receipt. False when the request owes nothing. */
export function dismissOwedSharedResult<R extends { id: string }>(db: DatabaseSync, id: string, deps: { load(id: string): R | undefined; receipt(request: R): boolean }): boolean {
  const dismissed = roomRequestsTransaction(db, () => {
    const owed = db.prepare("SELECT 1 AS x FROM room_request_owed WHERE kind='shared_delivery' AND request_id=?").get(id);
    const request = deps.load(id);
    if (!owed || !request) return false;
    db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=? AND state IN ('done','failed')").run(id);
    clearRoomRequestOwed(db, "shared_delivery", id);
    db.prepare("INSERT OR IGNORE INTO room_request_dismissal_receipts(request_id) VALUES(?)").run(id);
    return true;
  });
  if (dismissed) settleDismissalReceipts(db, deps);
  return dismissed;
}

/** Writes the dismissal receipts still owed (at most 100 per pass; the table holds only the ones that have not reached disk). A receipt whose request is gone
 * cannot be built and is dropped with it. Returns how many obligations remain. */
export function settleDismissalReceipts<R extends { id: string }>(db: DatabaseSync, deps: { load(id: string): R | undefined; receipt(request: R): boolean }): number {
  if (!tableExists(db, "room_request_dismissal_receipts")) return 0;
  const rows = db.prepare("SELECT request_id AS id FROM room_request_dismissal_receipts ORDER BY request_id LIMIT 100").all() as Array<{ id: string }>;
  let remaining = 0;
  for (const { id } of rows) {
    const request = deps.load(id);
    let written = !request;
    if (request) { try { written = deps.receipt(request); } catch { written = false; } }
    if (written) db.prepare("DELETE FROM room_request_dismissal_receipts WHERE request_id=?").run(id); else remaining++;
  }
  return remaining;
}
