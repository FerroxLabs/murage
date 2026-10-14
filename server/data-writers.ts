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
}

/** True only when the database is closed AND the engine-history worker AND the checkpointer have really exited. False keeps
 * the lease (the next start recovers the stale record). */
export async function stopDataWriters(steps: DataWriterStops): Promise<boolean> {
  const engines = steps.stopEngineHistory(); // admission closes in this call, before anything else here
  steps.closeDatabase();                     // the server connection closes before the checkpointer's
  const [enginesGone, checkpointerGone] = await Promise.all([engines, steps.stopWalMaintenance()]);
  return enginesGone && checkpointerGone;
}
