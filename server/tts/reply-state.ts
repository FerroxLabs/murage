/** Durable speech authority. All transitions are synchronous, transactional and metadata only. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterCommit, onRollback, scopedTx } from "../tx-scope.ts";
import { beginWrite, endWrite, undoWrite } from "../write-tx.ts";
import { BACKGROUND_BUSY_MS, setBusy } from "../db-busy.ts";

export type SpeechEvent =
  | { kind: "speech.ready"; threadId: string; messageId: string; generationId: string; settlementId: string; revision: number; bootId: string; settledAt: number }
  | { kind: "speech.invalidate"; threadId: string; revision: number; reason: "prompt" | "stop" | "recovery"; bootId: string }
  | { kind: "speech.sessionClosed"; sessionId: string; bootId: string; reason: "durable_stop_failed" | "closed" };
export interface SpeechConnection { id: string; principal: string; send(event: SpeechEvent): boolean; terminate(): void }
export interface SpeechAccount { accountScopeId: string; planVersion: string; holdUntil: number; serverNow: number }
export interface SpeechSession { sessionId: string; bootId: string; threadId: string; revision: number }
export interface SpeechTarget { threadId: string; messageId: string; botId: string; eligible: boolean }
export interface SpeechReservation {
  sessionId: string; principal: string; connectionId: string; threadId: string; messageId: string; commandSequence: number;
  settlementId?: string; action?: "speak";
}
export interface SpeechAttempt { attemptId: string; sessionId: string; threadId: string; messageId: string; revision: number; bootId: string; accountScopeId: string; planVersion: string; replaced?: string }
export type SpeechRetentionTable = "speech_settlements" | "speech_generations" | "speech_attempts" | "speech_commands" | "speech_sessions" | "speech_prompts";
/** Newer rows in the same (bot, thread) that let a generation go (design r3 b.1). An unbound row (no provider id) needs this many newer rows
 *  of any kind, which keeps invalidateBot's discovery. A bound row needs this many newer BOUND rows, which keeps the ambiguity a driver that
 *  repeats a provider turn id has today (testing/fake-driver.ts sendTurn), however many unbound generations come between. */
export const SPEECH_GENERATIONS_KEPT_PER_PAIR = 8;
/** Commands kept below an active session's last sequence; an older replay answers stale (409) instead of its stored status. */
export const SPEECH_COMMAND_WINDOW = 256;
/** Whether the owner send a `send:` marker would mirror exists (a database without owner_sends has none to mirror). */
function ownerSendExists(db: DatabaseSync, threadId: string, sendId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_sends'").get()) return true;
  return Boolean(db.prepare("SELECT 1 FROM owner_sends WHERE thread_id=? AND send_id=? LIMIT 1").get(threadId, sendId));
}
/** Rows with a speech-clock time are kept a day: 144 times the longest window any reader applies (the 600 s per-message quota). */
export const SPEECH_RETAIN_MS = 24 * 60 * 60 * 1000;
/** Frontier retention (design r5.1 F): every insert into a retained family first deletes at most this many of the family's dead rows, found by
 *  one seek whose range is the family's dead set, inside the inserting transaction. There is no cursor: a step depends only on committed rows. */
export const SPEECH_RETENTION_DELETES = 2;
/** The tables frontier retention keeps, each trimmed by its own family's inserts. */
export const SPEECH_RETENTION_TABLES: readonly SpeechRetentionTable[] = Object.freeze(["speech_settlements", "speech_generations", "speech_attempts", "speech_commands", "speech_sessions", "speech_prompts"]);
/** What one retention step did, counted (never allowances): rows its seeks returned, probes it ran, rows it deleted. */
export interface SpeechRetentionWork { returned: number; probes: number; removed: number }
/** Where a step applies: a generation step needs its (bot, thread) pair, a prompt step its thread, a command step its session and the
 *  sequence being inserted. */
export interface SpeechRetentionScope { threadId?: string; botId?: string; sessionId?: string; sequence?: number }
/** Bot memberships one ambiguity marker entry holds before it answers "ambiguous" for every bot (design r5.5 Δ11); MAX_WORKSPACE_BOTS. */
export const SPEECH_MARKER_BOTS = 100;
/** The membership standing for every bot; never a real bot id (ids are non-empty and carry no NUL). */
export const SPEECH_MARKER_ANY_BOT = "\u0000any";
/** A usable settlement: `reserve` refuses one this old or older (RS reserve). */
export const SPEECH_SETTLEMENT_USABLE_MS = 60_000;
/** Every statement frontier retention runs (design r5.1 S, G), exported so the plan and work tests read the shipped text. Each is a capped
 *  SEARCH: a range whose rows are all dead, LIMIT 2; or a capped probe. */
export const SPEECH_RETENTION_SQL = Object.freeze({
  settlementsDead: "SELECT rowid AS r FROM speech_settlements INDEXED BY speech_settlement_time WHERE settled_at<=? ORDER BY settled_at LIMIT 2",
  attemptsDead: "SELECT rowid AS r FROM speech_attempts INDEXED BY speech_attempt_terminal WHERE state IN ('complete','failed','cancelled','interrupted') AND reserved_at<=? ORDER BY reserved_at LIMIT 2",
  commandsWindow: "SELECT sequence FROM speech_commands WHERE session_id=? AND sequence<=? ORDER BY sequence LIMIT 2",
  closedSessions: "SELECT session_id FROM speech_sessions INDEXED BY speech_session_closed WHERE state='closed' LIMIT 2",
  commandsOf: "SELECT sequence FROM speech_commands WHERE session_id=? ORDER BY sequence LIMIT ?",
  newestInPair: `SELECT rowid AS r FROM speech_generations INDEXED BY speech_generation_bot WHERE bot_id=? AND thread_id=? ORDER BY rowid DESC LIMIT 1 OFFSET ${SPEECH_GENERATIONS_KEPT_PER_PAIR - 1}`,
  newestBoundInPair: `SELECT rowid AS r FROM speech_generations INDEXED BY speech_generation_bound WHERE bot_id=? AND thread_id=? AND provider_turn_id IS NOT NULL ORDER BY rowid DESC LIMIT 1 OFFSET ${SPEECH_GENERATIONS_KEPT_PER_PAIR - 1}`,
  newestSettlement: "SELECT generation_id,boot_id,settled_at FROM speech_settlements INDEXED BY speech_settlement_thread WHERE thread_id=? ORDER BY settled_at DESC, rowid DESC LIMIT 1",
  unboundDone: "SELECT rowid AS r,generation_id FROM speech_generations INDEXED BY speech_generation_unbound_done WHERE bot_id=? AND thread_id=? AND provider_turn_id IS NULL AND state<>'running' AND rowid<? ORDER BY rowid LIMIT 2",
  boundDone: "SELECT rowid AS r,generation_id,provider_turn_id,boot_id FROM speech_generations INDEXED BY speech_generation_bound_done WHERE bot_id=? AND thread_id=? AND provider_turn_id IS NOT NULL AND state<>'running' AND rowid<? ORDER BY rowid LIMIT 2",
  runningIdentity: "SELECT 1 AS hit FROM speech_generations INDEXED BY speech_generation_running WHERE thread_id=? AND provider_turn_id=? AND boot_id=? AND state='running' LIMIT 1",
  messageMarkers: "SELECT prompt_id FROM speech_prompts WHERE thread_id=? AND prompt_id>='message:' AND prompt_id<'message;' ORDER BY prompt_id LIMIT 2",
});
/** The turn-path statements design r4 T changes, exported so the plan test reads the shipped text. */
export const SPEECH_GENERATION_LOOKUP = "SELECT * FROM speech_generations INDEXED BY speech_generation_identity WHERE thread_id=? AND provider_turn_id=? AND boot_id=? LIMIT 2";
export const SPEECH_GENERATION_LOOKUP_BOT = "SELECT * FROM speech_generations INDEXED BY speech_generation_identity WHERE thread_id=? AND provider_turn_id=? AND boot_id=? AND bot_id=? LIMIT 2";
/** Retires the thread's running rows only (design r5.1 T2): a completed row of the thread can never pass reserve's join again, because the
 *  same transaction bumps the revision, so its stored word is not rewritten and its history is never visited. */
export const SPEECH_INVALIDATE_RUNNING = "UPDATE speech_generations INDEXED BY speech_generation_running SET state='invalid' WHERE thread_id=? AND state='running'";
/** recover closes the thread's active sessions only, through the active-session index (design r5.1 E, Astra r4 H4). */
export const SPEECH_RECOVER_SESSIONS = "UPDATE speech_sessions INDEXED BY speech_session_active SET state='closed' WHERE thread_id=? AND state='active'";
/** boot and closeAll walk only live rows, through live-only partial indexes (design r5.1 E [lw]). */
export const SPEECH_RETIRE_RUNNING = "UPDATE speech_generations INDEXED BY speech_generation_running SET state='invalid' WHERE state='running'";
export const SPEECH_CLOSE_ACTIVE = "UPDATE speech_sessions INDEXED BY speech_session_active SET state='closed' WHERE state='active'";
/** Gives an ended attempt's pending command that attempt's answer: a point update through the pending-by-attempt index (design r3 R). */
export const SPEECH_COMMAND_SETTLE = "UPDATE speech_commands INDEXED BY speech_commands_pending_attempt SET status=?,outcome=? WHERE attempt_id=? AND outcome='pending'";
const endedStatus = (state: string) => state === "complete" ? 200 : state === "cancelled" ? 204 : 502;
/** Runs `sql`, an UPDATE that ends live attempts and returns `attempt_id,state,outcome`, and settles each ended attempt's pending command.
 *  Every statement that moves an attempt out of reserved/streaming goes through here (or finish, which writes its own command), so no
 *  transaction walks the pending commands (design r3 R, invariant I1). */
function endAttempts(db: DatabaseSync, sql: string, ...params: Array<string | number>): void {
  const ended = db.prepare(sql).all(...params);
  if (!ended.length) return;
  const settle = db.prepare(SPEECH_COMMAND_SETTLE);
  for (const row of ended) settle.run(endedStatus(String(row.state)), row.outcome === null ? null : String(row.outcome), String(row.attempt_id));
}
/** The pre-r3 reconciliation, kept as a once-per-start repair (boot) for a database an earlier 1.0.18 build wrote: each pending command whose
 *  attempt is terminal takes that attempt's answer. Walks the pending commands (partial index) and probes each attempt by key. */
export const SPEECH_COMMAND_RECONCILE = `UPDATE speech_commands SET
        status=(SELECT CASE state WHEN 'complete' THEN 200 WHEN 'cancelled' THEN 204 ELSE 502 END FROM speech_attempts a WHERE a.attempt_id=speech_commands.attempt_id),
        outcome=(SELECT outcome FROM speech_attempts a WHERE a.attempt_id=speech_commands.attempt_id)
        WHERE outcome='pending' AND EXISTS (SELECT 1 FROM speech_attempts a WHERE a.attempt_id=speech_commands.attempt_id AND a.state NOT IN ('reserved','streaming'))`;
export class SpeechRefusal extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
type SessionRow = { session_id: string; principal: string; connection_id: string; thread_id: string; boot_id: string; state: string; last_sequence: number; active_attempt: string | null };
type Generation = { generation_id: string; thread_id: string; bot_id: string; prompt_id: string; revision: number; boot_id: string; provider_turn_id: string | null; state: string };
type Transaction = <T>(work: (db: DatabaseSync) => T) => T;
let savepoint = 0;
/** Tests and standalone ledger users use real SQLite transactions with the same after-commit discipline. */
export function speechTransaction(db: DatabaseSync): Transaction {
  return work => scopedTx(() => {
    // write-tx.ts frames (D24-B2 item d): BEGIN IMMEDIATE + savepoint at top level, a savepoint alone when nested, so a nested call can
    // never commit or roll back the caller's transaction
    const point = `speech_${++savepoint}`;
    beginWrite(db, point);
    try {
      const result = work(db);
      endWrite(db, point);
      return result;
    }
    catch (error) {
      try { undoWrite(db, point); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Speech transaction and rollback failed: ${String(cleanup)}`, { cause: error }); }
      throw error;
    }
  });
}
export class ReplyState {
  private incarnation = randomUUID();
  get bootId(): string { return this.incarnation; }
  private ready = false;
  private lastClock = 0;
  private readonly quarantined = new Set<string>();
  private readonly listening = new Map<string, { threadId: string; connection: SpeechConnection }>();
  private readonly revoked = new Set<string>();
  private readonly aborters = new Map<string, { threadId: string; sessionId: string; abort(): void }>();
  private readonly memoryHolds = new Map<string, number>();
  /** Bounded ambiguity markers (design r5.1 G): thread → provider id + boot → the bots of bound rows retention deleted while a row of that
   *  identity was running. A unique running lookup of a marked identity answers "ambiguous", as the full ledger would. Changed only after the
   *  outermost commit; an entry lives while a running row of its identity does (sweepMarkers). */
  private readonly ambiguous = new Map<string, Map<string, Set<string>>>();
  /** Sessions whose close transaction failed: the next session() transaction closes them (design r5.1 S, close leftovers). */
  private readonly unclosed = new Set<string>();
  /** Marker work whose outermost tx-scope frame "committed" while the connection was still inside a transaction no frame owns (a caller's raw
   *  BEGIN, under any frame opener): that transaction may yet roll back, and no hook will hear of it. The first speech transaction that
   *  commits with the connection idle settles it against committed rows (design r5.6 Δ13; Grok r5.6 M1/M2, Astra code review 1-3):
   *  - `unconfirmed`: memberships added there, each with the row whose deletion it stands for; one whose row is back is dropped;
   *  - `sweepLater`: threads whose sweep ran there; swept again on committed rows;
   *  - `pending` (below): the membership ids that have a record in `unconfirmed`.
   *  All three are empty after the first idle speech commit. The `Transaction` opener must open a tx-scope frame (tx-scope.ts runs afterCommit
   *  at once without one). */
  private readonly unconfirmed: Array<{ threadId: string; key: string; botId: string; generationId: string }> = [];
  /** The memberships `unconfirmed` holds records for. */
  private readonly pending = new Set<string>();
  private readonly sweepLater = new Set<string>();
  /** The last retention step's work, for the work tests. */
  lastRetention: SpeechRetentionWork | undefined;
  private readonly db: () => DatabaseSync;
  private readonly tx: Transaction;
  private readonly now: () => number;
  private readonly emit: (event: SpeechEvent) => void;
  constructor(options: { db(): DatabaseSync; transaction: Transaction; now?: () => number; emit?: (event: SpeechEvent) => void }) {
    this.db = options.db;
    // A command's permanent duplicate result follows cancellation and boot recovery too: each statement that ends an attempt settles that
    // attempt's own command (endAttempts), so a transaction never walks the pending commands (D24-SPEECH-RETENTION design r3 R).
    // every speech transaction, once its outermost frame commits with the connection idle, settles marker work left by raw transactions
    this.tx = work => options.transaction(db => { afterCommit(() => this.settleDeferredMarkers()); return work(db); });
    this.now = options.now ?? Date.now; this.emit = options.emit ?? (() => {});
  }
  boot(): void {
    this.ready = false;
    this.ambiguous.clear(); this.sweepLater.clear(); this.unconfirmed.length = 0; this.pending.clear(); this.unclosed.clear();
    this.tx(db => {
      const now = this.clock(db);
      db.prepare("UPDATE speech_accounts SET hold_until=max(hold_until,?) WHERE account_scope_id IN (SELECT account_scope_id FROM speech_attempts INDEXED BY speech_attempt_live_session WHERE state IN ('reserved','streaming'))").run(now + 600_000);
      endAttempts(db, "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='interrupted',outcome='boot' WHERE state IN ('reserved','streaming') RETURNING attempt_id,state,outcome");
      db.exec(`${SPEECH_RETIRE_RUNNING}; ${SPEECH_CLOSE_ACTIVE};`);
      // once per start: a database an earlier 1.0.18 build wrote is brought to the same commands
      db.exec(SPEECH_COMMAND_RECONCILE);
    });
    this.ready = true;
  }
  invalidateBot(botId: string): void {
    this.check();
    const threads = this.db().prepare("SELECT DISTINCT thread_id FROM speech_generations WHERE bot_id=?").all(botId);
    for (const row of threads) this.invalidate(String(row.thread_id));
  }
  /** Fleet disposal and restore retire even completed downloads and rotate volatile authority. */
  closeAll(): void {
    this.check();
    try {
      this.tx(db => {
        // running rows only: the new incarnation below makes every earlier settlement fail reserve's boot check (design r5.1 T2)
        db.exec(`${SPEECH_RETIRE_RUNNING}; ${SPEECH_CLOSE_ACTIVE};`);
        endAttempts(db, "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='cancelled',outcome='disposed' WHERE state IN ('reserved','streaming') RETURNING attempt_id,state,outcome");
      });
      for (const [sessionId, listener] of this.listening) {
        let sent = false;
        try { sent = listener.connection.send({ kind: "speech.sessionClosed", sessionId, bootId: this.bootId, reason: "closed" }); } catch { /* terminate below */ }
        if (!sent) listener.connection.terminate();
      }
    } catch {
      for (const threadId of new Set([...this.listening.values()].map(listener => listener.threadId))) this.quarantine(threadId);
      this.ready = false;
      throw new SpeechRefusal(503, "durable_stop_failed");
    } finally {
      this.abortWhere(() => true); this.listening.clear(); this.revoked.clear(); this.ambiguous.clear(); this.sweepLater.clear(); this.unconfirmed.length = 0; this.pending.clear(); this.unclosed.clear(); this.incarnation = randomUUID();
    }
  }
  private check(threadId?: string): void { if (!this.ready || threadId && this.quarantined.has(threadId)) throw new SpeechRefusal(409, "speech_unavailable"); }
  private clock(db: DatabaseSync): number {
    const row = db.prepare("SELECT value FROM speech_clock WHERE id=1").get();
    if (!row) throw new SpeechRefusal(409, "speech_unavailable");
    const now = Math.max(this.lastClock, Number(row.value), Math.floor(this.now()));
    if (!Number.isSafeInteger(now) || now < 0) throw new SpeechRefusal(409, "speech_unavailable");
    this.lastClock = now;
    db.prepare("UPDATE speech_clock SET value=? WHERE id=1").run(now); return now;
  }
  revision(threadId: string): number {
    this.check(threadId);
    return Number(this.db().prepare("SELECT revision FROM speech_threads WHERE thread_id=?").get(threadId)?.revision ?? 0);
  }
  /** SendStore has already deduplicated this acceptance, including explicit resends. */
  acceptPrompt(threadId: string, sendId?: string): number {
    return this.tx(db => {
      const revision = this.invalidate(threadId, "prompt");
      // a send: marker lives as long as its owner_sends row, which SendStore's accept holds in this transaction (design r5.1 P)
      if (sendId) { this.retainPrompts(db, threadId); db.prepare("INSERT OR IGNORE INTO speech_prompts VALUES(?,?)").run(threadId, `send:${sendId}`); }
      return revision;
    });
  }
  /** Must run inside the transaction accepting the owner's prompt. */
  prompt(threadId: string, promptId?: string): number {
    if (!promptId) return this.invalidate(threadId, "prompt");
    // a message: prompt writes no marker; it drains up to two of its thread's pre-r5 message: markers (design r5.1 P, M14)
    if (promptId.startsWith("message:")) return this.tx(db => { this.check(threadId); this.retainPrompts(db, threadId); return this.invalidate(threadId, "prompt"); });
    return this.tx(db => {
      this.check(threadId);
      // a send: marker is written only beside its owner_sends row, so SendStore's deletes keep every marker bounded (design r5.1 P)
      if (promptId.startsWith("send:") && !ownerSendExists(db, threadId, promptId.slice(5))) return this.invalidate(threadId, "prompt");
      this.retainPrompts(db, threadId);
      const inserted = db.prepare("INSERT OR IGNORE INTO speech_prompts VALUES(?,?)").run(threadId, promptId).changes;
      if (!inserted) return this.revision(threadId);
      return this.invalidate(threadId, "prompt");
    });
  }
  /** Revocation closes volatile authority on failure; its durable retry must not block terminal delivery. */
  private retire<T>(work: (db: DatabaseSync) => T): T {
    const db = this.db(), wait = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
    try { setBusy(db, Math.min(wait, BACKGROUND_BUSY_MS)); return this.tx(work); }
    finally { if (db.isOpen) setBusy(db, wait); }
  }
  invalidate(threadId: string, reason: "prompt" | "stop" = "stop"): number {
    // An owner Stop on a quarantined thread is never refused: quarantine already revoked its sessions and jobs, and
    // recoverPending owns the durable retire. Quarantine stays until recover commits (authorize/reserve/session stay 409).
    if (reason === "stop" && this.ready && this.quarantined.has(threadId)) { this.abortWhere(job => job.threadId === threadId); return 0; }
    this.check(threadId);
    try {
      return this.retire(db => {
        db.prepare("INSERT INTO speech_threads(thread_id,revision) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(threadId);
        const revision = Number(db.prepare("SELECT revision FROM speech_threads WHERE thread_id=?").get(threadId)!.revision);
        db.prepare(SPEECH_INVALIDATE_RUNNING).run(threadId);
        endAttempts(db, "UPDATE speech_attempts SET state='cancelled',outcome='invalidated' WHERE thread_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", threadId);
        this.sweepMarkers(threadId);
        afterCommit(() => { this.abortWhere(job => job.threadId === threadId); this.emit({ kind: "speech.invalidate", threadId, revision, reason, bootId: this.bootId }); });
        return revision;
      });
    } catch { this.quarantine(threadId); throw new SpeechRefusal(503, "durable_stop_failed"); }
  }
  private quarantine(threadId: string): void {
    this.quarantined.add(threadId);
    for (const [sessionId, listener] of this.listening) if (listener.threadId === threadId) {
      this.revoked.add(sessionId);
      this.abortWhere(job => job.sessionId === sessionId);
      let sent = false;
      try { sent = listener.connection.send({ kind: "speech.sessionClosed", sessionId, bootId: this.bootId, reason: "durable_stop_failed" }); } catch { /* fixed failure below */ }
      if (!sent) listener.connection.terminate();
    }
    this.abortWhere(job => job.threadId === threadId);
  }
  /** Only the coordinator recovery clock calls this; reconnect never clears quarantine. */
  recoverPending(): void {
    let attempted = 0;
    for (const threadId of this.quarantined) {
      try { this.recover(threadId); }
      catch { this.quarantined.delete(threadId); this.quarantined.add(threadId); }
      if (++attempted === 2) break;
    }
  }
  recover(threadId: string): void {
    if (!this.quarantined.has(threadId)) return;
    this.retire(db => {
      db.prepare("INSERT INTO speech_threads(thread_id,revision) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(threadId);
      db.prepare(SPEECH_INVALIDATE_RUNNING).run(threadId);
      endAttempts(db, "UPDATE speech_attempts SET state='cancelled',outcome='recovery' WHERE thread_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", threadId);
      db.prepare(SPEECH_RECOVER_SESSIONS).run(threadId);
      this.sweepMarkers(threadId);
    });
    this.quarantined.delete(threadId);
    this.emit({ kind: "speech.invalidate", threadId, revision: this.revision(threadId), reason: "recovery", bootId: this.bootId });
  }
  begin(threadId: string, botId: string, generationId: string, promptId: string): void {
    this.check(threadId);
    this.tx(db => {
      db.prepare("INSERT OR IGNORE INTO speech_threads(thread_id,revision) VALUES(?,0)").run(threadId);
      this.retainGenerations(db, botId, threadId, this.clock(db));
      db.prepare("INSERT INTO speech_generations(generation_id,thread_id,bot_id,prompt_id,revision,boot_id,state) SELECT ?,?,?,?,revision,?,'running' FROM speech_threads WHERE thread_id=?").run(generationId, threadId, botId, promptId, this.bootId, threadId);
    });
  }
  bind(generationId: string, providerTurnId: string): void {
    this.check();
    this.tx(db => {
      const row = db.prepare("SELECT * FROM speech_generations WHERE generation_id=?").get(generationId) as Generation | undefined;
      if (!row || row.state !== "running" || row.boot_id !== this.bootId) return;
      this.check(row.thread_id);
      if (row.provider_turn_id && row.provider_turn_id !== providerTurnId) throw new SpeechRefusal(409, "generation_conflict");
      db.prepare("UPDATE speech_generations SET provider_turn_id=? WHERE generation_id=?").run(providerTurnId, generationId);
    });
  }
  generation(threadId: string, providerTurnId: string, botId?: string): Generation | undefined {
    this.check(threadId);
    // two rows are enough to know the id is ambiguous; the seek never reads the rest of a same-id group (design r4 T1)
    const candidates = (botId
      ? this.db().prepare(SPEECH_GENERATION_LOOKUP_BOT).all(threadId, providerTurnId, this.bootId, botId)
      : this.db().prepare(SPEECH_GENERATION_LOOKUP).all(threadId, providerTurnId, this.bootId)) as Generation[];
    if (candidates.length !== 1) return undefined;
    const only = candidates[0]!;
    // a bound row retention deleted while this identity was running would make the full ledger ambiguous here (design r5.1 G marker)
    const bots = only.state === "running" ? this.ambiguous.get(threadId)?.get(`${providerTurnId}\u0000${this.bootId}`) : undefined;
    if (bots && (!botId || bots.has(botId) || bots.has(SPEECH_MARKER_ANY_BOT))) return undefined;
    return only;
  }
  invalidateGeneration(threadId: string, generationId: string): void {
    this.check(threadId);
    try {
      if (!this.db().prepare("SELECT 1 FROM speech_generations WHERE generation_id=? AND thread_id=? AND state='running'").get(generationId, threadId)) return;
      this.retire(db => { db.prepare("UPDATE speech_generations SET state='invalid' WHERE generation_id=? AND thread_id=? AND state='running'").run(generationId, threadId); this.sweepMarkers(threadId); });
    }
    catch { this.quarantine(threadId); throw new SpeechRefusal(503, "durable_stop_failed"); }
  }
  /** Called inside the transaction marking the stored terminal message. Metadata patches never call this. */
  settle(threadId: string, providerTurnId: string, messageId: string | undefined, completed: boolean, botId?: string): SpeechEvent | undefined {
    this.check(threadId);
    return this.tx(db => {
      const generation = this.generation(threadId, providerTurnId, botId);
      if (!generation || generation.state !== "running") return;
      this.sweepMarkers(threadId);
      if (!completed || !messageId || generation.revision !== this.revision(threadId)) {
        db.prepare("UPDATE speech_generations SET state='invalid' WHERE generation_id=?").run(generation.generation_id); return;
      }
      const settledAt = this.clock(db), settlementId = randomUUID();
      this.retainSettlements(db, settledAt);
      db.prepare("INSERT INTO speech_settlements VALUES(?,?,?,?,?,?,?,'completed')").run(settlementId, generation.generation_id, threadId, messageId, generation.revision, this.bootId, settledAt);
      db.prepare("UPDATE speech_generations SET state='completed' WHERE generation_id=?").run(generation.generation_id);
      const event: SpeechEvent = { kind: "speech.ready", threadId, messageId, generationId: generation.generation_id, settlementId, revision: generation.revision, bootId: this.bootId, settledAt };
      afterCommit(() => this.emit(event)); return event;
    });
  }
  session(connection: SpeechConnection, threadId: string): SpeechSession {
    this.check(threadId);
    if (this.listening.size >= 128 && ![...this.listening.values()].some(item => item.connection.id === connection.id)) throw new SpeechRefusal(409, "session_limit");
    const sessionId = randomUUID();
    const replaced = [...this.listening].filter(([, item]) => item.connection.id === connection.id).map(([id]) => id);
    const leftovers = [...this.unclosed];
    this.tx(db => {
      db.prepare("INSERT OR IGNORE INTO speech_threads(thread_id,revision) VALUES(?,0)").run(threadId);
      // sessions whose close failed earlier are closed now, so the durable active sessions stay the listening ones (design r5.1 S)
      for (const id of leftovers) {
        db.prepare("UPDATE speech_sessions SET state='closed' WHERE session_id=? AND state='active'").run(id);
        endAttempts(db, "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='cancelled',outcome='disconnected' WHERE session_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", id);
      }
      if (leftovers.length) afterCommit(() => { for (const id of leftovers) this.unclosed.delete(id); });
      db.prepare("UPDATE speech_sessions SET state='closed' WHERE connection_id=? AND state='active'").run(connection.id);
      for (const id of replaced) endAttempts(db, "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='cancelled',outcome='session_replaced' WHERE session_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", id);
      this.retainFamily(db);
      db.prepare("INSERT INTO speech_sessions(session_id,principal,connection_id,thread_id,boot_id,state) VALUES(?,?,?,?,?,'active')").run(sessionId, connection.principal, connection.id, threadId, this.bootId);
    });
    for (const id of replaced) { this.revoked.add(id); this.abortWhere(job => job.sessionId === id); this.listening.delete(id); this.revoked.delete(id); }
    this.listening.set(sessionId, { threadId, connection });
    return { sessionId, threadId, bootId: this.bootId, revision: this.revision(threadId) };
  }
  closeConnection(connectionId: string): void {
    const ids = [...this.listening].filter(([, item]) => item.connection.id === connectionId).map(([id]) => id);
    for (const id of ids) { this.revoked.add(id); this.abortWhere(job => job.sessionId === id); }
    try { this.tx(db => {
      db.prepare("UPDATE speech_sessions SET state='closed' WHERE connection_id=? AND state='active'").run(connectionId);
      for (const id of ids) endAttempts(db, "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='cancelled',outcome='disconnected' WHERE session_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", id);
    }); } catch (error) {
      // the rows stay durably active; the next session() closes them (design r5.1 S, close leftovers)
      for (const id of ids) this.unclosed.add(id);
      throw error;
    } finally { for (const id of ids) { this.listening.delete(id); this.revoked.delete(id); } }
  }
  private requireSession(input: Pick<SpeechReservation, "sessionId" | "principal" | "connectionId" | "threadId">): SessionRow {
    this.check(input.threadId);
    const row = this.db().prepare("SELECT * FROM speech_sessions WHERE session_id=?").get(input.sessionId) as SessionRow | undefined;
    if (!row || this.revoked.has(input.sessionId) || !this.listening.has(input.sessionId) || row.state !== "active" || row.boot_id !== this.bootId || row.principal !== input.principal || row.connection_id !== input.connectionId || row.thread_id !== input.threadId) throw new SpeechRefusal(409, "session_unavailable");
    return row;
  }
  binding(sessionId: string, principal: string, threadId: string): string {
    const listener = this.listening.get(sessionId);
    if (!listener) throw new SpeechRefusal(409, "session_unavailable");
    this.requireSession({ sessionId, principal, threadId, connectionId: listener.connection.id });
    return listener.connection.id;
  }
  sequence(input: SpeechReservation): void {
    const session = this.requireSession(input);
    const duplicate = this.db().prepare("SELECT status FROM speech_commands WHERE session_id=? AND sequence=?").get(input.sessionId, input.commandSequence);
    if (duplicate) throw new SpeechRefusal(input.action === "speak" ? Number(duplicate.status) : 204, "duplicate_command");
    if (!Number.isSafeInteger(input.commandSequence) || input.commandSequence <= session.last_sequence) throw new SpeechRefusal(input.action === "speak" ? 409 : 204, "stale_command");
  }
  accountStatus(accountScopeId: string, planVersion: string): SpeechAccount {
    const memoryHold = this.memoryHolds.get(accountScopeId) ?? 0;
    let storedHold = 0;
    try {
      const row = this.db().prepare("SELECT hold_until FROM speech_accounts WHERE account_scope_id=?").get(accountScopeId);
      if (!row && !memoryHold) throw new SpeechRefusal(409, "voice_changed");
      storedHold = Number(row?.hold_until ?? 0);
    } catch (error) { if (!memoryHold) throw error; }
    // A newly observed budget refusal still identifies its already-reserved account
    // when persistence fails. Admission remains closed until storage is healthy.
    return { accountScopeId, planVersion, holdUntil: Math.max(storedHold, memoryHold), serverNow: Math.max(this.lastClock, this.now()) };
  }
  authorize(input: Pick<SpeechReservation, "sessionId" | "principal" | "connectionId" | "threadId">): void { this.requireSession(input); }
  account(bindingId: string, credentialVersion: string): SpeechAccount {
    this.check();
    return this.tx(db => {
      const now = this.clock(db);
      db.prepare("INSERT OR IGNORE INTO speech_accounts(binding_id,credential_version,account_scope_id,plan_version) VALUES(?,?,?,?)").run(bindingId, credentialVersion, randomUUID(), randomUUID());
      const row = db.prepare("SELECT * FROM speech_accounts WHERE binding_id=? AND credential_version=?").get(bindingId, credentialVersion)!;
      return { accountScopeId: String(row.account_scope_id), planVersion: String(row.plan_version), holdUntil: Math.max(Number(row.hold_until), this.memoryHolds.get(String(row.account_scope_id)) ?? 0), serverNow: now };
    });
  }
  plan(account: SpeechAccount, fingerprint: string): SpeechAccount {
    this.check();
    return this.tx(db => {
      db.prepare("INSERT OR IGNORE INTO speech_plans VALUES(?,?,?)").run(account.accountScopeId, fingerprint, randomUUID());
      const row = db.prepare("SELECT plan_version FROM speech_plans WHERE account_scope_id=? AND fingerprint=?").get(account.accountScopeId, fingerprint)!;
      return { ...account, planVersion: String(row.plan_version) };
    });
  }
  reserve(input: SpeechReservation, validate: () => { target: SpeechTarget; account: SpeechAccount }): SpeechAttempt {
    this.check(input.threadId);
    return this.tx(db => {
      const session = this.requireSession(input), manual = input.action === "speak";
      if (!Number.isSafeInteger(input.commandSequence) || input.commandSequence <= 0) throw new SpeechRefusal(400, "command_sequence");
      const duplicate = db.prepare("SELECT status,outcome FROM speech_commands WHERE session_id=? AND sequence=?").get(input.sessionId, input.commandSequence);
      if (duplicate) throw new SpeechRefusal(manual ? Number(duplicate.status) : 204, "duplicate_command");
      if (input.commandSequence <= session.last_sequence) throw new SpeechRefusal(manual ? 409 : 204, "stale_command");
      const { target, account } = validate();
      if (!target.eligible || target.threadId !== input.threadId || target.messageId !== input.messageId) throw new SpeechRefusal(404, "reply_unavailable");
      const revision = this.revision(input.threadId), now = this.clock(db);
      let generationId: string | null = null;
      if (!manual) {
        const settled = db.prepare("SELECT s.*,g.state,g.bot_id FROM speech_settlements s JOIN speech_generations g USING(generation_id) WHERE settlement_id=? AND s.thread_id=? AND message_id=?").get(input.settlementId ?? "", input.threadId, input.messageId);
        if (!settled || settled.boot_id !== this.bootId || settled.state !== "completed" || settled.bot_id !== target.botId || Number(settled.revision) !== revision || now - Number(settled.settled_at) >= 60_000 || db.prepare("SELECT 1 FROM speech_attempts WHERE message_id=? AND mode='automatic'").get(input.messageId)) throw new SpeechRefusal(204, "stale_reply");
        generationId = String(settled.generation_id);
      }
      const storedAccount = db.prepare("SELECT * FROM speech_accounts WHERE account_scope_id=? AND (plan_version=? OR EXISTS(SELECT 1 FROM speech_plans p WHERE p.account_scope_id=speech_accounts.account_scope_id AND p.plan_version=?))").get(account.accountScopeId, account.planVersion, account.planVersion);
      if (!storedAccount) throw new SpeechRefusal(409, "voice_changed");
      if (Math.max(Number(storedAccount.hold_until), this.memoryHolds.get(account.accountScopeId) ?? 0) > now) throw new SpeechRefusal(402, "voice_budget_reached");
      const count = (sql: string, ...args: Array<string | number>) => Number(db.prepare(sql).get(...args)!.n);
      if (count("SELECT count(*) n FROM speech_attempts WHERE reserved_at>?", now - 60_000) >= 6 || count("SELECT count(*) n FROM speech_attempts WHERE message_id=? AND reserved_at>?", input.messageId, now - 600_000) >= 3) throw new SpeechRefusal(429, "voice_quota");
      const active = db.prepare("SELECT attempt_id,session_id FROM speech_attempts WHERE thread_id=? AND state IN ('reserved','streaming')").get(input.threadId);
      if (active && (!manual || active.session_id !== input.sessionId)) throw new SpeechRefusal(409, "speech_busy");
      const replaced = session.active_attempt ?? undefined;
      if (replaced) endAttempts(db, "UPDATE speech_attempts SET state='cancelled',outcome='replaced' WHERE attempt_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", replaced);
      const attemptId = randomUUID();
      this.retainAttempts(db, now);
      // the window is measured from the sequence being inserted, before last_sequence is written (design r5.1 S, Astra r5-4)
      this.retainFamily(db, input.sessionId, input.commandSequence);
      db.prepare("INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,generation_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved')").run(attemptId, input.sessionId, input.commandSequence, input.threadId, input.messageId, generationId, manual ? "manual" : "automatic", revision, this.bootId, now, account.accountScopeId, account.planVersion);
      db.prepare("INSERT INTO speech_commands VALUES(?,?,409,'pending',?)").run(input.sessionId, input.commandSequence, attemptId);
      db.prepare("UPDATE speech_sessions SET last_sequence=?,active_attempt=? WHERE session_id=?").run(input.commandSequence, attemptId, input.sessionId);
      return { attemptId, sessionId: input.sessionId, threadId: input.threadId, messageId: input.messageId, revision, bootId: this.bootId, accountScopeId: account.accountScopeId, planVersion: account.planVersion, replaced };
    });
  }
  install(attempt: SpeechAttempt, abort: () => void): void {
    if (!this.current(attempt)) { abort(); throw new SpeechRefusal(409, "attempt_cancelled"); }
    if (attempt.replaced) { this.aborters.get(attempt.replaced)?.abort(); this.aborters.delete(attempt.replaced); }
    this.aborters.set(attempt.attemptId, { threadId: attempt.threadId, sessionId: attempt.sessionId, abort });
  }
  current(attempt: SpeechAttempt): boolean {
    try {
      this.check(attempt.threadId);
      if (attempt.bootId !== this.bootId || this.revoked.has(attempt.sessionId) || !this.listening.has(attempt.sessionId)) return false;
      const row = this.db().prepare("SELECT a.state,s.active_attempt,s.state AS session_state,t.revision FROM speech_attempts a JOIN speech_sessions s USING(session_id) JOIN speech_threads t ON t.thread_id=a.thread_id WHERE attempt_id=?").get(attempt.attemptId);
      return Boolean(row && row.session_state === "active" && row.active_attempt === attempt.attemptId && Number(row.revision) === attempt.revision && ["reserved","streaming"].includes(String(row.state)));
    } catch { return false; }
  }
  finish(attempt: SpeechAttempt, outcome: "complete" | "failed" | "cancelled" | "budget"): void {
    if (outcome === "budget") this.memoryHolds.set(attempt.accountScopeId, Math.max(this.lastClock, this.now()) + 600_000);
    try { this.tx(db => {
      if (outcome === "budget") {
        const until = Math.max(this.clock(db) + 600_000, this.memoryHolds.get(attempt.accountScopeId)!);
        this.memoryHolds.set(attempt.accountScopeId, until);
        db.prepare("UPDATE speech_accounts SET hold_until=max(hold_until,?) WHERE account_scope_id=?").run(until, attempt.accountScopeId);
      }
      const state = outcome === "budget" ? "failed" : outcome;
      const changed = db.prepare("UPDATE speech_attempts SET state=?,outcome=? WHERE attempt_id=? AND state IN ('reserved','streaming')").run(state, outcome, attempt.attemptId).changes;
      if (changed) db.prepare("UPDATE speech_commands INDEXED BY speech_commands_pending_attempt SET status=?,outcome=? WHERE attempt_id=? AND outcome='pending'").run(outcome === "complete" ? 200 : outcome === "budget" ? 402 : outcome === "cancelled" ? 204 : 502, outcome, attempt.attemptId);
      db.prepare("UPDATE speech_sessions SET active_attempt=NULL WHERE session_id=? AND active_attempt=?").run(attempt.sessionId, attempt.attemptId);
    }); } finally { this.aborters.delete(attempt.attemptId); }
  }
  cancel(input: Omit<SpeechReservation, "messageId">): void {
    try { this.tx(db => {
      const session = this.requireSession(input);
      if (!Number.isSafeInteger(input.commandSequence) || input.commandSequence <= session.last_sequence) throw new SpeechRefusal(409, "stale_command");
      db.prepare("UPDATE speech_sessions SET last_sequence=?,active_attempt=NULL WHERE session_id=?").run(input.commandSequence, input.sessionId);
      this.retainFamily(db, input.sessionId, input.commandSequence);
      db.prepare("INSERT INTO speech_commands VALUES(?,?,204,'cancelled',NULL)").run(input.sessionId, input.commandSequence);
      endAttempts(db, "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='cancelled',outcome='cancelled' WHERE session_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", input.sessionId);
      afterCommit(() => this.abortWhere(job => job.sessionId === input.sessionId));
    }); } catch (error) {
      if (error instanceof SpeechRefusal) throw error;
      this.quarantine(input.threadId); throw new SpeechRefusal(503, "durable_stop_failed");
    }
  }
  /** One frontier step for `table`'s family in its own transaction: the step an insert into that family runs first (tests and repair; design
   *  r5.1 S). Generations need `scope.botId` and `scope.threadId`, prompts `scope.threadId`; a command step takes `scope.sessionId` and
   *  `scope.sequence`. */
  retainSpeechRows(table: SpeechRetentionTable, scope: SpeechRetentionScope = {}): SpeechRetentionWork {
    this.check();
    return this.tx(db => {
      const now = this.clock(db);
      switch (table) {
        case "speech_settlements": return this.retainSettlements(db, now);
        case "speech_attempts": return this.retainAttempts(db, now);
        case "speech_sessions": case "speech_commands": return this.retainFamily(db, scope.sessionId, scope.sequence);
        case "speech_generations":
          if (!scope.botId || !scope.threadId) throw new RangeError("retention scope");
          return this.retainGenerations(db, scope.botId, scope.threadId, now);
        case "speech_prompts":
          if (!scope.threadId) throw new RangeError("retention scope");
          return this.retainPrompts(db, scope.threadId);
        default: throw new RangeError("retention table");
      }
    });
  }
  private work(work: SpeechRetentionWork): SpeechRetentionWork { return this.lastRetention = work; }
  /** settlements (design r5.1 S): the range settled_at <= now − a day is exactly the dead set; the speech clock never goes back. */
  private retainSettlements(db: DatabaseSync, now: number): SpeechRetentionWork {
    const rows = db.prepare(SPEECH_RETENTION_SQL.settlementsDead).all(now - SPEECH_RETAIN_MS);
    const remove = db.prepare("DELETE FROM speech_settlements WHERE rowid=?");
    for (const row of rows) remove.run(Number(row.r));
    return this.work({ returned: rows.length, probes: 0, removed: rows.length });
  }
  /** attempts (design r5.1 S): terminal and reserved a day ago or more; a terminal state is final. */
  private retainAttempts(db: DatabaseSync, now: number): SpeechRetentionWork {
    const rows = db.prepare(SPEECH_RETENTION_SQL.attemptsDead).all(now - SPEECH_RETAIN_MS);
    const remove = db.prepare("DELETE FROM speech_attempts WHERE rowid=?");
    for (const row of rows) remove.run(Number(row.r));
    return this.work({ returned: rows.length, probes: 0, removed: rows.length });
  }
  /** sessions + commands, one family (design r5.1 S). A command insert into `sessionId` at `sequence` first drops that session's commands 256
   *  or more positions back; any budget left goes to the closed front: a closed session's commands (all dead, pending ones included: no path
   *  reads a closed session's commands), then the session once it has none. */
  private retainFamily(db: DatabaseSync, sessionId?: string, sequence?: number): SpeechRetentionWork {
    let budget = SPEECH_RETENTION_DELETES, returned = 0, removed = 0;
    const removeCommand = db.prepare("DELETE FROM speech_commands WHERE session_id=? AND sequence=?");
    if (sessionId !== undefined && sequence !== undefined) {
      const rows = db.prepare(SPEECH_RETENTION_SQL.commandsWindow).all(sessionId, sequence - SPEECH_COMMAND_WINDOW);
      returned += rows.length;
      for (const row of rows) { removeCommand.run(sessionId, Number(row.sequence)); removed++; budget--; }
    }
    if (budget > 0) {
      const closed = db.prepare(SPEECH_RETENTION_SQL.closedSessions).all();
      returned += closed.length;
      const commandsOf = db.prepare(SPEECH_RETENTION_SQL.commandsOf);
      for (const session of closed) {
        if (budget === 0) break;
        const id = String(session.session_id);
        const asked = budget, commands = commandsOf.all(id, asked);
        returned += commands.length;
        for (const row of commands) { removeCommand.run(id, Number(row.sequence)); removed++; budget--; }
        // fewer than asked for: the session has no command left
        if (budget > 0 && commands.length < asked) {
          db.prepare("DELETE FROM speech_sessions WHERE session_id=?").run(id); removed++; budget--;
        }
      }
    }
    return this.work({ returned, probes: 0, removed });
  }
  /** generations, per (bot, thread) pair at begin (design r5.1 G). Two classes, each a rowid range of non-running rows older than the pair's
   *  8th newest (bound) row. The one protected row is the thread's newest settlement's generation while it is usable. A bound row deleted while
   *  a row of its provider identity runs leaves a marker, so that identity stays ambiguous as in the full ledger. */
  private retainGenerations(db: DatabaseSync, botId: string, threadId: string, now: number): SpeechRetentionWork {
    let budget = SPEECH_RETENTION_DELETES, returned = 0, probes = 0, removed = 0;
    const nth = (sql: string) => { probes++; const row = db.prepare(sql).get(botId, threadId); return row ? Number(row.r) : null; };
    const any = nth(SPEECH_RETENTION_SQL.newestInPair), bound = nth(SPEECH_RETENTION_SQL.newestBoundInPair);
    if (any === null && bound === null) return this.work({ returned, probes, removed });
    probes++;
    const newest = db.prepare(SPEECH_RETENTION_SQL.newestSettlement).get(threadId);
    const protectedId = newest && newest.boot_id === this.bootId && Number(newest.settled_at) > now - SPEECH_SETTLEMENT_USABLE_MS ? String(newest.generation_id) : undefined;
    const remove = db.prepare("DELETE FROM speech_generations WHERE rowid=?");
    if (any !== null) {
      const rows = db.prepare(SPEECH_RETENTION_SQL.unboundDone).all(botId, threadId, any);
      returned += rows.length;
      for (const row of rows) {
        if (budget === 0) break;
        if (String(row.generation_id) === protectedId) continue;
        remove.run(Number(row.r)); removed++; budget--;
      }
    }
    if (bound !== null && budget > 0) {
      const rows = db.prepare(SPEECH_RETENTION_SQL.boundDone).all(botId, threadId, bound);
      returned += rows.length;
      const running = db.prepare(SPEECH_RETENTION_SQL.runningIdentity);
      for (const row of rows) {
        if (budget === 0) break;
        if (String(row.generation_id) === protectedId) continue;
        remove.run(Number(row.r)); removed++; budget--;
        const providerId = String(row.provider_turn_id), boot = String(row.boot_id);
        probes++;
        if (running.get(threadId, providerId, boot)) this.mark(threadId, providerId, boot, botId, String(row.generation_id));
      }
    }
    return this.work({ returned, probes, removed });
  }
  /** `message:` markers (design r5.1 S): none is written since r3; each prompt insert removes up to two of its own thread's. */
  private retainPrompts(db: DatabaseSync, threadId: string): SpeechRetentionWork {
    const rows = db.prepare(SPEECH_RETENTION_SQL.messageMarkers).all(threadId);
    const remove = db.prepare("DELETE FROM speech_prompts WHERE thread_id=? AND prompt_id=?");
    for (const row of rows) remove.run(threadId, String(row.prompt_id));
    return this.work({ returned: rows.length, probes: 0, removed: rows.length });
  }
  /** Adds `botId` to the identity's marker at once, in the deleting transaction, so every later read sees it exactly when the row is gone; a
   *  rollback of any enclosing frame takes it back with the row (design r5.2 Δ1). A set only grows while it lives. */
  private mark(threadId: string, providerId: string, boot: string, botId: string, generationId: string): void {
    if (boot !== this.bootId) return;
    let thread = this.ambiguous.get(threadId);
    if (!thread) { thread = new Map(); this.ambiguous.set(threadId, thread); }
    const key = `${providerId}\u0000${boot}`;
    let bots = thread.get(key);
    if (!bots) { bots = new Set(); thread.set(key, bots); }
    // a membership is recorded with the row it stands for until a commit with the connection idle shows that row durably gone
    // (settleDeferredMarkers); a membership already settled needs no record, one still pending gets this row as a further reason
    const id = `${threadId}\u0001${key}\u0001${botId}`;
    const fresh = !bots.has(botId) && !bots.has(SPEECH_MARKER_ANY_BOT);
    if (fresh || this.pending.has(id)) { this.unconfirmed.push({ threadId, key, botId, generationId }); this.pending.add(id); }
    if (!fresh) return;
    // past the cap the entry answers "ambiguous" for every bot: at most 1 + SPEECH_MARKER_BOTS memberships per entry whatever the bot-id churn,
    // and only ever more refusals than the full ledger, never an attribution it would not make (design r5.5 Δ11)
    const before = bots.size >= SPEECH_MARKER_BOTS ? new Set(bots) : undefined;
    if (before) { bots.clear(); bots.add(SPEECH_MARKER_ANY_BOT); } else bots.add(botId);
    const record = this.unconfirmed.at(-1);
    onRollback(() => {
      // the row is back with the frame's rollback: its record is moot
      const at = record ? this.unconfirmed.lastIndexOf(record) : -1;
      if (at >= 0) this.unconfirmed.splice(at, 1);
      // `pending` holds the ids that have a record: the rollback took the last one, so the id goes with it
      if (!this.unconfirmed.some((r) => r.threadId === threadId && r.key === key && r.botId === botId)) this.pending.delete(id);
      const held = this.ambiguous.get(threadId), set = held?.get(key);
      if (!held || !set) return;
      if (before) { set.clear(); for (const bot of before) set.add(bot); } else set.delete(botId);
      if (!set.size) held.delete(key);
      if (!held.size) this.ambiguous.delete(threadId);
    });
  }
  /** Settles pending marker work (see `unconfirmed`) once a speech transaction commits with the connection idle, so every row read is
   *  committed: a membership all of whose recorded rows are back (a raw transaction rolled back after its frame released) is dropped, then
   *  each touched thread is swept. In a framed commit this is one point read per membership just added; after raw transactions it is the
   *  backlog they left, once. */
  private settleDeferredMarkers(): void {
    if ((!this.unconfirmed.length && !this.sweepLater.size) || this.db().isTransaction) return;
    const threads = new Set(this.sweepLater);
    this.sweepLater.clear();
    const records = this.unconfirmed.splice(0);
    this.pending.clear();
    try {
      const exists = this.db().prepare("SELECT 1 FROM speech_generations WHERE generation_id=?");
      const back = new Map<string, boolean>();
      for (const item of records) {
        const id = `${item.threadId}\u0001${item.key}\u0001${item.botId}`;
        back.set(id, (back.get(id) ?? true) && Boolean(exists.get(item.generationId)));
        threads.add(item.threadId);
      }
      for (const item of records) {
        const id = `${item.threadId}\u0001${item.key}\u0001${item.botId}`;
        if (!back.get(id)) continue;
        back.delete(id);
        const held = this.ambiguous.get(item.threadId), set = held?.get(item.key);
        // a collapsed "any bot" entry stays: it can only refuse more than the full ledger (design r5.5 Δ11)
        if (!held || !set || set.has(SPEECH_MARKER_ANY_BOT)) continue;
        set.delete(item.botId);
        if (!set.size) held.delete(item.key);
        if (!held.size) this.ambiguous.delete(item.threadId);
      }
    } catch { /* a marker kept longer only keeps a lookup ambiguous */ }
    for (const id of threads) this.sweepThread(id);
  }
  /** After the transition commits, drops the thread's markers whose identity no longer has a running row: read from committed rows, so a marker
   *  a later generation of the same outer transaction still needs survives (design r5.1 G). If the connection is still inside a raw
   *  transaction at that point, its rows are not committed and an ended row could come back: the sweep waits (Grok r5.5 rider). */
  private sweepMarkers(threadId: string): void {
    afterCommit(() => {
      if (this.db().isTransaction) { if (this.ambiguous.has(threadId)) this.sweepLater.add(threadId); return; }
      this.sweepThread(threadId);
    });
  }
  private sweepThread(threadId: string): void {
    const thread = this.ambiguous.get(threadId);
    if (!thread) return;
    try {
      const running = this.db().prepare(SPEECH_RETENTION_SQL.runningIdentity);
      for (const key of [...thread.keys()]) {
        const [providerId, boot] = key.split("\u0000") as [string, string];
        if (!running.get(threadId, providerId, boot)) thread.delete(key);
      }
    } catch { /* a marker kept longer only keeps a lookup ambiguous */ }
    if (!thread.size) this.ambiguous.delete(threadId);
  }
  /** Sizes of the auxiliary marker sets, for the bound tests. */
  auxiliaryMarkerSets(): { unconfirmed: number; pending: number; sweepLater: number } {
    return { unconfirmed: this.unconfirmed.length, pending: this.pending.size, sweepLater: this.sweepLater.size };
  }
  /** Markers held now, for the bound tests. */
  ambiguityMarkers(): { entries: number; memberships: number } {
    let entries = 0, memberships = 0;
    for (const thread of this.ambiguous.values()) for (const bots of thread.values()) { entries++; memberships += bots.size; }
    return { entries, memberships };
  }
  private abortWhere(predicate: (job: { threadId: string; sessionId: string }) => boolean): void {
    for (const [id, job] of this.aborters) if (predicate(job)) { this.aborters.delete(id); try { job.abort(); } catch { /* cancellation remains irreversible */ } }
  }
}
