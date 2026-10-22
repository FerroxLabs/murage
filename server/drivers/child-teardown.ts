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
import { awaitCliTreeStopped, cliStopDelivery, type StopDelivery } from "../procs.ts";

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

const CONFIRMED: ProviderStopResult = Object.freeze({ closeConfirmed: true });
const timedOut = (): UnconfirmedStop => ({ closeConfirmed: false, reason: "timeout" });

interface Waiter {
  closeMs: number;
  resolve: (result: ProviderStopResult) => void;
  closeTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout>;
}

/** Observation of one child process's lifetime. */
export class ChildTeardown {
  #closed: boolean;
  #rootClosed = false;
  #confirming = false;
  #stopRequested = false;
  readonly #waiters = new Set<Waiter>();
  readonly #onClosed: Array<() => void> = [];
  private readonly child: ChildProcess;
  private readonly confirm: (child: ChildProcess) => Promise<boolean>;
  private readonly delivery: (child: ChildProcess) => StopDelivery;

  constructor(
    child: ChildProcess,
    confirm: (child: ChildProcess) => Promise<boolean> = awaitCliTreeStopped,
    delivery: (child: ChildProcess) => StopDelivery = cliStopDelivery,
  ) {
    this.child = child;
    this.confirm = confirm;
    this.delivery = delivery;
    // spawn() assigns the pid synchronously on success. No pid means the OS
    // never created a process (ENOENT, EACCES): there is nothing to close.
    this.#closed = child.pid === undefined;
    child.once("close", this.#onRootClose);
  }

  readonly #onRootClose = () => { this.#rootClosed = true; this.#confirm(); };

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
      if (stopped) this.#markClosed();
    }, () => { this.#confirming = false; });
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

  constructor(
    confirm: (child: ChildProcess) => Promise<boolean> = awaitCliTreeStopped,
    delivery: (child: ChildProcess) => StopDelivery = cliStopDelivery,
  ) {
    this.confirm = confirm;
    this.delivery = delivery;
  }

  track(threadId: string, turnId: string, child: ChildProcess): ChildTeardown {
    const teardown = new ChildTeardown(child, this.confirm, this.delivery);
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

async function combine(teardowns: ChildTeardown[], budget: TeardownWait): Promise<ProviderStopResult> {
  if (!teardowns.length) return CONFIRMED;
  const results = await Promise.all(teardowns.map((teardown) => teardown.wait(budget)));
  return results.every((result) => result.closeConfirmed) ? CONFIRMED : timedOut();
}
