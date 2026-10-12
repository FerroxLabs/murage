// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How every table added in 1.0.2 lives and dies. The LIST of added tables is APP_SCHEMA_102_ADDITIONS.tables
// (installation-app-schema-downgrade.ts): the downgrade drops it and the installation snapshot accepts it. This is the map beside it that says what
// happens to each table's rows, with one required entry per listed table (server/added-table-lifecycle.test.ts fails when one is missing,
// when an entry names a table that is not listed, or when an entry is never run):
//   - child: rows belong to a room request; the definition carries REFERENCES room_requests(id) ON DELETE CASCADE, and
//     `sweepAddedOrphans` removes what the cascade cannot reach (a connection with foreign keys off, a restored file);
//   - retained: rows are kept on purpose and pruned by the named function;
//   - marker: derived data, a flag or a record with no growth, or rows removed by a trigger, with the reason.
import type { DatabaseSync } from "node:sqlite";

export type Lifecycle =
  | { kind: "child"; parent: "room_requests"; column: string; /** the definition new databases get (carries the cascade) */ ddl: string; /** definitions earlier 1.0.2 builds wrote: still accepted in an archive, rebuilt once on open */ legacyDdl: readonly string[] }
  | { kind: "retained"; by: string }
  | { kind: "marker"; reason: string };

const derived = (what: string): Lifecycle => ({ kind: "marker", reason: `derived ${what}, rebuilt from the transcript` });
const trigger = (name: string): Lifecycle => ({ kind: "marker", reason: `rows are kept and removed by the ${name} triggers with the request they follow` });

export const ADDED_TABLE_LIFECYCLE: Readonly<Record<string, Lifecycle>> = {
  branch_walk: derived("branch index"),
  card_branch: derived("card index"),
  open_card: derived("card index"),
  turn_first: derived("turn index"),
  transcript_index_state: derived("index marker"),
  owner_deleted_threads: { kind: "marker", reason: "the owner's recorded deletions, a few small rows kept so a deleted conversation is never brought back" },
  owner_sends: { kind: "retained", by: "pruneResolved" },
  pending_delegations: { kind: "marker", reason: "a row lives until its hand-off finishes and is removed with it" },
  pending_delegations_import: { kind: "marker", reason: "one row: the one-time import of the older queue file" },
  restore_holds: { kind: "marker", reason: "holds a restore keeps until the owner decides, cleared by that decision" },
  send_restore_generation: { kind: "marker", reason: "one counter row" },
  room_request_backfills: { kind: "marker", reason: "one marker per upgrade step" },
  room_request_dismissal_receipts: trigger("room_request_dismissal"),
  room_request_owed: trigger("room_request_owed"),
  room_request_retry: trigger("room_request_retry"),
  shared_request_events: {
    kind: "child", parent: "room_requests", column: "request_id",
    ddl: "CREATE TABLE IF NOT EXISTS shared_request_events (request_id TEXT PRIMARY KEY REFERENCES room_requests(id) ON DELETE CASCADE, event_id TEXT NOT NULL)",
    legacyDdl: ["CREATE TABLE shared_request_events (request_id TEXT PRIMARY KEY, event_id TEXT NOT NULL)"],
  },
  project_card_delivery_owed: {
    kind: "child", parent: "room_requests", column: "request_id",
    ddl: "CREATE TABLE IF NOT EXISTS project_card_delivery_owed (request_id TEXT PRIMARY KEY REFERENCES room_requests(id) ON DELETE CASCADE, payload TEXT, created_at INTEGER NOT NULL)",
    legacyDdl: ["CREATE TABLE project_card_delivery_owed (request_id TEXT PRIMARY KEY, payload TEXT, created_at INTEGER NOT NULL)"],
  },
};

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const tableSql = (db: DatabaseSync, name: string): string | undefined => (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as { sql: string } | undefined)?.sql;
const hasTable = (db: DatabaseSync, name: string): boolean => tableSql(db, name) !== undefined;

/** Creates a child table with the definition that carries the cascade. A table an earlier build made without it is rebuilt once under its own
 * name, keeping only the rows whose request still exists (the others belonged to a request already gone). */
export function ensureChildTable(db: DatabaseSync, name: string): void {
  const entry = ADDED_TABLE_LIFECYCLE[name];
  if (!entry || entry.kind !== "child") throw new Error(`${name} is not a registered child table`);
  const current = tableSql(db, name);
  if (current === undefined) { db.exec(entry.ddl); return; }
  if (/REFERENCES\s+room_requests/i.test(current)) return;
  // the parent may be absent in a database that never had projects: nothing then belongs to a request
  const keep = hasTable(db, entry.parent) ? ` WHERE EXISTS (SELECT 1 FROM ${entry.parent} p WHERE p.id=o.${entry.column})` : " WHERE 0";
  db.exec("SAVEPOINT child_table_rebuild");
  try {
    const old = `${name}__old`;
    db.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(old)}`);
    db.exec(entry.ddl.replace("IF NOT EXISTS ", ""));
    const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => quote(column.name));
    db.exec(`INSERT INTO ${quote(name)}(${columns.join(",")}) SELECT ${columns.map(column => `o.${column}`).join(",")} FROM ${quote(old)} o${keep}`);
    db.exec(`DROP TABLE ${quote(old)}`);
    db.exec("RELEASE child_table_rebuild");
  } catch (error) { db.exec("ROLLBACK TO child_table_rebuild"); db.exec("RELEASE child_table_rebuild"); throw error; }
}

/** Removes the rows of every child table whose request is gone. The cascade does this on a connection with foreign keys on; this is for the
 * rest (foreign keys off, a restored file, an earlier build's table). Called wherever requests are removed (pruning, project deletion). */
export function sweepAddedOrphans(db: DatabaseSync): number {
  let removed = 0;
  for (const [name, entry] of Object.entries(ADDED_TABLE_LIFECYCLE)) {
    if (entry.kind !== "child" || !hasTable(db, name) || !hasTable(db, entry.parent)) continue;
    removed += Number(db.prepare(`DELETE FROM ${quote(name)} WHERE NOT EXISTS (SELECT 1 FROM ${quote(entry.parent)} p WHERE p.id=${quote(name)}.${quote(entry.column)})`).run().changes);
  }
  return removed;
}
