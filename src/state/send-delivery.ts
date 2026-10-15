// A send the person has made is theirs until the server has acknowledged it.
//
// The composer keeps the words until the acknowledgement (see Composer.tsx); the
// outbox only lets a reload carry on delivering. It uses localStorage when it can
// and works without it. Delivery posts with the
// stable sendId (the server reserves each sendId durably, so a repeat never
// runs the words twice). The outbox entry leaves only when the server answered
// (accepted, queued or delivered) or refused for good. A dropped connection,
// a timeout or a server error is NOT a refusal: the line stays on screen as
// "Sending" and delivery is tried again, with the same sendId.

import type { Attachment } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";

export interface OutboxDraft {
  draftId: string;
  text: string;
  requestText: string;
  attachments: Attachment[];
  channelMode?: "chat" | "goal";
  replyToId?: string;
}

export interface OutboxEntry {
  sendId: string;
  kind: "bot" | "group";
  botId?: string;
  groupId?: string;
  threadId: string;
  /** The exact text posted (attachment references included). */
  text: string;
  replyToId?: string;
  mode?: "chat" | "goal";
  responderId?: string;
  draft?: OutboxDraft;
  /** Set by the chip's Send again: the server runs a restore-held send only on this. */
  resend?: true;
  /** The restore generation the chip carried: Send again presents it, and the server runs a held send only for the newest restore's. */
  restoreGen?: string;
  /** The stop token the chip carried: the server runs a stopped send only for a press made after that Stop. */
  stopGen?: string;
  /** Minted fresh by the press; an automatic retry of this entry replays it, so it never runs anything the press did not. */
  actionId?: string;
  at: number;
  attempts: number;
}

type OutboxStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

const KEY = "murage-send-outbox";
/** Unresolved sends the outbox holds. Every entry here is unresolved (a resolved one
 * has already left), so past this a new send is refused and its words stay in the
 * composer; nothing the person already sent is ever evicted. */
export const MAX_OUTBOX_ENTRIES = 50;
/** One POST (and the settings wait before it) may take this long before it is abandoned and retried. */
export const ATTEMPT_TIMEOUT_MS = 45_000;
/** After this long without any answer the send is given back to the person to resend. */
export const OUTBOX_GIVE_UP_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return typeof e.sendId === "string" && (e.kind === "bot" || e.kind === "group") && typeof e.threadId === "string"
    && typeof e.text === "string" && typeof e.at === "number" && typeof e.attempts === "number"
    && (e.kind === "bot" ? typeof e.botId === "string" : typeof e.groupId === "string");
}

export function createOutbox(storage: OutboxStorage | undefined) {
  let memory: OutboxEntry[] | null = null;
  const read = (): OutboxEntry[] => {
    if (memory) return memory;
    let parsed: unknown;
    try { parsed = storage ? JSON.parse(storage.getItem(KEY) ?? "[]") : []; } catch { parsed = []; }
    memory = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    return memory;
  };
  /** True when the entries are on disk (or there is no disk to write to). */
  const write = (next: OutboxEntry[]): boolean => {
    memory = next;
    try { storage?.setItem(KEY, JSON.stringify(memory)); return true; } catch { return false; }
  };
  return {
    list: (): OutboxEntry[] => [...read()],
    has: (sendId: string): boolean => read().some((entry) => entry.sendId === sendId),
    /** The outbox is a convenience for a reload, not the thing that makes a send safe: the composer
     * keeps the words until the server acknowledges, and the server records each sendId durably.
     * So a missing, blocked or full localStorage never stops a send; the entry is held in memory
     * for this page. Only "full" (too many unresolved sends) leaves the outbox as it was. */
    add(entry: OutboxEntry): "ok" | "full" {
      const before = read();
      const others = before.filter((existing) => existing.sendId !== entry.sendId);
      if (others.length >= MAX_OUTBOX_ENTRIES) return "full";
      write([...others, entry]);
      return "ok";
    },
    remove(sendId: string): void {
      const rest = read().filter((entry) => entry.sendId !== sendId);
      if (rest.length !== read().length) write(rest);
    },
    bump(sendId: string): void {
      write(read().map((entry) => (entry.sendId === sendId ? { ...entry, attempts: entry.attempts + 1 } : entry)));
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

/** The server's "the database is locked for a moment" answer: 503 with code DATABASE_BUSY and a Retry-After. The send did not
 * run, so the same send id is repeated; this is never a refusal, whatever status carries it (an older server answered 409). */
export function isBusyRefusal(error: unknown): boolean {
  const e = error as { status?: unknown; body?: { code?: unknown } } | null;
  return e?.body?.code === "DATABASE_BUSY" || e?.status === 503;
}
/** The server's own busy answer and nothing else: the body names DATABASE_BUSY. A settings write or a delete is repeated only
 * on this (api(), store.tsx); any other 503 (a failed save, a gateway) is the answer the person sees, on the first try. */
export function isDatabaseBusyAnswer(error: unknown): boolean {
  return (error as { body?: { code?: unknown } } | null)?.body?.code === "DATABASE_BUSY";
}
/** How long to wait before repeating a send that met a busy answer: its Retry-After (seconds, in the body), at least a second, at most five. */
export function busyRetryDelayMs(error: unknown): number {
  const seconds = Number((error as { body?: { retryAfterSeconds?: unknown } } | null)?.body?.retryAfterSeconds);
  return Math.min(5_000, Math.max(1_000, Number.isFinite(seconds) ? seconds * 1_000 : 1_000));
}
/** Repeats `run` (a request that carries its own send id) while the server answers busy, a few times; any other outcome is returned or thrown as it is. */
export async function retryWhileBusy<T>(run: () => Promise<T>, options: { tries?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const tries = options.tries ?? 4, wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (!isBusyRefusal(error) || attempt >= tries) throw error;
      await wait(busyRetryDelayMs(error));
    }
  }
}

/** Methods whose repeat changes nothing a first run did not: a delete, a settings PUT or PATCH. api() repeats these on a busy answer; any other
 *  method is tried once (a POST repeats only where it carries its own sendId: the sends and deliverEdit). */
const IDEMPOTENT_WRITES: ReadonlySet<string> = new Set(["PUT", "PATCH", "DELETE"]);
export function busyRetriesFor(method: string | undefined): number { return IDEMPOTENT_WRITES.has((method ?? "GET").toUpperCase()) ? 4 : 1; }
/** How long an edit may stay unanswered, busy repeats included, before the editor gets its words back. */
export const EDIT_DEADLINE_MS = 20_000;
/** An edit of a sent message: posted under ONE sendId for every repeat (the server answers a repeat of an edit it already forked with that fork,
 *  never a second fork), repeated while the server answers busy (Retry-After, a few times), all within `deadlineMs` (EDIT_DEADLINE_MS). The
 *  editor keeps the words until `onSent`; on a failure or the deadline `onFailed` runs and the words are still the caller's to put back in the
 *  editor. Exactly one of them runs, once. `signal` is the person's Cancel: the delivery stops (its request is aborted, no more repeats) and
 *  neither hook runs, since the caller already gave the words back. */
export function deliverEdit(
  post: (sendId: string, signal: AbortSignal) => Promise<unknown>,
  hooks: { sendId: string; onSent?: () => void; onFailed: (error: unknown) => void },
  options: { tries?: number; wait?: (ms: number) => Promise<void>; deadlineMs?: number; setTimer?: (fn: () => void, ms: number) => () => void; signal?: AbortSignal } = {},
): Promise<void> {
  const stop = new AbortController();
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
  return new Promise<void>((resolve) => {
    let settled = false;
    let cancelDeadline: () => void = () => {};
    const onCancel = () => settle();
    function settle(outcome?: () => void): void {
      if (settled) return;
      settled = true;
      cancelDeadline();
      options.signal?.removeEventListener("abort", onCancel);
      stop.abort();
      try { outcome?.(); } finally { resolve(); }
    }
    if (options.signal?.aborted) { settle(); return; }
    options.signal?.addEventListener("abort", onCancel, { once: true });
    cancelDeadline = setTimer(() => settle(() => hooks.onFailed(Object.assign(new Error(attemptTimedOutSentence()), { status: 408 }))), options.deadlineMs ?? EDIT_DEADLINE_MS);
    retryWhileBusy(() => (stop.signal.aborted ? Promise.reject(new Error("edit stopped")) : post(hooks.sendId, stop.signal)), options)
      .then(() => settle(() => hooks.onSent?.()), (error: unknown) => settle(() => hooks.onFailed(error)));
  });
}

/** A refusal the server meant: retrying the same words cannot succeed. */
export function isDefinitiveFailure(error: unknown): boolean {
  if (isBusyRefusal(error)) return false;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

export interface DeliveryHooks {
  /** The server answered; `body` is its receipt. */
  onReceipt?: (entry: OutboxEntry, body: any) => void;
  /** A definitive refusal, or the give-up. Return true when handled; otherwise the default recovery runs. */
  onFailed?: (entry: OutboxEntry, error: unknown) => boolean | void;
}

export interface DeliveryDeps {
  outbox: Outbox;
  /** `signal` aborts when the attempt times out. */
  post: (entry: OutboxEntry, signal?: AbortSignal) => Promise<any>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** The line shows as "Sending" until a receipt or a failure. */
  showSending: (entry: OutboxEntry) => void;
  settleSending: (entry: OutboxEntry) => void;
  /** Gives the words back to the person after a definitive failure with nobody to tell. */
  recover: (entry: OutboxEntry, error: unknown) => void;
  receipt: (entry: OutboxEntry, body: any) => void;
  /** The server already held a send this device still had in its outbox (a reload, with no composer
   * waiting on it): lets the draft that sent it clear, as an acknowledgement would. */
  acknowledgeDraft?: (entry: OutboxEntry) => void;
  /** The server shows this send as a refused chip: every local copy of its words (restored draft, retry
   * lists, frozen composer) gives way to the chip. Runs after the composer callback is settled. */
  releaseRefused?: (sendId: string, entry?: OutboxEntry) => void;
  /** Starts the per-attempt clock; returns its cancel. Defaults to setTimeout. */
  attemptTimer?: (fn: () => void, ms: number) => () => void;
  attemptTimeoutMs?: number;
}

/** Spelled in the person's language when the error is made (locale pack keys send.outboxFull, send.timedOut). */
export const outboxFullSentence = (): string => t("send.outboxFull");
const attemptTimedOutSentence = (): string => t("send.timedOut");

export function createSendDelivery(deps: DeliveryDeps) {
  const inFlight = new Set<string>();
  const hooksFor = new Map<string, DeliveryHooks>();
  /** Send ids the server refused (it shows a chip). Remembered even while a POST is in flight, so that POST
   * failing later is not retried by itself: only the chip's Send again resends. */
  const refusedByServer = new Set<string>();
  /** Send ids whose in-flight POST was replaced by a resubmission: that POST's outcome only cleans up. */
  const superseded = new Set<string>();
  /** At most one resubmission per send id waits for the in-flight POST of the same id to end. */
  const queued = new Map<string, { entry: OutboxEntry; hooks: DeliveryHooks; resolve: () => void }>();
  const REFUSED = () => Object.assign(new Error("refused by server"), { status: 409 });

  /** Every composer hook set is settled exactly once (receipt OR failure), however many paths reach it. */
  const once = (hooks: DeliveryHooks): DeliveryHooks => {
    let settled = false;
    return {
      onReceipt: (e, body) => { if (settled) return; settled = true; hooks.onReceipt?.(e, body); },
      onFailed: (e, err) => { if (settled) return true; settled = true; return hooks.onFailed?.(e, err); },
    };
  };

  const retryLater = (entry: OutboxEntry, error?: unknown) => {
    const delay = isBusyRefusal(error) ? busyRetryDelayMs(error) : RETRY_DELAYS_MS[Math.min(entry.attempts, RETRY_DELAYS_MS.length - 1)]!;
    deps.setTimer(() => { void attempt(entry.sendId); }, delay);
  };

  const finishFailed = (entry: OutboxEntry, error: unknown) => {
    deps.outbox.remove(entry.sendId);
    deps.settleSending(entry);
    const hooks = hooksFor.get(entry.sendId);
    hooksFor.delete(entry.sendId);
    const handled = hooks?.onFailed?.(entry, error);
    if (handled !== true) deps.recover(entry, error);
  };

  /** The ONE place a send id is resolved against a server refusal: outbox entry, "Sending" line, composer
   * callback (so a frozen composer is released), draft and retry lists. Safe to call at any time and repeatedly. */
  const resolveRefused = (sendId: string) => {
    refusedByServer.add(sendId);
    if (inFlight.has(sendId)) return; // the POST in flight settles through here when it ends
    const entry = deps.outbox.list().find((candidate) => candidate.sendId === sendId);
    const hooks = hooksFor.get(sendId);
    hooksFor.delete(sendId);
    if (entry) {
      deps.outbox.remove(sendId);
      deps.settleSending(entry);
    }
    if (entry && hooks?.onFailed) {
      hooks.onFailed(entry, Object.assign(new Error("refused by server"), { status: 409 }));
    }
    deps.releaseRefused?.(sendId, entry);
  };

  async function attempt(sendId: string): Promise<void> {
    const entry = deps.outbox.list().find((candidate) => candidate.sendId === sendId);
    if (!entry || inFlight.has(sendId)) return;
    // The overall deadline holds whether or not an attempt ever fails cleanly.
    if (deps.now() - entry.at > OUTBOX_GIVE_UP_MS) {
      finishFailed(entry, Object.assign(new Error(attemptTimedOutSentence()), { status: 408 }));
      return;
    }
    inFlight.add(sendId);
    const controller = new AbortController();
    let cancelTimer: () => void = () => {};
    try {
      // Each attempt has its own clock: a POST or settings wait that never settles
      // is abandoned, counts as a failed attempt, and is retried with the same sendId.
      const remaining = Math.max(1, OUTBOX_GIVE_UP_MS - (deps.now() - entry.at));
      const limit = Math.min(deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS, remaining);
      const timedOut = new Promise<never>((_, reject) => {
        const fire = () => { controller.abort(); reject(Object.assign(new Error(attemptTimedOutSentence()), { status: 408 })); };
        if (deps.attemptTimer) cancelTimer = deps.attemptTimer(fire, limit);
        else { const handle = setTimeout(fire, limit); cancelTimer = () => clearTimeout(handle); }
      });
      timedOut.catch(() => {});
      const body = await Promise.race([deps.post(entry, controller.signal), timedOut]);
      if (superseded.has(sendId) && refusedByServer.has(sendId)) {
        // A refusal was observed for this id, so this late success must not consume the queued resend: the resend
        // starts when this attempt ends (the server re-admits a refused id; a durable row dedupes if it was accepted).
        return;
      }
      if (superseded.has(sendId)) {
        // The original was already settled when it was replaced; the server has this id, so the waiting resend is acknowledged too.
        deps.receipt(entry, body);
        const waiting = queued.get(sendId);
        queued.delete(sendId);
        if (waiting) { waiting.hooks.onReceipt?.(waiting.entry, body); waiting.resolve(); }
        return;
      }
      deps.outbox.remove(sendId);
      deps.settleSending(entry);
      deps.receipt(entry, body);
      const hooks = hooksFor.get(sendId);
      hooksFor.delete(sendId);
      // After a reload no composer hook is stored: the same guarded fallback as reconcile clears the draft that sent it.
      if (hooks?.onReceipt) hooks.onReceipt(entry, body);
      else deps.acknowledgeDraft?.(entry);
    } catch (error) {
      if (superseded.has(sendId)) {
        // Already settled when replaced; the queued resend (started below) is the one retry.
      } else if (refusedByServer.has(sendId)) {
        // The server refused this id while the POST was out: no automatic retry, the chip's Send again resends.
        inFlight.delete(sendId);
        resolveRefused(sendId);
      } else if (isDefinitiveFailure(error) || deps.now() - entry.at > OUTBOX_GIVE_UP_MS) {
        finishFailed(entry, error);
      } else {
        deps.outbox.bump(sendId);
        const bumped = deps.outbox.list().find((candidate) => candidate.sendId === sendId) ?? entry;
        retryLater(bumped, error);
      }
    } finally {
      cancelTimer();
      inFlight.delete(sendId);
      superseded.delete(sendId);
      const next = queued.get(sendId);
      if (next) {
        queued.delete(sendId);
        void begin(next.entry, next.hooks).then(next.resolve);
      }
    }
  }

  function begin(entry: OutboxEntry, hooks: DeliveryHooks): Promise<void> {
    refusedByServer.delete(entry.sendId); // a fresh send (the chip's Send again) is a new attempt
    const held = deps.outbox.add(entry);
    if (held !== "ok") {
      // Not durable, so not sent and not shown as sent: the words stay with the person.
      const error = Object.assign(new Error(outboxFullSentence()), { status: 507, outbox: held });
      if (hooks.onFailed?.(entry, error) !== true) deps.recover(entry, error);
      return Promise.resolve();
    }
    hooksFor.set(entry.sendId, hooks);
    deps.showSending(entry);
    return attempt(entry.sendId);
  }

  return {
    /** Write the outbox entry, show the line, post. Call BEFORE the composer clears. */
    submit(entry: OutboxEntry, rawHooks: DeliveryHooks = {}): Promise<void> {
      const hooks = once(rawHooks);
      const sendId = entry.sendId;
      if (!inFlight.has(sendId)) return begin(entry, hooks);
      // A POST for this id is still out (the chip's Send again during it). Never overwrite the live entry or its hooks:
      // settle the original now (its composer thaws), then run this one after the in-flight POST ends.
      const original = deps.outbox.list().find((candidate) => candidate.sendId === sendId);
      const originalHooks = hooksFor.get(sendId);
      hooksFor.delete(sendId);
      superseded.add(sendId);
      if (original) {
        deps.outbox.remove(sendId);
        deps.settleSending(original);
        originalHooks?.onFailed?.(original, REFUSED());
      }
      const earlier = queued.get(sendId);
      if (earlier) earlier.hooks.onFailed?.(earlier.entry, REFUSED()); // double click: only the latest resend runs
      return new Promise<void>((resolve) => {
        queued.set(sendId, { entry, hooks, resolve });
        if (earlier) earlier.resolve();
      });
    },
    /** Invariant check: at most one outbox entry and one in-flight POST per send id; no live hooks without an entry. */
    audit(): string[] {
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const e of deps.outbox.list()) {
        if (seen.has(e.sendId)) problems.push(`duplicate outbox entry ${e.sendId}`);
        seen.add(e.sendId);
      }
      for (const id of hooksFor.keys()) if (!seen.has(id)) problems.push(`hooks without an outbox entry ${id}`);
      for (const id of queued.keys()) if (!inFlight.has(id)) problems.push(`queued resend without an in-flight POST ${id}`);
      return problems;
    },
    /** After a (re)connect or reload: drop what the server already has a receipt for, deliver the rest. */
    reconcile(known: { messageSendIds: ReadonlySet<string>; pendingSendIds: ReadonlySet<string> }): void {
      for (const entry of deps.outbox.list()) {
        if (inFlight.has(entry.sendId)) continue;
        if (known.messageSendIds.has(entry.sendId) || known.pendingSendIds.has(entry.sendId)) {
          // The server accepted it while the acknowledgement was lost: this is that acknowledgement.
          // The same callback a receipt runs, so the composer clears its draft and stops waiting.
          deps.outbox.remove(entry.sendId);
          deps.settleSending(entry);
          const hooks = hooksFor.get(entry.sendId);
          hooksFor.delete(entry.sendId);
          if (hooks?.onReceipt) hooks.onReceipt(entry, { reconciled: true });
          else deps.acknowledgeDraft?.(entry);
          continue;
        }
        deps.showSending(entry);
        void attempt(entry.sendId);
      }
    },
    /** The server shows this id as a refused chip, or the person dismissed or re-sent it: see resolveRefused. */
    resolveRefused,
    forget: resolveRefused,
    inFlight: (sendId: string): boolean => inFlight.has(sendId),
  };
}
