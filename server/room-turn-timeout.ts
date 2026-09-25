import type { ProviderStopResult } from "./contracts.ts";

export function roomTurnTimeoutMs(minutes: number): number {
  return minutes * 60_000;
}

/**
 * One room turn's slice of the configured room ceiling.
 *
 * Counts work, not wall time: the clock holds while the turn is parked on
 * an approval or question card (request.opened → request.resolved) —
 * waiting on a person is not work, and stopping the turn under an open
 * card manufactures the stranded-approval state the harness otherwise has
 * to repair after the fact. Streaming, tool runs, and provider latency
 * still burn the budget normally; a turn that goes silent entirely is
 * separately caught by the stall watchdog.
 *
 * Requests pair opened→resolved per thread, but resolves can also arrive
 * for cards this turn never opened (stale cleanup after an interrupt), so
 * the count clamps at zero instead of trusting perfect pairing.
 */
export class RoomTurnDeadline {
  private remainingMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openRequests = 0;
  private stopped = false;
  private fired = false;
  private armedAt = 0;
  private fire: () => void;

  // plain field assignments, not parameter properties — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(minutes: number, fire: () => void) {
    this.remainingMs = roomTurnTimeoutMs(minutes);
    this.fire = fire;
  }

  /** Begin counting down the budget. */
  start(): void {
    this.arm();
  }

  /** request.opened → true (a person is deciding; hold however long they take),
   * request.resolved → false (the budget resumes where it left off). */
  setWaitingOnHuman(waiting: boolean): void {
    if (this.stopped || this.fired) return;
    if (waiting) {
      const wasIdle = this.openRequests === 0;
      this.openRequests += 1;
      if (wasIdle) this.hold();
    } else if (this.openRequests > 0) {
      this.openRequests -= 1;
      if (this.openRequests === 0) this.arm();
    }
  }

  /** The turn settled — cancel whatever remains. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private hold(): void {
    if (this.timer === null) return;
    this.remainingMs -= Date.now() - this.armedAt;
    clearTimeout(this.timer);
    this.timer = null;
    // A delayed event loop can deliver the card event after the deadline
    // already passed; a person's wait must not extend an exhausted budget.
    if (this.remainingMs <= 0) this.expired();
  }

  private arm(): void {
    if (this.stopped || this.fired || this.openRequests > 0) return;
    if (this.remainingMs <= 0) {
      this.expired();
      return;
    }
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.expired();
    }, this.remainingMs);
  }

  private expired(): void {
    if (this.stopped || this.fired) return;
    this.fired = true;
    this.fire();
  }
}

/** Completes the active room turn when its activity watchdog stalls. */
export class RoomTurnStallRegistry {
  private handlers = new Map<string, () => void>();

  register(threadId: string, handler: () => void): () => void {
    this.handlers.set(threadId, handler);
    return () => {
      if (this.handlers.get(threadId) === handler) this.handlers.delete(threadId);
    };
  }

  stall(threadId: string): boolean {
    const handler = this.handlers.get(threadId);
    if (!handler) return false;
    this.handlers.delete(threadId);
    handler();
    return true;
  }
}

export function roomTurnTimeoutMessage(botName: string, minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  return `${botName}'s room turn exceeded ${minutes} ${unit}: stopping; waiting for the engine to confirm close`;
}
/** One stopped room claim. Re-observe a bounded close receipt, never re-kill
 * or turn an elapsed deadline into permission to release the owner. */
export class RoomPendingStop {
  turnId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelled = false;
  private request: Promise<void> | undefined;
  private deps: {
    current: () => boolean;
    observe?: (turnId: string) => Promise<ProviderStopResult>;
    closed: (turnId: string) => void;
  };

  constructor(deps: RoomPendingStop["deps"]) { this.deps = deps; }

  stop(turnId: string, interrupt: () => Promise<void | ProviderStopResult>): Promise<void> {
    if (this.request || this.cancelled) return this.request ?? Promise.resolve();
    this.turnId = turnId;
    this.request = (async () => {
      let result: void | ProviderStopResult = undefined;
      try { result = await interrupt(); } catch { /* Still owned; observe closure. */ }
      if (!this.accept(result)) this.schedule();
    })();
    return this.request;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private accept(result: void | ProviderStopResult): boolean {
    if (this.cancelled) return true;
    if (!this.deps.current()) { this.cancel(); return true; }
    if (result?.closeConfirmed === true && this.turnId) {
      this.cancel();
      this.deps.closed(this.turnId);
      return true;
    }
    return false;
  }

  private schedule(): void {
    if (this.cancelled || !this.turnId || !this.deps.observe) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.accept(undefined)) return;
      void this.deps.observe!(this.turnId!).then(
        result => { if (!this.accept(result)) this.schedule(); },
        () => { if (!this.accept(undefined)) this.schedule(); },
      );
    }, 1_000);
    this.timer.unref?.();
  }
}
