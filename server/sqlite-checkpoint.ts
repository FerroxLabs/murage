// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { rateLimited } from "./observe.ts";

/** Checkpoint budget for a secondary connection: TRUNCATE holds the writer lock while it waits for readers, so
 * the wait is capped and a blocked checkpoint is logged, not waited out (PROPOSAL-v2 10.3). */
export const CHECKPOINT_BUSY_MS = 50;

/** `PRAGMA wal_checkpoint(TRUNCATE)` with at most CHECKPOINT_BUSY_MS of lock wait. Returns true when the log was
 * fully checkpointed and truncated; false when a reader or writer blocked it (the next checkpoint takes it). */
export function checkpointTruncate(db: DatabaseSync, op = "checkpoint", restoreBusyMs = 5000): boolean {
  let blocked = false;
  try {
    db.exec(`PRAGMA busy_timeout=${CHECKPOINT_BUSY_MS}`);
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
    blocked = Number(row?.busy ?? 0) !== 0;
  } catch { blocked = true; }
  finally { try { db.exec(`PRAGMA busy_timeout=${restoreBusyMs}`); } catch { /* closed */ } }
  if (blocked) rateLimited(`sqlite-checkpoint:${op}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${CHECKPOINT_BUSY_MS} holder=reader${suppressed ? ` more=${suppressed}` : ""}`);
  return !blocked;
}

const fileCheckpoints = new Set<Promise<boolean>>();
const fileCloses = new Set<Promise<void>>();
let fileCheckpointsStopped = false;

export function fileCheckpointAdmissionOpen(): boolean { return !fileCheckpointsStopped; }

/** A last-close owner includes worker startup failures and subsequent pins in the installation-lease join. */
export function trackFileClose(close: Promise<void>): Promise<void> {
  fileCloses.add(close);
  void close.then(() => fileCloses.delete(close), () => fileCloses.delete(close));
  return close;
}

/** A secondary file's privacy fold runs entirely off-thread; failure leaves it owed to the next sweep. Resolves only after the connection exits. */
export function checkpointFile(file: string, options: { gate?: Int32Array; beforeFold?: () => boolean | void } = {}): Promise<boolean> {
  if (fileCheckpointsStopped && !options.beforeFold) return Promise.resolve(false);
  const work = new Promise<boolean>(resolve => {
    let worker: Worker, folded = false, failed = false;
    const gate = options.gate ?? new Int32Array(new SharedArrayBuffer(12));
    const token = -Atomics.add(gate, 2, 1) - 1;
    try {
      worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(workerData.file);
        const { gate, token } = workerData;
        let folded = false;
        db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
        parentPort.once('message', proceed => {
          try {
            if (!proceed) return;
            const revision = Atomics.load(gate, 1);
            const copied = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
            // Bulk copying never owns the writer gate; only reset an unchanged, fully copied log.
            if (copied.busy || copied.log !== copied.checkpointed || revision !== Atomics.load(gate, 1)) return;
            if (Atomics.compareExchange(gate, 0, 0, token) !== 0) return;
            try {
              if (revision === Atomics.load(gate, 1)) folded = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 0;
            } finally { Atomics.store(gate, 0, 0); Atomics.notify(gate, 0); }
          } finally {
            // Last close may copy a reader's remaining tail; a concurrent open/write must reserve the same gate.
            while (Atomics.compareExchange(gate, 0, 0, token) !== 0) {
              const held = Atomics.load(gate, 0);
              if (held !== 0) Atomics.wait(gate, 0, held);
            }
            try { db.close(); }
            finally { Atomics.store(gate, 0, 0); Atomics.notify(gate, 0); parentPort.postMessage(folded); parentPort.close(); }
          }
        });
        parentPort.postMessage('ready');
      `, { eval: true, workerData: { file, gate, token } });
    } catch { resolve(false); return; }
    worker.on("message", result => {
      if (result === "ready") {
        let proceed = true;
        try { proceed = options.beforeFold?.() !== false; } catch { failed = true; }
        worker.postMessage(!failed && proceed);
      } else folded = result === true;
    });
    worker.on("error", () => { failed = true; });
    worker.on("exit", code => {
      if (Atomics.compareExchange(gate, 0, token, 0) === token) Atomics.notify(gate, 0);
      resolve(code === 0 && folded && !failed);
    });
  });
  fileCheckpoints.add(work);
  void work.then(() => fileCheckpoints.delete(work));
  return work;
}

/** Close admission before joining real exits, so no receipt worker can outlive the installation lease. */
export async function stopFileCheckpoints(): Promise<boolean> {
  fileCheckpointsStopped = true;
  do {
    await Promise.all([...fileCheckpoints, ...fileCloses]);
    // A worker exit can enqueue its owner's last close in a following promise continuation.
    await new Promise<void>(resolve => setImmediate(resolve));
  } while (fileCheckpoints.size || fileCloses.size);
  return true;
}
