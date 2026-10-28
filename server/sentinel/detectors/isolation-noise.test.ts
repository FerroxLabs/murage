// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S09 front-matter fallback: Low only at 20 fallbacks in 10 min in one engine launch; resolves after a later completed
// isolation scan plus 30 complete minutes with zero fallback, or retires when a newer launch replaces it.
import { describe, expect, it } from "vitest";
import type { IsolationFact } from "../../../shared/health-protocol.mjs";
import { isolationNoiseDetector } from "./isolation-noise.ts";
import { perWindow, tok, win } from "./fixtures.ts";

const iso = (fallbackDelta: number, launch = 1, extra: Partial<IsolationFact> = {}): IsolationFact =>
  ({ kind: "isolation", engineKind: "claude", launchToken: tok(launch, "d"), completedScan: false, fallbackDelta, ...extra });
const quiet = (from: number, to: number, launch = 1) => Array.from({ length: to - from + 1 }, (_, k) => win(from + k, { facts: [iso(0, launch)] }));

describe("S09 isolation-noise detector", () => {
  it("F:23-28 trace: 20 fallbacks in 10 min in one launch is Low; 19 is a normal count", () => {
    const r = perWindow(isolationNoiseDetector, [win(1, { facts: [iso(10)] }), win(10, { facts: [iso(10)] })]).last[0]!;
    expect(r.triggered).toBe("low");
    expect(r.pageEligible).toBe(false);
    expect(perWindow(isolationNoiseDetector, [win(1, { facts: [iso(10)] }), win(10, { facts: [iso(9)] })]).last[0]!.triggered).toBeNull();
  });

  it("the window excludes its left endpoint, and two launches never add up", () => {
    expect(perWindow(isolationNoiseDetector, [win(1, { facts: [iso(10)] }), win(11, { facts: [iso(10)] })]).last[0]!.triggered).toBeNull();
    expect(perWindow(isolationNoiseDetector, [win(1, { facts: [iso(10, 1), iso(10, 2)] })]).last[0]!.triggered).toBeNull();
  });

  it("never escalates above Low on volume", () => {
    expect(perWindow(isolationNoiseDetector, [win(1, { facts: [iso(5_000)] })]).last[0]!.triggered).toBe("low");
  });

  it("recovers only after a later completed scan and 30 complete minutes with zero fallback", () => {
    const trigger = win(1, { facts: [iso(20)] });
    const scanned = win(2, { facts: [iso(0, 1, { completedScan: true })] });
    expect(perWindow(isolationNoiseDetector, [trigger, scanned, ...quiet(3, 30)]).last[0]!.recovery.complete).toBe(false); // 29 calm minutes (2..30)
    expect(perWindow(isolationNoiseDetector, [trigger, scanned, ...quiet(3, 31)]).last[0]!.recovery.complete).toBe(true);
    expect(perWindow(isolationNoiseDetector, [trigger, ...quiet(2, 40)]).last[0]!.recovery.complete).toBe(false); // no completed scan
    const noisy = quiet(3, 32);
    noisy[10] = win(13, { facts: [iso(1)] });
    expect(perWindow(isolationNoiseDetector, [trigger, scanned, ...noisy]).last[0]!.recovery.complete).toBe(false);
  });

  it("a newer launch of the engine retires the noisy one as source-retired, never as recovered", () => {
    const r = perWindow(isolationNoiseDetector, [win(1, { facts: [iso(20, 1)] }), win(2, { facts: [iso(0, 2)] })]).last[0]!;
    expect(r.retired).toBe("source-retired");
    expect(r.recovery.complete).toBe(false);
  });
});
