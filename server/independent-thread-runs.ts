import { randomUUID } from "node:crypto";
import { overlaps, sameOwner, TurnResources, type TurnOwner } from "./turn-resources.ts";
import type { TaskResourceWait } from "./store.ts";

export const MAX_CONCURRENT_BOT_THREADS = 3;

/** The deadline a caller may still pass to `acquire`. Since 1.0.4 (SL-L L3)
 * the server's turn waits pass none: a waiter waits until it is granted,
 * stopped, replaced or the process ends, with its place in line shown. */
export const RESOURCE_WAIT_TIMEOUT_MS = 60 * 60_000;
/** SL-L L3: after this long in line a turn writes one "still waiting" line
 * (never repeated; the live chip carries the position). Longer than the
 * 20-minute inactivity watchdog that interrupts a stalled holder. */
export const RESOURCE_STILL_WAITING_MS = 60 * 60_000;
/** What is left of the "still waiting" hour for a wait that began at `firstWaitAt` (at least 1 ms, so the notice still fires). */
export function stillWaitingRemainingMs(firstWaitAt: number | undefined, now: number): number {
  return firstWaitAt === undefined ? RESOURCE_STILL_WAITING_MS : Math.max(1, RESOURCE_STILL_WAITING_MS - (now - firstWaitAt));
}
/** SL-L L2: claim-to-release history per resource kind, kept in memory only. */
const ESTIMATE_ALPHA = 0.3;
const ESTIMATE_MIN_SAMPLES = 3;

/** A wait that hit a caller's deadline. Distinct from a wait that resolved
 * false: nobody stopped this turn and it was never refused. No server turn
 * passes a deadline since 1.0.4 (SL-L L3); the class stays for callers that do. */
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
/** Told whenever the blockers or the waiter's place in line change. `position`
 * is 1 + the distinct earlier waiters whose set overlaps this one's; the
 * estimate is present only once every blocking kind has 3 measured holds. */
export type ResourceWaitListener = (blockers: readonly ResourceBlocker[], position: number, estimateMs?: number) => void;
/** One notice after `afterMs` in line, never repeated. */
export type ResourceLongWait = Readonly<{ afterMs: number; notify: () => void }>;
type ResourceWaiter = {
  owner: TurnOwner;
  resources: readonly string[];
  resolve: (granted: boolean | "yielded") => void;
  onWait?: ResourceWaitListener;
  yields?: (blockers: readonly ResourceBlocker[]) => boolean;
  shown?: string;
};

/** A turn may go on WITHOUT some of what it asked for instead of waiting for
 * it: `resources` names what it can do without, and `holderYields` says
 * whether a holder is one worth not waiting behind. The built-in browser is
 * the case (D4): a routine that holds the bot's browser profile while it
 * waits for the person's approval, possibly for hours, must not block every
 * other conversation with that bot. The turn that goes on never claims the
 * browser, so two turns still never drive the same profile at once. */
export type ResourceYield = Readonly<{ resources: ReadonlySet<string>; holderYields: (holder: TurnOwner) => boolean }>;

function yieldsTo(policy: ResourceYield, blockers: readonly ResourceBlocker[]): boolean {
  return blockers.length > 0 && blockers.every(blocker =>
    !blocker.queued && policy.resources.has(blocker.resource) && policy.holderYields(blocker.owner));
}

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
  /** SL-L L2: when each held resource was claimed, by generation. */
  private readonly claimedAt = new Map<string, Map<string, number>>();
  /** SL-L L2: EWMA of claim-to-release durations per resource kind (the key's prefix). */
  private readonly holdHistory = new Map<string, { samples: number; ewma: number }>();
  /** The one run per bot holding the owner's reserved slot above the limit. */
  private readonly ownerReserved = new Set<string>();
  /** Owner sends waiting for a slot: served ahead of automation. */
  private readonly ownerWaiting = new Set<string>();
  /** Every run admitted as the owner's own send, until it is released (owner-first.ts counts them). */
  private readonly ownerSends = new Set<string>();

  /** `queueForSlot` (queued automation only): at the limit, admit without a
   * thread slot instead of refusing; the caller must `awaitSlot` before any
   * setup. A direct send counts every admitted run, so it never overtakes a
   * queued one. */
  admit(botId: string, threadId: string, snapshot: T, resources: readonly string[] = [], options: { queueForSlot?: boolean; ownerFirst?: boolean } = {}): DirectThreadRun<T> {
    if (this.runs.has(threadId)) throw conflict("thread_busy", "This thread is already running or stopping.");
    const running = this.forBot(botId);
    let needsSlot = running.length >= MAX_CONCURRENT_BOT_THREADS;
    // Owner first (SPEC-P 7.2 step 8 [AMB-6]): the owner's own send is never
    // refused at the limit. It takes one reserved slot above it; with that
    // taken it waits for a slot ahead of every queued automation run.
    let reserved = false;
    if (needsSlot && options.ownerFirst && !running.some(run => this.ownerReserved.has(run.generation))) {
      needsSlot = false;
      reserved = true;
    }
    if (needsSlot && !options.queueForSlot && !options.ownerFirst) {
      throw conflict("thread_limit", "This bot is already running three threads. Wait for one to finish.");
    }
    const copied = structuredClone(snapshot);
    const owner = { threadId, generation: randomUUID() };
    if (!this.resources.claimAll(resources, owner)) throw conflict("resource_busy", "Another thread is using this browser, computer or working folder.");
    const run: DirectThreadRun<T> = Object.freeze({ ...owner, botId, snapshot: copied, phase: "setup" });
    this.runs.set(threadId, run);
    this.stamp(owner);
    if (needsSlot) this.slotless.add(owner.generation);
    if (reserved) this.ownerReserved.add(owner.generation);
    if (needsSlot && options.ownerFirst) this.ownerWaiting.add(owner.generation);
    if (options.ownerFirst) this.ownerSends.add(owner.generation);
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
      const waiter = { owner, botId, resolve };
      if (this.ownerWaiting.has(owner.generation)) {
        // ahead of every automation run, behind earlier owner sends
        const firstAutomation = this.slotWaiters.findIndex(entry => !this.ownerWaiting.has(entry.owner.generation));
        if (firstAutomation < 0) this.slotWaiters.push(waiter); else this.slotWaiters.splice(firstAutomation, 0, waiter);
      } else this.slotWaiters.push(waiter);
      onWait?.();
      this.pump();
    });
  }

  get(threadId: string): DirectThreadRun<T> | undefined { return this.runs.get(threadId); }
  /** Any run at all, in any phase (setup through settling). */
  any(): boolean { return this.runs.size > 0; }
  forBot(botId: string): readonly DirectThreadRun<T>[] { return [...this.runs.values()].filter(run => run.botId === botId); }
  current(owner: TurnOwner): boolean { return this.runs.get(owner.threadId)?.generation === owner.generation; }

  claim(owner: TurnOwner, resources: readonly string[]): boolean {
    // A run that already holds claims (and so is past admission) may extend
    // them with free resources: queued waiters never displace a holder. A run
    // holding nothing stays behind earlier waiters for overlapping resources.
    const holding = this.resources.heldBy(owner).length > 0;
    const claimed = this.claimable(owner) && (holding || !this.queuedAhead(resources, owner).length) && this.resources.claimAll(resources, owner);
    if (claimed) this.stamp(owner);
    return claimed;
  }

  /** Claim `resources` together with everything this generation already
   * holds, waiting for other threads instead of refusing. Before waiting the
   * turn releases every claim it holds (never wait while holding), then
   * re-claims the whole union atomically when a release lets it in. Resolves
   * false when the run is cancelled, released or replaced while waiting. */
  acquire(
    owner: TurnOwner,
    resources: readonly string[],
    onWait?: ResourceWaitListener,
    timeoutMs?: number,
    yieldPolicy?: ResourceYield,
    longWait?: ResourceLongWait,
  ): Promise<boolean | "yielded"> {
    if (!this.claimable(owner)) return Promise.resolve(false);
    const wanted = [...new Set([...this.resources.heldBy(owner), ...resources])];
    if (this.claim(owner, wanted)) return Promise.resolve(true);
    // "yielded": go on without the yieldable resources. Decided before any
    // release, so a turn that does not wait keeps everything it held.
    if (yieldPolicy && yieldsTo(yieldPolicy, this.blockersFor(wanted, owner, this.waiters.length))) return Promise.resolve("yielded");
    this.resources.release(owner);
    // Handed back to wait, not released: no hold is measured for the estimate.
    this.claimedAt.delete(owner.generation);
    return new Promise<boolean | "yielded">((resolve, reject) => {
      const waiter: ResourceWaiter = { owner, resources: wanted, resolve, onWait,
        ...(yieldPolicy ? { yields: (blockers: readonly ResourceBlocker[]) => yieldsTo(yieldPolicy, blockers) } : {}) };
      if (longWait && longWait.afterMs > 0) {
        const timer = setTimeout(() => {
          if (this.waiters.includes(waiter)) longWait.notify();
        }, longWait.afterMs);
        timer.unref?.();
        const settle = waiter.resolve;
        waiter.resolve = (granted) => { clearTimeout(timer); settle(granted); };
      }
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
        const settle = waiter.resolve;
        waiter.resolve = (granted) => { clearTimeout(timer); settle(granted); };
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
    const stamps = this.claimedAt.get(owner.generation);
    for (const resource of released) stamps?.delete(resource);
    if (released.length) this.pump();
    return released;
  }

  /** What this generation holds right now. A turn that yields while queued
   * has already released these (it never waits holding), so its caller
   * re-acquires them without the yielded resources. */
  heldBy(owner: TurnOwner): string[] { return this.current(owner) ? this.resources.heldBy(owner) : []; }

  /** Re-examine every waiter: a holder may have become one worth not waiting
   * behind (it started waiting for the person) without releasing anything. */
  recheck(): void { if (this.waiters.length) this.pump(); }

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

  /** Told the conversation whose run was just released, and its bot (the shared queue wakes the teams waiting on that conversation, and on the bot's slot). */
  onReleased?: (threadId: string, botId: string | undefined) => void;

  /** Only after teardown/final capture is confirmed. Late cleanup is harmless. */
  release(owner: TurnOwner): boolean {
    if (!this.current(owner)) return false;
    this.resources.release(owner);
    this.measureHolds(owner);
    const botId = this.runs.get(owner.threadId)?.botId;
    this.runs.delete(owner.threadId);
    try { this.onReleased?.(owner.threadId, botId); } catch { /* a listener never keeps a run from being released */ }
    this.slotless.delete(owner.generation);
    this.ownerReserved.delete(owner.generation);
    this.ownerWaiting.delete(owner.generation);
    this.ownerSends.delete(owner.generation);
    this.pump();
    return true;
  }

  /** Owner sends still preparing, sending or streaming (not stopping or settling). */
  ownerRunCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (this.ownerSends.has(run.generation) && run.phase !== "stopping" && run.phase !== "settling") count++;
    }
    return count;
  }

  /** Record when each resource this generation now holds was first claimed. */
  private stamp(owner: TurnOwner): void {
    const held = this.resources.heldBy(owner);
    if (!held.length) return;
    let stamps = this.claimedAt.get(owner.generation);
    if (!stamps) { stamps = new Map(); this.claimedAt.set(owner.generation, stamps); }
    const now = Date.now();
    for (const resource of held) if (!stamps.has(resource)) stamps.set(resource, now);
  }

  /** On release: one claim-to-release sample per held resource, by kind. */
  private measureHolds(owner: TurnOwner): void {
    const stamps = this.claimedAt.get(owner.generation);
    this.claimedAt.delete(owner.generation);
    if (!stamps) return;
    const now = Date.now();
    for (const [resource, at] of stamps) {
      const kind = resourceKindKey(resource);
      const held = Math.max(0, now - at);
      const history = this.holdHistory.get(kind);
      this.holdHistory.set(kind, history
        ? { samples: history.samples + 1, ewma: ESTIMATE_ALPHA * held + (1 - ESTIMATE_ALPHA) * history.ewma }
        : { samples: 1, ewma: held });
    }
  }

  /** `position x ewma` for the slowest blocking kind; absent until each
   * blocking kind has enough measured holds (an honest blank, never a guess). */
  private estimate(blockers: readonly ResourceBlocker[], position: number): number | undefined {
    const kinds = [...new Set(blockers.map(blocker => resourceKindKey(blocker.resource)))];
    if (!kinds.length) return undefined;
    let slowest = 0;
    for (const kind of kinds) {
      const history = this.holdHistory.get(kind);
      if (!history || history.samples < ESTIMATE_MIN_SAMPLES) return undefined;
      slowest = Math.max(slowest, history.ewma);
    }
    return Math.round(position * slowest);
  }

  /** 1 + the DISTINCT earlier waiters (by owner) whose set overlaps this one's. */
  private placeInLine(index: number): number {
    const waiter = this.waiters[index];
    const ahead = new Set<string>();
    for (let earlier = 0; earlier < index; earlier++) {
      const candidate = this.waiters[earlier];
      if (sameOwner(candidate.owner, waiter.owner)) continue;
      if (candidate.resources.some(key => waiter.resources.some(resource => overlaps(key, resource)))) {
        ahead.add(`${candidate.owner.threadId}\0${candidate.owner.generation}`);
      }
    }
    return 1 + ahead.size;
  }

  private claimable(owner: TurnOwner): boolean {
    const run = this.runs.get(owner.threadId);
    return Boolean(run && this.current(owner) && run.phase !== "stopping" && run.phase !== "settling");
  }

  private blockersFor(resources: readonly string[], owner: TurnOwner, before: number): ResourceBlocker[] {
    return [
      ...this.resources.conflicts(resources, owner).map(blocker => ({ ...blocker, queued: false })),
      ...this.queuedAhead(resources, owner, before),
    ];
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
      // the owner's reserved slot sits above the limit and frees none of it
      const holding = this.forBot(waiter.botId).filter(run => !this.slotless.has(run.generation) && !this.ownerReserved.has(run.generation)).length;
      if (holding < MAX_CONCURRENT_BOT_THREADS) {
        this.slotless.delete(waiter.owner.generation);
        this.ownerWaiting.delete(waiter.owner.generation);
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
        this.stamp(waiter.owner);
        this.waiters.splice(index, 1);waiter.resolve(true);continue;
      }
      const blockers = this.blockersFor(waiter.resources, waiter.owner, index);
      if (waiter.yields?.(blockers)) {
        this.waiters.splice(index, 1);waiter.resolve("yielded");continue;
      }
      const position = this.placeInLine(index);
      // Also when only the place in line moved (an earlier waiter left).
      const shown = `${blockers.map(blocker => `${blocker.resource}\0${blocker.owner.threadId}\0${blocker.owner.generation}`).join("\n")}\n#${position}`;
      if (waiter.shown !== shown) { waiter.shown = shown; waiter.onWait?.(blockers, position, this.estimate(blockers, position)); }
      index++;
    }
  }
}

/** The kind a hold is measured under: the resource key's prefix ("workspace", "computer", "browser", "screen"). */
function resourceKindKey(resource: string): string {
  const colon = resource.indexOf(":");
  return colon > 0 ? resource.slice(0, colon) : resource;
}

const STILL_WAITING_USE: Record<TaskResourceWait["resource"], string> = {
  "working-folder": "the working folder",
  computer: "the computer",
  browser: "the browser profile",
  shared: "the computer, browser or working folder",
  "thread-slot": "a free thread",
};

/** SL-L L3: the one activity line a turn writes after an hour in line. */
export function stillWaitingLine(wait: TaskResourceWait): string {
  const use = STILL_WAITING_USE[wait.resource] ?? STILL_WAITING_USE.shared;
  const title = typeof wait.holderTitle === "string" ? wait.holderTitle.trim() : "";
  return title ? `Still waiting for '${title}' to finish using ${use}` : `Still waiting for another thread to finish using ${use}`;
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
