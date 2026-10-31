// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app triggers (design GAP-APP-TRIGGERS-109 rev 1.5, slice AT-S1): the messages.db store. Sections 4.2, 4.3
// and 6.2-6.3. Every table here is indexed so the rows one event visits never grow with retained history (AT-15).
// Transactions are short and synchronous; nothing in this file does network I/O. A leaf: no server state imports, so the
// snapshot inspector can build its reference schema from initializeAppTriggers.
//
//   app_trigger_bindings   one row per trigger: the home's authenticated binding (owner, subscription, policy, billing)
//   app_trigger_policies   immutable policy revisions; the child ceilings are CHECKed zero
//   app_event_inbox        accepted deliveries (custody); unique owner/trigger/source key
//   app_event_tombstones   dropped deliveries (filtered, stale, refused): identity and disposition only, no content
//   app_event_batches      one open batch per trigger; sealed membership of at most 20
//   app_event_run_events   batch membership; a delivery belongs to at most one batch
//   app_event_runs         one run per sealed batch, with its Flux receipts, lineage and the child-refusal receipt
import type { DatabaseSync } from "node:sqlite";
import {
  APP_RUN_TERMINAL, appTriggerBindingSchema, appTriggerPolicySchema, type AppClaimItem, type AppInboxDisposition, type AppRunState,
  type AppTriggerBinding, type AppTriggerPolicy, type AppTriggerSyncState,
} from "../shared/app-triggers.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS app_trigger_bindings (
  trigger_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, bot_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL, sync_state TEXT NOT NULL, binding TEXT NOT NULL,
  child_creates INTEGER NOT NULL DEFAULT 0 CHECK (child_creates = 0), child_handoffs INTEGER NOT NULL DEFAULT 0 CHECK (child_handoffs = 0),
  updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS app_trigger_bindings_routine ON app_trigger_bindings(routine_id) WHERE sync_state <> 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS app_trigger_bindings_subscription ON app_trigger_bindings(subscription_id);
CREATE INDEX IF NOT EXISTS app_trigger_bindings_owner ON app_trigger_bindings(owner_account_id, sync_state);
CREATE TABLE IF NOT EXISTS app_trigger_policies (
  policy_id TEXT NOT NULL, revision INTEGER NOT NULL, trigger_id TEXT NOT NULL, policy TEXT NOT NULL,
  child_creates INTEGER NOT NULL DEFAULT 0 CHECK (child_creates = 0), child_handoffs INTEGER NOT NULL DEFAULT 0 CHECK (child_handoffs = 0),
  created_at INTEGER NOT NULL, PRIMARY KEY (policy_id, revision));
CREATE INDEX IF NOT EXISTS app_trigger_policies_trigger ON app_trigger_policies(trigger_id, revision);
CREATE TABLE IF NOT EXISTS app_event_inbox (
  delivery_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, trigger_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
  source_key TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, deadline_at TEXT NOT NULL, catch_up INTEGER NOT NULL,
  digest TEXT NOT NULL, projection TEXT, bytes INTEGER NOT NULL, disposition TEXT NOT NULL CHECK (disposition IN ('ready','batched','stale','rejected')),
  claim_id TEXT, acked INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS app_event_inbox_source ON app_event_inbox(owner_account_id, trigger_id, source_key);
CREATE INDEX IF NOT EXISTS app_event_inbox_ready ON app_event_inbox(trigger_id, received_at) WHERE disposition = 'ready' AND acked = 1;
CREATE INDEX IF NOT EXISTS app_event_inbox_unacked ON app_event_inbox(claim_id) WHERE acked = 0;
CREATE TABLE IF NOT EXISTS app_event_tombstones (
  delivery_id TEXT PRIMARY KEY, owner_account_id TEXT, trigger_id TEXT, source_key TEXT, digest TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('filtered','stale','rejected','duplicate')), claim_id TEXT, acked INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS app_event_tombstones_unacked ON app_event_tombstones(claim_id) WHERE acked = 0;
CREATE INDEX IF NOT EXISTS app_event_tombstones_at ON app_event_tombstones(at);
CREATE TABLE IF NOT EXISTS app_event_batches (
  batch_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','sealed','closed')),
  opened_at INTEGER NOT NULL, seal_due_at INTEGER NOT NULL, member_count INTEGER NOT NULL DEFAULT 0 CHECK (member_count BETWEEN 0 AND 20),
  member_bytes INTEGER NOT NULL DEFAULT 0, run_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS app_event_batches_open ON app_event_batches(trigger_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS app_event_batches_due ON app_event_batches(seal_due_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS app_event_batches_unrun ON app_event_batches(opened_at) WHERE state = 'sealed' AND run_id IS NULL;
CREATE TABLE IF NOT EXISTS app_event_run_events (
  batch_id TEXT NOT NULL, delivery_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  PRIMARY KEY (batch_id, position));
CREATE UNIQUE INDEX IF NOT EXISTS app_event_run_events_delivery ON app_event_run_events(delivery_id);
CREATE TABLE IF NOT EXISTS app_event_runs (
  run_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL UNIQUE, trigger_id TEXT NOT NULL, routine_id TEXT NOT NULL, bot_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL, policy_digest TEXT NOT NULL, billing_ref TEXT,
  state TEXT NOT NULL, wait_reason TEXT, retry_at INTEGER, flux_revision INTEGER,
  reserve_receipt TEXT, start_receipt TEXT, submitted INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT, generation TEXT, renew_due_at INTEGER,
  child_refusal TEXT, child_card TEXT, child_card_written INTEGER NOT NULL DEFAULT 0,
  child_creates INTEGER NOT NULL DEFAULT 0 CHECK (child_creates = 0), child_handoffs INTEGER NOT NULL DEFAULT 0 CHECK (child_handoffs = 0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS app_event_runs_active ON app_event_runs(trigger_id, created_at) WHERE state NOT IN ('completed','failed','cancelled','outcome_unknown','refused');
CREATE INDEX IF NOT EXISTS app_event_runs_due ON app_event_runs(retry_at) WHERE state NOT IN ('completed','failed','cancelled','outcome_unknown','refused');
CREATE INDEX IF NOT EXISTS app_event_runs_thread ON app_event_runs(thread_id, created_at) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_event_runs_history ON app_event_runs(routine_id, created_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS app_event_runs_card_owed ON app_event_runs(run_id) WHERE child_refusal IS NOT NULL AND child_card_written = 0;
`;

/** The tables this store creates (the snapshot inspector and the restore fence list them). */
export const APP_TRIGGER_TABLES = ["app_trigger_bindings", "app_trigger_policies", "app_event_inbox", "app_event_tombstones", "app_event_batches", "app_event_run_events", "app_event_runs"] as const;

const APP_TRIGGER_INDEXES = ["app_trigger_bindings_routine", "app_trigger_bindings_subscription", "app_trigger_bindings_owner", "app_trigger_policies_trigger",
  "app_event_inbox_source", "app_event_inbox_ready", "app_event_inbox_unacked", "app_event_tombstones_unacked", "app_event_tombstones_at", "app_event_batches_open",
  "app_event_batches_due", "app_event_batches_unrun", "app_event_run_events_delivery", "app_event_runs_active", "app_event_runs_due", "app_event_runs_thread",
  "app_event_runs_history", "app_event_runs_card_owed"] as const;
/** Every object this store makes in messages.db, for the downgrade's own frozen checks (pm-sends-102-r22). */
export const APP_TRIGGER_OBJECTS: readonly string[] = Object.freeze([...APP_TRIGGER_TABLES, ...APP_TRIGGER_INDEXES]);

export function initializeAppTriggers(db: DatabaseSync): void { db.exec(DDL); }

/** Going back to any build without connected-app triggers: the seven tables leave in one commit, and their indexes with them.
 * Held rows leave too. Nothing writes these tables yet (no AppTriggerDelivery is built outside tests, and no route creates an
 * app_event routine), so the slice has no owed event to keep; the slice that wires delivery owes a refusal here while a
 * delivery or run is still owed. An app_event routine stays in routines.json, and no older build loads or runs it (from 1.0.9
 * it is kept unloaded; before that it is skipped). Idempotent: a stopped run does this again. */
export function downgradeAppTriggers(db: DatabaseSync): { dropped: number } {
  const present = (name: string) => !!db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  const tables = APP_TRIGGER_TABLES.filter(present);
  if (!tables.length) return { dropped: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of tables) db.exec(`DROP TABLE ${name}`);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return { dropped: tables.length };
}

const sortReceipts = <T extends { deliveryId: string }>(receipts: T[]): T[] => receipts.sort((a, b) => (a.deliveryId < b.deliveryId ? -1 : a.deliveryId > b.deliveryId ? 1 : 0));

/** One synchronous transaction; a savepoint inside one the caller already holds. Never awaits. */
function inTx<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) {
    db.exec("SAVEPOINT app_trigger_tx");
    try { const out = work(); db.exec("RELEASE app_trigger_tx"); return out; }
    catch (error) { db.exec("ROLLBACK TO app_trigger_tx"); db.exec("RELEASE app_trigger_tx"); throw error; }
  }
  db.exec("BEGIN IMMEDIATE");
  try { const out = work(); db.exec("COMMIT"); return out; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

// ── runs ─────────────────────────────────────────────────────────────────────

/** The child-refusal receipt (section 7.1): bounded, and the only thing the explanation card is built from. */
export interface AppChildRefusalReceipt { code: "app_child_not_allowed"; kind: "create" | "ask" | "delegate" | "recovered"; at: number; attempts: number }

export interface AppEventRun {
  runId: string; batchId: string; triggerId: string; routineId: string; botId: string; ownerAccountId: string; subscriptionId: string;
  policyDigest: string; billingRef: string | null; state: AppRunState; waitReason: string | null; retryAt: number | null; fluxRevision: number | null;
  reserveReceipt: unknown; startReceipt: unknown; submitted: boolean;
  threadId: string | null; generation: string | null; renewDueAt: number | null;
  childRefusal: AppChildRefusalReceipt | null; childCard: AppChildCard | null; childCardWritten: boolean;
  childCreates: 0; childHandoffs: 0; createdAt: number; updatedAt: number;
}
export interface AppChildCard { id: string; runId: string; routineId: string; text: string; actions: ReadonlyArray<"open_routine" | "ask_my_bot"> }

type RunPatch = Partial<Pick<AppEventRun, "state" | "waitReason" | "retryAt" | "fluxRevision" | "reserveReceipt" | "startReceipt" | "submitted" | "threadId" | "generation" | "renewDueAt">>;

/** The indexed store RoutineManager.appRunStore exposes (section 4.3). */
export interface AppEventRunStore {
  create(run: Pick<AppEventRun, "runId" | "batchId" | "triggerId" | "routineId" | "botId" | "ownerAccountId" | "subscriptionId" | "policyDigest" | "billingRef"> & { state?: AppRunState; now: number }): AppEventRun;
  update(runId: string, patch: RunPatch, now: number, expectedState?: AppRunState): AppEventRun | null;
  findById(runId: string): AppEventRun | null;
  findActive(triggerId: string): AppEventRun[];
  findByThread(threadId: string, generation?: string): AppEventRun | null;
  history(routineId: string, options?: { before?: { createdAt: number; runId: string }; limit?: number }): AppEventRun[];
}

interface RunRow {
  run_id: string; batch_id: string; trigger_id: string; routine_id: string; bot_id: string; owner_account_id: string; subscription_id: string;
  policy_digest: string; billing_ref: string | null; state: string; wait_reason: string | null; retry_at: number | null; flux_revision: number | null;
  reserve_receipt: string | null; start_receipt: string | null; submitted: number;
  thread_id: string | null; generation: string | null; renew_due_at: number | null; child_refusal: string | null; child_card: string | null;
  child_card_written: number; child_creates: number; child_handoffs: number; created_at: number; updated_at: number;
}
const parseJson = (text: string | null): unknown => (text === null ? null : JSON.parse(text));
const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

function toRun(row: RunRow): AppEventRun {
  return {
    runId: row.run_id, batchId: row.batch_id, triggerId: row.trigger_id, routineId: row.routine_id, botId: row.bot_id, ownerAccountId: row.owner_account_id,
    subscriptionId: row.subscription_id, policyDigest: row.policy_digest, billingRef: row.billing_ref, state: row.state as AppRunState, waitReason: row.wait_reason,
    retryAt: row.retry_at, fluxRevision: row.flux_revision, reserveReceipt: parseJson(row.reserve_receipt), startReceipt: parseJson(row.start_receipt),
    submitted: row.submitted === 1, threadId: row.thread_id, generation: row.generation,
    renewDueAt: row.renew_due_at, childRefusal: parseJson(row.child_refusal) as AppChildRefusalReceipt | null, childCard: parseJson(row.child_card) as AppChildCard | null,
    childCardWritten: row.child_card_written === 1, childCreates: 0, childHandoffs: 0, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  state: "state", waitReason: "wait_reason", retryAt: "retry_at", fluxRevision: "flux_revision", reserveReceipt: "reserve_receipt", startReceipt: "start_receipt",
  submitted: "submitted", threadId: "thread_id", generation: "generation", renewDueAt: "renew_due_at",
};
const JSON_COLUMNS = new Set<keyof RunPatch>(["reserveReceipt", "startReceipt"]);

/** The SQL every per-event step runs. Exported so the scale test can hold each to an index search (AT-15). */
export const PER_EVENT_SQL = {
  bindingForSubscription: "SELECT binding, sync_state FROM app_trigger_bindings WHERE subscription_id=?",
  inboxById: "SELECT disposition, acked FROM app_event_inbox WHERE delivery_id=?",
  tombstoneById: "SELECT disposition, acked FROM app_event_tombstones WHERE delivery_id=?",
  inboxBySource: "SELECT delivery_id FROM app_event_inbox WHERE owner_account_id=? AND trigger_id=? AND source_key=?",
  openBatch: "SELECT batch_id, member_count, member_bytes, seal_due_at FROM app_event_batches WHERE trigger_id=? AND state='open'",
  // only deliveries Flux confirmed as acknowledged join a batch: reserve covers acknowledged events only (README reserve)
  readyForTrigger: "SELECT delivery_id, bytes FROM app_event_inbox WHERE trigger_id=? AND disposition='ready' AND acked=1 ORDER BY received_at LIMIT ?",
  triggersWithReady: "SELECT DISTINCT trigger_id FROM app_event_inbox WHERE disposition='ready' AND acked=1 LIMIT ?",
  unackedInboxClaims: "SELECT DISTINCT claim_id FROM app_event_inbox WHERE acked=0 AND claim_id IS NOT NULL LIMIT ?",
  unackedTombstoneClaims: "SELECT DISTINCT claim_id FROM app_event_tombstones WHERE acked=0 AND claim_id IS NOT NULL LIMIT ?",
  claimInbox: "SELECT delivery_id FROM app_event_inbox WHERE claim_id=? AND acked=0",
  claimTombstones: "SELECT delivery_id FROM app_event_tombstones WHERE claim_id=? AND acked=0",
  sealedWithoutRun: "SELECT batch_id, trigger_id FROM app_event_batches WHERE state='sealed' AND run_id IS NULL ORDER BY opened_at LIMIT ?",
  runningAtStart: "SELECT * FROM app_event_runs WHERE state NOT IN ('completed','failed','cancelled','outcome_unknown','refused') AND submitted=1 LIMIT ?",
  runById: "SELECT * FROM app_event_runs WHERE run_id=?",
  runsActive: "SELECT * FROM app_event_runs WHERE trigger_id=? AND state NOT IN ('completed','failed','cancelled','outcome_unknown','refused') ORDER BY created_at",
  runByThread: "SELECT * FROM app_event_runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1",
  historyFirst: "SELECT * FROM app_event_runs WHERE routine_id=? ORDER BY created_at DESC, run_id DESC LIMIT ?",
  historyAfter: "SELECT * FROM app_event_runs WHERE routine_id=? AND (created_at, run_id) < (?, ?) ORDER BY created_at DESC, run_id DESC LIMIT ?",
  dueBatches: "SELECT batch_id, trigger_id FROM app_event_batches WHERE state='open' AND seal_due_at<=? ORDER BY seal_due_at LIMIT ?",
  dueRuns: "SELECT * FROM app_event_runs WHERE state NOT IN ('completed','failed','cancelled','outcome_unknown','refused') AND retry_at<=? ORDER BY retry_at LIMIT ?",
  cardsOwed: "SELECT * FROM app_event_runs WHERE child_refusal IS NOT NULL AND child_card_written = 0 LIMIT ?",
} as const;

export class AppTriggerStore implements AppEventRunStore {
  private readonly db: DatabaseSync;
  // no parameter properties: the server runs with type stripping only
  constructor(db: DatabaseSync) { this.db = db; initializeAppTriggers(db); }

  // ── bindings and policies ──

  putBinding(binding: AppTriggerBinding, now: number): AppTriggerBinding {
    const clean = appTriggerBindingSchema.parse(binding);
    this.db.prepare(`INSERT INTO app_trigger_bindings (trigger_id, routine_id, bot_id, owner_account_id, subscription_id, sync_state, binding, updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(trigger_id) DO UPDATE SET sync_state=excluded.sync_state, binding=excluded.binding, updated_at=excluded.updated_at
      WHERE app_trigger_bindings.owner_account_id=excluded.owner_account_id AND app_trigger_bindings.subscription_id=excluded.subscription_id AND app_trigger_bindings.routine_id=excluded.routine_id`)
      .run(clean.triggerId, clean.routineId, clean.botId, clean.ownerAccountId, clean.subscriptionId, clean.syncState, JSON.stringify(clean), now);
    const stored = this.binding(clean.triggerId);
    // A trigger id never moves to another owner, subscription or routine: that is a new setup (section 5.3).
    if (!stored || stored.ownerAccountId !== clean.ownerAccountId || stored.subscriptionId !== clean.subscriptionId || stored.routineId !== clean.routineId) {
      throw new Error("A trigger keeps its owner, subscription and routine; set up a new trigger instead");
    }
    return stored;
  }

  binding(triggerId: string): AppTriggerBinding | null {
    const row = this.db.prepare("SELECT binding, sync_state FROM app_trigger_bindings WHERE trigger_id=?").get(triggerId) as { binding: string; sync_state: string } | undefined;
    return row ? this.readBinding(row) : null;
  }

  /** The binding a delivery's subscription names, or null. A row that no longer parses is no binding (fail closed). */
  bindingForSubscription(subscriptionId: string): AppTriggerBinding | null {
    const row = this.db.prepare(PER_EVENT_SQL.bindingForSubscription).get(subscriptionId) as { binding: string; sync_state: string } | undefined;
    return row ? this.readBinding(row) : null;
  }

  private readBinding(row: { binding: string; sync_state: string }): AppTriggerBinding | null {
    try {
      const parsed = appTriggerBindingSchema.safeParse({ ...(JSON.parse(row.binding) as object), syncState: row.sync_state });
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  setSyncState(triggerId: string, state: AppTriggerSyncState, now: number): boolean {
    return Number(this.db.prepare("UPDATE app_trigger_bindings SET sync_state=?, updated_at=? WHERE trigger_id=? AND sync_state <> 'deleted'").run(state, now, triggerId).changes) === 1;
  }

  putPolicy(policy: AppTriggerPolicy, now: number): void {
    const clean = appTriggerPolicySchema.parse(policy);
    // Immutable revisions: the same revision written again must be the same policy.
    const existing = this.db.prepare("SELECT policy FROM app_trigger_policies WHERE policy_id=? AND revision=?").get(clean.policyId, clean.revision) as { policy: string } | undefined;
    if (existing) { if (existing.policy !== JSON.stringify(clean)) throw new Error("A policy revision never changes"); return; }
    this.db.prepare("INSERT INTO app_trigger_policies (policy_id, revision, trigger_id, policy, created_at) VALUES (?,?,?,?,?)").run(clean.policyId, clean.revision, clean.triggerId, JSON.stringify(clean), now);
  }

  policy(policyId: string, revision: number): AppTriggerPolicy | null {
    const row = this.db.prepare("SELECT policy FROM app_trigger_policies WHERE policy_id=? AND revision=?").get(policyId, revision) as { policy: string } | undefined;
    if (!row) return null;
    const parsed = appTriggerPolicySchema.safeParse(JSON.parse(row.policy));
    return parsed.success ? parsed.data : null;
  }

  // ── custody (section 6.2: commit before ack) ──

  /**
   * Commit one claim's dispositions in ONE transaction, before the ack is sent. An accepted delivery enters the inbox;
   * a dropped one leaves a tombstone with no content (a foreign one keeps only its delivery id). A delivery already
   * committed keeps its first disposition, so a replayed claim acks exactly what it acked before.
   */
  commitClaim(claimId: string, entries: ReadonlyArray<CustodyEntry>, now: number): Array<{ deliveryId: string; disposition: "accepted" | "dropped" }> {
    return sortReceipts(inTx(this.db, () => entries.map(entry => ({ deliveryId: entry.item.deliveryId, disposition: this.commitOne(claimId, entry, now) }))));
  }

  private commitOne(claimId: string, entry: CustodyEntry, now: number): "accepted" | "dropped" {
    const { item } = entry;
    const inbox = this.db.prepare(PER_EVENT_SQL.inboxById).get(item.deliveryId) as { disposition: string } | undefined;
    if (inbox) { this.db.prepare("UPDATE app_event_inbox SET claim_id=?, acked=0 WHERE delivery_id=? AND acked=0").run(claimId, item.deliveryId); return "accepted"; }
    const tomb = this.db.prepare(PER_EVENT_SQL.tombstoneById).get(item.deliveryId) as { disposition: string } | undefined;
    if (tomb) { this.db.prepare("UPDATE app_event_tombstones SET claim_id=?, acked=0 WHERE delivery_id=? AND acked=0").run(claimId, item.deliveryId); return "dropped"; }
    if (entry.disposition !== "accept") {
      const foreign = entry.binding === null;
      this.db.prepare("INSERT INTO app_event_tombstones (delivery_id, owner_account_id, trigger_id, source_key, digest, disposition, claim_id, at) VALUES (?,?,?,?,?,?,?,?)")
        .run(item.deliveryId, foreign ? null : entry.binding!.ownerAccountId, foreign ? null : entry.binding!.triggerId, foreign ? null : item.sourceKey, foreign ? null : item.digest, entry.disposition, claimId, now);
      return "dropped";
    }
    const binding = entry.binding!;
    // One automatic admission per logical event: the same owner/trigger/source under a new delivery id is a duplicate.
    if (this.db.prepare(PER_EVENT_SQL.inboxBySource).get(binding.ownerAccountId, binding.triggerId, item.sourceKey)) {
      this.db.prepare("INSERT INTO app_event_tombstones (delivery_id, owner_account_id, trigger_id, source_key, digest, disposition, claim_id, at) VALUES (?,?,?,?,?,'duplicate',?,?)")
        .run(item.deliveryId, binding.ownerAccountId, binding.triggerId, item.sourceKey, item.digest, claimId, now);
      return "dropped";
    }
    const projection = JSON.stringify(item.projection);
    this.db.prepare(`INSERT INTO app_event_inbox (delivery_id, owner_account_id, trigger_id, subscription_id, source_key, event_type, occurred_at, deadline_at, catch_up, digest, projection, bytes, disposition, claim_id, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)`)
      .run(item.deliveryId, binding.ownerAccountId, binding.triggerId, item.subscriptionId, item.sourceKey, item.eventType, item.occurredAt, item.deadlineAt, item.catchUp ? 1 : 0, item.digest, projection, Buffer.byteLength(projection, "utf8"), claimId, now);
    return "accepted";
  }

  /** After Flux answered the ack: the claim's rows are acknowledged. */
  markAcked(claimId: string): void {
    inTx(this.db, () => {
      this.db.prepare("UPDATE app_event_inbox SET acked=1 WHERE claim_id=? AND acked=0").run(claimId);
      this.db.prepare("UPDATE app_event_tombstones SET acked=1 WHERE claim_id=? AND acked=0").run(claimId);
    });
  }

  /** Claims whose ack was never confirmed, bounded. Their exact receipts are replayed before any new claim. */
  unackedClaims(limit: number): string[] {
    const ids = new Set<string>();
    for (const sql of [PER_EVENT_SQL.unackedInboxClaims, PER_EVENT_SQL.unackedTombstoneClaims]) {
      for (const row of this.db.prepare(sql).all(limit) as Array<{ claim_id: string }>) ids.add(row.claim_id);
    }
    return [...ids].slice(0, limit);
  }

  /** The receipts this home committed for one claim, in a fixed order (by delivery id), so a replay is identical. */
  claimReceipts(claimId: string): Array<{ deliveryId: string; disposition: "accepted" | "dropped" }> {
    const accepted = (this.db.prepare(PER_EVENT_SQL.claimInbox).all(claimId) as Array<{ delivery_id: string }>).map(row => ({ deliveryId: row.delivery_id, disposition: "accepted" as const }));
    const dropped = (this.db.prepare(PER_EVENT_SQL.claimTombstones).all(claimId) as Array<{ delivery_id: string }>).map(row => ({ deliveryId: row.delivery_id, disposition: "dropped" as const }));
    return sortReceipts([...accepted, ...dropped]);
  }

  /** Flux answered lease_expired for an uncommitted claim: its rows wait, unacknowledged, for Flux to redeliver them
   * under a new claim (which re-binds them). They never join a batch meanwhile and are not replayed again. */
  releaseClaim(claimId: string): void {
    inTx(this.db, () => {
      this.db.prepare("UPDATE app_event_inbox SET claim_id=NULL WHERE claim_id=? AND acked=0").run(claimId);
      this.db.prepare("UPDATE app_event_tombstones SET claim_id=NULL WHERE claim_id=? AND acked=0").run(claimId);
    });
  }

  /** Runs that had been submitted when the process stopped (startup reconciliation), bounded. */
  submittedRuns(limit: number): AppEventRun[] {
    return (this.db.prepare(PER_EVENT_SQL.runningAtStart).all(limit) as unknown as RunRow[]).map(toRun);
  }

  inboxRow(deliveryId: string): { disposition: AppInboxDisposition | "dropped"; acked: boolean; tombstone?: string } | null {
    const inbox = this.db.prepare(PER_EVENT_SQL.inboxById).get(deliveryId) as { disposition: AppInboxDisposition; acked: number } | undefined;
    if (inbox) return { disposition: inbox.disposition, acked: inbox.acked === 1 };
    const tomb = this.db.prepare(PER_EVENT_SQL.tombstoneById).get(deliveryId) as { disposition: string; acked: number } | undefined;
    return tomb ? { disposition: "dropped", acked: tomb.acked === 1, tombstone: tomb.disposition } : null;
  }

  /** A delivery whose deadline passed before it joined a run: kept as stale, shown as a state. */
  markStale(deliveryId: string): void {
    this.db.prepare("UPDATE app_event_inbox SET disposition='stale', projection=NULL WHERE delivery_id=? AND disposition='ready'").run(deliveryId);
  }

  readyDeliveries(triggerId: string, limit: number): Array<{ deliveryId: string; bytes: number }> {
    return (this.db.prepare(PER_EVENT_SQL.readyForTrigger).all(triggerId, limit) as Array<{ delivery_id: string; bytes: number }>).map(row => ({ deliveryId: row.delivery_id, bytes: row.bytes }));
  }

  /** Triggers with ready deliveries, bounded (the claim loop walks at most this many per pass). */
  triggersWithReady(limit: number): string[] {
    return (this.db.prepare(PER_EVENT_SQL.triggersWithReady).all(limit) as Array<{ trigger_id: string }>).map(row => row.trigger_id);
  }

  deliveryForRun(deliveryId: string): { deliveryId: string; deadlineAt: string; sourceKey: string; eventType: string; digest: string } | null {
    const row = this.db.prepare("SELECT delivery_id, deadline_at, source_key, event_type, digest FROM app_event_inbox WHERE delivery_id=?").get(deliveryId) as { delivery_id: string; deadline_at: string; source_key: string; event_type: string; digest: string } | undefined;
    return row ? { deliveryId: row.delivery_id, deadlineAt: row.deadline_at, sourceKey: row.source_key, eventType: row.event_type, digest: row.digest } : null;
  }

  // ── batches (30 seconds, 20 events, 32 KiB) ──

  /** Add a ready delivery to its trigger's open batch, opening one when there is none and sealing the open one first
   * when this member would pass the event or byte bound. Returns the batch it joined. */
  addToBatch(triggerId: string, deliveryId: string, bytes: number, now: number, bounds: { windowMs: number; maxEvents: number; maxBytes: number }, newId: () => string): string {
    return inTx(this.db, () => {
      let open = this.db.prepare(PER_EVENT_SQL.openBatch).get(triggerId) as { batch_id: string; member_count: number; member_bytes: number } | undefined;
      if (open && (open.member_count >= bounds.maxEvents || (open.member_count > 0 && open.member_bytes + bytes > bounds.maxBytes))) {
        this.db.prepare("UPDATE app_event_batches SET state='sealed' WHERE batch_id=? AND state='open'").run(open.batch_id);
        open = undefined;
      }
      const batchId = open?.batch_id ?? newId();
      if (!open) this.db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES (?,?,'open',?,?)").run(batchId, triggerId, now, now + bounds.windowMs);
      const position = open?.member_count ?? 0;
      this.db.prepare("INSERT INTO app_event_run_events (batch_id, delivery_id, position) VALUES (?,?,?)").run(batchId, deliveryId, position);
      this.db.prepare("UPDATE app_event_batches SET member_count=member_count+1, member_bytes=member_bytes+? WHERE batch_id=?").run(bytes, batchId);
      this.db.prepare("UPDATE app_event_inbox SET disposition='batched' WHERE delivery_id=? AND disposition='ready'").run(deliveryId);
      if (position + 1 >= bounds.maxEvents) this.db.prepare("UPDATE app_event_batches SET state='sealed' WHERE batch_id=? AND state='open'").run(batchId);
      return batchId;
    });
  }

  /** Open batches whose window has passed, sealed now. */
  sealDue(now: number, limit: number): void {
    inTx(this.db, () => {
      for (const row of this.db.prepare(PER_EVENT_SQL.dueBatches).all(now, limit) as Array<{ batch_id: string }>) {
        this.db.prepare("UPDATE app_event_batches SET state='sealed' WHERE batch_id=? AND state='open'").run(row.batch_id);
      }
    });
  }

  /** Sealed batches with no run yet, bounded. */
  sealedWithoutRun(limit: number): Array<{ batchId: string; triggerId: string }> {
    return (this.db.prepare(PER_EVENT_SQL.sealedWithoutRun).all(limit) as Array<{ batch_id: string; trigger_id: string }>)
      .map(row => ({ batchId: row.batch_id, triggerId: row.trigger_id }));
  }

  batchMembers(batchId: string): string[] {
    return (this.db.prepare("SELECT delivery_id FROM app_event_run_events WHERE batch_id=? ORDER BY position").all(batchId) as Array<{ delivery_id: string }>).map(row => row.delivery_id);
  }

  /** Create the run and bind it to its sealed batch in one transaction (section 6.2: run id and membership together).
   * A batch that already has a run returns that run: a lost reply never allocates a replacement run id (6.3). */
  createRunForBatch(input: Parameters<AppEventRunStore["create"]>[0]): AppEventRun {
    return inTx(this.db, () => {
      const batch = this.db.prepare("SELECT state, run_id FROM app_event_batches WHERE batch_id=?").get(input.batchId) as { state: string; run_id: string | null } | undefined;
      if (!batch || batch.state !== "sealed") throw new Error("only a sealed batch gets a run");
      if (batch.run_id) return this.findById(batch.run_id)!;
      const run = this.create(input);
      this.db.prepare("UPDATE app_event_batches SET run_id=? WHERE batch_id=? AND run_id IS NULL").run(run.runId, input.batchId);
      return run;
    });
  }

  // ── AppEventRunStore ──

  create(input: Parameters<AppEventRunStore["create"]>[0]): AppEventRun {
    this.db.prepare(`INSERT INTO app_event_runs (run_id, batch_id, trigger_id, routine_id, bot_id, owner_account_id, subscription_id, policy_digest, billing_ref, state, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.runId, input.batchId, input.triggerId, input.routineId, input.botId, input.ownerAccountId, input.subscriptionId, input.policyDigest, input.billingRef, input.state ?? "sealed", input.now, input.now);
    return this.findById(input.runId)!;
  }

  update(runId: string, patch: RunPatch, now: number, expectedState?: AppRunState): AppEventRun | null {
    const sets: string[] = [], values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch) as Array<[keyof RunPatch, unknown]>) {
      const column = RUN_COLUMNS[key];
      if (!column) throw new Error(`not a run field: ${String(key)}`);
      sets.push(`${column}=?`);
      values.push(JSON_COLUMNS.has(key) ? json(value) : typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
    }
    sets.push("updated_at=?"); values.push(now);
    const where = expectedState === undefined ? "run_id=?" : "run_id=? AND state=?";
    const args = expectedState === undefined ? [runId] : [runId, expectedState];
    const changed = Number(this.db.prepare(`UPDATE app_event_runs SET ${sets.join(", ")} WHERE ${where}`).run(...values, ...args).changes);
    return changed === 1 ? this.findById(runId) : null;
  }

  findById(runId: string): AppEventRun | null {
    const row = this.db.prepare(PER_EVENT_SQL.runById).get(runId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  findActive(triggerId: string): AppEventRun[] {
    return (this.db.prepare(PER_EVENT_SQL.runsActive).all(triggerId) as unknown as RunRow[]).map(toRun);
  }

  /** The app run that owns this thread (and generation, when given). Host lineage only: never a caller's label. */
  findByThread(threadId: string, _generation?: string): AppEventRun | null {
    // any app run of the thread, whatever the turn's generation: the hard zero keys on the thread (GrokBuild r1 H1)
    const row = this.db.prepare(PER_EVENT_SQL.runByThread).get(threadId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** Keyset history, newest first: the page after `before`, never an offset over all runs. */
  history(routineId: string, options: { before?: { createdAt: number; runId: string }; limit?: number } = {}): AppEventRun[] {
    const limit = Math.max(1, Math.min(50, options.limit ?? 20));
    const rows = options.before
      ? this.db.prepare(PER_EVENT_SQL.historyAfter).all(routineId, options.before.createdAt, options.before.runId, limit)
      : this.db.prepare(PER_EVENT_SQL.historyFirst).all(routineId, limit);
    return (rows as unknown as RunRow[]).map(toRun);
  }

  /** Runs whose next step is due (renew, retry after a wait), bounded. */
  dueRuns(now: number, limit: number): AppEventRun[] {
    return (this.db.prepare(PER_EVENT_SQL.dueRuns).all(now, limit) as unknown as RunRow[]).map(toRun);
  }

  isTerminal(run: AppEventRun): boolean { return APP_RUN_TERMINAL.has(run.state); }

  // ── the child-refusal receipt and its one card (section 7.1) ──

  /** Persist the refusal receipt. The first refusal of a run writes it; later ones only count. Returns whether this was
   * the first (the one that owes the explanation card). Synchronous and before the refusal is returned. */
  recordChildRefusal(runId: string, kind: AppChildRefusalReceipt["kind"], now: number): { first: boolean } {
    return inTx(this.db, () => {
      const row = this.db.prepare("SELECT child_refusal FROM app_event_runs WHERE run_id=?").get(runId) as { child_refusal: string | null } | undefined;
      if (!row) throw new Error("no such app run");
      if (row.child_refusal) {
        const receipt = JSON.parse(row.child_refusal) as AppChildRefusalReceipt;
        const next: AppChildRefusalReceipt = { ...receipt, attempts: Math.min(1_000_000, receipt.attempts + 1) };
        this.db.prepare("UPDATE app_event_runs SET child_refusal=? WHERE run_id=?").run(JSON.stringify(next), runId);
        return { first: false };
      }
      const receipt: AppChildRefusalReceipt = { code: "app_child_not_allowed", kind, at: now, attempts: 1 };
      this.db.prepare("UPDATE app_event_runs SET child_refusal=? WHERE run_id=?").run(JSON.stringify(receipt), runId);
      return { first: true };
    });
  }

  /** Store the card built from the receipt and mark it written, once. False when it was already written. */
  markCardWritten(runId: string, card: AppChildCard): boolean {
    return Number(this.db.prepare("UPDATE app_event_runs SET child_card=?, child_card_written=1 WHERE run_id=? AND child_refusal IS NOT NULL AND child_card_written=0").run(JSON.stringify(card), runId).changes) === 1;
  }

  /** Runs with a refusal receipt whose card is not written yet (a restart between the two), bounded. */
  cardsOwed(limit: number): AppEventRun[] {
    return (this.db.prepare(PER_EVENT_SQL.cardsOwed).all(limit) as unknown as RunRow[]).map(toRun);
  }
}

/** What the delivery loop decided about one claimed item before custody. `binding` is null for a foreign subscription. */
export type CustodyEntry =
  | { item: AppClaimItem; binding: AppTriggerBinding; disposition: "accept" }
  | { item: AppClaimItem; binding: AppTriggerBinding | null; disposition: "filtered" | "stale" | "rejected" };

const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * The restore fence for this store (server/restore-fence.ts): after a restore nothing here runs until the owner reviews
 * again (rule 6). Every live binding needs review; unstarted runs are cancelled (nothing was submitted); a run that may
 * have started keeps an uncertain outcome and is never resubmitted; open batches close; ready deliveries are stale.
 */
export function fenceRestoredAppTriggers(db: DatabaseSync): { bindings: number; runs: number; deliveries: number } {
  if (!hasTable(db, "app_trigger_bindings")) return { bindings: 0, runs: 0, deliveries: 0 };
  const bindings = Number(db.prepare("UPDATE app_trigger_bindings SET sync_state='needs_review' WHERE sync_state NOT IN ('deleted','deleting','needs_review')").run().changes);
  const cancelled = Number(db.prepare("UPDATE app_event_runs SET state='cancelled', wait_reason='restored' WHERE state IN ('sealed','budget_wait','reserved')").run().changes);
  const uncertain = Number(db.prepare("UPDATE app_event_runs SET state='outcome_unknown', wait_reason='restored' WHERE state IN ('starting','running')").run().changes);
  db.prepare("UPDATE app_event_batches SET state='closed' WHERE state='open'").run();
  const deliveries = Number(db.prepare("UPDATE app_event_inbox SET disposition='stale', projection=NULL WHERE disposition='ready'").run().changes);
  return { bindings, runs: cancelled + uncertain, deliveries };
}
