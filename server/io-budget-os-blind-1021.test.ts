// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, B1 / I8 in the admission ledger (gate G-OS; owners: witness, io-budget admission and admission-shared = memv2-D;
// the admission callers = worker-controller lanes E/K/A and wal-maintenance = memv2-D).
// I8: admission of memory work is a pure function of the application's own counted bytes; no OS counter is an input. Before 1.0.21 the
// ledger's observed bytes (slot 11, and so the minute total in slot 3) were max(OS delta, meter delta): on macOS the OS term is the whole
// process's diskWritten and on Linux the thread's fsWrite, so a foreign writer spent the BG minute there and nowhere else (win32 has no
// OS term). The OS counter now stays in the watchdog's line only.
// Real path: the real IoBudget with the real readAdmissionProcess conversion; only process.platform, the darwin counter (on the loaded
// engine-exclusion addon, the object the real darwinWrittenBytes() reads), process.resourceUsage().fsWrite and the clock are injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { BG_MINUTE_BYTES, IoBudget } from "./io-budget.ts";
import { resetDarwinWrittenForTest } from "./os-disk-written.ts";

const PLATFORMS = ["darwin", "win32", "linux"] as const;
type Platform = typeof PLATFORMS[number];
const MINUTE = 60_000;
/** A foreign writer at 4 GB a minute, as the OS counters see it (bytes since the run began). */
const FOREIGN_PER_MINUTE = 4 * 1024 * 1024 * 1024;
const t0 = 29_000_000 * MINUTE;
const foreign = () => Math.floor(Math.max(0, Date.now() - t0) / MINUTE * FOREIGN_PER_MINUTE);

type Addon = { diskWritten?: () => number };
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const realUsage = process.resourceUsage.bind(process);
let addon: Addon | null = null, realDiskWritten: Addon["diskWritten"];
beforeEach(() => {
  addon = loadExclusionAddon() as unknown as Addon | null;
  expect(addon, "the engine-exclusion addon is loaded (the darwin counter is injected on it)").not.toBeNull();
  realDiskWritten = addon!.diskWritten;
  addon!.diskWritten = () => foreign();
  resetDarwinWrittenForTest();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0);
  vi.spyOn(process, "resourceUsage").mockImplementation(() => ({ ...realUsage(), fsWrite: Math.floor(foreign() / 512) }));
});
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (addon) addon.diskWritten = realDiskWritten;
  resetDarwinWrittenForTest();
  vi.restoreAllMocks(); vi.useRealTimers();
});

/** Three busy minutes, one BG admission of 1 MiB each second (settled at half), active server, under the foreign writer. */
function decisions(platform: Platform): { admitted: number[]; perMinute: number[]; osSeen: number } {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    vi.setSystemTime(t0); resetDarwinWrittenForTest();
    const budget = new IoBudget({ log: () => {} });
    budget.setIsIdle(() => false);
    const admitted: number[] = [], perMinute = [0, 0, 0];
    for (let m = 0; m < 3; m++) for (let s = 0; s < 60; s++) {
      vi.setSystemTime(t0 + MINUTE + m * MINUTE + s * 1000); // starts one minute in: the counters already moved 4 GB
      const ticket = budget.admit("BG", 1024 * 1024);
      admitted.push(ticket ? 1 : 0);
      if (ticket) { perMinute[m]++; budget.settle(ticket, 512 * 1024); }
    }
    // what the budget's own reading stored for the OS counter (slot 12): proves the injection reached readAdmissionProcess
    const osSeen = Number((budget as unknown as { admissionShared: { slots: BigInt64Array } }).admissionShared.slots[12]);
    budget.stop();
    return { admitted, perMinute, osSeen };
  } finally { Object.defineProperty(process, "platform", realPlatform); }
}

describe("G-OS: admission sees no OS counter (lane D, B1/I8)", () => {
  it("BG admission decisions are identical on darwin, win32 and linux under a 4 GB/min foreign writer, and the minute is not spent by it", () => {
    const r = Object.fromEntries(PLATFORMS.map(p => [p, decisions(p)])) as Record<Platform, ReturnType<typeof decisions>>;
    // the foreign writer is real for the OS counters: the budget's own darwin and linux readings saw more than 12 GB (win32 has no OS term)
    expect(r.darwin.osSeen, "darwin diskWritten reached the admission reading").toBeGreaterThan(3 * FOREIGN_PER_MINUTE);
    expect(r.linux.osSeen, "linux fsWrite reached the admission reading").toBeGreaterThan(3 * FOREIGN_PER_MINUTE);
    // win32 has no OS term: its decisions are the reference. They admit (12 MiB a minute, 512 KiB settled each, refused in the last 5 s).
    expect(r.win32.perMinute.every(n => n >= 20), `win32 admits in every minute (${r.win32.perMinute})`).toBe(true);
    expect(r.win32.perMinute.every(n => n * 1024 * 1024 <= BG_MINUTE_BYTES * 2)).toBe(true);
    // base f6ae52c670: darwin and linux admit 0 (observed = 4 GB of foreign OS bytes > BG_MINUTE_BYTES and > 49 MiB every minute)
    expect(r.darwin.perMinute, "darwin admits per minute as win32 does").toEqual(r.win32.perMinute);
    expect(r.linux.perMinute, "linux admits per minute as win32 does").toEqual(r.win32.perMinute);
    expect(r.darwin.admitted).toEqual(r.win32.admitted);
    expect(r.linux.admitted).toEqual(r.win32.admitted);
  });
});

describe("G-OS: the checkpointer's end of copy observes no OS counter (lane D, B1/I8, admission-shared endCopy)", () => {
  it("a copy ending with a 4 GB OS reading and 1,000 meter bytes observes 1,000 bytes, on every OS", () => {
    const now = t0 + 5_000;
    const ledger = checkpointLedger(new SharedArrayBuffer(32 * BigInt64Array.BYTES_PER_ELEMENT), 7001, 2000, { gen: 1 });
    const ticket = ledger.beginCopy(4096, now);
    expect(ticket, "a copy is admitted on a clean ledger").not.toBeNull();
    ledger.endCopy(ticket!, 4096, 0, { os: FOREIGN_PER_MINUTE, meter: 1000 }, now + 10);
    // base f6ae52c670: slot 11 = max(OS delta, meter delta) = 4 GB, so the minute total (slot 3) is spent by a foreign writer
    expect(Number(ledger.slots[11]), "observed = the meter's delta only").toBe(1000);
    expect(Number(ledger.slots[3])).toBeLessThan(1024 * 1024);
  });
});
