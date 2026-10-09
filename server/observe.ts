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
export function noteLoopHolder(name: string, ms: number): void { if (!topSource || ms > topSource.ms) topSource = { name, ms }; }

let loopMonitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
let loopTimer: ReturnType<typeof setInterval> | undefined;
/** `[loop] lag p50= p99= max= topSource=` every 5 minutes while p99 is over 100 ms. */
export function startLoopLagMonitor(intervalMs = 300_000, thresholdMs = 100): void {
  if (loopMonitor) return;
  loopMonitor = monitorEventLoopDelay({ resolution: 20 });
  loopMonitor.enable();
  loopTimer = setInterval(() => reportLoopLag(thresholdMs), intervalMs);
  loopTimer.unref();
}
export function reportLoopLag(thresholdMs = 100): string | undefined {
  if (!loopMonitor) return undefined;
  const p50 = loopMonitor.percentile(50) / 1e6, p99 = loopMonitor.percentile(99) / 1e6, max = loopMonitor.max / 1e6;
  loopMonitor.reset();
  const holder = topSource?.name ?? "unknown";
  topSource = undefined;
  if (p99 <= thresholdMs) return undefined;
  const line = `[loop] lag p50=${Math.round(p50)} p99=${Math.round(p99)} max=${Math.round(max)} topSource=${holder}`;
  observeLine(line);
  return line;
}
export function stopLoopLagMonitor(): void {
  loopMonitor?.disable(); loopMonitor = undefined;
  if (loopTimer) clearInterval(loopTimer); loopTimer = undefined;
}

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
