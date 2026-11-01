// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { botDeleted, ownerDeletedThread } from "./owner-deletions.ts";
import type { BlockingHeartbeat } from "./memory/blocking-heartbeat.ts";

/** Handoffs a bot queued for a peer that have not finished yet (server/delegations.ts), one row each.
 * A change to one handoff writes that one row; the due ones are found by index, so the cost of a pass follows the work it does and never the size
 * of the backlog. Queue order is rowid order. `item` holds the validated payload plus its counters; the columns hold what the indexes, the retry
 * timer and the exactly-once rule need:
 *  - phase `fresh`: runs when its source turn settles (retry_at is NULL);
 *  - phase `busy`: waits for a busy teammate; retry_at is when the fallback timer looks anyway;
 *  - phase `parked`: its target or sender is not in the registry yet; retry_at is the next look;
 *  - phase `started`: its turn began. The row stays until the turn's receipt is written, and it is what decides, after a restart, whether the
 *    turn ran (accepted_turn_id), may have been handed to the provider (submitted_at, committed just BEFORE the submit call), left only its prompt
 *    (turn_key names that prompt in target_thread_id) or never began. Nothing else records it. A started row with no started_at is HELD: a restart
 *    found it submitted with no sign it ran, so it does not run again; the owner reads a receipt and may send it again as a new hand-off.
 * `origin` says who owns the request side: `owner` (queued from the owner's conversation: this row is all there is), `room` (a room request of
 * the same id mirrors it), `shared` (shared work of the same id runs it) or `legacy` (imported from delegations.json).
 * `evidence_at` is when the engine's reply to the hand-off's prompt was stored (server/handoff-evidence.ts): set in the same transaction as that reply, never inferred later.
 * `held_notice_lines` lists the owner-facing line of every held hand-off (message id, hand-off id, conversation): written in the transaction that creates the line and
 * deleted in the one that releases it, so a line whose hand-off is gone is found by walking this table and nothing else.
 * Created by the database initializer and registered in the installation snapshot's reference schema. */
const PENDING_COLUMNS = `id TEXT PRIMARY KEY NOT NULL,
  source_thread_id TEXT NOT NULL,
  to_bot_id TEXT NOT NULL,
  from_bot_id TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('fresh','busy','parked','started')),
  retry_at INTEGER,
  item TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('owner','room','shared','legacy')),
  target_thread_id TEXT,
  turn_key TEXT,
  started_at INTEGER,
  accepted_turn_id TEXT,
  start_attempts INTEGER,
  submitted_at INTEGER,
  evidence_at INTEGER`;
const PENDING_INDEXES = `CREATE INDEX IF NOT EXISTS pd_thread ON pending_delegations(source_thread_id);
CREATE INDEX IF NOT EXISTS pd_due ON pending_delegations(retry_at, id) WHERE retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pd_phase ON pending_delegations(phase, source_thread_id);
CREATE INDEX IF NOT EXISTS pd_to ON pending_delegations(to_bot_id, phase);
CREATE INDEX IF NOT EXISTS pd_from ON pending_delegations(from_bot_id, phase);
CREATE INDEX IF NOT EXISTS pd_busy ON pending_delegations(to_bot_id, source_thread_id) WHERE phase='busy';
CREATE INDEX IF NOT EXISTS pd_started ON pending_delegations(started_at) WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pd_held ON pending_delegations(id) WHERE phase='started' AND started_at IS NULL;
CREATE INDEX IF NOT EXISTS pd_thread_own ON pending_delegations(source_thread_id) WHERE phase<>'started' AND origin<>'shared';
CREATE INDEX IF NOT EXISTS pd_thread_shared ON pending_delegations(source_thread_id) WHERE phase<>'started' AND origin='shared';`;
export const PENDING_DELEGATION_INDEXES = ["pd_thread", "pd_due", "pd_phase", "pd_to", "pd_from", "pd_busy", "pd_started", "pd_held", "pd_thread_own", "pd_thread_shared"] as const;

/** The idempotency key of a hand-off's prompt: the id of the user message in the target thread. Stable for the life of the row, and a legal message id. */
export function delegationTurnKey(id: string): string {
  return /^[\w-]{1,150}$/.test(id) ? `dlg-${id}` : `dlg-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

/** Who owns the request side of a hand-off, found from the records that exist for its id: a room request (`room`), shared work (`shared`), or none
 * (`legacy`: nothing but the queue row). The one-time stand-in records of the development builds do not count. */
export function resolveHandoffOrigin(db: DatabaseSync, id: string): "room" | "shared" | "legacy" {
  const has = (name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (!has("room_requests")) return "legacy";
  const request = db.prepare("SELECT group_id FROM room_requests WHERE id=?").get(id) as { group_id: string } | undefined;
  if (!request || request.group_id === OLD_OWNER_HANDOFF_GROUP) return "legacy";
  if (has("shared_request_provenance") && db.prepare("SELECT 1 AS x FROM shared_request_provenance WHERE request_id=?").get(id)) return "shared";
  return "room";
}

const CARRIED_COLUMNS = ["id", "source_thread_id", "to_bot_id", "from_bot_id", "phase", "retry_at", "item", "origin", "target_thread_id", "turn_key", "started_at", "accepted_turn_id", "start_attempts", "submitted_at", "evidence_at"] as const;

export function initializePendingDelegations(db: DatabaseSync): void {
  const existing = db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name='pending_delegations'").get();
  const present = existing ? (db.prepare("PRAGMA table_info(pending_delegations)").all() as Array<{ name: string }>).map((column) => column.name) : [];
  if (existing && (!present.includes("submitted_at") || !present.includes("evidence_at"))) {
    // The table of an earlier development build (before the row owned its execution state, or before it recorded the submit) was never released:
    // rebuilt once, every column it has kept. A row with no recorded owner is matched to the room request or shared work of the same id.
    const nested = db.isTransaction;
    db.exec(nested ? "SAVEPOINT pd_rebuild" : "BEGIN IMMEDIATE");
    try {
      for (const name of PENDING_DELEGATION_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`);
      // a trigger on another table that names this one would follow the rename to the old table: it goes, and is made again below
      for (const name of HANDOFF_MARK_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec("ALTER TABLE pending_delegations RENAME TO pending_delegations_old");
      db.exec(`CREATE TABLE pending_delegations (${PENDING_COLUMNS})`);
      const read = CARRIED_COLUMNS.filter((column) => present.includes(column));
      const copy = db.prepare(`INSERT INTO pending_delegations(${CARRIED_COLUMNS.join(", ")}) VALUES(${CARRIED_COLUMNS.map(() => "?").join(",")})`);
      for (const row of db.prepare(`SELECT ${read.join(", ")} FROM pending_delegations_old ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
        const known = typeof row.origin === "string" ? row.origin : "legacy";
        const origin = known === "legacy" ? resolveHandoffOrigin(db, String(row.id)) : known;
        copy.run(...CARRIED_COLUMNS.map((column) => (column === "origin" ? origin : column === "turn_key" ? ((row.turn_key as string | null | undefined) ?? delegationTurnKey(String(row.id))) : ((row[column] as never) ?? null))) as never[]);
      }
      db.exec("DROP TABLE pending_delegations_old");
      db.exec(nested ? "RELEASE pd_rebuild" : "COMMIT");
    } catch (error) { try { db.exec(nested ? "ROLLBACK TO pd_rebuild; RELEASE pd_rebuild" : "ROLLBACK"); } catch { /* already closed out */ } throw error; }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS pending_delegations (${PENDING_COLUMNS});
${PENDING_INDEXES}
CREATE TABLE IF NOT EXISTS pending_delegations_import (version INTEGER PRIMARY KEY NOT NULL);
CREATE TABLE IF NOT EXISTS held_notice_lines (message_id TEXT PRIMARY KEY NOT NULL, delegation_id TEXT NOT NULL, source_thread_id TEXT NOT NULL);`);
  ensureHandoffPairGuard(db);
}

/** A hand-off's row that has not started is never deleted while the request of the same id is live (a started row's request is already running its turn, and the
 * boot sweep ends it: it can no longer be started by anyone). The ways that end a hand-off end the request in the same transaction
 * (delegations.ts settleHandoffPair); this is the backstop under all of them, in the database: a delete that would leave a live request without its hand-off
 * (a plain shared request would then start as if it were not one) aborts. Created whenever both tables exist (they come up in either order). */
export const HANDOFF_PAIR_TRIGGER = "pending_delegation_live_pair";
export function ensureHandoffPairGuard(db: DatabaseSync): void {
  const has = (name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (!has("pending_delegations") || !has("room_requests")) return;
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${HANDOFF_PAIR_TRIGGER} BEFORE DELETE ON pending_delegations
WHEN OLD.phase<>'started' AND EXISTS (SELECT 1 FROM room_requests WHERE id=OLD.id AND group_id<>'${OLD_OWNER_HANDOFF_GROUP}' AND state IN ('queued','running','waiting_owner','waiting_bot'))
BEGIN SELECT RAISE(ABORT, 'HANDOFF_PAIR_LIVE: a hand-off is not removed while its request is live'); END;`);
  // The request of a hand-off carries that identity on its own row (room_requests.handoff), set by the database whichever of the two records is written
  // first, so it outlives the hand-off's row and its receipt for as long as the request exists.
  const requestColumns = (db.prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!requestColumns.includes("handoff")) return;
  const marked = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='trigger' AND name=?").get(HANDOFF_MARK_TRIGGERS[0]));
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${HANDOFF_MARK_TRIGGERS[0]} AFTER INSERT ON pending_delegations
BEGIN UPDATE room_requests SET handoff=1 WHERE id=NEW.id AND handoff IS NOT 1; END;
CREATE TRIGGER IF NOT EXISTS ${HANDOFF_MARK_TRIGGERS[1]} AFTER INSERT ON room_requests
WHEN EXISTS (SELECT 1 FROM pending_delegations WHERE id=NEW.id)
BEGIN UPDATE room_requests SET handoff=1 WHERE id=NEW.id; END;`);
  // the requests of the hand-offs already queued when the mark arrived
  if (!marked) db.exec("UPDATE room_requests SET handoff=1 WHERE handoff IS NULL AND id IN (SELECT id FROM pending_delegations)");
}
export const HANDOFF_MARK_TRIGGERS = ["pending_delegation_mark_request", "room_request_mark_handoff"] as const;

/** One row ready to insert, produced from a legacy delegations.json entry. */
export interface PendingDelegationRow {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  fromBotId: string | null;
  phase: "fresh" | "busy" | "parked";
  retryAt: number | null;
  item: string;
  origin?: "owner" | "room" | "shared" | "legacy";
}
/** delegations.ts registers how a legacy entry becomes a row (it owns the validation, and importing it here would be a cycle). */
let legacyParser: ((threadId: string, value: unknown) => PendingDelegationRow | null) | undefined;
export function registerLegacyDelegationParser(parse: (threadId: string, value: unknown) => PendingDelegationRow | null): void { legacyParser = parse; }

export const LEGACY_DELEGATIONS_FILE = "delegations.json";
const IMPORT_VERSION = 1;
let lastImportSkipped = 0;
/** How many entries the last import left out because the owner had deleted their conversation or bot. */
export function legacyImportSkipped(): number { return lastImportSkipped; }

export interface LegacyImportOptions {
  /** Keeps the start-up note moving while the file is read and written. */
  heartbeat?: () => BlockingHeartbeat;
  dataDir?: string;
  /** Test seam: replaces the file read so a test can make one read fail. */
  readFile?: (path: string) => string;
  /** Test seams for a crash between the steps. */
  beforeCommit?: () => void;
  afterCommit?: () => void;
}

export function syncDirectory(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* a platform that cannot sync a directory */ }
}

/** Moves the queue a 1.0.1 build (or an earlier 1.0.2 build) kept in delegations.json into the table, exactly once.
 * (1) the marker is set: only a leftover file is removed. (2) otherwise the file is parsed and every entry validated.
 * (3) one transaction inserts them in file order and sets the marker. (4) after the commit the file is removed.
 * A crash before the commit redoes the import; after it, the next start only removes the file. A file that reads but is not a queue
 * (corrupt JSON) is moved to recovery-quarantine and the marker set; a file that cannot be read stays, unmarked, for the next try. Returns how many handoffs were imported. */
export function importLegacyDelegations(db: DatabaseSync, options: LegacyImportOptions = {}): number {
  const dir = options.dataDir ?? DATA_DIR;
  const file = join(dir, LEGACY_DELEGATIONS_FILE);
  const imported = Boolean(db.prepare("SELECT 1 AS x FROM pending_delegations_import WHERE version=?").get(IMPORT_VERSION));
  if (imported) {
    if (existsSync(file)) { try { unlinkSync(file); syncDirectory(dir); } catch { /* removed on the next start */ } }
    return 0;
  }
  if (!legacyParser) return 0;   // delegations.ts is not loaded yet: its own boot call imports instead
  const mark = () => db.prepare("INSERT OR IGNORE INTO pending_delegations_import(version) VALUES(?)").run(IMPORT_VERSION);
  if (!existsSync(file)) { mark(); return 0; }
  let beat: BlockingHeartbeat | undefined;
  try { beat = options.heartbeat?.(); } catch { /* a heartbeat that cannot start leaves the work as it was */ }
  try {
    let raw: unknown;
    let text: string;
    // A read that fails (a busy or locked file, a permission slip) says nothing about the contents: the file stays,
    // the marker stays unset and the next boot or call reads it again. Only a clean read of bad JSON is quarantined.
    try { text = (options.readFile ?? ((path: string) => readFileSync(path, "utf8")))(file); } catch { return 0; }
    try { raw = JSON.parse(text); } catch { raw = undefined; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      // unreadable or not a queue: kept as evidence, never silently dropped
      const quarantine = join(dir, "recovery-quarantine");
      mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      renameSync(file, join(quarantine, `delegations.unreadable-${Date.now()}.json`));
      mark(); syncDirectory(dir);
      return 0;
    }
    const insert = db.prepare("INSERT OR IGNORE INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key) VALUES(?,?,?,?,?,?,?,?,?)");
    let count = 0;
    let skipped = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [threadId, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        for (const value of list) {
          const row = legacyParser(threadId, value);
          if (!row) continue;
          // The owner's recorded deletion of the source conversation, of the sender or of the target is decided here too: a file read late
          // (a 1.0.1 build that ran after the deletion, a delayed first import) never brings back work for something the owner deleted.
          if (ownerDeletedThread(db, row.sourceThreadId) || (row.fromBotId !== null && botDeleted(db, row.fromBotId)) || botDeleted(db, row.toBotId)) { skipped++; continue; }
          if (insert.run(row.id, row.sourceThreadId, row.toBotId, row.fromBotId, row.phase, row.retryAt, row.item, row.origin && row.origin !== "legacy" ? row.origin : resolveHandoffOrigin(db, row.id), delegationTurnKey(row.id)).changes) count++;
        }
      }
      mark();
      options.beforeCommit?.();
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already closed out */ } throw error; }
    lastImportSkipped = skipped;
    if (skipped > 0) console.log(`delegations: ${skipped} queued handoff(s) of deleted conversations or bots were not imported`);
    options.afterCommit?.();
    try { unlinkSync(file); syncDirectory(dirname(file)); } catch { /* removed on the next start */ }
    return count;
  } finally { try { beat?.end(); } catch { /* the note is only a note */ } }
}

/** The queue in the shape delegations.json had: source thread to its handoffs in queue order, each with its payload, ids, phase and retry time.
 * Evidence for a restore (recovery-quarantine) and what a test or a diagnostic reads; nothing reads it back as the queue. */
export function queuedDelegationsByThread(db: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  if (!db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name='pending_delegations'").get()) return out;
  for (const row of db.prepare("SELECT id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item FROM pending_delegations ORDER BY rowid").all() as Array<Record<string, unknown>>) {
    let item: unknown = {};
    try { item = JSON.parse(String(row.item)); } catch { /* kept as the empty object; the row is still listed */ }
    (out[String(row.source_thread_id)] ??= []).push({ ...(item as object), id: row.id, toBotId: row.to_bot_id, ...(row.from_bot_id ? { fromBotId: row.from_bot_id } : {}), phase: row.phase, retryAt: row.retry_at,
      ...(row.phase === "busy" ? { waitingOnBusy: true } : {}), ...(row.phase === "parked" ? { unknownTarget: true, unknownRetryAt: row.retry_at } : {}) });
  }
  return out;
}

/** The group id the durable record of an owner-conversation handoff carried in the development builds before the queue row owned its own state.
 * No code writes or reads such a record any more; this is only the name the one-time cleanup finds them by. */
export const OLD_OWNER_HANDOFF_GROUP = "owner-handoff";

/** One-time cleanup of the stand-in records the development builds kept for owner-conversation handoffs. A record that had left `queued` means the
 * handoff's turn had begun (or ended): its row becomes a started, accepted one, so the next start only receipts it as interrupted and never runs it
 * again. A queued record just goes (its row is still waiting). Found by `room_requests_group_state`, 500 per transaction; a database with
 * none of them does one indexed probe. Returns how many records were removed. */
/** Rows one migration page takes (one transaction). */
export const OWNER_MIGRATION_PAGE = 500;
/** One page of the clean-up: at most OWNER_MIGRATION_PAGE stand-in records, in one transaction. Returns how many it removed; fewer than a full page means the clean-up is done. */
export function migrateOwnerHandoffPage(db: DatabaseSync): number {
  const has = (name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (!has("room_requests") || !has("pending_delegations")) return 0;
  const rows = db.prepare(`SELECT id, state FROM room_requests WHERE group_id=? LIMIT ${OWNER_MIGRATION_PAGE}`).all(OLD_OWNER_HANDOFF_GROUP) as Array<{ id: string; state: string }>;
  if (!rows.length) return 0;
  const stamp = db.prepare("UPDATE pending_delegations SET phase='started', started_at=?, retry_at=NULL, accepted_turn_id=COALESCE(accepted_turn_id,'migrated'), start_attempts=COALESCE(start_attempts,1) WHERE id=? AND phase<>'started'");
  const forget = db.prepare("DELETE FROM room_requests WHERE id=? AND group_id=?");
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT pd_migrate" : "BEGIN IMMEDIATE");
  try {
    const now = Date.now();
    for (const row of rows) {
      if (row.state !== "queued") stamp.run(now, row.id);
      forget.run(row.id, OLD_OWNER_HANDOFF_GROUP);
    }
    db.exec(nested ? "RELEASE pd_migrate" : "COMMIT");
  } catch (error) { try { db.exec(nested ? "ROLLBACK TO pd_migrate; RELEASE pd_migrate" : "ROLLBACK"); } catch { /* already closed out */ } throw error; }
  return rows.length;
}
/** The whole clean-up at once (every page, one after the other). For tests and one-off tools; the server runs it through runOwnerHandoffMigration, which gives the
 * event loop its turn between pages. Returns how many records were removed. */
export function migrateOwnerHandoffRecords(db: DatabaseSync): number {
  let removed = 0;
  for (;;) { const n = migrateOwnerHandoffPage(db); removed += n; if (n < OWNER_MIGRATION_PAGE) return removed; }
}


export { HANDOFF_EVIDENCE_ROWS } from "./handoff-evidence.ts";
/** Whether the provider ran a hand-off's turn, from the hand-off's own row: the provider's acceptance of the turn is recorded (`accepted_turn_id`), or the
 * engine's reply to the hand-off's prompt was stored (`evidence_at`, written in the same transaction as that reply: server/handoff-evidence.ts). Nothing
 * here looks at row order, timestamps or the text of any line, and a line Murage wrote itself (a dispatch error, a status line, a "Messaged @" chip) carries
 * no provider turn id, so it is never evidence. */
export function handoffOutputExists(db: DatabaseSync, id: string): boolean {
  const row = db.prepare("SELECT accepted_turn_id, evidence_at FROM pending_delegations WHERE id=?").get(id) as { accepted_turn_id: string | null; evidence_at: number | null } | undefined;
  return row !== undefined && (Boolean(row.accepted_turn_id) || row.evidence_at !== null);
}

// ── the one-time cleanup runs until it succeeds ─────────────────────────────────────
let ownerRecordsPending = false;
let ownerRetryTimer: ReturnType<typeof setTimeout> | undefined;
let ownerRetryDelay = 1_000;
const admissionListeners = new Set<() => void>();
/** True while the cleanup of the old stand-in records has not succeeded: no hand-off is admitted, started or drained meanwhile (a stand-in
 * record that is still running means its hand-off may already have run). */
export function ownerRecordMigrationPending(): boolean { return ownerRecordsPending; }
/** Boot settling of the started hand-offs reads them a page at a time; nothing is admitted until the last page is done (settle before drain). The server's
 * first shutdown step holds too, for good: a closing server starts nothing and the next one settles what is left. */
let reconcileHolds = 0;
export function holdForReconcile(): () => void {
  reconcileHolds++;
  let released = false;
  return () => { if (!released) { released = true; reconcileHolds = Math.max(0, reconcileHolds - 1); } };
}
/** The one gate every dispatch asks (server/handoff-dispatch.ts gate): closed while the owner-record migration is pending, the boot settling is still paging or the server is closing. */
export function delegationAdmissionHeld(): boolean { return ownerRecordsPending || reconcileHolds > 0; }
/** Called once the held admission opens (the cleanup succeeded after an earlier failure): the server settles and drains what waited. */
export function onDelegationAdmissionOpen(listener: () => void): void { admissionListeners.add(listener); }
/** Test seam: forget the retry state and the listeners. */
export function _resetOwnerMigration(): void { ownerRecordsPending = false; reconcileHolds = 0; if (ownerRetryTimer) clearTimeout(ownerRetryTimer); ownerRetryTimer = undefined; ownerRetryDelay = 1_000; admissionListeners.clear(); }

/** Runs the cleanup, one page (OWNER_MIGRATION_PAGE records) per event-loop pass: a clean-up that fits one page is finished when this returns; a longer one holds
 * admission (as a failed one does) and carries on after the event loop has had its turn, opening admission when the last page is done. On failure admission stays
 * held and the cleanup is tried again with a growing wait (1 s up to 60 s); the next start tries again too. Returns true when the clean-up is complete. */
export function runOwnerHandoffMigration(db: DatabaseSync): boolean {
  let removed: number;
  try {
    removed = migrateOwnerHandoffPage(db);
  } catch (error) {
    const first = !ownerRecordsPending;
    ownerRecordsPending = true;
    if (first) console.warn(`[delegations] old handoff records: ${error instanceof Error ? error.message : String(error)}; handoffs wait and the cleanup is tried again`);
    if (ownerRetryTimer) clearTimeout(ownerRetryTimer);
    ownerRetryTimer = setTimeout(() => {
      ownerRetryTimer = undefined;
      try { db.prepare("SELECT 1").get(); } catch { return; }   // the database was closed: the next start tries again
      runOwnerHandoffMigration(db);
    }, ownerRetryDelay);
    ownerRetryTimer.unref?.();
    ownerRetryDelay = Math.min(60_000, ownerRetryDelay * 2);
    return false;
  }
  if (removed >= OWNER_MIGRATION_PAGE) {
    // a full page: there may be more. Admission is held until the last page is done, and the next page is a pass of its own.
    ownerRecordsPending = true;
    if (ownerRetryTimer) { clearTimeout(ownerRetryTimer); ownerRetryTimer = undefined; }
    setImmediate(() => {
      try { db.prepare("SELECT 1").get(); } catch { return; }   // the database was closed: the next start tries again
      runOwnerHandoffMigration(db);
    });
    return false;
  }
  const wasHeld = ownerRecordsPending;
  ownerRecordsPending = false; ownerRetryDelay = 1_000;
  if (ownerRetryTimer) { clearTimeout(ownerRetryTimer); ownerRetryTimer = undefined; }
  if (wasHeld) for (const listener of admissionListeners) { try { listener(); } catch (error) { console.error("delegations: admission listener failed", error); } }
  return true;
}
