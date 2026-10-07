// Per-turn timing trace for the non-voice turn pipeline (lane 0163-turn-trace).
//
// Off unless MURAGE_TURN_TRACE=1. When off, beginTurnTrace/turnTrace return one
// shared no-op object: no clock reads, no allocation, no map writes, no
// logging, so a call site costs one boolean property read.
//
// Timings only. A line carries a short random turn id, the phase name, elapsed
// ms since the turn was received, ms since the previous line, and a few
// numeric / boolean / enum-shaped details. Never text, paths, ids of user data.
import { randomBytes } from "node:crypto";

type Detail = Record<string, number | boolean | string | undefined>;

export interface TurnTrace {
  readonly enabled: boolean;
  /** One line: this phase was reached. */
  mark(phase: string, detail?: Detail): void;
  /** Like mark, but only the first call per phase in this turn logs. */
  once(phase: string, detail?: Detail): void;
  /** Start timing a phase; the returned function logs it with its own duration. */
  span(phase: string, detail?: Detail): (outcome?: string, detail?: Detail) => void;
  /** Time an async step, logging ok/error and its duration; errors are rethrown. */
  time<T>(phase: string, fn: () => Promise<T> | T, detail?: Detail): Promise<T>;
}

const SAFE_WORD = /^[A-Za-z0-9._:/-]{1,40}$/;
const NOOP_SPAN = (): void => {};
const NOOP: TurnTrace = {
  enabled: false,
  mark() {},
  once() {},
  span: () => NOOP_SPAN,
  time: async (_phase, fn) => fn(),
};

export const turnTraceEnabled = (): boolean => process.env.MURAGE_TURN_TRACE === "1";

const active = new Map<string, TurnTrace>();
const MAX_ACTIVE = 256;

function formatDetail(detail: Detail | undefined): string {
  if (!detail) return "";
  let out = "";
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    if (typeof value === "string" && !SAFE_WORD.test(value)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out += ` ${key}=${value}`;
  }
  return out;
}

function create(sink: (line: string) => void, now: () => number): TurnTrace {
  const id = randomBytes(4).toString("hex");
  const start = now();
  let last = start;
  const seen = new Set<string>();
  const log = (phase: string, detail?: Detail): void => {
    const t = now();
    sink(`[turn-trace] id=${id} phase=${phase} at=${Math.round(t - start)}ms since=${Math.round(t - last)}ms${formatDetail(detail)}`);
    last = t;
  };
  const span: TurnTrace["span"] = (phase, detail) => {
    const began = now();
    return (outcome, extra) => log(phase, { ...detail, ...extra, outcome, ms: Math.round(now() - began) });
  };
  return {
    enabled: true,
    mark: log,
    once(phase, detail) {
      if (seen.has(phase)) return;
      seen.add(phase);
      log(phase, detail);
    },
    span,
    async time(phase, fn, detail) {
      const done = span(phase, detail);
      try {
        const value = await fn();
        done("ok");
        return value;
      } catch (error) {
        done("error");
        throw error;
      }
    },
  };
}

/** Start the trace for a turn on `threadId` (replaces any earlier one). */
export function beginTurnTrace(
  threadId: string,
  sink: (line: string) => void = (line) => console.log(line),
  now: () => number = () => performance.now(),
): TurnTrace {
  if (!turnTraceEnabled()) return NOOP;
  const trace = create(sink, now);
  active.delete(threadId);
  active.set(threadId, trace);
  while (active.size > MAX_ACTIVE) active.delete(active.keys().next().value!);
  return trace;
}

/** The thread's current trace, or the shared no-op. */
export function turnTrace(threadId: string): TurnTrace {
  return active.get(threadId) ?? NOOP;
}

/** Log the end of the turn and forget the trace. */
export function endTurnTrace(threadId: string, outcome: string, detail?: Detail): void {
  const trace = active.get(threadId);
  if (!trace) return;
  active.delete(threadId);
  trace.mark("turn.done", { outcome, ...detail });
}

/** The engine-side marks, for every driver at once: all of them reach the turn
 * as RuntimeEvents on the bus. engine.first-token is the first streamed
 * assistant text or tool event, engine.first-text the first assistant text,
 * turn.done the completion with the driver's token counts when it has them.
 * Counts and timings only, never content. */
export function traceEngineEvent(event: {
  type: string; threadId: string; streamKind?: string; itemType?: string; ok?: boolean;
  usage?: { input: number; output: number };
}): void {
  const trace = active.get(event.threadId);
  if (!trace) return;
  const text = (event.type === "content.delta" && event.streamKind === "assistant_text")
    || (event.type === "item.completed" && event.itemType === "assistant_text");
  const tool = (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.itemType === "tool";
  if (text || tool) trace.once("engine.first-token");
  if (text) trace.once("engine.first-text");
  if (event.type === "turn.completed") {
    endTurnTrace(event.threadId, event.ok === false ? "failed" : "ok",
      event.usage ? { tokensIn: event.usage.input, tokensOut: event.usage.output } : undefined);
  }
}
