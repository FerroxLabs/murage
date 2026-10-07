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
  /** When the engine process was spawned (epoch ms): an idle engine past the
   * warm max age is closed with reason max-age. */
  spawnedAt?: number;
}

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
  const pending = new Map<string, { done: Promise<void>; finish: () => void }>();
  return {
    has: (threadId: string) => pending.has(threadId),
    /** False when a prewarm of this thread is already starting. */
    begin(threadId: string): boolean {
      if (pending.has(threadId)) return false;
      let finish = () => {};
      const done = new Promise<void>((resolve) => { finish = resolve; });
      pending.set(threadId, { done, finish });
      return true;
    },
    end(threadId: string) {
      const entry = pending.get(threadId);
      if (!entry) return;
      pending.delete(threadId);
      entry.finish();
    },
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

/** What a prewarm needs from a turn and no more: the spawn inputs (cwd, env source,
 * MCP config, settings, warm identity), without the message, its attachments, the
 * replay transcript or the caller's per-turn callbacks. */
export function spawnInputsOf(turn: SendTurnInput): SendTurnInput {
  return { ...turn, text: "", images: undefined, engineCommand: undefined, transcript: undefined, prewarm: undefined, onToolSurface: undefined, beforeSubmit: undefined };
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
 * (the same single Win32_Process listing the process-tree probes use). A
 * process whose working set Windows withholds counts as 0; a root it does
 * not list stays unmeasured. */
export async function windowsMeasure(pids: number[]): Promise<Map<number, number> | null> {
  const rows = await windowsListing();
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
  now: Date.now, totalmem: osTotalmem, freemem: () => darwinAvailable ?? osFreemem(), sampleFree: sampleDarwinAvailable, measure: psMeasure, env: process.env,
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
  let lastActivity = -Infinity;
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Threads whose engine the owner is about to use (focus, typing): their idle engine is held, not spared out. */
  const intents = new Map<string, number>();
  /** Threads whose warm engine this pool closed, so the next spawn is a known cold wake. */
  const coldWakes = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const windowMs = (): number => {
    const v = Number(d.env.MURAGE_WARM_ACTIVITY_WINDOW_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_ACTIVITY_WINDOW_MS;
  };
  const active = () => d.now() - lastActivity < windowMs();
  const intentHeld = (threadId: string) => {
    const until = intents.get(threadId);
    if (until === undefined) return false;
    if (until <= d.now()) { intents.delete(threadId); return false; }
    return true;
  };
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
  const evictOldest = (reason: string): boolean => {
    for (const key of [...idle.keys()]) if (evictKey(key, reason)) return true;
    return false;
  };
  /** An intent hold counts toward the one-spare-per-kind limit: the new hold
   * replaces the previous idle spare of its kind. */
  const moveIntent = (member: object, info: WarmMember) => {
    for (const [key, m] of [...idle]) {
      if (key !== member && m.engine === info.engine && m.threadId !== info.threadId) evictKey(key, "intent-moved");
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
    // past the warm max age: an idle engine is at a turn boundary, so retire it now
    for (const [key, m] of [...idle]) if (pastWarmMaxAge(m.spawnedAt, d.now(), d.env)) evictKey(key, "max-age");
    // idle past the window: back to zero (an intent hold keeps its own thread)
    if (!active()) {
      for (const [key, m] of [...idle]) if (!intentHeld(m.threadId)) evictKey(key, "activity window");
    } else {
      // while active: at most one idle spare per engine kind, the most recently used
      // (an intent-held process counts, and is the one kept when there is one)
      for (const engine of ["claude", "codex", "acp"] as const) {
        const mine = [...idle].filter(([, m]) => m.engine === engine);
        const held = mine.filter(([, m]) => intentHeld(m.threadId));
        const keep = (held.length ? held : mine).at(-1)?.[0];
        for (const [key] of mine) if (key !== keep) evictKey(key, "spare limit");
      }
    }
    const budget = budgetBytes();
    while (idle.size && budgetPoolBytes() > budget) evictOldest("pool budget");
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
    d.log(`warm pool engines=${idle.size} idle=${idle.size} poolMB=${mb(poolBytes())} budgetMB=${mb(budgetBytes())} freeMB=${mb(d.freemem())}`);
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

  return {
    /** An engine settled and is idle now (also refreshes its LRU position). */
    markIdle(member: object, info: WarmMember): Promise<void> {
      idle.delete(member);
      if (info.hold && !info.background) intents.set(info.threadId, d.now() + windowMs());
      else intents.delete(info.threadId);
      if (info.background) {
        sizes.delete(member);
        idle.set(member, info);
        evictKey(member, "background turn");
        return Promise.resolve();
      }
      idle.set(member, info);
      if (!firstSeen.has(member)) firstSeen.set(member, d.now());
      if (info.hold) moveIntent(member, info);
      startTimer();
      const run = running ??= check(false);
      run.then(() => scheduleEarly(member), () => {});
      return run;
    },
    /** A USER turn from any surface began. Routines, schedules and memory work never call this. */
    noteUserActivity() {
      lastActivity = d.now();
      if (!d.timer) return;
      if (windowTimer) clearTimeout(windowTimer);
      windowTimer = setTimeout(() => { windowTimer = null; if (!running) running = check(true); }, windowMs() + 1_000);
      windowTimer.unref?.();
    },
    /** Warm on intent (window focus, composer typing): hold this thread's idle engine
     * for one window; it is released if no send follows. */
    warmIntent(threadId: string) {
      intents.set(threadId, d.now() + windowMs());
      for (const [key, m] of [...idle]) if (m.threadId === threadId) moveIntent(key, m);
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
    sent(threadId: string) { intents.delete(threadId); },
    /** Make headroom for one more engine before a spawn. Never refuses the spawn: it
     * evicts idle engines instead. A measuring engine counts its provisional size here
     * (no grace on admission), and the free-memory backstop runs on a fresh sample. */
    async beforeSpawn(): Promise<void> {
      if (!idle.size) return;
      await running?.catch(() => {});
      await refresh(false);
      await d.sampleFree().catch(() => {});
      const budget = budgetBytes();
      if (idle.size && poolBytes() + averageBytes() > budget) evictOldest("pool reserve");
      if (idle.size && d.freemem() < minFreeBytes()) evictOldest("low memory");
    },
    idleCount: () => idle.size,
    poolBytes,
    budgetBytes,
  };
}

export const warmPool = createWarmPool();
