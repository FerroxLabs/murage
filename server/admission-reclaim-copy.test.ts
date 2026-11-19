// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: admission rule 5 and its main-thread side (IoBudget.requestReclaimCopy/chargeReclaimBucket, recall-view nudge): the recallcap racer;
// the checkpointer's copy loop that calls beginCopy/endCopy: wal-maintenance (unchanged).
// Fable BLOCK bb30fb1d03: the strict idle rule (about 1 MiB a minute while idle) refused every log copy while the start-up worker wrote GBs, so a
// log the recall reclaimer filled to its gate reset only around owner turns. A copy the reclaimer asked for in this minute is admitted under the
// reclaimer's own 700 MB/min bucket, and only there. The ledger is evaluated from its source text exactly as the checkpointer worker does, on the
// real buffer the server hands that worker.
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import { ioBudget, RECALL_RECLAIM_BYTES_PER_MINUTE } from "./io-budget.ts";

const MINUTE = 60_000, MiB = 1024 * 1024, LOG = 480 * MiB;
type Ledger = ReturnType<typeof checkpointLedger>;
/** The worker's view of the server's ledger (wal-maintenance: eval of admissionSource on workerData.admission), idle, during a 5 GB/min storm. */
let minutes = 0;
function stormyWorkerLedger(second = 10): { worker: Ledger; now: number } {
  const buffer = ioBudget.checkpointAdmissionBuffer();
  const worker = (0, eval)("(" + checkpointLedger.toString() + ")")(buffer, 7, 2000, { gen: 1 }) as Ledger;
  minutes += 2; // each call a fresh minute ahead of every earlier one (R3 also uses the minute after): rotation zeroes the per-minute slots
  const now = (Math.floor(Date.now() / MINUTE) + minutes) * MINUTE + second * 1000;
  worker.lock();
  try {
    worker.rotate(now);
    Atomics.store(worker.slots, 7, 1n); // the owner's verdict: idle
    Atomics.store(worker.slots, 11, 5000n * 1000n * 1000n); Atomics.store(worker.slots, 3, 5000n * 1000n * 1000n);
  } finally { worker.unlock(); }
  return { worker, now };
}
const release = (worker: Ledger, ticket: ReturnType<Ledger["beginCopy"]>, now: number, used = 0) => { if (ticket) worker.endCopy(ticket, used, 0, undefined, now); };

it("R1 the bucket is the reclaimer's own RECALL_RECLAIM_BYTES_PER_MINUTE: a copy of exactly that is admitted, one byte more is not", () => {
  expect(RECALL_RECLAIM_BYTES_PER_MINUTE).toBe(700_000_000);
  const over = stormyWorkerLedger();
  ioBudget.requestReclaimCopy(over.now);
  expect(over.worker.beginCopy(RECALL_RECLAIM_BYTES_PER_MINUTE + 1, over.now)).toBeNull();
  const at = stormyWorkerLedger(20);
  ioBudget.requestReclaimCopy(at.now);
  const ticket = at.worker.beginCopy(RECALL_RECLAIM_BYTES_PER_MINUTE, at.now);
  expect(ticket).not.toBeNull();
  release(at.worker, ticket, at.now, RECALL_RECLAIM_BYTES_PER_MINUTE);
});

it("R2 idle under a write storm: the reclaimer's requested log copy is admitted under its bucket; unrequested copies stay refused", () => {
  const { worker, now } = stormyWorkerLedger();
  expect(worker.beginCopy(LOG, now), "no request: the strict idle rule refuses").toBeNull();
  ioBudget.requestReclaimCopy(now);
  const ticket = worker.beginCopy(LOG, now);
  expect(ticket, "requested by the reclaimer held at the gate: admitted").not.toBeNull();
  expect(worker.beginCopy(10 * MiB, now), "one copy per request, even one the bucket still has room for").toBeNull();
  release(worker, ticket, now, LOG);
  expect(Number(worker.slots[30]), "the copy is charged to the reclaimer's bucket").toBe(LOG);
});

it("R3 never past the bucket: slices' charges count, a copy that would overrun waits for the next minute", () => {
  const { worker, now } = stormyWorkerLedger();
  ioBudget.chargeReclaimBucket(300_000_000, now);
  ioBudget.requestReclaimCopy(now);
  expect(worker.beginCopy(LOG, now), "300 MB of slices + a 480 MiB copy > 700 MB").toBeNull();
  const small = worker.beginCopy(200 * MiB, now);
  expect(small, "what is left of the bucket still admits a smaller copy").not.toBeNull();
  release(worker, small, now, 50 * MiB);
  expect(Number(worker.slots[30]), "the unused part of the ceiling goes back to the bucket").toBe(300_000_000 + 50 * MiB);
  // The next minute rotates the bucket; a request made last minute does not carry over.
  const next = now + MINUTE;
  ioBudget.requestReclaimCopy(now);
  worker.lock(); try { worker.rotate(next); Atomics.store(worker.slots, 7, 1n); Atomics.store(worker.slots, 3, 5000n * 1000n * 1000n); } finally { worker.unlock(); }
  expect(worker.beginCopy(LOG, next), "a stale request is not admitted").toBeNull();
  ioBudget.requestReclaimCopy(next);
  const fresh = worker.beginCopy(LOG, next);
  expect(fresh, "a fresh minute and a fresh request").not.toBeNull();
  release(worker, fresh, next, LOG);
});

it("R4 a poisoned ledger admits nothing, the reclaimer's copy included", () => {
  const { worker, now } = stormyWorkerLedger();
  ioBudget.requestReclaimCopy(now);
  Atomics.store(worker.slots, 15, 1n);
  try { expect(worker.beginCopy(LOG, now)).toBeNull(); } finally { Atomics.store(worker.slots, 15, 0n); }
});
