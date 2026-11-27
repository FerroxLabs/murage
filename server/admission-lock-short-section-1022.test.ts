// SPDX-License-Identifier: AGPL-3.0-or-later
// q1022 upgrade catch-up (MAIN-RULING UPCATCH-1022: 0 AdmissionLockTimeout). Owner of this file: the q1022 upgrade catch-up lane.
// Owner of the lock rule it guards: scperf-p1 (admission-shared.ts rule 2).
// Field: a healthy server logged "ERROR AdmissionLockTimeout" once or twice per 10 minutes and refused that admission, because the
// main thread made ONE compare-exchange and the checkpointer happened to be inside its section (a few shared-memory operations).
// Both clocks are process.hrtime (one clock for every thread).
// W-SHORT: a real worker holds the ledger lock for 20 microseconds past the moment the main thread reaches the lock, through the
//          production entry IoBudget.admissionIdle() -> critical() -> lock(). The main thread gets the lock, nothing is counted
//          or logged. Rounds where the worker was descheduled while holding (held longer than the main thread's bound) are not
//          judged: a paused holder is a real timeout (W-BOUND checks that one is counted and logged).
// W-BOUND: a holder that stays gives the timeout as before, counted and logged, and the main thread is back within 5 ms.
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import { IoBudget } from "./io-budget.ts";

const HOLDER = `const { workerData, threadId } = require("node:worker_threads");
  const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
  const ctl = new Int32Array(workerData.ctl), at = new BigInt64Array(workerData.at);
  for (;;) {
    Atomics.wait(ctl, 0, 0);
    if (Atomics.load(ctl, 0) === 9) break;
    ledger.lock();
    Atomics.store(ctl, 0, 2);
    let state = 2;
    while ((state = Atomics.load(ctl, 0)) === 2) { /* holding until the main thread is at the lock */ }
    if (state === 3) { const end = performance.now() + workerData.holdMs; while (performance.now() < end) { /* still inside the section */ } }
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.stayMs);
    ledger.unlock();
    at[0] = process.hrtime.bigint();
    Atomics.store(ctl, 0, 0);
    Atomics.store(ctl, 1, Atomics.load(ctl, 1) + 1);
  }`;

function setup(holdMs: number, stayMs: number) {
  const lines: string[] = [];
  const budget = new IoBudget({ read: () => ({ at: Date.now(), cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never, log: line => lines.push(line) });
  const ctl = new Int32Array(new SharedArrayBuffer(8)), at = new BigInt64Array(new SharedArrayBuffer(8));
  let reached = 0n;
  // critical() reads the idle verdict immediately before it takes the lock: this is the main thread "at the lock".
  budget.setIsIdle(() => { if (Atomics.load(ctl, 0) === 2 && stayMs === 0) { reached = process.hrtime.bigint(); Atomics.store(ctl, 0, 3); } return false; });
  const holder = new Worker(HOLDER, { eval: true, workerData: { buf: budget.checkpointAdmissionBuffer(), src: checkpointLedger.toString(), ctl: ctl.buffer, at: at.buffer, holdMs, stayMs } });
  const until = (done: () => boolean, what: string) => { const end = performance.now() + 10_000; while (!done()) if (performance.now() > end) throw new Error(`setup: ${what}`); };
  const hold = () => { Atomics.store(ctl, 0, 1); Atomics.notify(ctl, 0); until(() => Atomics.load(ctl, 0) === 2, "the worker never took the lock"); };
  const released = (round: number) => until(() => Atomics.load(ctl, 1) === round, "the worker never released the lock");
  const stop = async () => { Atomics.store(ctl, 0, 9); Atomics.notify(ctl, 0); await holder.terminate(); };
  return { budget, lines, ctl, at, hold, released, stop, reachedAt: () => reached };
}

it("W-SHORT the main thread meets the checkpointer's short section: the lock is taken, nothing is refused, counted or logged", { timeout: 60_000 }, async () => {
  const ROUNDS = 200, HOLD_MS = 0.02, JUDGED_MS = 0.15;
  const t = setup(HOLD_MS, 0);
  try {
    let judged = 0, missed = 0, refused = 0;
    for (let round = 1; round <= ROUNDS; round++) {
      t.hold();
      const before = t.budget.admissionHealth().lockTimeouts;
      t.budget.admissionIdle();
      const miss = t.budget.admissionHealth().lockTimeouts - before;
      t.released(round);
      if (Number(t.at[0] - t.reachedAt()) / 1e6 > JUDGED_MS) continue; // the holder was descheduled inside its section: not a short section
      judged++; missed += miss; if (miss) refused++;
    }
    expect(judged, "the worker held the lock for a short section in most rounds").toBeGreaterThanOrEqual(ROUNDS / 2);
    expect({ missed, refusedRounds: refused }, `of ${judged} short sections met by the main thread, none is an AdmissionLockTimeout`).toEqual({ missed: 0, refusedRounds: 0 });
  } finally { await t.stop(); }
});

it("W-BOUND a holder that stays still gives the timeout, counted and logged, and the main thread does not wait for it", { timeout: 60_000 }, async () => {
  const t = setup(0, 1);
  try {
    t.hold();
    const t0 = performance.now();
    t.budget.admissionIdle();
    const ms = performance.now() - t0, health = t.budget.admissionHealth();
    expect({ timeouts: health.lockTimeouts, site: health.lastTimeoutSite, lines: t.lines.filter(line => line.includes("AdmissionLockTimeout")).length }, "the timeout is counted, located and logged").toEqual({ timeouts: 1, site: "admissionIdle", lines: 1 });
    expect(ms, "the main thread came back at once").toBeLessThan(5);
    Atomics.store(t.ctl, 0, 4);
    t.released(1);
  } finally { await t.stop(); }
});
