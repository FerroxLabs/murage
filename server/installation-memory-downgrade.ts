import { downgradeTranscriptSeqTo102 } from "./transcript-seq.ts";
import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { downgradePushRetentionIndexesTo102 } from "./mobile-push-store.ts";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { downgradeMemorySchema, type MemoryDowngradeTarget } from "./memory/schema.ts";
import { downgradeMemoryIndexFile } from "./memory/age-index.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { writeFileAtomic } from "./atomic.ts";
import { foldRoutineStateForDowngrade } from "./routine-runs-journal.ts";

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
 * writes again (data-dir-inventory.ts says why each is never restored): the repairs note (the repairs run again and change nothing), the
 * model catch-up marker (re-queues only records still owed), this month's "Leave paused" choice (the item is asked again), the kept login-shell
 * environment (the next capture writes it), approvals still waiting for their answer (asked again; none was ever a grant) and the
 * first-run backup record (missing means not owed). The Cloud-only names are never on a desktop that reinstalls 1.0.2. */
export const DATA_DIR_NAMES_AFTER_102 = ["env", "learning-paused-left.json", "memory-model-adopted.json", "memory-model-adopted.json.tmp", "memory-repairs.json", "pending-grants.json", "setup-backup.json"] as const;
/** Removes those names from the data folder (a link is removed, never followed). Idempotent; returns the names removed. */
export function removeDataDirNamesAfter102(root: string): string[] {
  const removed: string[] = [];
  for (const name of DATA_DIR_NAMES_AFTER_102) {
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
 * older; 2: 0.1.54 to 0.1.60; 3 and 4: development builds; 5: before the 1.0 lineage tables; 6: 1.0.0 and 1.0.1; 7: before the 1.0.2 revocation index; 8: before the 1.0.2 cold-lineage indexes; 9: the 1.0.2 RC; 10: 1.0.2, which refuses the derived objects 1.0.3 adds) and folds the WAL so the file stands alone.
 * Chat history and memory rows are kept; only derived or learning-only
 * objects are dropped. The pre-upgrade copies are left untouched. Routine
 * state lines are folded into routines.json first (foldRoutineStateForDowngrade),
 * also when there is no memory database yet. */
/** The memory schema versions `memory-downgrade --to` accepts (10: 1.0.2). */
export const MEMORY_DOWNGRADE_TARGETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const satisfies readonly MemoryDowngradeTarget[];
export function downgradeInstallationMemorySchema(dataDir: string, to: MemoryDowngradeTarget = 1) {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const file = join(root, "messages.db");
  const stat = existsSync(file) ? lstatSync(file) : null;
  const hasDatabase = Boolean(stat?.isFile() && !stat.isSymbolicLink());
  const routines = join(root, "routines.json");
  if (!hasDatabase && !existsSync(routines)) fail("MEMORY_DATABASE_MISSING");
  const lease = acquireDataDirLeaseForProcess(root);
  try {
    // Routines first (1.0.2 bgwork): an older release reads only routines.json and plain journal lines, so every
    // cursor a routine state line moved is folded in before it can see the schedule (no occurrence runs twice).
    foldRoutineStateForDowngrade(routines);
    if (!hasDatabase) fail("MEMORY_DATABASE_MISSING");
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      // Going back to a build before 1.0.2: its waiting handoffs return to delegations.json (the file it reads), the ones whose turn was taken are
      // receipted as interrupted, and every application object 1.0.1 does not know leaves (installation-app-schema-downgrade.ts), all before the memory step.
      // every older build lacks messages.seq and its index (1.0.3): they leave first, whatever the target (transcript-seq.ts)
      downgradeTranscriptSeqTo102(db);
      // every older build lacks the push retention indexes (1.0.3): they leave first, whatever the target (mobile-push-store.ts)
      downgradePushRetentionIndexesTo102(db);
      const app = to <= 6 ? downgradeApplicationSchemaTo101(db, dirname(file)) : { exported: 0, interrupted: 0, dropped: 0, rebuilt: 0 };
      // before the memory step, so a stopped run finds the marker again and does it again
      if (to < 10 && reclaimHasRun(db)) resetRetainedSessionCursors(dirname(file));
      const result = downgradeMemorySchema(db, to);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      // 1.0.3 lane 2: the search index file goes back to what 1.0.2 wrote (its second word table and the lane's markers leave; a renamed
      // word table with age rowids stays, 1.0.2 reads it by rowid and by rank and is correct either way).
      downgradeMemoryIndexFile(join(root, "memory-index.db"));
      // 1.0.3's own notes at the root leave last, once the database is back in an older shape (a stopped run does this again)
      removeDataDirNamesAfter102(root);
      return app.exported || app.interrupted ? { ...result, handoffs: app.exported, handoffsStarted: app.interrupted } : result;
    } finally { db.close(); }
  } finally { lease.release(); }
}
