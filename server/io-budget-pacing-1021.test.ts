// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, io-budget pacing (MEMORY-V2-DESIGN 4.8; owners: witness and io-budget = memv2-D; the deferral's consumers =
// worker-controller lanes E/K/A, instrumentDatabase = lane W).
// B2: no idle timer. Before 1.0.21 IoBudget.start() armed a 25 ms admission refresh for ever (2,267 fires an idle minute, G-IDLE-PROCESS).
// It is now armed only while something is open or the published verdict is ACTIVE, and disarms once IDLE is published.
// B3 (F16): a missed ledger lock is a short retry, never "minute full". Before 1.0.21 a BG admission refused only because a checkpointer
// held the ledger lock for microseconds was deferred to the next minute (refusalRetry -> nextAdmissionMs), so one unlucky collision stopped
// background memory work for up to 60 s.
// Real path: the real IoBudget and the real shared ledger; the lock is held by a real worker thread, as admission-lock-timeout-surface does.
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import { IoBudget, isBgDeferred } from "./io-budget.ts";
import { WAL_ADMISSION_BYTES } from "./wal-maintenance.ts";

/** A reading one second into a minute: a minute-bound deferral would be 59 s. */
const at = 600_000 * 60 + 1000;
const reading = () => ({ at, cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never;

async function heldLedger(buf: SharedArrayBuffer, holdMs: number): Promise<Worker> {
  const holder = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    ledger.lock(); parentPort.postMessage("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs); ledger.unlock(); parentPort.postMessage("released");`,
  { eval: true, workerData: { buf, src: checkpointLedger.toString(), holdMs } });
  await new Promise<void>((resolve, reject) => { holder.once("message", () => resolve()); holder.once("error", reject); });
  return holder;
}

describe("B3 a lock miss is a short retry (lane D)", { timeout: 30_000 }, () => {
  it("a BG admission refused by a held ledger lock retries in 250 ms, and is admitted once the lock is free", async () => {
    const budget = new IoBudget({ read: reading, log: () => {} });
    budget.setIsIdle(() => false);
    const buf = budget.checkpointAdmissionBuffer();
    const holder = await heldLedger(buf, 400);
    const released = new Promise<void>(resolve => holder.on("message", m => { if (m === "released") resolve(); }));
    let retry: unknown;
    try {
      expect(budget.admit("BG", 4096)).toBeNull(); // the main thread never waits for the lock: one attempt, refused
      retry = budget.refusalRetry();
      await released; // the checkpointer's microsecond hold, stretched to 400 ms here
    } finally { await holder.terminate(); }
    expect(isBgDeferred(retry)).toBe(true);
    const r = retry as { retryInMs: number; reservationWait: boolean };
    console.log(`[B3-MEASURE] lock-miss retry ${r.retryInMs} ms (minute-bound would be ${budget.nextAdmissionMs()} ms)`);
    // base f6ae52c670: retryInMs = nextAdmissionMs = 59,000 ms (the rest of the minute) and reservationWait false
    expect(r.retryInMs).toBeLessThanOrEqual(250);
    expect(r.reservationWait).toBe(true); // so worker-controller's bgRetryDelay keeps the short step instead of the minute
    // the retry, after the holder released, is admitted
    const ticket = budget.admit("BG", 4096);
    expect(ticket).not.toBeNull();
    budget.settle(ticket!, 0);
  });
  it("a BG admission refused for spent bytes (no lock miss) still waits for the minute", () => {
    const budget = new IoBudget({ read: reading, log: () => {} });
    budget.setIsIdle(() => false);
    expect(budget.admit("BG", 1024 * 1024 * 1024)).toBeNull(); // over every allowance
    const retry = budget.refusalRetry() as unknown as { retryInMs: number; reservationWait: boolean };
    expect(retry.retryInMs).toBeGreaterThan(250);
    expect(retry.reservationWait).toBe(false);
  });
});

describe("B2 no idle admission timer (lane D)", () => {
  afterEach(() => { vi.useRealTimers(); });
  /** A started watchdog on a fake clock: `reads` counts every admission/watchdog reading (each 25 ms refresh is one). */
  function started(idle: () => boolean) {
    vi.useFakeTimers({ now: at });
    let reads = 0;
    const budget = new IoBudget({ read: () => { reads++; return { at: Date.now(), cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 } as never; }, log: () => {}, isIdle: idle });
    budget.start();
    const slot7 = () => new BigInt64Array(budget.checkpointAdmissionBuffer(false))[7]; // published verdict: 1n idle, 0n active (read without a section)
    return { budget, reads: () => reads, slot7, stop: () => budget.stop() };
  }
  it("an idle minute fires no admission refresh: reads stay at the watchdog's own, and the published verdict is idle", () => {
    const w = started(() => true);
    try {
      vi.advanceTimersByTime(1_000); // the first refresh publishes IDLE, then disarms
      const r0 = w.reads();
      vi.advanceTimersByTime(60_000);
      const reads = w.reads() - r0;
      console.log(`[B2-MEASURE] idle minute admission readings ${reads} (25 ms timer: ${60_000 / 25})`);
      // base f6ae52c670: 2,400 refreshes plus the watchdog tick
      expect(reads).toBeLessThanOrEqual(3); // the 60 s watchdog tick and the refresh it arms once
      expect(w.slot7()).toBe(1n);
    } finally { w.stop(); }
  });
  it("owner activity publishes ACTIVE at once; the refresh runs while active and disarms within 25 ms of the minute that turns idle", () => {
    let idle = true;
    const w = started(() => idle);
    try {
      vi.advanceTimersByTime(1_000);
      expect(w.slot7()).toBe(1n);
      idle = false; w.budget.noteForegroundActivity();
      expect(w.slot7()).toBe(0n); // published at once by the owner action's own section
      const r0 = w.reads();
      vi.advanceTimersByTime(1_000);
      expect(w.reads() - r0).toBeGreaterThanOrEqual(30); // while ACTIVE the 25 ms refresh runs
      idle = true;
      vi.advanceTimersByTime(60_000); // the watchdog minute clears the owner flag; the refresh publishes IDLE and disarms
      expect(w.slot7()).toBe(1n);
      const r1 = w.reads();
      vi.advanceTimersByTime(30_000);
      expect(w.reads() - r1).toBeLessThanOrEqual(1);
    } finally { w.stop(); }
  });
  it("an open reservation keeps the refresh armed while idle (its expiry is converted on time); settling it disarms", () => {
    const w = started(() => true);
    try {
      vi.advanceTimersByTime(1_000);
      const ticket = w.budget.admit("FGCOPY", 4096);
      expect(ticket).not.toBeNull();
      const r0 = w.reads();
      vi.advanceTimersByTime(1_000);
      expect(w.reads() - r0).toBeGreaterThanOrEqual(30);
      w.budget.settle(ticket!, 1024);
      vi.advanceTimersByTime(100);
      const r1 = w.reads();
      vi.advanceTimersByTime(30_000);
      expect(w.reads() - r1).toBeLessThanOrEqual(1);
    } finally { w.stop(); }
  });
});

describe("B4 background work stops first at the WAL half gate (lane D)", () => {
  const MiB = 1024 * 1024;
  it("at 256 MiB of un-copied log a BG admission is refused (retry in 1 s), a copy (FGCOPY) is not; under it BG is admitted", () => {
    const budget = new IoBudget({ read: reading, log: () => {} });
    budget.setIsIdle(() => false);
    let backlog = 300 * MiB;
    (budget as unknown as { setWalBacklog(read: () => number | null): void }).setWalBacklog(() => backlog);
    expect(backlog).toBeLessThan(WAL_ADMISSION_BYTES); // the owner's hard gate (512 MiB) is not reached: owner sends still commit
    // base f6ae52c670: no half gate, BG work keeps writing until the hard gate refuses the owner too
    expect(budget.admit("BG", 4096)).toBeNull();
    const retry = budget.refusalRetry() as unknown as { retryInMs: number; reservationWait: boolean };
    expect([retry.retryInMs, retry.reservationWait]).toEqual([1000, true]);
    const copy = budget.admit("FGCOPY", 4096);
    expect(copy).not.toBeNull(); budget.settle(copy!, 0);
    backlog = 100 * MiB; // the off-thread copy caught up
    const bg = budget.admit("BG", 4096);
    expect(bg).not.toBeNull(); budget.settle(bg!, 0);
    backlog = 256 * MiB; // exactly at the gate is past it
    expect(budget.admit("BG", 4096)).toBeNull();
  });
  it("an unreadable log reading stops background work (fail closed); no reading installed (no maintenance) changes nothing", () => {
    const budget = new IoBudget({ read: reading, log: () => {} });
    budget.setIsIdle(() => false);
    const bg = budget.admit("BG", 4096);
    expect(bg).not.toBeNull(); budget.settle(bg!, 0);
    (budget as unknown as { setWalBacklog(read: () => number | null): void }).setWalBacklog(() => { throw new Error("stat failed"); });
    expect(budget.admit("BG", 4096)).toBeNull();
  });
});
