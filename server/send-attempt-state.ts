import type { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { txScopeBegin, txScopeEnd } from "./tx-scope.ts";
import { beginWrite, endWrite, undoWrite, beginRead } from "./write-tx.ts";
import type { AttemptDelivery, AttemptPhase, ReplayPolicy, TerminalOutcome } from "../shared/help-turn-state.ts";
export type { AttemptDelivery, AttemptPhase, ReplayPolicy, TerminalOutcome } from "../shared/help-turn-state.ts";

/** F7 schema (DESIGN-r2 §3.1). No acceptance, migration or recovery runs in I0. */
export const SEND_ATTEMPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS send_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  send_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  isolated INTEGER NOT NULL CHECK(isolated IN (0,1)),
  queue_only INTEGER NOT NULL CHECK(queue_only IN (0,1)),
  phase TEXT NOT NULL CHECK(phase IN ('queued','starting','running','stopping','held','terminal')),
  delivery TEXT NOT NULL CHECK(delivery IN ('not_submitted','uncertain','submitted')),
  replay_policy TEXT NOT NULL CHECK(replay_policy IN ('exclude','allow')),
  revision INTEGER NOT NULL, binding_epoch INTEGER NOT NULL,
  stop_gen TEXT, restore_gen TEXT, message_id TEXT, queue_id TEXT,
  terminal_outcome TEXT CHECK(terminal_outcome IN ('completed','failed','refused','removed','stopped','abandoned_uncertain')),
  terminal_reason TEXT, terminal_at INTEGER, cleanup_owed INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(thread_id,send_id),
  CHECK(isolated = 0 OR queue_only = 1),
  CHECK((phase = 'terminal') = (terminal_outcome IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS send_attempts_message ON send_attempts(thread_id,message_id) WHERE message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS send_attempt_bindings (
  attempt_id TEXT NOT NULL, binding_epoch INTEGER NOT NULL, generation TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL, provider_turn_id TEXT, session_id TEXT,
  released_writes INTEGER NOT NULL,
  invocation_released INTEGER NOT NULL CHECK(invocation_released IN (0,1)),
  sealed INTEGER NOT NULL CHECK(sealed IN (0,1)), active INTEGER NOT NULL CHECK(active IN (0,1)),
  thread_id TEXT NOT NULL, PRIMARY KEY(attempt_id,binding_epoch), UNIQUE(attempt_id,generation)
);
CREATE INDEX IF NOT EXISTS send_attempt_bindings_provider ON send_attempt_bindings(provider_instance_id,thread_id,provider_turn_id,generation);
CREATE INDEX IF NOT EXISTS send_attempt_bindings_generation ON send_attempt_bindings(thread_id,generation,attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS send_attempt_bindings_active ON send_attempt_bindings(attempt_id) WHERE active=1;
CREATE TABLE IF NOT EXISTS send_actions (
  owner_id TEXT NOT NULL, action_id TEXT NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('resend','remove','stop')),
  target_attempt_id TEXT NOT NULL, target_revision INTEGER NOT NULL, target_binding_epoch INTEGER NOT NULL,
  target_provider_turn_id TEXT, fingerprint TEXT NOT NULL, stop_gen TEXT, restore_gen TEXT,
  replacement_attempt_id TEXT, replacement_send_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','done')), result_code TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,action_id),
  CHECK(kind <> 'resend' OR (replacement_attempt_id IS NOT NULL AND replacement_send_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS send_actions_replacement_attempt ON send_actions(replacement_attempt_id) WHERE replacement_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS send_actions_replacement_send ON send_actions(replacement_send_id) WHERE replacement_send_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS send_replay_exclusions (
  thread_id TEXT NOT NULL, message_id TEXT NOT NULL, attempt_id TEXT,
  reason TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(thread_id,message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS send_replay_exclusions_attempt ON send_replay_exclusions(attempt_id);
CREATE TABLE IF NOT EXISTS send_replay_epochs (thread_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL);
-- Epoch index producer: new3-g5/new3-g5-rd; filtered existence consumer: c3-memory-side.
CREATE INDEX IF NOT EXISTS send_replay_epochs_revision ON send_replay_epochs(revision);
CREATE TABLE IF NOT EXISTS send_replay_sessions (
  thread_id TEXT NOT NULL, driver_instance TEXT NOT NULL, native_session TEXT NOT NULL,
  generation TEXT NOT NULL, provider_turn_id TEXT NOT NULL, proof TEXT NOT NULL CHECK(json_valid(proof)),
  PRIMARY KEY(thread_id,driver_instance,native_session)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS send_replay_session_nodes (
  thread_id TEXT NOT NULL, driver_instance TEXT NOT NULL, native_session TEXT NOT NULL,
  kind TEXT NOT NULL, node_key TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)),
  PRIMARY KEY(thread_id,driver_instance,native_session,kind,node_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS turn_cleanup_owed (
  thread_id TEXT NOT NULL, generation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('tools','replies','images','approvals','release','publication')),
  attempt_id TEXT, provider_turn_id TEXT, terminal_revision INTEGER, status TEXT NOT NULL,
  PRIMARY KEY(thread_id,generation,kind)
);
CREATE INDEX IF NOT EXISTS turn_cleanup_owner_stop ON turn_cleanup_owed(thread_id,generation)
  WHERE kind='publication' AND status='owner_stop';
CREATE TABLE IF NOT EXISTS send_retirement_keys (
  key_id TEXT PRIMARY KEY NOT NULL, digest_version INTEGER NOT NULL,
  installation_scope TEXT NOT NULL, key_bytes TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS send_retirement_keys_active ON send_retirement_keys(active) WHERE active=1;
CREATE TABLE IF NOT EXISTS retired_send_ids (
  key_id TEXT NOT NULL, digest_version INTEGER NOT NULL, digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('attempt','send','action','queue')), retired_at INTEGER NOT NULL,
  PRIMARY KEY(key_id,digest_version,digest)
);`;

/** PROVISIONAL INTERFACE: initializeSendAttempts names the unnamed §3.1
 * initializer. §3.1 does not specify key_bytes encoding or cleanup status
 * values. key_bytes is hex-encoded key material in TEXT; cleanup status is
 * owned/pending/done/superseded, plus owner_stop for a confirmed Stop line. Initializing the schema mints no key or receipt. */
export function initializeSendAttempts(db: DatabaseSync): void {
  beginWrite(db, "send_attempt_schema");
  try {
    db.exec(SEND_ATTEMPT_SCHEMA_SQL);
    endWrite(db, "send_attempt_schema");
  } catch (error) {
    undoWrite(db, "send_attempt_schema");
    throw error;
  }
}

export interface AttemptKey { ownerId: string; botId: string; threadId: string; sendId: string; attemptId: string }
/** PROVISIONAL INTERFACE: I0 omits captured Stop/restore fences; undefined means null. */
export interface BindingKey extends AttemptKey { bindingEpoch: number; generation: string; providerInstanceId: string; providerTurnId?: string; stopGen?: string | null; restoreGen?: string | null }
export type ReceiptRevision = number;
// Receipt epoch producer and retained-session proof consumer owner: new3-g5b.
export type ReplayEligibilityChange = { threadId: string; messageId: string; attemptId: string; delivery: AttemptDelivery };
let replayEligibilityObserver: ((db: DatabaseSync, change: ReplayEligibilityChange, write: () => void) => void) | undefined;
export function setReplayEligibilityObserver(observer: typeof replayEligibilityObserver): void { replayEligibilityObserver = observer; }

export type AuthorizedAttemptScope = Pick<AttemptKey, "ownerId" | "botId" | "threadId">;
export interface AttemptSnapshot extends AttemptKey {
  fingerprint: string;
  isolated: boolean;
  queueOnly: boolean;
  phase: AttemptPhase;
  delivery: AttemptDelivery;
  replayPolicy: ReplayPolicy;
  revision: ReceiptRevision;
  bindingEpoch: number;
  stopGen: string | null;
  restoreGen: string | null;
  messageId: string | null;
  queueId: string | null;
  terminalOutcome: TerminalOutcome | null;
  terminalReason: string | null;
  terminalAt: number | null;
  cleanupOwed: number;
  createdAt: number;
  updatedAt: number;
}
export interface Missing { kind: "missing" }
export interface Retired { kind: "retired" }
export type CleanupKind = "tools" | "replies" | "images" | "approvals" | "release" | "publication";
export interface CleanupEffect {
  threadId: string;
  generation: string;
  kind: CleanupKind;
  attemptId: string | null;
  providerTurnId: string | null;
  terminalRevision: number | null;
  status: string;
}
/** PROVISIONAL INTERFACE: the design names deliveryEvidence/effectsOwed without
 * their TS shapes. Evidence is bound to the captured binding; A1 owns validation. */
export interface DeliveryEvidence { binding: BindingKey; delivery: AttemptDelivery }
export interface SettlementResult { kind: "committed" | "already" | "stale"; receipt: AttemptSnapshot; effectsOwed: CleanupEffect[] }


/** PROVISIONAL INTERFACE: the frozen functions omit their connection owner.
 * I installs the same messages-db provider used by SendStore before serving. */
let connection: (() => DatabaseSync) | undefined;
export function useSendAttemptDatabase(getDb: () => DatabaseSync): void { connection = getDb; }
function currentStore(): SendAttemptStore {
  if (!connection) throw new Error("send attempt database is not configured");
  return new SendAttemptStore(connection());
}
export function readAttempt(scope: AuthorizedAttemptScope, sendId: string): AttemptSnapshot | Missing | Retired { return currentStore().readAttempt(scope, sendId); }
export function recordInvocation(key: BindingKey, revision: number, fencedWrites: boolean): number { return currentStore().recordInvocation(key, revision, fencedWrites); }
export function releaseWrite(key: BindingKey, revision: number, ordinal: number): number { return currentStore().releaseWrite(key, revision, ordinal); }
export function settleAttempt(key: BindingKey, revision: number, outcome: TerminalOutcome, evidence: DeliveryEvidence): SettlementResult { return currentStore().settleAttempt(key, revision, outcome, evidence); }

export function attemptError(code: string): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status: code === "retired_send_id" ? 410 : 409 });
}
function snapshot(row: Record<string, unknown>): AttemptSnapshot {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) out[name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  out.isolated = Boolean(out.isolated); out.queueOnly = Boolean(out.queueOnly);
  return out as unknown as AttemptSnapshot;
}
const effects: CleanupKind[] = ["tools", "replies", "images", "approvals", "publication", "release"];
const deliveryRank = { not_submitted: 0, uncertain: 1, submitted: 2 };
function stronger(a: AttemptDelivery, b: AttemptDelivery): AttemptDelivery { return deliveryRank[a] >= deliveryRank[b] ? a : b; }

/** PROVISIONAL INTERFACE: narrow explicit-db facade for F1 operations and test
 * fixtures. Registration is I's job; constructing this never migrates a DB. */
export class SendAttemptStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  transaction<T>(work: () => T): T {
    const point = `attempt_${randomUUID().replaceAll("-", "")}`;
    beginWrite(this.db, point); txScopeBegin();
    try { const result = work(); endWrite(this.db, point); txScopeEnd(true); return result; }
    catch (error) { try { undoWrite(this.db, point); } finally { txScopeEnd(false); } throw error; }
  }
  byId(attemptId: string): AttemptSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM send_attempts WHERE attempt_id=?").get(attemptId);
    return row ? snapshot(row) : undefined;
  }
  readAttempt(scope: AuthorizedAttemptScope, sendId: string): AttemptSnapshot | Missing | Retired {
    // The authorized scope is supplied only after route proof and subject checks.
    if (this.isRetired(scope, "send", sendId)) return { kind: "retired" };
    const row = this.db.prepare("SELECT * FROM send_attempts WHERE thread_id=? AND send_id=? AND owner_id=? AND bot_id=?")
      .get(scope.threadId, sendId, scope.ownerId, scope.botId);
    return row ? snapshot(row) : { kind: "missing" };
  }
  create(input: AuthorizedAttemptScope & { sendId?: string; fingerprint: string; isolated?: boolean; queueOnly?: boolean; queueId?: string; stopGen?: string; restoreGen?: string }): AttemptSnapshot {
    return this.transaction(() => {
      const sendId = input.sendId ?? `srv-${randomUUID()}`;
      const prior = this.readAttempt(input, sendId);
      if (!("kind" in prior)) {
        if (prior.fingerprint !== input.fingerprint) throw attemptError("send_id_conflict");
        return prior;
      }
      if (prior.kind === "retired") throw attemptError("retired_send_id");
      const id = randomUUID(), now = Date.now();
      this.db.prepare(`INSERT INTO send_attempts (attempt_id,owner_id,bot_id,thread_id,send_id,fingerprint,isolated,queue_only,phase,delivery,replay_policy,revision,binding_epoch,queue_id,stop_gen,restore_gen,cleanup_owed,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'queued','not_submitted','exclude',1,0,?,?,?,0,?,?)`).run(id, input.ownerId, input.botId, input.threadId, sendId, input.fingerprint, input.isolated ? 1 : 0, input.isolated || input.queueOnly ? 1 : 0, input.queueId ?? null, input.stopGen ?? null, input.restoreGen ?? null, now, now);
      return this.byId(id)!;
    });
  }
  /** append must write on this connection; rollback includes the line and exclusion. */
  link(attemptId: string, messageId: string, append: () => void = () => {}): AttemptSnapshot {
    return this.transaction(() => {
      const receipt = this.byId(attemptId);
      if (!receipt) throw attemptError("missing_attempt");
      if (receipt.messageId) {
        if (receipt.messageId !== messageId) throw attemptError("line_already_linked");
        return receipt;
      }
      append();
      this.db.prepare("UPDATE send_attempts SET message_id=?,revision=revision+1,updated_at=? WHERE attempt_id=?").run(messageId, Date.now(), attemptId);
      this.setEligibility(this.byId(attemptId)!);
      return this.byId(attemptId)!;
    });
  }
  private setEligibility(receipt: AttemptSnapshot): void {
    if (!receipt.messageId) return;
    const write = () => {
    const prior = this.db.prepare("SELECT reason FROM send_replay_exclusions WHERE thread_id=? AND message_id=?").get(receipt.threadId, receipt.messageId);
    if (receipt.delivery === "submitted") {
      if (!prior) return;
      this.db.prepare("DELETE FROM send_replay_exclusions WHERE thread_id=? AND message_id=?").run(receipt.threadId, receipt.messageId);
    } else {
      if (prior?.reason === receipt.delivery) return;
      this.db.prepare("INSERT INTO send_replay_exclusions VALUES (?,?,?,?,?) ON CONFLICT(thread_id,message_id) DO UPDATE SET reason=excluded.reason,revision=excluded.revision")
        .run(receipt.threadId, receipt.messageId, receipt.attemptId, receipt.delivery, receipt.revision);
    }
    this.db.prepare("INSERT INTO send_replay_epochs VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(receipt.threadId);
    };
    if (replayEligibilityObserver) replayEligibilityObserver(this.db, { threadId: receipt.threadId, messageId: receipt.messageId, attemptId: receipt.attemptId, delivery: receipt.delivery }, write);
    else write();
  }
  bind(attemptIds: string[], binding: { generation: string; providerInstanceId: string; providerTurnId?: string }): BindingKey[] {
    return this.transaction(() => {
      if (!attemptIds.length || new Set(attemptIds).size !== attemptIds.length) throw attemptError("invalid_batch");
      const rows = attemptIds.map(id => this.byId(id));
      if (rows.some(row => !row || row.phase === "terminal" || row.phase === "stopping" || row.delivery !== "not_submitted")) throw attemptError("stale_action");
      const receipts = rows as AttemptSnapshot[];
      if (receipts.some(row => row.threadId !== receipts[0]!.threadId || row.ownerId !== receipts[0]!.ownerId || row.botId !== receipts[0]!.botId) || (receipts.length > 1 && receipts.some(row => row.isolated))) throw attemptError("invalid_batch");
      const keys: BindingKey[] = [];
      for (const receipt of receipts) {
        const previous = this.db.prepare("SELECT * FROM send_attempt_bindings WHERE attempt_id=? AND active=1").get(receipt.attemptId);
        if (previous && (!previous.sealed || previous.invocation_released || previous.released_writes)) throw attemptError("stop_required");
        if (previous) this.db.prepare("UPDATE turn_cleanup_owed SET status='superseded' WHERE thread_id=? AND generation=? AND status='owned'").run(receipt.threadId, previous.generation);
        this.db.prepare("UPDATE send_attempt_bindings SET active=0,sealed=1 WHERE attempt_id=?").run(receipt.attemptId);
        const epoch = receipt.bindingEpoch + 1;
        this.db.prepare("INSERT INTO send_attempt_bindings VALUES (?,?,?,?,?,NULL,0,0,0,1,?)")
          .run(receipt.attemptId, epoch, binding.generation, binding.providerInstanceId, binding.providerTurnId ?? null, receipt.threadId);
        this.db.prepare("UPDATE send_attempts SET phase='starting',binding_epoch=?,revision=revision+1,cleanup_owed=1,updated_at=? WHERE attempt_id=?").run(epoch, Date.now(), receipt.attemptId);
        for (const kind of effects) this.db.prepare("INSERT OR IGNORE INTO turn_cleanup_owed VALUES (?,?,?,?,?,NULL,'owned')").run(receipt.threadId, binding.generation, kind, receipt.attemptId, binding.providerTurnId ?? null);
        keys.push({ ...receipt, ...binding, bindingEpoch: epoch });
      }
      return keys;
    });
  }
  private matches(receipt: AttemptSnapshot, key: BindingKey, revision?: number, active = true): boolean {
    if (receipt.ownerId !== key.ownerId || receipt.botId !== key.botId || receipt.threadId !== key.threadId || receipt.sendId !== key.sendId || receipt.bindingEpoch !== key.bindingEpoch || (revision !== undefined && receipt.revision !== revision)) return false;
    if (receipt.stopGen !== (key.stopGen ?? null) || receipt.restoreGen !== (key.restoreGen ?? null)) return false;
    const binding = this.db.prepare("SELECT * FROM send_attempt_bindings WHERE attempt_id=? AND binding_epoch=?").get(key.attemptId, key.bindingEpoch);
    return Boolean(binding && (!active || binding.active) && binding.generation === key.generation && binding.provider_instance_id === key.providerInstanceId && (key.providerTurnId === undefined || binding.provider_turn_id === key.providerTurnId));
  }
  private writable(key: BindingKey, revision: number): AttemptSnapshot {
    const receipt = this.byId(key.attemptId);
    if (!receipt || receipt.phase === "terminal" || receipt.phase === "stopping" || !this.matches(receipt, key, revision)) throw attemptError("stale_action");
    const row = this.db.prepare("SELECT sealed FROM send_attempt_bindings WHERE attempt_id=? AND binding_epoch=?").get(key.attemptId, key.bindingEpoch)!;
    if (row.sealed) throw attemptError("stop_required");
    return receipt;
  }
  recordInvocation(key: BindingKey, revision: number, fencedWrites: boolean): number {
    return this.transaction(() => {
      const receipt = this.writable(key, revision);
      this.db.prepare("UPDATE send_attempt_bindings SET invocation_released=MAX(invocation_released,?) WHERE attempt_id=? AND binding_epoch=?").run(fencedWrites ? 0 : 1, key.attemptId, key.bindingEpoch);
      return this.evidence(receipt, fencedWrites ? "not_submitted" : "uncertain");
    });
  }
  releaseWrite(key: BindingKey, revision: number, ordinal: number): number {
    return this.transaction(() => {
      const receipt = this.writable(key, revision);
      const row = this.db.prepare("SELECT released_writes FROM send_attempt_bindings WHERE attempt_id=? AND binding_epoch=?").get(key.attemptId, key.bindingEpoch)!;
      if (!Number.isSafeInteger(ordinal) || ordinal !== Number(row.released_writes) + 1) throw attemptError("write_ordinal_conflict");
      this.db.prepare("UPDATE send_attempt_bindings SET released_writes=? WHERE attempt_id=? AND binding_epoch=?").run(ordinal, key.attemptId, key.bindingEpoch);
      return this.evidence(receipt, "uncertain");
    });
  }
  private evidence(receipt: AttemptSnapshot, delivery: AttemptDelivery): number {
    const next = stronger(receipt.delivery, delivery);
    this.db.prepare("UPDATE send_attempts SET delivery=?,replay_policy=?,revision=revision+1,updated_at=? WHERE attempt_id=?")
      .run(next, next === "submitted" ? "allow" : "exclude", Date.now(), receipt.attemptId);
    const updated = this.byId(receipt.attemptId)!; this.setEligibility(updated); return updated.revision;
  }
  allocateProvider(key: BindingKey, revision: number, providerTurnId: string): BindingKey {
    return this.transaction(() => {
      this.writable(key, revision);
      const row = this.db.prepare("SELECT provider_turn_id FROM send_attempt_bindings WHERE attempt_id=? AND binding_epoch=?").get(key.attemptId, key.bindingEpoch)!;
      if (row.provider_turn_id && row.provider_turn_id !== providerTurnId) throw attemptError("stale_action");
      this.db.prepare("UPDATE send_attempt_bindings SET provider_turn_id=? WHERE attempt_id=? AND binding_epoch=?").run(providerTurnId, key.attemptId, key.bindingEpoch);
      return { ...key, providerTurnId };
    });
  }
  acknowledge(key: BindingKey, revision: number): number {
    return this.transaction(() => {
      const receipt = this.byId(key.attemptId);
      if (!receipt || !key.providerTurnId || !this.matches(receipt, key, revision, receipt.phase !== "terminal")) throw attemptError("stale_action");
      const next = this.evidence(receipt, "submitted");
      if (receipt.phase !== "terminal" && receipt.phase !== "stopping") this.db.prepare("UPDATE send_attempts SET phase='running' WHERE attempt_id=?").run(key.attemptId);
      return next;
    });
  }
  seal(key: BindingKey, revision: number, stopGen?: string): BindingKey {
    return this.transaction(() => {
      const receipt = this.byId(key.attemptId);
      if (!receipt || !this.matches(receipt, key, revision) || receipt.phase === "terminal") throw attemptError("stale_action");
      this.db.prepare("UPDATE send_attempt_bindings SET sealed=1 WHERE attempt_id=? AND binding_epoch=?").run(key.attemptId, key.bindingEpoch);
      this.db.prepare("UPDATE send_attempts SET phase=?,stop_gen=COALESCE(?,stop_gen),revision=revision+1 WHERE attempt_id=?").run(stopGen ? "stopping" : "held", stopGen ?? null, key.attemptId);
      return { ...key, stopGen: stopGen ?? receipt.stopGen };
    });
  }
  /** The submission fence proved every released write of this binding unwritten (nothing reached the engine): the durable evidence the
   * release recorded is withdrawn and the binding sealed, so the rebuild takes a fresh binding. Never for an unfenced invocation, an
   * acknowledged delivery or a terminal attempt: those keep what they recorded. */
  withdrawUnwritten(key: BindingKey): boolean {
    return this.transaction(() => {
      const receipt = this.byId(key.attemptId);
      if (!receipt || receipt.phase === "terminal" || receipt.phase === "stopping" || receipt.delivery === "submitted" || !this.matches(receipt, key)) return false;
      const binding = this.db.prepare("SELECT invocation_released FROM send_attempt_bindings WHERE attempt_id=? AND binding_epoch=?").get(key.attemptId, key.bindingEpoch)!;
      if (binding.invocation_released) return false;
      this.db.prepare("UPDATE send_attempt_bindings SET sealed=1,released_writes=0 WHERE attempt_id=? AND binding_epoch=?").run(key.attemptId, key.bindingEpoch);
      this.db.prepare("UPDATE send_attempts SET phase='held',delivery='not_submitted',replay_policy='exclude',revision=revision+1,updated_at=? WHERE attempt_id=?").run(Date.now(), key.attemptId);
      this.setEligibility(this.byId(key.attemptId)!);
      return true;
    });
  }
  settleAttempt(key: BindingKey, revision: number, outcome: TerminalOutcome, evidence: DeliveryEvidence): SettlementResult {
    return this.transaction(() => {
      const receipt = this.byId(key.attemptId);
      if (!receipt) throw attemptError("missing_attempt");
      const result = (kind: SettlementResult["kind"]): SettlementResult => ({ kind, receipt: this.byId(key.attemptId)!, effectsOwed: this.owed(key.threadId, key.generation) });
      if (!this.matches(receipt, key, undefined, false) || !this.matches(receipt, evidence.binding, undefined, false)) return result("stale");
      if (receipt.phase === "terminal") return result("already");
      if (!this.matches(receipt, key, revision)) return result("stale");
      if (evidence.delivery === "submitted" && receipt.delivery !== "submitted" && !evidence.binding.providerTurnId) throw attemptError("unproven_delivery");
      const delivery = stronger(receipt.delivery, evidence.delivery);
      // A completion with no positive delivery proof remains unknown.
      const terminal = outcome === "completed" && delivery !== "submitted" ? "abandoned_uncertain" : outcome;
      const now = Date.now();
      this.db.prepare("UPDATE send_attempts SET phase='terminal',delivery=?,replay_policy=?,terminal_outcome=?,terminal_at=?,revision=revision+1,cleanup_owed=1,updated_at=? WHERE attempt_id=?")
        .run(delivery, delivery === "submitted" ? "allow" : "exclude", terminal, now, now, key.attemptId);
      this.db.prepare("UPDATE send_attempt_bindings SET sealed=1,active=0 WHERE attempt_id=? AND binding_epoch=?").run(key.attemptId, key.bindingEpoch);
      const updated = this.byId(key.attemptId)!; this.setEligibility(updated);
      for (const kind of effects) this.db.prepare(`INSERT INTO turn_cleanup_owed VALUES (?,?,?,?,?,?,'pending')
        ON CONFLICT(thread_id,generation,kind) DO UPDATE SET status='pending',terminal_revision=excluded.terminal_revision`)
        .run(key.threadId, key.generation, kind, key.attemptId, key.providerTurnId ?? null, updated.revision);
      if (updated.queueId && this.hasTable("owner_sends")) {
        const status = terminal === "removed" ? "cancelled" : terminal === "refused" ? "refused" : terminal === "completed" ? "delivered" : "failed";
        this.db.prepare("UPDATE owner_sends SET status=?,updated_at=? WHERE queue_id=?").run(status, now, updated.queueId);
      }
      return result("committed");
    });
  }
  settleBatch(batch: Array<{ key: BindingKey; revision: number }>, outcome: TerminalOutcome, delivery: AttemptDelivery): SettlementResult[] {
    return this.transaction(() => {
      const results = batch.map(({ key, revision }) => this.settleAttempt(key, revision, outcome, { binding: key, delivery }));
      if (results.some(result => result.kind === "stale")) throw attemptError("stale_action");
      return results;
    });
  }
  owed(threadId: string, generation: string): CleanupEffect[] {
    return this.db.prepare("SELECT * FROM turn_cleanup_owed WHERE thread_id=? AND generation=? AND status='pending'").all(threadId, generation).map(row => {
      const value: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(row)) value[name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = item;
      return value as unknown as CleanupEffect;
    });
  }
  oweOwnerStop(threadId: string, generation: string): void {
    this.db.prepare(`INSERT INTO turn_cleanup_owed (thread_id,generation,kind,status) VALUES (?,?,'publication','owner_stop')
      ON CONFLICT(thread_id,generation,kind) DO UPDATE SET status='owner_stop'`).run(threadId, generation);
  }
  ownerStopOwed(threadId: string, generation: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM turn_cleanup_owed WHERE thread_id=? AND generation=? AND kind='publication' AND status='owner_stop'")
      .get(threadId, generation));
  }
  owedOwnerStops(): Array<{ threadId: string; generation: string }> {
    return this.db.prepare("SELECT thread_id AS threadId, generation FROM turn_cleanup_owed WHERE kind='publication' AND status='owner_stop'")
      .all() as Array<{ threadId: string; generation: string }>;
  }
  finishOwnerStop(threadId: string, generation: string): void {
    this.db.prepare("DELETE FROM turn_cleanup_owed WHERE thread_id=? AND generation=? AND kind='publication' AND status='owner_stop'")
      .run(threadId, generation);
  }
  /** Receivers use (thread,generation,kind,terminalRevision) as their idempotency
   * key. Publication includes the attempt/revision explanation key. A false
   * result (e.g. F5 not_ready) leaves ownership owed. Release is always last. */
  flushEffects(threadId: string, generation: string, run: (effect: CleanupEffect) => boolean | void): boolean {
    for (const kind of effects) {
      const effect = this.owed(threadId, generation).find(item => item.kind === kind);
      if (!effect) continue;
      try {
        const done = this.transaction(() => {
          if (run(effect) === false) return false;
          this.db.prepare("UPDATE turn_cleanup_owed SET status='done' WHERE thread_id=? AND generation=? AND kind=? AND terminal_revision=?")
            .run(threadId, generation, kind, effect.terminalRevision);
          return true;
        });
        if (!done) return false;
      } catch { return false; }
    }
    this.db.prepare("UPDATE send_attempts SET cleanup_owed=0 WHERE attempt_id IN (SELECT attempt_id FROM send_attempt_bindings WHERE thread_id=? AND generation=?) AND phase='terminal'").run(threadId, generation);
    return true;
  }
  /** Snapshot-scoped bounded candidate lookup: no owner_sends/status scan. */
  replayEligibility(threadId: string, messageIds: readonly string[], copyRoots: ReadonlyMap<string, readonly { threadId: string; messageId: string }[]> = new Map()): { excludedIds: Set<string>; revision: number } {
    const point = `replay_${randomUUID().replaceAll("-", "")}`;
    beginRead(this.db, point);
    try {
      const excludedIds = new Set<string>();
      const lookup = this.db.prepare("SELECT 1 FROM send_replay_exclusions WHERE thread_id=? AND message_id=?");
      const epoch = this.db.prepare("SELECT revision FROM send_replay_epochs WHERE thread_id=?");
      // Root revisions contribute to the proof even when the copy text did not change.
      const revisions = new Map<string, number>([[threadId, Number(epoch.get(threadId)?.revision ?? 0)]]);
      for (const id of messageIds) {
        if (lookup.get(threadId, id)) excludedIds.add(id);
        for (const root of copyRoots.get(id) ?? []) {
          revisions.set(root.threadId, Number(epoch.get(root.threadId)?.revision ?? 0));
          if (lookup.get(root.threadId, root.messageId)) excludedIds.add(id);
        }
      }
      const revision = revisions.size === 1 ? revisions.get(threadId)! : Number.parseInt(createHash("sha256").update(JSON.stringify([...revisions].sort())).digest("hex").slice(0, 12), 16);
      endWrite(this.db, point); return { excludedIds, revision };
    } catch (error) { undoWrite(this.db, point); throw error; }
  }
  private hasTable(name: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  private keys(): Array<{ key_id: string; key_bytes: string; installation_scope: string; digest_version: number; active: number }> {
    return this.db.prepare("SELECT * FROM send_retirement_keys").all() as ReturnType<SendAttemptStore["keys"]>;
  }
  private digest(key: ReturnType<SendAttemptStore["keys"]>[number], scope: AuthorizedAttemptScope, kind: string, id: string): string {
    const tuple = [key.installation_scope, scope.ownerId, scope.botId, scope.threadId, kind, id];
    const hmac = createHmac("sha256", Buffer.from(key.key_bytes, "hex"));
    for (const part of tuple) { const bytes = Buffer.from(part); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); hmac.update(length).update(bytes); }
    return hmac.digest("hex");
  }
  isRetired(scope: AuthorizedAttemptScope, kind: "send" | "attempt" | "action" | "queue", id: string): boolean {
    return this.keys().some(key => Boolean(this.db.prepare("SELECT 1 FROM retired_send_ids WHERE key_id=? AND digest_version=? AND digest=?")
      .get(key.key_id, key.digest_version, this.digest(key, scope, kind, id))));
  }
  retireThread(scope: AuthorizedAttemptScope, revoke: () => void, deleteTranscript: () => void): void {
    revoke(); // synchronous dispatch/replay revocation precedes the owned transaction
    this.transaction(() => {
      let key = this.keys().find(row => row.active);
      if (!key) {
        this.db.prepare("INSERT INTO send_retirement_keys VALUES (?,1,?,?,1)").run(randomUUID(), randomUUID(), randomBytes(32).toString("hex"));
        key = this.keys().find(row => row.active)!;
      }
      const save = (kind: "send" | "attempt" | "action" | "queue", id: string) => this.db.prepare("INSERT OR IGNORE INTO retired_send_ids VALUES (?,?,?,?,?)").run(key!.key_id, key!.digest_version, this.digest(key!, scope, kind, id), kind, Date.now());
      const receipts = this.db.prepare("SELECT * FROM send_attempts WHERE owner_id=? AND bot_id=? AND thread_id=?").all(scope.ownerId, scope.botId, scope.threadId).map(snapshot);
      for (const receipt of receipts) {
        save("send", receipt.sendId); save("attempt", receipt.attemptId); if (receipt.queueId) save("queue", receipt.queueId);
        const actions = this.db.prepare("SELECT action_id FROM send_actions WHERE target_attempt_id=?").all(receipt.attemptId);
        for (const action of actions) save("action", String(action.action_id));
        this.db.prepare("DELETE FROM send_actions WHERE target_attempt_id=?").run(receipt.attemptId);
        this.db.prepare("DELETE FROM send_attempt_bindings WHERE attempt_id=?").run(receipt.attemptId);
        this.db.prepare("DELETE FROM send_replay_exclusions WHERE attempt_id=?").run(receipt.attemptId);
        this.db.prepare("DELETE FROM turn_cleanup_owed WHERE attempt_id=?").run(receipt.attemptId);
        this.db.prepare("DELETE FROM send_attempts WHERE attempt_id=?").run(receipt.attemptId);
      }
      deleteTranscript();
      this.db.prepare("INSERT INTO send_replay_epochs VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(scope.threadId);
    });
  }
}

/** PROVISIONAL INTERFACE: snapshot is the messages-db connection selected by
 * the replay owner. copyRoots carries only selected provenance identities. */
export function replayEligibility(threadId: string, messageIds: readonly string[], copyRoots: ReadonlyMap<string, readonly { threadId: string; messageId: string }[]>, snapshotDb: DatabaseSync) {
  return new SendAttemptStore(snapshotDb).replayEligibility(threadId, messageIds, copyRoots);
}

/** PROVISIONAL INTERFACE: F4 request without route authority. The caller has
 * already authorized scope and resolves payload only inside createReplacement. */
export interface AttemptResendRequest {
  contract: 1; actionId: string; threadId: string; sendId: string; attemptId: string;
  receiptRevision: number; bindingEpoch: number; kind: "resend";
  replacementSendId: string; stopGen?: string; restoreGen?: string; confirmDuplicate: boolean;
}
export function resendAttempt(store: SendAttemptStore, scope: AuthorizedAttemptScope, request: AttemptResendRequest,
  createReplacement: (old: AttemptSnapshot, replacementSendId: string) => AttemptSnapshot,
): { actionId: string; replacementSendId: string; replacementAttemptId: string; receipt: AttemptSnapshot; existing: boolean } {
  return store.transaction(() => {
    if (request.contract !== 1 || request.kind !== "resend" || request.threadId !== scope.threadId || !request.actionId || !request.replacementSendId || request.replacementSendId === request.sendId) throw attemptError("stale_action");
    if (store.isRetired(scope, "action", request.actionId) || store.isRetired(scope, "send", request.sendId)) throw attemptError("retired_send_id");
    const fingerprint = createHash("sha256").update(JSON.stringify([scope.ownerId, scope.botId, request.threadId, request.sendId, request.attemptId, request.receiptRevision, request.bindingEpoch, request.kind, request.replacementSendId, request.stopGen ?? null, request.restoreGen ?? null, request.confirmDuplicate])).digest("hex");
    const action = store.db.prepare("SELECT * FROM send_actions WHERE owner_id=? AND action_id=?").get(scope.ownerId, request.actionId);
    if (action) {
      if (action.fingerprint !== fingerprint || action.bot_id !== scope.botId || action.thread_id !== scope.threadId) throw attemptError("stale_action");
      if (action.status !== "done" || !action.replacement_attempt_id) throw attemptError("stale_action");
      const receipt = store.byId(String(action.replacement_attempt_id));
      if (!receipt) throw attemptError("retired_send_id");
      return { actionId: request.actionId, replacementSendId: receipt.sendId, replacementAttemptId: receipt.attemptId, receipt, existing: true };
    }
    const receipt = store.readAttempt(scope, request.sendId);
    if ("kind" in receipt) throw attemptError(receipt.kind === "retired" ? "retired_send_id" : "stale_action");
    if (receipt.terminalOutcome === "removed") throw attemptError("target_dismissed");
    if (receipt.queueId && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_sends'").get() && store.db.prepare("SELECT 1 FROM owner_sends WHERE queue_id=? AND status='cancelled'").get(receipt.queueId)) throw attemptError("target_dismissed");
    // Restore rotates the held projection's token, while a final receipt stays
    // immutable. Validate the current chip's fence without rewriting its receipt.
    const projection = receipt.queueId && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_sends'").get()
      ? store.db.prepare("SELECT restore_held,restore_gen FROM owner_sends WHERE thread_id=? AND send_id=? AND queue_id=? AND owner_id=?").get(receipt.threadId, receipt.sendId, receipt.queueId, receipt.botId)
      : undefined;
    const restoreGen = projection?.restore_held ? projection.restore_gen : receipt.restoreGen;
    if (receipt.attemptId !== request.attemptId || receipt.revision !== request.receiptRevision || receipt.bindingEpoch !== request.bindingEpoch || receipt.stopGen !== (request.stopGen ?? null) || restoreGen !== (request.restoreGen ?? null)) throw attemptError("stale_action");
    if (restoreGen && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='send_restore_generation'").get()) {
      if (store.db.prepare("SELECT token FROM send_restore_generation WHERE id=1").get()?.token !== restoreGen) throw attemptError("stale_action");
    }
    if (receipt.phase !== "terminal" || store.db.prepare("SELECT 1 FROM send_attempt_bindings WHERE attempt_id=? AND active=1").get(receipt.attemptId)) throw attemptError("stop_required");
    if (receipt.delivery !== "not_submitted") {
      if (receipt.delivery === "uncertain" && !receipt.stopGen && !receipt.restoreGen) throw attemptError("stop_required");
      if (!request.confirmDuplicate) throw attemptError("duplicate_confirmation_required");
    }
    const existing = store.readAttempt(scope, request.replacementSendId);
    if (!("kind" in existing) || existing.kind !== "missing") throw attemptError("send_id_conflict");
    // I0 requires replacement identities even on pending resend actions. Both
    // rows are created in this write transaction; a failed action insert also
    // rolls back its replacement and any queued after-commit publication.
    const replacement = createReplacement(receipt, request.replacementSendId);
    if (replacement.sendId !== request.replacementSendId || replacement.attemptId === receipt.attemptId || replacement.isolated !== receipt.isolated || replacement.queueOnly !== receipt.queueOnly || replacement.ownerId !== receipt.ownerId || replacement.botId !== receipt.botId || replacement.threadId !== receipt.threadId || replacement.phase !== "queued" || replacement.messageId) throw attemptError("invalid_replacement");
    store.db.prepare(`INSERT INTO send_actions (owner_id,action_id,bot_id,thread_id,kind,target_attempt_id,target_revision,target_binding_epoch,fingerprint,stop_gen,restore_gen,replacement_attempt_id,replacement_send_id,status,result_code,created_at)
      VALUES (?,?,?,?,'resend',?,?,?,?,?,?,?,?,'done','accepted',?)`)
      .run(scope.ownerId, request.actionId, scope.botId, scope.threadId, receipt.attemptId, receipt.revision, receipt.bindingEpoch, fingerprint, request.stopGen ?? null, request.restoreGen ?? null, replacement.attemptId, replacement.sendId, Date.now());
    return { actionId: request.actionId, replacementSendId: replacement.sendId, replacementAttemptId: replacement.attemptId, receipt: replacement, existing: false };
  });
}

/** Restart is called only after the installation owner has proved that the old
 * provider process/session cannot write. It never invokes an adapter. */
export function recoverSendAttempts(store: SendAttemptStore, closed: (binding: BindingKey) => boolean): number {
  let recovered = 0;
  const rows = store.db.prepare("SELECT attempt_id,binding_epoch,generation,provider_instance_id,provider_turn_id FROM send_attempt_bindings WHERE active=1").all();
  for (const row of rows) store.transaction(() => {
    const receipt = store.byId(String(row.attempt_id)); if (!receipt || receipt.phase === "terminal") return;
    const key: BindingKey = { ...receipt, generation: String(row.generation), providerInstanceId: String(row.provider_instance_id), ...(row.provider_turn_id ? { providerTurnId: String(row.provider_turn_id) } : {}) };
    if (!closed(key)) return;
    const token = randomUUID();
    const sealed = store.seal(key, receipt.revision, token);
    const current = store.byId(receipt.attemptId)!;
    const result = store.settleAttempt(sealed, current.revision, current.delivery === "not_submitted" ? "failed" : "abandoned_uncertain", { binding: sealed, delivery: current.delivery });
    if (result.kind === "committed") recovered++;
  });
  return recovered;
}

/** Import only durable legacy attempted rows, not ordinary historical chat.
 * started + dispatchedIn is ambiguous, never proof that words were delivered. */
export function importLegacySendAttempts(store: SendAttemptStore): number {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_sends'").get()) return 0;
  return store.transaction(() => {
    let imported = 0;
    const rows = store.db.prepare("SELECT * FROM owner_sends WHERE status IN ('started','failed','dispatched','unconfirmed','delivered','refused','cancelled','queued','sending')").all();
    for (const row of rows) {
      const scope = { ownerId: String(row.owner_id), botId: String(row.owner_id), threadId: String(row.thread_id) };
      const sendId = row.send_id ? String(row.send_id) : `srv-${randomUUID()}`;
      if (!("kind" in store.readAttempt(scope, sendId))) continue;
      store.db.prepare("UPDATE owner_sends SET send_id=? WHERE seq=? AND send_id IS NULL").run(sendId, row.seq);
      const receipt = store.create({ ...scope, sendId, fingerprint: String(row.fingerprint), isolated: Boolean(row.isolated), queueOnly: Boolean(row.queue_only), queueId: String(row.queue_id), stopGen: row.stop_gen ? String(row.stop_gen) : undefined, restoreGen: row.restore_gen ? String(row.restore_gen) : undefined });
      if (row.message_id) store.link(receipt.attemptId, String(row.message_id));
      if (["started", "failed", "dispatched", "unconfirmed", "delivered"].includes(String(row.status))) {
        const key = store.bind([receipt.attemptId], { generation: `legacy-${receipt.attemptId}`, providerInstanceId: "legacy" })[0]!;
        store.recordInvocation(key, store.byId(receipt.attemptId)!.revision, false);
      } else if (["refused", "cancelled"].includes(String(row.status))) {
        const key = store.bind([receipt.attemptId], { generation: `legacy-${receipt.attemptId}`, providerInstanceId: "legacy" })[0]!;
        store.settleAttempt(key, store.byId(receipt.attemptId)!.revision, row.status === "cancelled" ? "removed" : "refused", { binding: key, delivery: "not_submitted" });
      }
      imported++;
    }
    return imported;
  });
}
