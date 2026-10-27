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

/** The tables 1.0.4 adds to messages.db: the Flux number hold of a thread (message-tables.ts, flux-capture-hold.ts) and the place of the number
 * scrub (memory/scrub-state.ts SCRUB_PASS_TABLE). No older build reads or keeps them, so every downgrade drops both (schema.ts
 * UPGRADE_DERIVED_TABLES); the next newer start makes them again, and the scrub, having no pass row, runs again (it is idempotent). */
export const UPGRADE_104_TABLES = ["flux_capture_hold", "upgrade_scrub_pass"] as const;

/** The table 1.0.8 adds to messages.db: the delivery authority of a project routine's queued request (project-tables.ts, project-routines.ts).
 * No older build reads it, and a request without its row asks again (the authority is never assumed), so every downgrade drops it with the rows of
 * UPGRADE_104_TABLES; the next newer start makes it again empty, as a restore leaves it. */
export const UPGRADE_108_TABLES = ["project_routine_authority"] as const;

/** Tables an earlier preview of 1.0.2 wrote and this build no longer reads: derived data, never trusted, dropped by every start (ensureUpgradeAppTables)
 * and by the downgrade, and accepted by the archive inspector in exactly the shapes those previews wrote, so an archive of a preview file restores. The
 * proofs of large root sets were kept here; they now live in the process only (replay-lineage.ts). */
export const LEGACY_ROOT_SET_PROOFS_TABLE = "upgrade_root_set_proofs";
export const LEGACY_ROOT_SET_PROOFS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${LEGACY_ROOT_SET_PROOFS_TABLE}(
  set_id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL, lineage_stamp TEXT NOT NULL, cursor INTEGER NOT NULL, after_key TEXT NOT NULL DEFAULT '') WITHOUT ROWID`;
/** The columns a later preview appended to the legacy tables (an earlier preview's table lacks them). */
/** The card index's branch tables of the first 1.0.2 previews: the branch index (branch-index.ts) answers what they did, exactly, so they are dropped. */
export const LEGACY_CARD_BRANCH_SCHEMA = `CREATE TABLE IF NOT EXISTS card_branch(thread_id TEXT NOT NULL, card_id TEXT NOT NULL, leaf_id TEXT NOT NULL, on_branch INTEGER NOT NULL, PRIMARY KEY(thread_id, card_id)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS card_branch_leaf ON card_branch(thread_id, leaf_id)`;
export const LEGACY_BRANCH_WALK_SCHEMA = `CREATE TABLE IF NOT EXISTS branch_walk(thread_id TEXT PRIMARY KEY, leaf_id TEXT NOT NULL, cursor_id TEXT, pos INTEGER, found TEXT NOT NULL) WITHOUT ROWID`;
export const LEGACY_UPGRADE_TABLES: ReadonlyMap<string, { schema: string; optional: string[] }> = new Map([
  [LEGACY_ROOT_SET_PROOFS_TABLE, { schema: LEGACY_ROOT_SET_PROOFS_SCHEMA, optional: ["after_key"] }],
  ["card_branch", { schema: LEGACY_CARD_BRANCH_SCHEMA, optional: [] }],
  ["branch_walk", { schema: LEGACY_BRANCH_WALK_SCHEMA, optional: [] }],
]);
export function dropLegacyUpgradeTables(db: DatabaseSync): void { for (const table of LEGACY_UPGRADE_TABLES.keys()) db.exec(`DROP TABLE IF EXISTS ${table}`); }

export function ensureRootSetWorklist(db: DatabaseSync): void { db.exec(ROOT_SET_WORKLIST_SCHEMA); }
export function ensureAppWriteRevision(db: DatabaseSync): void { db.exec(APP_WRITE_REVISION_SCHEMA); }
export function ensureDirectTurnInflight(db: DatabaseSync): void { db.exec(DIRECT_TURN_INFLIGHT_SCHEMA); }
export function ensureUpgradeAppTables(db: DatabaseSync): void { ensureRootSetWorklist(db); ensureAppWriteRevision(db); ensureDirectTurnInflight(db); dropLegacyUpgradeTables(db); }
