// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, B4 background bucket (MEMORY-V2-DESIGN 4.8; owners: bucket and witness = memv2-D; consumers = lane I, the
// migration runner of section 5 and retention, which take it later).
// One 8 MiB a minute bucket for work nobody waits on, declared to the watchdog as planned bytes, stopped first at 256 MiB of un-copied WAL.
// Before 1.0.21 there was no such class: a background pass writing 8 MiB in an idle minute tripped the watchdog (the idle budget is 1 MiB),
// halved every poll rate and was named the fault (gap 40 (c): migration bytes would raise the idle I/O alarm).
// Real path: the real IoBudget minute (tick) and admission state; only the reading and the clock are injected.
import { describe, expect, it } from "vitest";
import * as io from "./io-budget.ts";

const MiB = 1024 * 1024;
type Bucket = { backgroundBucketWait?: (now?: number) => number; chargeBackgroundBucket?: (bytes: number, now?: number) => void };

function idleBudget() {
  const r = { at: 1_000 * 60_000, cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 };
  const lines: string[] = [];
  const budget = new io.IoBudget({ read: () => ({ ...r }) as never, log: l => lines.push(l), isIdle: () => true, systemOverloaded: () => null });
  expect(budget.tick()).toBeNull(); // the first sample only sets the floor
  return { budget, r, lines };
}

describe("B4 the background bucket (lane D)", () => {
  it("8 MiB of background-bucket work in an idle minute is planned: the watchdog does not trip or halve the poll rate", () => {
    const { budget, r, lines } = idleBudget();
    r.meterBytes += 8 * MiB; // the slice's writes, as the application meter counts them
    (budget as unknown as Bucket).chargeBackgroundBucket?.(8 * MiB, r.at + 1000);
    r.at += 60_000;
    const verdict = budget.tick();
    // base f6ae52c670: no bucket, 8 MiB > the 1 MiB idle budget: tripped, "writing 8.0 MB/min", poll rate x1/2
    expect(verdict?.tripped, `watchdog lines: ${lines.join(" | ")}`).toBe(false);
    expect(verdict?.writeBytesPerMinute).toBe(0);
  });

  it("the planned declaration is capped at the bucket's rate: a consumer charging 10x more hides nothing", () => {
    const { budget, r } = idleBudget();
    r.meterBytes += 80 * MiB;
    (budget as unknown as Bucket).chargeBackgroundBucket?.(80 * MiB, r.at);
    r.at += 60_000;
    const verdict = budget.tick();
    expect(verdict?.tripped).toBe(true);
    expect(verdict?.writeBytesPerMinute).toBe(72 * MiB);
  });

  it("the bucket paces at 8 MiB a minute (a leaky bucket: an oversized slice is debt)", () => {
    const b = new io.IoBudget({ read: () => ({ at: 0, cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never, log: () => {} }) as unknown as Bucket;
    expect(io.BACKGROUND_BUCKET_BYTES_PER_MINUTE).toBe(8 * MiB);
    const t = 5_000_000;
    expect(b.backgroundBucketWait?.(t)).toBe(0);
    b.chargeBackgroundBucket!(8 * MiB, t);
    expect(b.backgroundBucketWait!(t)).toBe(60_000);
    expect(b.backgroundBucketWait!(t + 30_000)).toBe(30_000);
    b.chargeBackgroundBucket!(2 * MiB, t + 30_000); // a slice run late in debt still adds its own time
    expect(b.backgroundBucketWait!(t + 30_000)).toBe(45_000);
    expect(b.backgroundBucketWait!(t + 75_000)).toBe(0);
    b.chargeBackgroundBucket!(0, t + 75_000); b.chargeBackgroundBucket!(Number.NaN, t + 75_000);
    expect(b.backgroundBucketWait!(t + 75_000)).toBe(0);
  });

  it("the bucket stops first at the WAL half gate (256 MiB un-copied), and an unreadable log stops it (fail closed)", () => {
    const budget = new io.IoBudget({ read: () => ({ at: 0, cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never, log: () => {} });
    const b = budget as unknown as Bucket;
    let backlog: number | null = io.WAL_HALF_GATE_BYTES - 1;
    budget.setWalBacklog(() => { if (backlog === -1) throw new Error("EIO"); return backlog; });
    expect(b.backgroundBucketWait!(1)).toBe(0);
    backlog = io.WAL_HALF_GATE_BYTES;
    expect(b.backgroundBucketWait!(1)).toBe(io.WAL_HALF_RETRY_MS);
    backlog = -1;
    expect(b.backgroundBucketWait!(1)).toBe(io.WAL_HALF_RETRY_MS);
    backlog = null; // no log open
    expect(b.backgroundBucketWait!(1)).toBe(0);
    // the owner path is never behind the bucket: an FGCOPY at the half gate is still admitted by the ledger
    backlog = io.WAL_HALF_GATE_BYTES;
    budget.setIsIdle(() => false);
    expect(budget.admit("FGCOPY", 4096)).not.toBeNull();
    expect(budget.admit("BG", 4096)).toBeNull();
  });
});
