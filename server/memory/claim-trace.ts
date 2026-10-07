// Memory-worker timing trace, behind MURAGE_TURN_TRACE=1 like the turn trace
// (../turn-trace.ts). Off, every function here is one environment read.
// Counts and milliseconds only: step names are fixed words, never job, source
// or scope ids and never message content.
import { turnTraceEnabled } from "../turn-trace.ts";

/** A single synchronous step that holds the event loop longer than this is logged. */
export const SLOW_STEP_MS = 50;

type Sink = (line: string) => void;
const defaultSink: Sink = line => console.log(line);

export function traceSlowStep(name: string, ms: number, sink: Sink = defaultSink): void {
  if (ms <= SLOW_STEP_MS || !turnTraceEnabled()) return;
  sink(`[turn-trace] phase=${name} slow=true ms=${Math.round(ms)}`);
}

/** Run one synchronous step of a pass and slow-trace it by its fixed name. */
export function timedStep<T>(name: string, step: () => T, sink: Sink = defaultSink): T {
  if (!turnTraceEnabled()) return step();
  const started = performance.now();
  try { return step(); } finally { traceSlowStep(name, performance.now() - started, sink); }
}

let lastDecade = -2;
export function resetBacklogTrace(): void { lastDecade = -2; }
/** Log the pending backlog once at start, then whenever it crosses a power of ten (either way). */
export function traceBacklog(pending: number, sink: Sink = defaultSink): void {
  if (!turnTraceEnabled()) return;
  const decade = pending > 0 ? Math.floor(Math.log10(pending)) : -1;
  if (decade === lastDecade) return;
  const first = lastDecade === -2;
  lastDecade = decade;
  sink(`[turn-trace] phase=memory.backlog ${first ? "start=true " : ""}pending=${pending}`);
}

/** The pause before the next claim after a cycle that held the loop for `busyMs`.
 * Synchronous work is held to at most 1/(1+FACTOR) = 25% of wall time while a
 * backlog drains: after every cycle the loop is left alone for FACTOR times the
 * time the cycle held it, capped at a minute only so that one
 * absurd reading cannot park the worker for good. A cycle under 2 ms (a normal
 * small backlog) gets no pause, only the return to the event loop. */
export const PACE_FACTOR = 3;
export function memoryTickGapMs(busyMs: number): number {
  return busyMs < 2 ? 0 : Math.min(60_000, Math.ceil(busyMs * PACE_FACTOR));
}
