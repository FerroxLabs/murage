// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The recovery scheduler: the bounded repair work that must happen whatever the memory mode is. A skill or routine change a failed commit left half done
// (its outbox pointer) is settled here, and the proofs of the large root sets turns have asked for are built in slices (in memory only: replay-lineage.ts). It starts as soon as the procedure host
// exists and runs one pass at boot, then every minute and on the first tick after the computer woke; it never waits for idle learning, which does not run
// while memory is paused or off.
//
// A pass is bounded two ways: at most OUTBOX_ROWS pointers and PROOF_MEMBERS root-set members. The pointer range is walked with a wrapping cursor, so a
// pointer that cannot settle yet never starves the ones behind it.
import type { DatabaseSync } from "node:sqlite";

export const RECOVERY_INTERVAL_MS = 60_000;
export const RECOVERY_OUTBOX_ROWS = 20;
export const RECOVERY_PROOF_MEMBERS = 4_000;

export interface RecoveryPass { settled: number; examined: number; pending: number; members: number; proofsPending: number; ran: boolean }
export interface RecoverySchedulerOptions {
  db: () => DatabaseSync;
  /** One bounded pass over the outbox from `after` (procedure-landing.ts reconcileOutstandingChangesPass). */
  outbox: (db: DatabaseSync, after: string | null, limit: number) => { settled: number; examined: number; pending: number; next: string | null };
  /** Builds the proofs of large root sets turns asked for, at most `budget` members (replay-lineage.ts advanceRootSetProofs). */
  proofs?: (budget: number) => { members: number; pending: number };
  /** One-time cheap upkeep that is not needed to listen (an index the start used to wait for): run on the first pass only, and again on a later pass if it threw. */
  upkeep?: () => void;
  /** True while a backup or restore holds the file: the pass waits for the next tick. */
  held?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}
export interface RecoveryScheduler { runNow(): RecoveryPass; wake(): RecoveryPass; stop(): void; cursor(): string | null }

export function startRecoveryScheduler(options: RecoverySchedulerOptions): RecoveryScheduler {
  const interval = options.intervalMs ?? RECOVERY_INTERVAL_MS;
  let after: string | null = null, running = false, upkept = false;
  const idle: RecoveryPass = { settled: 0, examined: 0, pending: 0, members: 0, proofsPending: 0, ran: false };
  const pass = (): RecoveryPass => {
    if (running || options.held?.()) return idle;
    running = true;
    const out: RecoveryPass = { ...idle, ran: true };
    try { if (options.upkeep && !upkept) { options.upkeep(); upkept = true; } } catch (error) { options.onError?.(error); }
    try {
      const outbox = options.outbox(options.db(), after, RECOVERY_OUTBOX_ROWS);
      after = outbox.next;
      out.settled = outbox.settled; out.examined = outbox.examined; out.pending = outbox.pending;
    } catch (error) { options.onError?.(error); }
    try {
      if (options.proofs) { const proofs = options.proofs(RECOVERY_PROOF_MEMBERS); out.members = proofs.members; out.proofsPending = proofs.pending; }
    } catch (error) { options.onError?.(error); }
    finally { running = false; }
    return out;
  };
  const timer = setInterval(() => {
    // a gap much longer than the interval is the computer waking: the pass below is the wake pass
    pass();
  }, interval);
  timer.unref?.();
  return { runNow: pass, wake: pass, stop: () => clearInterval(timer), cursor: () => after };
}
