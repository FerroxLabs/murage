// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The last step of shutdown: every thread that still writes the data directory is gone before the lease is released.
// Another launch may take over the moment the lease is free, so "gone" means the worker's real exit event, never a request to stop.
export interface DataWriterStops {
  /** Closes the server's connection to messages.db (synchronous, idempotent). */
  closeDatabase(): void;
  /** Refuses new engine-history jobs at once, lets the running one finish for a short grace, ends it, and resolves true once its worker has really exited. */
  stopEngineHistory(): Promise<boolean>;
  /** Ends the log checkpointer; true once its thread has really exited. Must run after the database is closed. */
  stopWalMaintenance(): Promise<boolean>;
  /** Joins the search worker and closes its reader before releasing the data lease. */
  stopSearchIndex?(): Promise<boolean>;
  /** Joins receipts checkpoint workers before releasing the installation lease. */
  stopLedgerCheckpoints?(): Promise<boolean>;
  /** Ends every worker thread that holds a connection of its own to messages.db (index builds, identity recompute, space hand-back, deferred inbox fill); true once they exited. */
  stopIndexBuilds?(): Promise<boolean>;
}

/** True only when the database is closed AND the engine-history worker, the checkpointer AND the index builds have really exited. False keeps
 * the lease (the next start recovers the stale record). */
export async function stopDataWriters(steps: DataWriterStops): Promise<boolean> {
  const engines = steps.stopEngineHistory(); // admission closes in this call, before anything else here
  // index builds and the other file-name workers end BEFORE the connection closes: one that commits between the close and its own end changes the file
  // after the close, the state the handover (a restore swap, an upgrade) must never meet. The join after the close below catches one started meanwhile.
  const earlyGone = (await steps.stopIndexBuilds?.()) ?? true; // false: a worker was alive at the close, so the lease is kept whatever the second join says
  steps.closeDatabase();                     // the server connection closes before the checkpointer's
  const [enginesGone, checkpointerGone, searchGone, ledgerGone, buildsGone] = await Promise.all([engines, steps.stopWalMaintenance(), steps.stopSearchIndex?.() ?? true, steps.stopLedgerCheckpoints?.() ?? true, steps.stopIndexBuilds?.() ?? true]);
  return earlyGone && enginesGone && checkpointerGone && searchGone && ledgerGone && buildsGone;
}

/** Stops the data writers once, on whichever shutdown path gets there first. A stop that arrives before the writers ever started
 * has nothing to wait for (every stop resolves true at once), so the lease can be released; a stop that finds writers running
 * keeps the order: stop them, then release. A failed attempt (a stalled writer) may be retried and still keeps the lease. */
export function createDataWriterGate(stop: () => Promise<boolean>, onStopped: () => void): { stop(): Promise<boolean>; readonly stopped: boolean } {
  let stopped = false;
  let inFlight: Promise<boolean> | undefined;
  return {
    get stopped() { return stopped; },
    stop() {
      if (stopped) return Promise.resolve(true);
      inFlight ??= stop().then(
        (ok) => { if (ok) { stopped = true; onStopped(); } return ok; },
        () => false,
      ).finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
