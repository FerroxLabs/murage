// Producer backpressure for the event bus.
//
// The bus holds events that a listener has not committed yet. Instead of
// parking the overflow anywhere else (a side file would keep revoked content
// on disk), it keeps RAM bounded by slowing the producers: when the bus is at
// its global cap, a stdio engine's stdout is paused (the OS pipe then stalls
// the engine itself) and a fetch-streaming driver awaits `whenOpen` before it
// reads the next chunk. Both resume below the low-water mark. Events are never
// dropped and never reordered: whatever a source already read still goes into
// its thread's queue in order, so the bound is the cap plus at most the events
// framed from chunks already read when a source is told to stop.
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

type Entry = { threadId: string | null; stream: Readable; paused: boolean };

export class IntakeValve {
  private entries = new Set<Entry>();
  private waiters = new Set<{ threadId: string | null; resolve: () => void }>();
  private readonly closed: (threadId: string | null) => boolean;
  /** `closed` returns true while intake for this thread (null: a stream shared by several threads) must stand still. */
  constructor(closed: (threadId: string | null) => boolean) { this.closed = closed; }

  /** True when a producer for this thread may hand the bus another event now. Check right before `publish`. */
  isOpen(threadId: string | null): boolean { return !this.closed(threadId); }

  /** Resolves when `isOpen` holds. */
  whenOpen(threadId: string | null): Promise<void> {
    if (this.isOpen(threadId)) return Promise.resolve();
    return new Promise<void>(resolve => { this.waiters.add({ threadId, resolve }); });
  }

  /** Puts a readable under the valve. `owner` (the child process) lets a stream that is still paused when its process
   * exits drain what the OS pipe already holds, so 'close' can fire. Returns the unregister function. */
  register(threadId: string | null, stream: Readable, owner?: EventEmitter): () => void {
    const entry: Entry = { threadId, stream, paused: false };
    this.entries.add(entry);
    const drop = () => { this.entries.delete(entry); if (entry.paused) { entry.paused = false; try { stream.resume(); } catch { /* destroyed */ } } };
    stream.once("close", drop);
    owner?.once("exit", drop);
    this.evaluate();
    return drop;
  }

  /** Re-reads the bus state: pauses what must stop, resumes what may run, wakes the waiters. */
  evaluate() {
    for (const entry of [...this.entries]) {
      const stop = this.closed(entry.threadId);
      if (stop && !entry.paused) { entry.paused = true; try { entry.stream.pause(); } catch { /* destroyed */ } }
      else if (!stop && entry.paused) { entry.paused = false; try { entry.stream.resume(); } catch { /* destroyed */ } }
    }
    for (const waiter of [...this.waiters]) {
      if (!this.closed(waiter.threadId)) { this.waiters.delete(waiter); waiter.resolve(); }
    }
  }

  pausedCount(): number { let n = 0; for (const e of this.entries) if (e.paused) n++; return n; }
}

let active: IntakeValve | null = null;
/** The running server's bus installs its valve here; with none installed (tests, tools) every producer runs free. */
export function installIntakeValve(valve: IntakeValve | null) { active = valve; }
/** Called by an engine driver wherever it wires a child's stdout into its frame splitter. */
export function registerIntake(threadId: string | null, stream: Readable, owner?: EventEmitter): () => void {
  return active ? active.register(threadId, stream, owner) : () => {};
}
/** Called by a driver that reads a network stream: await before reading the next chunk. */
export function awaitIntake(threadId: string | null): Promise<void> {
  return active ? active.whenOpen(threadId) : Promise.resolve();
}
export function isIntakeOpen(threadId: string | null = null): boolean { return active ? active.isOpen(threadId) : true; }
