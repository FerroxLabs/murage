// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Some migration statements cannot be cut into slices (a DROP INDEX over a multi-GB table, the commit of one large transaction),
// and while one runs the server thread is blocked: it cannot rewrite the start-up note, and the desktop shell treats a note that
// stops moving as a stalled start. A heartbeat thread keeps the note moving instead. It is a worker thread of THIS process, so it
// lives exactly as long as the server does: a server that dies stops the heartbeat, and the note goes stale at once. It writes the
// same note the reporter writes (plus the step and how long it has been going) every `intervalMs`, and `end()` waits for the writer's acknowledgement (its last write finished) and guarantees no
// write lands after it returns, so a later note (or the removal of the note when the upgrade is done) is never overwritten.
import { Worker } from "node:worker_threads";

/** The steps of the memory upgrade that may block the server thread; a closed set, shown nowhere but the note. */
export const BLOCKING_STEPS = ["tables", "indexes", "backfill", "validating", "committing"] as const;
export type BlockingStep = (typeof BLOCKING_STEPS)[number];
export interface BlockingHeartbeat { step(step: BlockingStep): void; end(): void }
export const HEARTBEAT_INTERVAL_MS = 30_000;

const LABEL_BYTES = 32;
// layout of the shared block: Int32 [writing, stopped, labelLength, spare], Float64 [stepStartedAt], then the label bytes
const WORKER_SOURCE = `
const { workerData, threadId } = require("node:worker_threads");
const fs = require("node:fs");
const ctl = new Int32Array(workerData.shared, 0, 4), at = new Float64Array(workerData.shared, 16, 1), label = new Uint8Array(workerData.shared, 24, ${LABEL_BYTES});
const began = Date.now(), temp = workerData.file + "." + (process.pid * 1000 + threadId) + ".tmp";
const beat = () => {
  if (Atomics.load(ctl, 1)) return;
  Atomics.store(ctl, 0, 1);
  try {
    if (Atomics.load(ctl, 1)) return;
    const now = Date.now(), step = Buffer.from(label.slice(0, Atomics.load(ctl, 2))).toString("utf8");
    fs.writeFileSync(temp, JSON.stringify({ ...workerData.base, updatedAt: now, step, stepElapsedMs: now - (at[0] || began) }), { mode: 0o600 });
    if (workerData.renameDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.renameDelayMs);
    fs.renameSync(temp, workerData.file);
  } catch { try { fs.rmSync(temp, { force: true }); } catch {} }
  finally { Atomics.store(ctl, 0, 0); Atomics.notify(ctl, 0); }
};
beat();
setInterval(beat, workerData.intervalMs);
`;

/** Starts the heartbeat for a blocking stretch of the upgrade. `base` is the note the reporter would write (its `updatedAt` is
 * replaced on every beat). Never throws: a heartbeat that cannot start leaves the upgrade exactly as it was. */
export function startBlockingHeartbeat(file: string, base: Record<string, unknown>, first: BlockingStep, intervalMs = HEARTBEAT_INTERVAL_MS, renameDelayMs = 0): BlockingHeartbeat {
  const shared = new SharedArrayBuffer(24 + LABEL_BYTES), ctl = new Int32Array(shared, 0, 4), at = new Float64Array(shared, 16, 1), label = new Uint8Array(shared, 24, LABEL_BYTES);
  const set = (step: BlockingStep) => {
    const bytes = Buffer.from(step, "utf8").subarray(0, LABEL_BYTES);
    label.set(bytes); at[0] = Date.now(); Atomics.store(ctl, 2, bytes.length);
  };
  set(first);
  let worker: Worker | null = null;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { shared, file, base, intervalMs, renameDelayMs } });
    worker.on("error", () => { /* a heartbeat failure never stops the upgrade */ });
    worker.unref();
  } catch { worker = null; }
  return {
    step: set,
    end() {
      Atomics.store(ctl, 1, 1);
      // The writer acknowledges by clearing its "writing" flag after its last rename has completed; it checks the stop flag after
      // taking that flag, so once the flag is seen clear no beat is writing and none will ever start. There is no give-up: a note
      // written after end() returns could overwrite the next state, and the writer only ever holds the flag for one small write.
      while (Atomics.load(ctl, 0) === 1) Atomics.wait(ctl, 0, 1, 50);
      try { void worker?.terminate(); } catch { /* already gone */ }
      worker = null;
    },
  };
}
