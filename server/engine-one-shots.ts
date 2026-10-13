// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own background one-shot runs of an engine (a memory or summary helper, a proposal review, a model listing) are programs of
// that engine too: while one is alive the engine reads as open, and a conversation deletion would stay pending behind it. Every such
// run goes through `runOneShot`. A deletion pauses the engine's one-shots first: new starts WAIT (they are not refused), the running
// ones get a short time to finish, and the rest are stopped through their own stop path (the process tree, a Job Object on Windows).
// A run that was stopped for the pause starts again after it when it can (`retry`). Turns the owner started are never touched here:
// they are held by harness/instance-holds.ts, and a live one keeps the deletion pending.

interface Running { engine: string; stop: () => void; stopped: boolean }

export class OneShotGate {
  private readonly paused = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly running = new Set<Running>();
  private readonly idleWaiters: Array<() => void> = [];

  isPaused(engine: string): boolean { return (this.paused.get(engine) ?? 0) > 0; }
  runningCount(engine: string): number { return [...this.running].filter((item) => item.engine === engine).length; }

  private async open(engine: string, signal?: AbortSignal): Promise<void> {
    while (this.isPaused(engine)) {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const list = this.waiting.get(engine) ?? [];
        list.push(resolve);
        this.waiting.set(engine, list);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  /** Runs one background run of `engine`. `work` gets the signal to honour (the caller's, and the pause's). With `retry`, a run the
   * pause stopped is started again once the pause is lifted; without it the stop reaches the caller as a cancellation. */
  async run<T>(engine: string, callerSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>, retry = false): Promise<T> {
    for (;;) {
      await this.open(engine, callerSignal);
      const control = new AbortController();
      const onCaller = () => control.abort();
      // an already-aborted caller still reaches `work`, which answers it in its own words
      if (callerSignal?.aborted) onCaller(); else callerSignal?.addEventListener("abort", onCaller, { once: true });
      const entry: Running = { engine, stopped: false, stop: () => { entry.stopped = true; control.abort(); } };
      this.running.add(entry);
      try {
        return await work(control.signal);
      } catch (error) {
        if (entry.stopped && retry && !callerSignal?.aborted) continue;
        throw error;
      } finally {
        callerSignal?.removeEventListener("abort", onCaller);
        this.running.delete(entry);
        for (const wake of this.idleWaiters.splice(0)) wake();
      }
    }
  }

  private async settled(engines: ReadonlySet<string>, ms: number): Promise<boolean> {
    const none = () => ![...this.running].some((item) => engines.has(item.engine));
    const deadline = Date.now() + ms;
    while (!none()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        timer.unref?.();
        this.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return true;
  }

  /** Pauses these engines' one-shots: new starts wait, running ones get `graceMs` to finish, the rest are stopped and given `stopMs`
   * to be confirmed gone. `clear` says none of them is left running. `release` lets the waiting ones start (call it in a finally). */
  async pause(engines: readonly string[], graceMs = 5_000, stopMs = 5_000): Promise<{ clear: boolean; release: () => void }> {
    const set = new Set(engines);
    for (const engine of set) this.paused.set(engine, (this.paused.get(engine) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const engine of set) {
        const left = (this.paused.get(engine) ?? 1) - 1;
        if (left > 0) { this.paused.set(engine, left); continue; }
        this.paused.delete(engine);
        for (const wake of this.waiting.get(engine)?.splice(0) ?? []) wake();
      }
    };
    try {
      let clear = await this.settled(set, graceMs);
      if (!clear) {
        for (const item of [...this.running]) if (set.has(item.engine)) item.stop();
        clear = await this.settled(set, stopMs);
      }
      return { clear, release };
    } catch (error) {
      release();
      throw error;
    }
  }
}

/** The one gate of this Murage process. */
export const oneShots = new OneShotGate();
