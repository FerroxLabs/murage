import { beginWrite, endWrite, undoWrite } from "./write-tx.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HumanPrincipal } from "./human-principals.ts";
import { OWN_WRITE_COPY, type OwnWriteState, type OwnWriteCardData } from "../shared/own-write-card.ts";
import { redactSecrets, redactSecretsForSink } from "./redact.ts";

export const OWN_WRITE_TTL_MS = 24 * 60 * 60_000;
export const OWN_WRITE_APPLY_MS = 30_000;
export const OWN_WRITE_TOOLS = new Set([
  "update_bot", "create_bot", "memory_save", "memory_propose_correction",
  "phone_calendar_read", "phone_calendar_find_free_time", "phone_calendar_add", "phone_calendar_change",
  "phone_reminders_read", "phone_reminders_add", "phone_reminders_complete", "phone_contacts_search", "phone_contacts_get",
  "phone_location_get", "phone_alarm_set", "phone_timer_set", "phone_text_compose", "phone_call_dial",
]);
export function initializeOwnWriteHolds(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS own_write_holds (
    hold_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, generation TEXT NOT NULL,
    tool TEXT NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, body_present INTEGER NOT NULL DEFAULT 1,
    frozen TEXT NOT NULL, dedupe_key TEXT NOT NULL, ref TEXT NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL, restore_token TEXT, receipt TEXT, result TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deadline INTEGER,
    card_projected_revision INTEGER NOT NULL DEFAULT 0, outcome_delivered INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS own_write_holds_thread ON own_write_holds(thread_id,state);
    CREATE INDEX IF NOT EXISTS own_write_holds_due ON own_write_holds(state,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS own_write_holds_ref ON own_write_holds(bot_id,ref);
    CREATE UNIQUE INDEX IF NOT EXISTS own_write_holds_open ON own_write_holds(dedupe_key) WHERE state='waiting' AND body_present=1;`);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get()) {
    const valid = `EXISTS(SELECT 1 FROM own_write_holds H WHERE H.hold_id=json_extract(NEW.json,'$.card.writer.holdId')
      AND NEW.id='own-writer-card-'||H.hold_id AND NEW.thread_id=H.thread_id AND NEW.kind='options'
      AND json_extract(NEW.json,'$.card.requestId')='own-'||H.hold_id AND json_extract(NEW.json,'$.card.writer.version')=1
      AND json_extract(NEW.json,'$.card.writer.tool')=H.tool AND json_extract(NEW.json,'$.card.writer.bodyHash')=H.body_hash
      AND json_extract(NEW.json,'$.card.writer.ref')=H.ref AND json_extract(NEW.json,'$.card.writer.state')=H.state
      AND json_extract(NEW.json,'$.card.writer.stateRevision')=H.revision
      AND (H.state<>'waiting' OR (json_extract(NEW.json,'$.card.answered') IS NULL AND COALESCE(json_extract(NEW.json,'$.card.dismissed'),0)=0)))`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS own_writer_card_insert BEFORE INSERT ON messages WHEN json_valid(NEW.json) AND json_extract(NEW.json,'$.card.kind')='own-write' BEGIN
      SELECT RAISE(ABORT,'writer-card-without-hold') WHERE NOT (${valid}); END;
      CREATE TRIGGER IF NOT EXISTS own_writer_card_update BEFORE UPDATE ON messages WHEN (json_valid(NEW.json) AND json_extract(NEW.json,'$.card.kind')='own-write') OR (json_valid(OLD.json) AND json_extract(OLD.json,'$.card.kind')='own-write') BEGIN
      SELECT RAISE(ABORT,'writer-card-action-changed') WHERE NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id OR NOT (${valid}) OR json_extract(NEW.json,'$.card.writer.stateRevision')<json_extract(OLD.json,'$.card.writer.stateRevision'); END;`);
  }

}
export interface FrozenOwnWrite {
  principal: HumanPrincipal; writeKeys: string[]; targetName?: string;
  phone?: { provider: string; origin: "desktop" | "companion"; authorityHeld: true };
  memory?: { id: string; version: number };
  memoryOrigin?: { outside: boolean; email: boolean };
  autoCeiling?: boolean;
}
export interface OwnWriteHold {
  id: string; botId: string; threadId: string; generation: string; tool: string;
  body: Record<string, unknown>; bodyHash: string; bodyPresent: boolean; frozen: FrozenOwnWrite;
  ref: string; state: OwnWriteState; revision: number; restoreToken: string | null;
  createdAt: number; updatedAt: number; deadline: number | null; receipt: string | null; result: string | null;
}
export type OwnWriteCompletion = { status: number; body: unknown };
export type PreparedOwnWrite = { cancel?(): void; run(beforeEffect: () => void): Promise<OwnWriteCompletion> | OwnWriteCompletion };
export class OwnWriteRefusal extends Error { readonly beforeEffect = true; }
export interface OwnWriteHost {
  db(): DatabaseSync; atomic?<T>(operation: () => T): T; now?: () => number; restoreToken(): string | null;
  valid(row: OwnWriteHold): boolean; stamp(keys: readonly string[]): boolean;
  prepare(row: OwnWriteHold): Promise<PreparedOwnWrite> | PreparedOwnWrite;
  project(row: OwnWriteHold): void; deliver?(row: OwnWriteHold): void;
}
const terminal = (s: OwnWriteState) => !["waiting", "approved", "applying"].includes(s);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const decode = (raw: Record<string, unknown>): OwnWriteHold => ({
  id: String(raw.hold_id), botId: String(raw.bot_id), threadId: String(raw.thread_id), generation: String(raw.generation), tool: String(raw.tool),
  body: JSON.parse(String(raw.body || "{}")), bodyHash: String(raw.body_hash), bodyPresent: raw.body_present === 1,
  frozen: JSON.parse(String(raw.frozen)), ref: String(raw.ref), state: raw.state as OwnWriteState, revision: Number(raw.revision),
  restoreToken: raw.restore_token === null ? null : String(raw.restore_token), receipt: raw.receipt === null ? null : String(raw.receipt),
  result: raw.result === null ? null : String(raw.result), createdAt: Number(raw.created_at), updatedAt: Number(raw.updated_at), deadline: raw.deadline === null ? null : Number(raw.deadline),
});
export function ownWriteCard(row: OwnWriteHold): OwnWriteCardData {
  const detail = Object.fromEntries(Object.entries(row.body).filter(([key]) => !['self','fromBotId','fromThreadId','botId','targetBotId','threadId','depth','revision','organizationRevision','action'].includes(key)));
  if (row.frozen.targetName) detail.target = row.frozen.targetName;
  return { version: 1, holdId: row.id, stateRevision: row.revision, state: row.state, tool: row.tool,
    bodyHash: row.bodyHash, ref: row.ref, detail: JSON.stringify(redactSecrets(detail), null, 2), ...(!row.bodyPresent ? { restored: true } : {}) };
}
export function sanitizeOwnWriteHoldsForRestore(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='own_write_holds'").get()) return;
  // Release the partial unique key before changing any states. Nothing restored is executable.
  db.exec("UPDATE own_write_holds SET body='{}',body_present=0,receipt=NULL,restore_token=NULL,deadline=NULL,state=CASE WHEN state='applying' THEN 'unknown' ELSE 'declined' END,revision=revision+1,card_projected_revision=0,outcome_delivered=0 WHERE state IN ('waiting','approved','applying')");
  // Keep retained cards bound to their now inert service rows before the
  // generic restore sweep touches their terminal fields. No restored Allow
  // receipt or executable body survives this projection.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get()) {
    db.exec(`UPDATE messages SET json=json_set(json,
      '$.card.writer.state',(SELECT state FROM own_write_holds WHERE hold_id=json_extract(messages.json,'$.card.writer.holdId')),
      '$.card.writer.stateRevision',(SELECT revision FROM own_write_holds WHERE hold_id=json_extract(messages.json,'$.card.writer.holdId')),
      '$.card.writer.restored',json('true'),
      '$.card.answered',(SELECT state FROM own_write_holds WHERE hold_id=json_extract(messages.json,'$.card.writer.holdId')))
      WHERE json_valid(json) AND json_extract(json,'$.card.kind')='own-write'
      AND EXISTS(SELECT 1 FROM own_write_holds H WHERE H.hold_id=json_extract(messages.json,'$.card.writer.holdId')
        AND H.body_present=0 AND messages.id='own-writer-card-'||H.hold_id AND messages.thread_id=H.thread_id)`);
  }
}
export class OwnWriteHolds {
  private readonly host: OwnWriteHost;
  private readonly flights = new Map<string, Promise<OwnWriteHold>>();
  private readonly waits = new Map<string, Set<(value: OwnWriteCompletion) => void>>();
  private serial = 0;
  constructor(host: OwnWriteHost) { this.host = host; initializeOwnWriteHolds(host.db()); }
  private now() { return (this.host.now ?? Date.now)(); }
  private atomic<T>(f: () => T): T {
    if (this.host.atomic) return this.host.atomic(f);
    const db = this.host.db(), name = `own_write_${++this.serial}`;
    beginWrite(db, name);
    try { const result = f(); endWrite(db, name); return result; }
    catch (error) { undoWrite(db, name); throw error; }
  }
  get(id: string): OwnWriteHold | null {
    const row = this.host.db().prepare("SELECT * FROM own_write_holds WHERE hold_id=?").get(id);
    return row ? decode(row) : null;
  }
  private transition(row: OwnWriteHold, state: OwnWriteState, extra: { receipt?: string; restoreToken?: string | null; deadline?: number | null; result?: string } = {}): OwnWriteHold | null {
    const changed = this.host.db().prepare("UPDATE own_write_holds SET state=?,revision=revision+1,updated_at=?,receipt=COALESCE(?,receipt),restore_token=?,deadline=?,result=COALESCE(?,result) WHERE hold_id=? AND state=? AND revision=?")
      .run(state, this.now(), extra.receipt ?? null, extra.restoreToken ?? row.restoreToken, extra.deadline ?? null, extra.result ?? null, row.id, row.state, row.revision);
    return Number(changed.changes) ? this.get(row.id) : null;
  }
  create(input: { botId: string; threadId: string; generation: string; tool: string; body: Record<string, unknown>; frozen: FrozenOwnWrite; active(): boolean }): OwnWriteHold {
    if (!OWN_WRITE_TOOLS.has(input.tool)) throw new OwnWriteRefusal("This change needs the owner to make it directly.");
    const body = JSON.stringify(input.body);
    if (Buffer.byteLength(body) > 65_536) throw new OwnWriteRefusal("This change is too large to review. Ask for a smaller change.");
    const bodyHash = hash(body), dedupe = hash(JSON.stringify([input.threadId, input.tool, bodyHash]));
    return this.atomic(() => {
      if (!input.active()) throw new OwnWriteRefusal("This request is no longer active.");
      const duplicate = this.host.db().prepare("SELECT * FROM own_write_holds WHERE dedupe_key=? AND state='waiting' AND body_present=1").get(dedupe);
      if (duplicate) return decode(duplicate);
      const count = this.host.db().prepare("SELECT count(*) n FROM own_write_holds WHERE thread_id=? AND state='waiting' AND body_present=1").get(input.threadId);
      if (Number(count?.n) >= 8) throw new OwnWriteRefusal("Several changes are waiting for you. Review them before asking for another.");
      const id = randomUUID(); let suffix = 0, ref: string;
      do { ref = `W-${hash(`own-write-ref:${id}:${suffix++}`).slice(0, 6).toUpperCase()}`; }
      while (this.host.db().prepare("SELECT 1 FROM own_write_holds WHERE bot_id=? AND ref=?").get(input.botId, ref));
      const now = this.now();
      this.host.db().prepare("INSERT INTO own_write_holds(hold_id,bot_id,thread_id,generation,tool,body,body_hash,frozen,dedupe_key,ref,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting',1,?,?)")
        .run(id, input.botId, input.threadId, input.generation, input.tool, body, bodyHash, JSON.stringify(input.frozen), dedupe, ref, now, now);
      const row = this.get(id)!;
      this.host.project(row); // Same messages.db savepoint as the hold insertion.
      this.host.db().prepare("UPDATE own_write_holds SET card_projected_revision=? WHERE hold_id=? AND revision=?").run(row.revision, id, row.revision);
      return row;
    });
  }
  async answer(id: string, revision: number, behavior: "allow" | "deny", receipt: { device: string; at: number }, validCard: () => boolean): Promise<{ status: number; row: OwnWriteHold | null }> {
    let row = this.get(id);
    if (!row || row.state !== "waiting" || row.revision !== revision) return { status: 409, row };
    if (!validCard()) { row = this.transition(row, "declined"); if (row) this.project(row); return { status: 409, row }; }
    if (this.now() - row.createdAt >= OWN_WRITE_TTL_MS) { row = this.transition(row, "expired"); if (row) this.project(row); return { status: 409, row }; }
    if (behavior === "allow" && (!row.bodyPresent || !this.host.valid(row))) return { status: 409, row };
    row = this.transition(row, behavior === "deny" ? "declined" : "approved", { receipt: JSON.stringify(receipt), restoreToken: this.host.restoreToken(), deadline: behavior === "allow" ? this.now() + OWN_WRITE_APPLY_MS : null });
    if (!row) return { status: 409, row: this.get(id) };
    // The execution continuation owns its promise; a projection exception cannot abandon approval.
    if (behavior === "allow") { const applying = this.apply(row.id); this.project(row); await applying; }
    else this.project(row);
    return { status: 200, row: this.get(id) };
  }
  private project(row: OwnWriteHold, completion?: OwnWriteCompletion): void {
    try {
      this.host.project(row);
      this.host.db().prepare("UPDATE own_write_holds SET card_projected_revision=? WHERE hold_id=? AND revision=?").run(row.revision, row.id, row.revision);
    } catch { /* Durable projection debt is retried by recover/tick. */ }
    if (!terminal(row.state)) return;
    try {
      this.host.deliver?.(row);
      this.host.db().prepare("UPDATE own_write_holds SET outcome_delivered=1 WHERE hold_id=?").run(row.id);
    } catch { /* A stable message id makes a post-commit retry idempotent. */ }
    const result = completion ?? { status: row.state === "applied" ? 200 : 403, body: { error: row.state === "unknown" ? OWN_WRITE_COPY.unknown : "This change was not allowed.", writer: ownWriteCard(row) } };
    for (const wake of this.waits.get(row.id) ?? []) wake(result);
    this.waits.delete(row.id);
  }
  apply(id: string): Promise<OwnWriteHold> {
    const pending = this.flights.get(id); if (pending) return pending;
    const work = this.applyOnce(id).finally(() => this.flights.delete(id)); this.flights.set(id, work); return work;
  }
  private async applyOnce(id: string): Promise<OwnWriteHold> {
    let row = this.get(id); if (!row) throw new Error("writer_request_missing");
    if (row.state !== "approved") return row;
    if (!row.bodyPresent || !row.receipt || !this.host.valid(row) || row.deadline === null || this.now() >= row.deadline || row.restoreToken !== this.host.restoreToken() || hash(JSON.stringify(row.body)) !== row.bodyHash) {
      row = this.transition(row, "declined") ?? this.get(id)!; this.project(row); return row;
    }
    let prepared: PreparedOwnWrite;
    try { prepared = await this.host.prepare(row); }
    catch (error) { row = this.transition(row, "declined", { result: redactSecretsForSink(error instanceof OwnWriteRefusal ? error.message : "This change is unavailable.") }) ?? this.get(id)!; this.project(row); return row; }
    // Recheck after preparation, then claim exactly once with a NULL-safe restore fence.
    row = this.get(id)!;
    if (row.state !== "approved") return row;
    if (!row.bodyPresent || hash(JSON.stringify(row.body)) !== row.bodyHash || !this.host.valid(row) || row.restoreToken !== this.host.restoreToken() || this.now() >= row.deadline!) { row = this.transition(row, "declined") ?? this.get(id)!; this.project(row); return row; }
    const changed = this.host.db().prepare("UPDATE own_write_holds SET state='applying',revision=revision+1,updated_at=? WHERE hold_id=? AND state='approved' AND revision=? AND body_present=1 AND restore_token IS ?")
      .run(this.now(), id, row.revision, this.host.restoreToken());
    if (!Number(changed.changes)) return this.get(id)!;
    row = this.get(id)!; let dispatched = false, invoked = false;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remainingMs = Math.max(1, row.deadline! - this.now());
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { prepared.cancel?.(); reject(new OwnWriteRefusal(OWN_WRITE_COPY.unknown)); }, remainingMs); timer.unref?.(); });
      const operation = Promise.resolve().then(() => { invoked = true; return prepared.run(() => {
        if (dispatched) return;
        const live = this.get(id);
        if (!live || !live.bodyPresent || hash(JSON.stringify(live.body)) !== live.bodyHash || live.state !== "applying" || live.deadline === null || this.now() >= live.deadline || !this.host.valid(live) || live.restoreToken !== this.host.restoreToken()) throw new OwnWriteRefusal("This change is no longer available.");
        if (!this.host.stamp(live.frozen.writeKeys)) throw new OwnWriteRefusal("Murage could not record this change. Check available disk space.");
        dispatched = true;
      }); });
      let completion: OwnWriteCompletion;
      try { completion = await Promise.race([operation, deadline]); } finally { if (timer) clearTimeout(timer); }
      if (completion.status < 200 || completion.status >= 300) throw new Error("This change could not be completed. Check its result before trying again.");
      if (!dispatched) throw new OwnWriteRefusal("The operation did not start.");
      const current = this.get(id)!;
      if (current.state !== "applying") return current;
      row = this.transition(current, "applied", { result: "Change made." }) ?? this.get(id)!;
      this.project(row, completion); return row;
    } catch (error) {
      const current = this.get(id)!;
      if (current.state !== "applying") return current;
      row = this.transition(current, dispatched || invoked && !(error instanceof OwnWriteRefusal) ? "unknown" : "declined", { result: redactSecretsForSink(error instanceof OwnWriteRefusal ? error.message : "Check the result before trying again.").slice(0, 8192) }) ?? this.get(id)!;
      this.project(row); return row;
    }
  }
  wait(id: string, signal?: AbortSignal): Promise<OwnWriteCompletion> {
    const row = this.get(id); if (!row) return Promise.resolve({ status: 404, body: { error: "This request is unavailable." } });
    if (terminal(row.state)) return Promise.resolve({ status: row.state === "applied" ? 200 : 403, body: { state: row.state, writer: ownWriteCard(row) } });
    return new Promise(resolve => {
      const finish = (value: OwnWriteCompletion) => { signal?.removeEventListener("abort", abort); this.waits.get(id)?.delete(finish); resolve(value); };
      const abort = () => finish({ status: 409, body: { error: "This request is no longer connected. Review its card in Murage." } });
      if (signal?.aborted) { abort(); return; }
      const set = this.waits.get(id) ?? new Set(); set.add(finish); this.waits.set(id, set);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  stop(threadId: string, generation?: string): void {
    const rows = this.host.db().prepare("SELECT * FROM own_write_holds WHERE thread_id=? AND state='waiting'" + (generation ? " AND generation=?" : "")).all(...(generation ? [threadId, generation] : [threadId]));
    for (const raw of rows) { const row = this.transition(decode(raw), "declined"); if (row) this.project(row); }
  }
  async recover(): Promise<void> {
    // Recovery finishes before listen. A prior-process approval never dispatches
    // at boot; applying work is uncertain even when no effect can be observed.
    this.atomic(() => {
      this.host.db().prepare("UPDATE own_write_holds SET state='unknown',result='restart',receipt=NULL,deadline=NULL,revision=revision+1,updated_at=? WHERE state='applying'").run(this.now());
      this.host.db().prepare("UPDATE own_write_holds SET state='declined',result='restart_before_apply',receipt=NULL,deadline=NULL,revision=revision+1,updated_at=? WHERE state='approved'").run(this.now());
    });
    await this.tick();
  }
  async tick(): Promise<void> {
    const due = this.host.db().prepare("SELECT * FROM own_write_holds WHERE state IN ('waiting','approved') OR card_projected_revision<revision OR (state NOT IN ('waiting','approved','applying') AND outcome_delivered=0)").all();
    for (const raw of due) {
      let row = decode(raw);
      if (row.state === "waiting" && this.now() - row.createdAt >= OWN_WRITE_TTL_MS) row = this.transition(row, "expired") ?? this.get(row.id)!;
      if (row.state === "approved") await this.apply(row.id);
      else this.project(row);
    }
    this.host.db().prepare("UPDATE own_write_holds SET body='{}',body_present=0,receipt=NULL WHERE state NOT IN ('waiting','approved','applying') AND updated_at<?").run(this.now() - 30 * 86_400_000);
    this.host.db().prepare("DELETE FROM own_write_holds WHERE state NOT IN ('waiting','approved','applying') AND outcome_delivered=1 AND updated_at<?").run(this.now() - 180 * 86_400_000);
  }
}

/** Dedicated stored-card authority. Display strings never authorize the frozen operation. */
export function ownWriteCardAuthorized(db: DatabaseSync, threadId: string, message: any): boolean {
  const writer = message?.card?.writer;
  if (!writer || writer.version !== 1 || typeof writer.holdId !== "string" || message.id !== `own-writer-card-${writer.holdId}` || message.card.requestId !== `own-${writer.holdId}`) return false;
  try {
    const raw = db.prepare("SELECT thread_id,tool,body_hash,ref,state,revision FROM own_write_holds WHERE hold_id=?").get(writer.holdId);
    return !!raw && raw.thread_id === threadId && raw.tool === writer.tool && raw.body_hash === writer.bodyHash && raw.ref === writer.ref && raw.state === writer.state && raw.revision === writer.stateRevision
      && !(writer.state === "waiting" && (message.card.answered || message.card.dismissed));
  } catch { return false; }
}
export function sameOwnWriteCard(before: any, after: any): boolean {
  const a = before?.card?.writer, b = after?.card?.writer;
  return !!a && !!b && before.id === after.id && before.kind === after.kind && before.card.kind === "own-write" && after.card.kind === "own-write"
    && before.card.requestId === after.card.requestId && a.holdId === b.holdId && a.tool === b.tool && a.bodyHash === b.bodyHash && a.ref === b.ref
    && b.stateRevision >= a.stateRevision && !(terminal(a.state) && !terminal(b.state));
}
