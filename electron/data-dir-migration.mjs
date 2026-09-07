import { lstatSync, renameSync } from "node:fs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";

export class DataDirMigrationError extends Error {
  name = "DataDirMigrationError";
  code = "PERSISTED_STATE_RECOVERY_REQUIRED";

  constructor(filePath, reason, error) {
    super("Legacy Murage migration could not finish safely. Saved data was preserved; stop other instances and check paths or permissions before retrying.");
    this.filePath = filePath;
    this.reason = reason;
    if (typeof error?.code === "string") this.readErrorCode = error.code;
    // Never retain raw filesystem/lease errors, which can contain private
    // paths, parser snippets or lease capabilities.
  }
}

function entry(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new DataDirMigrationError(path, "unreadable", error);
  }
}

/** Caller already holds the canonical target installation lease. Explicit
 * directory overrides disable automatic migration. Never create the target
 * here, never follow a legacy symlink, and never replace an existing target.
 * Older binaries without the lease protocol must be stopped before upgrade. */
export function migrateLegacyDataDirectory({ dataDir, legacyDataDir, enabled }) {
  if (!enabled) return false;
  if (entry(dataDir)) return false;
  const original = entry(legacyDataDir);
  if (!original) return false;
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new DataDirMigrationError(legacyDataDir, "invalid-shape");
  }

  let sourceLease;
  try { sourceLease = acquireDataDirLease(legacyDataDir); }
  catch (error) { throw new DataDirMigrationError(legacyDataDir, "migration-failed", error); }

  let failure;
  try {
    // Acquiring the source lease may cross filesystem work. Refuse a changed
    // source/target instead of moving a replacement beneath the held leases.
    const current = entry(legacyDataDir);
    if (entry(dataDir) || !current?.isDirectory() || current.isSymbolicLink() ||
        current.dev !== original.dev || current.ino !== original.ino) {
      throw new DataDirMigrationError(legacyDataDir, "invalid-shape");
    }
    renameSync(legacyDataDir, dataDir);
  } catch (error) {
    failure = error instanceof DataDirMigrationError
      ? error : new DataDirMigrationError(legacyDataDir, "migration-failed", error);
  } finally {
    try { sourceLease.release(); }
    catch (error) { failure ??= new DataDirMigrationError(legacyDataDir, "migration-failed", error); }
  }
  if (failure) throw failure;
  return true;
}
