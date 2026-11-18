// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only checkpointer barrier. The server build excludes server/testing, and wal-maintenance.ts only reads walWorkerSeam, so a production
// worker has no way to park. A parked pass is bounded: it releases itself after the deadline and counts that in expired().
import { walWorkerSeam } from "../wal-maintenance.ts";

export const PARK_DEADLINE_MS = 20_000;
// Int32 slots (8: the info the parked site reported): 0 armed site, 1 parked site, 2 release flag, 3 deadline expiries, 4 deadline in ms, 5 gate held, 6 start pause on, 7 answer hold in ms.

/** Runs inside the worker (sent as source, like the admission ledger). Every test-controlled pause or spin of the checkpointer lives here, nowhere in
 *  production source: park (before beginCopy / endCopy), beforeRunning (holdStart), gateHeld/awaitGate (holdGate), takeHold/hold (holdMs). */
function makeHooks(buffer: SharedArrayBuffer, shared: Int32Array) {
  const f = new Int32Array(buffer);
  return {
    park(site: number, info = 0) {
      if (Atomics.load(f, 0) !== site) return;
      Atomics.store(f, 8, info); Atomics.store(f, 1, site);
      const until = Date.now() + Atomics.load(f, 4);
      while (!Atomics.load(f, 2) && !Atomics.load(shared, 7)) {
        if (Date.now() >= until) { Atomics.add(f, 3, 1); break; }
      }
      Atomics.store(f, 0, 0); Atomics.store(f, 1, 0);
    },
    beforeRunning() { const stop = Date.now() + 2000; while (Atomics.load(f, 6) && Date.now() < stop) { /* bounded */ } },
    gateHeld: () => Boolean(Atomics.load(f, 5)),
    awaitGate(ms: number) { const end = Date.now() + ms; while (Atomics.load(f, 5) && !Atomics.load(shared, 7) && Date.now() < end) { /* bounded */ } },
    takeHold: () => Atomics.load(f, 7),
    hold(ms: number) { if (!ms) return; const end = Date.now() + ms; while (Date.now() < end) { /* bounded */ } },
  };
}
export const barrierSource = () => makeHooks.toString();

export function createWalBarrier(deadlineMs = PARK_DEADLINE_MS) {
  const buffer = new SharedArrayBuffer(16 * Int32Array.BYTES_PER_ELEMENT), f = new Int32Array(buffer);
  Atomics.store(f, 4, deadlineMs);
  return {
    buffer,
    /** The next pass of every worker created from now parks just before the named admission call. */
    arm(site: 1 | 2 | 3 | 4 | 5) { Atomics.store(f, 2, 0); Atomics.store(f, 1, 0); Atomics.store(f, 0, site); },
    parkedAt: () => Atomics.load(f, 1),
    /** The value the worker passed to the park it is sitting in (site 3: the poll tick number). */
    parkInfo: () => Atomics.load(f, 8),
    /** Clears an armed site that never parked. */
    disarm() { Atomics.store(f, 0, 0); },
    /** The checkpointer holds a finished pass (no answer, no next pass) while on. */
    holdGate(on: boolean) { Atomics.store(f, 5, Number(on)); },
    /** The checkpointer waits (at most 2 s) just before it marks a pass running while on. */
    holdStart(on: boolean) { Atomics.store(f, 6, Number(on)); },
    /** How long the checkpointer sits on each PASSIVE answer (read when the request reaches it). */
    setHoldMs(ms: number) { Atomics.store(f, 7, ms); },
    release() { Atomics.store(f, 2, 1); },
    /** How many parks ended by their deadline instead of a release. */
    expired: () => Atomics.load(f, 3),
  };
}
/** Installs a barrier for every checkpointer this process starts afterwards. */
export function installWalBarrier(deadlineMs = PARK_DEADLINE_MS) {
  const barrier = createWalBarrier(deadlineMs);
  walWorkerSeam.barrier = { source: barrierSource(), buffer: barrier.buffer };
  return barrier;
}
