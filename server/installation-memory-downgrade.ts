import { assertNoDecisionContinuations, DATA_DIR_NAMES_AFTER_118, downgradeDecisionTables, preservePost118Data, removePost118Data } from "./installation-decision-downgrade.ts";
import { preserveSignalForDowngrade } from "./channels/signal/park-downgrade.ts";
import type { ParkOptions } from "./channels/signal/park.ts";
import { downgradeChatsPreviewTables } from "./thread-summary.ts";
import { downgradeTranscriptSeqTo102 } from "./transcript-seq.ts";
import { chmodSync, closeSync, copyFileSync, fsyncSync, mkdtempSync, openSync, existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { downgradePushPhoneUsedTo102, downgradePushRetentionIndexesTo102 } from "./mobile-push-store.ts";
import { downgradeAppTriggers } from "./app-trigger-store.ts";
import { downgradeBotCallsTo108 } from "./bot-calls-schema.ts";
import { downgradeMessageIdIndexTo102 } from "./message-id-index.ts";
import { downgradeOutputPublicationTurnTo102 } from "./artifacts.ts";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { downgradeMemorySchema, suffixedSessionKeys, validateMemorySchema, type MemoryDowngradeTarget } from "./memory/schema.ts";
import { askTombstonePathFor, readAskTombstone, readTombstone, tombstonePathFor } from "./phones/revocation-tombstone.ts";
import { downgradeMemoryIndexFile } from "./memory/age-index.ts";
import { assertNoHeldVenuePosts, assertNoRestoreWindowOpen, assertNoOwedWorkForDowngrade, assertNoPendingPhoneWork, assertNoSpeechHeld, downgradeApplicationSchemaTo101, downgradeMessageSearch, finishBranchChangeForDowngrade, downgradeCardTablesTo117, downgradeDelegationPacks, downgradePhoneAskOptIns, downgradePhoneObjectsTo108, downgradeOwnerSendAskProof, downgradeSpeechTablesTo117, markInFlightSpeechInterrupted } from "./installation-app-schema-downgrade.ts";
import { writeFileAtomic } from "./atomic.ts";
import { foldRoutineStateForDowngrade } from "./routine-runs-journal.ts";
import { deleteFtsOrphans, removeMessageSearchFiles, expectPragma, ftsProbeBoth, ftsSettled, optimizeUntilSettled } from "./settle-copy.ts";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** The schema objects of messages.db as type:name (a trigger may share a name with a table, so both parts are the key; sqlite's own sqlite_* objects left out). */
function schemaObjectKeys(db: DatabaseSync): string[] {
  return (db.prepare("SELECT type||':'||name AS k FROM sqlite_schema WHERE substr(name,1,7)<>'sqlite_'").all() as Array<{ k: string }>).map(row => row.k);
}

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
 * more), and the feedback id (feedback-install-id: random, names nothing but this install's notes, made again by the next feedback sent),
 * and the HighLevel folder (highlevel/, 1.0.18: the connection record with ids, the location name and a token fingerprint, never the
 * token, and the change journal; 1.0.2 has no HighLevel, and a later upgrade asks the owner to check the location again, as after a restore).
 * The Cloud-only names are never on a desktop that reinstalls 1.0.2. */
export const DATA_DIR_NAMES_AFTER_102 = ["browser-window", "model-catalogs", "claude-private", "claude-signin-answers.json", "draft-only-cwd", "email-capabilities.json", "email-capabilities.json.tmp", "env", "feedback-install-id", "frozen-replies-recovery.json", "learning-paused-left.json", "memory-model-adopted.json", "memory-model-adopted.json.tmp", "memory-repairs.json", "memory-repairs.json.tmp", "pending-grants.json", "setup-backup.json", "cloud-computer-turns.json", "cloud-computer-turns.json.unreadable", "news-signup.json", "health", "health-key", "sentinel-delivery.json", "power-guard-notice.json", "highlevel"] as const;
/** Owner-kept notes written after 1.0.2 (backed up, so they are not in the derived list above), that 1.0.2's backup does not classify
 * either. The follow-model marker (thread-follow-model.ts) only records that the one-time chat model cleanup ran; 1.0.2 never reads
 * it. Removing it lets 1.0.2 take a backup; a later upgrade runs the cleanup once more, which drops only pins proved equal to the
 * bot's model and keeps every different pick. The owner's cross-device prefs (owner-prefs.json, 1.0.17 owner-prefs.ts) hold the
 * Approve all caution's "Don't show this again" and (1.0.18) Today's Calm | Detailed choice; 1.0.2 has neither and never reads the file.
 * Removing it lets 1.0.2 take a backup, and a later upgrade reads the missing file as the defaults: the caution shows once more and
 * Today opens Calm, and nothing else changes.
 * 1.0.18 adds outside-state.jsonl (the No limits marks, backed up as the owner's file): 1.0.2 has no marks and never reads it, so the downgrade takes it away too. */
export const DATA_DIR_OWNER_NOTES_AFTER_102 = [".threads-follow-model-v1", "owner-prefs.json", "outside-state.jsonl"] as const;
/** Phone history and its sidecars cannot live in the legacy data directory. Downgrade
 * first refuses unfinished calls and preserves a private, durable copy in a sibling folder. */
export const DATA_DIR_DATABASES_AFTER_102 = ["phone-calls.db", "phone-calls.db-journal", "phone-calls.db-shm", "phone-calls.db-wal"] as const;
/** Under the offline lease, fail closed on unreadable or unfinished calls. Keep a durable,
 * private raw family outside the legacy directory before removing anything. */
/** The check half (read-only, the preflight): PHONE_CALLS_UNREADABLE or PHONE_CALLS_PENDING, else the names of the family present. */
export function checkPhoneCallsForDowngrade(root: string): string[] {
  const family = DATA_DIR_DATABASES_AFTER_102.filter(name => existsSync(join(root, name)));
  if (!family.length) return family;
  const file = join(root, "phone-calls.db");
  for (const name of family) if (!lstatSync(join(root, name)).isFile() || lstatSync(join(root, name)).isSymbolicLink()) fail("PHONE_CALLS_UNREADABLE");
  // Empty database files contain no records. Any other unreadable shape blocks the downgrade.
  if (!existsSync(file)) fail("PHONE_CALLS_UNREADABLE");
  if (lstatSync(file).size === 0 && family.some(name => name !== "phone-calls.db" && lstatSync(join(root, name)).size > 0)) fail("PHONE_CALLS_UNREADABLE");
  if (lstatSync(file).size > 0) {
    let probe: DatabaseSync | undefined;
    try {
      probe = new DatabaseSync(file, { readOnly: true });
      if (probe.prepare("SELECT 1 FROM phone_calls WHERE status NOT IN ('ended', 'cancelled', 'abandoned') LIMIT 1").get()) fail("PHONE_CALLS_PENDING");
    } catch (error) {
      if ((error as { code?: string }).code === "PHONE_CALLS_PENDING") throw error;
      fail("PHONE_CALLS_UNREADABLE");
    } finally { probe?.close(); }
  }
  return family;
}
/** The copy half: checks (unless the preflight already did) and keeps the private copy. */
export function preservePhoneCallsForDowngrade(root: string, family: string[] = checkPhoneCallsForDowngrade(root)): string | undefined {
  if (!family.length) return;
  // A log that still holds committed rows is folded into the main file first, checked (busy 0, every frame checkpointed), else the downgrade
  // refuses with nothing removed and the log kept (a reader that blocks the fold may still let part of it reach the main file, so the claim is nothing removed, not every byte as it was): from here the main file alone holds every committed call, so the order the family leaves in no longer matters
  // and the private copy is the whole history (a call the log marked ended is ended in the copy and in a re-run).
  const wal = join(root, "phone-calls.db-wal");
  if (existsSync(wal) && lstatSync(wal).size > 0) {
    const calls = new DatabaseSync(join(root, "phone-calls.db"));
    try { calls.exec("PRAGMA busy_timeout=1000"); checkedTruncate(calls); } finally { calls.close(); }
    family = DATA_DIR_DATABASES_AFTER_102.filter(name => existsSync(join(root, name)));
  }
  const backup = mkdtempSync(join(dirname(root), ".murage-phone-calls-preserved-"));
  for (const name of family) {
    const destination = join(backup, name);
    copyFileSync(join(root, name), destination);
    chmodSync(destination, 0o600);
    const fd = openSync(destination, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  for (const directory of [backup, dirname(root)]) {
    const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return backup;
}

/** 1.0.18 records 1.0.2's backup does not classify (backed up and restored by 1.0.18, so in neither list above). The root record
 * (.murage-root.json, S5 data-roots.ts) names this folder's canonical root, its previous roots and any linked roots; 1.0.2 never reads
 * it. Removing it lets 1.0.2 take a backup, and a later 1.0.18 start reads the missing record as a first sight: the same as an upgrade
 * from 1.0.17, which had no record (each linked root is recorded silently, no card, nothing under any root is touched). */
export const DATA_DIR_RECORDS_AFTER_102 = ["browser-modes.json", ".murage-root.json"] as const;
/** Removes those names from the data folder (a link is removed, never followed). Idempotent; returns the names removed. */
export function removeDataDirNamesAfter102(root: string, alreadyPreserved = false): string[] {
  if (!alreadyPreserved) { preservePhoneCallsForDowngrade(root); preservePost118Data(root); }
  const removed: string[] = [];
  // The phone family leaves sidecars first, the main file last: a stop part way then leaves a family whose main file is still there, which the
  // preflight reads and a re-run finishes. The other order leaves sidecars with no main file, and the re-run refuses (PHONE_CALLS_UNREADABLE).
  for (const name of [...DATA_DIR_NAMES_AFTER_102, ...DATA_DIR_OWNER_NOTES_AFTER_102, ...[...DATA_DIR_DATABASES_AFTER_102].reverse(), ...DATA_DIR_RECORDS_AFTER_102, ...DATA_DIR_NAMES_AFTER_118]) {
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
 * rewrites the memory objects to the frozen shape of `to` (the command refuses 6 and below, refuseStepBefore102; 1: 0.1.53 and
 * older; 2: 0.1.54 to 0.1.60; 3 and 4: development builds; 5: before the 1.0 lineage tables; 6: 1.0.0 and 1.0.1; 7: before the 1.0.2 revocation index; 8: before the 1.0.2 cold-lineage indexes; 9: the 1.0.2 RC; 10: 1.0.2, which refuses the derived objects 1.0.3 adds; 11: 1.0.3 before the lineage door epoch; 12: 1.0.3 to 1.0.6, before the 1.0.7 source stamps) and folds the WAL so the file stands alone.
 * Chat history and memory rows are kept; only derived or learning-only
 * objects are dropped. The pre-upgrade copies are left untouched. Routine
 * state lines are folded into routines.json first (foldRoutineStateForDowngrade),
 * also when there is no memory database yet. */
/** Where a test stops the downgrade, as a crash there would (each point is after a committed step). */
export type DowngradeSearchPoint = "optimized" | "config-restored" | "index-file-removed" | "names-removed" | "checkpointed" | "marker-deleted";

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

/** Both phone revocation files are parsed with the readers that later read them back (phones/revocation-tombstone.ts). A file that cannot be read
 * stops the downgrade in the preflight with nothing written, because the step that merges into it would otherwise fail halfway. A missing file is fine. */
function assertTombstonesReadable(db: DatabaseSync): void {
  try {
    const path = tombstonePathFor(db);
    const askPath = askTombstonePathFor(db);
    if (path !== null) readTombstone(path);
    if (askPath !== null) readAskTombstone(askPath);
  } catch (error) {
    throw Object.assign(new Error("PHONE_REVOCATIONS_UNREADABLE"), { code: "PHONE_REVOCATIONS_UNREADABLE", cause: error });
  }
}

/** The memory schema versions `memory-downgrade --to` recognizes. 7 to 13 run (10: 1.0.2; 11: 1.0.3 before the lineage door epoch; 12: 1.0.3 to 1.0.6;
 * 13: 1.0.17, the same version, where only the 1.0.18 optional memory indexes leave and the source stamps stay);
 * 1 to 6, like no target at all, get the one sentence below. */
export const MEMORY_DOWNGRADE_TARGETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const satisfies readonly MemoryDowngradeTarget[];
export const MEMORY_DOWNGRADE_GO_THROUGH_102 = "MEMORY_DOWNGRADE_GO_THROUGH_102";
export const MEMORY_DOWNGRADE_GO_THROUGH_102_LINE = "To go back to Murage 1.0.1 or older, first go through Murage 1.0.2: create a backup in this version, run this command with --to 10, install 1.0.2, then go back further from there. Murage 1.0.1's backup and restore tools can't read your data after these steps. Your backup from this version restores in this version.";
/** A step to 1.0.1's shape or older belongs to 1.0.2's own command: this build's files hold objects that shape does not name, so 1.0.1's inspector would not
 * accept the result. Thrown before the lease, the routine folding and any open of the file. */
export function refuseStepBefore102(): never {
  throw Object.assign(new Error(MEMORY_DOWNGRADE_GO_THROUGH_102_LINE), { code: MEMORY_DOWNGRADE_GO_THROUGH_102 });
}
/** `testOnlyBefore102` is the tests' route to a target of 6 or below, for the rewind code and the checks against the real 1.0.1: only test files pass it
 * (installation-recovery-command.test.ts scans for that), and the command takes strings, so neither the hand-run command nor the app can set it. */
export function downgradeInstallationMemorySchema(dataDir: string, to: MemoryDowngradeTarget, testing: { at?: (point: DowngradeSearchPoint) => void; testOnlyBefore102?: true; signal?: ParkOptions } = {}) {
  if (to <= 6 && !testing.testOnlyBefore102) refuseStepBefore102();
  const at = testing.at ?? (() => {});
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const file = join(root, "messages.db");
  const stat = existsSync(file) ? lstatSync(file) : null;
  const hasDatabase = Boolean(stat?.isFile() && !stat.isSymbolicLink());
  const routines = join(root, "routines.json");
  const lease = acquireDataDirLeaseForProcess(root);
  // --to 13 is the step back to 1.0.17, the same memory version: only what 1.0.18 adds leaves (the chats preview, card and spoken-reply
  // tables, the 1.0.18 optional memory indexes). Every object 1.0.17 knows stays as it is: its phone, bot-call, trigger and push objects,
  // the transcript sequence and the root notes (phone-calls.db among them), which the steps below take only on the way to an older build.
  // ONE read-only PREFLIGHT runs on EVERY target before anything is written: every refusal for owner state comes from it and leaves every byte as it was.
  // Only the REMOVAL steps after it depend on the target (design PIPPERF-DOWNGRADE13-rule.md). On 13 phone-calls.db stays in place (1.0.17
  // does not know the name and leaves it out of its backup, it does not refuse it) and a private copy is kept beside the folder, as on every other target.
  const to117 = to === 13;
  try {
    // RESTORE WINDOW (read-only, before the first write): an owner restore that has not finished leaves its preparation owed to the next start of THIS build,
    // and an older build opened in between would write into that database, so the step back refuses until this build has finished the recovery.
    assertNoRestoreWindowOpen(root);
    if (!hasDatabase && !existsSync(routines)) fail("MEMORY_DATABASE_MISSING");
    // PREP: an attempt a crash left reserved or streaming is marked interrupted (the one write before the preflight, so its refusal ends)
    if (hasDatabase) {
      // An attempt a crash left reserved or streaming is marked interrupted and its account held ten minutes first, durably, exactly as a start does, so the refusal below ends
      // ten minutes later instead of repeating forever (installation-app-schema-downgrade.ts markInFlightSpeechInterrupted).
      const marker = new DatabaseSync(file);
      try { marker.exec("PRAGMA busy_timeout=5000"); markInFlightSpeechInterrupted(marker); } finally { marker.close(); }
    }
    // PREFLIGHT (read-only, every target): an unfinished or unreadable phone call; a phone line still waiting to send, a held Post in… post, a voice reply
    // still held or inside its rate window; a send or restore hold, an owed card delivery, a held hand-off, an owed hand-off reply (once 1.0.1's alone);
    // a memory schema the step cannot read; a search index in a state the settle cannot read. Nothing below may have run when the owner is told.
    const phoneFamily = checkPhoneCallsForDowngrade(root);
    if (hasDatabase) {
      // a normal connection held to reading (query_only): a read-only open of a WAL file leaves -wal and -shm behind, a normal close folds and removes
      // them, so a refusal leaves every byte as it was
      const probe = new DatabaseSync(file);
      // the same wait the main connection gets: a connection still leaving the file holds it for a moment, and the probe waits it out rather than failing
      try {
        probe.exec("PRAGMA busy_timeout=5000");
        probe.exec("PRAGMA query_only=ON");
        assertTombstonesReadable(probe);
        assertNoPendingPhoneWork(probe); assertNoHeldVenuePosts(probe); assertNoSpeechHeld(probe);
        assertNoDecisionContinuations(probe);
        assertNoOwedWorkForDowngrade(probe, root);
        if (!probe.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get()) fail("MEMORY_SCHEMA_UNSUPPORTED");
        validateMemorySchema(probe);
        if (ftsProbeBoth(probe) === "unknown") fail("SEARCH_INDEX_NOT_SETTLED");
      } finally { probe.close(); }
    }
    // Signal and connector custody is completed on every supported target, including 13, before removal/stamp.
    const signalPreservation = preserveSignalForDowngrade(root,testing.signal);
    // PRESERVE: the private copy of the phone history, then the routines (1.0.2 bgwork): an older release reads only routines.json and plain journal
    // lines, so every cursor a routine state line moved is folded in before it can see the schedule (no occurrence runs twice).
    const phoneCallsPreservedAt = preservePhoneCallsForDowngrade(root, phoneFamily);
    const applicationDataPreservedAt = preservePost118Data(root);
    foldRoutineStateForDowngrade(routines);
    if (!hasDatabase) fail("MEMORY_DATABASE_MISSING");
    const db = new DatabaseSync(file);
    try {
      // the wait first (as database.ts does): a connection still leaving the file holds it for a moment, and journal_mode reads it
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      // --to 12 and 13 report what they took away ("removed", additive): the schema objects, then the data-folder names
      const objectsBefore = to >= 12 ? schemaObjectKeys(db) : [];
      // FINISH (to 1.0.1 only, before any removal): a branch switch a crash cut short is finished, or the owner is told with nothing removed
      if (to <= 6) finishBranchChangeForDowngrade(db);
      // Going back to a build before 1.0.2: its waiting handoffs return to delegations.json (the file it reads), the ones whose turn was taken are
      // receipted as interrupted, and every application object 1.0.1 does not know leaves (installation-app-schema-downgrade.ts), all before the memory step.
      // every build before 1.0.3 lacks messages.seq and its index (transcript-seq.ts), and every build before 1.0.9 the bot call tables, their
      // trigger on messages and push_bindings.rings_for_calls (bot-calls-schema.ts): they leave on the way to such a build
      // every older build lacks the 1.0.18 chats preview tables: they leave, whatever the target (thread-summary.ts)
      downgradeDecisionTables(db);
      downgradeOwnerSendAskProof(db);
      downgradeChatsPreviewTables(db);
      if (!to117) downgradeBotCallsTo108(db);
      // every build before 1.0.12 lacks the connected-app trigger tables: they leave first on the way to one (app-trigger-store.ts)
      if (!to117) downgradeAppTriggers(db);
      // every older build lacks the 1.0.18 card tables (venue_posts, room_shares): they leave first, whatever the target (installation-app-schema-downgrade.ts)
      downgradeCardTablesTo117(db);
      // Delegation packs are newer than every supported downgrade target.
      downgradeDelegationPacks(db);
      // HighLevel marks are newer than every supported downgrade target.
      // DROP TABLE also removes its primary-key index before the legacy stamp.
      db.exec("DROP TABLE IF EXISTS highlevel_thread_marks");
      // The device-id disclosure choice is 1.0.19 state. Every supported
      // downgrade target predates it, including 1.0.17 which keeps phone registrations.
      downgradePhoneAskOptIns(db);
      // Older targets remove all phone columns below; 1.0.17 keeps those rows
      // and columns, but its strict inspector cannot accept 1.0.19 ask proof.
      // every older build lacks the 1.0.18 spoken-reply tables (speech_*): they leave first, whatever the target (installation-app-schema-downgrade.ts)
      downgradeSpeechTablesTo117(db);
      // the objects of 1.0.3 to 1.0.12 below leave on the way to a build before them, and stay on the step back to 1.0.17 (to117), which has them
      if (!to117) {
        downgradeTranscriptSeqTo102(db);
        // every build before 1.0.3 lacks the push retention indexes (mobile-push-store.ts)
        downgradePushRetentionIndexesTo102(db);
        // every build before 1.0.9 lacks push_events.phone_used: the column leaves with the retention indexes (mobile-push-store.ts)
        downgradePushPhoneUsedTo102(db);
        // every build before 1.0.3 lacks the message-id index (message-id-index.ts)
        downgradeMessageIdIndexTo102(db);
        // every build before 1.0.3 holds output_publications to its text without turn_id (artifacts.ts)
        downgradeOutputPublicationTurnTo102(db);
        // every build before 1.0.9 lacks the phone tables and owner_sends's phone columns (installation-app-schema-downgrade.ts)
        downgradePhoneObjectsTo108(db);
      }
      const app = to <= 6 ? downgradeApplicationSchemaTo101(db, dirname(file)) : { exported: 0, interrupted: 0, dropped: 0, rebuilt: 0 };
      // before the memory step, so a stopped run finds the marker again and does it again
      if (to < 10 && reclaimHasRun(db)) resetRetainedSessionCursors(dirname(file));
      // every build before memory schema 12 resumes by the raw cursor (rule 27): a session with a later incarnation never resumes there
      if (to < 12) resetIncarnatedSessionCursors(dirname(file), db);
      downgradeMessageSearch(db);
      removeMessageSearchFiles(root);
      settleSearchIndexForDowngrade(db, at);
      // STAMP LAST: the memory schema stamp is what tells 1.0.17 a folder is done, so every step that leaves a file or a name goes BEFORE it
      // (to 12 and below; 13 has no stamp change and leaves memory-index.db alone). A stopped run leaves the stamp up, 1.0.17 refuses the folder, and
      // running the command again finishes it. Each step below is idempotent.
      // 1.0.3 lane 2: the search index file goes back to what 1.0.2 wrote (its second word table and the lane's markers leave; a renamed
      // word table with age rowids stays, 1.0.2 reads it by rowid and by rank and is correct either way).
      let removedNames: string[] = [];
      if (!to117) {
        downgradeMemoryIndexFile(join(root, "memory-index.db"));
        at("index-file-removed");
        // 1.0.3's own notes at the root leave once the database holds nothing more to export (a stopped run does this again)
        removedNames = removeDataDirNamesAfter102(root, true);
        at("names-removed");
      }
      const result = { ...downgradeMemorySchema(db, to), ...signalPreservation, ...(phoneCallsPreservedAt ? { phoneCallsPreservedAt } : {}) };
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
      if (to117) removedNames.push(...removePost118Data(root));
      const objectsAfter = new Set(to >= 12 ? schemaObjectKeys(db) : []);
      const gone = [...new Set(objectsBefore.filter(key => !objectsAfter.has(key)).map(key => key.slice(key.indexOf(":") + 1)))].sort();
      const reported = { ...(to >= 12 ? { ...result, removed: [...gone, ...removedNames] } : result), ...(applicationDataPreservedAt ? {applicationDataPreservedAt} : {}) };
      return app.exported || app.interrupted ? { ...reported, handoffs: app.exported, handoffsStarted: app.interrupted } : reported;
    } finally { db.close(); }
  } finally { lease.release(); }
}
