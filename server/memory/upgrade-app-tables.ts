// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The tables of messages.db that only 1.0.2 writes and that belong to the app, not to the memory schema (their names do not start with memory_, so
// the exact-schema check of the memory tables never sees them). One list, so the archive inspector (installation-database-snapshot.ts), the
// downgrade (schema.ts UPGRADE_DERIVED_TABLES) and the shared 1.0.2 additions registry all name the same objects. A leaf module: no imports from
// the memory schema.
import type { DatabaseSync } from "node:sqlite";

/** The root sets the conversion has still to look at, in the order it looks at them (thread, size, id): filled in bounded slices from the reply and
 * session roots, read by keyset seek (no sort), and emptied behind the conversion's cursor. */
export const ROOT_SET_WORKLIST_TABLE = "upgrade_root_set_worklist";
export const ROOT_SET_WORKLIST_SCHEMA = `CREATE TABLE IF NOT EXISTS ${ROOT_SET_WORKLIST_TABLE}(
  thread_id TEXT NOT NULL, size INTEGER NOT NULL, set_id TEXT NOT NULL, PRIMARY KEY(thread_id,size,set_id)) WITHOUT ROWID`;

/** One row: a counter that moves whenever a counted table changes (messages, threads, ...), and an epoch that moves when the file is replaced as a
 * whole (restore, import, downgrade). The exact counts of the upgrade screen are valid only for the (epoch, n) they were read under. */
export const APP_WRITE_REVISION_TABLE = "app_write_revision";
export const APP_WRITE_REVISION_SCHEMA = `CREATE TABLE IF NOT EXISTS ${APP_WRITE_REVISION_TABLE}(
  id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, n INTEGER NOT NULL)`;

/** A direct (non-memory) turn that was admitted and has not settled: written when the turn starts, removed when it ends. A start after a crash reads
 * only this table to find the turns to mark interrupted, never the conversation history. */
export const DIRECT_TURN_INFLIGHT_TABLE = "direct_turn_inflight";
export const DIRECT_TURN_INFLIGHT_SCHEMA = `CREATE TABLE IF NOT EXISTS ${DIRECT_TURN_INFLIGHT_TABLE}(
  thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at INTEGER NOT NULL, PRIMARY KEY(thread_id,turn_id)) WITHOUT ROWID`;

/** Every table above, for the downgrade and the inspector. */
export const UPGRADE_APP_TABLES = [ROOT_SET_WORKLIST_TABLE, APP_WRITE_REVISION_TABLE, DIRECT_TURN_INFLIGHT_TABLE] as const;

export function ensureRootSetWorklist(db: DatabaseSync): void { db.exec(ROOT_SET_WORKLIST_SCHEMA); }
export function ensureAppWriteRevision(db: DatabaseSync): void { db.exec(APP_WRITE_REVISION_SCHEMA); }
export function ensureDirectTurnInflight(db: DatabaseSync): void { db.exec(DIRECT_TURN_INFLIGHT_SCHEMA); }
export function ensureUpgradeAppTables(db: DatabaseSync): void { ensureRootSetWorklist(db); ensureAppWriteRevision(db); ensureDirectTurnInflight(db); }
