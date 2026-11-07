import { downgradeTranscriptSeqTo102 } from "./transcript-seq.ts";
import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { downgradePushPhoneUsedTo102, downgradePushRetentionIndexesTo102 } from "./mobile-push-store.ts";
import { downgradeAppTriggers } from "./app-trigger-store.ts";
import { downgradeBotCallsTo108 } from "./bot-calls-schema.ts";
import { downgradeMessageIdIndexTo102 } from "./message-id-index.ts";
import { downgradeOutputPublicationTurnTo102 } from "./artifacts.ts";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { downgradeMemorySchema, suffixedSessionKeys, type MemoryDowngradeTarget } from "./memory/schema.ts";
import { downgradeMemoryIndexFile } from "./memory/age-index.ts";
import { assertNoHeldVenuePosts, assertNoPendingPhoneWork, downgradeApplicationSchemaTo101, downgradeCardTablesTo117, downgradePhoneObjectsTo108 } from "./installation-app-schema-downgrade.ts";
import { writeFileAtomic } from "./atomic.ts";
import { foldRoutineStateForDowngrade } from "./routine-runs-journal.ts";
import { deleteFtsOrphans, expectPragma, ftsSettled, optimizeUntilSettled } from "./settle-copy.ts";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Whether the root-set reclaim (memory/root-set-reclaim.ts) has run any step on this file, partly or fully: its marker is written in the transaction of
 * every batch. A v10 file whose marker cannot be read counts as reclaimed (the safe answer). */
function reclaimHasRun(db: DatabaseSync): boolean {
  try {
    const version = Number((db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get() as { schema_version?: unknown } | undefined)?.schema_version);
    if (!(version >= 10)) return false;
    return Number((db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get() as { value?: unknown } | undefined)?.value ?? 0) === 1;
  } catch { return true; }
}
/** After a reclaim the older build cannot prove what a retained provider session was shown (the session's root-set row is gone, and 1.0.1 reads "no row and
 * no receipts" as valid). Every retained provider session cursor (bots.json and groups.json: the bot's and each task's resumeCursors) is cleared, so 1.0.1
 * starts fresh sessions and replays only what it may show. No message is lost; an engine starts a new context. Idempotent; a file that does not parse is left. */
export function resetRetainedSessionCursors(root: string): number {
  let cleared = 0;
  const nonEmpty = (value: unknown) => Boolean(value) && typeof value === "object" && Object.keys(value as object).length > 0;
  for (const name of ["bots.json", "groups.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let records: unknown;
    try { records = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (!Array.isArray(records)) continue;
    let changed = false;
    const clear = (holder: Record<string, unknown>) => {
      if (Object.hasOwn(holder, "resumeCursors") && nonEmpty(holder.resumeCursors)) { holder.resumeCursors = {}; cleared++; changed = true; }
      for (const field of ["resumePolicies", "replayPending"]) if (Object.hasOwn(holder, field)) { delete holder[field]; changed = true; }
      if (Object.hasOwn(holder, "resumeSeals")) { delete holder.resumeSeals; changed = true; }
    };
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      clear(record as Record<string, unknown>);
      const tasks = (record as { tasks?: unknown }).tasks;
      if (Array.isArray(tasks)) for (const task of tasks) if (task && typeof task === "object") clear(task as Record<string, unknown>);
    }
    if (changed) writeFileAtomic(path, JSON.stringify(records), { mode: 0o600 });
  }
  return cleared;
}

/** Lineage S6 rule 27 on the way down: from incarnation 2 on a native session id is judged under `${id}#${n}`, but every build before memory
 * schema 12 keys a resumed session by the raw cursor, which is incarnation 1's row. A cursor whose session has a later incarnation (the
 * allocator or any per-session table names `${id}#${n}`, or the task records n >= 2) would be judged by the earlier, possibly clean,
 * session while the engine holds the later one, possibly revoked: each such cursor is cleared (and its incarnation with it), so the older
 * build starts a fresh session. A cursor with no later incarnation is kept (every cursor goes when the keys cannot be read). Idempotent; a
 * file that does not parse is left. */
export function resetIncarnatedSessionCursors(root: string, db: DatabaseSync): number {
  const later = new Set<string>();
  const pair = (instance: string, cursor: string) => JSON.stringify([instance, cursor]);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_session_incarnation'").get()) {
      for (const row of db.prepare("SELECT DISTINCT driver_instance,native_id FROM memory_session_incarnation WHERE n>=2").all()) later.add(pair(String(row.driver_instance), String(row.native_id)));
    }
    for (const key of suffixedSessionKeys(db)) later.add(pair(key.driverInstance, key.nativeId));
  } catch { return resetRetainedSessionCursors(root); } // the keys cannot be read: no retained session is left to judge by its raw cursor
  let cleared = 0;
  for (const name of ["bots.json", "groups.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let records: unknown;
    try { records = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (!Array.isArray(records)) continue;
    let changed = false;
    const clear = (holder: Record<string, unknown>) => {
      const cursors = holder.resumeCursors, incarnations = holder.resumeIncarnations;
      if (!cursors || typeof cursors !== "object") return;
      const counted = incarnations && typeof incarnations === "object" ? incarnations as Record<string, unknown> : undefined;
      for (const [instance, cursor] of Object.entries(cursors as Record<string, unknown>)) {
        if (cursor === undefined || cursor === null) continue;
        const n = Number(counted?.[instance]);
        if (!later.has(pair(instance, String(cursor))) && !(n >= 2)) continue;
        delete (cursors as Record<string, unknown>)[instance];
        if (counted) delete counted[instance];
        for (const field of ["resumePolicies", "replayPending"]) if (holder[field] && typeof holder[field] === "object") delete (holder[field] as Record<string, unknown>)[instance];
        if (holder.resumeSeals && typeof holder.resumeSeals === "object") delete (holder.resumeSeals as Record<string, unknown>)[instance];
        cleared++; changed = true;
      }
    };
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      clear(record as Record<string, unknown>);
      const tasks = (record as { tasks?: unknown }).tasks;
      if (Array.isArray(tasks)) for (const task of tasks) if (task && typeof task === "object") clear(task as Record<string, unknown>);
    }
    if (changed) writeFileAtomic(path, JSON.stringify(records), { mode: 0o600 });
  }
  return cleared;
}

/** The top-level data-folder names a 1.0.3 desktop writes that 1.0.2's backup does not classify: it refuses any name it does not know
 * (BACKUP_UNCLASSIFIED_COMPONENT), so after "Prepare to reinstall" 1.0.2 could take no backup. Each is a derived note or a cache that 1.0.3
 * writes again (data-dir-inventory.ts says why each is never restored): the repairs note and its unfinished write (the repairs run again and change nothing), the
 * model catch-up marker (re-queues only records still owed), this month's "Leave paused" choice (the item is asked again), the kept login-shell
 * environment (the next capture writes it), approvals still waiting for their answer (asked again; none was ever a grant), the
 * first-run backup record (missing means not owed), a Claude turn's settings overlays (claude-private/: only a crash leaves one, and 1.0.2
 * has no turn that reads it), the Claude sign-in card's remembered answers (claude-signin-answers.json: 1.0.2 has no such card, and the card simply asks again) and the frozen-replies recovery cursor (a later 1.0.3 start reads again from the start and
 * changes nothing a second time), and the cloud computer prompt record and its set-aside unreadable copy (cloud-computer-turns.ts: 1.0.2
 * has no such record, and a later 1.0.6 start begins a fresh one), and the health metadata folder (health/, 1.0.9 Sentinel's producer
 * input root: minute counters, sealed statistics and the backup status manifest, all rebuilt from fresh observations by a later 1.0.9
 * start; 1.0.2 never reads it), and the health token key next to it (health-key: the key Sentinel's opaque tokens are made with,
 * made again by a later 1.0.9 start), and the power-guard line note (power-guard-notice.json: a later start may show that one line once
 * more), and the feedback id (feedback-install-id: random, names nothing but this install's notes, made again by the next feedback sent).
 * The Cloud-only names are never on a desktop that reinstalls 1.0.2. */
export const DATA_DIR_NAMES_AFTER_102 = ["claude-private", "claude-signin-answers.json", "draft-only-cwd", "email-capabilities.json", "email-capabilities.json.tmp", "env", "feedback-install-id", "frozen-replies-recovery.json", "learning-paused-left.json", "memory-model-adopted.json", "memory-model-adopted.json.tmp", "memory-repairs.json", "memory-repairs.json.tmp", "pending-grants.json", "setup-backup.json", "cloud-computer-turns.json", "cloud-computer-turns.json.unreadable", "news-signup.json", "health", "health-key", "sentinel-delivery.json", "power-guard-notice.json"] as const;
/** Owner-kept notes written after 1.0.2 (backed up, so they are not in the derived list above), that 1.0.2's backup does not classify
 * either. The follow-model marker (thread-follow-model.ts) only records that the one-time chat model cleanup ran; 1.0.2 never reads
 * it. Removing it lets 1.0.2 take a backup; a later upgrade runs the cleanup once more, which drops only pins proved equal to the
 * bot's model and keeps every different pick. The owner's cross-device prefs (owner-prefs.json, 1.0.17 owner-prefs.ts) hold the
 * Approve all caution's "Don't show this again" and (1.0.18) Today's Calm | Detailed choice; 1.0.2 has neither and never reads the file.
 * Removing it lets 1.0.2 take a backup, and a later upgrade reads the missing file as the defaults: the caution shows once more and
 * Today opens Calm, and nothing else changes. */
export const DATA_DIR_OWNER_NOTES_AFTER_102 = [".threads-follow-model-v1", "owner-prefs.json"] as const;
/** 1.0.18 records 1.0.2's backup does not classify (backed up and restored by 1.0.18, so in neither list above). The root record
 * (.murage-root.json, S5 data-roots.ts) names this folder's canonical root, its previous roots and any linked roots; 1.0.2 never reads
 * it. Removing it lets 1.0.2 take a backup, and a later 1.0.18 start reads the missing record as a first sight: the same as an upgrade
 * from 1.0.17, which had no record (each linked root is recorded silently, no card, nothing under any root is touched). */
export const DATA_DIR_RECORDS_AFTER_102 = [".murage-root.json"] as const;
/** Removes those names from the data folder (a link is removed, never followed). Idempotent; returns the names removed. */
export function removeDataDirNamesAfter102(root: string): string[] {
  const removed: string[] = [];
  for (const name of [...DATA_DIR_NAMES_AFTER_102, ...DATA_DIR_OWNER_NOTES_AFTER_102, ...DATA_DIR_RECORDS_AFTER_102]) {
    const path = join(root, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isDirectory()) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
    removed.push(name);
  }
  return removed;
}

/** One-shot maintenance for reinstalling an older build on a data dir that a
 * later Murage already migrated to a newer memory schema. Takes the same
 * exclusive lease as the running app (so it refuses while Murage is open),
 * rewrites the memory objects to the frozen shape of `to` (1: 0.1.53 and
 * older; 2: 0.1.54 to 0.1.60; 3 and 4: development builds; 5: before the 1.0 lineage tables; 6: 1.0.0 and 1.0.1; 7: before the 1.0.2 revocation index; 8: before the 1.0.2 cold-lineage indexes; 9: the 1.0.2 RC; 10: 1.0.2, which refuses the derived objects 1.0.3 adds; 11: 1.0.3 before the lineage door epoch; 12: 1.0.3 to 1.0.6, before the 1.0.7 source stamps) and folds the WAL so the file stands alone.
 * Chat history and memory rows are kept; only derived or learning-only
 * objects are dropped. The pre-upgrade copies are left untouched. Routine
 * state lines are folded into routines.json first (foldRoutineStateForDowngrade),
 * also when there is no memory database yet. */
/** The memory schema versions `memory-downgrade --to` accepts (10: 1.0.2; 11: 1.0.3 before the lineage door epoch; 12: 1.0.3 to 1.0.6). */
/** Where a test stops the downgrade, as a crash there would (each point is after a committed step). */
export type DowngradeSearchPoint = "optimized" | "config-restored" | "checkpointed" | "marker-deleted";

const hasTable = (db: DatabaseSync, name: string) => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

/** The live file's search index settles before the older build sees it (SMOOTH-FTS-MERGE R6 section 4): after every
 * `DELETE FROM messages_fts` of this command (trimUnfinishedSearchFill inside downgradeApplicationSchemaTo101, already committed).
 * secure_delete read back; orphans out; optimize until settled (3 rounds, else fail: the earlier commit stays and rerunning the
 * command is the recovery); one VACUUM, the one place the live file is vacuumed, offline under the lease; the probe again. The older
 * build's merge defaults (automerge 4, deletemerge 10, literals) are written back on the success path and on the failure path. */
function settleSearchIndexForDowngrade(db: DatabaseSync, at: (point: DowngradeSearchPoint) => void) {
  expectPragma(db, "PRAGMA secure_delete=ON", 1);
  const fts = hasTable(db, "messages_fts");
  let failure: unknown;
  try { if (fts) { deleteFtsOrphans(db); optimizeUntilSettled(db); } }
  catch (error) { failure = error; }
  if (failure === undefined) {
    at("optimized");
    try {
      db.exec("VACUUM");
      if (ftsSettled(db) !== "settled") fail("SEARCH_INDEX_NOT_SETTLED");
    } catch (error) { failure = error; }
  }
  if (fts) {
    try {
      db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 4)");
      db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 10)");
    } catch (error) { if (failure === undefined) failure = error; }
  }
  if (failure !== undefined) {
    const code = (failure as { code?: unknown }).code;
    if (typeof code === "string" && code !== "FTS_COPY_NOT_SETTLED" && /^[A-Z][A-Z0-9_]{0,100}$/.test(code)) throw failure;
    throw Object.assign(new Error("SEARCH_INDEX_NOT_SETTLED"), { code: "SEARCH_INDEX_NOT_SETTLED", cause: failure });
  }
  at("config-restored");
}

/** The WAL fold is checked (R6 section 4): busy 0 and every frame of the log checkpointed, else the downgrade fails. */
function checkedTruncate(db: DatabaseSync) {
  let row: { busy?: unknown; log?: unknown; checkpointed?: unknown } | undefined;
  // a reader holding the log can surface as SQLITE_BUSY instead of busy=1: the same unfinished fold
  try { row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as typeof row; }
  catch (error) { throw Object.assign(new Error("WAL_CHECKPOINT_INCOMPLETE"), { code: "WAL_CHECKPOINT_INCOMPLETE", cause: error }); }
  if (!row || Number(row.busy) !== 0 || Number(row.log) !== Number(row.checkpointed)) fail("WAL_CHECKPOINT_INCOMPLETE");
}

export const MEMORY_DOWNGRADE_TARGETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const satisfies readonly MemoryDowngradeTarget[];
export function downgradeInstallationMemorySchema(dataDir: string, to: MemoryDowngradeTarget = 1, testing: { at?: (point: DowngradeSearchPoint) => void } = {}) {
  const at = testing.at ?? (() => {});
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const file = join(root, "messages.db");
  const stat = existsSync(file) ? lstatSync(file) : null;
  const hasDatabase = Boolean(stat?.isFile() && !stat.isSymbolicLink());
  const routines = join(root, "routines.json");
  if (!hasDatabase && !existsSync(routines)) fail("MEMORY_DATABASE_MISSING");
  const lease = acquireDataDirLeaseForProcess(root);
  try {
    // A phone line still waiting to send, or a held Post in… post, is refused before any change: nothing below may have run when the owner
    // is told to send or cancel it (the routine folding, the push and transcript columns and the memory step all change the file).
    if (hasDatabase) {
      const probe = new DatabaseSync(file, { readOnly: true });
      // the same wait the main connection gets: a connection still leaving the file holds it for a moment, and the probe waits it out rather than failing
      try { probe.exec("PRAGMA busy_timeout=5000"); assertNoPendingPhoneWork(probe); assertNoHeldVenuePosts(probe); } finally { probe.close(); }
    }
    // Routines first (1.0.2 bgwork): an older release reads only routines.json and plain journal lines, so every
    // cursor a routine state line moved is folded in before it can see the schedule (no occurrence runs twice).
    foldRoutineStateForDowngrade(routines);
    if (!hasDatabase) fail("MEMORY_DATABASE_MISSING");
    const db = new DatabaseSync(file);
    try {
      // the wait first (as database.ts does): a connection still leaving the file holds it for a moment, and journal_mode reads it
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      // Going back to a build before 1.0.2: its waiting handoffs return to delegations.json (the file it reads), the ones whose turn was taken are
      // receipted as interrupted, and every application object 1.0.1 does not know leaves (installation-app-schema-downgrade.ts), all before the memory step.
      // every older build lacks messages.seq and its index (1.0.3): they leave first, whatever the target (transcript-seq.ts)
      // every older build lacks the bot call tables, their trigger on messages and push_bindings.rings_for_calls (1.0.9): they leave first (bot-calls-schema.ts)
      downgradeBotCallsTo108(db);
      // every older build lacks the connected-app trigger tables (1.0.12): they leave first, whatever the target (app-trigger-store.ts)
      downgradeAppTriggers(db);
      // every older build lacks the 1.0.18 card tables (venue_posts, room_shares): they leave first, whatever the target (installation-app-schema-downgrade.ts)
      downgradeCardTablesTo117(db);
      downgradeTranscriptSeqTo102(db);
      // every older build lacks the push retention indexes (1.0.3): they leave first, whatever the target (mobile-push-store.ts)
      downgradePushRetentionIndexesTo102(db);
      // every older build lacks push_events.phone_used (1.0.9): the column leaves with the retention indexes, whatever the target (mobile-push-store.ts)
      downgradePushPhoneUsedTo102(db);
      // every older build lacks the message-id index (1.0.3): it leaves first, whatever the target (message-id-index.ts)
      downgradeMessageIdIndexTo102(db);
      // every older build holds output_publications to its text without turn_id (1.0.3): the column leaves first, whatever the target (artifacts.ts)
      downgradeOutputPublicationTurnTo102(db);
      // every older build lacks the phone tables and owner_sends's phone columns (1.0.9): they leave first, whatever the target (installation-app-schema-downgrade.ts)
      downgradePhoneObjectsTo108(db);
      const app = to <= 6 ? downgradeApplicationSchemaTo101(db, dirname(file)) : { exported: 0, interrupted: 0, dropped: 0, rebuilt: 0 };
      // before the memory step, so a stopped run finds the marker again and does it again
      if (to < 10 && reclaimHasRun(db)) resetRetainedSessionCursors(dirname(file));
      // every build before memory schema 12 resumes by the raw cursor (rule 27): a session with a later incarnation never resumes there
      if (to < 12) resetIncarnatedSessionCursors(dirname(file), db);
      settleSearchIndexForDowngrade(db, at);
      const result = downgradeMemorySchema(db, to);
      checkedTruncate(db);
      at("checkpointed");
      // The live merge marker (search-merge-runner) leaves only after that checkpoint, and only while its table is still there
      // (to>=10 keeps it, memory/schema.ts DERIVED_TABLES_KEPT_FOR_102). A failed checkpoint keeps it, in either state, and the next
      // start of a build that knows it pays it. By name only.
      if (hasTable(db, "transcript_index_state") && Number(db.prepare("DELETE FROM transcript_index_state WHERE name='search_merge'").run().changes) > 0) {
        at("marker-deleted");
        // the file stands alone again only when that one row's frame folded: checked like the first, a held log fails the downgrade
        // (the marker is gone and every step before it reruns as a no-op, so the rerun's first checked TRUNCATE folds it)
        checkedTruncate(db);
      }
      // 1.0.3 lane 2: the search index file goes back to what 1.0.2 wrote (its second word table and the lane's markers leave; a renamed
      // word table with age rowids stays, 1.0.2 reads it by rowid and by rank and is correct either way).
      downgradeMemoryIndexFile(join(root, "memory-index.db"));
      // 1.0.3's own notes at the root leave last, once the database is back in an older shape (a stopped run does this again)
      removeDataDirNamesAfter102(root);
      return app.exported || app.interrupted ? { ...result, handoffs: app.exported, handoffsStarted: app.interrupted } : result;
    } finally { db.close(); }
  } finally { lease.release(); }
}
