// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email after a restore (BOT-EMAIL-MURAGE-109 section 7, F23; restore-park r3.1 section 3). Runs inside the restore preparation's transaction on the
// restored database. Every live binding lands in `restored_unverified`: no polling, no tools, no sends until the owner's "Reconnect email" re-obtains
// the owner credential, lists #4, matches bot_id and mints a new email key. A removal in flight or queued is PARKED: an `email_parks` row (the only place a
// park is ever INSERTed) and the binding in `removal_parked`. Nothing re-runs a parked removal: not boot, settle, tick, reconnect or events. Keep address
// brings the inbox back, and only the owner's Remove after the restore resumes it. Event cursors are dropped (the restored install re-lists after
// Reconnect); send receipts stay so open rows reconcile against #19 and #20, and a held row whose payload was not carried shows "This email was waiting
// before the restore" with Don't send only.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const EMAIL_PARKS_DDL = `CREATE TABLE IF NOT EXISTS email_parks (bot_id TEXT PRIMARY KEY, park_id TEXT NOT NULL, park_rev INTEGER NOT NULL, state TEXT NOT NULL, inbox_id TEXT, address TEXT, key_id TEXT, binding_op_id TEXT, prior_state TEXT, keep_op TEXT, keep_covers TEXT, keep_failure TEXT, remote_deleted_at INTEGER, authorized_by TEXT, authorized_at INTEGER, parked_at INTEGER NOT NULL)`;

const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
type Raw = Record<string, unknown>;

/** The one INSERT of a park row (3.1 step 3): fresh id and revision 0, keep and authorization fields cleared; remote_deleted_at kept from `existing`. */
function insertPark(db: DatabaseSync, botId: string, binding: Raw | undefined, existing: Raw | undefined, tomb: Raw | undefined, now: number): void {
  const pick = (...values: unknown[]) => values.find(value => value !== undefined && value !== null) ?? null;
  const inboxId = binding ? pick(binding.inbox_id, existing?.inbox_id, tomb?.inbox_id) : pick(existing?.inbox_id, tomb?.inbox_id);
  const keyId = binding ? pick(binding.email_key_ref, existing?.key_id, tomb?.key_id) : pick(existing?.key_id, tomb?.key_id);
  const address = binding ? pick(binding.address, existing?.address) : pick(existing?.address);
  db.prepare("INSERT OR REPLACE INTO email_parks (bot_id, park_id, park_rev, state, inbox_id, address, key_id, binding_op_id, prior_state, keep_op, keep_covers, keep_failure, remote_deleted_at, authorized_by, authorized_at, parked_at) VALUES (?,?,0,'parked',?,?,?,?,?,NULL,NULL,NULL,?,NULL,NULL,?)")
    .run(botId, randomUUID(), inboxId as string | null, address as string | null, keyId as string | null, (binding?.op_id ?? existing?.binding_op_id ?? null) as string | null, (binding?.state ?? existing?.prior_state ?? null) as string | null, (existing?.remote_deleted_at ?? null) as number | null, now);
}

/** Returns how many bindings now wait for Reconnect. A database without the email tables (email never on) is not touched. */
export function prepareRestoredEmail(db: DatabaseSync, now: number = Date.now()): number {
  if (!hasTable(db, "email_bindings")) return 0;
  // the table first, so a pre-1.0.19 archive gains it inside the same transaction (Fable F3, Astra 5)
  db.exec(EMAIL_PARKS_DDL);
  const bindings = new Map((db.prepare("SELECT * FROM email_bindings").all() as Raw[]).map(row => [String(row.bot_id), row]));
  const parks = new Map((db.prepare("SELECT * FROM email_parks").all() as Raw[]).map(row => [String(row.bot_id), row]));
  const tombs = hasTable(db, "email_tombstones") ? (db.prepare("SELECT * FROM email_tombstones WHERE state<>'removed'").all() as Raw[]) : [];
  // a removal in flight or queued at backup time is parked: a removing, remove_requested or removal_parked binding, a bot-deletion intent that is not
  // removed (committed or not; the H1 case where the binding was active), or a park row the archive already holds in any state
  const parked = new Map<string, { tomb?: Raw }>();
  // r3.4d guards across restore (reducer restore prep lines 373, 389, 397): a Keep that holds a guard wins over a removal in flight, so that binding and its intents are not parked
  const guarded = new Set<string>();
  if (hasTable(db, "email_event_cursor")) for (const r of db.prepare("SELECT scope FROM email_event_cursor WHERE scope LIKE 'keepguard:%'").all() as Array<{ scope: string }>) guarded.add(r.scope.slice("keepguard:".length));
  const isGuarded = (row: Raw | undefined) => Boolean(row && typeof row.inbox_id === "string" && guarded.has(row.inbox_id));
  for (const [botId, row] of bindings) if (row.state === "removal_parked" || ((row.state === "removing" || row.state === "remove_requested") && !isGuarded(row))) parked.set(botId, {});
  for (const tomb of tombs) {
    if (typeof tomb.inbox_id === "string" && guarded.has(tomb.inbox_id) && !parked.has(String(tomb.bot_id))) continue; const botId = String(tomb.bot_id); parked.set(botId, { ...(parked.get(botId) ?? {}), tomb: parked.get(botId)?.tomb ?? tomb }); }
  for (const botId of parks.keys()) if (!parked.has(botId)) parked.set(botId, {});
  for (const [botId, info] of parked) insertPark(db, botId, bindings.get(botId), parks.get(botId), info.tomb, now);
  db.prepare("UPDATE email_bindings SET state='removal_parked', step='restored', revision=revision+1 WHERE bot_id IN (SELECT bot_id FROM email_parks)").run();
  const moved = Number(db.prepare("UPDATE email_bindings SET state='restored_unverified', step='restored', revision=revision+1 WHERE state NOT IN ('removal_parked','restored_unverified')").run().changes);
  db.prepare("UPDATE email_bindings SET step='restored' WHERE state='restored_unverified' AND (step IS NULL OR step<>'restored')").run();
  // the long-poll cursor belonged to the old install's session; install-id and ever-enabled stay
  if (hasTable(db, "email_event_cursor")) db.prepare("DELETE FROM email_event_cursor WHERE scope NOT IN ('install-id','ever-enabled') AND scope NOT LIKE 'keptkey:%' AND scope NOT LIKE 'keepguard:%'").run(); // kept keys and keep guards are carried across a restore (keptKeysProtected, reducer restore carry line 373);
  // a restore_pending marker (Cloud reset, Batch C) is consumed by this preparation
  if (hasTable(db, "restore_pending")) db.exec("DROP TABLE restore_pending");
  return moved;
}

/** r3.4d keptKeysProtected (reducer parkBinding, restore-reducer.ts line 108): a key the owner kept is never parked again by a step other than a restore. */
export function isKeptKeyIn(db: DatabaseSync, keyId: unknown): boolean {
  if (typeof keyId !== "string" || !keyId || !hasTable(db, "email_event_cursor")) return false;
  return Boolean(db.prepare("SELECT 1 FROM email_event_cursor WHERE scope=?").get(`keptkey:${keyId}`));
}

/** 3.2: a removal_parked binding from fad83e823 or an r1/r2 backup has no park row; one is adopted at store start, before the runtime (and its TEMP trigger). One
 *  transaction, idempotent. */
export function adoptLegacyParks(db: DatabaseSync): void {
  if (!hasTable(db, "email_bindings") || !hasTable(db, "email_parks")) return;
  const rows = db.prepare("SELECT * FROM email_bindings WHERE state='removal_parked' AND bot_id NOT IN (SELECT bot_id FROM email_parks)").all() as Raw[];
  if (!rows.length) return;
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) if (!isKeptKeyIn(db, row.email_key_ref)) insertPark(db, String(row.bot_id), row, undefined, undefined, Date.now()); // a kept key is never parked again (keptKeysProtected)
    if (own) db.exec("COMMIT");
  } catch (error) { if (own) { try { db.exec("ROLLBACK"); } catch { /* already out */ } } throw error; }
}
