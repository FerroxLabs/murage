// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Push state in messages.db: one relay binding per paired device, the outbox
// (which is also the eventRef → private target map the detail route reads),
// the persisted risk rating of each approval, first-decision-wins records,
// and the relay removals still owed for bindings dropped here.
// Private ids live here and never leave this machine; what leaves
// is built from them in mobile-push-outbox.ts.
import type { DatabaseSync } from "node:sqlite";
import type { PushCategory, PushKind, PushRisk, ResolvedBy } from "../shared/mobile-push.ts";
import { newKeySecret } from "./mobile-push-keys.ts";

export interface PushBinding {
  bindingId: string; deviceId: string; publisherToken: string; createdAt: number; previewContent?: boolean;
  /** When this host last authorised a token pair for the binding, plus the
   *  pair's lifetime; null when it never recorded one (a pair from an older
   *  build). Nothing is published to a binding past this moment. */
  tokenExpiresAt?: number | null;
}
/** How long a token pair lives: the same figure as the companion's
 *  PUSH_TOKEN_TTL_MS (companion/src/devices.ts), which does not import from
 *  here. The outbox test pins the two together. */
export const PUSH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
/** A binding dropped here that the relay has not yet confirmed deleting.
 *  The relay never expires a binding on its own (R3), so until this row is
 *  cleared the phone's push token stays live there and counts against its
 *  per-device limit. The publisher token is the credential for that DELETE:
 *  never logged, never put in an error. */
export interface RelayRemoval { bindingId: string; publisherToken: string; attempts: number; nextAttemptAt: number; createdAt: number }
export type PushEventState = "held" | "pending" | "sent" | "exhausted" | "dropped";
export interface PushEventRow {
  eventRef: string; bindingId: string; kind: PushKind; category: PushCategory; botId: string; threadId: string;
  requestId: string | null; messageId: string | null; collapseKey: string; threadGroup: string; revision: number;
  timeSensitive: boolean; resolvedBy: ResolvedBy | null; createdAt: number; expiresAt: number;
  holdUntil: number; state: PushEventState; attempts: number; nextAttemptAt: number;
}

const RISK_KEEP_MS = 7 * 24 * 3600_000;
const DECISION_KEEP_MS = 30 * 24 * 3600_000;
/** Retry a relay removal for a month, backing off to hourly, then give up. */
const REMOVAL_GIVE_UP_MS = 30 * 24 * 3600_000;
const REMOVAL_MAX_BACKOFF_MS = 3600_000;

export function initializeMobilePush(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_bindings (
      binding_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, publisher_token TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_events (
      event_ref TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES push_bindings(binding_id) ON DELETE CASCADE,
      kind TEXT NOT NULL, category TEXT NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      request_id TEXT, message_id TEXT, collapse_key TEXT NOT NULL, thread_group TEXT NOT NULL,
      revision INTEGER NOT NULL, time_sensitive INTEGER NOT NULL, resolved_by TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, hold_until INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('held','pending','sent','exhausted','dropped')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS push_events_due ON push_events(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS push_events_request ON push_events(binding_id, request_id, revision);
    CREATE INDEX IF NOT EXISTS push_events_request_id ON push_events(request_id, revision);
    CREATE INDEX IF NOT EXISTS push_events_collapse ON push_events(binding_id, collapse_key, revision);
    CREATE TABLE IF NOT EXISTS push_risk (
      request_key TEXT PRIMARY KEY, risk TEXT NOT NULL CHECK (risk IN ('low','risky')), rated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_decisions (
      request_key TEXT PRIMARY KEY, decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
      device_id TEXT NOT NULL, revision INTEGER NOT NULL, decided_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_relay_removals (
      binding_id TEXT PRIMARY KEY, publisher_token TEXT NOT NULL, attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
  `);
  // H9 fix round 1: a rating belongs to the push revision it was made for.
  // Appended by ALTER, never in the CREATE text, so a database H2 made and a
  // fresh one end with the same schema (installation-database-snapshot lists
  // it as optional). Nullable: a rating with no revision is unrated for all.
  const riskColumns = db.prepare("PRAGMA table_info(push_risk)").all() as Array<{ name: string }>;
  if (!riskColumns.some((column) => column.name === "revision")) db.exec("ALTER TABLE push_risk ADD COLUMN revision INTEGER");
  // Final review M2: the host-only HMAC key for a binding's collapseKey and
  // threadGroup, the same ALTER pattern. Nullable: a binding from before it
  // gets one on first use (PushStore.keySecret).
  const bindingColumns = db.prepare("PRAGMA table_info(push_bindings)").all() as Array<{ name: string }>;
  if (!bindingColumns.some((column) => column.name === "key_secret")) db.exec("ALTER TABLE push_bindings ADD COLUMN key_secret TEXT");
  // Phone consent is separate from desktop previews. Existing bindings and
  // replacements start with generic text until this phone explicitly opts in.
  if (!bindingColumns.some((column) => column.name === "preview_content")) db.exec("ALTER TABLE push_bindings ADD COLUMN preview_content INTEGER NOT NULL DEFAULT 0");
  // RES-002: a decision whose answer() threw is marked "unknown" (it may or
  // may not have landed). NULL means recorded and not known to be unfinished.
  const decisionColumns = db.prepare("PRAGMA table_info(push_decisions)").all() as Array<{ name: string }>;
  if (!decisionColumns.some((column) => column.name === "outcome")) db.exec("ALTER TABLE push_decisions ADD COLUMN outcome TEXT");
  // RES-009: the host's own record of when a binding's token pair expires.
  // Nullable: a binding from before it has none and keeps publishing.
  if (!bindingColumns.some((column) => column.name === "token_expires_at")) db.exec("ALTER TABLE push_bindings ADD COLUMN token_expires_at INTEGER");
}

type Row = Record<string, string | number | null>;
const toBinding = (r: Row): PushBinding => ({
  bindingId: String(r.binding_id), deviceId: String(r.device_id), publisherToken: String(r.publisher_token), createdAt: Number(r.created_at),
  previewContent: r.preview_content === 1,
  tokenExpiresAt: r.token_expires_at === null || r.token_expires_at === undefined ? null : Number(r.token_expires_at),
});
const toEvent = (r: Row): PushEventRow => ({
  eventRef: String(r.event_ref), bindingId: String(r.binding_id), kind: r.kind as PushKind, category: r.category as PushCategory,
  botId: String(r.bot_id), threadId: String(r.thread_id), requestId: r.request_id === null ? null : String(r.request_id),
  messageId: r.message_id === null ? null : String(r.message_id), collapseKey: String(r.collapse_key), threadGroup: String(r.thread_group),
  revision: Number(r.revision), timeSensitive: Number(r.time_sensitive) === 1,
  resolvedBy: r.resolved_by === null ? null : (r.resolved_by as ResolvedBy),
  createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), holdUntil: Number(r.hold_until),
  state: r.state as PushEventState, attempts: Number(r.attempts), nextAttemptAt: Number(r.next_attempt_at),
});
const toRemoval = (r: Row): RelayRemoval => ({
  bindingId: String(r.binding_id), publisherToken: String(r.publisher_token), attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at), createdAt: Number(r.created_at),
});
const key = (threadId: string, requestId: string) => `${threadId}:${requestId}`;

export class PushStore {
  private readonly source: DatabaseSync | (() => DatabaseSync);
  /** A function is read on every call, so a store built once survives
   *  database() reopening messages.db after a restore. Written without a TS
   *  constructor parameter property: some harness tooling loads server/*.ts
   *  through Node's strip-only type stripping, which rejects that syntax. */
  constructor(source: DatabaseSync | (() => DatabaseSync)) {
    this.source = source;
  }
  private get db(): DatabaseSync {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  bindings(): PushBinding[] {
    return (this.db.prepare("SELECT * FROM push_bindings ORDER BY created_at").all() as Row[]).map(toBinding);
  }
  binding(bindingId: string): PushBinding | null {
    const r = this.db.prepare("SELECT * FROM push_bindings WHERE binding_id=?").get(bindingId) as Row | undefined;
    return r ? toBinding(r) : null;
  }
  bindingForDevice(deviceId: string): PushBinding | null {
    const r = this.db.prepare("SELECT * FROM push_bindings WHERE device_id=?").get(deviceId) as Row | undefined;
    return r ? toBinding(r) : null;
  }
  setPreviewContent(bindingId: string, enabled: boolean): void {
    this.db.prepare("UPDATE push_bindings SET preview_content=? WHERE binding_id=?").run(enabled ? 1 : 0, bindingId);
  }
  /** Synchronous work only; a savepoint when a caller already opened one. */
  private transaction<T>(operation: () => T): T {
    const db = this.db;
    const nested = db.isTransaction;
    db.exec(nested ? "SAVEPOINT push_store" : "BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec(nested ? "RELEASE push_store" : "COMMIT");
      return result;
    } catch (error) {
      db.exec(nested ? "ROLLBACK TO push_store; RELEASE push_store" : "ROLLBACK");
      throw error;
    }
  }
  /** The binding's host-only key secret for collapseKey and threadGroup,
   *  never sent anywhere. A binding made before secrets existed gets one
   *  now, kept from then on; null for a binding that is not here. */
  keySecret(bindingId: string): string | null {
    const read = () => this.db.prepare("SELECT key_secret FROM push_bindings WHERE binding_id=?").get(bindingId) as Row | undefined;
    const r = read();
    if (!r) return null;
    if (typeof r.key_secret === "string" && r.key_secret !== "") return r.key_secret;
    this.db.prepare("UPDATE push_bindings SET key_secret=? WHERE binding_id=? AND key_secret IS NULL").run(newKeySecret(), bindingId);
    const minted = read();
    return minted && typeof minted.key_secret === "string" ? minted.key_secret : null;
  }
  /** Deletes the binding and, in the same write, owes the relay its removal. */
  private drop(binding: PushBinding, now: number, atRelay: boolean): void {
    this.db.prepare("DELETE FROM push_bindings WHERE binding_id=?").run(binding.bindingId);
    if (atRelay) this.enqueueRelayRemoval(binding, now);
  }

  /** One binding per device; enrolling again replaces it and says what went.
   *  Atomic: a failed insert keeps the old binding and queues nothing. */
  putBinding(binding: PushBinding): PushBinding | null {
    return this.transaction(() => {
      const previous = this.bindingForDevice(binding.deviceId);
      if (previous) this.drop(previous, binding.createdAt, true);
      this.db.prepare("INSERT INTO push_bindings (binding_id,device_id,publisher_token,created_at,key_secret) VALUES (?,?,?,?,?)")
        .run(binding.bindingId, binding.deviceId, binding.publisherToken, binding.createdAt, newKeySecret());
      return previous;
    });
  }
  /** Record when this binding's token pair expires. */
  setTokenExpiry(bindingId: string, expiresAt: number): void {
    this.db.prepare("UPDATE push_bindings SET token_expires_at=? WHERE binding_id=?").run(expiresAt, bindingId);
  }
  /** `atRelay: false` when the relay itself said the binding is gone. */
  removeBinding(bindingId: string, o: { atRelay?: boolean; now?: number } = {}): void {
    this.transaction(() => {
      const binding = this.binding(bindingId);
      if (binding) this.drop(binding, o.now ?? Date.now(), o.atRelay !== false);
    });
  }
  removeDevice(deviceId: string, now = Date.now()): PushBinding | null {
    return this.transaction(() => {
      const previous = this.bindingForDevice(deviceId);
      if (previous) this.drop(previous, now, true);
      return previous;
    });
  }

  /** Idempotent: a binding already owed keeps its place and its backoff. */
  enqueueRelayRemoval(binding: Pick<PushBinding, "bindingId" | "publisherToken">, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO push_relay_removals (binding_id,publisher_token,attempts,next_attempt_at,created_at) VALUES (?,?,0,?,?)")
      .run(binding.bindingId, binding.publisherToken, now, now);
  }
  dueRelayRemovals(now: number, limit: number): RelayRemoval[] {
    return (this.db.prepare("SELECT * FROM push_relay_removals WHERE next_attempt_at<=? ORDER BY next_attempt_at, created_at, rowid LIMIT ?")
      .all(now, limit) as Row[]).map(toRemoval);
  }
  relayRemovalDone(bindingId: string): void {
    this.db.prepare("DELETE FROM push_relay_removals WHERE binding_id=?").run(bindingId);
  }
  /** Backs off like the outbox (doubling from a second), capped at an hour;
   *  a removal still failing a month after it was queued is given up. */
  relayRemovalFailed(bindingId: string, now: number): "retry" | "abandoned" | "gone" {
    const r = this.db.prepare("SELECT * FROM push_relay_removals WHERE binding_id=?").get(bindingId) as Row | undefined;
    if (!r) return "gone";
    const row = toRemoval(r);
    if (now - row.createdAt >= REMOVAL_GIVE_UP_MS) { this.relayRemovalDone(bindingId); return "abandoned"; }
    const attempts = row.attempts + 1;
    this.db.prepare("UPDATE push_relay_removals SET attempts=?, next_attempt_at=? WHERE binding_id=?")
      .run(attempts, now + Math.min(REMOVAL_MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 30)), bindingId);
    return "retry";
  }

  insertEvent(e: PushEventRow): void {
    this.db.prepare(`INSERT INTO push_events (event_ref,binding_id,kind,category,bot_id,thread_id,request_id,message_id,collapse_key,
      thread_group,revision,time_sensitive,resolved_by,created_at,expires_at,hold_until,state,attempts,next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.eventRef, e.bindingId, e.kind, e.category, e.botId, e.threadId, e.requestId, e.messageId, e.collapseKey, e.threadGroup,
      e.revision, e.timeSensitive ? 1 : 0, e.resolvedBy, e.createdAt, e.expiresAt, e.holdUntil, e.state, e.attempts, e.nextAttemptAt);
  }
  event(bindingId: string, eventRef: string): PushEventRow | null {
    const r = this.db.prepare("SELECT * FROM push_events WHERE binding_id=? AND event_ref=?").get(bindingId, eventRef) as Row | undefined;
    return r ? toEvent(r) : null;
  }
  latestForRequest(bindingId: string, requestId: string): PushEventRow | null {
    const r = this.db.prepare("SELECT * FROM push_events WHERE binding_id=? AND request_id=? ORDER BY revision DESC LIMIT 1")
      .get(bindingId, requestId) as Row | undefined;
    return r ? toEvent(r) : null;
  }
  /** Drops every held or pending row of the request on this binding and
   *  records who answered, in one write. A row whose send is on the wire is
   *  dropped too: if the relay then accepts it, the outbox replaces it. */
  dropUnsentForRequest(bindingId: string, requestId: string, resolvedBy: ResolvedBy): number {
    return Number(this.db.prepare("UPDATE push_events SET state='dropped', resolved_by=? WHERE binding_id=? AND request_id=? AND state IN ('held','pending')")
      .run(resolvedBy, bindingId, requestId).changes);
  }
  /** Whether any revision of the request, other than a resolution, was
   *  accepted for this binding: something the phone shows. */
  sentForRequest(bindingId: string, requestId: string): boolean {
    return this.db.prepare("SELECT 1 AS yes FROM push_events WHERE binding_id=? AND request_id=? AND state='sent' AND category<>'resolved' LIMIT 1")
      .get(bindingId, requestId) !== undefined;
  }
  /** The request's newest push revision on any binding, 0 for none. One
   *  counter per request, shared by every phone (H10): equal revision
   *  numbers then mean equal content everywhere, and one push_risk row per
   *  request can be rated for exactly the revision every phone holds. */
  requestRevision(requestId: string): number {
    const r = this.db.prepare("SELECT MAX(revision) AS revision FROM push_events WHERE request_id=?").get(requestId) as Row | undefined;
    return r && r.revision !== null ? Number(r.revision) : 0;
  }
  /** The revision the next push of this request gets: past every event
   *  still stored AND past the revision its rating was made for. Events
   *  alone are not enough: an enqueue with no phone, a removed binding's
   *  cascade, or pruning can leave the rating's number unused, and issuing
   *  it again would let a failed re-rate leave the old rating in force
   *  (H10 fix round 1). The rating row outlives every event (7 days against
   *  12 hours), and once it is pruned there is no rating left to reuse. */
  nextRevision(threadId: string, requestId: string): number {
    const r = this.db.prepare("SELECT revision FROM push_risk WHERE request_key=?").get(key(threadId, requestId)) as Row | undefined;
    const rated = r && r.revision !== null ? Number(r.revision) : 0;
    return Math.max(this.requestRevision(requestId), rated) + 1;
  }
  bindingsWithRequest(requestId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT binding_id FROM push_events WHERE request_id=? ORDER BY binding_id").all(requestId) as Row[])
      .map((r) => String(r.binding_id));
  }
  /** Pending work whose retry time came, and held work whose hold ended. */
  due(now: number, limit: number): PushEventRow[] {
    return (this.db.prepare(`SELECT * FROM push_events WHERE (state='pending' AND next_attempt_at<=?) OR (state='held' AND hold_until<=?)
      ORDER BY created_at, revision, rowid LIMIT ?`).all(now, now, limit) as Row[]).map(toEvent);
  }
  /** `resolvedBy` on a dropped row records who answered it, so a send that
   *  was already on the wire and then lands can still be replaced. */
  update(eventRef: string, patch: Partial<Pick<PushEventRow, "state" | "attempts" | "nextAttemptAt" | "resolvedBy">>): void {
    const current = this.db.prepare("SELECT * FROM push_events WHERE event_ref=?").get(eventRef) as Row | undefined;
    if (!current) return;
    const next = { ...toEvent(current), ...patch };
    this.db.prepare("UPDATE push_events SET state=?,attempts=?,next_attempt_at=?,resolved_by=? WHERE event_ref=?")
      .run(next.state, next.attempts, next.nextAttemptAt, next.resolvedBy, eventRef);
  }
  /** Same write as update(), but only when the row's stored state is still
   *  `expected`. A flush's own send outcome must not resurrect a row a
   *  concurrent resolve() already dropped while that send was in flight. */
  updateIfState(eventRef: string, expected: PushEventState, patch: Partial<Pick<PushEventRow, "state" | "attempts" | "nextAttemptAt">>): boolean {
    const current = this.db.prepare("SELECT * FROM push_events WHERE event_ref=?").get(eventRef) as Row | undefined;
    if (!current || String(current.state) !== expected) return false;
    const next = { ...toEvent(current), ...patch };
    this.db.prepare("UPDATE push_events SET state=?,attempts=?,next_attempt_at=? WHERE event_ref=?")
      .run(next.state, next.attempts, next.nextAttemptAt, eventRef);
    return true;
  }
  /** Attention still waiting on this device: the newest revision of each
   *  collapse key, unexpired, not a resolution, not dropped. */
  pendingFor(bindingId: string, now: number): PushEventRow[] {
    const rows = (this.db.prepare(`SELECT e.* FROM push_events e WHERE e.binding_id=? AND e.expires_at>? AND e.revision=(
        SELECT MAX(revision) FROM push_events x WHERE x.binding_id=e.binding_id AND x.collapse_key=e.collapse_key)
      ORDER BY e.created_at, e.rowid`).all(bindingId, now) as Row[]).map(toEvent);
    return rows.filter((r) => r.category !== "resolved" && r.category !== "done" && r.state !== "dropped");
  }

  /** `revision` is the push revision the rating was made for; left out, the
   *  rating is stored for none and risk() with a revision reads it as unrated. */
  rateRisk(threadId: string, requestId: string, risk: "low" | "risky", now: number, revision?: number): void {
    this.db.prepare(`INSERT INTO push_risk (request_key,risk,rated_at,revision) VALUES (?,?,?,?)
      ON CONFLICT(request_key) DO UPDATE SET risk=excluded.risk, rated_at=excluded.rated_at, revision=excluded.revision`)
      .run(key(threadId, requestId), risk, now, revision ?? null);
  }
  /** With a revision, only a rating made for exactly that revision counts:
   *  one for an older (or no) revision is "unrated", so Allow needs step-up. */
  risk(threadId: string, requestId: string, revision?: number): PushRisk {
    const r = this.db.prepare("SELECT risk, revision FROM push_risk WHERE request_key=?").get(key(threadId, requestId)) as Row | undefined;
    if (!r) return "unrated";
    if (revision !== undefined && (r.revision === null || Number(r.revision) !== revision)) return "unrated";
    return r.risk as "low" | "risky";
  }
  /** One statement, so two callers can never both win. */
  decide(threadId: string, requestId: string, decision: "allow" | "deny", deviceId: string, revision: number, now: number): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO push_decisions (request_key,decision,device_id,revision,decided_at) VALUES (?,?,?,?,?)")
      .run(key(threadId, requestId), decision, deviceId, revision, now);
    return Number(result.changes) === 1;
  }

  /** answer() threw: the row stays (first-wins), but is marked unfinished. */
  markUnknown(threadId: string, requestId: string): void {
    this.db.prepare("UPDATE push_decisions SET outcome='unknown' WHERE request_key=?").run(key(threadId, requestId));
  }
  /** Take an unfinished decision over for one more try. One statement, so two
   *  retries can never both win. A Deny may always follow, from any device and
   *  revision, and the row then records the device and revision that denied.
   *  An Allow only follows an unfinished Allow made by the same device on the
   *  same notification revision. */
  retryUnknown(threadId: string, requestId: string, decision: "allow" | "deny", deviceId: string, revision: number, now: number): boolean {
    const result = this.db.prepare("UPDATE push_decisions SET outcome=NULL, decision=?, device_id=?, revision=?, decided_at=? WHERE request_key=? AND outcome='unknown' AND (?='deny' OR (decision='allow' AND device_id=? AND revision=?))")
      .run(decision, deviceId, revision, now, key(threadId, requestId), decision, deviceId, revision);
    return Number(result.changes) === 1;
  }
  /** The decision of an unfinished answer, or null when there is none. */
  unfinishedDecision(threadId: string, requestId: string): "allow" | "deny" | null {
    const r = this.db.prepare("SELECT decision FROM push_decisions WHERE request_key=? AND outcome='unknown'").get(key(threadId, requestId)) as Row | undefined;
    return r ? (r.decision as "allow" | "deny") : null;
  }
  /** The decision was recorded but its answer did not finish. */
  isUnknown(threadId: string, requestId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM push_decisions WHERE request_key=? AND outcome='unknown'").get(key(threadId, requestId)) !== undefined;
  }

  prune(now: number): void {
    this.db.prepare("DELETE FROM push_events WHERE expires_at<=?").run(now);
    this.db.prepare("DELETE FROM push_risk WHERE rated_at<=?").run(now - RISK_KEEP_MS);
    this.db.prepare("DELETE FROM push_decisions WHERE decided_at<=?").run(now - DECISION_KEEP_MS);
  }
}
