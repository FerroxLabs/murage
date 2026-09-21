import { randomUUID } from "node:crypto";
import { overlaps, sameOwner, TurnResources, type TurnOwner } from "./turn-resources.ts";

export const MAX_CONCURRENT_BOT_THREADS = 3;

/** How long a turn will wait for a thread ahead of it before giving up.
 * Deliberately longer than the 20-minute inactivity watchdog that interrupts
 * a stalled holder and releases its claims: anything still holding after this
 * is a turn that is genuinely working, and a waiter that has been queued for
 * an hour is better told so than left in a wait that can never end on its own. */
export const RESOURCE_WAIT_TIMEOUT_MS = 60 * 60_000;

/** A wait that hit its deadline. Distinct from a wait that resolved false:
 * nobody stopped this turn and it was never refused — the thread ahead of it
 * simply never let go, and an unattended run (a queued routine at 8am) had no
 * one to press Stop for it. */
export class ResourceWaitTimeout extends Error {
  // Plain fields, assigned in the body: the server runs under Node's
  // type-stripping loader, which rejects TypeScript parameter properties.
  readonly resources: readonly string[];
  readonly waitedMs: number;
  constructor(resources: readonly string[], waitedMs: number) {
    super(`waited ${Math.round(waitedMs / 1000)}s for another thread to release this browser, computer or working folder`);
    this.name = "ResourceWaitTimeout";
    this.resources = resources;
    this.waitedMs = waitedMs;
  }
}

export type DirectThreadRun<T> = Readonly<TurnOwner & {
  botId: string;
  snapshot: T;
  phase: "setup" | "dispatching" | "running" | "stopping" | "settling";
  providerTurnId?: string;
}>;
/** Who a waiting turn is waiting for: a holder of an overlapping claim, or an
 * earlier waiter whose overlapping set is served first. */
export type ResourceBlocker = Readonly<{ resource: string; owner: TurnOwner; queued: boolean }>;
type ResourceWaiter = {
  owner: TurnOwner;
  resources: readonly string[];
  resolve: (granted: boolean) => void;
  onWait?: (blockers: readonly ResourceBlocker[]) => void;
  shown?: string;
};

/** A run's detached routing snapshot survives UI selection changes. Cancelling
 * retires dispatch authority immediately; resource and capacity leases remain
 * until the caller confirms provider teardown/final screen settlement. */
export class IndependentThreadRuns<T> {
  private readonly runs = new Map<string, DirectThreadRun<T>>();
  private readonly resources = new TurnResources();
  /** FIFO. A waiter never holds a claim, so waiting cannot deadlock. */
  private readonly waiters: ResourceWaiter[] = [];
  private pumping = false;
  private pumpAgain = false;
  /** Generations admitted past the three-thread limit that do not yet hold a
   * thread slot, and the FIFO of those waiting for one. */
  private readonly slotless = new Set<string>();
  private readonly slotWaiters: { owner: TurnOwner; botId: string; resolve: (granted: boolean) => void }[] = [];

  /** `queueForSlot` (queued automation only): at the limit, admit without a
   * thread slot instead of refusing; the caller must `awaitSlot` before any
   * setup. A direct send counts every admitted run, so it never overtakes a
   * queued one. */
  admit(botId: string, threadId: string, snapshot: T, resources: readonly string[] = [], options: { queueForSlot?: boolean } = {}): DirectThreadRun<T> {
    if (this.runs.has(threadId)) throw conflict("thread_busy", "This thread is already running or stopping.");
    const needsSlot = this.forBot(botId).length >= MAX_CONCURRENT_BOT_THREADS;
    if (needsSlot && !options.queueForSlot) {
      throw conflict("thread_limit", "This bot is already running three threads. Wait for one to finish.");
    }
    const copied = structuredClone(snapshot);
    const owner = { threadId, generation: randomUUID() };
    if (!this.resources.claimAll(resources, owner)) throw conflict("resource_busy", "Another thread is using this browser, computer or working folder.");
    const run: DirectThreadRun<T> = Object.freeze({ ...owner, botId, snapshot: copied, phase: "setup" });
    this.runs.set(threadId, run);
    if (needsSlot) this.slotless.add(owner.generation);
    return run;
  }

  /** Resolves true once this run holds a thread slot (at once when it was
   * admitted with one), false when it is stopped, released or replaced first.
   * `onWait` fires once, synchronously, only when the run has to wait. */
  awaitSlot(owner: TurnOwner, onWait?: () => void): Promise<boolean> {
    if (!this.claimable(owner)) return Promise.resolve(false);
    if (!this.slotless.has(owner.generation)) return Promise.resolve(true);
    const botId = this.runs.get(owner.threadId)!.botId;
    return new Promise<boolean>((resolve) => {
      this.slotWaiters.push({ owner, botId, resolve });
      onWait?.();
      this.pump();
    });
  }

  get(threadId: string): DirectThreadRun<T> | undefined { return this.runs.get(threadId); }
  forBot(botId: string): readonly DirectThreadRun<T>[] { return [...this.runs.values()].filter(run => run.botId === botId); }
  current(owner: TurnOwner): boolean { return this.runs.get(owner.threadId)?.generation === owner.generation; }

  claim(owner: TurnOwner, resources: readonly string[]): boolean {
    // A run that already holds claims (and so is past admission) may extend
    // them with free resources: queued waiters never displace a holder. A run
    // holding nothing stays behind earlier waiters for overlapping resources.
    const holding = this.resources.heldBy(owner).length > 0;
    return this.claimable(owner) && (holding || !this.queuedAhead(resources, owner).length) && this.resources.claimAll(resources, owner);
  }

  /** Claim `resources` together with everything this generation already
   * holds, waiting for other threads instead of refusing. Before waiting the
   * turn releases every claim it holds (never wait while holding), then
   * re-claims the whole union atomically when a release lets it in. Resolves
   * false when the run is cancelled, released or replaced while waiting. */
  acquire(
    owner: TurnOwner,
    resources: readonly string[],
    onWait?: (blockers: readonly ResourceBlocker[]) => void,
    timeoutMs?: number,
  ): Promise<boolean> {
    if (!this.claimable(owner)) return Promise.resolve(false);
    const wanted = [...new Set([...this.resources.heldBy(owner), ...resources])];
    if (this.claim(owner, wanted)) return Promise.resolve(true);
    this.resources.release(owner);
    return new Promise<boolean>((resolve, reject) => {
      const waiter: ResourceWaiter = { owner, resources: wanted, resolve, onWait };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          // Leave the QUEUE, not just the promise. A bare Promise.race would
          // abandon the caller while this waiter stayed queued: the next
          // release would hand it the resources, and it would then hold a
          // browser, computer or working folder on behalf of a turn that has
          // already failed, with nobody left to release it.
          this.waiters.splice(index, 1);
          // This waiter may have been the one holding later waiters back.
          this.pump();
          reject(new ResourceWaitTimeout(wanted, timeoutMs));
        }, timeoutMs);
        // A pending wait must never keep the process alive on its own.
        timer.unref?.();
        waiter.resolve = (granted) => { clearTimeout(timer); resolve(granted); };
      }
      this.waiters.push(waiter);
      // Our own release may already admit an earlier waiter, and with it this one.
      this.pump();
    });
  }

  /** Hand back part of this generation's claims mid-turn, and let whoever was
   * queued behind them in. Silently ignored once the generation is gone: a
   * late release must never disturb the run that replaced it. */
  releaseResources(owner: TurnOwner, resources: readonly string[]): string[] {
    if (!this.current(owner)) return [];
    const released = this.resources.releaseSome(owner, resources);
    if (released.length) this.pump();
    return released;
  }

  /** Whether this generation is waiting for a shared resource. */
  waiting(owner: TurnOwner): boolean { return this.waiters.some(waiter => sameOwner(waiter.owner, owner)); }
  owns(owner: TurnOwner, resource: string): boolean { return this.current(owner) && this.resources.owns(resource, owner); }

  dispatch(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    if (!run || !this.current(owner) || run.phase !== "setup") return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "dispatching" }));
    return true;
  }

  accepted(owner: TurnOwner, providerTurnId: string): boolean {
    const run = this.runs.get(owner.threadId);
    // A synchronous completion may already have moved to settling or removed
    // this generation before sendTurn returns. Never reactivate it here.
    if (!run || !this.current(owner) || run.phase !== "dispatching") return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "running", providerTurnId }));
    return true;
  }

  cancel(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    if (!run || !this.current(owner)) return false;
    this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "stopping" }));
    this.pump();
    return true;
  }

  settling(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    if (!run || !this.current(owner)) return false;
    // A stopped run's terminal event does not revive it: it stays "stopping"
    // (dispatch authority retired) until its provider teardown is confirmed.
    if (run.phase !== "stopping") this.runs.set(owner.threadId, Object.freeze({ ...run, phase: "settling" }));
    return true;
  }

  /** Only after teardown/final capture is confirmed. Late cleanup is harmless. */
  release(owner: TurnOwner): boolean {
    if (!this.current(owner)) return false;
    this.resources.release(owner);
    this.runs.delete(owner.threadId);
    this.slotless.delete(owner.generation);
    this.pump();
    return true;
  }

  private claimable(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    return Boolean(run && this.current(owner) && run.phase !== "stopping" && run.phase !== "settling");
  }

  private queuedAhead(resources: readonly string[], owner: TurnOwner, before = this.waiters.length): ResourceBlocker[] {
    const blocked: ResourceBlocker[] = [];
    for (const resource of resources) {
      const waiter = this.waiters.slice(0, before).find(candidate => !sameOwner(candidate.owner, owner) && candidate.resources.some(key => overlaps(key, resource)));
      if (waiter) blocked.push({ resource, owner: waiter.owner, queued: true });
    }
    return blocked;
  }

  /** Runs on every release/cancel: event-driven, never polled. Serves waiters
   * in arrival order; a later waiter is skipped while an earlier waiter with
   * an overlapping set is still blocked, so nobody starves. */
  private pump(): void {
    // A wait callback may synchronously cancel or release another run; that
    // nested pump is folded into another pass instead of re-entering the loop.
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do { this.pumpAgain = false; this.pumpOnce(); } while (this.pumpAgain);
    } finally { this.pumping = false; }
  }

  private pumpOnce(): void {
    for (let index = 0; index < this.slotWaiters.length;) {
      const waiter = this.slotWaiters[index];
      if (!this.claimable(waiter.owner)) {
        this.slotWaiters.splice(index, 1);waiter.resolve(false);continue;
      }
      const holding = this.forBot(waiter.botId).filter(run => !this.slotless.has(run.generation)).length;
      if (holding < MAX_CONCURRENT_BOT_THREADS) {
        this.slotless.delete(waiter.owner.generation);
        this.slotWaiters.splice(index, 1);waiter.resolve(true);continue;
      }
      index++;
    }
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (!this.claimable(waiter.owner)) {
        this.waiters.splice(index, 1);waiter.resolve(false);continue;
      }
      const ahead = this.queuedAhead(waiter.resources, waiter.owner, index);
      if (!ahead.length && this.resources.claimAll(waiter.resources, waiter.owner)) {
        this.waiters.splice(index, 1);waiter.resolve(true);continue;
      }
      const blockers = [
        ...this.resources.conflicts(waiter.resources, waiter.owner).map(blocker => ({ ...blocker, queued: false })),
        ...ahead,
      ];
      const shown = blockers.map(blocker => `${blocker.resource}\0${blocker.owner.threadId}\0${blocker.owner.generation}`).join("\n");
      if (waiter.shown !== shown) { waiter.shown = shown; waiter.onWait?.(blockers); }
      index++;
    }
  }
}

function conflict(code: string, message: string) { return Object.assign(new Error(message), { status: 409, code }); }

/** Old clients may omit a target only while there is exactly one direct task.
 * Always validate supplied targets; never redirect an explicit wrong target. */
export function requireDirectThreadTarget(taskIds: readonly string[], requested: unknown): string {
  if (requested === undefined) {
    if (taskIds.length !== 1) throw conflict("thread_required", "Choose a thread explicitly. Update this client to use independent threads.");
    return taskIds[0];
  }
  if (typeof requested !== "string" || !/^[\w-]+$/.test(requested)) throw Object.assign(new Error("threadId must be a task id"), { status: 400 });
  if (!taskIds.includes(requested)) throw Object.assign(new Error("No such thread for this bot."), { status: 404 });
  return requested;
}
