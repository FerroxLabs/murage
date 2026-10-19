// SPDX-License-Identifier: AGPL-3.0-or-later
// A Cloud home checks that its own UI renders: once at boot, then every 10 minutes. The
// result is cached in memory and reported by GET /api/health as "ui". The check never runs
// on a request path and at most one runs at a time.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanupCanaryBrowser, spawnCanaryBrowser } from "./browser-process.ts";
import { ensureServerInstancePublished, SERVER_INSTANCE, STALE_INSTANCE_EXIT } from "./server-instance.ts";
import { cloudHomeInternal } from "./copy.ts";
/** Fixed words for a failed launch: the launcher's step-reason code when it set one, else a known control error, else "other". */
export function canaryFailureCode(error: unknown): string {
  const code = (error as { canaryCode?: unknown } | undefined)?.canaryCode;
  if (typeof code === "string" && /^[a-z0-9-]{1,80}$/.test(code)) return code;
  const message = (error as Error | undefined)?.message;
  return message === "ui check timed out" ? "timed-out" : message === "ui check halted" ? "halted" : message === "aborted" ? "aborted" : "other";
}

export type UiState = "pending" | "ok" | "failed";
export const UI_CANARY_USER_AGENT = "murage-control-canary/1";
export const UI_CANARY_INTERVAL_MS = 10 * 60_000;
export const UI_CANARY_CAP_MS = 20_000;
export const UI_CANARY_PATH = "/";
// An anonymous visitor's normal end states. "working", "unavailable" and "message" are not usable doors.
const DOOR_VALUES = ["continue", "other-device"];

/** Pass = html[data-murage-mounted="1"] and main[data-murage-door] on a finished, usable state (continue or other-device). */
export function domShowsUi(dom: string): boolean {
  const html = /<html\b[^>]*>/i.exec(dom)?.[0] ?? "";
  if (!/\sdata-murage-mounted\s*=\s*["']?1["']?(?=[\s>"'/])/i.test(html)) return false;
  for (const main of dom.matchAll(/<main\b[^>]*>/gi)) {
    const value = /\sdata-murage-door\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(main[0]);
    if (value && DOOR_VALUES.includes(value[1] ?? value[2] ?? "")) return true;
  }
  return false;
}

export const UI_CANARY_DRAIN_MS = 10_000;
export const UI_CANARY_KILL_AFTER_MS = 5_000;

/** Every process the canary starts goes through one spawner. Once fenced it refuses to start anything, and it can say when every child it started has closed. */
export interface CanarySpawner {
  spawn(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams | null;
  /** True only after every child has emitted `close`; false when `ms` passes first. */
  drained(ms: number): Promise<boolean>;
}
type BaseSpawn = (args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams | null;

/** Tracks the children of one launch. On abort it sends SIGTERM (sudo relays it to the root launcher; SIGKILL to sudo would orphan it),
 * then SIGKILL after `killAfterMs`. `spawn` throws synchronously once the signal has aborted. */
export function createChildSpawner(base: BaseSpawn, signal: AbortSignal, killAfterMs = UI_CANARY_KILL_AFTER_MS): CanarySpawner {
  const children = new Set<ChildProcessWithoutNullStreams>();
  const waiters = new Set<() => void>();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const release = (child: ChildProcessWithoutNullStreams) => { if (children.delete(child) && children.size === 0) for (const wake of [...waiters]) wake(); };
  const fence = () => {
    for (const child of children) { try { child.kill("SIGTERM"); } catch {} }
    if (children.size === 0 || killTimer) return;
    killTimer = setTimeout(() => { for (const child of children) { try { child.kill("SIGKILL"); } catch {} } }, killAfterMs);
    killTimer.unref?.();
  };
  if (signal.aborted) fence(); else signal.addEventListener("abort", fence, { once: true });
  return {
    spawn(args, env) {
      if (signal.aborted) throw new Error(cloudHomeInternal.canaryAborted);
      const child = base(args, env);
      if (!child) return null;
      children.add(child);
      child.once("close", () => release(child));
      child.once("error", () => { if (child.pid === undefined) release(child); });
      return child;
    },
    drained(ms) {
      if (children.size === 0) return Promise.resolve(true);
      return new Promise<boolean>(resolve => {
        const done = (value: boolean) => { clearTimeout(timer); waiters.delete(wake); resolve(value); };
        const wake = () => done(true);
        const timer = setTimeout(() => done(false), ms);
        waiters.add(wake);
      });
    },
  };
}

export interface UiCanaryRequest { path: string; userAgent: string; signal: AbortSignal; spawner: CanarySpawner }
/** Renders the app's page in a sandboxed browser and resolves with the final DOM as HTML. It only renders: every process goes through
 * `request.spawner`, and it never stops the browser itself. The controller owns every teardown. */
export type UiCanaryLauncher = (request: UiCanaryRequest) => Promise<string>;

export interface UiCanary {
  status(): UiState; finishedAt(): number | null; runOnce(): Promise<UiState>; start(): void; stop(): void;
  /** For tests and diagnostics: the controller's phase, its generation and the one verdict health reads. */
  snapshot(): { phase: string; gen: number; verdict: { ui: UiState; at: number | null; gen: number } };
}

type Phase = "unknown" | "dirty" | "clean" | "running" | "draining";
interface Handle { gen: number; abort: AbortController; spawner: CanarySpawner; halt: () => void }
interface Verdict { ui: UiState; at: number | null; gen: number }
/** Replaced whole, never field by field. `gen` only increases. */
interface State { phase: Phase; gen: number; handle?: Handle; verdict: Verdict }

export interface UiCanaryDeps {
  launcher: UiCanaryLauncher; intervalMs?: number; capMs?: number; drainMs?: number;
  /** Stops, lists and erases the canary browser; rejects when it cannot prove the browser gone. */
  cleanup?: () => Promise<void>;
  /** Writes this process's instance id where the launcher reads it. Runs before boot cleanup and every launch. */
  publishInstance?: () => void;
  /** One plain line to stderr (journald under murage-home.service). */
  log?: (line: string) => void;
  /** The spawner for one launch. Defaults to tracking children started by `spawnCanaryBrowser`. */
  makeSpawner?: (signal: AbortSignal) => CanarySpawner;
  setTimer?: typeof setInterval; clearTimer?: typeof clearInterval; setCap?: typeof setTimeout; clearCap?: typeof clearTimeout;
}

/** One controller owns the single canary browser, fenced by generation:
 *  unknown/dirty -> teardown -> clean -> running(g) -> draining(g) -> teardown -> clean | dirty.
 *  A launch happens only from `clean`, which is entered only by a confirmed teardown after fence and drain. */
export function createUiCanary(deps: UiCanaryDeps): UiCanary {
  const { launcher, intervalMs = UI_CANARY_INTERVAL_MS, capMs = UI_CANARY_CAP_MS, drainMs = UI_CANARY_DRAIN_MS } = deps;
  const cleanup = deps.cleanup ?? cleanupCanaryBrowser;
  const publishInstance = deps.publishInstance ?? (() => ensureServerInstancePublished());
  const log = deps.log ?? ((line: string) => console.error(line));
  // What happened this tick; flushed as ONE "[ui-canary]" line when the tick ends. Fixed words only: no URLs, tokens or DOM.
  let tick: string[] = [];
  const base: BaseSpawn = (args, env) => {
    const child = spawnCanaryBrowser(args, env);
    child?.once("close", code => { if (code === STALE_INSTANCE_EXIT && !tick.includes("stale-instance")) tick.push("stale-instance"); });
    return child;
  };
  const makeSpawner = deps.makeSpawner ?? ((signal: AbortSignal) => createChildSpawner(base, signal));
  const setTimer = deps.setTimer ?? setInterval, clearTimer = deps.clearTimer ?? clearInterval;
  const setCap = deps.setCap ?? setTimeout, clearCap = deps.clearCap ?? clearTimeout;
  // A canary browser from before a restart may survive (scopes outlive the app's cgroup), so boot is `unknown`.
  let rec: State = { phase: "unknown", gen: 0, verdict: { ui: "pending", at: null, gen: 0 } };
  let inflight: Promise<UiState> | undefined;
  let draining: { gen: number; done: Promise<void> } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const now = () => Date.now();
  /** Compare-and-set: replaces the whole record only if it is still in the expected phase and generation. */
  const swap = (phase: Phase, gen: number, next: State): boolean => {
    if (rec.phase !== phase || rec.gen !== gen) return false;
    rec = next;
    return true;
  };
  /** Drain every child of the handle, then prove the browser gone. Only a confirmed teardown makes the record `clean`. */
  async function teardown(phase: "unknown" | "dirty" | "draining", gen: number): Promise<void> {
    const handle = rec.phase === phase && rec.gen === gen ? rec.handle : undefined;
    let confirmed = false, busy = false;
    try {
      if (!handle || await handle.spawner.drained(drainMs)) { await cleanup(); confirmed = true; }
    } catch (error) { confirmed = false; busy = (error as { busy?: boolean } | undefined)?.busy === true; }
    if (confirmed) swap(phase, gen, { phase: "clean", gen, verdict: rec.verdict });
    else {
      tick.push("teardown-unconfirmed"); if (busy) tick.push("cleanup-busy-exit-75");
    }
    if (!confirmed) swap(phase, gen, { phase: "dirty", gen, ...(handle ? { handle } : {}), verdict: { ui: "failed", at: now(), gen } });
  }
  /** running(g) -> draining(g): writes the verdict (none when stopping), fences, then tears down. Whoever loses the race joins the same drain. */
  function beginDrain(handle: Handle, verdict: UiState | null): Promise<void> {
    const next: State = { phase: "draining", gen: handle.gen, handle, verdict: verdict ? { ui: verdict, at: now(), gen: handle.gen } : rec.verdict };
    if (swap("running", handle.gen, next)) {
      handle.abort.abort();
      draining = { gen: handle.gen, done: teardown("draining", handle.gen) };
    }
    return draining && draining.gen === handle.gen ? draining.done : Promise.resolve();
  }
  async function cycle(): Promise<UiState> {
    // r7: the new instance is written BEFORE boot cleanup, so an older server's queued launch either already
    // entered its scope (cleanup finds and kills it) or is refused by the launcher after it takes the lock.
    try { publishInstance(); } catch {
      tick.push("instance-write-failed");
      if (rec.phase === "unknown" || rec.phase === "dirty") swap(rec.phase, rec.gen, { ...rec, phase: "dirty", verdict: { ui: "failed", at: now(), gen: rec.gen } } as State);
      return rec.verdict.ui;
    }
    if (rec.phase === "unknown" || rec.phase === "dirty") {
      await teardown(rec.phase, rec.gen);
    }
    if ((rec as State).phase !== "clean") return rec.verdict.ui;
    const gen = rec.gen + 1;
    const abort = new AbortController();
    let halt!: () => void;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<never>((_resolve, reject) => {
      halt = () => reject(new Error(cloudHomeInternal.canaryHalted));
      capTimer = setCap(() => reject(new Error(cloudHomeInternal.canaryTimedOut)), capMs);
    });
    capped.catch(() => {});
    const handle: Handle = { gen, abort, spawner: makeSpawner(abort.signal), halt };
    if (!swap("clean", rec.gen, { phase: "running", gen, handle, verdict: rec.verdict })) { clearCap(capTimer!); return rec.verdict.ui; }
    let ui: UiState = "failed";
    let failure = "";
    try {
      const launched = launcher({ path: UI_CANARY_PATH, userAgent: UI_CANARY_USER_AGENT, signal: abort.signal, spawner: handle.spawner });
      launched.catch(() => {});   // a late settle of this launch writes nothing
      ui = domShowsUi(await Promise.race([launched, capped])) ? "ok" : "failed";
      if (ui === "failed") failure = "no-ui";
    } catch (error) { ui = "failed"; failure = canaryFailureCode(error); }
    clearCap(capTimer!);
    // The failing step as fixed words (e.g. error=cdp-url-session-not-running), never free text.
    tick.push(`launch gen=${gen} result=${ui}` + (ui === "failed" ? ` error=${failure}` : ""));
    await beginDrain(handle, ui);
    return rec.verdict.ui;
  }
  const runOnce = (): Promise<UiState> => inflight ??= (() => {
    tick = [];
    return cycle().finally(() => { inflight = undefined; if (tick.length) { try { log(`[ui-canary] ${tick.join(" ")}`); } catch { /* logging never fails a check */ } } });
  })();
  return {
    status: () => rec.verdict.ui,
    finishedAt: () => rec.verdict.at,
    snapshot: () => ({ phase: rec.phase, gen: rec.gen, verdict: rec.verdict }),
    runOnce,
    start() {
      if (timer) return;
      void runOnce();
      timer = setTimer(() => { void runOnce(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = undefined;
      if (rec.phase === "running" && rec.handle) { const handle = rec.handle; void beginDrain(handle, null); handle.halt(); }
    },
  };
}

let singleton: UiCanary | undefined;
/** Cloud home only. Desktop: nothing starts and the answer is undefined. */
export function startUiCanary(launcher: UiCanaryLauncher, env: NodeJS.ProcessEnv = process.env, deps: Omit<UiCanaryDeps, "launcher"> = {}): UiCanary | undefined {
  if (env.MURAGE_CLOUD_ROLE !== "home") return undefined;
  singleton ??= createUiCanary({ launcher, ...deps });
  singleton.start();
  return singleton;
}
export function uiCanaryState(env: NodeJS.ProcessEnv = process.env): UiState | undefined {
  if (env.MURAGE_CLOUD_ROLE !== "home") return undefined;
  return singleton?.status() ?? "pending";
}
/** Minted once per process start; lets the control plane tell a restarted app from a stale answer. */
export const UI_INSTANCE = SERVER_INSTANCE;
export function uiHealth(env: NodeJS.ProcessEnv = process.env): { ui: UiState; uiAt: number | null; instance: string } | undefined {
  if (env.MURAGE_CLOUD_ROLE !== "home") return undefined;
  return { ui: singleton?.status() ?? "pending", uiAt: singleton?.finishedAt() ?? null, instance: UI_INSTANCE };
}
export function resetUiCanaryForTests(): void { singleton?.stop(); singleton = undefined; }
