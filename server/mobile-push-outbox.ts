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

export const ATTENTION_TTL_MS = 12 * 3600_000;
export const DONE_TTL_MS = 3600_000;
/** A transient failure backs off, doubling to this cap, until the event expires. */
export const MAX_BACKOFF_MS = 300_000;
const SEND_TIMEOUT_MS = 10_000;
const FLUSH_LIMIT = 20;

export interface OutboxNotification { kind: PushKind; botId: string; threadId: string; requestId?: string; messageId?: string }
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

  enqueue(n: OutboxNotification): number {
    const { store, world } = this;
    const now = this.now();
    const present = world.present();
    if (!isAttention(n.kind) && present) return 0;
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
    let created = 0;
    for (const binding of store.bindings()) {
      const eventRef = this.randomRef();
      const secret = store.keySecret(binding.bindingId);
      if (!secret) continue;
      store.insertEvent({
        eventRef, bindingId: binding.bindingId, kind: n.kind, category, botId: n.botId, threadId: n.threadId,
        requestId: n.requestId ?? null, messageId, collapseKey: collapseKey(secret, n.requestId ?? eventRef),
        threadGroup: threadGroup(secret, n.botId), revision, timeSensitive,
        resolvedBy: null, createdAt: now, expiresAt: now + (n.kind === "done" ? DONE_TTL_MS : ATTENTION_TTL_MS),
        holdUntil: held ? now + PRESENCE_HOLD_MS : now, state: held ? "held" : "pending", attempts: 0, nextAttemptAt: now,
      });
      created++;
    }
    return created;
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

  private insertResolved(latest: PushEventRow, revision: number, where: ResolvedBy, now: number): void {
    this.store.insertEvent({
      ...latest, eventRef: this.randomRef(), category: "resolved", revision, timeSensitive: false,
      resolvedBy: where, createdAt: now, holdUntil: now, state: "pending", attempts: 0, nextAttemptAt: now,
    });
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
    const { store, world, sender } = this;
    store.prune(this.now());
    let attempted = 0;
    for (const row of store.due(this.now(), FLUSH_LIMIT)) {
      // A held row waited out the presence hold: its request may have been
      // answered, or its thread hidden from this device, in the meantime.
      if (row.state === "held" && ((row.requestId && !world.stillPending(row.threadId, row.requestId)) || !world.visible(row.threadId))) {
        store.update(row.eventRef, { state: "dropped" });
        continue;
      }
      const binding = store.binding(row.bindingId);
      if (!binding) continue;
      // The phone's token pair has expired, so it is no longer enrolled: not
      // an error and not worth a retry. The row is dropped, so it neither
      // loops nor crowds out other bindings' rows in this batch.
      if (binding.tokenExpiresAt != null && binding.tokenExpiresAt <= this.now()) {
        store.updateIfState(row.eventRef, row.state, { state: "dropped" });
        continue;
      }
      // The attempt is written down before the send, so a crash cannot lose
      // the backoff. Attempts only set the backoff; only a relay rejection
      // (below) ends the event before it expires. Claiming is conditional on
      // the row still being in the state due() returned it in: a resolve()
      // reaching this same row earlier in this same batch (from another row's
      // send, or between batches) already moved it to "dropped", and that
      // must not be undone here.
      const attempts = row.attempts + 1;
      const preSendState: PushEventState = "pending";
      const claimed = store.updateIfState(row.eventRef, row.state, {
        state: preSendState, attempts,
        nextAttemptAt: this.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 20)),
      });
      if (!claimed) continue;
      attempted++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      let result: SendResult = "retry";
      try { result = await sender.publish(binding, this.relayEvent(row), controller.signal); }
      catch { /* no provider text, content or credential is kept */ }
      finally { clearTimeout(timer); }
      // Conditional on preSendState: a resolve() reaching this exact row while
      // the send was in flight already moved it to "dropped", and a landing
      // "accepted" must not resurrect it back to "sent". The relay will still
      // deliver it, though, so it is replaced with the resolution.
      if (result === "accepted" && !store.updateIfState(row.eventRef, preSendState, { state: "sent" })) this.replaceLateAccept(row);
      // A 401: the binding is gone here. The relay removal is still queued:
      // if the relay really dropped it, the DELETE answers 401 and counts as
      // done; if the 401 came from something in between, the relay binding
      // is not orphaned.
      if (result === "gone") store.removeBinding(binding.bindingId);
      if (result === "rejected" && store.updateIfState(row.eventRef, preSendState, { state: "exhausted" })) this.exhausted(row);
    }
    return { attempted };
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
