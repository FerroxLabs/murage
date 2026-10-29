// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import { askTombstonePathFor, mergeIntoAskTombstone, mergeIntoTombstone, tombstonePathFor, type AskTombstoneRow, type TombstoneRow } from "./phones/revocation-tombstone.ts";
import { dropWriteRevisionTriggers } from "./app-write-revision.ts";
import { LEGACY_DELEGATIONS_FILE, syncDirectory } from "./pending-delegations-schema.ts";
import { runBranchChangeSlice } from "./memory/branch-change.ts";
import { SCHEMA_1_0_1, type Schema101Object } from "./schema-1.0.1.ts";

/** Every non-memory object Murage 1.0.2 adds to messages.db beyond what 1.0.1 reads. Frozen by name: a retry after a crash must drop exactly the
 * same set, and a 1.0.2 object that is not listed here fails server/pm-sends-102-r22.test.ts (the check against the real 1.0.1 inspector). Memory objects
 * (`memory_*`) are not here: the memory downgrade (server/memory/schema.ts) owns them. Dropped in this order: triggers, indexes, tables. */
export const APP_SCHEMA_102_ADDITIONS = Object.freeze({
  triggers: [
    "pending_delegation_live_pair",
    "pending_delegation_mark_request",
    "room_request_dismissal_gone",
    "room_request_mark_handoff",
    "room_request_mark_shared",
    "room_request_owed_classify",
    "room_request_owed_fanout_child",
    "room_request_owed_fanout_ins",
    "room_request_owed_fanout_upd",
    "room_request_owed_gone",
    "room_request_owed_shared_clear",
    "room_request_owed_shared_ins",
    "room_request_owed_shared_upd",
    "room_request_retry_gone",
    "room_request_retry_left",
    "shared_provenance_mark_request",
    "shared_ready_insert",
    "shared_ready_park",
    "shared_ready_state",
    "shared_ready_unpark",
    "turn_source_copy_d",
    "turn_source_copy_i",
    "turn_source_hold_r",
    "turn_source_hold_u",
  ],
  indexes: [
    // turnctx: indexed reads of the working context on tables 1.0.1 already has
    "artifacts_bot_date",
    "image_operations_awaiting",
    "image_operations_inflight_hash",
    "image_operations_pending",
    "image_operations_pending_hash",
    "keyed_card_family",
    "keyed_card_id",
    "messages_pending_browser_check",
    "output_publications_unannounced",
    "owner_sends_age",
    "owner_sends_open",
    "owner_sends_prunable",
    "owner_sends_send",
    "owner_sends_status",
    "pd_busy",
    "pd_due",
    "pd_from",
    "pd_held",
    "pd_phase",
    "pd_started",
    "pd_thread",
    "pd_thread_own",
    "pd_thread_shared",
    "pd_to",
    "project_work_items_assignee",
    "room_request_owed_due",
    "room_request_owed_request",
    "room_request_retry_due",
    "room_requests_fanout_held",
    "room_requests_owner_words",
    "room_requests_queued_wake",
    "room_requests_queued_deadline",
    "room_requests_runnable",
    "room_requests_runnable_bot",
    "room_requests_runnable_group",
    "room_requests_runnable_team",
    "room_requests_shared_team",
    "room_requests_shared_wake",
    "room_requests_team_dispatch",
    "seg_attach",
    "shared_ready_bot_wait",
    "shared_ready_live",
    "shared_ready_order",
    "shared_ready_seq",
    "shared_ready_thread",
    "turn_source_copies_copy",
    "turn_source_holds_thread",
    // bot email (server/email/email-store.ts), 1.0.9: made only when email is in use; dropped with their tables
    "email_events_received",
    "email_events_reference",
    "email_sends_due",
    "email_sends_generation",
    "email_sends_hash",
    "email_sends_inbox",
    "email_sends_replaces",
    "email_sends_settled",
  ],
  tables: [
    "app_write_revision",
    "attachment_name",
    "branch_change",
    "browser_check_pending",
    "direct_turn_inflight",
    "fill_pending",
    "held_notice_lines",
    "keyed_card",
    "line",
    "message_image",
    "msg_branch",
    "open_card",
    "owner_deleted_threads",
    "owner_sends",
    "pending_delegations",
    "pending_delegations_import",
    // 1.0.9 phone tools and share and ask (server/phones/): created only while the flag is on, so absent from most files
    "phone_ask_revocations",
    "phone_receipts",
    "phone_registrations",
    "phone_revocations",
    "project_card_delivery_owed",
    "restore_holds",
    "room_request_backfills",
    "room_request_dismissal_receipts",
    "room_request_owed",
    "room_request_retry",
    "room_request_status",
    "seg",
    "send_restore_generation",
    "shared_drain_sweep",
    "shared_ready_teams",
    "shared_request_events",
    "thread_key",
    "transcript_index_state",
    "turn_first",
    "turn_source_copies",
    "turn_source_holds",
    // bot email (server/email/email-store.ts), 1.0.9
    "email_bindings",
    "email_event_cursor",
    "email_events",
    "email_payloads",
    "email_policy_sync",
    "email_sends",
    "email_tombstones",
    "email_trust",
    "email_trusted",
  ],
});

/** Thrown (as the `code` of an Error) when open owner sends or restore holds exist: dropping their tables would lose the owner's words or delivery debt. */
export const DOWNGRADE_WORK_PENDING = "DOWNGRADE_WORK_PENDING";
/** Thrown when a finished card's result is still owed to its project room: the owed row and its payload are the only record of that delivery. */
export const DOWNGRADE_CARD_DELIVERY_OWED = "DOWNGRADE_CARD_DELIVERY_OWED";
export const CARD_DELIVERY_OWED_LINE = "Some card results have not reached their room yet. Reopen this version of Murage to retry delivery, then try again.";
/** Thrown (as the `code`) when hand-offs are held for the owner: going back would drop work the owner has not decided. */
export const DOWNGRADE_HANDOFFS_HELD = "DOWNGRADE_HANDOFFS_HELD";
export const INTERRUPTED_BY_REINSTALL = "interrupted by the reinstall";

export interface AppSchemaDowngrade {
  /** Handoffs written back to delegations.json for 1.0.1 to run (waiting ones, and ones whose start was cut short before the provider took the turn). */
  exported: number;
  /** Handoffs whose turn the provider had taken: they get an "interrupted by the reinstall" receipt and are not run again. */
  interrupted: number;
  /** Objects dropped, and manifest tables rebuilt. */
  dropped: number;
  rebuilt: number;
}

const has = (db: DatabaseSync, type: string, name: string): boolean => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type=? AND name=?").get(type, name));
const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const BUSY_FALLBACK_MS = 5 * 60_000;
const RECEIPTS_FILE = "delegation-receipts.json";
const MAX_RECEIPTS = 100;

/** The entry a 1.0.1 build reads for one queued handoff (`_loadPending`): the payload, ids and counters it validates, plus the busy and parked marks. */
function legacyEntry(row: Record<string, unknown>): Record<string, unknown> {
  let item: Record<string, unknown> = {};
  try { const parsed = JSON.parse(String(row.item)); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) item = parsed as Record<string, unknown>; } catch { /* an empty payload: the older loader drops an entry without a target and message */ }
  const entry: Record<string, unknown> = { ...item, id: row.id, toBotId: row.to_bot_id, ...(row.from_bot_id ? { fromBotId: row.from_bot_id } : {}) };
  if (row.phase === "busy") { entry.waitingOnBusy = true; entry.waitingSince = Number(row.retry_at ?? 0) - BUSY_FALLBACK_MS; }
  if (row.phase === "parked") { entry.unknownTarget = true; entry.unknownRetryAt = Number(row.retry_at ?? 0); }
  return entry;
}

function readJsonFile(path: string, dataDir: string, label: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");   // a read failure aborts the step with nothing changed
  try { return JSON.parse(text); } catch {
    // a leftover that cannot be parsed is kept as evidence, never merged and never dropped silently
    const quarantine = join(dataDir, "recovery-quarantine");
    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    renameSync(path, join(quarantine, `${label}.unreadable-${Date.now()}.json`));
    return undefined;
  }
}

/** What 1.0.2 holds that 1.0.1 cannot take back: the owner's words still waiting in a send, and results or requests a restore is keeping on hold. */
function pendingOwnerWork(db: DatabaseSync): number {
  let n = 0;
  if (has(db, "table", "owner_sends")) n += Number((db.prepare("SELECT COUNT(*) AS n FROM owner_sends WHERE NOT ((status IN ('started','delivered','cancelled') OR (status IN ('unconfirmed','failed') AND message_id IS NOT NULL)) AND text='')").get() as { n: number }).n);
  if (has(db, "table", "restore_holds")) n += Number((db.prepare("SELECT COUNT(*) AS n FROM restore_holds").get() as { n: number }).n);
  return n;
}

/** The 1.0.9 phone objects every older build lacks: the four phone tables and the owner_sends columns a phone's share or ask line uses. They leave first,
 * whatever the target (installation-memory-downgrade.ts), so a downgraded messages.db holds the text the older build creates and its restore check accepts.
 * A phone line still waiting to send is refused (dropping queue_only would turn a line that only fills the composer into one that sends). Idempotent. */
/** owner_sends as 1.0.2 creates it (the text its backup check and a fresh install hold): the table before 1.0.9's phone columns. */
const OWNER_SENDS_102_DDL = `CREATE TABLE owner_sends (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('bot','group')),
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  send_id TEXT,
  queue_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  text TEXT,
  prompt TEXT,
  reply_to_id TEXT,
  origin TEXT,
  mode TEXT,
  responder_id TEXT,
  existing_message_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notice TEXT,
  restore_held INTEGER NOT NULL DEFAULT 0,
  restore_gen TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  stop_gen TEXT,
  action_id TEXT,
  turn_id TEXT
)`;
export const PHONE_OWNER_SENDS_COLUMNS = Object.freeze(["via", "queue_only", "via_device", "attachments"]);
/** Refuses (DOWNGRADE_WORK_PENDING) while any phone line is still waiting to send: a row that carries any of owner_sends's phone columns and is not
 * yet delivered, cancelled or answered with its text gone. Reads only. The memory downgrade runs it before its first change, and the phone step runs it again. */
export function assertNoPendingPhoneWork(db: DatabaseSync): void {
  if (!has(db, "table", "owner_sends")) return;
  const present = new Set((db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map(column => column.name));
  const phone = [["queue_only", "queue_only=1"], ["via", "via IS NOT NULL"], ["via_device", "via_device IS NOT NULL"], ["attachments", "attachments IS NOT NULL"]]
    .filter(([name]) => present.has(name!)).map(([, test]) => test);
  if (phone.length === 0) return;
  const open = Number((db.prepare(`SELECT COUNT(*) AS n FROM owner_sends WHERE (${phone.join(" OR ")}) AND NOT ((status IN ('started','delivered','cancelled') OR (status IN ('unconfirmed','failed') AND message_id IS NOT NULL)) AND text='')`).get() as { n: number }).n);
  if (open > 0) throw Object.assign(new Error(`You have ${open} message${open === 1 ? "" : "s"} from a phone still waiting to send. Send or cancel ${open === 1 ? "it" : "them"}, then try again.`), { code: DOWNGRADE_WORK_PENDING });
}

export function downgradePhoneObjectsTo108(db: DatabaseSync, hooks: { beforeDrop?: (table: string) => void } = {}): { tables: number; columns: number } {
  let tables = 0, columns = 0;
  assertNoPendingPhoneWork(db);
  // The revocations are set aside beside messages.db before anything changes, so a phone removed while its jobs token was still on disk (or an ask
  // generation that was revoked) stays barred after a later upgrade. The files only grow, so writing them ahead of the transaction is harmless. A file
  // that cannot be written (or read, when one is already there) stops the downgrade with nothing changed.
  if (has(db, "table", "phone_revocations")) {
    const rows = db.prepare("SELECT device_id, revoked_at, reason FROM phone_revocations").all() as unknown as TombstoneRow[];
    const path = tombstonePathFor(db);
    if (rows.length > 0 && path !== null) mergeIntoTombstone(path, rows);
  }
  if (has(db, "table", "phone_ask_revocations")) {
    const rows = db.prepare("SELECT device_id, through FROM phone_ask_revocations").all() as unknown as AskTombstoneRow[];
    const path = askTombstonePathFor(db);
    if (rows.length > 0 && path !== null) mergeIntoAskTombstone(path, rows);
  }
  const present = has(db, "table", "owner_sends")
    ? (db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map(column => column.name) : [];
  const mine = PHONE_OWNER_SENDS_COLUMNS.filter(name => present.includes(name));
  // One transaction: the owner_sends rebuild and the four drops stand together or not at all, so a failure never leaves a file that lost its
  // revocation tables but is still 1.0.9. The two revocation tables go last.
  const outer = db.isTransaction;
  if (!outer) db.exec("BEGIN IMMEDIATE");
  else db.exec("SAVEPOINT phone_downgrade");
  try {
    if (mine.length > 0) {
      // DROP COLUMN would leave the definition's closing bracket joined to the last column, which is not the text 1.0.2 creates: the table is rebuilt
      // under its own name to 1.0.2's definition, every other column and row kept, and its indexes made again.
      const dependents = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name='owner_sends' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as Array<{ type: string; name: string; sql: string }>;
      for (const dependent of dependents) db.exec(`DROP ${dependent.type.toUpperCase()} ${quoted(dependent.name)}`);
      db.exec("ALTER TABLE owner_sends RENAME TO owner_sends__phone");
      db.exec(OWNER_SENDS_102_DDL);
      const kept = (db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map(column => column.name).filter(name => present.includes(name)).map(quoted).join(",");
      db.exec(`INSERT INTO owner_sends(${kept}) SELECT ${kept} FROM owner_sends__phone`);
      db.exec("DROP TABLE owner_sends__phone");
      for (const dependent of dependents) db.exec(dependent.sql);
      columns += mine.length;
    }
    for (const name of ["phone_receipts", "phone_registrations", "phone_ask_revocations", "phone_revocations"]) {
      if (!has(db, "table", name)) continue;
      hooks.beforeDrop?.(name);
      db.exec(`DROP TABLE ${quoted(name)}`);
      tables++;
    }
    db.exec(outer ? "RELEASE phone_downgrade" : "COMMIT");
  } catch (error) {
    try { db.exec(outer ? "ROLLBACK TO phone_downgrade; RELEASE phone_downgrade" : "ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
  return { tables, columns };
}

/** What the owner reads when going back is refused because a finished hand-off's reply is still on its way (the next start of Murage delivers it). */
export const OWED_REPLIES_LINE = "A teammate's reply is still on its way to its conversation. Open Murage once so it arrives, then try going back to the earlier version.";
/** Receipts that still owe their source conversation a line (delegations.ts: `reply` is kept until the line is written). Read only: an unreadable file is the
 * merge's business below. */
function owedHandoffReplies(dataDir: string): number {
  const path = join(dataDir, RECEIPTS_FILE);
  if (!existsSync(path)) return 0;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r === "object" && (r as { reply?: unknown }).reply !== undefined).length : 0;
  } catch { return 0; }
}
/** What the owner reads when going back is refused because a conversation switch could not be finished. */
export const BRANCH_CHANGE_LINE = "A change to an edited conversation is still being finished. Open Murage once and wait a minute, then try going back to the earlier version.";
/** What the owner reads when going back is refused because hand-offs are held for them. */
export const HELD_HANDOFFS_LINE = "Some hand-offs are waiting for you. Send again or dismiss them, then try going back to the earlier version.";
/** Hand-offs held for the owner: started rows with no start time (pd_held). */
function heldHandoffs(db: DatabaseSync): number {
  if (!has(db, "table", "pending_delegations")) return 0;
  return Number((db.prepare("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='started' AND started_at IS NULL").get() as { n: number }).n);
}

/** Brings the application tables of messages.db back to what Murage 1.0.1 accepts, for "Prepare to reinstall Murage 1.0.1" (before the memory step,
 * server/installation-memory-downgrade.ts). The database is the truth until the final commit:
 *  1. it refuses (DOWNGRADE_WORK_PENDING) while a send or a restore hold still keeps the owner's words or a delivery, or while a hand-off is held for the
 *     owner (Send again or Dismiss): nothing is touched;
 *  2. every handoff row is read: waiting ones, and ones whose start was cut short before the provider was handed the turn (any origin), are merged BY ID
 *     into delegations.json (a leftover entry with the same id is replaced); ones the provider took or may have taken (accepted, submitted, or held for
 *     the owner) are never exported as runnable: the first two get an "interrupted by the reinstall" receipt in delegation-receipts.json, merged by id,
 *     and their leftover entries are removed;
 *  3. one BEGIN IMMEDIATE: retained room-request marks reset, the requests of exported hand-offs put back at queued (where 1.0.1 expects a waiting
 *     hand-off's), old stand-in records deleted, every object in APP_SCHEMA_102_ADDITIONS dropped (triggers, indexes, tables), any 1.0.1 table whose
 *     columns differ rebuilt from its executable original definition (schema-1.0.1.ts `ddl`); COMMIT.
 * A crash anywhere leaves the rows (or the finished result): a retry recomputes the same files and the same drops. */
export function downgradeApplicationSchemaTo101(db: DatabaseSync, dataDir: string, hooks: { beforeCommit?: () => void; branchChangeProgress?: (slices: number) => void } = {}): AppSchemaDowngrade {
  const pending = pendingOwnerWork(db);
  if (pending > 0) {
    throw Object.assign(new Error(`You have ${pending} message${pending === 1 ? "" : "s"} still waiting to send or restore. Send or cancel ${pending === 1 ? "it" : "them"}, then try again.`), { code: DOWNGRADE_WORK_PENDING });
  }
  // a finished card's result still on its way to the project room: dropping the table would lose the delivery 1.0.1 has no way to resume
  if (has(db, "table", "project_card_delivery_owed") && Number((db.prepare("SELECT COUNT(*) AS n FROM project_card_delivery_owed").get() as { n: number }).n) > 0) {
    throw Object.assign(new Error(CARD_DELIVERY_OWED_LINE), { code: DOWNGRADE_CARD_DELIVERY_OWED });
  }
  // a hand-off held for the owner (Send again or Dismiss) has no form 1.0.1 can keep: it is never dropped, the owner decides it first
  if (heldHandoffs(db) > 0) throw Object.assign(new Error(HELD_HANDOFFS_LINE), { code: DOWNGRADE_HANDOFFS_HELD });
  // a finished hand-off whose reply is not yet in its conversation: 1.0.1 cannot deliver it, and its receipt is never replaced or cut while it owes the line
  if (owedHandoffReplies(dataDir) > 0) throw Object.assign(new Error(OWED_REPLIES_LINE), { code: DOWNGRADE_WORK_PENDING });
  // A long branch switch cut short (a crash) leaves memory sources half moved between the two branches, and dropping its queue would lose the place that
  // finishes it. Finish it first, a slice at a time (each slice its own short transaction); if a slice cannot run, nothing has been touched and the owner is told.
  if (has(db, "table", "branch_change")) {
    let slices = 0;
    try {
      while (runBranchChangeSlice(db)) hooks.branchChangeProgress?.(++slices);
    } catch {
      throw Object.assign(new Error(BRANCH_CHANGE_LINE), { code: DOWNGRADE_WORK_PENDING });
    }
  }
  let exported = 0, interrupted = 0;
  const exportedIds: string[] = [];
  if (has(db, "table", "pending_delegations")) {
    const file = join(dataDir, LEGACY_DELEGATIONS_FILE);
    const queue: Array<{ thread: string; entry: Record<string, unknown> }> = [];
    const gone = new Set<string>();   // ids the reinstalled build must not run
    const cut = new Map<string, Record<string, unknown>>();
    const receipts: Array<Record<string, unknown>> = [];
    const now = Date.now();
    for (const row of db.prepare("SELECT id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, accepted_turn_id, submitted_at, started_at, target_thread_id, turn_key, evidence_at FROM pending_delegations ORDER BY rowid").iterate() as Iterable<Record<string, unknown>>) {
      const id = String(row.id);
      if (row.phase === "started") {
        // held: a restart already told the owner it may have started, and a receipt exists. Accepted, or handed to the provider (with or without a sign
        // that it ran): it may have run, so it is never exported as runnable. Only a start that never reached the provider is exported (below).
        if (row.started_at === null || row.started_at === undefined) { gone.add(id); continue; }
        if (row.accepted_turn_id || row.submitted_at || row.evidence_at !== null) {
          gone.add(id);
          receipts.push({ id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, toBotName: row.to_bot_id, status: "failed", result: INTERRUPTED_BY_REINSTALL, finishedAt: now });
          interrupted++;
          continue;
        }
      }
      queue.push({ thread: String(row.source_thread_id), entry: legacyEntry(row) });
      cut.set(id, row);
      exportedIds.push(id);
    }
    // the file: what was already there stays (a leftover the import has not taken), minus what must not run, with these entries replacing same-id ones
    const out: Record<string, Array<Record<string, unknown>>> = {};
    const raw = readJsonFile(file, dataDir, "delegations");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [threadId, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const kept = list.filter((value) => value && typeof value === "object" && !gone.has(String((value as { id?: unknown }).id)) && !cut.has(String((value as { id?: unknown }).id)));
        if (kept.length) out[threadId] = kept as Array<Record<string, unknown>>;
      }
    }
    for (const { thread, entry } of queue) (out[thread] ??= []).push(entry);
    exported = queue.length;
    if (exported > 0 || gone.size > 0) {
      if (Object.keys(out).length || existsSync(file)) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeFileAtomic(file, JSON.stringify(out, null, 2), { mode: 0o600 });
      }
    }
    if (receipts.length) {
      const path = join(dataDir, RECEIPTS_FILE);
      const existing = readJsonFile(path, dataDir, "delegation-receipts");
      const ids = new Set(receipts.map((r) => r.id));
      const merged = [...receipts, ...(Array.isArray(existing) ? existing.filter((r) => r && typeof r === "object" && !ids.has((r as { id?: unknown }).id)) : [])].slice(0, MAX_RECEIPTS);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(path, JSON.stringify(merged, null, 2), { mode: 0o600 });
    }
    if (exported > 0 || gone.size > 0 || receipts.length) syncDirectory(dataDir);
  }
  const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined)?.foreign_keys ?? 0);
  if (foreignKeys) db.exec("PRAGMA foreign_keys=OFF");
  let dropped = 0, rebuilt = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (has(db, "table", "room_requests")) {
        // marks 1.0.2 wrote on requests that 1.0.1 would read as something else
        db.exec("UPDATE room_requests SET refusal=NULL WHERE refusal='retained_unresolved'");
        db.prepare("DELETE FROM room_requests WHERE group_id=?").run("owner-handoff");
        // A hand-off exported as runnable must find its request where 1.0.1 expects a waiting hand-off's: queued. One that 1.0.2 had dispatched
        // (running) would be marked unknown by 1.0.1's own boot sweep and the hand-off then cancelled without ever running.
        const requeue = db.prepare("UPDATE room_requests SET state='queued', dispatched_at=NULL, waiting_since=NULL WHERE id=? AND state IN ('running','waiting_owner')");
        for (const id of exportedIds) requeue.run(id);
      }
      // before transcript_index_state (the fill's place) is dropped: leave an index 1.0.1's own resume completes
      trimUnfinishedSearchFill(db);
      // the counter triggers (app-write-revision.ts) are temporary triggers of this connection that write app_write_revision: they go before it
      dropWriteRevisionTriggers(db);
      for (const [type, names] of [["trigger", APP_SCHEMA_102_ADDITIONS.triggers], ["index", APP_SCHEMA_102_ADDITIONS.indexes], ["table", APP_SCHEMA_102_ADDITIONS.tables]] as const) {
        for (const name of names) {
          if (!has(db, type, name)) continue;
          db.exec(`DROP ${type.toUpperCase()} ${quoted(name)}`);
          dropped++;
        }
      }
      rebuilt = rebuildDifferingTables(db);
      hooks.beforeCommit?.();
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already closed out */ } throw error; }
  } finally { if (foreignKeys) db.exec("PRAGMA foreign_keys=ON"); }
  return { exported, interrupted, dropped, rebuilt };
}

/** 1.0.1 resumes the search index from its highest indexed rowid (backfillMessageSearchIndex: MAX(messages_fts_docsize.id)) and trusts every
 * row below it. 1.0.2's background fill keeps its own place instead (transcript_index_state 'search_fts', `cursor`), because a live write of an
 * unfinished run indexes its row beyond the history not yet filled. Dropping that place with the entries above it kept would leave the rows
 * between the cursor and the highest live entry out of 1.0.1's index for good. So with the fill unfinished, the entries above its cursor are
 * deleted: 1.0.1 resumes at the cursor and indexes everything after it again, the live rows included. The deletion costs the live entries
 * written since the fill began (a rowid range of the index), never the history. Inside the caller's transaction. Returns the entries deleted. */
export function trimUnfinishedSearchFill(db: DatabaseSync): number {
  if (!has(db, "table", "transcript_index_state") || !has(db, "table", "messages_fts")) return 0;
  const state = db.prepare("SELECT done, cursor FROM transcript_index_state WHERE name='search_fts'").get() as { done: number; cursor: number } | undefined;
  if (!state || Number(state.done) !== 0) return 0;
  return Number(db.prepare("DELETE FROM messages_fts WHERE rowid > ?").run(Number(state.cursor)).changes);
}

const shapeOf = (db: DatabaseSync, table: string): string =>
  JSON.stringify((db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all() as Array<Record<string, unknown>>)
    .map((column) => `${column.name}:${String(column.type).toUpperCase()}:${column.notnull}:${column.dflt_value}:${column.pk}:${column.hidden}`));

/** A 1.0.1 table whose columns are not one of the shapes 1.0.1 accepts (a column 1.0.2 appended) is rebuilt to the 1.0.1 definition, keeping the
 * columns both have, and its indexes and triggers are created again. Inside the caller's transaction. */
function rebuildDifferingTables(db: DatabaseSync): number {
  let rebuilt = 0;
  const byName = new Map<string, Schema101Object>(SCHEMA_1_0_1.map((object) => [object.name, object]));
  for (const object of SCHEMA_1_0_1) {
    if (object.type !== "table" || object.name.startsWith("messages_fts") || !has(db, "table", object.name)) continue;
    const shape = shapeOf(db, object.name);
    if (object.columns.some((accepted) => JSON.stringify(accepted) === shape)) continue;
    // the definition as 1.0.1 wrote it (comments and line breaks intact), never the normalized comparison text
    const latest = object.ddl;
    if (!latest) continue;
    // only a table that GREW (every column of the 1.0.1 shape is still there, in order, with more after): anything else is not a 1.0.2 change and is left to the inspector to refuse
    const wanted = (JSON.parse(JSON.stringify(object.columns[0] ?? [])) as string[]).map((column) => column.split(":")[0]);
    const present = (db.prepare(`PRAGMA table_info(${quoted(object.name)})`).all() as Array<{ name: string }>).map((column) => column.name);
    if (!wanted.length || wanted.some((column, index) => present[index] !== column) || present.length <= wanted.length) continue;
    const dependents = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(object.name) as Array<{ type: string; name: string; sql: string }>;
    const keep = dependents.filter((dependent) => byName.has(dependent.name));
    for (const dependent of dependents) db.exec(`DROP ${dependent.type.toUpperCase()} ${quoted(dependent.name)}`);
    const old = `${object.name}__old`;
    db.exec(`ALTER TABLE ${quoted(object.name)} RENAME TO ${quoted(old)}`);
    db.exec(latest);
    const oldColumns = new Set((db.prepare(`PRAGMA table_info(${quoted(old)})`).all() as Array<{ name: string }>).map((column) => column.name));
    const common = (db.prepare(`PRAGMA table_info(${quoted(object.name)})`).all() as Array<{ name: string }>).map((column) => column.name).filter((column) => oldColumns.has(column));
    const list = common.map(quoted).join(",");
    db.exec(`INSERT INTO ${quoted(object.name)}(${list}) SELECT ${list} FROM ${quoted(old)}`);
    db.exec(`DROP TABLE ${quoted(old)}`);
    for (const dependent of keep) db.exec(dependent.sql);
    rebuilt++;
  }
  return rebuilt;
}
