// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2), phase 2: the state machine of 5.3 and 5.4 (T1 to T9 and T7b), the owner
// cancel of 5.6, the server-decided sessions of 5.7, the owed admissions and their drain (4.1) and the boot reconcile of
// 5.8. Policy (decide(), 4.2) is phase 3: a transition here applies a Decision it is handed, guarded by state and gen.
// Every transition is ONE transaction (5.2): a guarded UPDATE, and only when one row changed, the card, the session and
// the push rows through CallEffects, which write inside the same transaction. Zero rows changed: nothing else happens.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { CALL_PROTOCOL, type AnswerRefusal } from "../shared/bot-calls-contract.ts";
import { CALL_PRINCIPAL, inTransaction, insertCallRule } from "./bot-calls-schema.ts";

/** One constant for freshness (4.1): a fact older than this when admitted or decided is late, never a late ring. */
export const FRESH_MS = 10 * 60_000;
/** A rule admits at most this many intents in 24 h (4.1). */
export const RULE_ADMISSIONS_PER_DAY = 24;
/** The Tier B line: fenced, plain, at most 140 characters (5.10). */
export const CALL_LINE_MAX = 140;
const DAY_MS = 24 * 3600_000;
const PAGE = 100;

export type CallState = "pending" | "waiting" | "ringing" | "live" | "done";
export type CallOutcome = "answered" | "declined" | "text_instead" | "missed" | "texted" | "seen" | "dropped" | "cancelled" | "late" | "restored";
export type FactKind = "timed" | "watch.changed" | "webhook.event" | "channel.message" | "turn.ended" | "routine.failed" | "routine.needs_you" | "routine.needs_owner_now";
export type SessionEnd = "closed" | "lost" | "stopped" | "backstop" | "restore";

/** Each step of a decision and how the intent ended, for the per-intent receipt (design 3). */
export interface ReceiptStep { check: string; result: string; detail?: string }
export interface CallReceipt { steps: ReceiptStep[]; stop?: string; ended?: SessionEnd }

export interface CallIntent {
  id: string; botId: string; ruleId: string; tier: "A" | "B"; threadId: string; factKind: FactKind; factKey: string; factAt: number;
  factFields: Record<string, unknown>; line: string | null; state: CallState; gen: number; activeSlot: boolean; deadlineAt: number | null;
  rangAt: number | null; answeredOn: string | null; sessionId: string | null; seenAt: number | null; createdAt: number; endedAt: number | null;
  outcome: CallOutcome | null; receipt: CallReceipt;
}
export interface CallSession {
  id: string; callId: string; botId: string; intentId: string | null; threadId: string | null; device: string; openedAt: number;
  lastSeenAt: number; backstopAt: number; endedAt: number | null; endedBy: SessionEnd | null;
  /** The authenticated device that opened or answered it, written with the row; null only on a row from before principals. */
  principal: string | null;
}

/** How a call request was resolved on the phones (resolveCall, 5.5): answered gives `elsewhere`, the rest `dismissed`. */
export type CallResolution = "answered" | "declined" | "missed" | "stopped";
/** The writes a transition owes, made INSIDE its transaction (5.2). Phase 4 wires them to the push outbox, phase 5 to the
 * keyed cards. Each must be synchronous and must throw rather than swallow a failed write, so the transition rolls back. */
export interface CallEffects {
  /** A `call` push row per binding that rings for calls, expiring at the ring's end (T2, T4). */
  ring(intent: CallIntent, expiresAt: number): void;
  /** The ONE place a note push is made; it writes nothing in quiet hours (card only). */
  note(intent: CallIntent): void;
  /** resolveCall: drops never-attempted rows of the request and owes a resolved revision to every binding that may have rung. */
  resolve(intent: CallIntent, where: CallResolution): void;
  /** The keyed card (family `bot-call`, key = intent id), rendered from the intent's state, outcome and receipt. */
  card(intent: CallIntent): void;
  /** Every unsent call-note row of the bot's intents, whatever their state (5.6). */
  dropNotes(botId: string): void;
}
export const NO_CALL_EFFECTS: CallEffects = Object.freeze({ ring() {}, note() {}, resolve() {}, card() {}, dropNotes() {} });

type IntentRow = {
  id: string; bot_id: string; rule_id: string; tier: "A" | "B"; thread_id: string; fact_kind: FactKind; fact_key: string; fact_at: number; fact_fields: string;
  line: string | null; state: CallState; gen: number; active_slot: number | null; deadline_at: number | null; rang_at: number | null; answered_on: string | null;
  session_id: string | null; seen_at: number | null; created_at: number; ended_at: number | null; outcome: CallOutcome | null; receipt: string;
};
const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
function parseObject(text: string): Record<string, unknown> | null {
  try { const parsed = JSON.parse(text) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function parseReceipt(text: string): CallReceipt {
  const object = parseObject(text) ?? {};
  return { ...object, steps: Array.isArray(object.steps) ? object.steps as ReceiptStep[] : [] } as CallReceipt;
}
const toIntent = (r: IntentRow): CallIntent => ({
  id: r.id, botId: r.bot_id, ruleId: r.rule_id, tier: r.tier, threadId: r.thread_id, factKind: r.fact_kind, factKey: r.fact_key, factAt: Number(r.fact_at),
  factFields: parseObject(r.fact_fields) ?? {}, line: r.line, state: r.state, gen: Number(r.gen), activeSlot: num(r.active_slot) === 1, deadlineAt: num(r.deadline_at),
  rangAt: num(r.rang_at), answeredOn: r.answered_on, sessionId: r.session_id, seenAt: num(r.seen_at), createdAt: Number(r.created_at), endedAt: num(r.ended_at),
  outcome: r.outcome, receipt: parseReceipt(r.receipt),
});
export function getIntent(db: DatabaseSync, id: string): CallIntent | null {
  const row = db.prepare("SELECT * FROM bot_calls WHERE id=?").get(id) as IntentRow | undefined;
  return row ? toIntent(row) : null;
}
type SessionRow = { id: string; call_id: string; bot_id: string; intent_id: string | null; thread_id: string | null; device: string; opened_at: number; last_seen_at: number;
  backstop_at: number; ended_at: number | null; ended_by: SessionEnd | null; principal?: string | null };
const toSession = (r: SessionRow): CallSession => ({
  id: r.id, callId: r.call_id, botId: r.bot_id, intentId: r.intent_id, threadId: r.thread_id, device: r.device, openedAt: Number(r.opened_at),
  lastSeenAt: Number(r.last_seen_at), backstopAt: Number(r.backstop_at), endedAt: num(r.ended_at), endedBy: r.ended_by,
  principal: typeof r.principal === "string" ? r.principal : null,
});
export function getSession(db: DatabaseSync, callId: string): CallSession | null {
  const row = db.prepare("SELECT * FROM bot_call_sessions WHERE call_id=?").get(callId) as SessionRow | undefined;
  return row ? toSession(row) : null;
}
const sessionById = (db: DatabaseSync, id: string): CallSession | null => {
  const row = db.prepare("SELECT * FROM bot_call_sessions WHERE id=?").get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
};

const receiptWith = (intent: CallIntent, steps: readonly ReceiptStep[], extra: Partial<Omit<CallReceipt, "steps">> = {}): string =>
  JSON.stringify({ ...intent.receipt, ...extra, steps: [...intent.receipt.steps, ...steps] });
/** The reread after a guarded UPDATE: the row exists, it was just written in this transaction. */
const reread = (db: DatabaseSync, id: string): CallIntent => getIntent(db, id)!;

/** The Tier B line as it may be shown or spoken (5.10, F43): control characters and line breaks become spaces, at most 140 characters. */
/** Control characters, line and paragraph separators, zero-width and bidi controls. */
const LINE_FENCE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
export function fenceCallLine(line: unknown): string | null {
  if (typeof line !== "string") return null;
  const plain = line.replace(LINE_FENCE, " ").replace(/\s+/g, " ").trim();
  return plain ? [...plain].slice(0, CALL_LINE_MAX).join("") : null;
}

// ── T1: admission (4.1) ─────────────────────────────────────────────────────

export interface Admission {
  botId: string; ruleId: string; threadId: string; factKind: FactKind; factKey: string; factAt: number;
  factFields?: Record<string, unknown>; line?: string | null;
}
/** T1. INSERT OR IGNORE on UNIQUE(bot_id, fact_key): idempotent, and "1 per run" for Tier B. Nothing is written when the
 * rule is missing, another bot's, off or restore-held, or already admitted 24 intents in 24 h. Returns the new intent's id,
 * or null when nothing was written. The tier is the rule's (derived from its kind). */
export function admitIntent(db: DatabaseSync, a: Admission, now: number): string | null {
  return inTransaction(db, () => {
    const rule = db.prepare("SELECT bot_id, tier, enabled, restore_held FROM bot_call_rules WHERE id=?").get(a.ruleId) as
      { bot_id: string; tier: "A" | "B"; enabled: number; restore_held: number } | undefined;
    if (!rule || rule.bot_id !== a.botId || Number(rule.enabled) !== 1 || Number(rule.restore_held) !== 0) return null;
    const recent = Number((db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM bot_calls WHERE rule_id=? AND created_at > ? LIMIT ?)")
      .get(a.ruleId, now - DAY_MS, RULE_ADMISSIONS_PER_DAY + 1) as { n: number }).n);
    if (recent >= RULE_ADMISSIONS_PER_DAY) return null;
    const id = randomUUID();
    const changed = Number(db.prepare(`INSERT OR IGNORE INTO bot_calls (id, bot_id, rule_id, tier, thread_id, fact_kind, fact_key, fact_at, fact_fields, line, state, gen, created_at, receipt)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`).run(id, a.botId, a.ruleId, rule.tier, a.threadId, a.factKind, a.factKey, Math.trunc(a.factAt),
      JSON.stringify(a.factFields ?? {}), fenceCallLine(a.line), now, JSON.stringify({ steps: [] })).changes);
    return changed === 1 ? id : null;
  });
}

// ── decisions (applied by T2 and T4) ─────────────────────────────────────────

/** What decide() (phase 3) hands a transition. `dropped`: an invalid fact (receipt only). */
export type Decision =
  | { to: "waiting"; deadlineAt: number; steps: ReceiptStep[] }
  | { to: "ringing"; steps: ReceiptStep[] }
  | { to: "done"; outcome: "texted" | "late" | "dropped"; steps: ReceiptStep[] };
export type Applied = { applied: false } | { applied: true; intent: CallIntent };
/** A decision may be a function of the intent as read inside the committing transaction (4.2: steps 2 to 5 and 7 are
 * re-read there), so nothing it gates can change between the check and the write. */

const slotTaken = (db: DatabaseSync) => !!db.prepare("SELECT 1 AS x FROM bot_calls WHERE active_slot=1 LIMIT 1").get();
const isConstraint = (error: unknown) => /constraint/i.test(String((error as { message?: unknown })?.message ?? error));
const LIVE_CONFLICT: ReceiptStep = { check: "live", result: "on_call" };

/** The ring of T2 and T4: `ringing`, taking active_slot in the same statement (the unique index enforces one). A taken
 * slot texts. Returns null when the guard matched no row. */
function ringFrom(db: DatabaseSync, before: CallIntent, from: "pending" | "waiting", steps: readonly ReceiptStep[], fx: CallEffects, now: number):
  { rang: boolean; intent: CallIntent } | null {
  const deadline = now + CALL_PROTOCOL.ringMs;
  if (!slotTaken(db)) {
    let changed = 0;
    try {
      changed = Number(db.prepare(`UPDATE bot_calls SET state='ringing', active_slot=1, rang_at=?, deadline_at=?, receipt=? WHERE id=? AND state=? AND gen=?`)
        .run(now, deadline, receiptWith(before, steps), before.id, from, before.gen).changes);
    } catch (error) { if (!isConstraint(error)) throw error; changed = -1; }
    if (changed === 0) return null;
    if (changed === 1) {
      // outside the try: any failure of the fan-out rolls the whole transition back (F10)
      const intent = reread(db, before.id);
      fx.ring(intent, deadline);
      return { rang: true, intent };
    }
  }
  // T2 texts with the card and the note; T4's message was already sent, so its receipt only
  return endText(db, before, from, [...steps, LIVE_CONFLICT], "texted", from === "pending", fx, now);
}

/** A text exit: `done(outcome)`. With `notify`, the card and the note (T2); without, the receipt only (T4, whose message
 * card and note were already sent). */
function endText(db: DatabaseSync, before: CallIntent, from: "pending" | "waiting", steps: readonly ReceiptStep[], outcome: "texted" | "late" | "dropped",
  notify: boolean, fx: CallEffects, now: number): { rang: false; intent: CallIntent } | null {
  const changed = Number(db.prepare("UPDATE bot_calls SET state='done', outcome=?, active_slot=NULL, ended_at=?, receipt=? WHERE id=? AND state=? AND gen=?")
    .run(outcome, now, receiptWith(before, steps), before.id, from, before.gen).changes);
  if (changed !== 1) return null;
  const intent = reread(db, before.id);
  if (notify && outcome !== "dropped") { fx.card(intent); fx.note(intent); }
  return { rang: false, intent };
}

/** T2: `pending` to `waiting`, `ringing` or `done`, under the gen the decision ran with. A decision that finds the state
 * or gen changed (a Stop, a boot) is discarded (F21). */
export function applyInitial(db: DatabaseSync, id: string, gen: number, decision: Decision | ((intent: CallIntent) => Decision), fx: CallEffects, now: number): Applied {
  return inTransaction(db, (): Applied => {
    const before = getIntent(db, id);
    if (!before || before.state !== "pending" || before.gen !== gen) return { applied: false };
    const d = typeof decision === "function" ? decision(before) : decision;
    if (d.to === "ringing") { const r = ringFrom(db, before, "pending", d.steps, fx, now); return r ? { applied: true, intent: r.intent } : { applied: false }; }
    if (d.to === "waiting") {
      const changed = Number(db.prepare("UPDATE bot_calls SET state='waiting', deadline_at=?, receipt=? WHERE id=? AND state='pending' AND gen=?")
        .run(Math.trunc(d.deadlineAt), receiptWith(before, d.steps), id, gen).changes);
      if (changed !== 1) return { applied: false };
      const intent = reread(db, id);
      fx.card(intent); fx.note(intent);
      return { applied: true, intent };
    }
    const r = endText(db, before, "pending", d.steps, d.outcome, true, fx, now);
    return r ? { applied: true, intent: r.intent } : { applied: false };
  });
}

/** T4: `waiting` at its deadline to `ringing`, `done(texted)` or `done(late)`. Escalation never returns to `waiting`; the
 * text exits change the receipt only (F23, F56). */
export function applyEscalation(db: DatabaseSync, id: string, gen: number, decision: Decision | ((intent: CallIntent) => Decision), fx: CallEffects, now: number): Applied {
  return inTransaction(db, (): Applied => {
    const before = getIntent(db, id);
    if (!before || before.state !== "waiting" || before.gen !== gen) return { applied: false };
    const d = typeof decision === "function" ? decision(before) : decision;
    if (d.to === "ringing") { const r = ringFrom(db, before, "waiting", d.steps, fx, now); return r ? { applied: true, intent: r.intent } : { applied: false }; }
    // escalation never returns to waiting, and its fact was valid when admitted: both text
    const outcome = d.to === "waiting" || d.outcome === "dropped" ? "texted" : d.outcome;
    const r = endText(db, before, "waiting", d.steps, outcome, false, fx, now);
    return r ? { applied: true, intent: r.intent } : { applied: false };
  });
}

/** A new gen for a pending intent: a decision still in flight under the old one is discarded (boot, 5.8). */
export function bumpGen(db: DatabaseSync, id: string): number | null {
  const row = db.prepare("UPDATE bot_calls SET gen=gen+1 WHERE id=? AND state IN ('pending','waiting') RETURNING gen").get(id) as { gen: number } | undefined;
  return row ? Number(row.gen) : null;
}

// ── T3: seen (4.5) ──────────────────────────────────────────────────────────

/** T3: an explicit owner act on a waiting intent's card. Anything else is not seen. */
export function markSeen(db: DatabaseSync, id: string, now: number): boolean {
  return inTransaction(db, () => {
    const before = getIntent(db, id);
    if (!before || before.state !== "waiting") return false;
    return Number(db.prepare("UPDATE bot_calls SET state='done', outcome='seen', seen_at=?, ended_at=?, receipt=? WHERE id=? AND state='waiting'")
      .run(now, now, receiptWith(before, [{ check: "seen", result: "seen" }]), id).changes) === 1;
  });
}

// ── sessions (5.7) ──────────────────────────────────────────────────────────

/** Live means not ended, traffic seen in the last 60 s, and before the backstop. Nothing else. */
export function sessionLive(s: Pick<CallSession, "endedAt" | "lastSeenAt" | "backstopAt">, now: number): boolean {
  return s.endedAt === null && now - s.lastSeenAt <= CALL_PROTOCOL.silenceEndsMs && now < s.backstopAt;
}
const silentEnd = (s: Pick<CallSession, "lastSeenAt" | "backstopAt">, now: number): SessionEnd =>
  now - s.lastSeenAt > CALL_PROTOCOL.silenceEndsMs ? "lost" : "backstop";

/** A session row always carries the authenticated device that opened or answered it, in the same INSERT: no row of this build
 *  is ever without one, so the boot backfill (bot-calls-schema.ts migrateSessionPrincipals) never touches it. */
function insertSession(db: DatabaseSync, o: { botId: string; intentId: string | null; threadId: string; device: string; principal: string }, now: number): { sessionId: string; callId: string } {
  if (!CALL_PRINCIPAL.test(o.principal)) throw new Error("bot call: a session needs the authenticated device that opened it");
  const sessionId = randomUUID();
  const callId = randomUUID();
  db.prepare(`INSERT INTO bot_call_sessions (id, call_id, bot_id, intent_id, thread_id, device, opened_at, last_seen_at, backstop_at, principal) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sessionId, callId, o.botId, o.intentId, o.threadId, o.device, now, now, now + CALL_PROTOCOL.backstopMs, o.principal);
  return { sessionId, callId };
}

/** Ends one session, and in the same transaction its intent's T8 (`live` to `done(answered)`). Returns whether it ended now. */
export function endSession(db: DatabaseSync, callId: string, endedBy: SessionEnd, fx: CallEffects, now: number): { ended: boolean; intentId: string | null } {
  return inTransaction(db, () => {
    const s = getSession(db, callId);
    if (!s || s.endedAt !== null) return { ended: false, intentId: s?.intentId ?? null };
    if (Number(db.prepare("UPDATE bot_call_sessions SET ended_at=?, ended_by=? WHERE call_id=? AND ended_at IS NULL").run(now, endedBy, callId).changes) !== 1) return { ended: false, intentId: s.intentId };
    if (s.intentId) finishLive(db, s.intentId, s, endedBy, fx, now);
    return { ended: true, intentId: s.intentId };
  });
}
/** T8: the intent follows its session. The Called card reads the minutes and "The call dropped." when lost. */
function finishLive(db: DatabaseSync, intentId: string, s: CallSession, endedBy: SessionEnd, fx: CallEffects, now: number): void {
  const before = getIntent(db, intentId);
  if (!before || before.state !== "live") return;
  const changed = Number(db.prepare("UPDATE bot_calls SET state='done', outcome='answered', active_slot=NULL, ended_at=?, receipt=? WHERE id=? AND state='live'")
    .run(now, receiptWith(before, [{ check: "call", result: endedBy, detail: String(Math.max(0, Math.round((now - s.openedAt) / 60_000))) }], { ended: endedBy }), intentId).changes);
  if (changed === 1) fx.card(reread(db, intentId));
}

/** Traffic for a call (a pong, a frame, or a request carrying its call id): sets last_seen_at only while the session is
 * still live; one already silent for 60 s, or past its backstop, ends instead (a late request never revives it). */
export function touchSession(db: DatabaseSync, callId: string, fx: CallEffects, now: number): "live" | "ended" | "unknown" {
  return inTransaction(db, () => {
    const s = getSession(db, callId);
    if (!s) return "unknown";
    if (s.endedAt !== null) return "ended";
    if (!sessionLive(s, now)) { endSession(db, callId, silentEnd(s, now), fx, now); return "ended"; }
    db.prepare("UPDATE bot_call_sessions SET last_seen_at=? WHERE call_id=? AND ended_at IS NULL AND last_seen_at < ?").run(now, callId, now);
    return "live";
  });
}

/** The 10 s sweep (and every decide()): sessions silent for 60 s end `lost`, past the backstop end `backstop`. Paged. */
export function sweepSessions(db: DatabaseSync, fx: CallEffects, now: number): string[] {
  const ended: string[] = [];
  for (;;) {
    const rows = db.prepare(`SELECT * FROM bot_call_sessions WHERE ended_at IS NULL AND (last_seen_at < ? OR backstop_at <= ?) ORDER BY last_seen_at LIMIT ?`)
      .all(now - CALL_PROTOCOL.silenceEndsMs, now, PAGE) as SessionRow[];
    for (const row of rows) { const s = toSession(row); if (endSession(db, s.callId, silentEnd(s, now), fx, now).ended) ended.push(s.callId); }
    if (rows.length < PAGE) return ended;
  }
}

/** Step 3 of decide(): a ring holds the slot, or any session is live (5.7). */
export function callIsLive(db: DatabaseSync, now: number): boolean {
  if (slotTaken(db)) return true;
  return !!db.prepare("SELECT 1 AS x FROM bot_call_sessions WHERE ended_at IS NULL AND last_seen_at >= ? AND backstop_at > ? LIMIT 1").get(now - CALL_PROTOCOL.silenceEndsMs, now);
}
export function liveSessions(db: DatabaseSync, now: number): CallSession[] {
  return (db.prepare("SELECT * FROM bot_call_sessions WHERE ended_at IS NULL AND last_seen_at >= ? AND backstop_at > ? ORDER BY opened_at LIMIT ?")
    .all(now - CALL_PROTOCOL.silenceEndsMs, now, PAGE) as SessionRow[]).map(toSession);
}
export function ringingIntent(db: DatabaseSync): CallIntent | null {
  const row = db.prepare("SELECT * FROM bot_calls WHERE state='ringing' LIMIT 1").get() as IntentRow | undefined;
  return row ? toIntent(row) : null;
}

/** An ordinary owner call (POST /api/calls/sessions). Opening one while an intent rings ends that ring as `text_instead`
 * with "You started another call" (5.4). */
export function openOwnerSession(db: DatabaseSync, o: { botId: string; threadId: string; device: string; principal: string }, fx: CallEffects, now: number):
  { sessionId: string; callId: string; endedRing: string | null } {
  return inTransaction(db, () => {
    const ringing = ringingIntent(db);
    const endedRing = ringing && endRing(db, ringing.id, "text_instead", fx, now, { stop: "another_call" }) ? ringing.id : null;
    return { ...insertSession(db, { botId: o.botId, intentId: null, threadId: o.threadId, device: o.device, principal: o.principal }, now), endedRing };
  });
}

// ── T5: answer, and its retry (5.4) ─────────────────────────────────────────

export type AnswerResult =
  | { status: 200; sessionId: string; callId: string; threadId: string; intent: CallIntent }
  | { status: 409; error: AnswerRefusal }
  | { status: 410; error: "gone" }
  | { status: 404; error: "not_found" };

/** T5: the first device wins. A retry by the winner returns the same session while it is live; once it ended, or is no
 * longer live (the request ends it `lost` and runs T8), `410`. Any other device gets `409 answered_elsewhere`. An answer
 * after the ring's deadline is `409 expired` and runs T7 (F16, F17, F18). */
/** A ring has no session row until someone answers: the answer inserts it, with the answering device, in this transaction. */
export function answerCall(db: DatabaseSync, id: string, device: string, fx: CallEffects, now: number, principal: string): AnswerResult {
  return inTransaction(db, (): AnswerResult => {
    const before = getIntent(db, id);
    if (!before) return { status: 404, error: "not_found" };
    if (before.state === "ringing") {
      if (before.deadlineAt === null || before.deadlineAt <= now) { endRing(db, id, "missed", fx, now); return { status: 409, error: "expired" }; }
      const { sessionId, callId } = insertSession(db, { botId: before.botId, intentId: id, threadId: before.threadId, device, principal }, now);
      const changed = Number(db.prepare("UPDATE bot_calls SET state='live', answered_on=?, session_id=?, receipt=? WHERE id=? AND state='ringing' AND deadline_at > ?")
        .run(device, sessionId, receiptWith(before, [{ check: "answer", result: "answered", detail: device.split(":")[0] }]), id, now).changes);
      if (changed !== 1) throw new Error("bot call: the ring changed inside its own transaction");
      const intent = reread(db, id);
      fx.resolve(intent, "answered");
      return { status: 200, sessionId, callId, threadId: before.threadId, intent };
    }
    if (before.state === "live") {
      const s = before.sessionId ? sessionById(db, before.sessionId) : null;
      if (before.answeredOn !== device) return { status: 409, error: "answered_elsewhere" };
      if (s && sessionLive(s, now)) return { status: 200, sessionId: s.id, callId: s.callId, threadId: before.threadId, intent: before };
      if (s && s.endedAt === null) endSession(db, s.callId, silentEnd(s, now), fx, now);
      return { status: 410, error: "gone" };
    }
    if (before.state === "done") return { status: 410, error: "gone" };
    return { status: 409, error: "expired" };
  });
}

// ── T6, T7, T7b: a ring ends ────────────────────────────────────────────────

/** T6 (declined, text_instead), T7 (missed, deadline passed) and T7b (missed at boot, no deadline guard). The slot is
 * freed, resolveCall stops every binding that may have rung, the Missed card is written; text_instead and missed add the
 * note. Never a re-ring. */
function endRing(db: DatabaseSync, id: string, outcome: "declined" | "text_instead" | "missed", fx: CallEffects, now: number,
  o: { boot?: boolean; stop?: string } = {}): boolean {
  const before = getIntent(db, id);
  if (!before || before.state !== "ringing") return false;
  const deadlineGuard = outcome === "missed" && !o.boot ? " AND deadline_at <= ?" : "";
  const args: Array<string | number> = [outcome, now, receiptWith(before, [{ check: "ring", result: outcome }], o.stop ? { stop: o.stop } : {}), id];
  if (deadlineGuard) args.push(now);
  const changed = Number(db.prepare(`UPDATE bot_calls SET state='done', outcome=?, active_slot=NULL, ended_at=?, receipt=? WHERE id=? AND state='ringing'${deadlineGuard}`).run(...args).changes);
  if (changed !== 1) return false;
  const intent = reread(db, id);
  fx.resolve(intent, outcome === "missed" ? "missed" : "declined");
  fx.card(intent);
  if (outcome !== "declined") fx.note(intent);
  return true;
}
/** Not now (T6 declined) and Text me instead (T6 text_instead). */
export function declineCall(db: DatabaseSync, id: string, how: "declined" | "text_instead", fx: CallEffects, now: number): boolean {
  return inTransaction(db, () => endRing(db, id, how, fx, now));
}
/** T7: the 45 s ring ended unanswered. */
export function missCall(db: DatabaseSync, id: string, fx: CallEffects, now: number): boolean {
  return inTransaction(db, () => endRing(db, id, "missed", fx, now));
}

// ── T9: Stop and every owner cancel (5.6) ───────────────────────────────────

export type CancelScope = { bot: string } | { rule: string } | { intent: string } | { all: true };
export type CancelReason = "stop" | "pause" | "delete" | "bot_off" | "rule_off" | "never_again" | "calls_off" | "owner";
const BOT_REASONS: ReadonlySet<CancelReason> = new Set(["stop", "pause", "delete", "bot_off"]);

/** cancelBotCalls: ONE transaction. T9 for every non-done intent in scope. A bot scope (Stop, pause, delete, switch off)
 * also ends every live session of the bot, ordinary calls included, and drops every unsent call-note of the bot. Rule
 * off, never again and calls off for today cancel intents only and leave a call the owner is already in. Returns what
 * ended, for the call.ended hints after commit. */
export function cancelBotCalls(db: DatabaseSync, scope: CancelScope, reason: CancelReason, fx: CallEffects, now: number): { intents: string[]; callIds: string[] } {
  if ("bot" in scope && !BOT_REASONS.has(reason)) throw new Error("bot call: a bot-scope cancel is a Stop, pause, delete or switch off");
  return inTransaction(db, () => {
    const where = "bot" in scope ? ["bot_id=?", scope.bot] : "rule" in scope ? ["rule_id=?", scope.rule] : "intent" in scope ? ["id=?", scope.intent] : ["1=1"];
    const keepLive = !("bot" in scope);
    const ids = (db.prepare(`SELECT id FROM bot_calls WHERE state <> 'done' AND ${where[0]}${keepLive ? " AND state <> 'live'" : ""}`)
      .all(...where.slice(1) as string[]) as Array<{ id: string }>).map(r => r.id);
    const intents: string[] = [];
    for (const id of ids) {
      const before = getIntent(db, id);
      if (!before || before.state === "done" || (keepLive && before.state === "live")) continue;
      const changed = Number(db.prepare("UPDATE bot_calls SET state='done', outcome='cancelled', active_slot=NULL, ended_at=?, receipt=? WHERE id=? AND state <> 'done'")
        .run(now, receiptWith(before, [{ check: "cancel", result: reason }], { stop: reason }), id).changes);
      if (changed !== 1) continue;
      const intent = reread(db, id);
      fx.resolve(intent, "stopped");
      fx.card(intent);
      intents.push(id);
    }
    const callIds: string[] = [];
    if ("bot" in scope) {
      for (const row of db.prepare("UPDATE bot_call_sessions SET ended_at=?, ended_by='stopped' WHERE bot_id=? AND ended_at IS NULL RETURNING call_id").all(now, scope.bot) as Array<{ call_id: string }>) callIds.push(row.call_id);
      fx.dropNotes(scope.bot);
    }
    return { intents, callIds };
  });
}

// ── owed admissions (4.1) ───────────────────────────────────────────────────

export interface OwedRow { factKey: string; botId: string; kind: string; threadId: string; sourceId: string | null; at: number | null; armed: boolean }
type OwedDbRow = { fact_key: string; bot_id: string; kind: string; thread_id: string; source_id: string | null; at: number | null; armed: number };
const toOwed = (r: OwedDbRow): OwedRow => ({ factKey: r.fact_key, botId: r.bot_id, kind: r.kind, threadId: r.thread_id, sourceId: r.source_id, at: num(r.at), armed: Number(r.armed) === 1 });

/** "Call me when this finishes": the turn_end rule and the armed owed row (at NULL) in ONE transaction. The rule goes
 * through insertCallRule, so it is born held during a restore (F61). */
export function markTurnCall(db: DatabaseSync, o: { botId: string; threadId: string; turnId: string; how: "ring" | "text_first"; waitMin?: number | null; label?: string | null }, now: number): { ruleId: string } {
  return inTransaction(db, () => {
    const ruleId = insertCallRule(db, { botId: o.botId, kind: "turn_end", params: { threadId: o.threadId, turnId: o.turnId }, how: o.how, waitMin: o.how === "text_first" ? o.waitMin : undefined, label: o.label ?? undefined }, now);
    db.prepare("INSERT OR IGNORE INTO bot_call_owed (fact_key, bot_id, kind, thread_id, source_id, at, armed) VALUES (?,?,'turn',?,?,NULL,1)")
      .run(`turn:${o.turnId}`, o.botId, o.threadId, o.turnId);
    return { ruleId };
  });
}
/** The settle hook: the marked turn ended at `at`. Returns whether an armed row was settled. */
export function settleTurnOwed(db: DatabaseSync, turnId: string, at: number): boolean {
  return Number(db.prepare("UPDATE bot_call_owed SET at=? WHERE fact_key=? AND at IS NULL").run(Math.trunc(at), `turn:${turnId}`).changes) === 1;
}
/** Boot: an armed row whose thread has no running turn counts as settled at the thread's newest message (boot clears the
 * busy flags, so a turn cut by the crash is not running). */
export function settleArmedAtBoot(db: DatabaseSync, threadRunning: (threadId: string) => boolean, now: number): number {
  let settled = 0;
  const newest = db.prepare("SELECT MAX(at) AS at FROM messages WHERE thread_id=?");
  for (const row of db.prepare("SELECT * FROM bot_call_owed WHERE at IS NULL").all() as OwedDbRow[]) {
    if (threadRunning(row.thread_id)) continue;
    const at = num((newest.get(row.thread_id) as { at: number | null } | undefined)?.at) ?? now;
    settled += Number(db.prepare("UPDATE bot_call_owed SET at=? WHERE fact_key=? AND at IS NULL").run(at, row.fact_key).changes);
  }
  return settled;
}

/** What a drained row admits. "damaged": the source cannot be read; the row is deleted with a trace (F6). */
export type OwedMatch = Admission[] | "damaged";

/** The drain: on a wake after a commit that wrote an owed row, and at boot. Paged `WHERE at IS NOT NULL ORDER BY at`
 * (armed turn rows wait until they settle, F58). Each row is ONE transaction: read the source, match, INSERT OR IGNORE,
 * delete the row. A crash rolls back to owed; the unique key keeps a redo to one intent (F4, F5). A row whose
 * transaction throws stays owed for the next wake, and this drain stops. Returns the admitted intent ids. */
export function drainOwed(db: DatabaseSync, match: (row: OwedRow) => OwedMatch, now: number, onDamaged: (row: OwedRow) => void = () => {}): string[] {
  const admitted: string[] = [];
  const page = db.prepare("SELECT * FROM bot_call_owed WHERE at IS NOT NULL ORDER BY at, fact_key LIMIT ?");
  for (;;) {
    const rows = (page.all(PAGE) as OwedDbRow[]).map(toOwed);
    for (const row of rows) {
      try {
        inTransaction(db, () => {
          if (!db.prepare("SELECT 1 AS x FROM bot_call_owed WHERE fact_key=? AND at IS NOT NULL").get(row.factKey)) return;
          let result: OwedMatch;
          try { result = match(row); } catch { result = "damaged"; }
          if (result === "damaged") onDamaged(row);
          else for (const a of result) { const id = admitIntent(db, a, now); if (id) admitted.push(id); }
          db.prepare("DELETE FROM bot_call_owed WHERE fact_key=?").run(row.factKey);
        });
      } catch { return admitted; }
    }
    if (rows.length < PAGE) return admitted;
  }
}

/** The channel matcher (4.1): the message is read in TypeScript, never by json_extract in a write path. Every bot's
 * enabled, unheld sender rules for the thread are matched, not only the owed row's bot (the watch list names one bot). */
/** `senderOf` names the external sender of an inbound row. Inbound rows carry no sender id of their own (only
 * json.automation names the channel), so the harness answers from the thread's verified human binding. Only an inbound
 * (`user`) row with an automation origin can match: an owner-typed row or a bot's reply never rings. */
export function matchChannelOwed(db: DatabaseSync, row: OwedRow, senderOf: (threadId: string, json: Record<string, unknown>) => string | null): OwedMatch {
  if (!row.sourceId) return [];
  const message = db.prepare("SELECT json, at, role FROM messages WHERE thread_id=? AND id=?").get(row.threadId, row.sourceId) as { json: string; at: number; role: string } | undefined;
  if (!message || message.role !== "user") return [];
  const json = parseObject(message.json);
  if (!json) return "damaged";
  const automation = json.automation as { kind?: unknown } | undefined;
  if (!automation || typeof automation !== "object" || (automation.kind !== "channel" && automation.kind !== "webhook")) return [];
  const sender = senderOf(row.threadId, json);
  if (!sender) return [];
  const out: Admission[] = [];
  const rules = db.prepare("SELECT id, bot_id, params FROM bot_call_rules WHERE kind='sender' AND enabled=1 AND restore_held=0 ORDER BY bot_id, position, id").all() as Array<{ id: string; bot_id: string; params: string }>;
  const seen = new Set<string>();
  for (const rule of rules) {
    const params = parseObject(rule.params);
    if (!params || params.threadId !== row.threadId || !Array.isArray(params.senderIds) || !params.senderIds.includes(sender) || seen.has(rule.bot_id)) continue;
    seen.add(rule.bot_id);
    out.push({ botId: rule.bot_id, ruleId: rule.id, threadId: row.threadId, factKind: "channel.message", factKey: row.factKey, factAt: Number(message.at), factFields: { senderId: sender, messageId: row.sourceId } });
  }
  return out;
}

// ── boot reconcile (5.8) ────────────────────────────────────────────────────

export interface BootReconcile {
  /** Pending intents with their new gen: decide(initial) runs for each (its freshness step makes an old one late). */
  redecide: Array<{ id: string; gen: number }>;
  /** Waiting intents whose deadline is still ahead: their escalation timers. */
  timers: Array<{ id: string; deadlineAt: number }>;
  /** Ringing intents ended by T7b. */
  missed: string[];
  /** Waiting intents whose deadline passed while Murage was not running: T4 to done(late), receipt only. */
  late: string[];
  admitted: string[];
}
/** Before any new admission and before the push outbox starts (5.8): 1. every open session gets the 60 s grace; 2. armed
 * turn rows settle, owed rows drain, the journal's call facts are re-admitted; 3. every open intent is walked, paged. A
 * restart never resumes a ring (T7b, guard state='ringing' only, F14) and never rings for a missed deadline (F56). */
export function bootReconcile(db: DatabaseSync, deps: {
  fx: CallEffects; threadRunning: (threadId: string) => boolean; match: (row: OwedRow) => OwedMatch; readmitJournal?: () => string[]; onDamaged?: (row: OwedRow) => void;
}, now: number): BootReconcile {
  db.prepare("UPDATE bot_call_sessions SET last_seen_at=? WHERE ended_at IS NULL").run(now);
  settleArmedAtBoot(db, deps.threadRunning, now);
  const out: BootReconcile = { redecide: [], timers: [], missed: [], late: [], admitted: drainOwed(db, deps.match, now, deps.onDamaged) };
  out.admitted.push(...(deps.readmitJournal?.() ?? []));
  let after = "";
  const page = db.prepare("SELECT id, state, gen, deadline_at FROM bot_calls WHERE state <> 'done' AND id > ? ORDER BY id LIMIT ?");
  for (;;) {
    const rows = page.all(after, PAGE) as Array<{ id: string; state: CallState; gen: number; deadline_at: number | null }>;
    for (const row of rows) {
      after = row.id;
      if (row.state === "pending") { const gen = bumpGen(db, row.id); if (gen !== null) out.redecide.push({ id: row.id, gen }); }
      else if (row.state === "waiting") {
        const deadline = num(row.deadline_at);
        if (deadline === null || deadline <= now) {
          const r = applyEscalation(db, row.id, Number(row.gen), { to: "done", outcome: "late", steps: [{ check: "fresh", result: "late", detail: "deadline_passed_while_down" }] }, deps.fx, now);
          if (r.applied) out.late.push(row.id);
        } else out.timers.push({ id: row.id, deadlineAt: deadline });
      } else if (row.state === "ringing") {
        if (inTransaction(db, () => endRing(db, row.id, "missed", deps.fx, now, { boot: true }))) out.missed.push(row.id);
      }
      // live: follows its session (the grace above, then the sweep)
    }
    if (rows.length < PAGE) return out;
  }
}
