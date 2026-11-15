// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux Memory capture after the turn (FLUX-OFF-HEADERS-104 round 2). Flux captures a Murage turn ONLY on an
// explicit request: a header can switch memory off but never on, and a Murage key gets no default-on capture.
// So Murage itself posts each finished memory-on turn to the Flux Memory API, from this process, with the
// Flux key. It sits at the server's one dispatch point and its one event fold (like flux-memory-first-token.ts),
// never in a driver, so every engine is covered the same way, OpenClaw and Custom ACP included.
//
// Target (FLUX-SPACES-CAPTURE-FORGET-106 R4): the replying bot's space, POST /v1/memory/spaces/bot:<hmac>/events, with the
// conversation named in metadata.thread (an HMAC tag), so deleting the conversation asks Flux to forget that thread and deleting the
// bot deletes its space (flux-memory-forget.ts). The space and tag are noted in the ledger before the request leaves; the receipt
// after a 202. An older proxy without the route (404/405) means "not available": nothing is sent anywhere else. A 409 means Flux
// Memory is off for this key (or the thread was forgotten); a 429 memory_end_user_limit means the account is full; a 404
// memory_not_found means the bot's space was shredded. A bot set to "Ask me before it changes anything" sends nothing.
//
// Memory off is structural: `begin` keeps an entry only for a turn whose decision is capture on, and `observe`
// can send only from an entry. A guest, background, prewarm, asks-first, kill-switch, "Use Flux memory" off,
// memory-off or excluded-thread turn has no entry, so there is nothing to send.
import { createHash } from "node:crypto";
import { fluxUsageHeaders } from "./flux-usage-tags.ts";

import type { SendTurnInput } from "./contracts.ts";
import { FLUX_MEMORY_APP, FLUX_MEMORY_APP_HEADER, fluxMemoryContextForTurn, fluxMemoryDecision, type FluxMemoryContext } from "./flux-memory-headers.ts";
import { FLUX_FORGET_GRACE_MS, FLUX_SPACE, FLUX_SPACE_GONE_CODE, fluxKeyFingerprint, type FluxCaptureTarget } from "./flux-memory-spaces.ts";
import { redactSecretsInText } from "./redact.ts";
import { readBotLearning } from "./bot-learning.ts";
import { readMemoryLearning } from "./memory/learning-policy.ts";
import type { DatabaseSync } from "node:sqlite";

/** The current bot policy, read again before each external capture attempt. */
export function fluxBotCapturePaused(db: DatabaseSync, bot: { id: string; learning?: unknown } | null | undefined): boolean {
  if (!bot) return true;
  const learning = readBotLearning(bot);
  return !learning.enabled || learning.askFirst || readMemoryLearning(db).botsPaused.includes(bot.id);
}

/** The Flux Memory API base (FluxMain: direct calls under /v1/memory from Murage's process). */
export const FLUX_MEMORY_API_BASE = "https://api.fluxrouter.ai/v1/memory";
/** Each side of a captured turn is cut to this many UTF-8 bytes. */
export const FLUX_CAPTURE_SIDE_MAX_BYTES = 32 * 1024;
const RETRY_DELAYS_MS = [1_000, 4_000] as const;
/** Each capture attempt gives up after this long (FLUX-SPACES-CAPTURE-FORGET-106 R3.1). */
export const FLUX_CAPTURE_TIMEOUT_MS = 30_000;
/** An older proxy without the spaces route (404/405): no capture is tried again for this long. */
export const FLUX_SPACES_UNAVAILABLE_MS = 6 * 60 * 60_000;

/** Config loader: flux.memory.vault is still accepted in config.json and ignored. Capture goes only to the thread's space
 * (FLUX-SPACES-CAPTURE-FORGET-106): a vault capture could never be forgotten when the conversation is deleted. */
export function setFluxMemoryCaptureVault(_value: string | undefined): void { /* ignored: nothing is ever sent to a vault */ }

/** The one place that knows where a capture goes: the replying bot's space. null for a space outside FluxMain's charset. */
export function fluxMemoryCaptureUrl(space: string): string | null {
  if (!FLUX_SPACE.test(space)) return null;
  return `${FLUX_MEMORY_API_BASE}/spaces/${encodeURIComponent(space)}/events`;
}

const cut = (text: string): string => {
  if (Buffer.byteLength(text, "utf8") <= FLUX_CAPTURE_SIDE_MAX_BYTES) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = FLUX_CAPTURE_SIDE_MAX_BYTES;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};

export interface FluxCaptureDeps {
  /** The Flux key, read fresh each time (flux-config.ts fluxKey). */
  key: () => string | null;
  /** Murage's own memory captures this thread now (memory mode, hold, excluded threads: memory/capture.ts). */
  threadCaptures: (threadId: string) => boolean;
  /** Point-read the exact user message dispatched for this turn. */
  userText: (threadId: string, ownerMessageId?: string) => string | undefined;
  /** "Ask me before it changes anything" (bot-learning.ts askFirst) for this bot. Such a bot sends nothing to Flux Memory. */
  asksFirst: (botId: string) => boolean;
  /** The current per-bot learning switches and Memory page pause. */
  botCaptures?: (botId: string) => boolean;
  /** The spaces ledger (flux-memory-spaces.ts), over messages.db. */
  ledger: {
    /** Written before the request leaves; the bot space and thread tag to send, or null when nothing may be sent (bot or thread
     * deleted, thread forgotten, space tombstoned or at the limit). */
    noteUsed: (threadId: string, botId: string, keyFp: string) => FluxCaptureTarget | null;
    keyOff: (keyFp: string) => boolean;
    setKeyOff: (keyFp: string, code: string | null) => void;
    /** Flux accepted the capture (2xx): the receipt; a late 2xx on a tombstoned space or thread re-owes its forget, and answers
     * true then (the forget worker is woken: `onReowe`). */
    accepted: (input: { threadId: string; botId: string; keyFp: string; space: string; tag: string; sourceId: unknown }) => boolean | void;
    /** Flux's spaces route is proven for this space and key (an earlier 2xx or a receipt): any 404 there means the space is gone. */
    routeProven?: (space: string, keyFp: string) => boolean;
    /** 409 memory_thread_forgotten: the thread is never captured again. */
    threadForgotten: (threadId: string, code: string | null) => void;
    /** 404 memory_not_found: the bot's space was shredded; never captured again with this key. */
    spaceGone: (space: string, keyFp: string, code: string | null) => void;
    /** 429 memory_end_user_limit: the bot's space sends nothing, looked at again after 24 h. */
    limit: (space: string, keyFp: string) => void;
  };
  /** A late 2xx re-owed a forget (ledger.accepted answered true): wake the forget worker (flux-memory-forget.ts poke). */
  onReowe?: () => void;
  fetch?: typeof globalThis.fetch;
  /** Dispatcher for the request (provider-dispatcher.ts); omitted in tests. */
  dispatcher?: (url: string) => unknown;
  url?: (space: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

interface Pending { context: FluxMemoryContext; botId: string; userText: string; userTruncated: boolean; reply: string[] }

type TurnStart = Pick<SendTurnInput, "threadId" | "background" | "prewarm" | "warmIdentity" | "engineCommand" | "fluxCaptureHold" | "ownerMessageId">;
const BODY_MAX = 65_536;
const readBody = async (response: Response): Promise<unknown> => {
  try {
    const text = await response.text();
    return text.length <= BODY_MAX ? JSON.parse(text) : null;
  } catch { return null; }
};
const codeIn = (body: unknown): string | null => {
  const value = body && typeof body === "object" ? body as { error?: { code?: unknown }; code?: unknown } : {};
  const code = (value.error && typeof value.error === "object" ? value.error.code : undefined) ?? value.code;
  return typeof code === "string" ? code : null;
};
/** One capture request: in flight from the finished turn until `send()` settles (the forget worker waits on it). */
interface Job { threadId: string; botId: string; controller: AbortController }
type FoldEvent = { type: string; threadId: string; turnId?: string; itemType?: string; origin?: string; text?: string; ok?: boolean };

export class FluxMemoryCapture {
  private readonly pending = new Map<string, Pending>();
  private readonly deps: FluxCaptureDeps;
  private readonly warned = new Set<string>();
  /** Captures in flight (tests await them). */
  readonly inflight = new Set<Promise<void>>();
  /** Every capture in flight: a deleted conversation or bot aborts its own; each leaves only when its send() has settled. */
  private readonly jobs = new Set<Job>();
  /** When the last capture of a thread / of a bot settled: the forget waits the grace after it. */
  private readonly settledThread = new Map<string, number>();
  private readonly settledBot = new Map<string, number>();
  /** An older proxy answered 404/405 for the spaces route: no capture until then (in memory: a restart probes again). Only
   * before the route is proven for that space and key. */
  private readonly unavailableUntil = new Map<string, number>();
  /** `${keyFp} ${space}` pairs a capture 2xx landed for in this process (the ledger keeps the durable proof). */
  private readonly proven = new Set<string>();
  // No parameter property: the server runs under Node type stripping.
  constructor(deps: FluxCaptureDeps) { this.deps = deps; }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Every check is fail closed: a lookup that throws means no capture. */
  private capturing(context: FluxMemoryContext, threadId: string, botId: string | undefined): boolean {
    if (fluxMemoryDecision(context).capture !== "on") return false;
    try {
      const key = this.deps.key();
      if (!key) return false;
      if (!botId || this.deps.asksFirst(botId) || this.deps.botCaptures?.(botId) === false) return false;
      if (this.deps.ledger.keyOff(fluxKeyFingerprint(key))) return false;
      return this.deps.threadCaptures(threadId);
    } catch { this.logFailure("admission"); return false; }
  }

  /** A capture for this thread is in flight, or settled less than the grace ago (the forget worker waits). */
  busy(threadId: string): boolean {
    for (const job of this.jobs) if (job.threadId === threadId) return true;
    return this.now() - (this.settledThread.get(threadId) ?? -Infinity) < FLUX_FORGET_GRACE_MS;
  }

  /** A capture of this bot is in flight in any conversation, channels included, or settled less than the grace ago. */
  botBusy(botId: string): boolean {
    for (const job of this.jobs) if (job.botId === botId) return true;
    return this.now() - (this.settledBot.get(botId) ?? -Infinity) < FLUX_FORGET_GRACE_MS;
  }

  /** A turn is being dispatched (index.ts sendProjectUsageTurn). Only a capture-on turn gets an entry. */
  begin(turn: TurnStart): void {
    this.pending.delete(turn.threadId);
    if (turn.prewarm || turn.background || turn.engineCommand) return;
    const context = fluxMemoryContextForTurn(turn);
    const botId = turn.warmIdentity?.botId;
    if (!this.capturing(context, turn.threadId, botId)) return;
    let userText: string | undefined;
    try { userText = this.deps.userText(turn.threadId, turn.ownerMessageId); } catch { this.logFailure("user-text"); userText = undefined; }
    if (!userText?.trim()) return;
    // secrets are redacted as Murage's own capture redacts them (memory/capture.ts captureSource)
    const redacted = redactSecretsInText(userText), excerpt = cut(redacted);
    this.pending.set(turn.threadId, { context, botId: botId!, userText: excerpt, userTruncated: excerpt !== redacted, reply: [] });
  }

  /** The conversation was deleted (memory/capture.ts captureThreadDeletion): drop its entry and abort its request in flight. It
   * stays busy until its send() has settled. */
  forgetThread(threadId: string): void {
    this.pending.delete(threadId);
    for (const job of this.jobs) if (job.threadId === threadId) job.controller.abort();
  }

  /** The bot was deleted (the bot:<id> owner-deletion record): every capture of it, in every conversation, is dropped and aborted. */
  forgetBot(botId: string): void {
    for (const [threadId, entry] of this.pending) if (entry.botId === botId) this.pending.delete(threadId);
    for (const job of this.jobs) if (job.botId === botId) job.controller.abort();
  }

  /** Every runtime event passes through here, after the reply guard has cut any line. */
  observe(event: FoldEvent): void {
    const entry = this.pending.get(event.threadId);
    if (!entry) return;
    if (event.type === "item.completed" && event.itemType === "assistant_text" && event.origin === "engine" && typeof event.text === "string") {
      entry.reply.push(event.text);
    } else if (event.type === "session.exited") {
      this.pending.delete(event.threadId);
    } else if (event.type === "turn.completed") {
      this.pending.delete(event.threadId);
      if (event.ok !== true) return;
      const completeReply = redactSecretsInText(entry.reply.join("\n\n")).trim();
      const reply = cut(completeReply);
      if (!reply) return;
      for (const other of this.jobs) if (other.threadId === event.threadId) other.controller.abort();
      const record: Job = { threadId: event.threadId, botId: entry.botId, controller: new AbortController() };
      this.jobs.add(record);
      const job = this.send(event.threadId, event.turnId, entry, reply, record.controller.signal, reply !== completeReply).catch(() => {
        this.logFailure("unexpected");
      }).finally(() => {
        // only once send() has settled: until then the forget of this thread or bot waits
        this.jobs.delete(record);
        const at = this.now();
        this.settledThread.set(record.threadId, at);
        this.settledBot.set(record.botId, at);
        this.inflight.delete(job);
      });
      this.inflight.add(job);
    }
  }

  private logFailure(stage: string): void {
    try { (this.deps.log ?? console.info)(`[flux] memory-capture failed stage=${stage}`); } catch { /* logging cannot admit a capture */ }
  }

  private async send(threadId: string, turnId: string | undefined, entry: Pending, reply: string, signal: AbortSignal, replyTruncated = false): Promise<void> {
    // decided again now: a switch turned off since dispatch reaches the capture (the dispatch decision is the ceiling)
    if (!this.capturing(entry.context, threadId, entry.botId)) return;
    const log = this.deps.log ?? ((line: string) => { try { console.info(line); } catch { /* ignore */ } });
    const id = createHash("sha256").update(`${threadId}:${turnId ?? entry.userText}:${reply}`).digest("hex");
    const text = `User: ${entry.userText}\n\nAssistant: ${reply}`;
    const doFetch = this.deps.fetch ?? globalThis.fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
      // the key is read again for every attempt, and only while capture is still on
      const key = this.deps.key();
      if (signal.aborted || !key || !this.capturing(entry.context, threadId, entry.botId)) return;
      const keyFp = fluxKeyFingerprint(key);
      // Ledger first, in the same synchronous step as the check above: from here a deletion of this thread owes a thread forget in
      // this space for this key, and a deletion of the bot owes the space's DELETE. A deleted bot or thread, a tombstoned or full
      // space, or a ledger that cannot be written sends nothing.
      let target: FluxCaptureTarget | null;
      try { target = this.deps.ledger.noteUsed(threadId, entry.botId, keyFp); } catch { this.logFailure("ledger-admission"); target = null; }
      if (!target) return;
      const { space, tag } = target;
      // An unproven route's latch cannot hide a later 404 on a proven space, or silence a different key.
      if (this.now() < (this.unavailableUntil.get(keyFp) ?? 0) && !this.routeProven(space, keyFp)) return;
      const url = (this.deps.url ?? fluxMemoryCaptureUrl)(space);
      if (!url) { this.warnOnce("no-target", log); return; }
      const body = JSON.stringify({ client_event_id: id, text, metadata: { app: FLUX_MEMORY_APP, kind: "turn", thread: tag,
        ...(entry.userTruncated || replyTruncated ? { incomplete: true, user_truncated: entry.userTruncated, assistant_truncated: replyTruncated } : {}) } });
      let status = 0;
      let response: Response | undefined;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": id, [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP, ...fluxUsageHeaders({ feature: "memory", botId: entry.botId, threadId }) },
          body,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(FLUX_CAPTURE_TIMEOUT_MS)]),
          ...(this.deps.dispatcher ? { dispatcher: this.deps.dispatcher(url) } : {}),
        } as RequestInit);
        status = response.status;
      } catch { status = 0; }
      const answer = response && (status >= 200 && status < 300 || status === 404 || status === 409 || status === 429) ? await readBody(response) : null;
      if (response && answer === null) { try { await response.body?.cancel(); } catch { /* the answer is not read */ } }
      const code = codeIn(answer);
      if (status >= 200 && status < 300) {
        // recorded even when aborted meanwhile: a 2xx that landed for a space or thread deleted since re-owes its forget
        const sourceId = answer && typeof answer === "object" ? (answer as { source_id?: unknown }).source_id : undefined;
        this.proven.add(`${keyFp} ${space}`);
        let reowed = false;
        try { reowed = this.deps.ledger.accepted({ threadId, botId: entry.botId, keyFp, space, tag, sourceId }) === true; }
        catch { this.logFailure("ledger-receipt"); return; }
        if (reowed) { try { this.deps.onReowe?.(); } catch { /* the worker's own timer still runs */ } }
        log(`[flux] memory-capture ok status=${status}`);
        return;
      }
      if (status === 409) {
        if (code === "memory_thread_forgotten") {
          // the conversation was forgotten at Flux (deleted): never captured again, no retry, no Settings line
          try { this.deps.ledger.threadForgotten(threadId, code); } catch { this.logFailure("ledger-thread"); }
          return;
        }
        // Flux Memory is off for this key (unenrolled, consent off, account not enabled yet): no more capture for it, no retry
        try { this.deps.ledger.setKeyOff(keyFp, code); } catch { this.logFailure("ledger-key"); }
        this.warnOnce("key-off", log, status);
        return;
      }
      if (status === 429 && code === "memory_end_user_limit") {
        // the Flux account is full (1,000 bots): that bot sends nothing, never retried, Retry-After ignored
        try { this.deps.ledger.limit(space, keyFp); } catch { this.logFailure("ledger-limit"); }
        this.warnOnce("limit", log, status);
        return;
      }
      if (status === 404 && (code === "memory_not_found" || this.routeProven(space, keyFp))) {
        // the bot's space was shredded (deleted elsewhere, a restored pre-delete copy) or this key has no personal memory: the
        // space is tombstoned for this key and never written again, so a late retry cannot recreate it. Once the route is proven
        // for this space and key (an earlier 2xx or a receipt), ANY 404 there is this, never an older proxy (Grok M, 106 r1).
        try { this.deps.ledger.spaceGone(space, keyFp, FLUX_SPACE_GONE_CODE); } catch { this.logFailure("ledger-space"); }
        this.warnOnce("space-gone", log, status);
        return;
      }
      if (signal.aborted) return;
      if (status === 404 || status === 405) {
        // an older proxy without the spaces route (the route was never proven for this space and key): not available for 6 h,
        // and nothing is sent anywhere else
        this.unavailableUntil.set(keyFp, this.now() + FLUX_SPACES_UNAVAILABLE_MS);
        this.warnOnce("unavailable", log, status);
        return;
      }
      const retry = status === 0 || status === 429 || status >= 500;
      if (!retry || attempt >= RETRY_DELAYS_MS.length) {
        if (retry) log(`[flux] memory-capture failed status=${status}`);
        else this.warnOnce(`status-${status}`, log, status);
        return;
      }
      await sleep(RETRY_DELAYS_MS[attempt]!);
      if (signal.aborted) return;
    }
  }

  /** Fail closed toward the tombstone: a ledger that cannot answer is not proof, so only the in-memory 2xx counts then. */
  private routeProven(space: string, keyFp: string): boolean {
    if (this.proven.has(`${keyFp} ${space}`)) return true;
    try { return this.deps.ledger.routeProven?.(space, keyFp) === true; } catch { return false; }
  }

  private warnOnce(kind: string, log: (line: string) => void, status?: number): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    log(kind === "no-target" ? "[flux] memory-capture no-target"
      : kind === "unavailable" ? `[flux] memory-capture not-available status=${status}`
      : kind === "key-off" ? "[flux] memory-capture key-off status=409"
      : kind === "space-gone" ? "[flux] memory-capture space-gone status=404"
      : kind === "limit" ? "[flux] memory-capture limit status=429"
      : `[flux] memory-capture failed status=${status}`);
  }
}
