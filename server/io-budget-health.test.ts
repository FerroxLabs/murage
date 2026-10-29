// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.9 Sentinel (GAP-SENTINEL-109 section 4.2): the IO watchdog reports every judged minute, calm and zero minutes
// included, as enums and byte counts only. The planned-work cap and the verdict are unchanged by the report.
import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS, chargedRatePerMin, isValidIoSample, parseIoSample, type IoSample } from "../shared/health-protocol.mjs";
import { IO_BUDGET_IDLE_BYTES_PER_MINUTE, IoBudget, ioSourceClass, type IoReading } from "./io-budget.ts";

const MINUTE = 60_000;
const MB_BLOCKS = 2048;

function rig(idle: boolean, onSample?: (sample: IoSample) => void) {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const samples: IoSample[] = [];
  const budget = new IoBudget({ read: () => reading, log: () => {}, isIdle: () => idle, systemOverloaded: () => null, onSample: onSample ?? (sample => samples.push(sample)) });
  const advance = (ms: number, writeMb: number) => {
    reading = { at: reading.at + ms, fsWriteBlocks: reading.fsWriteBlocks + Math.round(writeMb * MB_BLOCKS), cpuMicros: reading.cpuMicros + 0.05 * ms * 1000 };
    return budget.tick();
  };
  budget.tick();
  return { budget, samples, advance };
}

describe("io-budget: Sentinel minute sample", () => {
  it("reports a calm zero minute as a valid sample", () => {
    const { samples, advance } = rig(true);
    advance(MINUTE, 0);
    expect(samples).toHaveLength(1);
    expect(parseIoSample(samples[0]).ok).toBe(true);
    expect(samples[0]).toMatchObject({ idle: true, intervalMs: MINUTE, osBytes: 0, applicationBytes: 0, chargedBytes: 0, budgetBytes: IO_BUDGET_IDLE_BYTES_PER_MINUTE, pollScale: 1, sourceClass: "other", discontinuity: false });
    expect(isValidIoSample(samples[0])).toBe(true);
  });

  it("reports planned bytes and the charged remainder; the verdict is the same as without the report", () => {
    const { budget, samples, advance } = rig(true);
    budget.setPlannedBytes(() => 19.6 * 1048576);
    const verdict = advance(MINUTE, 20);
    expect(verdict?.tripped).toBe(false);
    const sample = samples[0]!;
    expect(sample.plannedBytesAllowed).toBe(Math.round(19.6 * 1048576));
    expect(sample.chargedBytes).toBe(20 * 1048576 - Math.round(19.6 * 1048576));
    expect(chargedRatePerMin(sample)).toBeCloseTo(sample.chargedBytes, 0);
    const plain = rig(true, () => {});
    plain.budget.setPlannedBytes(() => 19.6 * 1048576);
    expect(plain.advance(MINUTE, 20)?.tripped).toBe(false);
  });

  it("a minute past 90 s is reported but marked discontinuous; 90 s exactly is valid", () => {
    const { samples, advance } = rig(false);
    advance(HEALTH_LIMITS.ioSampleMaxMs, 1);
    advance(HEALTH_LIMITS.ioSampleMaxMs + 1, 1);
    expect(samples.map(sample => sample.discontinuity)).toEqual([false, true]);
    expect(samples.map(sample => isValidIoSample(sample))).toEqual([true, false]);
  });

  it("names the heaviest writer only by its closed source class", () => {
    const { budget, samples, advance } = rig(false);
    budget.noteBytes("database:/Users/someone/Library/Application Support/Murage/messages.db", 5_000);
    budget.noteBytes("memory-worker", 10);
    advance(MINUTE, 0);
    expect(samples[0]!.sourceClass).toBe("messages-db");
    expect(JSON.stringify(samples[0])).not.toContain("Users");
    expect(ioSourceClass("database:C:\\Data\\memory-index.db")).toBe("memory-index-db");
    expect(ioSourceClass("database:/x/skill-index.db")).toBe("skill-index-db");
    expect(ioSourceClass("database:/x/connected-app-ledger.db")).toBe("connected-app-ledger-db");
    expect(ioSourceClass("memory-worker")).toBe("memory");
    expect(ioSourceClass("exec:SELECT 1")).toBe("other");
    expect(ioSourceClass(undefined)).toBe("other");
  });

  it("a throwing listener never changes the watchdog", () => {
    const { advance } = rig(true, () => { throw new Error("listener"); });
    expect(advance(MINUTE, 20)?.tripped).toBe(true);
  });
});
