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
  #stopRequested = false;
  readonly #waiters = new Set<Waiter>();
  readonly #onClosed: Array<() => void> = [];

  constructor(child: ChildProcess) {
    // spawn() assigns the pid synchronously on success. No pid means the OS
    // never created a process (ENOENT, EACCES): there is nothing to close.
    this.#closed = child.pid === undefined;
    child.once("close", () => this.#markClosed());
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

  #armClose(waiter: Waiter): void {
    if (waiter.closeTimer) return;
    waiter.closeTimer = setTimeout(() => this.#expire(waiter), waiter.closeMs);
    waiter.closeTimer.unref?.();
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

  track(threadId: string, turnId: string, child: ChildProcess): ChildTeardown {
    const teardown = new ChildTeardown(child);
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

  waitAll(budget: TeardownWait): Promise<ProviderStopResult> {
    return combine([...this.#byTurn.values()].map((entry) => entry.teardown), budget);
  }
}

async function combine(teardowns: ChildTeardown[], budget: TeardownWait): Promise<ProviderStopResult> {
  if (!teardowns.length) return CONFIRMED;
  const results = await Promise.all(teardowns.map((teardown) => teardown.wait(budget)));
  return results.every((result) => result.closeConfirmed) ? CONFIRMED : timedOut();
}
