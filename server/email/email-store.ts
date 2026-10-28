// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bot email tables of messages.db (design 2.2, 2.6, 3.3 to 3.5, 9). Every state-carrying row (a send, a binding, a removal intent, a
// policy-sync intent) has a `revision`, and every write to it is one compare-and-set on that revision: a writer that read an older row
// changes nothing and is told so. The frozen email bytes live in email_payloads, apart from the send record, so a backup can leave them out
// and keep the record (design 7).
//
// Tables are created by initializeEmailTables (idempotent). They are registered with the installation snapshot (APP_TABLES via
// APP_SCHEMA_102_ADDITIONS) and the added-table lifecycle (added-table-lifecycle.ts), and they are created only when bot email is in use, so
// an installation with email off keeps exactly the schema it has today.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export const EMAIL_TABLES = ["email_bindings", "email_sends", "email_payloads", "email_events", "email_event_cursor", "email_policy_sync", "email_trust", "email_trusted", "email_tombstones"] as const;
export const EMAIL_INDEXES = ["email_sends_hash", "email_sends_due", "email_sends_inbox", "email_sends_generation", "email_sends_settled", "email_sends_replaces", "email_events_reference", "email_events_received"] as const;

/** The payload-prune scan cursor's scope in email_event_cursor (pruneSettledSends). */
export const PRUNE_PAYLOADS_SCOPE = "prune:payloads";

export const EMAIL_DDL = [
  `CREATE TABLE IF NOT EXISTS email_bindings (bot_id TEXT PRIMARY KEY, inbox_id TEXT, address TEXT, username TEXT, display_name TEXT, email_key_ref TEXT, flux_account_id TEXT, state TEXT NOT NULL, step TEXT, op_id TEXT, op_started_at INTEGER, policy TEXT NOT NULL, failure TEXT, closing_until TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS email_sends (send_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, generation INTEGER NOT NULL, thread_id TEXT NOT NULL, inbox_id TEXT NOT NULL, kind TEXT NOT NULL, reply_message_id TEXT, payload_hash TEXT NOT NULL, summary TEXT NOT NULL, idem_suffix INTEGER NOT NULL, state TEXT NOT NULL, code TEXT, why TEXT, stop_requested INTEGER NOT NULL, owner_sent INTEGER NOT NULL, replaces TEXT, receipt TEXT, revision INTEGER NOT NULL, attempts TEXT NOT NULL, held_ids TEXT, approval_id TEXT, message_id TEXT, reconcile_step INTEGER NOT NULL, due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dispatched_at INTEGER, settled_at INTEGER, delivery_note TEXT)`,
  `CREATE INDEX IF NOT EXISTS email_sends_hash ON email_sends(bot_id, payload_hash)`,
  `CREATE INDEX IF NOT EXISTS email_sends_due ON email_sends(due_at) WHERE due_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS email_sends_inbox ON email_sends(inbox_id, state)`,
  `CREATE INDEX IF NOT EXISTS email_sends_generation ON email_sends(bot_id, generation)`,
  `CREATE INDEX IF NOT EXISTS email_sends_settled ON email_sends(settled_at) WHERE settled_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS email_sends_replaces ON email_sends(replaces) WHERE replaces IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS email_payloads (send_id TEXT NOT NULL, part INTEGER NOT NULL, name TEXT, content_type TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(send_id, part)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS email_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, inbox_id TEXT, bot_id TEXT, client_reference TEXT, held_id TEXT, created TEXT, data TEXT, received_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS email_events_reference ON email_events(client_reference) WHERE client_reference IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS email_events_received ON email_events(received_at)`,
  `CREATE TABLE IF NOT EXISTS email_event_cursor (scope TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS email_policy_sync (bot_id TEXT PRIMARY KEY, policy TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS email_trust (bot_id TEXT NOT NULL, address TEXT NOT NULL, sent_at TEXT NOT NULL, tainted_at INTEGER, offer_blocked_until INTEGER, offered_at INTEGER, offer_thread TEXT, offer_reason TEXT, PRIMARY KEY(bot_id, address)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS email_trusted (bot_id TEXT NOT NULL, entry TEXT NOT NULL, rule TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(bot_id, entry)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS email_tombstones (bot_id TEXT NOT NULL, inbox_id TEXT NOT NULL, address_hash TEXT, state TEXT NOT NULL, committed INTEGER NOT NULL, reason TEXT NOT NULL, key_id TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER, next_try_at INTEGER, PRIMARY KEY(bot_id, inbox_id))`,
] as const;

export function initializeEmailTables(db: DatabaseSync): void { for (const sql of EMAIL_DDL) db.exec(sql); }

// ---- rows ------------------------------------------------------------------------------------------------------------------

export type SendState =
  | "prepared" | "awaiting_owner" | "dispatching" | "held" | "approving" | "sent" | "refused" | "approved_unsent" | "unknown" | "unknown_expired"
  | "withdraw_pending" | "withdrawn" | "declined" | "expired";
export const TERMINAL_SEND_STATES: ReadonlySet<SendState> = new Set(["sent", "refused", "withdrawn", "declined", "expired"]);
export const OPEN_SEND_STATES: readonly SendState[] = ["prepared", "awaiting_owner", "dispatching", "held", "approving", "approved_unsent", "unknown", "unknown_expired", "withdraw_pending"];

export interface SendSummary {
  to: string[]; cc: string[]; subject: string; textLength: number;
  attachments: Array<{ name: string; contentType: string; size: number; sha256: string }>;
  /** what the reply answers (for 3.3 and the card); null on a send */
  replySource: ReplySource | null;
}
export interface ReplySource { from: string; senderAuthenticated: boolean; scanStatus: string; scanVerdict: string | null; listMail: boolean }
export interface OwnerReceipt { sendId: string; payloadHash: string; revision: number; at: number; device: string; used: boolean }
export interface Attempt { suffix: number; keyId: string | null; at: number; route: string; /** #32: Flux answered 2xx (stored under its key) */ answered?: boolean }

export interface SendRow {
  sendId: string; botId: string; generation: number; threadId: string; inboxId: string; kind: "send" | "reply"; replyMessageId: string | null;
  payloadHash: string; summary: SendSummary; idemSuffix: number; state: SendState; code: string | null; why: string | null;
  stopRequested: boolean; ownerSent: boolean; replaces: string | null; receipt: OwnerReceipt | null; revision: number; attempts: Attempt[];
  heldIds: string[]; approvalId: string | null; messageId: string | null; reconcileStep: number; dueAt: number | null;
  createdAt: number; updatedAt: number; dispatchedAt: number | null; settledAt: number | null; deliveryNote: string | null;
}

export type BindingState = "provisioning" | "active" | "failed" | "paused" | "billing_hold" | "grace" | "closing" | "removing" | "remove_requested" | "account_off" | "restored_unverified";
/** The Flux inbox states Murage mirrors from #5, send refusals and #28 lifecycle events (2.6, billing #518). `grace` receives and reads but
 *  never sends; `closing` (a Flux-side close: billing, account disabled, support) is owner-only, and `closing_until` holds Flux's date. */
export const LIVE_BINDING_STATES: ReadonlySet<BindingState> = new Set<BindingState>(["active", "paused", "billing_hold", "grace", "closing"]);
export interface BindingRow {
  botId: string; inboxId: string | null; address: string | null; username: string | null; displayName: string | null; emailKeyRef: string | null;
  fluxAccountId: string | null; state: BindingState; step: "key" | "inbox" | null; opId: string | null; opStartedAt: number | null; policy: "ask" | "auto";
  failure: string | null;
  /** Flux's closing_until (ISO) while the inbox is `closing`; null in every other state. */
  closingUntil: string | null; revision: number; updatedAt: number;
}
export interface TombstoneRow {
  botId: string; inboxId: string; addressHash: string | null; state: "removing" | "remove_requested" | "removed"; committed: boolean; reason: string;
  keyId: string | null; revision: number; createdAt: number; removedAt: number | null; nextTryAt: number | null;
}
export interface PayloadPart { part: number; name: string | null; contentType: string | null; size: number; sha256: string; data: Uint8Array }
export interface StoredEvent { eventId: string; type: string; inboxId: string | null; botId: string | null; clientReference: string | null; heldId: string | null; created: string | null; data: Record<string, unknown>; receivedAt: number }

const SEND_COLUMNS: Record<keyof SendRow, string> = {
  sendId: "send_id", botId: "bot_id", generation: "generation", threadId: "thread_id", inboxId: "inbox_id", kind: "kind", replyMessageId: "reply_message_id",
  payloadHash: "payload_hash", summary: "summary", idemSuffix: "idem_suffix", state: "state", code: "code", why: "why", stopRequested: "stop_requested",
  ownerSent: "owner_sent", replaces: "replaces", receipt: "receipt", revision: "revision", attempts: "attempts", heldIds: "held_ids", approvalId: "approval_id",
  messageId: "message_id", reconcileStep: "reconcile_step", dueAt: "due_at", createdAt: "created_at", updatedAt: "updated_at", dispatchedAt: "dispatched_at",
  settledAt: "settled_at", deliveryNote: "delivery_note",
};
const JSON_SEND = new Set<keyof SendRow>(["summary", "receipt", "attempts", "heldIds"]);
const BOOL_SEND = new Set<keyof SendRow>(["stopRequested", "ownerSent"]);
const BINDING_COLUMNS: Record<keyof BindingRow, string> = {
  botId: "bot_id", inboxId: "inbox_id", address: "address", username: "username", displayName: "display_name", emailKeyRef: "email_key_ref",
  fluxAccountId: "flux_account_id", state: "state", step: "step", opId: "op_id", opStartedAt: "op_started_at", policy: "policy", failure: "failure", closingUntil: "closing_until",
  revision: "revision", updatedAt: "updated_at",
};
const TOMBSTONE_COLUMNS: Record<keyof TombstoneRow, string> = {
  botId: "bot_id", inboxId: "inbox_id", addressHash: "address_hash", state: "state", committed: "committed", reason: "reason", keyId: "key_id",
  revision: "revision", createdAt: "created_at", removedAt: "removed_at", nextTryAt: "next_try_at",
};

function toColumn<R>(json: ReadonlySet<keyof R>, bool: ReadonlySet<keyof R>, key: keyof R, value: unknown): SQLInputValue {
  if (json.has(key)) return value === null || value === undefined ? (key === "heldIds" ? "[]" : null) : JSON.stringify(value);
  if (bool.has(key)) return value ? 1 : 0;
  return value === undefined ? null : value as SQLInputValue;
}
function fromRow<R>(columns: Record<keyof R, string>, json: ReadonlySet<keyof R>, bool: ReadonlySet<keyof R>, raw: Record<string, unknown>): R {
  const out = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(columns) as Array<[keyof R & string, string]>) {
    const value = raw[column];
    out[key] = json.has(key) ? (value === null || value === undefined ? null : JSON.parse(String(value))) : bool.has(key) ? Number(value) === 1 : value ?? null;
  }
  return out as R;
}

export class StaleRevisionError extends Error { constructor(what: string) { super(`EMAIL_STALE_REVISION:${what}`); } }

export interface EmailStoreOptions {
  /** Runs fn in one transaction (database.ts `transaction` in the server; a plain BEGIN IMMEDIATE here by default). Nested calls join. */
  transaction?: <T>(fn: () => T) => T;
}

export class EmailStore {
  private readonly txImpl: <T>(fn: () => T) => T;
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync, options: EmailStoreOptions = {}) {
    this.db = db;
    initializeEmailTables(db);
    this.txImpl = options.transaction ?? (<T>(fn: () => T): T => {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already out */ } throw error; }
    });
  }
  tx<T>(fn: () => T): T { return this.txImpl(fn); }

  // ---- sends ----
  insertSend(row: SendRow): void {
    const keys = Object.keys(SEND_COLUMNS) as Array<keyof SendRow>;
    this.db.prepare(`INSERT INTO email_sends (${keys.map(key => SEND_COLUMNS[key]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map(key => toColumn<SendRow>(JSON_SEND, BOOL_SEND, key, row[key])));
  }
  private send(raw: unknown): SendRow | null { return raw ? fromRow<SendRow>(SEND_COLUMNS, JSON_SEND, BOOL_SEND, raw as Record<string, unknown>) : null; }
  private sends(raw: unknown[]): SendRow[] { return raw.map(row => this.send(row)!); }
  getSend(sendId: string): SendRow | null { return this.send(this.db.prepare("SELECT * FROM email_sends WHERE send_id=?").get(sendId)); }
  /** One compare-and-set: the row moves only if it is still at `revision`. Returns the new row, or null when it had moved on. */
  casSend(sendId: string, revision: number, patch: Partial<Omit<SendRow, "sendId" | "revision">>, now: number): SendRow | null {
    const keys = (Object.keys(patch) as Array<keyof SendRow>).filter(key => key !== "sendId" && key !== "revision" && key !== "updatedAt");
    const sets = [...keys.map(key => `${SEND_COLUMNS[key]}=?`), "revision=revision+1", "updated_at=?"];
    const result = this.db.prepare(`UPDATE email_sends SET ${sets.join(",")} WHERE send_id=? AND revision=?`)
      .run(...keys.map(key => toColumn<SendRow>(JSON_SEND, BOOL_SEND, key, patch[key])), now, sendId, revision);
    return Number(result.changes) === 1 ? this.getSend(sendId) : null;
  }
  /** The row that replaced `sendId` (an owner resend or an edit), if any: there is at most one. */
  sendReplacing(sendId: string): SendRow | null { return this.send(this.db.prepare("SELECT * FROM email_sends WHERE replaces=? LIMIT 1").get(sendId)); }
  sendsByHash(botId: string, payloadHash: string): SendRow[] { return this.sends(this.db.prepare("SELECT * FROM email_sends WHERE bot_id=? AND payload_hash=? ORDER BY created_at").all(botId, payloadHash)); }
  sendsOfGeneration(botId: string, generation: number): SendRow[] { return this.sends(this.db.prepare("SELECT * FROM email_sends WHERE bot_id=? AND generation=? ORDER BY created_at").all(botId, generation)); }
  sendsInStates(states: readonly SendState[]): SendRow[] { return this.sends(this.db.prepare(`SELECT * FROM email_sends WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(...states)); }
  sendsOfBot(botId: string, states: readonly SendState[]): SendRow[] { return this.sends(this.db.prepare(`SELECT * FROM email_sends WHERE bot_id=? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(botId, ...states)); }
  sendsOfInbox(inboxId: string, states: readonly SendState[]): SendRow[] { return this.sends(this.db.prepare(`SELECT * FROM email_sends WHERE inbox_id=? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(inboxId, ...states)); }
  dueSends(now: number): SendRow[] { return this.sends(this.db.prepare("SELECT * FROM email_sends WHERE due_at IS NOT NULL AND due_at<=? ORDER BY due_at").all(now)); }
  /** The local row a Flux hold belongs to: by held id, or by client_reference (= send_id). */
  sendForHeld(heldId: string, clientReference?: string | null): SendRow | null {
    if (clientReference) { const row = this.getSend(clientReference); if (row) return row; }
    return this.send(this.db.prepare("SELECT s.* FROM email_sends s, json_each(s.held_ids) j WHERE j.value=? LIMIT 1").get(heldId));
  }

  /** Frozen bytes leave once a row has settled for `payloadAfter` ms; the settled record itself (its receipt and why line) after
   * `rowAfter` ms, and only once its bytes are gone. Open rows are never touched. `limit` bounds the sends looked at per step (oldest
   * first, on the settled_at index), so one pass never holds the database for long; the next pass takes the rest. The payload step keeps
   * a scan cursor (settled_at, send_id) in email_event_cursor, so a pass starts after the last send it looked at and never rescans the
   * settled sends whose bytes are already gone (Astra r2 Medium). A send settles at "now", always past the cursor (which stays older than
   * now - payloadAfter), so nothing is skipped. */
  pruneSettledSends(now: number, payloadAfter = 30 * 86_400_000, rowAfter = 180 * 86_400_000, limit = -1): { payloads: number; rows: number } {
    return this.tx(() => {
      const terminal = "state IN ('sent','refused','withdrawn','declined','expired') AND settled_at IS NOT NULL";
      const mark = this.getCursor(PRUNE_PAYLOADS_SCOPE);
      const split = mark ? mark.indexOf("|") : -1;
      const afterAt = split > 0 ? Number(mark!.slice(0, split)) : -1;
      const afterId = split > 0 ? mark!.slice(split + 1) : "";
      const scanned = this.db.prepare(`SELECT send_id, settled_at FROM email_sends WHERE ${terminal} AND settled_at<? AND (settled_at>? OR (settled_at=? AND send_id>?)) ORDER BY settled_at, send_id LIMIT ?`)
        .all(now - payloadAfter, afterAt, afterAt, afterId, limit) as Array<{ send_id: string; settled_at: number }>;
      let payloads = 0;
      if (scanned.length) {
        const drop = this.db.prepare("DELETE FROM email_payloads WHERE send_id=?");
        for (const send of scanned) payloads += Number(drop.run(send.send_id).changes);
        const last = scanned[scanned.length - 1];
        this.setCursor(PRUNE_PAYLOADS_SCOPE, `${last.settled_at}|${last.send_id}`, now);
      }
      const rows = Number(this.db.prepare(`DELETE FROM email_sends WHERE send_id IN (SELECT send_id FROM email_sends WHERE ${terminal} AND settled_at<? AND NOT EXISTS (SELECT 1 FROM email_payloads p WHERE p.send_id=email_sends.send_id) ORDER BY settled_at LIMIT ?)`).run(now - rowAfter, limit).changes);
      return { payloads, rows };
    });
  }

  // ---- payloads ----
  putPayload(sendId: string, parts: PayloadPart[]): void {
    const insert = this.db.prepare("INSERT INTO email_payloads (send_id, part, name, content_type, size, sha256, data) VALUES (?,?,?,?,?,?,?)");
    for (const part of parts) insert.run(sendId, part.part, part.name, part.contentType, part.size, part.sha256, part.data);
  }
  getPayload(sendId: string): PayloadPart[] {
    return (this.db.prepare("SELECT part, name, content_type, size, sha256, data FROM email_payloads WHERE send_id=? ORDER BY part").all(sendId) as Array<Record<string, unknown>>)
      .map(raw => ({ part: Number(raw.part), name: (raw.name as string | null) ?? null, contentType: (raw.content_type as string | null) ?? null, size: Number(raw.size), sha256: String(raw.sha256), data: raw.data as Uint8Array }));
  }
  dropPayload(sendId: string): void { this.db.prepare("DELETE FROM email_payloads WHERE send_id=?").run(sendId); }

  // ---- bindings ----
  getBinding(botId: string): BindingRow | null { const raw = this.db.prepare("SELECT * FROM email_bindings WHERE bot_id=?").get(botId); return raw ? fromRow<BindingRow>(BINDING_COLUMNS, new Set(), new Set(), raw as Record<string, unknown>) : null; }
  bindings(): BindingRow[] { return (this.db.prepare("SELECT * FROM email_bindings ORDER BY bot_id").all() as Array<Record<string, unknown>>).map(raw => fromRow<BindingRow>(BINDING_COLUMNS, new Set(), new Set(), raw)); }
  bindingByInbox(inboxId: string): BindingRow | null { const raw = this.db.prepare("SELECT * FROM email_bindings WHERE inbox_id=?").get(inboxId); return raw ? fromRow<BindingRow>(BINDING_COLUMNS, new Set(), new Set(), raw as Record<string, unknown>) : null; }
  /** Inserts a binding at revision 1 only when none exists (the first writer wins). */
  insertBinding(row: Omit<BindingRow, "revision" | "closingUntil"> & { closingUntil?: string | null }): boolean {
    const keys = (Object.keys(BINDING_COLUMNS) as Array<keyof BindingRow>);
    const values = keys.map(key => key === "revision" ? 1 : (row as BindingRow)[key] ?? null) as SQLInputValue[];
    return Number(this.db.prepare(`INSERT OR IGNORE INTO email_bindings (${keys.map(key => BINDING_COLUMNS[key]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...values).changes) === 1;
  }
  casBinding(botId: string, revision: number, patch: Partial<Omit<BindingRow, "botId" | "revision">>, now: number): BindingRow | null {
    const keys = (Object.keys(patch) as Array<keyof BindingRow>).filter(key => key !== "botId" && key !== "revision" && key !== "updatedAt");
    const result = this.db.prepare(`UPDATE email_bindings SET ${[...keys.map(key => `${BINDING_COLUMNS[key]}=?`), "revision=revision+1", "updated_at=?"].join(",")} WHERE bot_id=? AND revision=?`)
      .run(...keys.map(key => (patch[key] ?? null) as SQLInputValue), now, botId, revision);
    return Number(result.changes) === 1 ? this.getBinding(botId) : null;
  }
  /** Deletes the binding only while it is still this generation (same inbox, setup op and key ref), in one conditional statement. */
  deleteBindingGeneration(row: Pick<BindingRow, "botId" | "inboxId" | "opId" | "emailKeyRef">): boolean {
    return Number(this.db.prepare("DELETE FROM email_bindings WHERE bot_id=? AND inbox_id IS ? AND op_id IS ? AND email_key_ref IS ?").run(row.botId, row.inboxId, row.opId, row.emailKeyRef).changes) === 1;
  }
  deleteBinding(botId: string, revision: number): boolean { return Number(this.db.prepare("DELETE FROM email_bindings WHERE bot_id=? AND revision=?").run(botId, revision).changes) === 1; }

  // ---- tombstones and deletion intents ----
  private tomb(raw: unknown): TombstoneRow | null { return raw ? fromRow<TombstoneRow>(TOMBSTONE_COLUMNS, new Set(), new Set<keyof TombstoneRow>(["committed"]), raw as Record<string, unknown>) : null; }
  getTombstone(botId: string, inboxId: string): TombstoneRow | null { return this.tomb(this.db.prepare("SELECT * FROM email_tombstones WHERE bot_id=? AND inbox_id=?").get(botId, inboxId)); }
  tombstones(): TombstoneRow[] { return (this.db.prepare("SELECT * FROM email_tombstones ORDER BY created_at").all() as unknown[]).map(raw => this.tomb(raw)!); }
  upsertTombstone(row: Omit<TombstoneRow, "revision">): void {
    this.db.prepare(`INSERT INTO email_tombstones (bot_id, inbox_id, address_hash, state, committed, reason, key_id, revision, created_at, removed_at, next_try_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(bot_id, inbox_id) DO UPDATE SET address_hash=excluded.address_hash, state=excluded.state, committed=excluded.committed, reason=excluded.reason, key_id=excluded.key_id, revision=email_tombstones.revision+1, removed_at=excluded.removed_at, next_try_at=excluded.next_try_at`)
      .run(row.botId, row.inboxId, row.addressHash, row.state, row.committed ? 1 : 0, row.reason, row.keyId, row.createdAt, row.removedAt, row.nextTryAt);
  }
  casTombstone(botId: string, inboxId: string, revision: number, patch: Partial<Omit<TombstoneRow, "botId" | "inboxId" | "revision">>): TombstoneRow | null {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    const result = this.db.prepare(`UPDATE email_tombstones SET ${[...keys.map(key => `${TOMBSTONE_COLUMNS[key]}=?`), "revision=revision+1"].join(",")} WHERE bot_id=? AND inbox_id=? AND revision=?`)
      .run(...keys.map(key => key === "committed" ? (patch[key] ? 1 : 0) : (patch[key] ?? null) as SQLInputValue), botId, inboxId, revision);
    return Number(result.changes) === 1 ? this.getTombstone(botId, inboxId) : null;
  }
  deleteTombstone(botId: string, inboxId: string, revision: number): boolean { return Number(this.db.prepare("DELETE FROM email_tombstones WHERE bot_id=? AND inbox_id=? AND revision=?").run(botId, inboxId, revision).changes) === 1; }
  pruneTombstones(before: number): number { return Number(this.db.prepare("DELETE FROM email_tombstones WHERE state='removed' AND removed_at IS NOT NULL AND removed_at<?").run(before).changes); }

  // ---- events ----
  /** Records an event once (eev_ ids are unique); false when it was already recorded. */
  recordEvent(event: Omit<StoredEvent, "receivedAt">, now: number): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO email_events (event_id, type, inbox_id, bot_id, client_reference, held_id, created, data, received_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(event.eventId, event.type, event.inboxId, event.botId, event.clientReference, event.heldId, event.created, JSON.stringify(event.data ?? {}), now).changes) === 1;
  }
  eventsFor(clientReference: string): StoredEvent[] {
    return (this.db.prepare("SELECT * FROM email_events WHERE client_reference=? ORDER BY received_at, event_id").all(clientReference) as Array<Record<string, unknown>>).map(raw => ({
      eventId: String(raw.event_id), type: String(raw.type), inboxId: (raw.inbox_id as string | null) ?? null, botId: (raw.bot_id as string | null) ?? null,
      clientReference: (raw.client_reference as string | null) ?? null, heldId: (raw.held_id as string | null) ?? null, created: (raw.created as string | null) ?? null,
      data: JSON.parse(String(raw.data ?? "{}")) as Record<string, unknown>, receivedAt: Number(raw.received_at),
    }));
  }
  hasEvent(eventId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM email_events WHERE event_id=?").get(eventId)); }
  /** Inbound envelopes of one inbox, newest first (the owner's panel lists; the bot never reads this table). */
  receivedEvents(inboxId: string, limit = 50): StoredEvent[] {
    return (this.db.prepare("SELECT * FROM email_events WHERE inbox_id=? AND type='email.message.received' ORDER BY received_at DESC, event_id DESC LIMIT ?").all(inboxId, limit) as Array<Record<string, unknown>>).map(raw => ({
      eventId: String(raw.event_id), type: String(raw.type), inboxId: (raw.inbox_id as string | null) ?? null, botId: (raw.bot_id as string | null) ?? null,
      clientReference: (raw.client_reference as string | null) ?? null, heldId: (raw.held_id as string | null) ?? null, created: (raw.created as string | null) ?? null,
      data: JSON.parse(String(raw.data ?? "{}")) as Record<string, unknown>, receivedAt: Number(raw.received_at),
    }));
  }
  /** Cached events received before `before`, oldest first, at most `limit` of them (on the received_at index). */
  pruneEvents(before: number, limit = -1): number { return Number(this.db.prepare("DELETE FROM email_events WHERE event_id IN (SELECT event_id FROM email_events WHERE received_at<? ORDER BY received_at LIMIT ?)").run(before, limit).changes); }
  getCursor(scope: string): string | null { return ((this.db.prepare("SELECT cursor FROM email_event_cursor WHERE scope=?").get(scope) as { cursor?: string } | undefined)?.cursor) ?? null; }
  setCursor(scope: string, cursor: string, now: number): void { this.db.prepare("INSERT INTO email_event_cursor (scope, cursor, updated_at) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at").run(scope, cursor, now); }
  /** Every cursor scope that starts with `prefix` (a seek on the primary key). */
  cursorScopes(prefix: string): string[] {
    return (this.db.prepare("SELECT scope FROM email_event_cursor WHERE scope >= ? AND scope < ? ORDER BY scope").all(prefix, `${prefix}\uffff`) as Array<{ scope: string }>).map(row => row.scope);
  }
  clearCursor(scope: string): void { this.db.prepare("DELETE FROM email_event_cursor WHERE scope=?").run(scope); }

  // ---- policy sync ----
  getPolicySync(botId: string): { botId: string; policy: "ask" | "auto"; state: "pending" | "confirmed"; revision: number; updatedAt: number } | null {
    const raw = this.db.prepare("SELECT * FROM email_policy_sync WHERE bot_id=?").get(botId) as Record<string, unknown> | undefined;
    return raw ? { botId: String(raw.bot_id), policy: raw.policy as "ask" | "auto", state: raw.state as "pending" | "confirmed", revision: Number(raw.revision), updatedAt: Number(raw.updated_at) } : null;
  }
  /** Writes a pending intent; revision = previous + 1 (or 1). Returns the intent's revision. */
  putPolicyIntent(botId: string, policy: "ask" | "auto", now: number): number {
    this.db.prepare("INSERT INTO email_policy_sync (bot_id, policy, state, revision, updated_at) VALUES (?,?, 'pending', 1, ?) ON CONFLICT(bot_id) DO UPDATE SET policy=excluded.policy, state='pending', revision=email_policy_sync.revision+1, updated_at=excluded.updated_at").run(botId, policy, now);
    return this.getPolicySync(botId)!.revision;
  }
  confirmPolicyIntent(botId: string, revision: number, now: number): boolean {
    return Number(this.db.prepare("UPDATE email_policy_sync SET state='confirmed', revision=revision+1, updated_at=? WHERE bot_id=? AND revision=?").run(now, botId, revision).changes) === 1;
  }
  pendingPolicyIntents(): Array<{ botId: string; policy: "ask" | "auto"; revision: number }> {
    return (this.db.prepare("SELECT bot_id, policy, revision FROM email_policy_sync WHERE state='pending'").all() as Array<Record<string, unknown>>).map(raw => ({ botId: String(raw.bot_id), policy: raw.policy as "ask" | "auto", revision: Number(raw.revision) }));
  }

  // ---- trust (3.3, 3.5) ----
  trustedEntries(botId: string): Array<{ entry: string; rule: "allow" | "block"; source: string; createdAt: number }> {
    return (this.db.prepare("SELECT entry, rule, source, created_at FROM email_trusted WHERE bot_id=? ORDER BY entry").all(botId) as Array<Record<string, unknown>>)
      .map(raw => ({ entry: String(raw.entry), rule: raw.rule as "allow" | "block", source: String(raw.source), createdAt: Number(raw.created_at) }));
  }
  /** An exact address only; a domain is never an allow (Grok, contract r2.3). */
  addTrusted(botId: string, entry: string, rule: "allow" | "block", source: string, now: number): void {
    this.db.prepare("INSERT INTO email_trusted (bot_id, entry, rule, source, created_at) VALUES (?,?,?,?,?) ON CONFLICT(bot_id, entry) DO UPDATE SET rule=excluded.rule, source=excluded.source").run(botId, entry, rule, source, now);
  }
  removeTrusted(botId: string, entry: string): void { this.db.prepare("DELETE FROM email_trusted WHERE bot_id=? AND entry=?").run(botId, entry); }
  isApproved(botId: string, address: string): boolean {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const rows = this.db.prepare("SELECT entry, rule FROM email_trusted WHERE bot_id=? AND entry IN (?, ?)").all(botId, address, domain) as Array<{ entry: string; rule: string }>;
    if (rows.some(row => row.rule === "block")) return false;
    return rows.some(row => row.rule === "allow" && row.entry === address);
  }
  /** One owner Send that went out to `address` (earned-trust counter). */
  noteOwnerSent(botId: string, address: string, now: number): void {
    const raw = this.db.prepare("SELECT sent_at FROM email_trust WHERE bot_id=? AND address=?").get(botId, address) as { sent_at?: string } | undefined;
    const list = raw?.sent_at ? (JSON.parse(raw.sent_at) as number[]) : [];
    const kept = [...list.filter(at => at > now - 30 * 86_400_000), now].slice(-20);
    this.db.prepare("INSERT INTO email_trust (bot_id, address, sent_at) VALUES (?,?,?) ON CONFLICT(bot_id, address) DO UPDATE SET sent_at=excluded.sent_at").run(botId, address, JSON.stringify(kept));
  }
  noteComplaintOrBounce(botId: string, address: string, now: number): void {
    this.db.prepare("INSERT INTO email_trust (bot_id, address, sent_at, tainted_at) VALUES (?,?, '[]', ?) ON CONFLICT(bot_id, address) DO UPDATE SET tainted_at=excluded.tainted_at").run(botId, address, now);
  }
  blockTrustOffer(botId: string, address: string, until: number): void {
    this.db.prepare("INSERT INTO email_trust (bot_id, address, sent_at, offer_blocked_until) VALUES (?,?, '[]', ?) ON CONFLICT(bot_id, address) DO UPDATE SET offer_blocked_until=excluded.offer_blocked_until").run(botId, address, until);
  }
  /** The bot's email_trust_offer for an eligible address (3.5): kept on the trust row for the owner's proposal card (built from this record,
   *  never from the bot's words). `reason` is the bot's own text, stored bounded and shown to the owner only. */
  recordTrustOffer(botId: string, address: string, threadId: string, reason: string, now: number): void {
    this.db.prepare("UPDATE email_trust SET offered_at=?, offer_thread=?, offer_reason=? WHERE bot_id=? AND address=?").run(now, threadId, reason.slice(0, 500), botId, address);
  }
  /** Offers not yet answered (Add clears the row's offer through addTrusted's caller; Not now through blockTrustOffer). */
  pendingTrustOffers(botId: string): Array<{ address: string; threadId: string | null; reason: string; offeredAt: number }> {
    return (this.db.prepare("SELECT address, offer_thread, offer_reason, offered_at FROM email_trust WHERE bot_id=? AND offered_at IS NOT NULL ORDER BY offered_at").all(botId) as Array<{ address: string; offer_thread: string | null; offer_reason: string | null; offered_at: number }>)
      .map(row => ({ address: row.address, threadId: row.offer_thread, reason: row.offer_reason ?? "", offeredAt: row.offered_at }));
  }
  clearTrustOffer(botId: string, address: string): void {
    this.db.prepare("UPDATE email_trust SET offered_at=NULL, offer_thread=NULL, offer_reason=NULL WHERE bot_id=? AND address=?").run(botId, address);
  }
  /** Eligible for email_trust_offer: 3 owner Sends in 30 days, no complaint or bounce in that window, no "Not now" in force, not already trusted. */
  trustOfferEligible(botId: string, address: string, now: number): boolean {
    const raw = this.db.prepare("SELECT sent_at, tainted_at, offer_blocked_until FROM email_trust WHERE bot_id=? AND address=?").get(botId, address) as { sent_at: string; tainted_at: number | null; offer_blocked_until: number | null } | undefined;
    if (!raw || this.isApproved(botId, address)) return false;
    const since = now - 30 * 86_400_000;
    const sends = (JSON.parse(raw.sent_at) as number[]).filter(at => at > since).length;
    return sends >= 3 && !(raw.tainted_at !== null && raw.tainted_at > since) && !(raw.offer_blocked_until !== null && raw.offer_blocked_until > now);
  }
}
