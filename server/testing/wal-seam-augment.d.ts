// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only types for the seams that the WAL test transform (wal-transform.mjs, SEAM_RESTORE) re-creates in the transformed copy of
// server/wal-maintenance.ts and server/io-budget.ts. Production source declares none of these; server/testing is excluded from the server build.
import type { WalPass, PassiveResult } from "../wal-maintenance.ts";
declare module "../wal-maintenance.ts" {
export function setWalRecoveryKnobsForTest(knobs?: { admissionBytes?: number; stallMs?: number }): void;
/** One poll tick as the worker's scheduler saw it (test hook only). `work` is the scheduler's own committed-work decision (data_version changed, and a new
 * salt or a step of growth since the last pass; a pass deferred by the reset fence shows work=true, started=false); `retry` is its reader-blocked or failed-read retry flag; `now` and `lastAt` are the clocks it compared. `startedAt` is the monotonic epoch time of the latest timed pass's start, before its work. `deferredAt` is the worker's Date.now() when the reset fence first deferred the pass now pending (null when none is): the clock the DUE_MS cap is measured on. */
export interface PaceTick { tick: number; now: number; lastAt: number; work: boolean; changed: boolean; timed: boolean; retry: boolean; started: boolean; startedAt?: number; deferredAt?: number | null; gen: number; committedFrames?: number }
export interface WalMaintenanceHooks {
  /** Test only: when set before the worker starts, receives one record per poll tick. Observe only: it never changes a tick or a decision. */
  paceTrace: ((tick: PaceTick) => void) | null;
  /** Test only: one Int32 cell, read by the worker at the top of each poll tick (before data_version) and echoed in the pace record as `gen`. Set before the worker starts. */
  paceGen: Int32Array | null;
  /** Test only: milliseconds between retries of a scrub that did not finish (default 30 s). */
  retryMs: number;
  /** Test only: the least time between two "checkpointer stopped" lines (default 10 minutes). */
  failureLogGapMs: number;
  /** Test only: the pauses before each restart of a failed checkpointer (default 1 s, 5 s, 30 s, 2 min, then every 5 min for good; an empty list means no restart). */
  restartDelaysMs: number[];
  /** Test only: the next this-many reads of the log header fail as if the system refused them (EMFILE). */
  unreadableReads: number;
  /** Test only: ends the checkpointer thread abruptly. */
  terminate(): void;
  /** Test only: workers created so far, live workers now, and starts refused because the journal limit could not be pinned. */
  spawned(): number;
  liveWorkers(): number;
  pinRefusals(): number;
  /** Test only: fails the current worker as if it had errored; false when there is none (stopped or retired). */
  failActive(): boolean;
  /** Test only: the descriptor number the sync-debt flush uses (-1: none), and how many replaced descriptors still wait for their workers to exit. */
  debtFd(): number;
  debtOrphans(): number;
  /** Test only: re-arms both one-shot log lines. */
  resetLogOnce(): void;
  captureHandler(): (message: unknown) => void;
  /** Test only: the thread id of the current checkpointer (-1: none). */
  workerThreadId(): number;
  heartbeat(): number;
  lastResult(): PassiveResult | null;
}
export const walMaintenanceTestHooks: WalMaintenanceHooks;
export const walWorkerSeam: { barrier: { source: string; buffer: SharedArrayBuffer } | null };
export function onWalPass(listener: (pass: WalPass) => void): () => void;
export function lastRequestedPass(): WalPass | null;
}
declare module "../io-budget.ts" {
  export function setAdmissionClockOffsetForFixture(ms: number): void;
  export function admissionClockOffset(): number;
  interface IoBudget { resetAdmissionForFixture(): void }
}
