// STOP-FENCE (1.0.18, design r3): one fence per send. A send registers it as the FIRST statement of sendTurn, before any await; a stop, reset,
// Stop All or dispose that lands before the child is spawned (or before the prompt is written) makes the fence not live, and the next
// side effect refuses. Every operation here is O(1): no history or pool scan.

/** The message a send ends with when it is stopped before it started. Callers classify by fence state, never by this text. */
export class SendStoppedError extends Error {
  readonly site: string;
  constructor(site: string) { super("the turn was stopped before it started"); this.site = site; this.name = "SendStoppedError"; }
}

export type SendKind = "send" | "prewarm";
/** Who already holds a thread outside the pending set: an active turn, or a destination probe. */
export interface Owner { kind: SendKind }

export interface SendFence {
  readonly threadId: string;
  readonly turnId: string;
  readonly kind: SendKind;
  readonly startEpoch: number;
  /** The prewarm-gate token a prewarm fence owns (warm-pool.ts O1); undefined for a send. */
  readonly gate?: object;
  /** True once start() took ownership (the turn is `active`): deferred cleanups belong to the turn now. */
  readonly handedOff: boolean;
  /** Not stopped, not disposed, and the thread epoch has not moved. Still valid after end(). */
  live(): boolean;
  /** A stop someone asked for (interrupt, reset, Stop All, a cancelled prewarm). Dispose is NOT a stop: it reads as the engine closing. */
  retired(): boolean;
  /** Throws SendStoppedError(site) when the fence is not live. */
  check(site: string): void;
  /** Frees the thread for the next send (admission) without ending the fence. Idempotent. */
  release(): void;
  /** Registers a cleanup that runs once at end() unless handOff() came first. */
  own(cleanup: () => void): void;
  /** The turn took ownership: owned cleanups are dropped here, the turn teardown runs them. */
  handOff(): void;
  /** Releases the reservation and runs owned cleanups not handed off. Idempotent. */
  end(): void;
}

export interface SendFences {
  begin(threadId: string, turnId: string, kind: SendKind, gate?: object): SendFence;
  /** Threads with a pending fence (Stop All retires these). */
  threads(): Iterable<string>;
  /** Kills one pending, not handed-off prewarm fence on the thread. No epoch move. Returns whether one was killed. */
  cancelPrewarm(threadId: string): boolean;
}

export const BUSY_MESSAGE = "a turn is already running on this thread";

export function createSendFences(o: { epochOf(threadId: string): number; disposed(): boolean; owner(threadId: string): Owner | null }): SendFences {
  const pending = new Map<string, Set<FenceImpl>>();
  class FenceImpl implements SendFence {
    killed = false;
    handedOff = false;
    private released = false;
    private ended = false;
    private cleanups: Array<() => void> = [];
    readonly startEpoch: number;
    readonly threadId: string; readonly turnId: string; readonly kind: SendKind; readonly gate?: object;
    constructor(threadId: string, turnId: string, kind: SendKind, gate?: object) { this.threadId = threadId; this.turnId = turnId; this.kind = kind; this.gate = gate; this.startEpoch = o.epochOf(threadId); }
    live() { return !this.killed && !o.disposed() && o.epochOf(this.threadId) === this.startEpoch; }
    retired() { return this.killed || o.epochOf(this.threadId) !== this.startEpoch; }
    check(site: string) { if (!this.live()) throw new SendStoppedError(site); }
    release() {
      if (this.released) return;
      this.released = true;
      const set = pending.get(this.threadId);
      if (!set) return;
      set.delete(this);
      if (set.size === 0) pending.delete(this.threadId);
    }
    own(cleanup: () => void) {
      if (this.ended) { cleanup(); return; }
      if (!this.handedOff) this.cleanups.push(cleanup);
    }
    handOff() { this.handedOff = true; this.cleanups = []; }
    end() {
      if (this.ended) return;
      this.ended = true;
      this.release();
      const run = this.cleanups;
      this.cleanups = [];
      for (const cleanup of run) cleanup();
    }
  }
  return {
    begin(threadId, turnId, kind, gate) {
      const set = pending.get(threadId);
      const owner = o.owner(threadId);
      if (kind === "prewarm") {
        // A prewarm never displaces anything: it yields to every owner and every pending send.
        if (owner || (set && set.size > 0)) throw new Error(BUSY_MESSAGE);
      } else {
        // A real send takes a prewarm over (the takeover path), but never a real send, an active turn or a probe.
        if (owner && owner.kind !== "prewarm") throw new Error(BUSY_MESSAGE);
        if (set) for (const other of set) if (other.kind === "send") throw new Error(BUSY_MESSAGE);
      }
      const fence = new FenceImpl(threadId, turnId, kind, gate);
      const into = set ?? new Set<FenceImpl>();
      into.add(fence);
      if (!set) pending.set(threadId, into);
      return fence;
    },
    threads: () => pending.keys(),
    cancelPrewarm(threadId) {
      const set = pending.get(threadId);
      if (!set) return false;
      let killed = false;
      for (const fence of set) if (fence.kind === "prewarm" && !fence.handedOff && !fence.killed) { fence.killed = true; killed = true; }
      return killed;
    },
  };
}

/** The single writer for ACP calls (design C3). Until the prompt is written, a call (any message with a method other than session/cancel) on a
 *  fence that is not live is refused: `halt` settles the turn cancelled at once, and the refusal is thrown. Responses (id with result or error)
 *  and session/cancel are never checked. `promptSent` flips only here, in the same tick as the prompt bytes. */
/** The gate before an ACP write: a call (not a cancel) written before the prompt, on a fence that is no longer live, halts the turn and throws. Synchronous, so the hook-to-write chain stays synchronous. */
export function fenceBeforeWrite(fence: SendFence, state: { promptSent: boolean }, msg: unknown, halt: () => void): void {
  const method = (msg as { method?: unknown } | null)?.method;
  if (typeof method === "string" && method !== "session/cancel" && !state.promptSent && !fence.live()) { halt(); throw new SendStoppedError(`write:${method}`); }
}
/** After the write: the prompt is out, so the fence no longer gates this turn's writes. */
export function fenceAfterWrite(state: { promptSent: boolean }, msg: unknown): void {
  if ((msg as { method?: unknown } | null)?.method === "session/prompt") state.promptSent = true;
}
export function fencedWrite<T>(fence: SendFence, state: { promptSent: boolean }, msg: unknown, write: () => T, halt: () => void): T {
  fenceBeforeWrite(fence, state, msg, halt);
  const result = write();
  fenceAfterWrite(state, msg);
  return result;
}
