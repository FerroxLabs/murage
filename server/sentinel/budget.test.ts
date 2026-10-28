// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { DAY_MS, HOUR_MS, LEDGER_HOURS, ScanBudget, canCharge, charge, fullBucket, parseBucket, spentInDay } from "./budget.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

describe("scan budget", () => {
  it("allows exactly the fixed counts and records the first limit met", () => {
    const budget = new ScanBudget({ cpuMicros: () => 0, rssBytes: () => 0 });
    for (let i = 0; i < HEALTH_LIMITS.inputFilesPerScan; i++) expect(budget.takeFile()).toBe(true);
    expect(budget.takeFile()).toBe(false);
    expect(budget.stopReason).toBe("files");
    expect(budget.takeStat(HEALTH_LIMITS.statOpsPerScan)).toBe(true);
    expect(budget.takeStat()).toBe(false);
    expect(budget.stopReason).toBe("files");
  });

  it("caps reads at 256 KiB chunks and 2 MiB per scan", () => {
    const budget = new ScanBudget({ cpuMicros: () => 0, rssBytes: () => 0 });
    expect(budget.chunkAllowance()).toBe(256 * KiB);
    for (let i = 0; i < 7; i++) budget.chargeBytes(256 * KiB);
    expect(budget.chunkAllowance()).toBe(256 * KiB);
    expect(budget.chargeBytes(256 * KiB)).toBe(true);
    expect(budget.stopReason).toBe("bytes");
    expect(budget.chunkAllowance()).toBe(0);
  });

  it("caps records at 4,096, queries at 8 and rows at 256", () => {
    const budget = new ScanBudget({ cpuMicros: () => 0, rssBytes: () => 0 });
    for (let i = 0; i < 4096; i++) budget.takeRecord();
    expect(budget.takeRecord()).toBe(false);
    for (let i = 0; i < 8; i++) expect(budget.takeQuery()).toBe(true);
    expect(budget.takeQuery()).toBe(false);
    expect(budget.takeRows(256)).toBe(true);
    expect(budget.takeRows(1)).toBe(false);
  });

  it("stops cooperatively at 250 ms CPU and 128 MiB RSS, not before", () => {
    let cpu = 1_000_000;
    let rss = 0;
    const budget = new ScanBudget({ cpuMicros: () => cpu, rssBytes: () => rss });
    cpu += 249_999;
    expect(budget.withinRuntime()).toBe(true);
    cpu += 1;
    expect(budget.withinRuntime()).toBe(false);
    expect(budget.stopReason).toBe("cpu");
    const memory = new ScanBudget({ cpuMicros: () => 0, rssBytes: () => rss });
    rss = 128 * MiB - 1;
    expect(memory.withinRuntime()).toBe(true);
    rss = 128 * MiB;
    expect(memory.withinRuntime()).toBe(false);
    expect(memory.stopReason).toBe("rss");
  });
});

describe("rolling 24 h write ledger", () => {
  const T = Date.UTC(2026, 9, 27);
  it("starts empty with 32 MiB to spend and keeps a 64 KiB reserve from normal writes", () => {
    const bucket = fullBucket(T);
    expect(canCharge(bucket, 32 * MiB - 64 * KiB, T)).toBe(true);
    expect(canCharge(bucket, 32 * MiB - 64 * KiB + 1, T)).toBe(false);
    expect(canCharge(bucket, 32 * MiB, T, true)).toBe(true);
  });

  it("no rolling 24 h ever spends more than 32 MiB: bytes count until they are a full day old", () => {
    // spend almost everything, then keep asking every 30 minutes: nothing comes back before 24 h have passed
    let bucket = charge(fullBucket(T), 32 * MiB - 64 * KiB, T);
    for (let t = T + 30 * 60_000; t < T + DAY_MS; t += 30 * 60_000) expect(canCharge(bucket, 1024, t)).toBe(false);
    expect(canCharge(bucket, 1024, T + DAY_MS + HOUR_MS)).toBe(true);
    // spending at the steady rate of the old bucket's refill (32 MiB a day) never doubles the day's total
    bucket = fullBucket(T);
    let spent = 0;
    for (let t = T; t < T + DAY_MS; t += 2 * 60_000) if (canCharge(bucket, 64 * KiB, t)) { bucket = charge(bucket, 64 * KiB, t); spent += 64 * KiB; }
    expect(spent).toBeLessThanOrEqual(32 * MiB);
    expect(spentInDay(bucket, T + DAY_MS - 1)).toBe(spent);
  });

  it("keeps at most 25 hour slots", () => {
    let bucket = fullBucket(T);
    for (let h = 0; h < 100; h++) bucket = charge(bucket, 1, T + h * HOUR_MS);
    expect(bucket.hours.length).toBeLessThanOrEqual(LEDGER_HOURS + 1);
    expect(spentInDay(bucket, T + 99 * HOUR_MS)).toBe(LEDGER_HOURS);
  });

  it("reads a missing or malformed ledger as nothing spent, and an earlier build's token bucket as what it had spent", () => {
    expect(parseBucket(null, T)).toEqual(fullBucket(T));
    expect(parseBucket({ hours: "x" }, T)).toEqual(fullBucket(T));
    expect(parseBucket({ tokens: "x", at: T }, T)).toEqual(fullBucket(T));
    expect(spentInDay(parseBucket({ tokens: 70 * KiB, at: T }, T), T)).toBe(32 * MiB - 70 * KiB);
    expect(spentInDay(parseBucket({ hours: [[Math.floor(T / HOUR_MS), 5], [0, 9]] }, T), T)).toBe(5);
  });
});
