// The harness's own record of the first run's backup step (Settings L5).
//
// One file in the data folder, written by the harness only. It holds two
// facts that must outlive the desktop's own files: whether this data folder
// owes the first-run backup at all (written once, when setup starts on a
// folder that has never had backups), and how that step ended. The desktop
// reads it, never writes it: a lost desktop record cannot reopen an ending
// recorded here, and a missing record here means "not owed", so an install
// that predates the first-run backup is never held.
//
// Shared because the harness (server/setup-backup.ts) writes it and the
// desktop host (electron/backup-schedule-host.mjs) reads it, and neither can
// import the other.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const SETUP_BACKUP_FILE_NAME = "setup-backup.json";
export const SETUP_BACKUP_MAX_BYTES = 4 * 1024;
const ENDINGS = [null, "verified", "off"];

/** The record, or null for anything that is not exactly one. */
export function parseSetupBackupRecord(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "at,ending,owed,version") return null;
  if (value.version !== 2 || typeof value.owed !== "boolean" || !ENDINGS.includes(value.ending) || !Number.isSafeInteger(value.at) || value.at < 0) return null;
  return { version: 2, owed: value.owed, ending: value.ending, at: value.at };
}

/** Reads the record kept in `dataDir`: missing, unreadable, or the record. */
export function readSetupBackupRecord(dataDir) {
  const file = path.join(dataDir, SETUP_BACKUP_FILE_NAME);
  let stat;
  try { stat = lstatSync(file); } catch (error) { return error?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SETUP_BACKUP_MAX_BYTES) return { kind: "unreadable" };
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return { kind: "unreadable" }; }
  const record = parseSetupBackupRecord(text);
  return record ? { kind: "record", record } : { kind: "unreadable" };
}
