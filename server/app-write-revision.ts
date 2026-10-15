// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One number that moves whenever a table the upgrade screen counts changes (messages, conversations, memory records, receipts), kept in the
// app_write_revision table of messages.db. The counts worker reads it in the SAME read transaction as the counts, so a figure is exactly the
// state of the file at (epoch, n); the cached figures of an earlier launch are valid only for an equal (epoch, n). The counter is moved by TEMP
// triggers that every connection that writes those tables installs (installWriteRevisionTriggers); anything that replaces or rewrites the file as a
// whole (restore, import, a migration) writes a new epoch instead (bumpWriteEpoch). Sizes and modification times are not revisions: a rewritten file
// can keep both.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { APP_WRITE_REVISION_TABLE, ensureAppWriteRevision } from "./memory/upgrade-app-tables.ts";

/** The tables whose rows the upgrade screen counts (or whose first date it shows). */
export const COUNTED_TABLES = ["messages", "thread_state", "memory_records", "memory_disclosures"] as const;

/** Creates the table and its one row when they are missing. */
export function ensureWriteRevision(db: DatabaseSync): void {
  ensureAppWriteRevision(db);
  db.prepare(`INSERT OR IGNORE INTO ${APP_WRITE_REVISION_TABLE}(id,epoch,n) VALUES(1,?,0)`).run(randomUUID());
}

/** The file was replaced or rewritten as a whole: every cached figure is void. */
export function bumpWriteEpoch(db: DatabaseSync): void {
  ensureWriteRevision(db);
  db.prepare(`UPDATE ${APP_WRITE_REVISION_TABLE} SET epoch=?,n=0 WHERE id=1`).run(randomUUID());
}

/** Removes this connection's triggers (a downgrade drops the table they write to; a trigger left behind would fail every later counted write). */
export function dropWriteRevisionTriggers(db: DatabaseSync): void {
  for (const table of COUNTED_TABLES) for (const kind of ["insert", "delete"]) db.exec(`DROP TRIGGER IF EXISTS temp.app_rev_${table}_${kind}`);
  db.exec("DROP TRIGGER IF EXISTS temp.app_rev_messages_at");
}

/** Installs (once per connection) the temporary triggers that move the counter. Temporary: they live and die with the connection, so the file itself
 * gains no object an older build would have to know about. A counted table that is not there yet is skipped (the next open installs it). */
export function installWriteRevisionTriggers(db: DatabaseSync): void {
  ensureWriteRevision(db);
  const bump = `UPDATE ${APP_WRITE_REVISION_TABLE} SET n=n+1 WHERE id=1;`;
  for (const table of COUNTED_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue;
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS app_rev_${table}_insert AFTER INSERT ON main.${table} BEGIN ${bump} END;
      CREATE TEMP TRIGGER IF NOT EXISTS app_rev_${table}_delete AFTER DELETE ON main.${table} BEGIN ${bump} END;`);
  }
  // the date of the first message moves when a row's time is rewritten
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get()) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS app_rev_messages_at AFTER UPDATE OF at ON main.messages BEGIN ${bump} END;`);
  }
}
