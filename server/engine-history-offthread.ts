// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the engine-history part of a conversation deletion in a worker thread, one job at a time (two jobs at once could
// each rewrite the same JSONL file from a stale copy and lose the other's change). A job that cannot finish (the worker
// crashes, runs out of memory, or takes too long) reports every engine home as failed: the pending deletion record stays,
// and a later retry runs the whole removal again from the ids the record holds. This never rejects. If a worker cannot be
// started at all the job fails with the reason `worker-unavailable` and does NO engine I/O on the calling thread: the pending
// record stays and the retry schedule starts the worker again. (An inline fallback would read, decompress and rewrite engine
// files on the thread that serves the app, with no time limit.)
//
// Serialization is by REAL exit: the next job starts only after the previous worker's `exit` event, even when the caller
// already has its timeout answer (a worker stuck in native code keeps running after terminate() is asked for). A queued job
// that waits too long for that exit is reported failed without starting a worker, and the queue stays blocked behind the
// still-running one.
//
// At shutdown stopEngineHistory() refuses new jobs, gives the running one a short grace, ends it, and resolves only once the
// worker's exit event has fired, so the data-directory lease is never released while a worker is still touching files.
import { Worker } from "node:worker_threads";
import type { DeletionEngine, DeletionEngineHome, DeletionLeftover } from "./conversation-deletion.ts";
import type { HomePlanData } from "./engine-plan-core.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

export const ENGINE_HISTORY_TIMEOUT_MS = 15 * 60_000;
/** What each engine home's removal needs and a crash must not lose, by `<engine>\0<home>`: named id sets found before anything
 * was removed (session ids, thread ids, slugs...). Saved in the pending deletion record. */
export type EngineDiscovery = Record<string, Record<string, string[]>>;
export interface EngineHistoryJob {
  /** "plan" only reads: it plans the homes in `only` (default all) and reports their plans and ids. "execute" runs the steps of
   * `plans` that are not done and reports each finished step as it goes. No kind runs the whole plan / execute / verify loop
   * inline (the facade removeEngineHistoryFiles). "probe" only reads the process list: which homes a program Murage did not start has
   * open (engine-closed.ts foreignEngineHolders), so an attempt leaves them alone before it pauses or holds anything. */
  kind?: "plan" | "execute" | "recover" | "probe";
  homes: DeletionEngineHome[]; folders: string[]; memoryFolders: string[]; sessions: Partial<Record<DeletionEngine, string[]>>;
  /** ids saved by an earlier plan; a plan works from these as well as from what it can still see */
  known?: EngineDiscovery;
  /** plan: only these homes (`engine\0home`) */
  only?: string[];
  /** plan: homes (`engine\0home`) whose holder line the service already wrote for this holder (its whole try once an hour, lane 106):
   * still gated and skipped exactly as any open home, only without a second `home not read` line */
  quiet?: string[];
  /** execute: the saved plans to run, by `engine\0home` */
  plans?: Record<string, HomePlanData>;
  /** where the crash journals are kept (<data folder>/engine-redo); "recover" finishes every journal there */
  redoDir?: string;
  /** <data folder>/native, where Murage's private engine scopes are (engine-closed.ts configureScopes): unset, no home is private */
  nativeDir?: string;
  /** "recover" before any hold (the start-up pass): journals of homes inside an engine's scope folder are left for the attempt that
   * holds them */
  skipScopes?: boolean;
}
export interface EngineHistoryResult {
  removed: string[]; failed: string[]; leftovers: DeletionLeftover[];
  /** the ids a plan found, merged with the ones it was given (the facts to save) */
  discovery?: EngineDiscovery;
  /** plan: the plan of every home that could be planned in full, by `engine\0home` */
  plans?: Record<string, HomePlanData>;
  /** the homes (`engine\0home`) that could not be planned, or whose steps did not all finish */
  failedHomes?: string[];
  /** short reasons by failed path */
  reasons?: Record<string, string>;
  /** the first short reason a home (`engine\0home`) could not be finished */
  homeReasons?: Record<string, string>;
  /** the desktop application (Claude, Cursor) that is open when that is why a home (`engine\0home`) is pending */
  homeApps?: Record<string, string>;
  /** execute: databases whose checkpoint is verified, by home key */
  factsDelta?: Record<string, { clear: Record<string, string[]> }>;
  /** execute: the homes (`engine\0home`) with a step whose planned inputs no longer matched. Nothing of that step was changed;
   * the home is planned again. */
  staleHomes?: string[];
  /** plan: the homes (`engine\0home`) whose engine was closed before AND after the plan was made. A home that was changed is
   * finished only when its verifying plan is one of these. */
  closedHomes?: string[];
  /** plan: the homes whose engine could not be checked (rather than seen open) before or after the plan was made: the owner is told
   * Murage could not check, never that the engine is open */
  uncheckedHomes?: string[];
  /** plan: the homes (`engine\0home`) in a folder a sync client mirrors. Their owner is told once, after the deletion, that the cloud
   * provider may still hold older copies. */
  syncedHomes?: string[];
  /** probe: the homes (`engine\0home`) a program Murage did not start has open, with the desktop application when that is why and the
   * holders for the log line. A home not listed was not seen open that way; the attempt goes on to the full gate as before. */
  foreignHomes?: Record<string, { app?: string; holders?: Array<{ pid: number; ppid: number; name: string | null; exe: string | null; argv: string[]; by: string }>; kinds?: string[] }>;
}
export interface EngineHistoryOptions {
  workerPath?: string;
  timeoutMs?: number;
  onWorker?: (worker: Worker) => void;
  /** Test only: how workers are made. */
  createWorker?: (path: string) => Worker;
  /** How long a queued job waits for the previous worker's exit before it is reported failed (default 5 minutes). */
  exitWaitMs?: number;
  /** Hears each plan step the worker finished (home key, step index), as it finishes. */
  onStep?: (key: string, index: number) => void;
}

/** Test only: applied to every job that passes no options of its own. */
export const engineHistoryTestHooks: EngineHistoryOptions = {};
/** Settles when the most recently queued job's worker has really exited (or the job never started one). */
let tailExit: Promise<void> = Promise.resolve();
let closing = false;
let current: { worker: Worker; exited: Promise<void> } | null = null;

function failedResult(job: EngineHistoryJob, code?: string): EngineHistoryResult {
  // Only the homes this job was about: a plan job names them in `only`, an execute job in `plans`.
  const scope = job.only ?? (job.plans ? Object.keys(job.plans) : undefined);
  const about = job.homes.filter(home => !scope || scope.includes(`${home.engine}\0${home.home}`));
  const homes = [...new Set(about.map(home => home.home))];
  const keys = [...new Set(about.map(home => `${home.engine}\0${home.home}`))];
  return {
    removed: [], failed: homes, leftovers: [],
    ...(code ? { failedHomes: keys, homeReasons: Object.fromEntries(keys.map(key => [key, code])), reasons: Object.fromEntries(homes.map(home => [home, code])) } : {}),
  };
}

/** Resolves true when `promise` settles first, false when `ms` pass first. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    timer.unref();
    void promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

function runOne(job: EngineHistoryJob, options: EngineHistoryOptions): { result: Promise<EngineHistoryResult>; exited: Promise<void> } {
  let worker: Worker;
  try { worker = options.createWorker ? options.createWorker(options.workerPath ?? SPAWNED_PROXIES.engineHistoryWorker) : new Worker(options.workerPath ?? SPAWNED_PROXIES.engineHistoryWorker); }
  catch {
    return { result: Promise.resolve(failedResult(job, "worker-unavailable")), exited: Promise.resolve() };
  }
  let markExited!: () => void;
  // Only the worker's own `exit` event counts: an `error` event is a failure notice, not proof the thread has left.
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  const mine = { worker, exited };
  current = mine;
  void exited.then(() => { if (current === mine) current = null; });
  worker.on("exit", () => markExited());
  const result = new Promise<EngineHistoryResult>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: EngineHistoryResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void Promise.resolve(worker.terminate()).catch(() => {});
      resolve(value);
    };
    worker.on("message", (message: { type?: string; result?: EngineHistoryResult; key?: string; index?: number }) => {
      if (message.type === "step" && typeof message.key === "string" && typeof message.index === "number") options.onStep?.(message.key, message.index);
      else if (message.type === "result" && message.result) finish(message.result);
    });
    worker.on("error", () => finish(failedResult(job)));
    worker.on("exit", () => finish(failedResult(job)));
    try {
      options.onWorker?.(worker);
      worker.postMessage(job);
    } catch { finish(failedResult(job)); return; }
    timer = setTimeout(() => finish(failedResult(job)), options.timeoutMs ?? ENGINE_HISTORY_TIMEOUT_MS);
    timer.unref();
  });
  return { result, exited };
}

/** Queues the job behind any job already running (until that worker has really exited) and resolves with its result. Never
 * rejects. After stopEngineHistory() every job is reported failed at once. */
export function runEngineHistoryOffThread(job: EngineHistoryJob, given: EngineHistoryOptions = {}): Promise<EngineHistoryResult> {
  const options = { ...engineHistoryTestHooks, ...given };
  if (closing) return Promise.resolve(failedResult(job));
  const previous = tailExit;
  let release!: () => void;
  tailExit = new Promise<void>(resolve => { release = resolve; });
  return (async () => {
    try {
      const free = await settlesWithin(previous, options.exitWaitMs ?? 5 * 60_000);
      if (!free || closing) { void previous.then(release); return failedResult(job); }
      const { result, exited } = runOne(job, options);
      void exited.then(release);
      return await result;
    } catch {
      release();
      return failedResult(job);
    }
  })();
}

/** Shutdown: no new job starts, the running one gets `graceMs` to finish and is then ended, and this resolves true only once
 * the worker's exit event has fired (false if it is still alive `killMs` after being ended). Idempotent. */
export async function stopEngineHistory(graceMs = 3000, killMs = 1500): Promise<boolean> {
  closing = true;
  const tail = tailExit;
  if (await settlesWithin(tail, graceMs)) return true;
  try { void Promise.resolve(current?.worker.terminate()).catch(() => {}); } catch { /* already gone */ }
  return settlesWithin(tail, killMs);
}

/** Shutdown has begun: from now on every job is reported failed at once (its pending record stays for the next start). */
export function refuseEngineHistoryJobs(): void { closing = true; }

/** Test only: lets jobs run again after stopEngineHistory(). */
export function resumeEngineHistory(): void { closing = false; }
