/** Durable speech authority. All transitions are synchronous, transactional and metadata only. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterCommit, scopedTx } from "../tx-scope.ts";

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
    const nested = db.isTransaction, point = `speech_${++savepoint}`;
    db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
    try { const result = work(db); db.exec(nested ? `RELEASE ${point}` : "COMMIT"); return result; }
    catch (error) { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); throw error; }
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
  private readonly db: () => DatabaseSync;
  private readonly tx: Transaction;
  private readonly now: () => number;
  private readonly emit: (event: SpeechEvent) => void;
  constructor(options: { db(): DatabaseSync; transaction: Transaction; now?: () => number; emit?: (event: SpeechEvent) => void }) {
    this.db = options.db;
    this.tx = work => options.transaction(db => {
      const result = work(db);
      // A command's permanent duplicate result follows cancellation and boot recovery too.
      db.exec(`UPDATE speech_commands SET
        status=(SELECT CASE state WHEN 'complete' THEN 200 WHEN 'cancelled' THEN 204 ELSE 502 END FROM speech_attempts a WHERE a.attempt_id=speech_commands.attempt_id),
        outcome=(SELECT outcome FROM speech_attempts a WHERE a.attempt_id=speech_commands.attempt_id)
        WHERE outcome='pending' AND attempt_id IN (SELECT attempt_id FROM speech_attempts WHERE state NOT IN ('reserved','streaming'))`);
      return result;
    });
    this.now = options.now ?? Date.now; this.emit = options.emit ?? (() => {});
  }
  boot(): void {
    this.ready = false;
    this.tx(db => {
      const now = this.clock(db);
      db.prepare("UPDATE speech_accounts SET hold_until=max(hold_until,?) WHERE account_scope_id IN (SELECT account_scope_id FROM speech_attempts WHERE state IN ('reserved','streaming'))").run(now + 600_000);
      db.exec("UPDATE speech_attempts SET state='interrupted',outcome='boot' WHERE state IN ('reserved','streaming'); UPDATE speech_generations SET state='invalid' WHERE state='running'; UPDATE speech_sessions SET state='closed';");
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
        db.exec("UPDATE speech_generations SET state='invalid'; UPDATE speech_sessions SET state='closed'; UPDATE speech_attempts SET state='cancelled',outcome='disposed' WHERE state IN ('reserved','streaming');");
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
      this.abortWhere(() => true); this.listening.clear(); this.revoked.clear(); this.incarnation = randomUUID();
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
      if (sendId) db.prepare("INSERT OR IGNORE INTO speech_prompts VALUES(?,?)").run(threadId, `send:${sendId}`);
      return revision;
    });
  }
  /** Must run inside the transaction accepting the owner's prompt. */
  prompt(threadId: string, promptId?: string): number {
    if (!promptId) return this.invalidate(threadId, "prompt");
    return this.tx(db => {
      this.check(threadId);
      if (!db.prepare("INSERT OR IGNORE INTO speech_prompts VALUES(?,?)").run(threadId, promptId).changes) return this.revision(threadId);
      return this.invalidate(threadId, "prompt");
    });
  }
  invalidate(threadId: string, reason: "prompt" | "stop" = "stop"): number {
    this.check(threadId);
    try {
      return this.tx(db => {
        db.prepare("INSERT INTO speech_threads(thread_id,revision) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(threadId);
        const revision = Number(db.prepare("SELECT revision FROM speech_threads WHERE thread_id=?").get(threadId)!.revision);
        db.prepare("UPDATE speech_generations SET state='invalid' WHERE thread_id=?").run(threadId);
        db.prepare("UPDATE speech_attempts SET state='cancelled',outcome='invalidated' WHERE thread_id=? AND state IN ('reserved','streaming')").run(threadId);
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
    for (const threadId of [...this.quarantined]) { try { this.recover(threadId); } catch { /* keep authority closed until the durable recovery commits */ } }
  }
  recover(threadId: string): void {
    if (!this.quarantined.has(threadId)) return;
    this.tx(db => {
      db.prepare("INSERT INTO speech_threads(thread_id,revision) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(threadId);
      db.prepare("UPDATE speech_generations SET state='invalid' WHERE thread_id=?").run(threadId);
      db.prepare("UPDATE speech_attempts SET state='cancelled',outcome='recovery' WHERE thread_id=? AND state IN ('reserved','streaming')").run(threadId);
      db.prepare("UPDATE speech_sessions SET state='closed' WHERE thread_id=?").run(threadId);
    });
    this.quarantined.delete(threadId);
    this.emit({ kind: "speech.invalidate", threadId, revision: this.revision(threadId), reason: "recovery", bootId: this.bootId });
  }
  begin(threadId: string, botId: string, generationId: string, promptId: string): void {
    this.check(threadId);
    this.tx(db => {
      db.prepare("INSERT OR IGNORE INTO speech_threads(thread_id,revision) VALUES(?,0)").run(threadId);
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
    const rows = this.db().prepare("SELECT * FROM speech_generations WHERE thread_id=? AND provider_turn_id=? AND boot_id=?").all(threadId, providerTurnId, this.bootId) as Generation[];
    const candidates = rows.filter(row => !botId || row.bot_id === botId);
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  invalidateGeneration(threadId: string, generationId: string): void {
    this.check(threadId);
    try { this.tx(db => { db.prepare("UPDATE speech_generations SET state='invalid' WHERE generation_id=? AND thread_id=? AND state='running'").run(generationId, threadId); }); }
    catch { this.quarantine(threadId); throw new SpeechRefusal(503, "durable_stop_failed"); }
  }
  /** Called inside the transaction marking the stored terminal message. Metadata patches never call this. */
  settle(threadId: string, providerTurnId: string, messageId: string | undefined, completed: boolean, botId?: string): SpeechEvent | undefined {
    this.check(threadId);
    return this.tx(db => {
      const generation = this.generation(threadId, providerTurnId, botId);
      if (!generation || generation.state !== "running") return;
      if (!completed || !messageId || generation.revision !== this.revision(threadId)) {
        db.prepare("UPDATE speech_generations SET state='invalid' WHERE generation_id=?").run(generation.generation_id); return;
      }
      const settledAt = this.clock(db), settlementId = randomUUID();
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
    this.tx(db => {
      db.prepare("INSERT OR IGNORE INTO speech_threads(thread_id,revision) VALUES(?,0)").run(threadId);
      db.prepare("UPDATE speech_sessions SET state='closed' WHERE connection_id=?").run(connection.id);
      for (const id of replaced) db.prepare("UPDATE speech_attempts SET state='cancelled',outcome='session_replaced' WHERE session_id=? AND state IN ('reserved','streaming')").run(id);
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
      db.prepare("UPDATE speech_sessions SET state='closed' WHERE connection_id=?").run(connectionId);
      for (const id of ids) db.prepare("UPDATE speech_attempts SET state='cancelled',outcome='disconnected' WHERE session_id=? AND state IN ('reserved','streaming')").run(id);
    }); } finally { for (const id of ids) { this.listening.delete(id); this.revoked.delete(id); } }
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
      if (replaced) db.prepare("UPDATE speech_attempts SET state='cancelled',outcome='replaced' WHERE attempt_id=? AND state IN ('reserved','streaming')").run(replaced);
      const attemptId = randomUUID();
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
      if (changed) db.prepare("UPDATE speech_commands SET status=?,outcome=? WHERE attempt_id=?").run(outcome === "complete" ? 200 : outcome === "budget" ? 402 : outcome === "cancelled" ? 204 : 502, outcome, attempt.attemptId);
      db.prepare("UPDATE speech_sessions SET active_attempt=NULL WHERE session_id=? AND active_attempt=?").run(attempt.sessionId, attempt.attemptId);
    }); } finally { this.aborters.delete(attempt.attemptId); }
  }
  cancel(input: Omit<SpeechReservation, "messageId">): void {
    try { this.tx(db => {
      const session = this.requireSession(input);
      if (!Number.isSafeInteger(input.commandSequence) || input.commandSequence <= session.last_sequence) throw new SpeechRefusal(409, "stale_command");
      db.prepare("UPDATE speech_sessions SET last_sequence=?,active_attempt=NULL WHERE session_id=?").run(input.commandSequence, input.sessionId);
      db.prepare("INSERT INTO speech_commands VALUES(?,?,204,'cancelled',NULL)").run(input.sessionId, input.commandSequence);
      db.prepare("UPDATE speech_attempts SET state='cancelled',outcome='cancelled' WHERE session_id=? AND state IN ('reserved','streaming')").run(input.sessionId);
      afterCommit(() => this.abortWhere(job => job.sessionId === input.sessionId));
    }); } catch (error) {
      if (error instanceof SpeechRefusal) throw error;
      this.quarantine(input.threadId); throw new SpeechRefusal(503, "durable_stop_failed");
    }
  }
  private abortWhere(predicate: (job: { threadId: string; sessionId: string }) => boolean): void {
    for (const [id, job] of this.aborters) if (predicate(job)) { this.aborters.delete(id); try { job.abort(); } catch { /* cancellation remains irreversible */ } }
  }
}
