// SPDX-License-Identifier: AGPL-3.0-or-later
// The work that starts once the port is open, run so the first /api/health is
// answered before any of it.
//
// The listen callback used to start a dozen jobs back to back. Each one's
// synchronous part was small, but together they held the event loop for over
// a second, and the window waiting on /api/health waited for all of them. Now
// each step runs in its own turn of the event loop, after the first health
// answer (or a short fallback when nobody asks), and each is named for the
// stall line while it runs.
import { awaitWriterGate, isDatabaseBusy } from "./db-busy.ts";
import { ioBudget } from "./io-budget.ts";
import { heldStep } from "./observe.ts";
import { startupMark } from "./startup-trace.ts";

export interface AfterListenStep { name: string; run: () => unknown }

/** How long the steps wait for a first health check before starting anyway
 *  (a headless run nobody asks). Nothing in the list is urgent, so this is
 *  generous, and it is not a deadline on a slow boot: see `LOOP_BUSY_MS`. */
export const AFTER_LISTEN_FALLBACK_MS = 5_000;
/** A fallback timer that fires this late means the event loop is still busy
 *  booting, and the window's first health request may be queued behind that
 *  work: the steps keep waiting, up to AFTER_LISTEN_MAX_WAIT_MS in all. */
export const LOOP_BUSY_MS = 100;
export const AFTER_LISTEN_MAX_WAIT_MS = 60_000;

let healthAnswered: (() => void) | undefined;
let healthSeen = false;
const firstHealth = new Promise<void>((resolve) => { healthAnswered = resolve; });
/** Resolves once the first /api/health answer has been sent. */
export function firstHealthAnswered(): Promise<void> { return firstHealth; }

/** Called by the health route once its answer is sent. */
export function noteHealthAnswered(): void {
  if (healthSeen) return;
  healthSeen = true;
  startupMark("health.answered");
  healthAnswered?.();
  releaseStartupWrites();
}

// The listen tick writes nothing (STALLS-FINAL-DESIGN 3.4): work a start began before listen and that pages on after it (the boot settling of
// hand-offs) holds its writes until the first health answer, or until the after-listen steps start anyway (the fallback, nobody asking).
let releaseStartupWrites: () => void = () => {};
const startupWrites = new Promise<void>((resolve) => { releaseStartupWrites = resolve; });
/** Resolves at the first health answer (or the after-listen fallback): from then on the start's own background writes may run. */
export function startupWritesReady(): Promise<void> { return startupWrites; }

// The start's background work (the after-listen steps, the boot recoveries they start, the boot settling of hand-offs). A long writer that takes
// the writer hold (an index build) waits for it to settle, so nothing of the start meets the hold (database.ts invariant 2).
const bootJobs = new Set<Promise<unknown>>();
let finishSteps: () => void = () => {};
const stepsDone = new Promise<void>((resolve) => { finishSteps = resolve; });
/** Counts `job` as start-up work until it settles; returns it unchanged. */
export function trackBootJob<T>(job: Promise<T>): Promise<T> {
  const settled = job.then(() => undefined, () => undefined);
  bootJobs.add(settled);
  void settled.then(() => { bootJobs.delete(settled); });
  return job;
}
/** The longest a long writer waits for the start's work to settle. */
export const BOOT_SETTLE_MAX_MS = 60_000;
/** Resolves once every after-listen step has run and every tracked start-up job has settled (at most `maxMs` from now). */
let settledMarked = false;
export function bootSettled(maxMs = BOOT_SETTLE_MAX_MS): Promise<void> {
  const settled = (async () => {
    await stepsDone;
    while (bootJobs.size) await Promise.all([...bootJobs]);
    if (!settledMarked) { settledMarked = true; startupMark("boot.settled"); }
  })();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs); timer.unref?.();
    void settled.then(() => { clearTimeout(timer); resolve(); });
  });
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Run the steps one per event-loop turn, starting after the first health
 *  answer or the fallback. A step that throws is reported and the rest run. */
export async function runAfterListen(steps: readonly AfterListenStep[], options: { fallbackMs?: number; first?: Promise<void>; busyMs?: number; maxWaitMs?: number; busyRetryMs?: number; busyAttempts?: number } = {}): Promise<void> {
  const fallbackMs = options.fallbackMs ?? AFTER_LISTEN_FALLBACK_MS;
  const busyMs = options.busyMs ?? LOOP_BUSY_MS, maxWaitMs = options.maxWaitMs ?? AFTER_LISTEN_MAX_WAIT_MS;
  const first = options.first ?? firstHealth;
  let timer: ReturnType<typeof setTimeout> | undefined, answered = false;
  void first.then(() => { answered = true; });
  const begun = performance.now();
  const fallback = new Promise<void>((resolve) => {
    const arm = () => {
      const armed = performance.now();
      timer = setTimeout(() => {
        // Late: the loop was held, so a health request may be waiting behind
        // that work. Wait for it rather than start the memory worker now.
        const late = performance.now() - armed - fallbackMs;
        if (!answered && late > busyMs && performance.now() - begun < maxWaitMs) arm();
        else resolve();
      }, fallbackMs);
      timer.unref?.();
    };
    arm();
  });
  await Promise.race([first, fallback]);
  if (timer) clearTimeout(timer);
  releaseStartupWrites();
  const retries: Promise<void>[] = [];
  for (const step of steps) {
    await nextTurn();
    // A step that met a held write lock (its synchronous part runs under the `startup` source, so any write there waits the background budget
    // and throws) runs again once the writer gate is free and after a growing pause from AFTER_LISTEN_BUSY_RETRY_MS, up to AFTER_LISTEN_BUSY_ATTEMPTS
    // attempts in all; the later steps do not wait for it.
    const attempts = Math.max(1, options.busyAttempts ?? AFTER_LISTEN_BUSY_ATTEMPTS);
    if (!runStep(step, attempts > 1)) retries.push(new Promise<void>(resolve => {
      const again = (attempt: number, pause: number) => {
        void awaitWriterGate().then(() => {
          const timer = setTimeout(() => {
            if (runStep(step, attempt < attempts)) resolve();
            else again(attempt + 1, Math.min(pause * 2, 5_000));
          }, pause);
          timer.unref?.();
        });
      };
      again(2, options.busyRetryMs ?? AFTER_LISTEN_BUSY_RETRY_MS);
    }));
    startupMark(`deferred.${step.name}`);
  }
  await Promise.all(retries);
  startupMark("deferred.done");
  finishSteps();
}

/** How long a step that met a held write lock waits before its second attempt (doubling after, at most 5 s). */
export const AFTER_LISTEN_BUSY_RETRY_MS = 250;
/** Attempts of a step that keeps meeting a held write lock (about 20 s of pauses in all), then it is warned once. */
export const AFTER_LISTEN_BUSY_ATTEMPTS = 8;
/** One attempt of a step, named for the stall line and under the `startup` source for its synchronous part only (io-budget.ts withSyncSource:
 *  the loops a step starts keep their own sources). False when it met a held lock and may be retried. */
function runStep(step: AfterListenStep, mayRetry: boolean): boolean {
  try { heldStep(`startup.${step.name}`, () => ioBudget.withSyncSource("startup", step.run)); return true; }
  catch (error) {
    if (mayRetry && isDatabaseBusy(error)) return false;
    console.warn(`Start-up step ${step.name} could not finish: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

/** Attempts of one boot recovery cycle that keeps meeting a held write lock. */
export const BOOT_RECOVERY_ATTEMPTS = 8;
/** After a cycle's attempts are spent on held locks, the recovery starts a new cycle this much later (and again, until it finishes): it is never
 *  left for the next launch. Those later cycles are not start-up work (bootSettled does not wait for them). */
export const RECOVERY_PERIODIC_MS = 60_000;
/** Starts a boot recovery from its after-listen step. ALL of it, its asynchronous slices included, runs under the `startup` source: every write
 *  it makes takes the background lock budget, never the owner's 1 s on the serving thread. A held lock it meets starts the recovery again after
 *  the writer gate is free and a growing pause (the recoveries are idempotent and resume from their marks), up to `attempts` times; then it is
 *  started again every `periodicMs` until it finishes. Any other failure is reported. The first cycle counts as start-up work until it settles
 *  (trackBootJob, unless `track` is false: work the index build itself waits on must not hold boot.settled). Resolves when the first cycle ends. */
export function startRecovery(run: () => Promise<unknown>, report: (error: unknown) => void, options: { attempts?: number; firstPauseMs?: number; periodicMs?: number; track?: boolean } = {}): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? BOOT_RECOVERY_ATTEMPTS), periodicMs = options.periodicMs ?? RECOVERY_PERIODIC_MS;
  let warned = false;
  const cycle = (): Promise<void> => new Promise<void>(resolve => {
    const attempt = (left: number, pause: number) => {
      let started: Promise<unknown>;
      try { started = ioBudget.withSource("startup", run); } catch (error) { started = Promise.reject(error); }
      void started.then(() => resolve(), error => {
        if (!isDatabaseBusy(error)) { report(error); resolve(); return; }
        if (left > 1) {
          void awaitWriterGate().then(() => { const timer = setTimeout(() => attempt(left - 1, Math.min(pause * 2, 5_000)), pause); timer.unref?.(); });
          return;
        }
        if (!warned) { warned = true; console.warn(`[startup] a boot recovery met a held lock ${attempts} times; it runs again every ${Math.round(periodicMs / 1000)} s until it finishes`); }
        const timer = setTimeout(() => { void cycle(); }, periodicMs); timer.unref?.();
        resolve();
      });
    };
    attempt(attempts, options.firstPauseMs ?? AFTER_LISTEN_BUSY_RETRY_MS);
  });
  const first = cycle();
  return options.track === false ? first : trackBootJob(first);
}

/** A settle that may only run once something is ready (the open-card list), asked for by every attempt of the recovery around it. However many
 *  attempts ask, there is ONE subscription to the ready signal and ONE settle running at a time: a call while a settle runs joins it. `settle()`
 *  settles now when ready (or joins the running one); otherwise it leaves the single listener waiting and returns, and the listener starts the
 *  settle once through `recover` (its own recovery, retried on held locks). */
export function readySettle(options: {
  ready: () => boolean;
  subscribe: (onSignal: () => void) => () => void;
  run: () => Promise<void>;
  recover: (settle: () => Promise<void>) => void;
}): () => Promise<void> {
  let running: Promise<void> | null = null;
  const settle = (): Promise<void> => (running ??= Promise.resolve().then(options.run).finally(() => { running = null; }));
  let off: (() => void) | null = null;
  const stopListening = () => { off?.(); off = null; };
  return async () => {
    if (options.ready()) { stopListening(); return settle(); }
    if (off) return;
    off = options.subscribe(() => {
      if (!off || !options.ready()) return;
      stopListening();
      options.recover(settle);
    });
    if (options.ready()) { stopListening(); return settle(); }
  };
}
