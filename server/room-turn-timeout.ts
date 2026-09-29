import type { ProviderStopResult } from "./contracts.ts";

/** A room turn's silence limit in milliseconds. Room turns are stopped for
 * silence, never for duration (0.1.61): the stall watchdog (turn-watchdog.ts)
 * runs a room turn on this limit instead of the direct turns' TURN_STALL_MS,
 * with the same exemptions (a person deciding, a wait for a slot or folder).
 * The old absolute ceiling, RoomTurnDeadline, stopped long work while it was
 * still streaming. */
export function roomTurnSilenceMs(minutes: number): number {
  return minutes * 60_000;
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

/** The room's stall line: the direct turns' "no activity" wording, plus the
 * close receipt a room claim still waits for (RoomPendingStop). */
export function roomTurnStallMessage(minutes: number): string {
  const unit = minutes === 1 ? "minute" : "minutes";
  return `error: no activity for ${minutes} ${unit}: stopping; waiting for the engine to confirm close`;
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

  /** The stopped turn's own terminal event (turn.completed or
   * session.exited). For an engine with no teardown receipt (Claude, Codex,
   * Box: `observe` absent) this is the close receipt, as it is for a direct
   * turn (index.ts settleDirect); without it a stopped room stayed busy until
   * the app restarted. An engine that does give a receipt waits for it. */
  terminal(turnId: string): void {
    if (this.cancelled || this.deps.observe || !this.request || this.turnId !== turnId) return;
    this.accept({ closeConfirmed: true });
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
