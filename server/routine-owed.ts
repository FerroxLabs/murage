// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owed routine results (owner of this side: routines; the other side, the writer gate, is database.ts / wal-maintenance.ts).
// A settled run's result card is written by deliverRoutineRun; a write the database refuses (the log is far ahead of its copy, a
// busy gate) never drops it: the run stays owed and is tried again, not every minute for every run. A refusal pauses every route to
// a write (every run meets the same gate) with a growing wait; the minute pass alone still sends one probe a pass, so the card lands
// at the first pass after the gate opens and never waits out the pause (a refusal is an admission check or a 1 s busy wait). The owner
// sees "waiting for the database" on the run, and the log carries one line a minute with the count.
import { rateLimited } from "./observe.ts";
import { isDatabaseBusy } from "./database.ts";
import type { RoutineRun } from "./routines.ts";

/** The pass and the first wait are a minute. MURAGE_TEST_ROUTINE_OWED_MS is a test seam only (the booted witness of the landing after the
 * gate opens, routine-owed-landing-http.test.ts, sets it so the real minute pass runs within seconds); production never sets it. */
export const OWED_PASS_MS = Number(process.env.MURAGE_TEST_ROUTINE_OWED_MS) || 60_000;
export const OWED_FIRST_WAIT_MS = OWED_PASS_MS;
export const OWED_MAX_WAIT_MS = 8 * OWED_PASS_MS;

export interface OwedDeps {
  now(): number;
  runById(runId: string): RoutineRun | undefined;
  isOpen(run: RoutineRun): boolean;
  /** a saved output of this run still being finished: wait for it (not a failure) */
  publicationUnsettled(run: RoutineRun): boolean;
  /** throws on any refusal; a busy refusal is retried with backoff, any other is retried at the next pass */
  deliver(run: RoutineRun): void;
  markDelivered(runId: string): void;
  /** the owner-visible note that the result waits for the database (it leaves with markDelivered's own save) */
  setWaiting(runId: string): void;
  /** secrets out of a refusal's text before it is logged */
  redact(text: string): string;
}

/** `owed` is the caller's set of run ids still owed a result (index.ts adds a start-up's pending runs and every settled run to it). */
export function createOwedDeliveries(deps: OwedDeps, owed: Set<string>) {
  /** Consecutive refusals: the gate is the same for every run, so one refusal pauses every route and the wait doubles
   * (the minute pass alone still probes once a pass). */
  let streak = 0, pausedUntil = 0;
  const fault = (error: unknown, busyCount: number) => {
    const text = deps.redact(error instanceof Error ? error.message : String(error));
    rateLimited("routine-result-write", 60_000, (suppressed) => busyCount
      ? `[routines] ${busyCount} run result${busyCount === 1 ? "" : "s"} waiting for the database${suppressed ? ` (${suppressed} more refusals since the last line)` : ""}: ${text.slice(0, 200)}`
      : `[routines] a run's result could not be written yet${suppressed ? ` (${suppressed} more since the last line)` : ""}: ${text.slice(0, 200)}`, deps.now());
  };
  function forget(runId: string): void {
    owed.delete(runId);
  }
  /** One write of one owed result. Returns "busy" when the gate refused it (the caller stops its pass). A probe tries the gate during
   * the pause; its write clears the pause. */
  function finish(runId: string, probe = false): "done" | "waiting" | "busy" {
    const run = deps.runById(runId);
    if (!run || run.delivery?.state !== "pending" || deps.isOpen(run)) { forget(runId); return "done"; }
    try {
      // a publication's wake and a run that just settled wait out the gate's pause; the minute pass's probe tries the gate
      if (!probe && deps.now() < pausedUntil) return "busy";
      if (deps.publicationUnsettled(run)) return "waiting";
      deps.deliver(run);
      deps.markDelivered(runId);
      forget(runId);
      streak = 0; pausedUntil = 0;
      return "done";
    } catch (error) {
      if (!isDatabaseBusy(error)) { fault(error, 0); return "waiting"; }
      pausedUntil = deps.now() + Math.min(OWED_MAX_WAIT_MS, OWED_FIRST_WAIT_MS * 2 ** Math.min(streak++, 8));
      fault(error, owed.size);
      // every owed result tells its owner it waits (once each: a run already noted is not written again)
      for (const id of owed) { try { deps.setWaiting(id); } catch { /* the note is a courtesy: the run stays owed */ } }
      return "busy";
    }
  }
  return {
    finish: (runId: string) => finish(runId),
    /** The minute pass: while paused, owed results probe the gate one at a time until one is written (the pause ends and the rest
     * follow in this pass) or refused (the pass stops); a result still waiting for its publication passes the probe on. */
    retry(queued: (runId: string) => boolean): void {
      let probing = true;
      for (const runId of [...owed]) {
        if (queued(runId)) continue;
        const paused = deps.now() < pausedUntil;
        if (paused && !probing) break;
        try { if (finish(runId, paused) === "busy") probing = false; } catch (error) { fault(error, 0); }
      }
    },
    owedCount: () => owed.size,
  };
}
