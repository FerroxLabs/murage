// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spec §3.4 push outbox, adapted from the Codex MobileNotificationOutbox:
// durable, retried, bounded, and fed only by notify() after the preference
// filter. What leaves is the RelayEvent in shared/mobile-push.ts and nothing
// else; the private ids stay in push_events for the detail route.
import { isAttention, pushCategory, type PushCategory, type PushKind, type PushRisk, type RelayEvent, type ResolvedBy } from "../shared/mobile-push.ts";
import { PRESENCE_HOLD_MS } from "./mobile-presence.ts";
import { collapseKey, newEventRef, threadGroup } from "./mobile-push-keys.ts";
import type { PushBinding, PushEventRow, PushEventState, PushStore } from "./mobile-push-store.ts";
import type { CallResolution } from "./bot-calls-machine.ts";

export const ATTENTION_TTL_MS = 12 * 3600_000;
export const DONE_TTL_MS = 3600_000;
/** A transient failure backs off, doubling to this cap, until the event expires. */
export const MAX_BACKOFF_MS = 300_000;
const SEND_TIMEOUT_MS = 10_000;
const FLUSH_LIMIT = 20;
/** sendNow (bot calls 5.5): each call row of the request is sent in parallel, with this timeout. */
export const SEND_NOW_TIMEOUT_MS = 5_000;
/** A call note, and a call's resolved revision at the least, lives this long (5.5). */
export const CALL_NOTE_TTL_MS = 12 * 3600_000;
/** A 401 alone is retried: a binding counts as gone only after this many 401s in a row, spanning at least GONE_AFTER_MS. */
export const GONE_AFTER_401S = 3;
export const GONE_AFTER_MS = 10 * 60_000;
/** What a call's phones are told for each way its request was resolved. */
const CALL_RESOLVED_BY: Record<CallResolution, ResolvedBy> = { answered: "elsewhere", declined: "dismissed", missed: "dismissed", stopped: "dismissed" };
/** A call note collapses apart from its ring, so the ring's resolution never clears the note that follows it. */
const noteCollapseId = (intentId: string): string => `${intentId}\ncall-note`;

export interface OutboxNotification { kind: PushKind; botId: string; threadId: string; requestId?: string; messageId?: string;
  /** S39: a done for a turn the asking phone started. It skips the presence gate and goes to that phone only. */
  askDeviceId?: string }
export interface OutboxWorld {
  visible(threadId: string): boolean;
  present(): boolean;
  badge(): number;
  latestMessageId(threadId: string): string | undefined;
  stillPending(threadId: string, requestId: string): boolean;
  /** Rate the request's content for this revision, before any phone gets
   *  it (spec §3.5). Left out, or throwing, leaves the revision unrated. */
  rate?(threadId: string, requestId: string, revision: number): void;
  /** The rating for exactly this revision: the one respond checks. */
  risk(threadId: string, requestId: string, revision: number): PushRisk;
  timeSensitive(threadId: string, requestId: string): boolean;
  /** False for a routine or skill proposal and a question card: those are
   *  answered in the app, so the phone offers Open only. */
  actionable(threadId: string, requestId: string): boolean;
  /** False for a phone whose registration is missing or older than protocol 1 (F20): it cannot run a job, so it is not pushed one. Left out, every phone can. */
  deviceJobCapable?(bindingId: string): boolean;
  /** X1: whether the thread's turn has used the owner's phone. Every row written for it is flagged, so its detail is the generic text. Left out, nothing is flagged;
   *  one that throws flags the row (fail closed). */
  phoneMarked?(threadId: string): boolean;
  /** Bot calls dispatch fence (5.5): the intent (a call row's request id) is `ringing` and its `deadline_at` is still ahead. A `call`
   *  row is sent only while this says true; left out, or throwing, no ring is sent (fail closed). */
  callRinging?(intentId: string): boolean;
}
/** "retry": no answer, or one that says nothing about this event (network,
 *  429, 5xx): try again, backing off, until the event expires. "rejected": a
 *  final answer for this event (any other 4xx): it is never retried. */
export type SendResult = "accepted" | "gone" | "retry" | "rejected";
export interface PushSender { publish(binding: PushBinding, event: RelayEvent, signal: AbortSignal): Promise<SendResult> }

/** Written with explicit field assignment, not a TS constructor parameter
 *  property: server/*.ts loads through Node's strip-only type stripping,
 *  which rejects that syntax (see mobile-push-store.ts). */
export class PushOutbox {
  private readonly store: PushStore;
  private readonly world: OutboxWorld;
  private readonly sender: PushSender;
  private readonly now: () => number;
  private readonly randomRef: () => string;
  private readonly warn: (hook: string, error: unknown) => void;
  private readonly onExhausted: (row: PushEventRow) => void;
  private running: Promise<{ attempted: number }> | null = null;
  /** Rows held from their claim to their send's completion, by run() and sendNow() alike (5.5, F60). Lost with the process; boot
   *  ends every ringing intent (T7b) before either path starts. */
  private readonly inFlight = new Set<string>();
  /** 401s in a row per binding, and when the first of them came. Any other answer clears it. Lost with the process, which only
   *  delays a removal. */
  private readonly unauthorized = new Map<string, { count: number; firstAt: number }>();

  constructor(o: {
    store: PushStore; world: OutboxWorld; sender: PushSender; now?: () => number; randomRef?: () => string;
    /** A content-free trace of a swallowed failure (the hook name). */
    warn?: (hook: string, error: unknown) => void;
    /** An attention event the relay rejected for good: the phone was not
     *  told, so the owner should be. Content-free; never throws out. */
    onExhausted?: (row: PushEventRow) => void;
  }) {
    this.onExhausted = o.onExhausted ?? (() => {});
    this.store = o.store;
    this.world = o.world;
    this.sender = o.sender;
    this.now = o.now ?? Date.now;
    this.randomRef = o.randomRef ?? newEventRef;
    this.warn = o.warn ?? (() => {});
  }

  /** The flag for a row about to be written: the thread's mark now. A world that cannot answer flags the row. */
  private phoneUsed(threadId: string): boolean {
    try { return this.world.phoneMarked?.(threadId) === true; } catch (error) { this.warn("phone-mark", error); return true; }
  }

  enqueue(n: OutboxNotification): number {
    const { store, world } = this;
    const now = this.now();
    // Bot calls have their own entry points (ringCall, noteCall): never held, never fanned out to every phone as a ring.
    if (n.kind === "call" || n.kind === "call-note") return 0;
    const present = world.present();
    if (!isAttention(n.kind) && present && !n.askDeviceId) return 0;
    if (!world.visible(n.threadId)) return 0;
    // One revision per request for every binding (H9 re-review Concern 1),
    // rated once, here, before the fan-out: the category chosen below and
    // respondFromPush's Allow check then read the same rating.
    // nextRevision never repeats a number a rating was made for, so a
    // failed rate below really leaves this revision unrated.
    const revision = n.requestId ? store.nextRevision(n.threadId, n.requestId) : 1;
    if (n.kind === "approval" && n.requestId && world.rate) {
      try { world.rate(n.threadId, n.requestId, revision); } catch (error) { this.warn("rate", error); /* unrated for this revision: Open only */ }
    }
    const risk: PushRisk = n.kind === "approval" && n.requestId ? world.risk(n.threadId, n.requestId, revision) : "unrated";
    const actionable = n.kind !== "approval" || (n.requestId !== undefined && world.actionable(n.threadId, n.requestId));
    const category = actionable ? pushCategory(n.kind, risk) : "question";
    const held = isAttention(n.kind) && present;
    const messageId = n.messageId ?? world.latestMessageId(n.threadId) ?? null;
    const timeSensitive = n.kind === "approval" && n.requestId ? world.timeSensitive(n.threadId, n.requestId) : false;
    const phoneUsed = this.phoneUsed(n.threadId);
    let created = 0;
    // S39: while the owner is present, an ask turn's done goes to the asking phone alone, with no hold.
    const askOnly = present && !isAttention(n.kind) && n.askDeviceId !== undefined;
    for (const binding of store.bindings()) {
      if (askOnly && binding.deviceId !== n.askDeviceId) continue;
      const eventRef = this.randomRef();
      const secret = store.keySecret(binding.bindingId);
      if (!secret) continue;
      store.insertEvent({
        eventRef, bindingId: binding.bindingId, kind: n.kind, category, botId: n.botId, threadId: n.threadId,
        requestId: n.requestId ?? null, messageId, collapseKey: collapseKey(secret, n.requestId ?? eventRef),
        threadGroup: threadGroup(secret, n.botId), revision, timeSensitive,
        resolvedBy: null, createdAt: now, expiresAt: now + (n.kind === "done" ? DONE_TTL_MS : ATTENTION_TTL_MS),
        holdUntil: held ? now + PRESENCE_HOLD_MS : now, state: held ? "held" : "pending", attempts: 0, nextAttemptAt: now, phoneUsed,
      });
      created++;
    }
    return created;
  }

  /** A phone job is parked (S15): one push, to the one phone chosen for the job. No presence hold, since a job is always for the phone, and no
   *  content: the row carries the operation id as its request id so resolve() can withdraw it. Returns the rows queued (0 or 1). */
  enqueueDeviceJob(n: { bindingId: string; botId: string; threadId: string; operationId: string; expiresAt: number }): number {
    const { store, world } = this;
    if (!world.visible(n.threadId)) return 0;
    if (world.deviceJobCapable && !world.deviceJobCapable(n.bindingId)) return 0;
    const binding = store.binding(n.bindingId);
    const secret = binding ? store.keySecret(binding.bindingId) : null;
    if (!binding || !secret) return 0;
    const now = this.now();
    store.insertEvent({
      eventRef: this.randomRef(), bindingId: binding.bindingId, kind: "device-job", category: "device-job", botId: n.botId, threadId: n.threadId,
      requestId: n.operationId, messageId: null, collapseKey: collapseKey(secret, n.operationId), threadGroup: threadGroup(secret, n.botId),
      revision: store.nextRevision(n.threadId, n.operationId), timeSensitive: false, resolvedBy: null, createdAt: now, expiresAt: n.expiresAt,
      holdUntil: now, state: "pending", attempts: 0, nextAttemptAt: now, phoneUsed: this.phoneUsed(n.threadId),
    });
    return 1;
  }

  /** Answered anywhere: replace what the phone shows (spec §3.4). Something
   *  never sent is dropped instead, so a phone never sees a replacement for
   *  a notification it never had. */
  resolve(threadId: string, requestId: string, where: ResolvedBy): number {
    const { store } = this;
    const now = this.now();
    let created = 0;
    const revision = store.nextRevision(threadId, requestId);
    for (const bindingId of store.bindingsWithRequest(requestId)) {
      const latest = store.latestForRequest(bindingId, requestId);
      if (!latest || latest.threadId !== threadId || latest.category === "resolved" || latest.state === "dropped") continue;
      // "held" and "pending" (never attempted, still retrying, or on the
      // wire) have not landed on the phone: every such row of the request is
      // dropped, recording who answered, so one still on the wire that the
      // relay then accepts is replaced in run(). What the phone does show is
      // any revision already sent, even when a newer one had not landed yet
      // (final re-review N1): that one gets the replacement now.
      const onPhone = latest.state !== "held" && latest.state !== "pending";
      store.dropUnsentForRequest(bindingId, requestId, where);
      if (!onPhone && !store.sentForRequest(bindingId, requestId)) continue;
      this.insertResolved(latest, revision, where, now);
      created++;
    }
    return created;
  }

  private insertResolved(latest: PushEventRow, revision: number, where: ResolvedBy, now: number, expiresAt = latest.expiresAt): void {
    this.store.insertEvent({
      ...latest, eventRef: this.randomRef(), category: "resolved", revision, timeSensitive: false,
      resolvedBy: where, createdAt: now, expiresAt, holdUntil: now, state: "pending", attempts: 0, nextAttemptAt: now,
    });
  }

  /** A bot call rings (T2, T4): one `call` row per phone that rings for calls, due now, never held, expiring at the ring's end.
   *  The request id is the intent id. Written synchronously, so it commits or rolls back with the transition. Returns the rows. */
  ringCall(n: { intentId: string; botId: string; threadId: string; expiresAt: number }): number {
    return this.insertCallRows("call", n.intentId, n.botId, n.threadId, n.expiresAt, (bindingId) => this.store.ringsForCalls(bindingId) === true);
  }

  /** The note push of a call that texted, was missed or went late: one `call-note` row per phone, due now, never held, for 12 h.
   *  Quiet hours are the caller's (the machine's note() writes nothing then). Returns the rows. */
  noteCall(n: { intentId: string; botId: string; threadId: string }): number {
    return this.insertCallRows("call-note", n.intentId, n.botId, n.threadId, this.now() + CALL_NOTE_TTL_MS, () => true);
  }

  private insertCallRows(kind: "call" | "call-note", intentId: string, botId: string, threadId: string, expiresAt: number, rings: (bindingId: string) => boolean): number {
    const { store, world } = this;
    const now = this.now();
    if (expiresAt <= now || !world.visible(threadId)) return 0;
    const revision = store.nextRevision(threadId, intentId);
    const phoneUsed = this.phoneUsed(threadId);
    let created = 0;
    for (const binding of store.bindings()) {
      if (!rings(binding.bindingId)) continue;
      const secret = store.keySecret(binding.bindingId);
      if (!secret) continue;
      store.insertEvent({
        eventRef: this.randomRef(), bindingId: binding.bindingId, kind, category: kind, botId, threadId, requestId: intentId, messageId: null,
        collapseKey: collapseKey(secret, kind === "call" ? intentId : noteCollapseId(intentId)), threadGroup: threadGroup(secret, botId), revision,
        timeSensitive: kind === "call", resolvedBy: null, createdAt: now, expiresAt, holdUntil: now, state: "pending", attempts: 0, nextAttemptAt: now, phoneUsed,
      });
      created++;
    }
    return created;
  }

  /** resolveCall (5.5), which replaces resolve() for a call request: on every phone holding a ring of the intent, the rings never
   *  attempted are dropped, and a phone that MAY have rung (a ring claimed, so possibly on the wire or acknowledged and lost, or
   *  accepted) gets a resolved revision in this same write, living max(the ring's expiry, now + 12 h). So a stop is durable without
   *  the send's callback. Idempotent: a phone whose newest call row is already a resolution is left alone. Notes are not touched.
   *  Returns the resolved revisions written. */
  resolveCall(threadId: string, intentId: string, how: CallResolution): number {
    const { store } = this;
    const now = this.now();
    const where = CALL_RESOLVED_BY[how];
    let revision: number | null = null;
    let created = 0;
    for (const bindingId of store.callBindingsForRequest(intentId)) {
      const latest = store.latestCallRow(bindingId, intentId);
      if (!latest || latest.category === "resolved") continue;
      store.dropUnsentCallRows(bindingId, intentId, where);
      if (!store.callMayHaveRung(bindingId, intentId)) continue;
      revision ??= store.nextRevision(threadId, intentId);
      this.insertResolved(latest, revision, where, now, Math.max(latest.expiresAt, now + CALL_NOTE_TTL_MS));
      created++;
    }
    return created;
  }

  /** Bot-scope cancel (5.6): every unsent call note of the bot. */
  dropCallNotes(botId: string): number {
    return this.store.dropCallNotes(botId);
  }

  /** An accepted send whose row a resolve() dropped while it was on the
   *  wire: the relay will deliver it, so the phone shows an answered
   *  request. Owe it the resolved replacement, unless the request already
   *  has one on this binding, or a newer live revision will supersede it.
   *  Only the row's own stored drop counts: one dropped for another reason
   *  (a hold that ended answered) carries no resolvedBy. */
  private replaceLateAccept(row: PushEventRow): void {
    const { store } = this;
    if (!row.requestId) return;
    const stored = store.event(row.bindingId, row.eventRef);
    if (!stored || stored.state !== "dropped" || stored.resolvedBy === null) return;
    const latest = store.latestForRequest(row.bindingId, row.requestId);
    if (!latest || latest.category === "resolved" || latest.state !== "dropped") return;
    this.insertResolved(latest, store.nextRevision(row.threadId, row.requestId), stored.resolvedBy, this.now());
  }

  pending(bindingId: string): { badge: number; items: Array<{ collapseKey: string; revision: number; category: PushCategory }> } {
    // A hidden thread answers exactly like a missing one (Global Constraints).
    const items = this.store.pendingFor(bindingId, this.now())
      .filter((row) => this.world.visible(row.threadId))
      .filter((row) => !row.requestId || this.world.stillPending(row.threadId, row.requestId))
      .map((row) => ({ collapseKey: row.collapseKey, revision: row.revision, category: row.category }));
    return { badge: this.world.badge(), items };
  }

  flush(): Promise<{ attempted: number }> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<{ attempted: number }> {
    const { store } = this;
    store.prune(this.now());
    let attempted = 0;
    for (const row of store.due(this.now(), FLUSH_LIMIT)) {
      if (await this.attempt(row, SEND_TIMEOUT_MS)) attempted++;
    }
    return { attempted };
  }

  /** Bot calls 5.5: right after a call transition commits, claim and send that request's due rows IN PARALLEL with a 5 s timeout,
   *  never behind the sequential batch. The same exclusive claim and in-flight set as run(), so the two never send one row twice;
   *  run() keeps retrying whatever this did not land, until the row expires. */
  async sendNow(requestId: string): Promise<{ attempted: number }> {
    const rows = this.store.dueForRequest(requestId, this.now());
    const results = await Promise.all(rows.map((row) => this.attempt(row, SEND_NOW_TIMEOUT_MS)));
    return { attempted: results.filter(Boolean).length };
  }

  /** The dispatch fence (5.5): a ring is sent only while its intent is ringing and its deadline is ahead. A world that cannot answer
   *  (left out, or throwing) never rings (fail closed). */
  private ringAllowed(row: PushEventRow): boolean {
    if (row.category !== "call" || !row.requestId) return true;
    if (row.expiresAt <= this.now()) return false;
    try { return this.world.callRinging?.(row.requestId) === true; } catch (error) { this.warn("call-ringing", error); return false; }
  }

  /** One send of one row, shared by run() and sendNow(). Returns whether this path claimed (and so attempted) it. */
  private async attempt(row: PushEventRow, timeoutMs: number): Promise<boolean> {
    const { store, world, sender } = this;
    // Another path holds this row from its claim to its completion (F60).
    if (this.inFlight.has(row.eventRef)) return false;
    // A held row waited out the presence hold: its request may have been
    // answered, or its thread hidden from this device, in the meantime.
    if (row.state === "held" && ((row.requestId && !world.stillPending(row.threadId, row.requestId)) || !world.visible(row.threadId))) {
      store.updateIfState(row.eventRef, "held", { state: "dropped" });
      return false;
    }
    const binding = store.binding(row.bindingId);
    if (!binding) return false;
    // The phone's token pair has expired, so it is no longer enrolled: not
    // an error and not worth a retry. The row is dropped, so it neither
    // loops nor crowds out other bindings' rows in this batch.
    if (binding.tokenExpiresAt != null && binding.tokenExpiresAt <= this.now()) {
      store.updateIfState(row.eventRef, row.state, { state: "dropped" });
      return false;
    }
    if (!this.ringAllowed(row)) {
      store.claim(row.eventRef, row, { state: "dropped", attempts: row.attempts, nextAttemptAt: row.nextAttemptAt });
      return false;
    }
    // The attempt is written down before the send, so a crash cannot lose
    // the backoff, and a ring whose acknowledgement is lost still counts as
    // "may have rung" (5.5). Attempts only set the backoff; only a relay
    // rejection (below) ends the event before it expires. The claim is
    // exclusive: it wins only while the row still has the state AND the
    // attempt count read here, so a resolve() that already dropped it, or
    // another path that already claimed it, makes it fail.
    const attempts = row.attempts + 1;
    const preSendState: PushEventState = "pending";
    const claimed = store.claim(row.eventRef, row, {
      state: preSendState, attempts,
      nextAttemptAt: this.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 20)),
    });
    if (!claimed) return false;
    this.inFlight.add(row.eventRef);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let result: SendResult = "retry";
      try { result = await sender.publish(binding, this.relayEvent(row), controller.signal); }
      catch { /* no provider text, content or credential is kept */ }
      finally { clearTimeout(timer); }
      // Conditional on preSendState: a resolve() reaching this exact row while
      // the send was in flight already moved it to "dropped", and a landing
      // "accepted" must not resurrect it back to "sent". The relay will still
      // deliver it, though, so it is replaced with the resolution.
      if (result === "accepted" && !store.updateIfState(row.eventRef, preSendState, { state: "sent" })) this.replaceLateAccept(row);
      // A 401 is retried like any transient failure: the row keeps its
      // backoff. Only GONE_AFTER_401S in a row, spanning GONE_AFTER_MS, make
      // the binding gone here, so one stray 401 never drops a phone and its
      // queued events. The relay removal is still queued: if the relay really
      // dropped it, the DELETE answers 401 and counts as done; if the 401s
      // came from something in between, the relay binding is not orphaned.
      if (result === "gone" && this.goneNow(binding.bindingId)) store.removeBinding(binding.bindingId);
      if (result !== "gone") this.unauthorized.delete(binding.bindingId);
      if (result === "rejected" && store.updateIfState(row.eventRef, preSendState, { state: "exhausted" })) this.exhausted(row);
    } finally {
      this.inFlight.delete(row.eventRef);
    }
    return true;
  }

  /** Counts a 401 for the binding; true once it is the GONE_AFTER_401S-th in a row and GONE_AFTER_MS after the first. */
  private goneNow(bindingId: string): boolean {
    const now = this.now();
    const seen = this.unauthorized.get(bindingId) ?? { count: 0, firstAt: now };
    seen.count += 1;
    this.unauthorized.set(bindingId, seen);
    if (seen.count < GONE_AFTER_401S || now - seen.firstAt < GONE_AFTER_MS) return false;
    this.unauthorized.delete(bindingId);
    return true;
  }

  private exhausted(row: PushEventRow): void {
    if (!isAttention(row.kind) || row.category === "resolved") return;
    try { this.onExhausted(row); } catch (error) { this.warn("exhausted", error); }
  }

  private relayEvent(row: PushEventRow): RelayEvent {
    return {
      bindingId: row.bindingId, eventRef: row.eventRef, category: row.category, revision: row.revision,
      workspaceBadge: this.world.badge(), collapseKey: row.collapseKey, threadGroup: row.threadGroup,
      timeSensitive: row.timeSensitive, expiresAt: row.expiresAt,
    };
  }
}
