// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RESTORE-PARK r3.1 section 5. A Cloud reset or undo (murage-commands restore_into_place) writes a `restore_pending` row into the staged
// messages.db; this consumes it once at boot, before anything reads email rows. One transaction: a crash leaves either the marker and the
// old rows, or neither, so the next boot redoes the work or has nothing to do.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareRestoredEmail } from "./restore.ts";
import { bumpWriteEpoch } from "../app-write-revision.ts";

/** True when a marker was found and consumed. A missing database is never created; an unmarked one is not touched. */
export function consumeRestoreMarker(dataDir: string, hooks: { prepare?: (db: DatabaseSync) => unknown } = {}): boolean {
  const file = join(dataDir, "messages.db");
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_pending'").get()) { db.exec("ROLLBACK"); return false; }
      (hooks.prepare ?? prepareRestoredEmail)(db);
      // M6 (J4): when an owner restore job swapped this database in, the job's boot recovery would prepare it again (a second re-key of the parks). The job's prepared
      // mark is written here, inside the same transaction, so recovery sees the preparation done. A Cloud reset no job swapped in has no swapped mark and gets none.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_job_marks'").get()) {
        const swapped = db.prepare("SELECT job_id FROM restore_job_marks WHERE kind='swapped'").get() as { job_id: string } | undefined;
        if (swapped) db.prepare("INSERT OR REPLACE INTO restore_job_marks (kind, job_id) VALUES ('prepared', ?)").run(swapped.job_id);
      }
      // the swapped-in file is a different file from any whose figures were cached: a new epoch, in the same transaction as the preparation
      bumpWriteEpoch(db);
      db.exec("DROP TABLE IF EXISTS restore_boot_wait");
      db.exec("DROP TABLE IF EXISTS restore_pending");
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  } finally {
    db.close();
  }
}
