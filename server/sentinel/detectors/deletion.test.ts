// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S05 deletion still pending: Medium at 24 elapsed hours, or 15 awake minutes after holder clearance with at least 2
// failed completion attempts. Resolution needs a fresh persisted snapshot; time alone never raises it above Medium.
import { describe, expect, it } from "vitest";
import { deletionDetector } from "./deletion.ts";
import { holdFingerprint } from "./engine-holds.ts";
import { AWAKE_BASE, HOUR_MS, INST, MIN, T0, at, input, obligation, scans, win } from "./fixtures.ts";

const A0 = AWAKE_BASE;
const pending = (i: number, extra = {}) => win(i, { facts: [obligation({ code: "deletion", oldestPendingAt: T0, observedAt: at(i), ...extra })] });
/** Minute index of a time, so a first-scan window sits inside the 60 min baseline. */
const mi = (now: number) => Math.floor((now - T0) / MIN);
const one = (now: number, extra = {}) => deletionDetector.evaluate(input({ windows: [pending(mi(now), extra)], now, awake: A0 }), null).results[0]!;

describe("S05 deletion detector", () => {
  it("F:23-28 trace: a persisted pending deletion is Medium at 24 elapsed hours, not before, and never higher", () => {
    expect(one(T0 + 24 * HOUR_MS - 1).triggered).toBeNull();
    expect(one(T0 + 24 * HOUR_MS).triggered).toBe("medium");
    const later = one(T0 + 240 * HOUR_MS);
    expect(later.triggered).toBe("medium");
    expect(later.pageEligible).toBe(false);
  });

  it("Medium 15 awake minutes after holder clearance with at least 2 failed attempts", () => {
    const run = (failed: number, awakeAfter: number) => scans(deletionDetector, [
      input({ windows: [pending(1, { holderState: "clear", holderClearAt: at(1), failedAttemptsAfterClear: failed })], awake: A0, now: at(1) }),
      input({ now: at(1) + awakeAfter, awake: A0 + awakeAfter }),
    ]).last[0]!;
    expect(run(1, 60 * MIN).triggered).toBeNull();
    expect(run(2, 15 * MIN - 1).triggered).toBeNull();
    expect(run(2, 15 * MIN).triggered).toBe("medium");
  });

  it("logs alone never prove completion: no new snapshot keeps it unresolved", () => {
    const r = scans(deletionDetector, [
      input({ windows: [pending(mi(T0 + 25 * HOUR_MS))], awake: A0, now: T0 + 25 * HOUR_MS }),
      input({ now: T0 + 26 * HOUR_MS, awake: A0 + HOUR_MS }),
    ]).last[0]!;
    expect(r.triggered).toBe("medium");
    expect(r.recovery.complete).toBe(false);
  });

  it("resolves on a reconciled snapshot with nothing pending, or once the affected obligation has ended", () => {
    const now = T0 + 25 * HOUR_MS;
    const cleared = scans(deletionDetector, [
      input({ windows: [pending(mi(now))], awake: A0, now }),
      input({ windows: [pending(mi(now) + 1, { pendingCount: 0, oldestPendingAt: null, completedDelta: 1 })], awake: A0 + MIN, now: now + MIN }),
    ]).last[0]!;
    expect(cleared.recovery).toEqual({ positive: true, complete: true });
    const advanced = scans(deletionDetector, [
      input({ windows: [pending(mi(now))], awake: A0, now }),
      input({ windows: [pending(mi(now) + 1, { oldestPendingAt: now - HOUR_MS })], awake: A0 + MIN, now: now + MIN }),
    ]).last[0]!;
    expect(advanced.triggered).toBeNull();
    expect(advanced.recovery.complete).toBe(true);
  });

  it("links the S04 hold fingerprint while the holder is involved", () => {
    expect(one(T0 + 24 * HOUR_MS).relatedFingerprints).toEqual([holdFingerprint(INST, "claude", "deletion")]);
  });
});
