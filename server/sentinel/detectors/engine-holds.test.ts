// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S04 engine home held: Low after 24 awake hours held with work owed, Medium 15 awake minutes after two clear
// observations at least 2 min apart, sleep never counts, an unchecked holder is unavailable, and a deletion hold is
// presented under S05 without losing its own fingerprint.
import { describe, expect, it } from "vitest";
import { fingerprint } from "../types.ts";
import { deletionFingerprint, engineHoldsDetector } from "./engine-holds.ts";
import { AWAKE_BASE, HOUR_MS, INST, MIN, T0, at, input, obligation, scans, win } from "./fixtures.ts";

const A0 = AWAKE_BASE;
const held = (i: number, extra = {}) => win(i, { facts: [obligation({ code: "engine-history", observedAt: at(i), ...extra })] });
/** First scan sees the fact at awake A0; the second scan (no new windows) runs at the given awake time and wall time. */
function after(first: ReturnType<typeof win>[], awake: number, now: number) {
  return scans(engineHoldsDetector, [input({ windows: first, awake: A0, now: at(1) }), input({ now, awake })]).last[0]!;
}

describe("S04 engine-holds detector", () => {
  it("F:23-28 trace: a held home is Low at 24 awake hours with work owed, not one millisecond before", () => {
    expect(after([held(1)], A0 + 24 * HOUR_MS - 1, at(1) + 24 * HOUR_MS).triggered).toBeNull();
    const r = after([held(1)], A0 + 24 * HOUR_MS, at(1) + 24 * HOUR_MS);
    expect(r.triggered).toBe("low");
    expect(r.pageEligible).toBe(false);
  });

  it("sleep is never a failure duration: 30 wall hours with 23 awake hours stays quiet", () => {
    expect(after([held(1)], A0 + 23 * HOUR_MS, at(1) + 30 * HOUR_MS).triggered).toBeNull();
  });

  it("an expected holder with nothing owed is a count, never an issue", () => {
    expect(after([held(1, { pendingCount: 0, oldestPendingAt: null })], A0 + 48 * HOUR_MS, at(1) + 48 * HOUR_MS).triggered).toBeNull();
  });

  it("an unchecked holder state is unavailable coverage, not clear", () => {
    const r = after([held(1, { holderState: "unknown" })], A0 + 48 * HOUR_MS, at(1) + 48 * HOUR_MS);
    expect(r.triggered).toBeNull();
    expect(r.coverage).toBe("unavailable");
  });

  it("Medium 15 awake minutes after two clear observations at least 2 min apart", () => {
    const clear = (i: number, observedAt: number) => win(i, { facts: [obligation({ code: "engine-history", holderState: "clear", holderClearAt: T0, observedAt })] });
    const run = (gapMs: number, awakeAfter: number) => scans(engineHoldsDetector, [
      input({ windows: [clear(1, at(1))], awake: A0, now: at(1) }),
      input({ windows: [clear(4, at(1) + gapMs)], awake: A0 + 3 * MIN, now: at(4) }),
      input({ now: at(4) + awakeAfter, awake: A0 + 3 * MIN + awakeAfter }),
    ]).last[0]!;
    expect(run(2 * MIN - 1, 60 * MIN).triggered).toBeNull(); // observations 1:59 apart never confirm clearance
    expect(run(2 * MIN, 15 * MIN - 1).triggered).toBeNull();
    expect(run(2 * MIN, 15 * MIN).triggered).toBe("medium");
  });

  it("resolves on a completed operation or a fresh no-work-pending observation", () => {
    const done = scans(engineHoldsDetector, [
      input({ windows: [held(1)], awake: A0, now: at(1) }),
      input({ now: at(1) + 24 * HOUR_MS, awake: A0 + 24 * HOUR_MS }),
      input({ windows: [held(2, { completedDelta: 1 })], awake: A0 + 24 * HOUR_MS + MIN, now: at(1) + 24 * HOUR_MS + MIN }),
    ]);
    expect(done.results[1]![0]!.triggered).toBe("low");
    expect(done.results[2]![0]!.recovery).toEqual({ positive: true, complete: true });
    const empty = scans(engineHoldsDetector, [
      input({ windows: [held(1)], awake: A0, now: at(1) }),
      input({ windows: [held(2, { pendingCount: 0, oldestPendingAt: null })], awake: A0 + MIN, now: at(2) }),
    ]);
    expect(empty.last[0]!.recovery.complete).toBe(true);
  });

  it("a deletion hold is presented under S05, with both fingerprints kept and linked", () => {
    const r = after([win(1, { facts: [obligation({ code: "deletion", observedAt: at(1) })] })], A0 + 24 * HOUR_MS, at(1) + 24 * HOUR_MS);
    expect(r.triggered).toBe("low");
    expect(r.presentedBy).toBe(deletionFingerprint(INST, "claude"));
    expect(r.relatedFingerprints).toEqual([deletionFingerprint(INST, "claude")]);
    expect(fingerprint(r.tuple)).not.toBe(r.presentedBy);
    const other = after([held(1)], A0 + 24 * HOUR_MS, at(1) + 24 * HOUR_MS);
    expect(other.presentedBy).toBeUndefined();
  });
});
