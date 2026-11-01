// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2), phase 4c: the harness side of the machine. The CallEffects backed by the push
// outbox and the card writer (5.2, 5.5), the dispatch fence's callRinging and the outbox's stillPending for call requests,
// boot reconcile BEFORE the push outbox starts (5.8), the 10 s sweep, the escalation and ring timers, the owed drain's wake
// (4.1), sendNow after every commit, and the SSE hints. server/index.ts builds one of these with database() as the db, so
// a card written through the store inside a transition nests in the same transaction (a52a9b431).
import type { DatabaseSync } from "node:sqlite";
import type { CallHint } from "../shared/bot-calls-contract.ts";
import {
  answerCall, bootReconcile, cancelBotCalls, declineCall, drainOwed, endSession, getIntent, getSession, markSeen, matchChannelOwed,
  missCall, openOwnerSession, settleTurnOwed, sweepSessions, touchSession,
  type Admission, type AnswerResult, type CallEffects, type CallIntent, type CancelReason, type CancelScope, type CallSession, type OwedMatch, type OwedRow, type SessionEnd,
} from "./bot-calls-machine.ts";
import { admitFact, type ServerFact } from "./bot-calls-facts.ts";
import { decide, quietNow, type DecideEntry, type DecideWorld } from "./bot-calls-policy.ts";

export const SWEEP_EVERY_MS = 10_000;

/** The outbox's call paths (mobile-push-outbox.ts, phase 4b). */
export interface CallOutbox {
  ringCall(n: { intentId: string; botId: string; threadId: string; expiresAt: number }): number;
  noteCall(n: { intentId: string; botId: string; threadId: string }): number;
  resolveCall(threadId: string, intentId: string, how: "answered" | "declined" | "missed" | "stopped"): number;
  dropCallNotes(botId: string): number;
  sendNow(requestId: string): Promise<{ attempted: number }>;
}

export interface BotCallsRuntimeDeps {
  /** database(): the store's own connection, so the card's write nests in the transition (5.2). */
  db: () => DatabaseSync;
  outbox: CallOutbox;
  /** The keyed card for this intent, written through the store, synchronously, inside the transition. Throws on failure. */
  card(intent: CallIntent): void;
  world: Omit<DecideWorld, "bootAt">;
  /** An SSE hint (call.ring, call.answered, call.ended). Content-free; never throws out. */
  hint(payload: CallHint): void;
  /** A session ended: the call channel tells its sockets and closes them. */
  sessionEnded?(callId: string, reason: SessionEnd): void;
  /** A thread has a running turn (boot: nothing does). */
  threadRunning(threadId: string): boolean;
  /** The external sender of an inbound channel row (the thread's verified human binding, 4.1). */
  senderOf(threadId: string, json: Record<string, unknown>): string | null;
  /** Starts the push outbox's timer: called once, after boot reconcile returned (5.5, 5.8). */
  startOutbox(): void;
  now?: () => number;
  warn?: (hook: string, error: unknown) => void;
}

/** The turn matcher (4.1): an armed `turn` row admits the turn_end rule that armed it, for that bot and thread. */
export function matchTurnOwed(db: DatabaseSync, row: OwedRow): OwedMatch {
  if (!row.sourceId) return [];
  const rules = db.prepare("SELECT id, params FROM bot_call_rules WHERE bot_id=? AND kind='turn_end' AND enabled=1 AND restore_held=0 ORDER BY position, id").all(row.botId) as Array<{ id: string; params: string }>;
  for (const rule of rules) {
    let params: { threadId?: unknown; turnId?: unknown } | null;
    try { params = JSON.parse(rule.params) as { threadId?: unknown; turnId?: unknown } | null; } catch { continue; }
    if (!params || params.threadId !== row.threadId || params.turnId !== row.sourceId) continue;
    const admission: Admission = { botId: row.botId, ruleId: rule.id, threadId: row.threadId, factKind: "turn.ended", factKey: row.factKey, factAt: row.at ?? Date.now(), factFields: { turnId: row.sourceId } };
    return [admission];
  }
  return [];
}

export type BotCallsRuntime = ReturnType<typeof createBotCallsRuntime>;

export function createBotCallsRuntime(deps: BotCallsRuntimeDeps) {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? (() => {});
  const bootAt = now();
  const world: DecideWorld = { ...deps.world, bootAt };
  /** Boot reconcile has returned: until then nothing sends and the fence says no (5.5). */
  let ready = false;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const fx: CallEffects = {
    ring: (intent, expiresAt) => { deps.outbox.ringCall({ intentId: intent.id, botId: intent.botId, threadId: intent.threadId, expiresAt }); },
    // the ONE place a note push is made: in quiet hours or calls off for today the card only (5.4)
    note: (intent) => { if (!quietNow(deps.db(), deps.world, now())) deps.outbox.noteCall({ intentId: intent.id, botId: intent.botId, threadId: intent.threadId }); },
    resolve: (intent, where) => { deps.outbox.resolveCall(intent.threadId, intent.id, where); },
    card: (intent) => deps.card(intent),
    dropNotes: (botId) => { deps.outbox.dropCallNotes(botId); },
  };

  const safeHint = (payload: CallHint) => { try { deps.hint(payload); } catch (error) { warn("hint", error); } };
  const send = (intentId: string) => { if (ready) void deps.outbox.sendNow(intentId).catch((error: unknown) => warn("send-now", error)); };
  const clearTimer = (id: string) => { const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); } };
  const at = (id: string, when: number, run: () => void) => {
    clearTimer(id);
    const t = setTimeout(() => { timers.delete(id); try { run(); } catch (error) { warn("timer", error); } }, Math.max(0, when - now()));
    t.unref?.();
    timers.set(id, t);
  };

  /** After a commit: rebuild the intent's timer, hint the clients, send its push rows now (5.2). */
  function settled(id: string): void {
    const intent = getIntent(deps.db(), id);
    if (!intent) return;
    clearTimer(id);
    if (intent.state === "waiting" && intent.deadlineAt !== null) at(id, intent.deadlineAt, () => { void run(id, "escalation"); });
    else if (intent.state === "ringing" && intent.deadlineAt !== null) {
      at(id, intent.deadlineAt, () => { if (missCall(deps.db(), id, fx, now())) settled(id); });
      safeHint({ type: "call.ring", intentId: id, botId: intent.botId, threadId: intent.threadId, deadlineAt: intent.deadlineAt });
    } else if (intent.state === "done") safeHint({ type: "call.ended", intentId: id, threadId: intent.threadId });
    send(id);
  }

  async function run(id: string, entry: DecideEntry): Promise<void> {
    try { const r = await decide(deps.db(), id, entry, world, fx, now); if (r.applied) settled(id); }
    catch (error) { warn("decide", error); }
  }

  const match = (row: OwedRow): OwedMatch => row.kind === "turn" ? matchTurnOwed(deps.db(), row) : matchChannelOwed(deps.db(), row, deps.senderOf);

  /** The drain's wake (4.1): after a commit that wrote an owed row (a turn settled, an inbound channel row), and each sweep. */
  function wake(): void {
    if (!ready) return;
    let admitted: string[] = [];
    try { admitted = drainOwed(deps.db(), match, now(), () => warn("owed-damaged", null)); } catch (error) { warn("drain", error); }
    for (const id of admitted) void run(id, "initial");
  }

  function endedSessions(callIds: readonly string[], reason: SessionEnd): void {
    for (const callId of callIds) {
      const threadId = getSession(deps.db(), callId)?.threadId ?? undefined;
      safeHint(threadId ? { type: "call.ended", callId, threadId } : { type: "call.ended", callId });
      try { deps.sessionEnded?.(callId, reason); } catch (error) { warn("session-ended", error); }
    }
  }

  /** The 10 s sweep (5.7): silent sessions end `lost` (backstop past 4 h); a ring or a wait whose timer was lost ends or
   * escalates; the owed drain wakes. */
  function sweep(): void {
    if (!ready) return;
    const db = deps.db();
    const t = now();
    const before = new Map((db.prepare("SELECT call_id, last_seen_at, backstop_at FROM bot_call_sessions WHERE ended_at IS NULL AND (last_seen_at < ? OR backstop_at <= ?)")
      .all(t - 60_000, t) as Array<{ call_id: string; backstop_at: number }>).map((r) => [r.call_id, Number(r.backstop_at) <= t ? "backstop" as const : "lost" as const]));
    for (const callId of sweepSessions(db, fx, t)) {
      endedSessions([callId], before.get(callId) ?? "lost");
      const s = getSession(db, callId);
      if (s?.intentId) settled(s.intentId);
    }
    for (const row of db.prepare("SELECT id, state FROM bot_calls WHERE state IN ('ringing','waiting') AND deadline_at <= ? LIMIT 100").all(t) as Array<{ id: string; state: string }>) {
      if (timers.has(row.id)) continue;
      if (row.state === "ringing") { if (missCall(db, row.id, fx, t)) settled(row.id); }
      else void run(row.id, "escalation");
    }
    wake();
  }

  return {
    fx,
    world,
    /** The dispatch fence (5.5): ringing, and the deadline ahead. False until boot reconcile returned. */
    callRinging(intentId: string): boolean {
      if (!ready) return false;
      const intent = getIntent(deps.db(), intentId);
      return intent !== null && intent.state === "ringing" && intent.deadlineAt !== null && intent.deadlineAt > now();
    },
    /** Whether this request id is a call intent at all (the outbox's world asks before its own card checks). */
    owns(requestId: string): boolean { return getIntent(deps.db(), requestId) !== null; },
    /** The outbox's pending() for a call request: a ring while it rings; a note until it is seen or the call happened. */
    stillPending(requestId: string): boolean {
      const intent = getIntent(deps.db(), requestId);
      if (!intent) return false;
      if (intent.state === "ringing") return intent.deadlineAt !== null && intent.deadlineAt > now();
      if (intent.seenAt !== null || intent.state === "live" || intent.state === "pending") return false;
      return intent.state === "waiting" || (intent.outcome !== null && ["texted", "late", "missed", "declined", "text_instead"].includes(intent.outcome));
    },
    ready: () => ready,
    /** 5.8: before any new admission and before the push outbox starts. Then the outbox, the sweep and the timers. */
    boot(): void {
      if (ready) return;
      const db = deps.db();
      let out: ReturnType<typeof bootReconcile> | null = null;
      try { out = bootReconcile(db, { fx, threadRunning: deps.threadRunning, match, onDamaged: () => warn("owed-damaged", null) }, now()); }
      catch (error) { warn("boot-reconcile", error); }
      ready = out !== null;
      // Other kinds keep sending even when the reconcile failed; calls stay fenced (callRinging is false while not ready).
      try { deps.startOutbox(); } catch (error) { warn("start-outbox", error); }
      if (!out) return;
      for (const id of [...out.missed, ...out.late]) send(id);
      for (const { id, deadlineAt } of out.timers) at(id, deadlineAt, () => { void run(id, "escalation"); });
      for (const { id } of out.redecide) void run(id, "initial");
      for (const id of out.admitted) void run(id, "initial");
      sweepTimer = setInterval(() => { try { sweep(); } catch (error) { warn("sweep", error); } }, SWEEP_EVERY_MS);
      sweepTimer.unref?.();
    },
    stop(): void {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      for (const id of [...timers.keys()]) clearTimer(id);
    },
    sweep,
    wake,
    /** A new admission (a producer's INSERT OR IGNORE returned an id): decide(initial). */
    admitted(id: string): void { if (ready) void run(id, "initial"); },
    /** One server fact from a producer (bot-calls-facts.ts): admit it against the bot's rules, then decide. Never throws
     * out into the producer; returns the new intents' ids (empty when no rule matched or it was already admitted). */
    fact(f: ServerFact): string[] {
      let ids: string[] = [];
      try { ids = admitFact(deps.db(), f, now()); } catch (error) { warn("fact", error); return []; }
      for (const id of ids) if (ready) void run(id, "initial");
      return ids;
    },
    /** bus turn.completed: settle a marked turn's armed row, then wake the drain. */
    turnCompleted(turnId: string): void {
      try { if (settleTurnOwed(deps.db(), turnId, now())) wake(); } catch (error) { warn("turn-settle", error); }
    },
    answer(id: string, device: string): AnswerResult {
      const r = answerCall(deps.db(), id, device, fx, now());
      if (r.status === 200) safeHint({ type: "call.answered", intentId: id, callId: r.callId, device, threadId: r.threadId });
      settled(id);
      return r;
    },
    decline(id: string, how: "declined" | "text_instead"): boolean {
      const ok = declineCall(deps.db(), id, how, fx, now());
      if (ok) settled(id);
      return ok;
    },
    seen(id: string): boolean { const ok = markSeen(deps.db(), id, now()); if (ok) { clearTimer(id); send(id); } return ok; },
    openSession(o: { botId: string; threadId: string; device: string }): { sessionId: string; callId: string } {
      const r = openOwnerSession(deps.db(), o, fx, now());
      if (r.endedRing) settled(r.endedRing);
      return { sessionId: r.sessionId, callId: r.callId };
    },
    endSession(callId: string, reason: SessionEnd = "closed"): boolean {
      const r = endSession(deps.db(), callId, reason, fx, now());
      if (r.ended) { endedSessions([callId], reason); if (r.intentId) settled(r.intentId); }
      return r.ended;
    },
    /** Traffic for a call: a pong, a frame, or a request carrying x-murage-call-id (5.7). `may` is the request's
     * check: a caller that is not the session's device and cannot see its thread touches nothing ("unknown"). */
    touch(callId: string, may?: (session: CallSession) => boolean): "live" | "ended" | "unknown" {
      const db = deps.db();
      const before = getSession(db, callId);
      if (may && (!before || !may(before))) return "unknown";
      const r = touchSession(db, callId, fx, now());
      if (r === "ended" && before && before.endedAt === null) {
        const after = getSession(db, callId);
        endedSessions([callId], after?.endedBy ?? "lost");
        if (before.intentId) settled(before.intentId);
      }
      return r;
    },
    /** 5.6: Stop, pause, delete, switch off (bot scope), rule off, never again, calls off for today. */
    cancel(scope: CancelScope, reason: CancelReason): { intents: string[]; callIds: string[] } {
      const r = cancelBotCalls(deps.db(), scope, reason, fx, now());
      for (const id of r.intents) settled(id);
      endedSessions(r.callIds, "stopped");
      return r;
    },
  };
}
