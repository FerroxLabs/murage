// One adaptive, memory-aware pool of idle warm engine processes, shared by the
// Claude and Codex drivers. There is no fixed count: an idle engine stays until
// its own idle timer fires, or until memory pressure retires it, least recently
// used first. Only idle engines are ever evicted, and a spawn is never refused.
import { execFile, type ChildProcess } from "node:child_process";
import { freemem as osFreemem, totalmem as osTotalmem } from "node:os";
import type { SendTurnInput } from "../contracts.ts";
import { awaitCliTreeStopped, killCliTree } from "../procs.ts";
import { hasPlatformRss, platformRss, processHandleInfo } from "../platform-process-hooks.ts";
import { windowsListing } from "./process-tree.ts";
import { reuseStats } from "./reuse-stats.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MEASURE_EVERY_MS = 30_000;
const SUMMARY_EVERY_MS = 5 * 60_000;
const UNKNOWN_ENGINE_BYTES = 800 * MB;
/** Counted toward the budget for an engine whose resident size cannot be measured. */
const ASSUMED_ENGINE_BYTES = 600 * MB;
const DEFAULT_MIN_FREE_BYTES = 1.5 * GB;
/** A just-spawned engine may be invisible to the platform rss hook (Murage Cloud
 * creates its systemd scope a moment later). Within this window of its spawn an
 * unmeasured engine is "measuring": re-measured early, and its provisional size
 * never evicts other engines on budget grounds. */
const MEASURING_WINDOW_MS = 10_000;
/** Early re-measure points, ms after spawn. With the grace-expiry check below, an
 * engine gets at most three extra measurements, each scheduled once in its life. */
const EARLY_REMEASURE_MS = [2_000, 5_000] as const;
/** A first reading taken before this age may be a still-starting engine's: it is
 * kept as provisional and re-measured once more (at 5 s after spawn, or 3 s later). */
const EARLY_READING_MS = 2_000;
const EARLY_FOLLOWUP_MS = 3_000;
/** The grace-expiry check: just past the window, the provisional size counts in full.
 * It survives a quick turn (release, then idle again), so enforcement never waits for the 30 s tick. */
const GRACE_EXPIRY_MS = MEASURING_WINDOW_MS + 1;

/** The oldest a warm engine may get, 5 h by default (MURAGE_WARM_MAX_AGE_MS).
 * Murage Cloud's systemd RuntimeMaxSec is 6 h: this keeps warm engines under it.
 * An older engine is recycled at its next turn boundary, never mid-turn. */
export const DEFAULT_WARM_MAX_AGE_MS = 5 * 60 * 60_000;
export function warmMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MURAGE_WARM_MAX_AGE_MS);
  return env.MURAGE_WARM_MAX_AGE_MS !== undefined && Number.isFinite(v) && v > 0 ? v : DEFAULT_WARM_MAX_AGE_MS;
}
/** When Murage spawned this process (its recorded handle), or undefined. */
export const spawnedAtOf = (child: ChildProcess | null | undefined): number | undefined =>
  child ? processHandleInfo(child)?.spawnedAt : undefined;
/** True when the engine started at `spawnedAt` is older than the warm max age. */
export function pastWarmMaxAge(spawnedAt: number | undefined, now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof spawnedAt === "number" && spawnedAt > 0 && now - spawnedAt >= warmMaxAgeMs(env);
}

export type WarmEngine = "claude" | "codex" | "acp";
const DEFAULT_ACTIVITY_WINDOW_MS = 15 * 60_000;
/** The bucket of an engine whose thread's last user turn was a non-owner's: no owner turn ever wakes it. */
const NON_OWNER_BUCKET = "\u0000non-owner";
/** Idle owner engines kept per engine kind across active bots (E1; MURAGE_WARM_SPARES 1..3 for tests). */
export const DEFAULT_WARM_SPARES = 3;
export function warmSpares(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MURAGE_WARM_SPARES);
  return Number.isInteger(v) && v >= 1 && v <= DEFAULT_WARM_SPARES ? v : DEFAULT_WARM_SPARES;
}
export interface WarmMember {
  engine: WarmEngine;
  threadId: string;
  /** The engine process pid; its whole process tree is measured. */
  pid: () => number | undefined;
  /** Retire this idle engine with the given close reason. */
  close: (reason: string) => void;
  /** True while the engine owns an active turn. A busy engine is never evicted. */
  busy?: () => boolean;
  /** The turn that just settled was background work (routine, schedule, memory):
   * the engine is released at once and never earns a spare. */
  background?: boolean;
  /** The engine was started on intent (prewarm), not by a turn: hold it for one
   * activity window, and release it if no send follows. */
  hold?: boolean;
  /** A focus or typing hold cannot outlive this member's bot activity window. */
  ownerActivityOnly?: boolean;
  /** When the engine process was spawned (epoch ms): an idle engine past the
   * warm max age is closed with reason max-age. */
  spawnedAt?: number;
  /** The engine home this process was started on (scope kind and bot): a login split on that scope drains it. */
  scope?: { kind: string; bot: string | null };
  /** The bot whose thread this engine serves. Unset: the bot of the thread's last owner turn (noteUserActivity). */
  bot?: string;
}

/** How long an unclaimed prewarm (and an asleep bot's focus or typing hold) is held after the owner's last open, focus or
 * typing beat on its thread (designs/WARM-W1-1022-presence.md P-PRE 5, Q-PR2; MAIN-RULING warm1022-driver-D2). An active
 * bot's hold keeps the activity window. MURAGE_WARM_PREWARM_HOLD_MS (1 s..120 s) is for tests only. */
export const PREWARM_HOLD_MS = 120_000;
export function prewarmHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MURAGE_WARM_PREWARM_HOLD_MS);
  return Number.isFinite(v) && v >= 1_000 && v <= PREWARM_HOLD_MS ? v : PREWARM_HOLD_MS;
}
/** Prewarm start limits (P-PRE 3): one per thread per minute, three across all bots in any rolling minute. */
const PREWARM_RATE_WINDOW_MS = 60_000;
const PREWARM_STARTS_PER_WINDOW = 3;

/** How long a send waits for a prewarm that is still starting the same thread's engine. */
export const PREWARM_WAIT_MS = 20_000;
const prewarmWaitMs = (): number => {
  const v = Number(process.env.MURAGE_PREWARM_WAIT_MS);
  return process.env.MURAGE_PREWARM_WAIT_MS !== undefined && Number.isFinite(v) && v >= 0 ? v : PREWARM_WAIT_MS;
};
/** The hard bound, in total, on a send taking over a prewarm: cancel it, then end the
 * process it owns, then give up with a clear error. */
export const TAKEOVER_BOUND_MS = 10_000;
const takeoverBoundMs = (): number => {
  const v = Number(process.env.MURAGE_PREWARM_TAKEOVER_MS);
  return process.env.MURAGE_PREWARM_TAKEOVER_MS !== undefined && Number.isFinite(v) && v > 0 ? v : TAKEOVER_BOUND_MS;
};
/** What a send that could not take over a prewarm fails with. */
export const TAKEOVER_FAILED_MESSAGE = "The engine that was starting for this conversation did not stop in time, so this message was not sent. Try again in a moment; restart Murage if it keeps happening.";

/** The in-flight prewarms of one driver instance, so a send that arrives meanwhile
 * waits for the engine being started instead of failing as "already running". */
export function createPrewarmGate() {
  const pending = new Map<string, { done: Promise<void>; finish: () => void; token: object; startedAt: number }>();
  const abandonedTokens = new WeakSet<object>();
  return {
    has: (threadId: string) => pending.has(threadId),
    /** Every thread whose prewarm is still starting (none of them is claimed yet: a claim only waits on the entry). */
    threads: (): string[] => [...pending.keys()],
    /** The current prewarm's token, or undefined. */
    token: (threadId: string): object | undefined => pending.get(threadId)?.token,
    /** True while `token` is still this thread's prewarm. */
    current: (threadId: string, token: object): boolean => pending.get(threadId)?.token === token,
    /** A token (truthy) for the new prewarm, or null when a prewarm of this thread is already starting. */
    begin(threadId: string): object | null {
      if (pending.has(threadId)) return null;
      let finish = () => {};
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const token = {};
      pending.set(threadId, { done, finish, token, startedAt: Date.now() });
      return token;
    },
    /** Ends the prewarm. With a token, only if it is still the current one (a stale end leaves a newer prewarm alone). */
    end(threadId: string, token?: object) {
      const entry = pending.get(threadId);
      if (!entry) return;
      if (token !== undefined && entry.token !== token) return;
      pending.delete(threadId);
      entry.finish();
    },
    /** P-FENCE 2: a send found this thread's prewarm hung (or the owner went away while it started). The entry ends NOW, so
     * `has()` is false and every waiter goes on; the token is marked abandoned, so the prewarm's late spawn, park or end never
     * writes back into the thread's slots, the pool or this gate (the driver checks `abandoned(token)`). */
    abandon(threadId: string): object | undefined {
      const entry = pending.get(threadId);
      if (!entry) return undefined;
      abandonedTokens.add(entry.token);
      pending.delete(threadId);
      entry.finish();
      return entry.token;
    },
    /** True once `token`'s prewarm was abandoned, or when there is no token (a prewarm that never held the gate keeps nothing). */
    abandoned: (token: object | undefined): boolean => token === undefined || abandonedTokens.has(token),
    /** Ends when this thread's prewarm has really ended, however long that takes. */
    settled: (threadId: string): Promise<void> => pending.get(threadId)?.done ?? Promise.resolve(),
    /** A send's wait for the prewarm ran out: cancel it and wait for it to end and free
     * its dispatch slot; if it will not, end the process it owns now (`child()`, the exact
     * handle the driver holds at this moment, never a remembered PID) through the owned
     * process-tree lifecycle, and wait once more. The whole takeover is bounded
     * (TAKEOVER_BOUND_MS): false means the slot is still not free, and the send must fail
     * with TAKEOVER_FAILED_MESSAGE, never fall through to "already running". */
    async takeOver(threadId: string, hooks: {
      stop: () => unknown;
      child: () => ChildProcess | null | undefined;
      slotBusy: () => boolean;
      boundMs?: number;
      terminate?: (child: ChildProcess) => Promise<boolean>;
    }): Promise<boolean> {
      const deadline = Date.now() + (hooks.boundMs ?? takeoverBoundMs());
      const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.(); });
      const settled = () => !pending.has(threadId) && !hooks.slotBusy();
      const waitSettled = async (until: number): Promise<boolean> => {
        while (!settled()) {
          if (Date.now() >= until) return false;
          const entry = pending.get(threadId);
          await Promise.race([entry ? entry.done : sleep(20), sleep(Math.min(20, until - Date.now()))]);
        }
        return true;
      };
      const cancelled = (async () => { try { await hooks.stop(); } catch {} })();
      await Promise.race([cancelled, sleep(deadline - Date.now())]);
      // half the bound for the cancel, the rest for ending the process it owns
      if (await waitSettled(Math.min(deadline, Date.now() + Math.max(0, (deadline - Date.now()) / 2)))) return true;
      const child = hooks.child();
      if (child && child.exitCode === null && child.signalCode === null) {
        const terminate = hooks.terminate ?? ((c: ChildProcess) => { killCliTree(c); return awaitCliTreeStopped(c, 1_000); });
        await Promise.race([terminate(child).catch(() => false), sleep(deadline - Date.now())]);
      }
      return waitSettled(deadline);
    },
    /** A send's claim of the prewarm starting its thread's engine (presence P-FENCE 3): it waits until that prewarm is ready
     * or failed, bounded only against a hang, PREWARM_WAIT_MS counted from the PREWARM's own start, not from the send. */
    claim(threadId: string, ms: number = prewarmWaitMs()): Promise<boolean> {
      const entry = pending.get(threadId);
      if (!entry) return Promise.resolve(true);
      return this.wait(threadId, Math.max(0, entry.startedAt + ms - Date.now()));
    },
    /** True when no prewarm is (or was) starting, or it ended within `ms`. */
    async wait(threadId: string, ms: number = prewarmWaitMs()): Promise<boolean> {
      const entry = pending.get(threadId);
      if (!entry) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
      try { return await Promise.race([entry.done.then(() => true), timeout]); } finally { clearTimeout(timer); }
    },
  };
}

/** A prewarm's fence refused its launch: nothing was spawned, nobody is told, and the next turn is a cold start. */
export class PrewarmRefused extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`prewarm refused: ${reason}`); this.reason = reason; }
  get spareLoss(): string { return `fence:${this.reason}`; }
}

/** What a prewarm needs from a turn and no more: the spawn inputs (cwd, env source,
 * MCP config, settings, warm identity), without the message, its attachments, the
 * replay transcript or the caller's per-turn callbacks. */
export function spawnInputsOf(turn: SendTurnInput): SendTurnInput {
  return { ...turn, text: "", images: undefined, engineCommand: undefined, transcript: undefined, prewarm: undefined, onToolSurface: undefined, beforePrepare: undefined, beforeSubmit: undefined, prepareSubmit: undefined, notWritten: undefined, attemptWritten: undefined, attemptUncertain: undefined, attemptNotWritten: undefined, attemptSettled: undefined, launchFence: undefined };
}

/** The spawn inputs of each thread's last real (user) turn, held in memory only,
 * so an intent warm can start the engine the next turn would. Never persisted. */
export function createTurnMemory<T>(max = 64) {
  const turns = new Map<string, T>();
  return {
    remember(threadId: string, turn: T) {
      turns.delete(threadId);
      turns.set(threadId, turn);
      while (turns.size > max) turns.delete(turns.keys().next().value!);
    },
    /** Update the remembered turn (for example its resume cursor), if there is one. */
    patch(threadId: string, change: Partial<T>) {
      const turn = turns.get(threadId);
      if (turn) turns.set(threadId, { ...turn, ...change });
    },
    get: (threadId: string) => turns.get(threadId),
    forget: (threadId: string) => turns.delete(threadId),
  };
}

export interface WarmPoolDeps {
  now: () => number;
  totalmem: () => number;
  freemem: () => number;
  /** Resident bytes of the process tree under each pid, null where unknown. */
  measure: (pids: number[]) => Promise<Map<number, number> | null>;
  /** Refresh whatever `freemem` reads from (macOS reports reclaimable pages separately). */
  sampleFree: () => Promise<void>;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Re-check on a timer while any engine is idle (off in unit tests). */
  timer: boolean;
  /** Schedules an unref'd one-shot early re-measure, returns its cancel. Null: none (unit tests). */
  schedule?: ((fn: () => void, ms: number) => () => void) | null;
}

/** Parse `ps -A -o pid=,ppid=,rss=` into per-root tree sums, in bytes. */
export function treeRss(listing: string, roots: number[]): Map<number, number> {
  const rss = new Map<number, number>();
  const kids = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    rss.set(pid, Number(m[3]) * 1024);
    (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
  }
  const out = new Map<number, number>();
  for (const root of roots) {
    if (!rss.has(root)) continue;
    let sum = 0;
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      sum += rss.get(p) ?? 0;
      stack.push(...(kids.get(p) ?? []));
    }
    out.set(root, sum);
  }
  return out;
}

/** Per-root tree sums of working-set bytes from the Windows process table
 * (the native process list the process-tree probes use, plus tasklist for the sizes). A
 * process whose working set Windows withholds counts as 0; a root it does
 * not list stays unmeasured. */
export async function windowsMeasure(pids: number[]): Promise<Map<number, number> | null> {
  const rows = await windowsListing({ memory: true });
  if (!rows) return null;
  return treeRss(rows.map((row) => `${row.pid} ${row.ppid} ${Math.floor((row.rssBytes ?? 0) / 1024)}`).join("\n"), pids);
}

function psMeasure(pids: number[]): Promise<Map<number, number> | null> {
  if (!pids.length) return Promise.resolve(null);
  if (process.platform === "win32") return windowsMeasure(pids);
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 16 * MB }, (error, stdout) => {
      if (error && !stdout) return resolve(null);
      resolve(treeRss(String(stdout), pids));
    });
  });
}

// os.freemem() on macOS counts only never-used pages (often ~100 MB on a healthy
// machine), so there "available" is free + inactive + speculative from vm_stat.
let darwinAvailable: number | null = null;
function sampleDarwinAvailable(): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  return new Promise((resolve) => {
    execFile("vm_stat", [], { timeout: 3_000, killSignal: "SIGKILL" }, (error, stdout) => {
      if (!error) {
        const text = String(stdout);
        const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
        const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1]);
        const sum = pages("free") + pages("inactive") + pages("speculative");
        if (page > 0 && Number.isFinite(sum)) darwinAvailable = sum * page;
      }
      resolve();
    });
  });
}

const defaults = (): WarmPoolDeps => ({
  now: () => Date.now(), totalmem: osTotalmem, freemem: () => darwinAvailable ?? osFreemem(), sampleFree: sampleDarwinAvailable, measure: psMeasure, env: process.env,
  log: (line) => console.info(line), timer: true,
  schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
});

export function createWarmPool(overrides: Partial<WarmPoolDeps> = {}) {
  const d: WarmPoolDeps = { ...defaults(), ...overrides };
  /** Idle engines, least recently used first. */
  const idle = new Map<object, WarmMember>();
  const sizes = new Map<object, number>();
  let lastMeasure = -Infinity;
  let lastSummary = -Infinity;
  let running: Promise<void> | null = null;
  /** MAIN-RULING warm-active-only: when each bot last had an owner turn. A bot with none in the activity
   * window keeps no engine (asleep), an active bot keeps at most one. "" = turns that name no bot. */
  const botActivity = new Map<string, number>();
  /** The bot of each thread's last owner turn, for members that do not name their bot. */
  const threadBots = new Map<string, string>();
  /** Threads whose last user turn was a non-owner's (channel audience), with when it began: that engine is in no
   * bot's bucket, so it never takes (or evicts) the owner's one engine of that bot. */
  const nonOwnerThreads = new Map<string, number>();
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Threads whose engine the owner is about to use (focus, typing), with when the last open, focus or typing beat landed: their
   * idle engine is held, not spared out, for holdFor() from that beat (also its keep-order position). */
  const intentAt = new Map<string, number>();
  /** Owner presence (designs/WARM-W1-1022-presence.md P-AWAY): unset = present (unit tests that do not wire it). */
  let presentNow: () => boolean = () => true;
  /** Bumped by every away edge: an unclaimed prewarm admitted before it is closed when it parks (P-FENCE 1). */
  let presenceEpoch = 0;
  /** P-FENCE 2: each driver instance's detach-all hook, called by ownerAway (onOwnerAway). */
  const awayDetachers = new Set<(cause: string) => number>();
  const admittedEpoch = new Map<string, number>();
  /** Admitted prewarm starts not yet parked or given back, with when admitted. Only a LOST entry lapses after PREWARM_RATE_WINDOW_MS
   * (a caller that admitted and never reported back): a start its driver still reports running (answering, or given back past its
   * wait) stays in flight until that driver says it ended, however long it runs (ASTRA 08c6017e2c). While
   * one is in flight, a pressure check closes only unclaimed engines: the pressure may be that start's own, and an owner engine never
   * pays for a prewarm (MAIN 2026-11-22 19:53Z; Astra r6 pass 1). */
  const inflightStarts = new Map<string, number>();
  /** Starts the driver reported still running after it answered false (Codex past its wait): the give-back keeps them in flight. */
  const runningAfterGiveBack = new Set<string>();
  /** Starts whose driver call has not answered yet (admitAndPrewarm: from the admission to the answer). */
  const answering = new Set<string>();
  const startsInFlight = (): number => {
    const now = d.now();
    for (const [t, at] of inflightStarts) if (now - at >= PREWARM_RATE_WINDOW_MS && !runningAfterGiveBack.has(t) && !answering.has(t)) inflightStarts.delete(t);
    return inflightStarts.size;
  };
  /** Prewarm starts admitted, per thread and across bots (P-PRE 3). */
  const startsByThread = new Map<string, number>();
  let recentStarts: number[] = [];
  /** Threads whose warm engine this pool closed, so the next spawn is a known cold wake. */
  const coldWakes = new Set<string>();
  /** Engines that already settled an owner turn, with the order they last did so.
   * A background turn that borrows one hands it back: it never closes it, and never moves it up the keep order. */
  const ownerOrder = new WeakMap<object, number>();
  let ownerSeq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const windowMs = (): number => {
    const v = Number(d.env.MURAGE_WARM_ACTIVITY_WINDOW_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_ACTIVITY_WINDOW_MS;
  };
  const botOf = (m: WarmMember): string => m.bot ?? (nonOwnerThreads.has(m.threadId) ? NON_OWNER_BUCKET : threadBots.get(m.threadId) ?? "");
  const botActiveAt = (m: WarmMember): number => botActivity.get(botOf(m)) ?? -Infinity;
  const botActive = (m: WarmMember): boolean => d.now() - botActiveAt(m) < windowMs();
  /** Judged now, not at the beat: a hold taken while the bot was active ends 120 s after the beat once the bot is asleep. */
  const intentHeld = (threadId: string) => {
    const at = intentAt.get(threadId);
    if (at === undefined) return false;
    if (d.now() - at >= holdFor(threadId)) { clearIntent(threadId); return false; }
    return true;
  };
  /** How recently the owner used this engine's bot: its last owner turn, or the owner's intent hold on its thread. */
  const recentAt = (m: WarmMember): number => Math.max(botActiveAt(m), !m.ownerActivityOnly && intentHeld(m.threadId) ? intentAt.get(m.threadId) ?? -Infinity : -Infinity);
  /** A prewarm no send has claimed yet (speculative: it never makes room for itself by evicting an owner engine). */
  const unclaimed = (key: object, m: WarmMember): boolean => m.hold === true && !ownerOrder.has(key);
  /** How long a beat on this thread holds it: while its bot is active, the window; once asleep (or for a bot with no owner turn),
   * the 120 s prewarm hold, never longer than the window (MAIN-RULING warm1022-driver-D2). */
  const holdFor = (threadId: string): number => {
    const bot = threadBots.get(threadId);
    return bot !== undefined && !nonOwnerThreads.has(threadId) && d.now() - (botActivity.get(bot) ?? -Infinity) < windowMs() ? windowMs() : Math.min(prewarmHoldMs(d.env), windowMs());
  };
  /** Each hold's own end is checked when it lapses, not at the next 30 s tick (real timers only; unit tests tick themselves). */
  const holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const setIntent = (threadId: string) => {
    const len = Math.min(holdFor(threadId), prewarmHoldMs(d.env));
    intentAt.set(threadId, d.now());
    clearTimeout(holdTimers.get(threadId));
    if (!d.timer) return;
    const t = setTimeout(() => { holdTimers.delete(threadId); if (idle.size) checkSoon(); }, len + 1);
    t.unref?.();
    holdTimers.set(threadId, t);
  };
  const clearIntent = (threadId: string) => { intentAt.delete(threadId); clearTimeout(holdTimers.get(threadId)); holdTimers.delete(threadId); };
  const budgetBytes = (): number => {
    const override = Number(d.env.MURAGE_WARM_POOL_BUDGET_MB);
    if (Number.isFinite(override) && override > 0) return override * MB;
    const total = d.totalmem();
    return Math.max(0, Math.min(total * 0.25, total - 6 * GB));
  };
  const minFreeBytes = (): number => {
    const override = Number(d.env.MURAGE_WARM_POOL_MIN_FREE_MB);
    return d.env.MURAGE_WARM_POOL_MIN_FREE_MB !== undefined && Number.isFinite(override) && override >= 0 ? override * MB : DEFAULT_MIN_FREE_BYTES;
  };
  /** Engines whose size could not be measured, already logged once. */
  const assumedLogged = new WeakSet<object>();
  const poolBytes = () => { let sum = 0; for (const m of idle.keys()) sum += sizes.get(m) ?? ASSUMED_ENGINE_BYTES; return sum; };
  const averageBytes = () => {
    const known = [...idle.keys()].map((m) => sizes.get(m)).filter((n): n is number => typeof n === "number" && n > 0);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : UNKNOWN_ENGINE_BYTES;
  };
  const mb = (n: number) => Math.round(n / MB);
  // resolved from the overrides, not the merged defaults: timer:false without an
  // injected scheduler schedules nothing real
  const schedule = overrides.schedule !== undefined ? overrides.schedule : (d.timer ? defaults().schedule! : null);
  /** When each engine was first seen idle (fallback for a missing spawnedAt). */
  const firstSeen = new WeakMap<object, number>();
  /** Each engine's early checks: scheduled once per engine, never re-armed. */
  type EarlyState = { remeasure: (() => void)[]; expiry: (() => void) | null; expiryDone: boolean; followUpAt: number };
  const early = new WeakMap<object, EarlyState>();
  /** When each engine's size was last read from nothing, taken as the reading arrives
   * (not when the whole check, with its free-memory sample, finishes). */
  const firstReadAt = new WeakMap<object, number>();
  const startOf = (key: object): number => idle.get(key)?.spawnedAt ?? firstSeen.get(key) ?? d.now();
  /** Never measured and still within the window after its spawn. */
  const measuring = (key: object): boolean => !sizes.has(key) && d.now() - startOf(key) <= MEASURING_WINDOW_MS;
  /** Pool size for the budget check in check() only: a measuring engine's provisional
   * guess never evicts OTHER idle engines. This includes a young engine whose local ps
   * failed: the grace is bounded by the 10 s window and the grace-expiry check, and it
   * never applies to admission (beforeSpawn uses poolBytes) or the free-memory backstop. */
  const budgetPoolBytes = () => { let sum = 0; for (const m of idle.keys()) sum += sizes.get(m) ?? (measuring(m) ? 0 : ASSUMED_ENGINE_BYTES); return sum; };
  /** Cancel the pending re-measures; `all` also cancels the grace-expiry check (eviction). */
  const cancelEarly = (key: object, all = false) => {
    const st = early.get(key);
    if (!st) return;
    for (const c of st.remeasure) c();
    st.remeasure = [];
    if (all && st.expiry) { st.expiry(); st.expiry = null; }
    if (all) st.expiryDone = true;
  };
  /** The once-only grace-expiry check, armed whenever an unmeasured engine is idle inside its window. */
  const ensureExpiry = (key: object, st: EarlyState, elapsed: number) => {
    if (st.expiry || st.expiryDone || sizes.has(key) || elapsed >= GRACE_EXPIRY_MS) return;
    st.expiry = schedule!(() => { st.expiry = null; st.expiryDone = true; if (idle.has(key) && !sizes.has(key)) checkSoon(); }, GRACE_EXPIRY_MS - elapsed);
  };
  /** A provisional first reading: exactly one more re-measure, at 5 s after spawn or 3 s on. */
  const armFollowUp = (key: object, st: EarlyState, age: number, readAt: number) => {
    const wait = Math.max(EARLY_REMEASURE_MS[1] - age, EARLY_FOLLOWUP_MS);
    st.followUpAt = readAt + wait;
    st.remeasure.push(schedule!(() => { if (idle.has(key)) checkSoon(); }, Math.max(0, st.followUpAt - d.now())));
  };
  /** A forced check now, or right after the one in flight (which may predate the deadline). */
  const checkSoon = () => {
    const go = () => { if (!running) running = check(true); };
    if (running) running.then(go, go); else go();
  };
  /** Re-measure an unmeasured young engine at ~2 s and ~5 s after spawn, and check once
   * just past its window, rather than at the 30 s tick. Scheduled once per engine. */
  const scheduleEarly = (key: object) => {
    if (!schedule || !idle.has(key)) return;
    const elapsed = d.now() - startOf(key);
    const known = early.get(key);
    if (known) { ensureExpiry(key, known, elapsed); return; } // back from a quick turn: no re-armed re-measures
    const st: EarlyState = { remeasure: [], expiry: null, expiryDone: false, followUpAt: 0 };
    if (sizes.has(key)) {
      // measured at once, but so young the reading may be a still-starting engine's
      const readAt = firstReadAt.get(key) ?? d.now();
      const readAge = readAt - startOf(key);
      if (readAge < EARLY_READING_MS) { early.set(key, st); armFollowUp(key, st, readAge, readAt); }
      return;
    }
    early.set(key, st);
    // each callback is a no-op unless the engine is idle and still unmeasured
    const due = () => { if (idle.has(key) && !sizes.has(key)) checkSoon(); };
    for (const target of EARLY_REMEASURE_MS) if (elapsed < target) st.remeasure.push(schedule(due, target - elapsed));
    ensureExpiry(key, st, elapsed);
  };

  const evictKey = (key: object, reason: string): boolean => {
    const member = idle.get(key);
    if (!member) return false;
    idle.delete(key);
    sizes.delete(key);
    cancelEarly(key, true);
    // defence in depth: an engine with an active turn is not idle, whatever the set says
    let busy = false;
    try { busy = member.busy?.() === true; } catch {}
    if (busy) return false;
    coldWakes.add(member.threadId);
    d.log(`warm pool evict engine=${member.engine} thread=${member.threadId} reason=${reason} poolMB=${mb(poolBytes())} budgetMB=${mb(budgetBytes())}`);
    try { member.close(reason); } catch {}
    return true;
  };
  /** Pressure retires the least recently active bot's engine first (MAIN-RULING warm-active-only (4));
   * within one bot, the least recently used. */
  const evictOldest = (reason: string): boolean => {
    if (startsInFlight() > 0) {
      const spare = [...idle].find(([key, m]) => unclaimed(key, m));
      return spare ? evictKey(spare[0], reason) : false;
    }
    // an unclaimed prewarm goes before any engine that settled an owner turn (owner always wins, MAIN 2026-11-22 19:53Z)
    const order = [...idle].map(([key, m], i) => ({ key, at: recentAt(m), i, spec: unclaimed(key, m) ? 0 : 1 })).sort((a, b) => a.spec - b.spec || a.at - b.at || a.i - b.i);
    for (const { key } of order) if (evictKey(key, reason)) return true;
    return false;
  };
  /** An intent hold counts toward its bot's one-engine limit: a CLAIMED hold replaces that bot's previous idle spare of its
   * kind (other bots keep theirs). An UNCLAIMED prewarm only moves other unclaimed prewarms (at most one per engine kind): an
   * engine that settled an owner turn is never closed by opening another chat, of its own bot or another (presence P-PRE 3, 6;
   * MAIN 2026-11-22 19:53Z "a prewarm never evicts the owner engine", MAIN 2026-11-23 warm1022-presence-r6 same-bot path). */
  const moveIntent = (member: object, info: WarmMember) => {
    const speculative = unclaimed(member, info);
    for (const [key, m] of [...idle]) {
      if (key !== member && m.engine === info.engine && m.threadId !== info.threadId && ((botOf(m) === botOf(info) && !speculative) || unclaimed(key, m))) evictKey(key, "intent-moved");
    }
  };

  const refresh = async (force: boolean) => {
    if (!idle.size) return;
    const t = d.now();
    const unmeasured = [...idle.keys()].some((m) => !sizes.has(m));
    if (!force && !unmeasured && t - lastMeasure < MEASURE_EVERY_MS) return;
    lastMeasure = t;
    const entries = [...idle.entries()].map(([key, m]) => [key, m.pid()] as const).filter((e): e is readonly [object, number] => typeof e[1] === "number");
    // A platform rssBytes hook (Murage Cloud) replaces the measurement; a pid it
    // does not know stays unmeasured and is assumed at 600 MB.
    const pids = entries.map(([, pid]) => pid);
    const result = hasPlatformRss() ? await platformRss(pids).catch(() => null) : await d.measure(pids).catch(() => null);
    if (result) {
      for (const [key, pid] of entries) {
        const bytes = result.get(pid);
        if (bytes === undefined || !idle.has(key)) continue;
        const first = !sizes.has(key);
        sizes.set(key, bytes);
        if (first) firstReadAt.set(key, d.now());
        const st = early.get(key);
        const age = d.now() - startOf(key);
        if (st && st.followUpAt > d.now()) continue; // provisional: its one follow-up is pending
        if (st && schedule && first && age < EARLY_READING_MS) {
          // first reading of a still-starting engine: keep exactly one more re-measure
          cancelEarly(key);
          armFollowUp(key, st, age, d.now());
        } else cancelEarly(key);
      }
    }
    // unmeasurable (Windows, a failed ps): a conservative size counts toward the budget
    for (const [key, m] of idle) {
      if (sizes.has(key) || assumedLogged.has(key)) continue;
      assumedLogged.add(key);
      d.log(`warm pool rss unknown, assuming 600MB engine=${m.engine} thread=${m.threadId}`);
    }
  };

  const enforce = () => {
    // P-AWAY: while the owner is away nothing idle survives a check
    if (!presentNow()) for (const key of [...idle.keys()]) evictKey(key, "owner away");
    // past the warm max age: an idle engine is at a turn boundary, so retire it now
    for (const [key, m] of [...idle]) if (pastWarmMaxAge(m.spawnedAt, d.now(), d.env)) evictKey(key, "max-age");
    // MAIN-RULING warm-active-only: a bot with no owner turn in the window is asleep, so its engines go. The one
    // exception is the owner's own intent hold (focus, typing) on that thread: kept for the hold's window only.
    for (const [key, m] of [...idle]) if (!botActive(m) && (m.ownerActivityOnly || !intentHeld(m.threadId))) evictKey(key, unclaimed(key, m) ? "prewarm unused" : "activity window");
    // forget bots and threads that are past the window and own no idle engine
    const now = d.now(), live = new Set([...idle.values()].map(botOf));
    for (const [b, at] of botActivity) if (now - at >= windowMs() && !live.has(b)) botActivity.delete(b);
    const idleThreads = new Set([...idle.values()].map((m) => m.threadId));
    for (const [t, b] of threadBots) if (!botActivity.has(b) && !idleThreads.has(t) && !intentAt.has(t)) threadBots.delete(t);
    for (const [t, at] of startsByThread) if (now - at >= PREWARM_RATE_WINDOW_MS) startsByThread.delete(t);
    for (const [t, at] of nonOwnerThreads) if (now - at >= windowMs() && !idleThreads.has(t)) nonOwnerThreads.delete(t);
    // at most one idle engine per active bot: one that settled an owner turn before an unclaimed prewarm (owner always wins);
    // among those, the intent-held one, else the most recently used
    const byBot = new Map<string, [object, WarmMember][]>();
    for (const e of idle) { const b = botOf(e[1]); byBot.set(b, [...(byBot.get(b) ?? []), e]); }
    for (const mine of byBot.values()) {
      const owned = mine.filter(([key, m]) => !unclaimed(key, m));
      const pick = owned.length ? owned : mine;
      const held = pick.filter(([, m]) => intentHeld(m.threadId));
      const keep = (held.length ? held : pick).at(-1)?.[0];
      for (const [key] of mine) if (key !== keep) evictKey(key, "spare limit");
    }
    // at most warmSpares() (3) idle engines per engine kind across bots: the most recently active bots keep theirs
    for (const engine of ["claude", "codex", "acp"] as const) {
      const mine = [...idle].filter(([, m]) => m.engine === engine).map(([key, m], i) => ({ key, at: recentAt(m), i, spec: unclaimed(key, m) ? 1 : 0 }));
      // unclaimed prewarms go first under the cap: another bot's engine that settled an owner turn is never closed to keep one (P-PRE 3, 6)
      mine.sort((a, b) => a.spec - b.spec || b.at - a.at || b.i - a.i);
      for (const { key } of mine.slice(warmSpares(d.env))) evictKey(key, "spare limit");
    }
    const budget = budgetBytes();
    // stops when nothing more may be closed (a prewarm start in flight protects owner engines): never a loop without progress
    while (idle.size && budgetPoolBytes() > budget) if (!evictOldest("pool budget")) break;
    // free memory does not move until the kill lands: one engine per check
    if (idle.size && d.freemem() < minFreeBytes()) evictOldest("low memory");
  };

  const summary = () => {
    const t = d.now();
    if (t - lastSummary < SUMMARY_EVERY_MS) return;
    lastSummary = t;
    // idle resident size per engine, so the thresholds come from data
    for (const [key, m] of idle) {
      const bytes = sizes.get(key);
      if (bytes !== undefined) d.log(`warm pool rss engine=${m.engine} thread=${m.threadId} rssMB=${mb(bytes)}`);
    }
    d.log(`warm pool engines=${idle.size} idle=${idle.size} poolMB=${mb(poolBytes())} budgetMB=${mb(budgetBytes())} freeMB=${mb(d.freemem())} ${reuseStats.line()}`);
  };

  const check = (force: boolean): Promise<void> => {
    const run = (async () => {
      try {
        await refresh(force);
        await d.sampleFree().catch(() => {});
        enforce();
        summary();
      } finally {
        running = null;
        if (!idle.size && timer) { clearInterval(timer); timer = null; }
      }
    })();
    return run;
  };

  const startTimer = () => {
    if (!d.timer || timer) return;
    timer = setInterval(() => { if (!running) running = check(true); }, MEASURE_EVERY_MS);
    timer.unref?.();
  };

  /** Scopes whose login split: engines started on them before this time are closed, now if idle and at settle if busy. */
  const drained = new Map<string, number>();
  const scopeId = (scope: { kind: string; bot: string | null }) => `${scope.kind}\u0000${scope.bot ?? ""}`;
  const staleScope = (info: WarmMember): boolean => {
    if (!info.scope) return false;
    const at = drained.get(scopeId(info.scope));
    return at !== undefined && !(info.spawnedAt !== undefined && info.spawnedAt > at);
  };

  const api = {
    /** The scope's login split: close every idle engine started on it, and any started before now when it settles. */
    drainScope(scope: { kind: string; bot: string | null }, reason = "login-split"): number {
      drained.set(scopeId(scope), d.now());
      let closed = 0;
      for (const [key, m] of [...idle]) {
        if (m.scope && scopeId(m.scope) === scopeId(scope)) { idle.delete(key); sizes.delete(key); cancelEarly(key); try { m.close(reason); } catch {} closed++; }
      }
      return closed;
    },
    /** An engine settled and is idle now (also refreshes its LRU position). */
    markIdle(member: object, info: WarmMember): Promise<void> {
      idle.delete(member);
      if (info.hold) inflightStarts.delete(info.threadId);
      if (staleScope(info)) { sizes.delete(member); cancelEarly(member); try { info.close("login-split"); } catch {} return Promise.resolve(); }
      // P-AWAY: while away every engine closes as it settles (owner, borrowed, background, prewarm). P-FENCE 1: an unclaimed
      // prewarm admitted before the newest away edge closes too, even if he is present again by now.
      const stale = info.hold === true && !ownerOrder.has(member) && (admittedEpoch.get(info.threadId) ?? presenceEpoch) < presenceEpoch;
      if (!presentNow() || stale) {
        if (info.hold) { admittedEpoch.delete(info.threadId); clearIntent(info.threadId); }
        idle.set(member, info);
        evictKey(member, "owner away");
        return Promise.resolve();
      }
      if (info.ownerActivityOnly && !botActive(info)) {
        idle.set(member, info);
        evictKey(member, "activity window");
        return Promise.resolve();
      }
      // A background turn (routine, schedule, card continuation) on the owner's own thread runs on the
      // owner's hot engine. That engine is the owner's: it goes back where it was, with the thread's hold as it was.
      const borrowed = info.background === true && ownerOrder.has(member);
      if (!borrowed) {
        if (info.hold && !info.background) setIntent(info.threadId);
        else clearIntent(info.threadId);
      }
      if (info.background && !borrowed) {
        sizes.delete(member);
        idle.set(member, info);
        evictKey(member, "background turn");
        return Promise.resolve();
      }
      if (borrowed) {
        // back at its owner-use position: engines the owner used later stay ahead of it
        const mine = ownerOrder.get(member)!;
        const later = [...idle].filter(([key]) => (ownerOrder.get(key) ?? Infinity) > mine);
        for (const [key] of later) idle.delete(key);
        idle.set(member, { ...info, background: false });
        for (const [key, m] of later) idle.set(key, m);
        d.log(`warm pool keep engine=${info.engine} thread=${info.threadId} reason=owner engine after a background turn`);
      } else {
        // a prewarm no send has reached yet is not the owner's engine: a background turn that takes it still releases it
        if (!info.hold) ownerOrder.set(member, ++ownerSeq);
        idle.set(member, info);
      }
      if (!firstSeen.has(member)) firstSeen.set(member, d.now());
      if (info.hold) moveIntent(member, info);
      startTimer();
      const run = running ??= check(false);
      run.then(() => scheduleEarly(member), () => {});
      return run;
    },
    /** A USER turn from any surface began on this bot's thread. Routines, schedules and memory work never call this. */
    noteUserActivity(botId?: string, threadId?: string) {
      botActivity.set(botId ?? "", d.now());
      // a turn that names no bot never moves a thread off the bot it is known to belong to
      if (threadId !== undefined && (botId !== undefined || !threadBots.has(threadId))) threadBots.set(threadId, botId ?? "");
      if (!d.timer) return;
      if (windowTimer) clearTimeout(windowTimer);
      windowTimer = setTimeout(() => { windowTimer = null; if (!running) running = check(true); }, windowMs() + 1_000);
      windowTimer.unref?.();
    },
    /** A user turn began on this thread (every driver calls this at send; background turns never do). MAIN-RULING
     * warm-active-only: an owner turn wakes its bot; a non-owner (channel audience) turn wakes no bot and marks the
     * thread, so its engine never takes that bot's one slot. A turn with no identity counts as an owner turn of "". */
    noteTurn(identity: { botId: string; audience: "owner" | "non-owner" } | undefined, threadId: string): void {
      if (identity?.audience === "non-owner") { nonOwnerThreads.set(threadId, d.now()); return; }
      nonOwnerThreads.delete(threadId);
      api.noteUserActivity(identity?.botId, threadId);
    },
    /** What the pool knows of a thread's last user turn: its bot, whether that bot is awake, and whether it was a non-owner's. */
    activityFor(threadId: string): { bot: string | undefined; active: boolean; nonOwner: boolean } {
      const bot = threadBots.get(threadId), nonOwner = nonOwnerThreads.has(threadId);
      return { bot, active: !nonOwner && bot !== undefined && d.now() - (botActivity.get(bot) ?? -Infinity) < windowMs(), nonOwner };
    },
    /** Warm on intent (window focus, composer typing): hold this thread's idle engine
     * for one window; it is released if no send follows. */
    warmIntent(threadId: string, botId?: string) {
      if (botId !== undefined) threadBots.set(threadId, botId);
      // MAIN-RULING warm1022-driver-D2: an asleep bot's hold is the 120 s prewarm hold; an active bot keeps the window
      setIntent(threadId);
      for (const [key, m] of [...idle]) if (m.threadId === threadId && (!m.ownerActivityOnly || botActive(m))) moveIntent(key, m);
      if (d.timer) startTimer();
    },
    /** True once if this pool closed the thread's engine, so the next spawn is a cold wake. */
    consumeColdWake(threadId: string): boolean { return coldWakes.delete(threadId); },
    tick: () => check(true),
    /** The engine left the idle set: a turn began, or it closed. Its grace-expiry check
     * stays (a quick turn returns it to idle inside the window); it is a no-op unless the
     * engine is idle again. */
    release(member: object) { idle.delete(member); sizes.delete(member); cancelEarly(member); },
    /** A send reached the thread: its intent hold has done its job. */
    sent(threadId: string) { clearIntent(threadId); admittedEpoch.delete(threadId); },
    /** Wire owner presence (index.ts): while it reads false nothing idle is kept. */
    setPresence(present: () => boolean) { presentNow = present; },
    /** P-AWAY: the owner went away at an edge (lock, sleep). Every hold is cleared and every idle engine is retired now;
     * busy engines finish their turn and close at settle. An unclaimed prewarm still starting closes when it parks (epoch). */
    ownerAway(cause: string): number {
      presenceEpoch++;
      for (const t of [...intentAt.keys()]) clearIntent(t);
      let closed = 0;
      for (const key of [...idle.keys()]) if (evictKey(key, `owner away ${cause}`)) closed++;
      // P-FENCE 2 (W-PR6 a): every unclaimed prewarm still starting is abandoned now, on every driver instance, never left to park
      for (const detach of [...awayDetachers]) { try { closed += detach(cause); } catch {} }
      return closed;
    },
    /** A driver instance's hook for ownerAway: it abandons every prewarm of its own still starting and returns how many. The
     * returned function unregisters it (dispose). */
    onOwnerAway(detach: (cause: string) => number): () => void {
      awayDetachers.add(detach);
      return () => { awayDetachers.delete(detach); };
    },
    /** The driver started nothing for an admitted prewarm (a no-op): its start is given back. Its admission epoch stays: a driver
     * that answers false while its start goes on (Codex, past its wait) still parks later, and P-FENCE 1 must judge that park. */
    /** The driver answered false but its start goes on (Codex past its wait): it stays in flight until it parks or ends. */
    startStillRunning(threadId: string) { runningAfterGiveBack.add(threadId); },
    /** That start ended (parked, failed or abandoned). */
    startEnded(threadId: string) { runningAfterGiveBack.delete(threadId); if (!answering.has(threadId)) inflightStarts.delete(threadId); },
    /** The driver's start call began (admitAndPrewarm): it is in flight, without a lapse, until startAnswered. */
    startAnswering(threadId: string) { if (inflightStarts.has(threadId)) answering.add(threadId); },
    /** The driver's start call answered. True: its engine parked (or a send claimed it), the start is over. False: unadmitPrewarm
     * follows, which keeps a start the driver reported still running. */
    startAnswered(threadId: string, started: boolean) { answering.delete(threadId); if (started) inflightStarts.delete(threadId); },
    unadmitPrewarm(threadId: string) {
      if (!runningAfterGiveBack.has(threadId)) inflightStarts.delete(threadId);
      const at = startsByThread.get(threadId);
      if (at === undefined) return;
      startsByThread.delete(threadId);
      const i = recentStarts.lastIndexOf(at);
      if (i >= 0) recentStarts.splice(i, 1);
    },
    /** P-PRE 2-4: may a prewarm start on this thread now? Records its admission (epoch, rate) when it may. */
    admitPrewarm(threadId: string): { ok: true } | { ok: false; reason: "away" | "warm" | "rate" | "budget" } {
      if (!presentNow()) return { ok: false, reason: "away" };
      if ([...idle.values()].some((m) => m.threadId === threadId)) return { ok: false, reason: "warm" };
      const now = d.now();
      recentStarts = recentStarts.filter((at) => now - at < PREWARM_RATE_WINDOW_MS);
      const last = startsByThread.get(threadId);
      if ((last !== undefined && now - last < PREWARM_RATE_WINDOW_MS) || recentStarts.length >= PREWARM_STARTS_PER_WINDOW) return { ok: false, reason: "rate" };
      // speculative: only unclaimed prewarms make room, never an engine that settled an owner turn
      const budget = budgetBytes();
      // room for the engine it is about to start, in the pool budget AND above the free-memory floor: a start that would push free
      // memory under the floor is refused here, so no pressure check before its park ever closes an owner engine for it
      const over = () => poolBytes() + averageBytes() * (1 + startsInFlight()) > budget || d.freemem() - averageBytes() * (1 + startsInFlight()) < minFreeBytes();
      while (over()) {
        const spare = [...idle].find(([key, m]) => unclaimed(key, m));
        if (!spare || !evictKey(spare[0], "intent-moved")) break;
      }
      if (over()) return { ok: false, reason: "budget" };
      startsByThread.set(threadId, now);
      recentStarts.push(now);
      inflightStarts.set(threadId, now);
      // a given-back start of this thread may still be running and park later: it keeps the older epoch (ASTRA 4ee774eaee retry race)
      admittedEpoch.set(threadId, Math.min(admittedEpoch.get(threadId) ?? presenceEpoch, presenceEpoch));
      return { ok: true };
    },
    /** Make headroom for one more engine before a spawn. Never refuses the spawn: it
     * evicts idle engines instead. A measuring engine counts its provisional size here
     * (no grace on admission), and the free-memory backstop runs on a fresh sample. A `speculative` spawn (a prewarm) makes room
     * only from unclaimed prewarms, never from an engine that settled an owner turn (P-PRE 4: owner always wins). */
    async beforeSpawn(opts?: { speculative?: boolean }): Promise<void> {
      if (!idle.size) return;
      await running?.catch(() => {});
      await refresh(false);
      await d.sampleFree().catch(() => {});
      const budget = budgetBytes();
      const evict = (reason: string) => {
        if (!opts?.speculative) return evictOldest(reason);
        const spare = [...idle].find(([key, m]) => unclaimed(key, m));
        return spare ? evictKey(spare[0], reason) : false;
      };
      if (idle.size && poolBytes() + averageBytes() > budget) evict("pool reserve");
      if (idle.size && d.freemem() - (opts?.speculative ? averageBytes() : 0) < minFreeBytes()) evict("low memory");
    },
    idleCount: () => idle.size,
    poolBytes,
    budgetBytes,
  };
  return api;
}

export const warmPool = createWarmPool();

/** warmThread's admission, start and give-back (server/index.ts), shared so its witness drives the production wiring: P-PRE 2-4
 * admission (records the presence epoch before the driver's first await, P-FENCE 1), then the driver's start; a start that answers
 * false (a no-op, or Codex past its wait while it still runs) is given back, keeping its admission epoch. */
export function admitAndPrewarm(
  pool: Pick<ReturnType<typeof createWarmPool>, "admitPrewarm" | "unadmitPrewarm"> & Partial<Pick<ReturnType<typeof createWarmPool>, "startAnswering" | "startAnswered">>,
  threadId: string,
  start: () => Promise<boolean>,
): Promise<{ admitted: false; reason: "away" | "warm" | "rate" | "budget" } | { admitted: true; started: boolean }> {
  const admission = pool.admitPrewarm(threadId);
  if (!admission.ok) return Promise.resolve({ admitted: false, reason: admission.reason });
  // the driver's start runs now, in the same tick as the admission (its gate entry registers before any away edge can land)
  let starting: Promise<boolean>;
  pool.startAnswering?.(threadId);
  try { starting = start(); } catch { starting = Promise.resolve(false); }
  return starting.catch(() => false).then((started) => {
    pool.startAnswered?.(threadId, started);
    if (!started) pool.unadmitPrewarm(threadId);
    return { admitted: true as const, started };
  });
}
