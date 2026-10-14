// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The recovery scheduler: the bounded repair work that must happen whatever the memory mode is. A skill or routine change a failed commit left half done
// (its outbox pointer) is settled here, and the proofs of the large root sets turns have asked for are built in slices (in memory only: replay-lineage.ts). It starts as soon as the procedure host
// exists and runs one pass at boot, then every minute and on the first tick after the computer woke; it never waits for idle learning, which does not run
// while memory is paused or off.
//
// A pass is bounded three ways: at most OUTBOX_ROWS pointers, PROOF_MEMBERS root-set members (the members of sets nested under them included) and
// RECOVERY_SLICE_MS of proof work. The pointer range is walked with a wrapping cursor, so a pointer that cannot settle yet never starves the ones
// behind it. The owner goes first: no pass runs while an owner turn is waiting or running, or while the I/O budget asks this work to wait; the pass
// is tried again on the next tick.
import type { DatabaseSync } from "node:sqlite";

export const RECOVERY_INTERVAL_MS = 60_000;
export const RECOVERY_OUTBOX_ROWS = 20;
export const RECOVERY_PROOF_MEMBERS = 4_000;
/** The longest one pass judges proofs before it hands the loop back. */
export const RECOVERY_SLICE_MS = 50;

export interface RecoveryPass { settled: number; examined: number; pending: number; members: number; proofsPending: number; ran: boolean; upkept?: boolean }
export interface RecoverySchedulerOptions {
  db: () => DatabaseSync;
  /** One bounded pass over the outbox from `after` (procedure-landing.ts reconcileOutstandingChangesPass). */
  outbox: (db: DatabaseSync, after: string | null, limit: number) => { settled: number; examined: number; pending: number; next: string | null };
  /** Builds the proofs of large root sets turns asked for, at most `budget` members (replay-lineage.ts advanceRootSetProofs). */
  proofs?: (budget: number, sliceMs: number) => { members: number; pending: number };
  /** One-time upkeep that is not needed to listen (an index the start used to wait for): run on a pass that does nothing else, once, and again on a
   * later pass if it threw. */
  upkeep?: () => void;
  /** True while a backup or restore holds the file: the pass waits for the next tick. */
  held?: () => boolean;
  /** True while an owner turn is waiting or running: the pass waits for the next tick (the owner goes first). */
  busy?: () => boolean;
  /** True while the I/O budget asks background work to wait (io-budget.ts shouldDefer): the pass waits for the next tick. */
  defer?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}
export interface RecoveryScheduler { runNow(): RecoveryPass; wake(): RecoveryPass; stop(): void; cursor(): string | null }

export function startRecoveryScheduler(options: RecoverySchedulerOptions): RecoveryScheduler {
  const interval = options.intervalMs ?? RECOVERY_INTERVAL_MS;
  let after: string | null = null, running = false, upkept = false, followUp: ReturnType<typeof setTimeout> | null = null;
  const idle: RecoveryPass = { settled: 0, examined: 0, pending: 0, members: 0, proofsPending: 0, ran: false };
  const pass = (): RecoveryPass => {
    if (running || options.held?.() || options.busy?.() || options.defer?.()) return idle;
    running = true;
    const out: RecoveryPass = { ...idle, ran: true };
    // the upkeep is one statement that cannot be cut into slices (an index build): it gets a pass of its own, with nothing else run in it
    if (options.upkeep && !upkept) {
      try { options.upkeep(); upkept = true; out.upkept = true; } catch (error) { options.onError?.(error); }
      running = false;
      // the rest of the pass follows once the loop has been handed back
      followUp = setTimeout(() => { followUp = null; pass(); }, 0); followUp.unref?.();
      return out;
    }
    try {
      const outbox = options.outbox(options.db(), after, RECOVERY_OUTBOX_ROWS);
      after = outbox.next;
      out.settled = outbox.settled; out.examined = outbox.examined; out.pending = outbox.pending;
    } catch (error) { options.onError?.(error); }
    try {
      // the outbox may have used the owner's turn to arrive: checked again before the proof slice
      if (options.proofs && !options.busy?.()) { const proofs = options.proofs(RECOVERY_PROOF_MEMBERS, RECOVERY_SLICE_MS); out.members = proofs.members; out.proofsPending = proofs.pending; }
    } catch (error) { options.onError?.(error); }
    finally { running = false; }
    return out;
  };
  const timer = setInterval(() => {
    // a gap much longer than the interval is the computer waking: the pass below is the wake pass
    pass();
  }, interval);
  timer.unref?.();
  return { runNow: pass, wake: pass, stop: () => { clearInterval(timer); if (followUp) clearTimeout(followUp); }, cursor: () => after };
}
