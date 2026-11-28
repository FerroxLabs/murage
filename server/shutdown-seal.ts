// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner: fix/1022-schema-shutdown. The one place that knows the server's shutdown close of messages.db happened (database.ts closeDatabaseForShutdown
// sets it; no import here, so memory/ and inbox code can ask without a cycle). Every path that opens messages.db WITHOUT database() (a worker thread
// handed the file name: index builds, identity recompute, space hand-back, the deferred inbox fill) asks sealedForShutdown() first and does nothing
// once it is true: the handover (a restore swap, an upgrade) owns the file from the close on.
import type { Worker } from "node:worker_threads";
let sealed = false;
/** The worker threads alive now that hold a connection of their own to messages.db (started by name, not through database()). */
const fileWorkers = new Set<Worker>();
/** A site that starts such a worker registers it here, so shutdown can end and join it before the file is handed over. */
export function trackFileWorker(worker: Worker): void { fileWorkers.add(worker); worker.once("exit", () => { fileWorkers.delete(worker); }); }
/** Shutdown (a step of stopDataWriters): ends every tracked worker and resolves true once each thread has really exited, false after `grace` ms
 * (a thread inside one native SQLite statement cannot be interrupted until it returns: the caller keeps the lease rather than hand the file over
 * with a writer alive). An index build or a VACUUM ended before it commits leaves the file as it was; the next start does it again. */
export async function stopFileWorkers(grace = 3000): Promise<boolean> {
  const ends = [...fileWorkers].map(worker => worker.terminate().then(() => true, () => false));
  if (!ends.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), grace); });
  try { return await Promise.race([Promise.all(ends).then(all => all.every(Boolean)), late]); } finally { clearTimeout(timer); }
}

/** What a timer that wakes after the shutdown close meets (instead of a fresh open that validates a file mid-handover). */
export class DatabaseShutdownError extends Error {
  readonly code = "DATABASE_SHUTDOWN";
  constructor() { super("DATABASE_SHUTDOWN"); }
}
/** True once shutdown closed the connection; background timers and worker starts check it and do nothing. */
export function sealedForShutdown(): boolean { return sealed; }
export function sealForShutdown(): void { sealed = true; }
