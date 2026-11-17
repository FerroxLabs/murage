// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux Memory spaces ledger (FLUX-SPACES-CAPTURE-FORGET-106 R4). Each bot's turns are captured into one Flux space,
// "bot:<hex HMAC of the bot id>", and every capture names its conversation in metadata.thread (hex HMAC of the thread id), so
// deleting a conversation asks Flux to forget that thread and deleting a bot deletes its space. This module keeps, in messages.db:
//   - the HMAC salt (made on first use, never leaves this computer);
//   - which (thread, key, space) each capture went to, with the bot and the thread tag, written BEFORE the request leaves;
//   - the receipts (source ids) Flux answered with, written after a 202;
//   - the forgets owed (a thread forget or a bot space DELETE), written in the deletion's own transaction (owner-deletions.ts);
//   - tombstones: a thread or space that is never captured again (permanent);
//   - the bot spaces Flux answered 429 memory_end_user_limit for, and the keys Flux Memory is off for.
// A key is only ever kept as a fingerprint. Names are computed once, at capture, and stored: a forget never recomputes them.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const DDL = [
  "CREATE TABLE IF NOT EXISTS flux_space_meta (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS flux_key_off (key_fp TEXT PRIMARY KEY, code TEXT, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS flux_mem_used (thread_id TEXT NOT NULL, key_fp TEXT NOT NULL, space TEXT NOT NULL, bot_id TEXT NOT NULL DEFAULT '', thread_tag TEXT NOT NULL DEFAULT '', first_at INTEGER NOT NULL, PRIMARY KEY(thread_id, key_fp, space))",
  "CREATE TABLE IF NOT EXISTS flux_mem_receipt (space TEXT NOT NULL, key_fp TEXT NOT NULL, thread_id TEXT NOT NULL, source_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(space, key_fp, source_id))",
  "CREATE TABLE IF NOT EXISTS flux_mem_owed (space TEXT NOT NULL, key_fp TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('thread','bot')), thread_id TEXT NOT NULL DEFAULT '', thread_tag TEXT NOT NULL DEFAULT '', bot_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL CHECK(state IN ('owed','polling')), op_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, polls INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_status INTEGER, attempt TEXT, fallback_at INTEGER, PRIMARY KEY(space, key_fp, kind, thread_tag))",
  "CREATE TABLE IF NOT EXISTS flux_mem_tombstone (kind TEXT NOT NULL CHECK(kind IN ('thread','space')), subject TEXT NOT NULL, key_fp TEXT NOT NULL DEFAULT '', code TEXT, at INTEGER NOT NULL, attempt TEXT, PRIMARY KEY(kind, subject, key_fp))",
  "CREATE TABLE IF NOT EXISTS flux_mem_limit (space TEXT NOT NULL, key_fp TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(space, key_fp))",
  // a (space, key) Flux has answered a capture 2xx for: the route is proven there, so a later 404 can only mean the space is gone
  "CREATE TABLE IF NOT EXISTS flux_mem_proven (space TEXT NOT NULL, key_fp TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(space, key_fp))",
  "CREATE INDEX IF NOT EXISTS flux_mem_owed_thread ON flux_mem_owed(kind, thread_id)",
  "CREATE INDEX IF NOT EXISTS flux_mem_owed_due ON flux_mem_owed(next_at, created_at)",
  "CREATE INDEX IF NOT EXISTS flux_mem_receipt_thread ON flux_mem_receipt(space, key_fp, thread_id, at, source_id)",
];

const tableExists = (db: DatabaseSync, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Runs `work` atomically: a savepoint inside a caller's transaction, else its own. */
function atomically<T>(db: DatabaseSync, name: string, work: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec(nested ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (error) {
    try { db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK"); } catch { /* already ended */ }
    throw error;
  }
}

/** One-time step (R4.12.1): this branch's unreleased per-conversation `thread:` spaces each become a DELETE owed of that stored
 * space, and the old tables go, in one transaction. No release ever had them. */
function migrateOldTables(db: DatabaseSync, now: number): void {
  const hasUsed = tableExists(db, "flux_space_used"), hasOwed = tableExists(db, "flux_forget_owed"), hasGen = tableExists(db, "flux_space_gen");
  if (!hasUsed && !hasOwed && !hasGen) return;
  atomically(db, "flux_mem_migrate", () => {
    const owe = db.prepare(
      "INSERT OR IGNORE INTO flux_mem_owed(space, key_fp, kind, thread_id, thread_tag, bot_id, state, op_id, attempts, polls, next_at, created_at, attempt) " +
      "VALUES(?, ?, 'bot', '', '', '', 'owed', NULL, 0, 0, ?, ?, NULL)",
    );
    for (const table of [hasUsed ? "flux_space_used" : null, hasOwed ? "flux_forget_owed" : null]) {
      if (!table) continue;
      for (const row of db.prepare(`SELECT DISTINCT space, key_fp FROM ${table}`).all() as Array<{ space: string; key_fp: string }>) {
        owe.run(String(row.space), String(row.key_fp), now, now);
      }
    }
    for (const table of ["flux_space_used", "flux_space_gen", "flux_forget_owed"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
  });
}

const ready = new WeakSet<DatabaseSync>();
export function initializeFluxSpaces(db: DatabaseSync, now: number = Date.now()): void {
  if (ready.has(db)) return;
  for (const statement of DDL) db.exec(statement);
  migrateOldTables(db, now);
  // inside a transaction the tables are only kept if it commits: remembered only outside one
  if (!db.isTransaction) ready.add(db);
}

/** The space charset FluxMain accepts. */
export const FLUX_SPACE = /^[A-Za-z0-9._:#-]{1,128}$/;
/** Forgets owed become due this long after the deletion commits (a capture in flight gets to settle first). */
export const FLUX_FORGET_GRACE_MS = 10_000;
/** A bot space Flux answered 429 memory_end_user_limit for is looked at again after this long, with one real turn. */
export const FLUX_LIMIT_RECHECK_MS = 24 * 60 * 60_000;
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/** A key's fingerprint: what the ledger keeps instead of the key. */
export function fluxKeyFingerprint(key: string): string {
  return createHash("sha256").update(`murage-flux-key:${key}`).digest("hex").slice(0, 32);
}

function salt(db: DatabaseSync): string {
  initializeFluxSpaces(db);
  const row = db.prepare("SELECT salt FROM flux_space_meta WHERE id=1").get() as { salt?: string } | undefined;
  if (typeof row?.salt === "string" && /^[0-9a-f]{64}$/.test(row.salt)) return row.salt;
  db.prepare("INSERT OR REPLACE INTO flux_space_meta(id, salt) VALUES(1, ?)").run(randomBytes(32).toString("hex"));
  return String((db.prepare("SELECT salt FROM flux_space_meta WHERE id=1").get() as { salt: string }).salt);
}

/** The bot's Flux space. A bot id cannot be read back from it. */
export function fluxBotSpace(db: DatabaseSync, botId: string): string {
  const space = `bot:${createHmac("sha256", salt(db)).update(`murage-bot\0${botId}`).digest("hex")}`;
  if (!FLUX_SPACE.test(space)) throw new Error("flux space out of charset");
  return space;
}

/** The conversation's tag in capture metadata. A thread id cannot be read back from it. */
export function fluxThreadTag(db: DatabaseSync, threadId: string): string {
  return createHmac("sha256", salt(db)).update(`murage-thread\0${threadId}`).digest("hex");
}

const tombstoned = (db: DatabaseSync, kind: "thread" | "space", subject: string, keyFp: string): boolean =>
  Boolean(db.prepare("SELECT 1 AS x FROM flux_mem_tombstone WHERE kind=? AND subject=? AND (key_fp=? OR key_fp='') LIMIT 1").get(kind, subject, keyFp));

/** Whether this thread may still be captured to Flux: no owner-deletion record, no thread tombstone and no thread forget owed. */
export function fluxThreadOpen(db: DatabaseSync, threadId: string): boolean {
  initializeFluxSpaces(db);
  if (tableExists(db, "owner_deleted_threads") && db.prepare("SELECT 1 AS x FROM owner_deleted_threads WHERE thread_id=?").get(threadId)) return false;
  if (db.prepare("SELECT 1 AS x FROM flux_mem_tombstone WHERE kind='thread' AND subject=? LIMIT 1").get(threadId)) return false;
  return !db.prepare("SELECT 1 AS x FROM flux_mem_owed WHERE kind='thread' AND thread_id=? LIMIT 1").get(threadId);
}

export interface FluxCaptureTarget { space: string; tag: string }

/** Written BEFORE a capture request leaves, in the same synchronous step as the checks: from here on deleting the thread owes a
 * thread forget in this space for this key, and deleting the bot owes a DELETE of this space. null (nothing may be sent) when the
 * bot or the thread is deleted, the space is tombstoned for this key, or the bot's space is at Flux's limit. Throws when the row
 * cannot be written. */
export function noteFluxSpaceUsed(db: DatabaseSync, threadId: string, botId: string, keyFp: string, now: number = Date.now()): FluxCaptureTarget | null {
  if (!botId || !fluxThreadOpen(db, threadId)) return null;
  if (tableExists(db, "owner_deleted_threads") && db.prepare("SELECT 1 AS x FROM owner_deleted_threads WHERE thread_id=?").get(`bot:${botId}`)) return null;
  const space = fluxBotSpace(db, botId);
  if (tombstoned(db, "space", space, keyFp)) return null;
  const limit = db.prepare("SELECT at FROM flux_mem_limit WHERE space=? AND key_fp=?").get(space, keyFp) as { at?: number } | undefined;
  if (limit && now - Number(limit.at) < FLUX_LIMIT_RECHECK_MS) return null;
  const tag = fluxThreadTag(db, threadId);
  db.prepare("INSERT OR IGNORE INTO flux_mem_used(thread_id, key_fp, space, bot_id, thread_tag, first_at) VALUES(?,?,?,?,?,?)").run(threadId, keyFp, space, botId, tag, now);
  return { space, tag };
}

/** Re-owe at once (a 2xx landed for a space or thread already tombstoned): a DONE can never stand on a forget sent before it. */
const REOWE =
  "INSERT INTO flux_mem_owed(space, key_fp, kind, thread_id, thread_tag, bot_id, state, op_id, attempts, polls, next_at, created_at, attempt) " +
  "VALUES(?, ?, ?, ?, ?, ?, 'owed', NULL, 0, 0, ?, ?, NULL) " +
  "ON CONFLICT(space, key_fp, kind, thread_tag) DO UPDATE SET state='owed', op_id=NULL, next_at=excluded.next_at";

/** Flux accepted a capture (2xx). The receipt is kept (the ids fallback forgets it); a limit on the space is lifted; the route is
 * proven for this space and key. A 2xx that lands for a tombstoned space or thread re-owes the shred or the thread forget now, and
 * the answer is true then, so the caller wakes the forget worker (Astra M1: an idle worker would otherwise sleep on it). */
export function noteFluxCaptureAccepted(db: DatabaseSync, input: { threadId: string; botId: string; keyFp: string; space: string; tag: string; sourceId: unknown }, now: number = Date.now()): boolean {
  initializeFluxSpaces(db);
  const { threadId, botId, keyFp, space, tag } = input;
  return atomically(db, "flux_mem_accepted", () => {
    db.prepare("INSERT OR IGNORE INTO flux_mem_used(thread_id, key_fp, space, bot_id, thread_tag, first_at) VALUES(?,?,?,?,?,?)").run(threadId, keyFp, space, botId, tag, now);
    db.prepare("INSERT OR IGNORE INTO flux_mem_proven(space, key_fp, at) VALUES(?,?,?)").run(space, keyFp, now);
    if (typeof input.sourceId === "string" && SOURCE_ID.test(input.sourceId)) {
      db.prepare("INSERT OR IGNORE INTO flux_mem_receipt(space, key_fp, thread_id, source_id, at) VALUES(?,?,?,?,?)").run(space, keyFp, threadId, input.sourceId, now);
    }
    db.prepare("DELETE FROM flux_mem_limit WHERE space=? AND key_fp=?").run(space, keyFp);
    const botGone = tombstoned(db, "space", space, keyFp)
      || (tableExists(db, "owner_deleted_threads") && Boolean(db.prepare("SELECT 1 AS x FROM owner_deleted_threads WHERE thread_id=?").get(`bot:${botId}`)));
    if (botGone) { db.prepare(REOWE).run(space, keyFp, "bot", "", "", botId, now, now); return true; }
    if (!fluxThreadOpen(db, threadId)) { db.prepare(REOWE).run(space, keyFp, "thread", threadId, tag, botId, now, now); return true; }
    return false;
  });
}

/** Whether Flux's spaces route is proven for this space and key: a capture there was answered 2xx before (a proof row, or a
 * receipt). Once it is, any 404 to a capture there means the space is gone (Grok M, 106 r1), never an older proxy. */
export function fluxRouteProven(db: DatabaseSync, space: string, keyFp: string): boolean {
  initializeFluxSpaces(db);
  return Boolean(db.prepare("SELECT 1 AS x FROM flux_mem_proven WHERE space=? AND key_fp=?").get(space, keyFp))
    || Boolean(db.prepare("SELECT 1 AS x FROM flux_mem_receipt WHERE space=? AND key_fp=? LIMIT 1").get(space, keyFp));
}

/** Bots whose Flux space was deleted at Flux for this key (a capture answered 404): Flux memory stays off for them. */
export function fluxSpacesGone(db: DatabaseSync, keyFp: string | null): number {
  initializeFluxSpaces(db);
  if (!keyFp) return 0;
  const row = db.prepare("SELECT COUNT(DISTINCT subject) AS n FROM flux_mem_tombstone WHERE kind='space' AND key_fp=? AND code=?").get(keyFp, FLUX_SPACE_GONE_CODE) as { n?: number } | undefined;
  return Number(row?.n) || 0;
}

/** The code a space tombstone written from a capture 404 carries. */
export const FLUX_SPACE_GONE_CODE = "memory_not_found";

/** Flux answered 409 memory_thread_forgotten to a capture: the thread is never captured again (attempt NULL: never withdrawn). */
export function tombstoneFluxThread(db: DatabaseSync, threadId: string, code: string | null, now: number = Date.now()): void {
  initializeFluxSpaces(db);
  db.prepare("INSERT OR IGNORE INTO flux_mem_tombstone(kind, subject, key_fp, code, at, attempt) VALUES('thread', ?, '', ?, ?, NULL)").run(threadId, code, now);
}

/** Flux answered 404 memory_not_found to a capture: the space was shredded (or this key has no personal memory). Never captured
 * again with this key; a late retry must not recreate it. */
export function tombstoneFluxSpace(db: DatabaseSync, space: string, keyFp: string, code: string | null, now: number = Date.now()): void {
  initializeFluxSpaces(db);
  db.prepare("INSERT OR IGNORE INTO flux_mem_tombstone(kind, subject, key_fp, code, at, attempt) VALUES('space', ?, ?, ?, ?, NULL)").run(space, keyFp, code, now);
}

/** Flux answered 429 memory_end_user_limit: that bot's space sends nothing, looked at again after 24 h with one real turn. */
export function setFluxSpaceLimit(db: DatabaseSync, space: string, keyFp: string, now: number = Date.now()): void {
  initializeFluxSpaces(db);
  db.prepare("INSERT OR REPLACE INTO flux_mem_limit(space, key_fp, at) VALUES(?,?,?)").run(space, keyFp, now);
}

/** Bots whose space is at Flux's limit for this key (Settings shows a line while there are any). */
export function fluxLimitedBots(db: DatabaseSync, keyFp: string | null): number {
  initializeFluxSpaces(db);
  if (!keyFp) return 0;
  const row = db.prepare("SELECT COUNT(DISTINCT space) AS n FROM flux_mem_limit WHERE key_fp=?").get(keyFp) as { n?: number } | undefined;
  return Number(row?.n) || 0;
}

const OWE =
  "INSERT OR IGNORE INTO flux_mem_owed(space, key_fp, kind, thread_id, thread_tag, bot_id, state, op_id, attempts, polls, next_at, created_at, attempt) " +
  "VALUES(?, ?, ?, ?, ?, ?, 'owed', NULL, 0, 0, ?, ?, ?)";

/** In the conversation deletion's own transaction: a permanent thread tombstone, and a thread forget owed in every (space, key)
 * the thread was captured to. A row with no stored tag, or a space that is not a bot space, is owed a DELETE of that stored space
 * instead (R4.11.2). Every insert is `INSERT OR IGNORE`: a row an earlier deletion wrote keeps its own attempt token. */
export function oweFluxThreadForget(db: DatabaseSync, threadId: string, attempt: string = randomUUID(), now: number = Date.now()): number {
  initializeFluxSpaces(db);
  db.prepare("INSERT OR IGNORE INTO flux_mem_tombstone(kind, subject, key_fp, code, at, attempt) VALUES('thread', ?, '', 'deleted', ?, ?)").run(threadId, now, attempt);
  const owe = db.prepare(OWE);
  let owed = 0;
  for (const row of db.prepare("SELECT space, key_fp, bot_id, thread_tag FROM flux_mem_used WHERE thread_id=?").all(threadId) as Array<{ space: string; key_fp: string; bot_id: string; thread_tag: string }>) {
    const tagged = Boolean(row.thread_tag) && String(row.space).startsWith("bot:");
    owed += Number(owe.run(row.space, row.key_fp, tagged ? "thread" : "bot", tagged ? threadId : "", tagged ? row.thread_tag : "", row.bot_id ?? "", now + FLUX_FORGET_GRACE_MS, now, attempt).changes);
  }
  return owed;
}

/** In the bot deletion's own transaction: each stored (space, key) the bot captured to is tombstoned and owed a DELETE, never a
 * recomputed name; the recomputed bot space is tombstoned for every key too, so a bot with no row yet never captures. */
export function oweFluxBotDeletion(db: DatabaseSync, botId: string, attempt: string = randomUUID(), now: number = Date.now()): number {
  initializeFluxSpaces(db);
  const tomb = db.prepare("INSERT OR IGNORE INTO flux_mem_tombstone(kind, subject, key_fp, code, at, attempt) VALUES('space', ?, ?, 'deleted', ?, ?)");
  tomb.run(fluxBotSpace(db, botId), "", now, attempt);
  const owe = db.prepare(OWE);
  let owed = 0;
  for (const row of db.prepare("SELECT DISTINCT space, key_fp FROM flux_mem_used WHERE bot_id=?").all(botId) as Array<{ space: string; key_fp: string }>) {
    tomb.run(row.space, row.key_fp, now, attempt);
    owed += Number(owe.run(row.space, row.key_fp, "bot", "", "", botId, now + FLUX_FORGET_GRACE_MS, now, attempt).changes);
  }
  return owed;
}

/** A deletion that did not commit (the bot's registry save failed): only the rows THIS attempt wrote, and only owed rows never sent. */
export function withdrawFluxForget(db: DatabaseSync, attempt: string): void {
  initializeFluxSpaces(db);
  db.prepare("DELETE FROM flux_mem_tombstone WHERE attempt=?").run(attempt);
  db.prepare("DELETE FROM flux_mem_owed WHERE attempt=? AND state='owed' AND op_id IS NULL").run(attempt);
}

export interface FluxForgetRow {
  space: string; keyFp: string; kind: "thread" | "bot"; threadId: string; threadTag: string; botId: string;
  state: "owed" | "polling"; opId: string | null; attempts: number; polls: number; nextAt: number; createdAt: number;
  lastStatus: number | null; fallbackAt: number | null;
}

export function dueFluxForgets(db: DatabaseSync, now: number, limit = 20): FluxForgetRow[] {
  initializeFluxSpaces(db);
  return (db.prepare("SELECT * FROM flux_mem_owed WHERE next_at<=? ORDER BY next_at, created_at LIMIT ?").all(now, limit) as Array<Record<string, unknown>>).map(rowOf);
}

export function allFluxForgets(db: DatabaseSync): FluxForgetRow[] {
  initializeFluxSpaces(db);
  return (db.prepare("SELECT * FROM flux_mem_owed ORDER BY next_at, kind, thread_id").all() as Array<Record<string, unknown>>).map(rowOf);
}

/** The soonest a forget row is due (null with none). */
export function nextFluxForgetAt(db: DatabaseSync): number | null {
  initializeFluxSpaces(db);
  const row = db.prepare("SELECT MIN(next_at) AS at FROM flux_mem_owed").get() as { at?: number | null } | undefined;
  return row?.at === null || row?.at === undefined ? null : Number(row.at);
}

const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
const rowOf = (row: Record<string, unknown>): FluxForgetRow => ({
  space: String(row.space), keyFp: String(row.key_fp), kind: row.kind === "bot" ? "bot" : "thread", threadId: String(row.thread_id ?? ""),
  threadTag: String(row.thread_tag ?? ""), botId: String(row.bot_id ?? ""), state: row.state === "polling" ? "polling" : "owed",
  opId: typeof row.op_id === "string" ? row.op_id : null, attempts: Number(row.attempts) || 0, polls: Number(row.polls) || 0,
  nextAt: Number(row.next_at) || 0, createdAt: Number(row.created_at) || 0, lastStatus: num(row.last_status), fallbackAt: num(row.fallback_at),
});

type RowKey = Pick<FluxForgetRow, "space" | "keyFp" | "kind" | "threadTag">;
const PK = "space=? AND key_fp=? AND kind=? AND thread_tag=?";
const pk = (row: RowKey) => [row.space, row.keyFp, row.kind, row.threadTag] as const;

/** Every update of a row is by its full primary key. */
export function updateFluxForget(db: DatabaseSync, row: RowKey, patch: Partial<Pick<FluxForgetRow, "state" | "opId" | "attempts" | "polls" | "nextAt" | "lastStatus" | "fallbackAt">>): void {
  const current = db.prepare(`SELECT * FROM flux_mem_owed WHERE ${PK}`).get(...pk(row)) as Record<string, unknown> | undefined;
  if (!current) return;
  const next = { ...rowOf(current), ...patch };
  db.prepare(`UPDATE flux_mem_owed SET state=?, op_id=?, attempts=?, polls=?, next_at=?, last_status=?, fallback_at=? WHERE ${PK}`)
    .run(next.state, next.opId, next.attempts, next.polls, next.nextAt, next.lastStatus, next.fallbackAt, ...pk(row));
}

/** Receipts of a thread row (the ids fallback), up to `limit`. */
export function fluxThreadReceipts(db: DatabaseSync, row: Pick<FluxForgetRow, "space" | "keyFp" | "threadId">, limit = 100): string[] {
  initializeFluxSpaces(db);
  return (db.prepare("SELECT source_id FROM flux_mem_receipt WHERE space=? AND key_fp=? AND thread_id=? ORDER BY at, source_id LIMIT ?").all(row.space, row.keyFp, row.threadId, limit) as Array<{ source_id: string }>).map((r) => String(r.source_id));
}

/** Flux forgot these receipted captures (ids fallback): their receipts go. The row is NOT done (R4.7). */
export function dropFluxReceipts(db: DatabaseSync, row: Pick<FluxForgetRow, "space" | "keyFp">, sourceIds: string[]): void {
  atomically(db, "flux_mem_receipts", () => {
    const drop = db.prepare("DELETE FROM flux_mem_receipt WHERE space=? AND key_fp=? AND source_id=?");
    for (const id of sourceIds) drop.run(row.space, row.keyFp, id);
  });
}

/** The forget is finished. A thread row: its owed row, used row and receipts. A bot row: every row of (space, key), the shred
 * covered them. Tombstones stay. One transaction. */
export function finishFluxForget(db: DatabaseSync, row: Pick<FluxForgetRow, "space" | "keyFp" | "kind" | "threadTag" | "threadId">): void {
  atomically(db, "flux_forget_done", () => {
    if (row.kind === "bot") {
      for (const table of ["flux_mem_owed", "flux_mem_used", "flux_mem_receipt", "flux_mem_limit", "flux_mem_proven"]) db.prepare(`DELETE FROM ${table} WHERE space=? AND key_fp=?`).run(row.space, row.keyFp);
    } else {
      db.prepare(`DELETE FROM flux_mem_owed WHERE ${PK}`).run(...pk(row));
      db.prepare("DELETE FROM flux_mem_used WHERE thread_id=? AND key_fp=? AND space=?").run(row.threadId, row.keyFp, row.space);
      db.prepare("DELETE FROM flux_mem_receipt WHERE space=? AND key_fp=? AND thread_id=?").run(row.space, row.keyFp, row.threadId);
    }
  });
}

/** The 409 code FluxMain says is final: the owner unenrolled the key and it is never enrolled again. */
export const FLUX_KEY_OFF_FINAL = "key_unenrolled_no_auto_reenroll";
/** 409 memory_account_not_enabled: FluxMain auto-enables the key within 15 min, so it is looked at again after 30 min. */
export const FLUX_KEY_OFF_NOT_READY = "memory_account_not_enabled";
export const FLUX_KEY_OFF_NOT_READY_RECHECK_MS = 30 * 60_000;
/** Any other 409 (consent off) is looked at again once a day, with a real turn, never in a loop. */
export const FLUX_KEY_OFF_RECHECK_MS = 24 * 60 * 60_000;

/** Flux answered 409 for this key: Flux Memory is off for it. A final code (key_unenrolled_no_auto_reenroll) is never overwritten
 * for that fingerprint (Astra M3): a later consent or not-enabled answer must not turn a final "off" into a timed recheck. */
export function setFluxKeyOff(db: DatabaseSync, keyFp: string, code: string | null, now: number = Date.now()): void {
  initializeFluxSpaces(db);
  db.prepare(
    "INSERT INTO flux_key_off(key_fp, code, at) VALUES(?,?,?) " +
    "ON CONFLICT(key_fp) DO UPDATE SET code=excluded.code, at=excluded.at WHERE flux_key_off.code IS NOT ?",
  ).run(keyFp, code ? code.slice(0, 64) : null, now, FLUX_KEY_OFF_FINAL);
}

export type FluxKeyOffReason = "final" | "consent" | "not_enabled";

/** Why Flux Memory is off for this key now, or null when it is on (or due its recheck). */
export function fluxKeyOffReason(db: DatabaseSync, keyFp: string, now: number = Date.now()): FluxKeyOffReason | null {
  initializeFluxSpaces(db);
  const row = db.prepare("SELECT code, at FROM flux_key_off WHERE key_fp=?").get(keyFp) as { code?: string | null; at?: number } | undefined;
  if (!row) return null;
  if (row.code === FLUX_KEY_OFF_FINAL) return "final";
  if (row.code === FLUX_KEY_OFF_NOT_READY) return now - Number(row.at) < FLUX_KEY_OFF_NOT_READY_RECHECK_MS ? "not_enabled" : null;
  return now - Number(row.at) < FLUX_KEY_OFF_RECHECK_MS ? "consent" : null;
}

export function fluxKeyOff(db: DatabaseSync, keyFp: string, now: number = Date.now()): boolean {
  return fluxKeyOffReason(db, keyFp, now) !== null;
}

/** Deleted conversations and bots whose forget waits for a key other than the current one (Settings shows a line while any). */
export function fluxForgetsWaitingForKey(db: DatabaseSync, currentFp: string | null): number {
  initializeFluxSpaces(db);
  const row = db.prepare("SELECT COUNT(DISTINCT CASE WHEN kind='thread' THEN 't:' || thread_id ELSE 'b:' || space END) AS n FROM flux_mem_owed WHERE key_fp<>?").get(currentFp ?? "") as { n?: number } | undefined;
  return Number(row?.n) || 0;
}
