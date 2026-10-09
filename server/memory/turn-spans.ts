// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a turn's time goes between memory.assemble and dispatch.send (PROPOSAL-v2 section 11,
// lines 1 and 2). The opt-in turn trace names a few phases; the remainder of the EVIDENCE
// section 7 gap (0.55 s idle, 1.5 s while indexing) was never attributed. These spans are always on and cost
// two clock reads each. One line per turn, always when the memory part took over 500 ms and for one
// turn in fifty otherwise. Milliseconds and fixed words only.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { observeLine } from "../observe.ts";

export const SLOW_TURN_LINE_MS = 500;
export const TURN_LINE_SAMPLE = 50;
let turns = 0;
/** Test hook: restart the one-in-fifty count. */
export function resetTurnLineCount(): void { turns = 0; }

/** Span names that make up "assert" and "recall" in the summary line; every other name counts toward `named` only. */
const ASSERT = ["assert.dispatch", "assert.images", "receipt.prepare"];
const REPLAY = ["replay.filter"];
export type RecallMode = "lexical" | "hybrid" | "skipped";

export interface TurnLineFacts {
  route?: "flux" | "native";
  engine?: string;
  resumed?: boolean;
  recallMode?: RecallMode;
  /** Why recall was skipped, when it was. */
  skippedReason?: string;
}

const lagMonitor = (() => { try { const m = monitorEventLoopDelay({ resolution: 10 }); m.enable(); return m; } catch { return undefined; } })();
const round = (value: number) => Math.round(value);

export class PreDispatchTimer {
  private readonly started = performance.now();
  private readonly totals = new Map<string, number>();
  private finished = false;
  private readonly emit: (line: string) => void;
  constructor(emit: (line: string) => void = observeLine) { this.emit = emit; lagMonitor?.reset(); }
  /** Start a span; call the returned function to end it (more than one span of a name adds up). */
  span(name: string): () => void {
    const at = performance.now();
    return () => { this.totals.set(name, (this.totals.get(name) ?? 0) + (performance.now() - at)); };
  }
  sync<T>(name: string, run: () => T): T { const end = this.span(name); try { return run(); } finally { end(); } }
  async async<T>(name: string, run: () => Promise<T>): Promise<T> { const end = this.span(name); try { return await run(); } finally { end(); } }
  ms(name: string): number { return this.totals.get(name) ?? 0; }
  /** Milliseconds since the timer started. */
  elapsed(): number { return performance.now() - this.started; }
  /** Sum of all named spans. Spans may nest only if the caller names them apart; overlapping names double count. */
  named(): number { let sum = 0; for (const value of this.totals.values()) sum += value; return sum; }
  summary(facts: TurnLineFacts = {}): Record<string, number | string> {
    const pre = this.elapsed();
    const sum = (names: string[]) => names.reduce((total, name) => total + this.ms(name), 0);
    const recallMode = facts.recallMode ?? "lexical";
    return {
      route: facts.route ?? "native", engine: facts.engine ?? "unknown", resumed: String(Boolean(facts.resumed)),
      pre: round(pre), recall: round(this.ms("recall")), recallMode: recallMode === "skipped" ? `skipped:${facts.skippedReason ?? "budget"}` : recallMode,
      assert: round(sum(ASSERT)), replayFilter: round(sum(REPLAY)), other: round(Math.max(0, pre - this.named())),
      loopP99: round((lagMonitor?.percentile(99) ?? 0) / 1e6),
    };
  }
  /** Emit the summary line (once). Returns whether a line was written. */
  finish(facts: TurnLineFacts = {}, now = performance.now()): boolean {
    if (this.finished) return false;
    this.finished = true;
    turns++;
    const summary = this.summary(facts);
    if (Number(summary.pre) <= SLOW_TURN_LINE_MS && turns % TURN_LINE_SAMPLE !== 0) return false;
    void now;
    const extra = [...this.totals].filter(([name]) => !["recall", ...ASSERT, ...REPLAY].includes(name)).map(([name, value]) => `${name}=${round(value)}`).join(" ");
    this.emit(`[memory] turn ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(" ")}${extra ? ` ${extra}` : ""}`);
    return true;
  }
}
