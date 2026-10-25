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
import { IntakeValve } from "./intake.ts";
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

  publish(event: RuntimeEvent) {
    if (this.omitThread(event.threadId)) return this.deliver(event);
    // Live-only events (each streamed chunk, each progress tick) and events of a
    // conversation already deleted are delivered and never written
    // (harness/event-log.ts says which and why).
    if (!persistsEvent(event) || threadLogClosed(event.threadId)) return this.deliver(event);
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    // the F12 record (the map handed to the engine process) is never written (runtime-event-out.ts)
    const loggable = redactSecrets(withoutImageBytes(loggedRuntimeEvent(event)));
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
