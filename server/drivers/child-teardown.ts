// Close-confirmed provider teardown (0.1.52 A2 / R1-T2).
//
// A kill request, a delivered SIGTERM, a started taskkill or an acknowledged
// session/cancel is not closure. Drivers that run one child process per turn
// track that child here from spawn until Node reports `close`, so the harness
// can keep a thread's workspace/computer ownership until the process that was
// using it is really gone. The wait is bounded: at the deadline the answer is
// `closeConfirmed:false`, never an optimistic success, and the child stays
// tracked so a later close is still observed.
import type { ChildProcess } from "node:child_process";

import type { ProviderStopResult } from "../contracts.ts";
import { awaitCliTreeStopped, cliStopDelivery, cliTreeStoppedSignal, WINDOWS_STOP_ROUTE_CAP_MS, type StopDelivery } from "../procs.ts";

/** Wait for `close` after termination was requested. Same bound codex uses. */
export const PROVIDER_CLOSE_DEADLINE_MS = 5_000;

/** Read at call time so an isolated fixture can shorten (never disable) it. */
export function providerCloseDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MURAGE_PROVIDER_CLOSE_MS);
  return Number.isFinite(value) && value > 0 ? value : PROVIDER_CLOSE_DEADLINE_MS;
}

type UnconfirmedStop = Extract<ProviderStopResult, { closeConfirmed: false }>;

/** interruptTurn/stopAll/dispose reject with this at the deadline. The child
 * is still owned; callers must retain the resources it was using. */
export class ProviderStopUnconfirmedError extends Error {
  readonly code = "provider_stop_unconfirmed";
  readonly stopResult: UnconfirmedStop;
  constructor(driver: string, stopResult: UnconfirmedStop) {
    super(`${driver} did not exit after termination was requested; its process remains owned`);
    this.name = "ProviderStopUnconfirmedError";
    this.stopResult = stopResult;
  }
}

export interface TeardownWait {
  /** Budget that starts once termination has been requested (or at the wait
   * if it already was). */
  closeMs: number;
  /** Absolute cap from the wait itself, for a stop that is requested through
   * a grace period (ACP session/cancel) rather than immediately. */
  maxMs: number;
}

/** An immediate stop (dispose at Quit, stopAll at an engine switch) answers inside this, on every platform: one second inside
 * the server's own shutdown (graceful-shutdown.ts SERVER_SHUTDOWN_TIMEOUT_MS), which is inside the desktop's graceful close.
 * A stop still unconfirmed at the budget keeps running in the background (its own route cap, the stopped signal), and on
 * Windows the engine job's members end with the server's handles whatever the server itself manages (U24 design R7). */
export const PROVIDER_DISPOSE_BUDGET_MS = 5_000;

/** U24: the budget for a stop whose kill goes out after `graceMs` (an ACP session/cancel grace). With no grace it is the
 * immediate-stop budget above. With a grace (an interactive Stop, nothing above it has a shorter deadline) the absolute cap
 * is the grace plus the longest route: on Windows the taskkill route's cap (WINDOWS_STOP_ROUTE_CAP_MS, which caps taskkill
 * itself), elsewhere the close budget. The close budget counts from delivery (ChildTeardown), so a stop delivered quickly is
 * not held longer. */
export function stopBudget(graceMs: number, closeMs: number = providerCloseDeadlineMs(), platform: NodeJS.Platform = process.platform): TeardownWait {
  if (graceMs <= 0) return { closeMs: Math.min(closeMs, PROVIDER_DISPOSE_BUDGET_MS), maxMs: PROVIDER_DISPOSE_BUDGET_MS };
  return { closeMs, maxMs: graceMs + (platform === "win32" ? Math.max(closeMs, WINDOWS_STOP_ROUTE_CAP_MS) : closeMs) };
}

const CONFIRMED: ProviderStopResult = Object.freeze({ closeConfirmed: true });
const timedOut = (): UnconfirmedStop => ({ closeConfirmed: false, reason: "timeout" });

interface Waiter {
  closeMs: number;
  resolve: (result: ProviderStopResult) => void;
  closeTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout>;
}

/** Observation of one child process's lifetime. */
/** How long a tree confirmed stopped waits for the root's own `close` before it counts as closed anyway (see
 * ChildTeardown.#treeStoppedConfirmed). An empty Windows job leaves nothing that can hold the root's streams open, so
 * `close` lands within moments; the bound only covers a close Node never reports. */
export const ROOT_CLOSE_GRACE_MS = 1_000;

/** A child whose exit and every stdio stream are already done: its `close` has been emitted before this observation. */
const alreadyClosed = (child: ChildProcess): boolean =>
  (typeof child.exitCode === "number" || typeof child.signalCode === "string")
  && [child.stdin, child.stdout, child.stderr].every((stream) => !stream || stream.destroyed);

export class ChildTeardown {
  #closed: boolean;
  #rootClosed = false;
  #treeStopped = false;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  #confirming = false;
  #stopRequested = false;
  #subscribed = false;
  readonly #waiters = new Set<Waiter>();
  readonly #onClosed: Array<() => void> = [];
  private readonly child: ChildProcess;
  private readonly confirm: (child: ChildProcess) => Promise<boolean>;
  private readonly delivery: (child: ChildProcess) => StopDelivery;
  private readonly stoppedSignal: (child: ChildProcess) => Promise<true>;

  constructor(
    child: ChildProcess,
    confirm: (child: ChildProcess) => Promise<boolean> = awaitCliTreeStopped,
    delivery: (child: ChildProcess) => StopDelivery = cliStopDelivery,
    stoppedSignal: (child: ChildProcess) => Promise<true> = cliTreeStoppedSignal,
  ) {
    this.child = child;
    this.confirm = confirm;
    this.delivery = delivery;
    this.stoppedSignal = stoppedSignal;
    // spawn() assigns the pid synchronously on success. No pid means the OS
    // never created a process (ENOENT, EACCES): there is nothing to close.
    this.#closed = child.pid === undefined;
    this.#rootClosed = !this.#closed && alreadyClosed(child);
    child.once("close", this.#onRootClose);
  }

  readonly #onRootClose = () => {
    this.#rootClosed = true;
    if (this.#treeStopped) this.#markClosed();
    else this.#confirm();
  };

  // The tree is confirmed stopped. On POSIX and on the Windows taskkill route that confirmation already includes the root's
  // `close`; the Windows job route confirms on the empty job alone (U24 design R5), which can answer before Node reports the
  // root's `close`. The driver's own close handling (the turn's settle, its last lifecycle and native log rows) runs on that
  // `close`, so the child counts as closed only once it has been seen, bounded by ROOT_CLOSE_GRACE_MS: a dispose, a deletion
  // hold or a turn teardown wait then never answers ahead of it, on every platform alike.
  #treeStoppedConfirmed(): void {
    if (this.#closed) return;
    this.#treeStopped = true;
    if (this.#rootClosed) { this.#markClosed(); return; }
    if (this.#graceTimer) return;
    this.#graceTimer = setTimeout(() => this.#markClosed(), ROOT_CLOSE_GRACE_MS);
    this.#graceTimer.unref?.();
  }

  /** The turn this observation belongs to has handed its still-running child
   * back to a driver's idle session pool (the ACP pool, #1575): the turn no
   * longer owns it, so every wait for the turn resolves confirmed. The child
   * itself is tracked from then on by the pool's own teardown, which stopAll,
   * dispose, reset and interrupt wait on. Never call this for a child that
   * is still serving the turn. */
  detach(): void {
    this.child.removeListener("close", this.#onRootClose);
    this.#markClosed();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The driver has asked the OS to terminate this child. */
  markStopRequested(): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    // A wait that began before the request (a stop with a grace) starts the confirmation now, as wait() does once it was requested.
    // A microtask later, so the caller's own kill (which registers its stop-route observer) goes out first and the confirmation
    // joins that route instead of starting one without it.
    if (this.#waiters.size) queueMicrotask(() => this.#confirm());
    for (const waiter of this.#waiters) this.#armClose(waiter);
  }

  onClosed(callback: () => void): void {
    if (this.#closed) callback();
    else this.#onClosed.push(callback);
  }

  wait({ closeMs, maxMs }: TeardownWait): Promise<ProviderStopResult> {
    if (this.#closed) return Promise.resolve(CONFIRMED);
    if (this.#rootClosed || this.#stopRequested) this.#confirm();
    return new Promise((resolve) => {
      const waiter: Waiter = {
        closeMs,
        resolve,
        closeTimer: null,
        maxTimer: setTimeout(() => this.#expire(waiter), Math.max(maxMs, closeMs)),
      };
      waiter.maxTimer.unref?.();
      this.#waiters.add(waiter);
      if (this.#stopRequested) this.#armClose(waiter);
    });
  }

  #confirm(): void {
    if (this.#closed || this.#confirming) return;
    this.#confirming = true;
    void this.confirm(this.child).then((stopped) => {
      this.#confirming = false;
      if (stopped) this.#treeStoppedConfirmed();
      else this.#subscribe();
    }, () => { this.#confirming = false; this.#subscribe(); });
  }

  // U24 design R5: a confirmation that read "not stopped" at a caller cap (the Windows job route answers every caller at
  // JOB_STOP_CAP_MS while its attempt continues) is followed by the tree's durable stopped signal, so a late success
  // releases every waiter and onClosed callback without another Stop. The signal holds no timer and never resolves for
  // a tree that is never confirmed; subscribing once is enough.
  #subscribe(): void {
    if (this.#subscribed || this.#closed) return;
    this.#subscribed = true;
    void this.stoppedSignal(this.child).then(() => this.#treeStoppedConfirmed(), () => {});
  }

  #armClose(waiter: Waiter): void {
    if (waiter.closeTimer) return;
    this.#closeIn(waiter, waiter.closeMs);
  }

  #closeIn(waiter: Waiter, ms: number): void {
    waiter.closeTimer = setTimeout(() => this.#closeElapsed(waiter), ms);
    waiter.closeTimer.unref?.();
  }

  // The close budget counts from delivered termination. A route still in
  // flight (Windows taskkill, which can take seconds to answer or refuse)
  // has not terminated anything yet: wait for it, then give the child its
  // full budget. The absolute cap (maxTimer) still bounds every wait.
  #closeElapsed(waiter: Waiter): void {
    if (!this.#waiters.has(waiter)) return;
    const { pending, settledAt } = this.delivery(this.child);
    if (pending) {
      waiter.closeTimer = null;
      void pending.then(() => { if (this.#waiters.has(waiter) && !waiter.closeTimer) this.#closeIn(waiter, waiter.closeMs); });
      return;
    }
    const left = settledAt === null ? 0 : settledAt + waiter.closeMs - Date.now();
    if (left > 0) { this.#closeIn(waiter, left); return; }
    this.#expire(waiter);
  }

  #expire(waiter: Waiter): void {
    if (!this.#waiters.delete(waiter)) return;
    this.#clear(waiter);
    waiter.resolve(timedOut());
  }

  #clear(waiter: Waiter): void {
    clearTimeout(waiter.maxTimer);
    if (waiter.closeTimer) clearTimeout(waiter.closeTimer);
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#graceTimer) { clearTimeout(this.#graceTimer); this.#graceTimer = null; }
    for (const waiter of this.#waiters) {
      this.#clear(waiter);
      waiter.resolve(CONFIRMED);
    }
    this.#waiters.clear();
    for (const callback of this.#onClosed.splice(0)) {
      try { callback(); } catch { /* bookkeeping only */ }
    }
  }
}

/** Every not-yet-closed child a driver instance has spawned, by provider turn. */
export class TurnTeardowns {
  readonly #byTurn = new Map<string, { threadId: string; teardown: ChildTeardown }>();
  private readonly confirm: (child: ChildProcess) => Promise<boolean>;
  private readonly delivery: (child: ChildProcess) => StopDelivery;
  private readonly stoppedSignal: (child: ChildProcess) => Promise<true>;

  constructor(
    confirm: (child: ChildProcess) => Promise<boolean> = awaitCliTreeStopped,
    delivery: (child: ChildProcess) => StopDelivery = cliStopDelivery,
    stoppedSignal: (child: ChildProcess) => Promise<true> = cliTreeStoppedSignal,
  ) {
    this.confirm = confirm;
    this.delivery = delivery;
    this.stoppedSignal = stoppedSignal;
  }

  track(threadId: string, turnId: string, child: ChildProcess): ChildTeardown {
    const teardown = new ChildTeardown(child, this.confirm, this.delivery, this.stoppedSignal);
    if (!teardown.closed) {
      const entry = { threadId, teardown };
      this.#byTurn.set(turnId, entry);
      teardown.onClosed(() => {
        if (this.#byTurn.get(turnId) === entry) this.#byTurn.delete(turnId);
      });
    }
    return teardown;
  }

  /** True while any child spawned for this thread is still unobserved-closed. */
  pending(threadId: string): boolean {
    for (const entry of this.#byTurn.values()) if (entry.threadId === threadId) return true;
    return false;
  }

  /** Close of the child that served `turnId`, or of every child on the thread
   * when no turn is named. Nothing tracked means nothing remains alive. */
  wait(threadId: string, turnId: string | undefined, budget: TeardownWait): Promise<ProviderStopResult> {
    const entries = [...this.#byTurn.entries()]
      .filter(([id, entry]) => entry.threadId === threadId && (turnId === undefined || id === turnId))
      .map(([, entry]) => entry.teardown);
    return combine(entries, budget);
  }

  /** Resolves once every child now tracked for `turnId` (every child on the
   * thread when no turn is named) has closed, observed only through
   * ChildTeardown.onClosed. It holds no timer: a child that never closes, or
   * whose close a platform hook vetoes, leaves it pending. The children are
   * captured at the call, because a close drops them from this map, so call
   * it before waiting on the same turn. Nothing tracked resolves at once. */
  closed(threadId: string, turnId: string | undefined): Promise<void> {
    const entries = [...this.#byTurn.entries()]
      .filter(([id, entry]) => entry.threadId === threadId && (turnId === undefined || id === turnId))
      .map(([, entry]) => entry.teardown);
    return Promise.all(entries.map((teardown) => new Promise<void>((resolve) => teardown.onClosed(resolve)))).then(() => undefined);
  }

  /** Close of every child on the thread except the one that served `exceptTurnId`
   * (the caller's own, live child). */
  waitOthers(threadId: string, exceptTurnId: string, budget: TeardownWait): Promise<ProviderStopResult> {
    const entries = [...this.#byTurn.entries()]
      .filter(([id, entry]) => entry.threadId === threadId && id !== exceptTurnId)
      .map(([, entry]) => entry.teardown);
    return combine(entries, budget);
  }

  waitAll(budget: TeardownWait): Promise<ProviderStopResult> {
    return combine([...this.#byTurn.values()].map((entry) => entry.teardown), budget);
  }
}

export async function combine(teardowns: ChildTeardown[], budget: TeardownWait): Promise<ProviderStopResult> {
  if (!teardowns.length) return CONFIRMED;
  const results = await Promise.all(teardowns.map((teardown) => teardown.wait(budget)));
  return results.every((result) => result.closeConfirmed) ? CONFIRMED : timedOut();
}
