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
  // the branch index, the line index and the keyed indexes (branch-index.ts, keyed-cards.ts, message-image-paths.ts): small tables the message writers keep and a thread's fill builds
  thread_key: derived("branch index (a number per thread and how far its fill has got)"),
  seg: derived("branch index (segments of a thread's branches)"),
  msg_branch: derived("branch index (the segment and order of a row)"),
  fill_pending: derived("branch index (rows waiting for their parent during a fill)"),
  line: derived("line index (the rows a prompt reads, by class)"),
  branch_change: { kind: "marker", reason: "a branch move whose memory sources are still being flipped, in slices; the row is removed when the last slice commits" },
  message_image: derived("image index"),
  attachment_name: derived("attachment-name index"),
  keyed_card: derived("keyed card index"),
  open_card: derived("card index"),
  turn_first: derived("turn index"),
  transcript_index_state: derived("index marker"),
  owner_deleted_threads: { kind: "marker", reason: "the owner's recorded deletions, a few small rows kept so a deleted conversation is never brought back" },
  held_notice_lines: { kind: "marker", reason: "one row per held hand-off line, written with the line and removed with it when the owner sends it again or dismisses it" },
  owner_sends: { kind: "retained", by: "pruneResolved" },
  app_write_revision: { kind: "marker", reason: "one counter row the counts worker reads with the counts" },
  browser_check_pending: derived("pending browser-check index"),
  direct_turn_inflight: derived("in-flight direct-turn index"),
  // a turn's sources as ranges (turn-source-holds.ts): which lines are copies of which, kept and removed by its triggers with the rows they
  // follow; and the hold log, one small row per withheld, forgotten or replaced line, never removed so a range's starting entry stays exact
  turn_source_copies: trigger("turn_source_copy"),
  turn_source_holds: { kind: "marker", reason: "one small row per line withheld, forgotten or replaced; kept so every turn's starting entry in the log stays exact" },
  pending_delegations: { kind: "marker", reason: "a row lives until its hand-off finishes and is removed with it" },
  pending_delegations_import: { kind: "marker", reason: "one row: the one-time import of the older queue file" },
  // 1.0.9 phone tools and share and ask (server/phones/): small tables made only while the flag is on
  phone_registrations: { kind: "marker", reason: "one row per phone, replaced by its next report and removed when the phone is removed" },
  phone_revocations: { kind: "marker", reason: "one small row per removed or switched-off phone, kept so it stays refused" },
  phone_ask_revocations: { kind: "marker", reason: "one row per phone: the highest ask generation refused, which only ever grows" },
  phone_receipts: { kind: "retained", by: "RETAIN_MS" },
  restore_holds: { kind: "marker", reason: "holds a restore keeps until the owner decides, cleared by that decision" },
  send_restore_generation: { kind: "marker", reason: "one counter row" },
  room_request_backfills: { kind: "marker", reason: "one marker per upgrade step" },
  room_request_dismissal_receipts: trigger("room_request_dismissal"),
  room_request_owed: trigger("room_request_owed"),
  room_request_retry: trigger("room_request_retry"),
  // shared fairness (shared-ready.ts, pm-sends): one row per (bot, team) kept and removed by the shared_ready triggers with the requests they
  // follow, and the drain sweep's one position row
  shared_ready_teams: trigger("shared_ready"),
  shared_drain_sweep: { kind: "marker", reason: "one row: where the sweep of waiting teams goes on from" },
  // bot email (server/email/email-store.ts), 1.0.9: created only when email is in use
  email_bindings: { kind: "marker", reason: "one row per bot with an email address; replaced by a tombstone when the address is removed" },
  email_sends: { kind: "marker", reason: "one row per email a bot wrote; settled rows are pruned by EmailStore.pruneSettledSends, open rows never" },
  email_payloads: { kind: "marker", reason: "the frozen bytes of an email, removed by EmailStore.pruneSettledSends 30 days after the send settles" },
  email_events: { kind: "marker", reason: "a cache of Flux email events for dedupe and reconcile, pruned by EmailStore.pruneEvents" },
  email_event_cursor: { kind: "marker", reason: "one row per event stream: where the long-poll reader goes on from" },
  email_policy_sync: { kind: "marker", reason: "one row per bot: the email setting still to be written to Flux, confirmed in place" },
  email_trust: { kind: "marker", reason: "one row per (bot, address) the owner sent to: the earned-trust counter, a bounded list of times" },
  email_trusted: { kind: "marker", reason: "the owner's exact-address trusted list and block list per bot, changed only by the owner" },
  email_tombstones: { kind: "marker", reason: "removal intents and tombstones of email addresses; removed ones are pruned after 30 days by EmailStore.pruneTombstones" },
  shared_request_events: {
    kind: "child", parent: "room_requests", column: "request_id",
    ddl: "CREATE TABLE IF NOT EXISTS shared_request_events (request_id TEXT PRIMARY KEY REFERENCES room_requests(id) ON DELETE CASCADE, event_id TEXT NOT NULL)",
    legacyDdl: ["CREATE TABLE shared_request_events (request_id TEXT PRIMARY KEY, event_id TEXT NOT NULL)"],
  },
  room_request_status: {
    kind: "child", parent: "room_requests", column: "request_id",
    ddl: "CREATE TABLE IF NOT EXISTS room_request_status (request_id TEXT PRIMARY KEY REFERENCES room_requests(id) ON DELETE CASCADE, status_key TEXT NOT NULL, status_data TEXT, diagnostic TEXT)",
    legacyDdl: [],
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
