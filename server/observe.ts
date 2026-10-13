// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plain, rate-limited log lines for the memory performance work (PROPOSAL-v2
// section 11). Counts, milliseconds and fixed words only: never content, never
// user-data ids. On by default; the opt-in turn trace (turn-trace.ts) is separate.
import { monitorEventLoopDelay } from "node:perf_hooks";

export type ObserveSink = (line: string) => void;
let sink: ObserveSink = line => console.log(line);
/** Tests capture the lines; passing nothing restores the console. */
export function setObserveSink(next?: ObserveSink): void { sink = next ?? (line => console.log(line)); }
export function observeLine(line: string): void { try { sink(line); } catch { /* a log line never fails the work */ } }

interface Window { at: number; suppressed: number }
const windows = new Map<string, Window>();
const MAX_WINDOWS = 512;
/** Emit `build(suppressed)` at most once per `windowMs` for `key`; the line says how many were folded into it. */
export function rateLimited(key: string, windowMs: number, build: (suppressed: number) => string, now = Date.now()): boolean {
  const previous = windows.get(key);
  if (previous && now - previous.at < windowMs) { previous.suppressed++; return false; }
  if (!previous && windows.size >= MAX_WINDOWS) windows.delete(windows.keys().next().value!);
  windows.set(key, { at: now, suppressed: 0 });
  observeLine(build(previous?.suppressed ?? 0));
  return true;
}
export function resetObserveWindows(): void { windows.clear(); }

/** Named long synchronous or awaited operations, so a lock wait or a slow step can say what was running. */
const longOps = new Map<number, { name: string; since: number }>();
let longOpSeq = 0;
export function longOp<T>(name: string, run: () => T): T {
  const id = ++longOpSeq;
  longOps.set(id, { name, since: performance.now() });
  try { return run(); } finally { longOps.delete(id); }
}
export function runningLongOps(): string[] { return [...longOps.values()].map(op => op.name); }
/** Name of the longest-running registered operation, or undefined. */
export function oldestLongOp(): string | undefined {
  let best: { name: string; since: number } | undefined;
  for (const op of longOps.values()) if (!best || op.since < best.since) best = op;
  return best?.name;
}

/** The step that last held the loop longest since the monitor last reported (name only). */
let topSource: { name: string; ms: number } | undefined;
export function noteLoopHolder(name: string, ms: number): void {
  if (!topSource || ms > topSource.ms) topSource = { name, ms };
  addStallStep(name, ms);
}
/** Run a synchronous step that can hold the main thread, naming it for the
 * stall line while it runs. Every run counts toward its name's total on the
 * stall line (a thousand 10 ms calls are a 10 s holder); one over 50 ms is
 * also the lag line's top source. */
export function heldStep<T>(name: string, run: () => T): T {
  const restore = noteActiveTask(name);
  const started = performance.now();
  try { return run(); }
  finally {
    restore();
    const ms = performance.now() - started;
    if (ms > 50) noteLoopHolder(name, ms);
    else addStallStep(name, ms);
  }
}
/** Time per named step since the stall watch's last tick, summed across calls. */
let stallSteps = new Map<string, { ms: number; calls: number }>();
function addStallStep(name: string, ms: number): void {
  const step = stallSteps.get(name);
  if (step) { step.ms += ms; step.calls++; }
  else if (stallSteps.size < 256) stallSteps.set(name, { ms, calls: 1 });
}
/** `name:<total>ms` (with `xN` when it ran N > 1 times) for the step that held the loop longest in all,
 *  and the next two as `others=`. */
export function stallHolderText(steps: ReadonlyMap<string, { ms: number; calls: number }>): string {
  const ranked = [...steps].filter(([, step]) => step.ms >= 1).sort((a, b) => b[1].ms - a[1].ms);
  if (!ranked.length) return "holder=unknown";
  const one = ([name, step]: [string, { ms: number; calls: number }]) => `${name}:${Math.round(step.ms)}ms${step.calls > 1 ? `x${step.calls}` : ""}`;
  return `holder=${one(ranked[0]!)}${ranked.length > 1 ? ` others=${ranked.slice(1, 3).map(one).join(",")}` : ""}`;
}
/** The named step running when the stall watch last looked (what a stall interrupted, or caused). */
let activeTask: string | undefined;
/** The task named last (what the stall line would call active now), or undefined. */
export function activeTaskName(): string | undefined { return activeTask; }
/** Name what the main thread is doing for the stall line. Returns the restore. */
export function noteActiveTask(name: string): () => void {
  const previous = activeTask;
  activeTask = name;
  return () => { activeTask = previous; };
}

let loopMonitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
let loopTimer: ReturnType<typeof setInterval> | undefined;
/** `[loop] lag p50= p99= max= topSource=` every 5 minutes while p99 is over 100 ms. */
export function startLoopLagMonitor(intervalMs = 300_000, thresholdMs = 100): void {
  if (loopMonitor) return;
  loopMonitor = monitorEventLoopDelay({ resolution: 20 });
  loopMonitor.enable();
  loopTimer = setInterval(() => reportLoopLag(thresholdMs), intervalMs);
  loopTimer.unref();
  startLoopStallWatch();
}
export function reportLoopLag(thresholdMs = 100): string | undefined {
  if (!loopMonitor) return undefined;
  const p50 = loopMonitor.percentile(50) / 1e6, p99 = loopMonitor.percentile(99) / 1e6, max = loopMonitor.max / 1e6;
  loopMonitor.reset();
  const holder = topSource?.name ?? "unknown";
  topSource = undefined;
  // One long block is a single sample of the histogram, so p99 alone hid a
  // two-minute stall; the max says it.
  if (p99 <= thresholdMs && max <= STALL_THRESHOLD_MS) return undefined;
  const line = `[loop] lag p50=${Math.round(p50)} p99=${Math.round(p99)} max=${Math.round(max)} topSource=${holder}`;
  observeLine(line);
  return line;
}
export function stopLoopLagMonitor(): void {
  loopMonitor?.disable(); loopMonitor = undefined;
  if (loopTimer) clearInterval(loopTimer); loopTimer = undefined;
  stopLoopStallWatch();
}

/** A main-thread block this long is logged at once, by itself. */
export const STALL_THRESHOLD_MS = 1_000;
let stallTimer: ReturnType<typeof setInterval> | undefined;
/**
 * `[loop] stall blocked=<ms> holder=<step> running=<ops> active=<task>`, the
 * moment the main thread comes back from a block over `thresholdMs`.
 *
 * Everything an engine waits on in Murage runs on this one thread: the reply
 * to a permission ask, the relay of every connected-app call, a steer, the
 * memory lease heartbeat. A block there looked like the engine or the broker
 * being slow (a 137 s "permission wait" in No limits, a 146 s app call Flux
 * answered in 10 s), and nothing in the log said so. The five-minute lag line
 * is a percentile; this is the event, with what held the thread: the named
 * steps that reported themselves (`heldStep`, `noteLoopHolder`), each summed
 * over the whole block and the largest three named, the long operations
 * still open, and the task named last (`noteActiveTask`).
 */
export function startLoopStallWatch(thresholdMs = STALL_THRESHOLD_MS, tickMs = 250, now: () => number = () => performance.now()): void {
  if (stallTimer) return;
  let last = now();
  stallSteps = new Map();
  stallTimer = setInterval(() => {
    const at = now();
    const blocked = at - last - tickMs;
    last = at;
    const steps = stallSteps;
    stallSteps = new Map();
    if (blocked <= thresholdMs) return;
    const running = runningLongOps();
    observeLine(`[loop] stall blocked=${Math.round(blocked)}ms ${stallHolderText(steps)}${running.length ? ` running=${running.slice(0, 4).join(",")}` : ""}${activeTask ? ` active=${activeTask}` : ""}`);
  }, tickMs);
  stallTimer.unref();
}
export function stopLoopStallWatch(): void { if (stallTimer) clearInterval(stallTimer); stallTimer = undefined; }

/** A statement that held the loop this long is reported (and remembered as the loop's top holder). */
export const SLOW_SQL_MS = 50;
export function reportSlowSql(op: string, ms: number, source: string | undefined): void {
  noteLoopHolder(`sqlite:${source ?? "unattributed"}`, ms);
  rateLimited(`sqlite-slow:${op}`, 60_000, suppressed => `[sqlite] slow op=${op} ms=${Math.round(ms)} source=${source ?? "none"}${suppressed ? ` more=${suppressed}` : ""}`);
}

/** `[memory] eligibility rule=<version> keep= ask= refuse= unknown=` for one batch of the eligibility classifier (line 7). */
export function logEligibilityBatch(rule: string, counts: { keep: number; ask: number; refuse: number; unknown: number }): void {
  const safe = /^[A-Za-z0-9._-]{1,24}$/.test(rule) ? rule : "unversioned";
  observeLine(`[memory] eligibility rule=${safe} keep=${counts.keep} ask=${counts.ask} refuse=${counts.refuse} unknown=${counts.unknown}`);
}
