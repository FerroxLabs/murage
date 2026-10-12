// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import { LEGACY_DELEGATIONS_FILE, syncDirectory } from "./pending-delegations-schema.ts";
import { SCHEMA_1_0_1, type Schema101Object } from "./schema-1.0.1.ts";

/** Every non-memory object Murage 1.0.2 adds to messages.db beyond what 1.0.1 reads. Frozen by name: a retry after a crash must drop exactly the
 * same set, and a 1.0.2 object that is not listed here fails server/pm-sends-102-r22.test.ts (the check against the real 1.0.1 inspector). Memory objects
 * (`memory_*`) are not here: the memory downgrade (server/memory/schema.ts) owns them. Dropped in this order: triggers, indexes, tables. */
export const APP_SCHEMA_102_ADDITIONS = Object.freeze({
  triggers: [
    "pending_delegation_live_pair",
    "room_request_dismissal_gone",
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
  ],
  indexes: [
    "card_branch_leaf",
    "image_operations_awaiting",
    "image_operations_inflight_hash",
    "image_operations_pending",
    "image_operations_pending_hash",
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
    "pd_to",
    "room_request_owed_due",
    "room_request_owed_request",
    "room_request_retry_due",
    "room_requests_fanout_held",
    "room_requests_owner_words",
    "room_requests_queued_deadline",
    "room_requests_runnable",
    "room_requests_runnable_bot",
    "room_requests_runnable_group",
    "room_requests_runnable_team",
    "room_requests_team_dispatch",
  ],
  tables: [
    "branch_walk",
    "card_branch",
    "held_notice_lines",
    "open_card",
    "owner_deleted_threads",
    "owner_sends",
    "pending_delegations",
    "pending_delegations_import",
    "project_card_delivery_owed",
    "restore_holds",
    "room_request_backfills",
    "room_request_dismissal_receipts",
    "room_request_owed",
    "room_request_retry",
    "send_restore_generation",
    "shared_request_events",
    "transcript_index_state",
    "turn_first",
  ],
});

/** Thrown (as the `code` of an Error) when open owner sends or restore holds exist: dropping their tables would lose the owner's words or delivery debt. */
export const DOWNGRADE_WORK_PENDING = "DOWNGRADE_WORK_PENDING";
/** Thrown when a finished card's result is still owed to its project room: the owed row and its payload are the only record of that delivery. */
export const DOWNGRADE_CARD_DELIVERY_OWED = "DOWNGRADE_CARD_DELIVERY_OWED";
export const CARD_DELIVERY_OWED_LINE = "Some card results have not reached their room yet. Reopen this version of Murage to retry delivery, then try again.";
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

/** Brings the application tables of messages.db back to what Murage 1.0.1 accepts, for "Prepare to reinstall Murage 1.0.1" (before the memory step,
 * server/installation-memory-downgrade.ts). The database is the truth until the final commit:
 *  1. it refuses (DOWNGRADE_WORK_PENDING) while a send or a restore hold still keeps the owner's words or a delivery: nothing is touched;
 *  2. every handoff row is read: waiting ones, and ones whose start was cut short before the provider was handed the turn (any origin), are merged BY ID
 *     into delegations.json (a leftover entry with the same id is replaced); ones the provider took or may have taken (accepted, submitted, or held for
 *     the owner) are never exported as runnable: the first two get an "interrupted by the reinstall" receipt in delegation-receipts.json, merged by id,
 *     and their leftover entries are removed;
 *  3. one BEGIN IMMEDIATE: retained room-request marks reset, the requests of exported hand-offs put back at queued (where 1.0.1 expects a waiting
 *     hand-off's), old stand-in records deleted, every object in APP_SCHEMA_102_ADDITIONS dropped (triggers, indexes, tables), any 1.0.1 table whose
 *     columns differ rebuilt from its executable original definition (schema-1.0.1.ts `ddl`); COMMIT.
 * A crash anywhere leaves the rows (or the finished result): a retry recomputes the same files and the same drops. */
export function downgradeApplicationSchemaTo101(db: DatabaseSync, dataDir: string, hooks: { beforeCommit?: () => void } = {}): AppSchemaDowngrade {
  const pending = pendingOwnerWork(db);
  if (pending > 0) {
    throw Object.assign(new Error(`You have ${pending} message${pending === 1 ? "" : "s"} still waiting to send or restore. Send or cancel ${pending === 1 ? "it" : "them"}, then try again.`), { code: DOWNGRADE_WORK_PENDING });
  }
  // a finished card's result still on its way to the project room: dropping the table would lose the delivery 1.0.1 has no way to resume
  if (has(db, "table", "project_card_delivery_owed") && Number((db.prepare("SELECT COUNT(*) AS n FROM project_card_delivery_owed").get() as { n: number }).n) > 0) {
    throw Object.assign(new Error(CARD_DELIVERY_OWED_LINE), { code: DOWNGRADE_CARD_DELIVERY_OWED });
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
