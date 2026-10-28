// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S10 monitoring coverage: a running producer quiet for 10 awake minutes, a stats snapshot over 45 min old while the
// app is active, 3 failed scans in 10 min, and unreadable sources are reported; two fresh scans 120 s apart restore it.
import { describe, expect, it } from "vitest";
import type { DbStatsManifest } from "../../../shared/health-protocol.mjs";
import { coverageDetector } from "./coverage.ts";
import { AWAKE_BASE, INST, MIN, at, byClass, input, scans, win } from "./fixtures.ts";

const A0 = AWAKE_BASE;
const stats = (atMs: number) => ({ manifest: { schemaVersion: 1, installationId: INST, generation: 1, file: "db-stats-1.sqlite", sha256: "0".repeat(64), bytes: 1, statsSchemaVersion: 1, at: atMs, coverage: "complete" } as DbStatsManifest, rows: [] });

describe("S10 coverage detector", () => {
  it("a running producer with no complete record for 10 awake minutes is Medium, not at 9:59", () => {
    const quiet = (awakeAfter: number) => scans(coverageDetector, [
      input({ windows: [win(1)], awake: A0, now: at(1), dbStats: stats(at(1)) }),
      input({ now: at(1) + awakeAfter, awake: A0 + awakeAfter, dbStats: stats(at(1)) }),
    ]).last;
    expect(byClass(quiet(10 * MIN - 1), "producer-silent-server")!.triggered).toBeNull();
    expect(byClass(quiet(10 * MIN), "producer-silent-server")!.triggered).toBe("medium");
    // sleep does not count: 3 wall hours with 5 awake minutes is fine
    const slept = scans(coverageDetector, [
      input({ windows: [win(1)], awake: A0, now: at(1), dbStats: stats(at(1)) }),
      input({ now: at(1) + 180 * MIN, awake: A0 + 5 * MIN, dbStats: stats(at(1) + 170 * MIN) }),
    ]).last;
    expect(byClass(slept, "producer-silent-server")!.triggered).toBeNull();
  });

  it("an orderly stopped producer is not silent", () => {
    const r = scans(coverageDetector, [
      input({ windows: [win(1, { lifecycle: "stopped" })], awake: A0, now: at(1) }),
      input({ now: at(1) + 60 * MIN, awake: A0 + 60 * MIN }),
    ]).last;
    expect(byClass(r, "producer-silent-server")!.triggered).toBeNull();
  });

  it("a stats snapshot strictly older than 45 min while the app is active is Medium", () => {
    const at45 = (age: number) => scans(coverageDetector, [input({ windows: [win(60)], awake: A0, now: at(60), dbStats: stats(at(60) - age) })]).last;
    expect(byClass(at45(45 * MIN), "stats-stale")!.triggered).toBeNull();
    expect(byClass(at45(45 * MIN + 1), "stats-stale")!.triggered).toBe("medium");
  });

  it("3 failed scan attempts within (now - 10 min, now] are Medium; one at exactly 10 min ago does not count", () => {
    const now = at(30);
    const one = (failures: number[]) => byClass(coverageDetector.evaluate(input({ now, scanFailures: failures }), null).results, "scan-failing")!;
    expect(one([now - 60_000, now - 120_000]).triggered).toBeNull();
    expect(one([now - 60_000, now - 120_000, now - 180_000]).triggered).toBe("medium");
    expect(one([now - 10 * MIN, now - 120_000, now - 180_000]).triggered).toBeNull();
  });

  it("an unreadable source is reported at once", () => {
    const r = coverageDetector.evaluate(input({ now: at(5), sourceCoverage: { server: "complete", backup: "unavailable" } }), null).results;
    expect(byClass(r, "source-unavailable-backup")!.triggered).toBe("medium");
  });

  it("restores after two fresh scans at least 120 s apart, not 119 s", () => {
    const run = (gap: number) => scans(coverageDetector, [
      input({ now: at(5), sourceCoverage: { server: "complete", backup: "unavailable" } }),
      input({ now: at(7), sourceCoverage: { server: "complete", backup: "complete" } }),
      input({ now: at(7) + gap, sourceCoverage: { server: "complete", backup: "complete" } }),
    ]).last;
    expect(byClass(run(119_000), "source-unavailable-backup")!.recovery.complete).toBe(false);
    const ok = byClass(run(120_000), "source-unavailable-backup")!;
    expect(ok.recovery).toEqual({ positive: true, complete: true });
  });
});
