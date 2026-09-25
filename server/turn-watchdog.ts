// Stall watchdog for admitted turns.
//
// ask_bot has a short inline wait budget, while room turns have a separately
// configurable absolute ceiling. The main 1:1 path had none: a wedged CLI
// (hung network call, dead MCP child,
// a provider that stops streaming without exiting) left its bot busy
// forever — composer locked, screen poller running — until an interrupt or
// an app restart. This watchdog watches ACTIVITY, not duration: a turn may
// legitimately run for an hour while events keep flowing, but a turn whose
// thread has emitted nothing at all for `stallMs` is wedged. Turns parked
// on a human approval are exempt — waiting on a person is not a stall.
//
// Armed at ADMISSION, not dispatch (upstream #1682, hand port): a turn can
// wedge in setup (a hung box or VM mount, a browser that never registers,
// memory that never builds) before any provider event exists. Two rules keep
// that from stopping real work:
//   - a turn WAITING for something is not stalled: a thread slot, another
//     thread's computer, browser or working folder, handoff capacity, or a
//     person (waitingOn / setWaitingOnHuman). The clock restarts when the
//     wait ends.
//   - setup is latched: until the turn is dispatched, silence is measured
//     against the longer setup ceiling, so slow provider or integration setup
//     is not mistaken for a stall, while a setup that never returns still is.

/** Why a turn is waiting rather than working. */
export type StallWaitReason =
  | "thread-slot"
  | "coordination-slot"
  | "capacity"
  | "computer"
  | "browser"
  | "working-folder"
  | "shared"
  | "room-turn";

export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  /** "setup" from admission until dispatch; "running" after. */
  phase: "setup" | "running";
  /** The turn's own claim; lets a finished setup settle only its own watch. */
  generation?: string;
}

export interface TurnWatchdogOptions {
  stallMs: number;
  /** Silence allowed before dispatch. Never shorter than stallMs. */
  setupStallMs?: number;
  checkMs: number;
  /** Called once per stalled turn, after the entry is removed. */
  onStall: (turn: WatchedTurn) => void;
  now?: () => number;
}

const STALLED_GENERATIONS_KEPT = 256;

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  private turnWaits = new Map<WatchedTurn, Map<symbol, StallWaitReason>>();
  private stalledGenerations = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  // a plain field assignment, not a parameter property — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private owned(threadId: string, generation?: string): WatchedTurn | undefined {
    const turn = this.turns.get(threadId);
    if (!turn) return undefined;
    if (generation !== undefined && turn.generation !== undefined && turn.generation !== generation) return undefined;
    return turn;
  }

  private forget(turn: WatchedTurn): void {
    this.turns.delete(turn.threadId);
    this.turnWaits.delete(turn);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    // never hold the process open just to watch for stalls
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
    this.turnWaits.clear();
  }

  /** A turn was admitted (`setup: true`) or dispatched on this thread. */
  watch(threadId: string, botId: string, opts: { generation?: string; setup?: boolean } = {}): void {
    const previous = this.turns.get(threadId);
    if (previous) this.turnWaits.delete(previous);
    const at = this.now();
    this.turns.set(threadId, {
      threadId,
      botId,
      startedAt: at,
      lastEventAt: at,
      waitingOnHuman: false,
      phase: opts.setup ? "setup" : "running",
      ...(opts.generation !== undefined ? { generation: opts.generation } : {}),
    });
  }

  /** The admitted turn reached its provider: setup is over, the clock
   * restarts at the running ceiling. If something cleared the watch in
   * between, it is re-armed, unless this very turn already stalled. */
  dispatched(threadId: string, botId: string, generation?: string): void {
    const turn = this.owned(threadId, generation);
    if (turn && (generation === undefined || turn.generation === generation || turn.generation === undefined)) {
      turn.phase = "running";
      turn.lastEventAt = this.now();
      return;
    }
    if (generation !== undefined && this.stalledGenerations.has(generation)) return;
    if (this.turns.has(threadId)) return; // a newer turn owns the thread
    this.watch(threadId, botId, { generation });
  }

  /** The turn is waiting for a resource, not working. Returns the release;
   * releasing twice, or after the turn was replaced, does nothing. */
  waitingOn(threadId: string, reason: StallWaitReason, generation?: string): () => void {
    const turn = this.owned(threadId, generation);
    if (!turn) return () => {};
    const key = Symbol(reason);
    let waits = this.turnWaits.get(turn);
    if (!waits) this.turnWaits.set(turn, (waits = new Map()));
    waits.set(key, reason);
    return () => {
      const current = this.turnWaits.get(turn);
      if (!current?.delete(key)) return;
      if (this.turns.get(turn.threadId) === turn) turn.lastEventAt = this.now();
    };
  }

  /** What the turn on this thread is waiting for right now (tests, logs). */
  waits(threadId: string): StallWaitReason[] {
    const turn = this.turns.get(threadId);
    return turn ? [...(this.turnWaits.get(turn)?.values() ?? [])] : [];
  }

  /** Any provider event for the thread proves the turn is alive. */
  touch(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.lastEventAt = this.now();
  }

  /** request.opened → true (a human is deciding; not a stall however long
   * they take); request.resolved → false (the clock restarts). */
  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  /** The turn settled normally — stop watching it. With a generation, only
   * that turn's own watch is cleared. */
  settle(threadId: string, generation?: string): void {
    const turn = this.owned(threadId, generation);
    if (turn) this.forget(turn);
  }

  /** A turn left setup without dispatching: clear its watch, and only if it
   * is still that turn's setup watch. */
  settleSetup(threadId: string, generation: string): void {
    const turn = this.turns.get(threadId);
    if (turn?.phase === "setup" && turn.generation === generation) this.forget(turn);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  /** Visible for tests; the interval calls this. */
  sweep(): void {
    const at = this.now();
    const setupStallMs = Math.max(this.opts.stallMs, this.opts.setupStallMs ?? this.opts.stallMs);
    for (const turn of [...this.turns.values()]) {
      if (turn.waitingOnHuman) continue;
      if (this.turnWaits.get(turn)?.size) continue;
      const ceiling = turn.phase === "setup" ? setupStallMs : this.opts.stallMs;
      if (at - turn.lastEventAt < ceiling) continue;
      this.forget(turn);
      if (turn.generation !== undefined) {
        this.stalledGenerations.add(turn.generation);
        if (this.stalledGenerations.size > STALLED_GENERATIONS_KEPT) {
          this.stalledGenerations.delete(this.stalledGenerations.values().next().value!);
        }
      }
      this.opts.onStall(turn);
    }
  }
}
