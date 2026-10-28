// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The detector registry, the correlation slot budget, state caps, and scale: per-evaluation work and state never grow
// with the number of historical windows already folded in.
import { describe, expect, it } from "vitest";
import { DETECTOR_CLASS, HEALTH_LIMITS, type CounterRow, type Fact, type OperationalWindow } from "../../../shared/health-protocol.mjs";
import { DETECTOR_STATE_MAX_BYTES, fingerprint, type DetectorId, type DetectorState } from "../types.ts";
import { CORRELATION_SLOTS } from "./common.ts";
import { DETECTORS, DETECTOR_SUBSYSTEM, DETECTOR_VERSIONS, runDetectors, type PersistedDetectorState } from "./index.ts";
import { sendFenceDetector } from "./send-fence.ts";
import { MIB, SK, T0, input, io, obligation, tok, turn, win } from "./fixtures.ts";

const bytes = (state: DetectorState | null) => Buffer.byteLength(JSON.stringify(state));

/** One busy minute exercising every fact kind, with fresh opaque tokens each minute. */
function busy(i: number): OperationalWindow {
  const counters: CounterRow[] = [
    { detector: "extraction", engineKind: "claude", sourceKey: SK, code: "unusable", value: 2 },
    { detector: "extraction", engineKind: "claude", sourceKey: SK, code: "complete", value: 1 },
    { detector: "io-pressure", engineKind: "none", code: "prior-deleted", value: 1500 },
  ];
  const facts: Fact[] = [
    io(i % 3 ? 60 * MIB : 0),
    { kind: "extraction-streak", sourceKey: SK, engineKind: "claude", leadingUnusable: 1, trailingUnusable: 1, maxConsecutiveUnusable: 1, settledCount: 3, orderComplete: true },
    obligation({ observedAt: T0 + i * 60_000, oldestPendingAt: T0 - 1 }),
    obligation({ code: "engine-history", holderState: "clear", observedAt: T0 + i * 60_000, oldestPendingAt: T0 - 1 }),
    { kind: "isolation", engineKind: "claude", launchToken: tok(Math.floor(i / 50), "d"), completedScan: i % 7 === 0, fallbackDelta: 3 },
  ];
  for (let k = 0; k < 11; k++) {
    const n = i * 16 + k;
    facts.push(turn({ n, scope: n, refusalDelta: 2, rebuildMsDelta: 6_000, resetDelta: 1, final: k % 3 === 0 ? "exhausted" : k % 3 === 1 ? "completed" : null }));
  }
  return win(i, { counters, facts });
}

function runFor(minutes: number) {
  let prior: Partial<Record<DetectorId, PersistedDetectorState>> = {};
  const sizes: Partial<Record<DetectorId, number>> = {};
  for (let i = 1; i <= minutes; i++) {
    const runs = runDetectors(input({ windows: [busy(i)], awake: 1_000_000 + i * 60_000 }), prior);
    const next: Partial<Record<DetectorId, PersistedDetectorState>> = {};
    for (const run of runs) {
      expect(run.failed).toBe(false);
      expect(run.oversize).toBe(false);
      next[run.id] = run.nextState!;
      sizes[run.id] = bytes(run.nextState!.state);
    }
    prior = next;
  }
  return sizes;
}

describe("detector registry", () => {
  it("lists S01..S10 once each, in class order, with versions and subsystems", () => {
    expect(DETECTORS.map(d => DETECTOR_CLASS[d.id])).toEqual(["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10"]);
    for (const d of DETECTORS) {
      expect(DETECTOR_VERSIONS[d.id]).toBe(d.version);
      expect(Number.isInteger(d.version) && d.version >= 1).toBe(true);
      expect(DETECTOR_SUBSYSTEM[d.id]).toBeTruthy();
    }
  });

  it("the per-detector correlation shares add up to the global 1,024 slots", () => {
    expect(Object.values(CORRELATION_SLOTS).reduce((a, b) => a + b, 0)).toBe(HEALTH_LIMITS.correlationEntries);
  });

  it("a prior state from another detector version is discarded, not trusted", () => {
    const runs = runDetectors(input({ now: T0 }), { backup: { version: 999, state: { counted: { "not-protected": "x" }, overdueBase: 1, stalledDeadline: null } } });
    expect(runs.find(r => r.id === "backup")!.nextState!.state).toMatchObject({ overdueBase: null });
  });

  it("only S01 and S02 results can ever be page-eligible", () => {
    const pagers = new Set<string>();
    let prior: Partial<Record<DetectorId, PersistedDetectorState>> = {};
    for (let i = 1; i <= 40; i++) {
      const runs = runDetectors(input({ windows: [busy(i)] }), prior);
      for (const run of runs) {
        for (const r of run.results) if (r.pageEligible) pagers.add(r.tuple.detectorId);
        prior[run.id] = run.nextState!;
      }
    }
    for (const id of pagers) expect(["backup", "io-pressure"]).toContain(id);
  });

  it("grouping never erases a distinct fingerprint: presentedBy always names a different fingerprint", () => {
    let prior: Partial<Record<DetectorId, PersistedDetectorState>> = {};
    let grouped = 0;
    for (let i = 1; i <= 30; i++) {
      for (const run of runDetectors(input({ windows: [busy(i)], awake: 1_000_000 + i * 24 * 3_600_000 }), prior)) {
        for (const r of run.results) if (r.presentedBy) { grouped++; expect(r.presentedBy).not.toBe(fingerprint(r.tuple)); }
        prior[run.id] = run.nextState!;
      }
    }
    expect(grouped).toBeGreaterThan(0);
  });
});

describe("scale", () => {
  it("state stays under the cap and does not grow with history (150 vs 600 busy minutes)", () => {
    const early = runFor(150);
    const late = runFor(600);
    for (const d of DETECTORS) {
      expect(late[d.id]!).toBeLessThanOrEqual(DETECTOR_STATE_MAX_BYTES);
      // fixed rings and capped maps: allow for token/number width only
      expect(late[d.id]!).toBeLessThanOrEqual(Math.ceil(early[d.id]! * 1.1) + 64);
    }
  });

  it("an evicted correlation token cannot establish a threshold and marks coverage partial", () => {
    // 30 windows in one minute, 16 fresh turns each: far beyond the send-fence share of the correlation slots. The
    // first 25 carry fast rebuilds (no trigger); the last 5, after eviction began, would meet the threshold.
    const windows = Array.from({ length: 30 }, (_, k) => win(5, { seq: 5 + k * 1000, facts: Array.from({ length: 16 }, (_, j) => turn({ n: k * 16 + j, refusalDelta: 2, rebuildMsDelta: k < 25 ? 0 : 6_000 })) }));
    const out = sendFenceDetector.evaluate(input({ windows }), null);
    const r = out.results[0]!;
    expect(r.triggered).toBeNull();
    expect(r.coverage).toBe("partial");
    expect((out.nextState.rows as readonly unknown[]).length).toBeLessThanOrEqual(CORRELATION_SLOTS["send-fence"]);
  });
});
