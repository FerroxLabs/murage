// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { looksLikeAuthFailure, noteInstanceAuthFailure, noteInstanceTurnOk } from "../key-rejections.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { loggedRuntimeEvent } from "../runtime-event-out.ts";
import { isPhoneRequest } from "../phones/withhold.ts";
import { createHash } from "node:crypto";
import { IntakeValve } from "./intake.ts";
import { observeTurnEvent } from "../health/turn-observer.ts";
import { boundedRecord, markLogCovered, persistsEvent, flushSessionLines, markSessionsPending, recordSessionLine, rotateIfFull, sweepAfterWrite, threadLogClosed } from "./event-log.ts";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";

const INCOMPLETE_LOG_MESSAGE =
  "Canonical event history is incomplete: Murage could not write one or more events to disk. Live updates will continue.";

/** Provider image bytes, out of the on-disk log.
 *
 * `redactSecrets` scrubs CREDENTIAL-shaped content; nothing in it knows about
 * base64 payloads. So the ACP driver carefully kept generated-image bytes out
 * of native/<thread>.ndjson while the very same payload went verbatim into
 * events/<thread>.ndjson — the sibling file, and the one the comment below
 * calls "a file people paste into bug reports". Half the job.
 *
 * The shape is kept so the log still shows that an image happened and how big
 * it was; only the payload goes. Found by the sweep's own verifier after two
 * external audits called this lane clean. */
function withoutImageBytes(event: RuntimeEvent): RuntimeEvent {
  const candidate = event as unknown as { itemType?: unknown; data?: unknown };
  if (candidate.itemType !== "assistant_image" || typeof candidate.data !== "string") return event;
  return {
    ...event,
    data: `[image data: ${candidate.data.length} base64 chars]`,
  } as RuntimeEvent;
}

export type DeliveryGate = {
  held(): boolean; wait(): Promise<void>; isBusy(error: unknown): boolean;
  /** The queue passed its bound while the gate was held: release the hold (the index build defers to a later idle). */
  overflow?(): void;
};
type QueuedDelivery = { event: RuntimeEvent; owed: RuntimeEventListener[]; bytes: number };
export type DeliveryLimits = { maxEvents: number; maxBytes: number; batch: number; retryMinMs: number; retryMaxMs: number };
const DEFAULT_LIMITS: DeliveryLimits = { maxEvents: 2_000, maxBytes: 32 * 1024 * 1024, batch: 50, retryMinMs: 50, retryMaxMs: 2_000 };
function eventBytes(event: RuntimeEvent): number {
  try { return JSON.stringify(event).length; } catch { return 4_096; }
}

export const PHONE_TEXT_WITHHELD = "[phone turn text withheld]";
export const PHONE_RESULT_WITHHELD = "[phone result withheld]";
export interface PhoneWithholdPolicy {
  thread(threadId: string): boolean;
  phoneTool(event: RuntimeEvent): { summary: string } | null;
}

const REQUEST_WITHHELD_FIELDS = ["toolInput", "toolCall", "questions", "choices", "reason", "filePaths", "folderTrust"] as const;

function withheldRequest(e: Record<string, unknown>): RuntimeEvent {
  const out: Record<string, unknown> = { ...e, summary: PHONE_RESULT_WITHHELD };
  delete out.raw;
  for (const key of REQUEST_WITHHELD_FIELDS) delete out[key];
  return out as unknown as RuntimeEvent;
}

/** The model picks Codex question ids, so the log keeps a stable non-reversible stand-in; rows still line up. Live delivery keeps the real id. */
function standInQuestionId(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  return `q-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** A marked thread's question keeps its shape (ids, counts, flags) and none of its words. */
function withheldQuestions(e: Record<string, unknown>): RuntimeEvent {
  const { raw: _raw, ...rest } = e;
  const questions = Array.isArray(e.questions)
    ? e.questions.map((q) => ({ id: standInQuestionId((q as { id?: string }).id), question: PHONE_RESULT_WITHHELD, options: [], multiSelect: Boolean((q as { multiSelect?: boolean }).multiSelect), allowOther: Boolean((q as { allowOther?: boolean }).allowOther) }))
    : [];
  return { ...rest, questions } as unknown as RuntimeEvent;
}

function withheldByType(policy: PhoneWithholdPolicy, event: RuntimeEvent): RuntimeEvent {
  try {
    const e = event as unknown as Record<string, unknown>;
    const marked = policy.thread(event.threadId);
    if (e.type === "request.opened") {
      if (marked || isPhoneRequest(e)) return withheldRequest(e);
      return event;
    }
    if (e.type === "item.completed" || e.type === "item.started") {
      if (e.itemType === "tool") {
        const phone = policy.phoneTool(event);
        if (!phone && !marked) return event;
        // the raw engine frame can carry the same arguments and result
        const { raw: _raw, detail: _detail, title: _title, ...rest } = e;
        const summary = phone ? phone.summary : PHONE_RESULT_WITHHELD;
        return (e.type === "item.completed"
          ? { ...rest, result: PHONE_RESULT_WITHHELD, summary }
          : { ...rest, input: PHONE_RESULT_WITHHELD, summary }) as unknown as RuntimeEvent;
      }
      if (e.type === "item.started" && e.itemType === "reasoning" && marked) {
        const { raw: _raw, ...rest } = e;
        return { ...rest, title: PHONE_RESULT_WITHHELD, summary: PHONE_RESULT_WITHHELD, input: PHONE_RESULT_WITHHELD } as unknown as RuntimeEvent;
      }
      if (e.type === "item.completed" && e.itemType === "assistant_text" && marked) {
        const { raw: _raw, ...rest } = e;
        return { ...rest, text: PHONE_TEXT_WITHHELD } as unknown as RuntimeEvent;
      }
    }
    if (e.type === "question.async" && marked) return withheldQuestions(e);
    return event;
  } catch {
    // fail closed: a policy that throws writes the shape and none of the words
    const e = event as unknown as Record<string, unknown>;
    if (e.type === "request.opened") return withheldRequest(e);
    if (e.type === "question.async") return withheldQuestions(e);
    if (e.type === "item.started" && e.itemType === "reasoning") return { ...e, raw: undefined, title: PHONE_RESULT_WITHHELD, summary: PHONE_RESULT_WITHHELD, input: PHONE_RESULT_WITHHELD } as unknown as RuntimeEvent;
    if (e.type === "item.completed" && e.itemType === "assistant_text") return { ...e, raw: undefined, text: PHONE_TEXT_WITHHELD } as unknown as RuntimeEvent;
    if ((e.type === "item.completed" || e.type === "item.started") && e.itemType === "tool") return { ...e, raw: undefined, detail: undefined, title: undefined, summary: PHONE_RESULT_WITHHELD, result: e.type === "item.completed" ? PHONE_RESULT_WITHHELD : undefined, input: e.type === "item.started" ? PHONE_RESULT_WITHHELD : undefined } as unknown as RuntimeEvent;
    return event;
  }
}

/** Marked threads are deny-by-default: every string at any depth becomes the withheld marker except these structural fields
 * (ids, event type, kind, status, timestamps, tool name, item type). Numbers, booleans and null always stay. An event type
 * nobody listed here gets every string withheld. */
const STRUCTURAL_STRING_KEYS: ReadonlySet<string> = new Set([
  "eventId", "provider", "providerInstanceId", "threadId", "turnId", "itemId", "requestId", "interjectionId", "sessionId", "id",
  "createdAt", "type", "kind", "itemType", "requestType", "streamKind", "status", "origin", "behavior", "source", "stopReason",
  "approvalScope", "toolKind", "tool", "toolEngine", "mcpReadiness", "deniedBy",
]);
/** `name` and `namespace` are structural only inside a tool identity (a tool's name, never display text). */
const TOOL_IDENTITY_KEYS: ReadonlySet<string> = new Set(["name", "namespace", "kind"]);
const WITHHOLD_MAX_DEPTH = 12;

function isMarker(value: string): boolean {
  return value === PHONE_TEXT_WITHHELD || value === PHONE_RESULT_WITHHELD;
}

function withholdAllStrings(value: unknown, key: string, parent: string, keep: ReadonlySet<string>, depth: number): unknown {
  if (typeof value === "string") {
    if (isMarker(value)) return value;
    if (STRUCTURAL_STRING_KEYS.has(key) || keep.has(key) || (parent === "toolIdentity" && TOOL_IDENTITY_KEYS.has(key))) return value;
    return PHONE_RESULT_WITHHELD;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= WITHHOLD_MAX_DEPTH) return PHONE_RESULT_WITHHELD;
  if (Array.isArray(value)) return value.map((item) => withholdAllStrings(item, key, parent, keep, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, item] of Object.entries(value as Record<string, unknown>)) out[k] = withholdAllStrings(item, k, key, keep, depth + 1);
  return out;
}

/** A marked thread's raw engine frame never reaches the log: its keys are the engine's, so the structural allowlist means nothing there. */
function withoutRaw(event: RuntimeEvent): RuntimeEvent {
  const { raw: _raw, ...rest } = event as RuntimeEvent & { raw?: unknown };
  return rest as RuntimeEvent;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const PHONE_ROW_KEYS: ReadonlySet<string> = new Set(["summary"]);

function withheldForLog(policy: PhoneWithholdPolicy | null, event: RuntimeEvent): RuntimeEvent {
  if (!policy) return event;
  const typed = withheldByType(policy, event);
  try {
    if (!policy.thread(event.threadId)) return typed;
    // a phone tool row's summary is Murage's own line, not model text
    const keep = policy.phoneTool(event) ? PHONE_ROW_KEYS : NO_KEYS;
    return withholdAllStrings(withoutRaw(typed), "", "", keep, 0) as RuntimeEvent;
  } catch {
    return withholdAllStrings(withoutRaw(typed), "", "", NO_KEYS, 0) as RuntimeEvent;
  }
}


export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  private unsubscribes: Array<{ instanceId: string; unsubscribe: () => void }> = [];
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  private readonly appendLog: typeof appendFileSync;
  /** Every listener is durable by default (the fold, terminal cleanup and the waiters all write or follow writes): its
   * deliveries wait out the writer gate and are retried on a locked database, never dropped. `{ durable: false }` opts out. */
  private immediate = new Set<RuntimeEventListener>();
  private gate: DeliveryGate | null = null;
  /** Events waiting for the writer gate (or for a lock to clear), per thread and in order, each with the durable listeners
   * still owed it (the failed one and every listener after it, in subscription order). A thread whose head keeps meeting a
   * locked database backs off on its own; other threads are never held behind it. */
  private pendingByThread = new Map<string, QueuedDelivery[]>();
  private retryState = new Map<string, { at: number; attempts: number }>();
  /** Every event still owed. All of it is in RAM and none of it is ever written to a side file: revoked content must not
   * outlive its deletion, so the bound is kept by slowing the producers (see intake.ts), never by spilling. */
  private pendingCount = 0;
  private pendingBytes = 0;
  /** Bytes owed per thread, so a few huge events from one thread close that thread's intake before they reach the global byte cap. */
  private bytesByThread = new Map<string, number>();
  /** True from the moment the global cap is reached until the queue is back under the low-water mark. */
  private saturated = false;
  private overflowed = false;
  /** Producers ask this before handing over another event; engine stdout streams are paused through it. */
  readonly valve = new IntakeValve(threadId => this.intakeClosed(threadId));
  private limits: DeliveryLimits = DEFAULT_LIMITS;
  private draining = false;
  /** Threads whose events are delivered but never written to events/. */
  private omitThread: (threadId: string) => boolean = () => false;
  /** 1.0.9 phone tools: what the canonical log may not keep of a phone thread (see withholdText). */
  private withhold: PhoneWithholdPolicy | null = null;

  constructor(appendLog: typeof appendFileSync = appendFileSync) {
    this.appendLog = appendLog;
  }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      const unsub = instance.adapter.onEvent((event) => {
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        if (instance.tracksKeyRejection !== true) observeSignIn(instance.instanceId, event, instance.driverKind === "claude" || instance.driverKind === "codex");
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.unsubscribes.push({ instanceId: instance.instanceId, unsubscribe: unsub });
    }
  }

  /** The Chief's hidden New project proposal turns leave no event log. */
  omitLog(predicate: (threadId: string) => boolean) { this.omitThread = predicate; }

  /** A thread that used the phone tools keeps its words out of events/ (the Inspector reads that file), and a phone tool's input and
   * result are never written for any thread. Live delivery is untouched: the owner's chat keeps the words. Runs before boundedRecord, so
   * an over-limit record is withheld too. Never gated on the feature flag (a mark outlives the flag). */
  withholdText(policy: PhoneWithholdPolicy) { this.withhold = policy; }

  publish(event: RuntimeEvent) {
    if (this.omitThread(event.threadId)) return this.deliver(event);
    // Sentinel: every engine's turn outcomes through this one common path (observe only, O(1), never throws)
    observeTurnEvent(event);
    // Live-only events (each streamed chunk, each progress tick) and events of a
    // conversation already deleted are delivered and never written
    // (harness/event-log.ts says which and why).
    if (!persistsEvent(event) || threadLogClosed(event.threadId)) return this.deliver(event);
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    // the F12 record (the map handed to the engine process) is never written (runtime-event-out.ts)
    const loggable = withheldForLog(this.withhold, redactSecrets(withoutImageBytes(loggedRuntimeEvent(event))) as RuntimeEvent);
    const persistedEvents = pendingWarning ? [pendingWarning, loggable] : [loggable];
    try {
      // the canonical log is a file people paste into bug reports; scrub
      // credential-shaped content (tool titles, request summaries, reply
      // text) the same way the native tee does
      const lines = persistedEvents.map((entry) => boundedRecord(entry as RuntimeEvent));
      const encoded = lines.join("\n") + "\n";
      const bytes = Buffer.byteLength(encoded);
      // a bus given its own writer (a test, or the no-log presentation bus) owns no files
      const ownsFiles = this.appendLog === appendFileSync;
      if (ownsFiles) { flushSessionLines(EVENTS_DIR, event.threadId); if (event.type === "session.started") markSessionsPending(EVENTS_DIR, event.threadId); }
      const freshFile = ownsFiles && rotateIfFull(EVENTS_DIR, event.threadId, bytes);
      this.appendLog(join(EVENTS_DIR, `${event.threadId}.ndjson`), encoded, { mode: 0o600 });
      // a file this release created holds no session line the sessions file lacks
      if (freshFile) markLogCovered(EVENTS_DIR, event.threadId);
      if (ownsFiles && event.type === "session.started") recordSessionLine(EVENTS_DIR, event.threadId, lines[lines.length - 1]!);
      if (ownsFiles) sweepAfterWrite(EVENTS_DIR, event.threadId, bytes);
      if (pendingWarning) this.pendingLogWarnings.delete(event.threadId);
    } catch (error) {
      // Never feed this warning back through publish(): that would retry the
      // same failed write and recurse. Deliver it once for this outage, then
      // persist the same marker before the first event written after recovery.
      if (!pendingWarning) {
        const warning: RuntimeEvent = {
          eventId: newId(),
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          createdAt: new Date().toISOString(),
          turnId: event.turnId,
          type: "runtime.error",
          message: INCOMPLETE_LOG_MESSAGE,
        };
        this.pendingLogWarnings.set(event.threadId, warning);
        console.error("bus: canonical event log write failed", error);
        this.deliver(warning);
      }
    }
    this.deliver(event);
  }

  private deliver(event: RuntimeEvent) {
    const owed: RuntimeEventListener[] = [];
    for (const listener of [...this.listeners]) {
      if (!this.immediate.has(listener)) { owed.push(listener); continue; }
      try {
        listener(event);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
    if (!owed.length) return;
    // Durable listeners write to messages.db. While the lock is held, or earlier events of the same thread are still waiting,
    // this one queues behind them (per-thread order is kept); otherwise it runs now.
    if (this.pendingByThread.has(event.threadId) || this.gate?.held()) { this.enqueue(event, owed); return; }
    const left = this.runOwed(event, owed);
    if (left.length) this.enqueue(event, left);
  }

  /** Runs the listeners in order. At the first one that hits a locked database it stops and returns that listener AND every
   * listener after it, so none overtakes the failed one. A listener that fails any other way is logged and skipped. */
  private runOwed(event: RuntimeEvent, owed: RuntimeEventListener[]): RuntimeEventListener[] {
    for (let i = 0; i < owed.length; i++) {
      try {
        owed[i]!(event);
      } catch (e) {
        if (this.gate?.isBusy(e)) return owed.slice(i);
        console.error("bus: listener threw", e);
      }
    }
    return [];
  }

  private enqueue(event: RuntimeEvent, owed: RuntimeEventListener[]) {
    const bytes = eventBytes(event);
    const entry = { event, owed, bytes };
    const queue = this.pendingByThread.get(event.threadId);
    if (queue) queue.push(entry); else this.pendingByThread.set(event.threadId, [entry]);
    this.pendingCount++; this.pendingBytes += bytes;
    this.bytesByThread.set(event.threadId, (this.bytesByThread.get(event.threadId) ?? 0) + bytes);
    this.checkCapacity();
    this.kick();
  }

  /** The cap is global (all threads, events and bytes). Reaching it releases the hold on writers (a held gate would
   * otherwise keep every thread queueing; the index build defers to a later idle) and closes intake. Intake reopens only
   * below the low-water mark, so producers do not flap.
   *
   * No deadlock between threads: a thread may hold at most half the event cap (`threadShare`), so one thread whose
   * listener keeps meeting a lock cannot fill the queue and starve the others. A blocked thread's queue drains by its own
   * retry timer, independent of intake, and a thread with nothing queued delivers synchronously without using capacity. */
  private checkCapacity() {
    const { maxEvents, maxBytes } = this.limits;
    if (!this.saturated && (this.pendingCount >= maxEvents || this.pendingBytes >= maxBytes)) {
      this.saturated = true;
      if (!this.overflowed) {
        this.overflowed = true;
        console.error(`bus: delivery queue reached its cap (${this.pendingCount} events); intake is paused until it drains and the writer hold is released`);
        try { this.gate?.overflow?.(); } catch (e) { console.error("bus: overflow release failed", e); }
      }
    } else if (this.saturated && this.pendingCount <= Math.floor(maxEvents / 2) && this.pendingBytes <= Math.floor(maxBytes / 2)) {
      this.saturated = false;
    }
    if (!this.pendingCount) this.overflowed = false;
    this.valve.evaluate();
  }
  private threadShare(): number { return Math.max(1, Math.floor(this.limits.maxEvents / 2)); }
  /** True while a producer for this thread (null: a stream shared by several) must wait. */
  private intakeClosed(threadId: string | null): boolean {
    if (this.saturated) return true;
    if (threadId === null) return false;
    return (this.pendingByThread.get(threadId)?.length ?? 0) >= this.threadShare() || (this.bytesByThread.get(threadId) ?? 0) >= Math.max(1, Math.floor(this.limits.maxBytes / 2));
  }

  private kick() {
    if (this.draining) return;
    this.draining = true;
    void this.drain().catch(e => console.error("bus: drain failed", e)).finally(() => { this.draining = false; if (this.pendingCount) this.kick(); });
  }

  private async drain() {
    let held = 0;
    while (this.pendingCount) {
      if (this.gate?.held()) {
        await this.gate.wait();
        // a wait that returns at once while the hold is still in force (a bounded or exclusion-blind wait) must not spin the loop: a real timer, growing to a cap
        if (this.gate.held()) { held = Math.min(held * 2 || 5, 100); await new Promise<void>(resolve => setTimeout(resolve, held)); } else held = 0;
        continue;
      }
      held = 0;
      const now = Date.now();
      let budget = this.limits.batch, soonest = Infinity;
      for (const [threadId, queue] of [...this.pendingByThread]) {
        const state = this.retryState.get(threadId);
        if (state && state.at > now) { soonest = Math.min(soonest, state.at); continue; }
        while (queue.length && budget > 0) {
          const head = queue[0]!;
          head.owed = this.runOwed(head.event, head.owed);
          if (head.owed.length) {
            const attempts = (state?.attempts ?? 0) + 1;
            if (attempts === 100) console.error(`bus: thread ${threadId} has met a locked database ${attempts} times; still retrying`);
            const wait = Math.min(this.limits.retryMaxMs, this.limits.retryMinMs * 2 ** Math.min(attempts, 10));
            this.retryState.set(threadId, { at: Date.now() + wait, attempts });
            soonest = Math.min(soonest, Date.now() + wait);
            break;
          }
          queue.shift(); budget--; this.pendingCount--; this.pendingBytes -= head.bytes;
          this.bytesByThread.set(threadId, Math.max(0, (this.bytesByThread.get(threadId) ?? 0) - head.bytes));
          this.retryState.delete(threadId);
        }
        if (!queue.length) { this.pendingByThread.delete(threadId); this.retryState.delete(threadId); this.bytesByThread.delete(threadId); }
        this.checkCapacity();
        if (budget <= 0) break;
      }
      if (!this.pendingCount) break;
      // hand the loop back between batches; sleep until the soonest retry when every thread is backing off
      await new Promise<void>(resolve => budget <= 0 ? setImmediate(resolve) : setTimeout(resolve, Math.max(5, Math.min(this.limits.retryMaxMs, soonest - Date.now()))));
    }
  }

  /** Test seam: tighter bounds and timings. */
  setDeliveryLimits(limits: Partial<DeliveryLimits>) { this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  /** The writer gate the durable listeners wait on (server/database.ts). */
  gateDeliveries(gate: DeliveryGate | null) { this.gate = gate; }

  /** True while a durable delivery is still queued. */
  pendingDurable(): number { return this.pendingCount; }

  subscribe(listener: RuntimeEventListener, options: { durable?: boolean } = {}): () => void {
    this.listeners.add(listener);
    if (options.durable === false) this.immediate.add(listener);
    return () => { this.listeners.delete(listener); this.immediate.delete(listener); };
  }

  detachAll() {
    for (const { unsubscribe } of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Stop delivering only these instances' events; every other engine stays
   * attached (a scoped provider reload, server/index.ts reloadProviders). */
  detach(instanceIds: ReadonlySet<string>) {
    const kept: Array<{ instanceId: string; unsubscribe: () => void }> = [];
    for (const entry of this.unsubscribes) {
      if (instanceIds.has(entry.instanceId)) entry.unsubscribe();
      else kept.push(entry);
    }
    this.unsubscribes = kept;
  }
}

/** An authentication-class failure on an engine marks it signed out; a turn that finishes well clears the mark.
 *  Read from the event's own words (and the structured provider error when there is one), never from tool names. */
function observeSignIn(instanceId: string, event: RuntimeEvent, subscriptionLogin = false): void {
  if (event.type === "turn.completed") {
    if (event.ok === true) noteInstanceTurnOk(instanceId);
    return;
  }
  if (event.type !== "runtime.error" || event.setup === true) return;
  if (event.authRequired === true || event.providerError?.kind === "authentication" || looksLikeAuthFailure(event.message, { engineLevel: subscriptionLogin })) noteInstanceAuthFailure(instanceId, Date.now(), { signIn: subscriptionLogin });
}
