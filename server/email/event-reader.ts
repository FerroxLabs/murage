// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bot email event reader (BOT-EMAIL-MURAGE-109 5.1, F24). One long-poll per install on #28 (`wait=25`) with the email:owner
// credential, and only while the launch switch is on and at least one binding can receive mail: nothing polls while email is dark, while
// every binding is restored_unverified, account_off, failed or being removed.
//
// A batch is applied in one store transaction: every eev_ id is recorded once (email_events, envelopes only: Flux sends no bodies on #28),
// the send rows move (send.applyEvent), the arrival notices are written and the cursor advances, or none of it happens. Lifecycle events
// (pause, grace, closing, renewed, deleted) then mirror into the bindings, which may read #5. `410 cursor_expired` re-lists what the
// expired window could have carried (messages since the last seen event, the pending approvals #19 and every bound inbox #5), then takes
// `latest_cursor`. 503 and every outage back off, doubling up to a ceiling.
import type { FluxEmailClient, EmailEvent } from "./flux-email-client.ts";
import type { EmailStore, BindingState } from "./email-store.ts";
import type { EmailSendService } from "./send-service.ts";
import type { EmailBindingService } from "./binding-service.ts";
import { addrSpec } from "./tools.ts";
import { isFilteredMail, isHeldForOwner } from "./inbound.ts";

/** The binding states whose inbox receives mail (closing is owner-only; restored_unverified and account_off never poll, F23). */
export const RECEIVING_STATES: ReadonlySet<BindingState> = new Set<BindingState>(["active", "paused", "billing_hold", "grace"]);
export const EVENT_CURSOR_SCOPE = "events";
export const EVENT_LAST_SEEN_SCOPE = "events-last-seen";
const OWNER = { kind: "owner" } as const;
const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CEILING_MS = 300_000;
const IDLE_MS = 30_000;
const LIFECYCLE = /^email\.(bot\.(paused|resumed)|inbox\.(grace|closing|renewed|restored|credited|deleted|renewal_due)|account\.(enabled|disabled))$/;

/** One inbound email as the owner's notice reads it: the bare sender address and where it goes, never a subject or text. */
export interface EmailArrival { botId: string; inboxId: string; messageId: string | null; from: string; heldForOwner: boolean; filtered: boolean }

export interface EventReaderOptions {
  store: EmailStore;
  client: FluxEmailClient;
  send: EmailSendService;
  bindings: EmailBindingService;
  /** The launch switch (probe enabled). */
  enabled: () => boolean;
  /** The owner's arrival notices, per bot, grouped (5.2). Runs inside the batch's transaction; it never starts a turn. */
  onArrivals?: (botId: string, arrivals: EmailArrival[]) => void;
  onRefusal?: (code: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type PollResult = "idle" | "ok" | "expired" | "backoff";

export class EmailEventReader {
  private readonly options: EventReaderOptions;
  private running = false;
  private failures = 0;
  private wakeIdle: (() => void) | null = null;
  constructor(options: EventReaderOptions) { this.options = options; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Whether this install polls now: the switch is on and a binding can receive. */
  shouldPoll(): boolean {
    if (!this.options.enabled()) return false;
    return this.options.store.bindings().some(row => Boolean(row.inboxId) && RECEIVING_STATES.has(row.state));
  }

  /** The wait before the next poll after `failures` outages in a row: 2 s doubling, never above the ceiling. */
  static backoffMs(failures: number): number { return failures <= 0 ? 0 : Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20)); }
  backoff(): number { return EmailEventReader.backoffMs(this.failures); }

  /** One long-poll and its batch. */
  async pollOnce(): Promise<PollResult> {
    if (!this.shouldPoll()) return "idle";
    const { store, client } = this.options;
    const cursor = store.getCursor(EVENT_CURSOR_SCOPE) ?? undefined;
    const answer = await client.events(OWNER, { cursor, wait: 25, limit: 50 });
    if (answer.kind === "refused" && answer.status === 410 && answer.code === "cursor_expired") {
      const latest = typeof answer.error.fields.latest_cursor === "string" ? answer.error.fields.latest_cursor : null;
      const ok = await this.relist();
      // the cursor moves only after the re-list read everything it could; a partial re-list keeps the old cursor and backs off
      if (!ok || !latest) { this.failures++; return "backoff"; }
      store.setCursor(EVENT_CURSOR_SCOPE, latest, this.now());
      this.failures = 0;
      return "expired";
    }
    if (answer.kind !== "ok") {
      if (answer.kind === "refused") this.options.onRefusal?.(answer.code);
      this.failures++;
      return "backoff";
    }
    const events = Array.isArray(answer.body.data) ? answer.body.data.filter(isEvent) : [];
    const next = typeof answer.body.next_cursor === "string" && answer.body.next_cursor ? answer.body.next_cursor : null;
    const lifecycle = this.applyBatch(events, next);
    // section 8: the account the events belong to; a binding made under another account waits for Reconnect
    const account = events.map(event => (event as { account_id?: unknown }).account_id).find((id): id is string => typeof id === "string" && /^[\w.:-]{1,120}$/.test(id));
    if (account) { try { this.options.bindings.noteAccount(account); } catch { /* the next batch says it again */ } }
    for (const event of lifecycle) {
      try { await this.options.bindings.applyLifecycle(event); } catch (error) { this.options.log?.(`[email] lifecycle: ${(error as Error)?.message ?? error}`); }
    }
    this.failures = 0;
    return "ok";
  }

  /** Records, applies and acknowledges one batch in one transaction. Returns the fresh lifecycle events, applied after the commit. */
  applyBatch(events: EmailEvent[], nextCursor: string | null): EmailEvent[] {
    const { store, send } = this.options;
    return store.tx(() => {
      const lifecycle: EmailEvent[] = [];
      const arrivals = new Map<string, EmailArrival[]>();
      let lastSeen: string | null = null;
      for (const event of events) {
        if (typeof event.created === "string") lastSeen = event.created;
        if (store.hasEvent(event.id)) continue;
        // send.applyEvent records the eev_ id (with its envelope) and moves the send row it names, if any
        send.applyEvent(event);
        if (!store.hasEvent(event.id)) store.recordEvent({ eventId: event.id, type: event.type, inboxId: event.inbox_id ?? null, botId: event.bot_id ?? null, clientReference: null, heldId: null, created: event.created ?? null, data: event.data ?? {} }, this.now());
        if (LIFECYCLE.test(event.type)) lifecycle.push(event);
        else if (event.type === "email.message.received") {
          const arrival = this.arrival(event);
          if (arrival) { const list = arrivals.get(arrival.botId) ?? []; list.push(arrival); arrivals.set(arrival.botId, list); }
        }
      }
      for (const [botId, list] of arrivals) {
        try { this.options.onArrivals?.(botId, list); } catch (error) { this.options.log?.(`[email] arrival notice: ${(error as Error)?.message ?? error}`); }
      }
      if (lastSeen) store.setCursor(EVENT_LAST_SEEN_SCOPE, lastSeen, this.now());
      if (nextCursor) store.setCursor(EVENT_CURSOR_SCOPE, nextCursor, this.now());
      return lifecycle;
    });
  }

  private arrival(event: EmailEvent): EmailArrival | null {
    const data = event.data ?? {};
    const binding = event.inbox_id ? this.options.store.bindingByInbox(event.inbox_id) : null;
    if (!binding || !RECEIVING_STATES.has(binding.state)) return null;
    const from = addrSpec(data.from);
    if (!from) return null;
    return { botId: binding.botId, inboxId: event.inbox_id!, messageId: typeof data.message_id === "string" ? data.message_id : null, from, heldForOwner: isHeldForOwner(data), filtered: isFilteredMail(data) };
  }

  /** F24: what an expired cursor could have carried. Inbound mail since the last seen event becomes arrival notices (deduplicated by
   *  message id), outbound mail settles its send rows, and #19 and #5 are read again. True when every read answered. */
  async relist(): Promise<boolean> {
    const { store, client, send, bindings } = this.options;
    let complete = true;
    const since = store.getCursor(EVENT_LAST_SEEN_SCOPE) ?? undefined;
    const bound = store.bindings().filter(row => row.inboxId && RECEIVING_STATES.has(row.state));
    for (const row of bound) {
      const inboxId = row.inboxId!;
      let pageCursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const listed = await client.listMessages(OWNER, inboxId, { since, limit: 100, ...(pageCursor ? { cursor: pageCursor } : {}) });
        if (listed.kind !== "ok") { complete = false; break; }
        const synthetic: EmailEvent[] = [];
        for (const message of listed.body.data ?? []) {
          if (!message || typeof message.id !== "string") continue;
          const record = message as Record<string, unknown>;
          if (message.direction === "outbound") {
            if (typeof message.client_reference === "string") synthetic.push({ id: `relist:sent:${message.id}`, type: "email.message.sent", inbox_id: inboxId, created: typeof record.created_at === "string" ? record.created_at : undefined, data: { message_id: message.id, client_reference: message.client_reference } });
          } else {
            synthetic.push({ id: `relist:received:${message.id}`, type: "email.message.received", inbox_id: inboxId, created: typeof record.received_at === "string" ? record.received_at : undefined, data: { ...pickEnvelope(record), message_id: message.id } });
          }
        }
        this.applyBatch(synthetic, null);
        pageCursor = typeof listed.body.next_cursor === "string" && listed.body.next_cursor ? listed.body.next_cursor : undefined;
        if (!pageCursor) break;
      }
      const inbox = await bindings.refresh(row.botId).catch(() => null);
      if (!inbox) complete = false;
    }
    // #19: a hold whose approval left the pending list (approved, expired or cancelled while the cursor was dead) is re-read
    const approvals = await client.listApprovals(OWNER, { state: "pending" });
    if (approvals.kind === "ok") {
      const pending = new Set((approvals.body.data ?? []).map(item => item.id));
      await send.afterEventGap(pending);
    } else complete = false;
    return complete;
  }

  /** The loop: polls while it should, idles while it should not, backs off after an outage. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }
  stop(): void { this.running = false; this.wakeIdle?.(); }
  /** A binding or the switch changed: an idle reader looks again now. */
  wake(): void { this.wakeIdle?.(); }

  private async loop(): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.();
      this.wakeIdle = () => { clearTimeout(timer); resolve(); };
    }));
    while (this.running) {
      let result: PollResult;
      try { result = await this.pollOnce(); } catch (error) { this.options.log?.(`[email] events: ${(error as Error)?.message ?? error}`); this.failures++; result = "backoff"; }
      if (!this.running) break;
      if (result === "idle") await sleep(IDLE_MS);
      else if (result === "backoff") await sleep(this.backoff());
      this.wakeIdle = null;
    }
  }
}

function isEvent(value: unknown): value is EmailEvent {
  return !!value && typeof value === "object" && typeof (value as EmailEvent).id === "string" && typeof (value as EmailEvent).type === "string";
}

/** The envelope fields an arrival needs from a re-listed message (no subject or text is kept from a re-list). */
function pickEnvelope(message: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["from", "thread_id", "spam", "blocked", "hidden", "trust", "sender_authenticated", "held_for_owner"]) if (key in message) out[key] = message[key];
  return out;
}
