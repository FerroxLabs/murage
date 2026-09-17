import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { downgradeMemorySchema } from "./memory/schema.ts";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** One-shot maintenance for reinstalling a 0.1.x build on a data dir that a
 * later Murage already migrated to memory schema v2. Takes the same exclusive
 * lease as the running app (so it refuses while Murage is open), rewrites the
 * memory objects to the frozen v1 shape and folds the WAL so the file stands
 * alone. Chat history and memory rows are kept; only v2 learning details and
 * the learning policy are dropped. The pre-upgrade copy is left untouched. */
export function downgradeInstallationMemorySchema(dataDir: string) {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const file = join(root, "messages.db");
  const stat = existsSync(file) ? lstatSync(file) : null;
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("MEMORY_DATABASE_MISSING");
  const lease = acquireDataDirLeaseForProcess(root);
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const result = downgradeMemorySchema(db);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      return result;
    } finally { db.close(); }
  } finally { lease.release(); }
}
