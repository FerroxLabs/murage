// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S03 learning extraction: 3 consecutive unusable attempts in 15 min (Medium), the 30/60 min rate rules (High), the
// 30 min recovery rule, and unknown stays unknown: interrupted attempts or missing coverage never become a rate.
import { describe, expect, it } from "vitest";
import type { CounterRow, ExtractionStreakFact, OperationalWindow } from "../../../shared/health-protocol.mjs";
import { HealthCounters } from "../../health/counters.ts";
import type { DetectorResult } from "../types.ts";
import { EXTRACTION_SOURCES_MAX, extractionDetector } from "./extraction.ts";
import { INST, MIN, SK, T0, input, perWindow, scans, win } from "./fixtures.ts";

interface Spec { complete?: number; unusable?: number; cancelled?: number; interrupted?: number; deferred?: number; streak?: Partial<ExtractionStreakFact> | false; ok?: boolean; partialCoverage?: boolean }

function ext(i: number, spec: Spec = {}) {
  const counters: CounterRow[] = [];
  const add = (code: string, value = 0) => { if (value > 0) counters.push({ detector: "extraction", engineKind: "claude", sourceKey: SK, code, value }); };
  add("complete", spec.complete); add("unusable", spec.unusable); add("cancelled", spec.cancelled); add("interrupted", spec.interrupted); add("deferred-busy", spec.deferred);
  const settled = (spec.complete ?? 0) + (spec.unusable ?? 0) + (spec.cancelled ?? 0) + (spec.interrupted ?? 0);
  const facts: ExtractionStreakFact[] = [];
  if (spec.streak !== false && settled > 0) {
    const allUnusable = (spec.unusable ?? 0) === settled;
    facts.push({
      kind: "extraction-streak", sourceKey: SK, engineKind: "claude", settledCount: settled, orderComplete: true,
      leadingUnusable: allUnusable ? settled : 0, trailingUnusable: allUnusable ? settled : 0, maxConsecutiveUnusable: allUnusable ? settled : 0,
      ...(spec.streak || {}),
    });
  }
  return win(i, { counters, facts, complete: spec.ok ?? true, ...(spec.partialCoverage ? { coverage: { extraction: "partial" } } : {}) });
}
/** Minutes 1..n from specs; null sends no window. */
const series = (specs: (Spec | null)[]) => specs.flatMap((spec, k) => (spec === null ? [] : [ext(k + 1, spec)]));
const results = (specs: (Spec | null)[]) => perWindow(extractionDetector, series(specs)).results.map(scan => scan[0] as DetectorResult | undefined);
const last = (specs: (Spec | null)[]) => results(specs).at(-1)!;
const U: Spec = { unusable: 1 };
const Z: Spec = {};
const fill = (n: number, spec: Spec) => Array<Spec>(n).fill(spec);

describe("S03 extraction detector", () => {
  it("Medium at 3 consecutive unusable admitted attempts across adjacent complete windows, not 2", () => {
    expect(last([U, U]).triggered).toBeNull();
    expect(last([U, U, U]).triggered).toBe("medium");
    expect(last([{ unusable: 3 }]).triggered).toBe("medium");
  });

  it("the 15 min window is left-exclusive and right-inclusive", () => {
    // unusable at minutes 1, 8 and 16 with idle minutes between: minute 1 is outside (16 - 15, 16]
    const outside = [U, ...fill(6, Z), U, ...fill(7, Z), U];
    expect(outside).toHaveLength(16);
    expect(last(outside).triggered).toBeNull();
    // at minutes 2, 8 and 16: all inside
    expect(last([Z, U, ...fill(5, Z), U, ...fill(7, Z), U]).triggered).toBe("medium");
  });

  it("a cancelled, interrupted, missing, out-of-order or incomplete window breaks the streak proof", () => {
    expect(last([U, { cancelled: 1, streak: { leadingUnusable: 0, trailingUnusable: 0, maxConsecutiveUnusable: 0 } }, U, U]).triggered).toBeNull();
    expect(last([U, { interrupted: 1, streak: { leadingUnusable: 0, trailingUnusable: 0, maxConsecutiveUnusable: 0 } }, U, U]).triggered).toBeNull();
    expect(last([U, null, U, U]).triggered).toBeNull();
    expect(last([U, { unusable: 1, streak: { orderComplete: false } }, U]).triggered).toBeNull();
    expect(last([U, { unusable: 1, ok: false }, U]).triggered).toBeNull();
    // unusable without a streak fact cannot prove order
    expect(last([U, { unusable: 1, streak: false }, U]).triggered).toBeNull();
    // a complete reply in between ends the run
    expect(last([U, { unusable: 1, complete: 1, streak: { leadingUnusable: 1, trailingUnusable: 0, maxConsecutiveUnusable: 1 } }, U, U]).triggered).toBeNull();
  });

  it("deferrals (busy, unconfigured, budget) never count", () => {
    const out = results(fill(60, { deferred: 50 }));
    expect(out.every(r => r === undefined || (r.triggered === null && r.occurrences === 0))).toBe(true);
  });

  it("High A: in 30 complete minutes, 10 settled, zero complete and 10 unusable; 9 is not enough", () => {
    const tenOf30 = Array.from({ length: 30 }, (_, k) => (k % 3 === 0 ? { unusable: 1, streak: false } : Z) as Spec);
    expect(tenOf30.filter(s => s.unusable).length).toBe(10);
    expect(last(tenOf30).triggered).toBe("high");
    const nineOf30 = tenOf30.map((s, k) => (k === 0 ? Z : s));
    expect(last(nineOf30).triggered).toBeNull();
    // a complete attempt anywhere in the 30 minutes removes rule A
    expect(last(tenOf30.map((s, k) => (k === 1 ? { complete: 1 } : s))).triggered).toBeNull();
  });

  it("High B: 20 settled in 60 complete minutes at an unusable fraction of at least 80%; 79% is not", () => {
    // completes at minutes 10, 25, 40, 55 keep rule A away; 16 unusable spread over the rest
    const build = (unusable: number, complete: number, cancelled = 0) => {
      const specs: Spec[] = fill(60, Z).map(() => ({}));
      [10, 25, 40, 55].slice(0, complete).forEach(m => { specs[m - 1] = { complete: 1 }; });
      let placed = 0;
      for (let m = 2; m <= 60 && placed < unusable; m += 3) if (!specs[m - 1]!.complete) { specs[m - 1] = { unusable: 1, streak: false }; placed++; }
      let c = 0;
      for (let m = 60; m >= 1 && c < cancelled; m--) if (!specs[m - 1]!.complete && !specs[m - 1]!.unusable) { specs[m - 1] = { cancelled: 1, streak: false }; c++; }
      return specs;
    };
    expect(last(build(16, 4)).triggered).toBe("high"); // 16 / 20 = 80%
    expect(last(build(15, 4)).triggered).toBeNull(); // 19 settled
    expect(last(build(15, 4, 1)).triggered).toBeNull(); // 20 settled, 15 / 19 = 78.9%
    // cancellations count as settled but are excluded from the fraction: 16 / (16 + 4) = 80% with 22 settled
    expect(last(build(16, 4, 2)).triggered).toBe("high");
  });

  it("an interrupted attempt makes the rate unknown, never a calculated failure rate", () => {
    const specs: Spec[] = Array.from({ length: 60 }, (_, k) => (k % 2 === 0 ? { unusable: 1, streak: false } : Z));
    specs[59] = { interrupted: 1, streak: false };
    const r = last(specs);
    expect(r.triggered).toBeNull();
    expect(r.metrics.unusablePercent).toBeUndefined();
  });

  it("F:22/F:38-47 trace: 177 unusable replies with no success denominator stay unknown, not a rate", () => {
    const specs: Spec[] = Array.from({ length: 60 }, (_, k) => ({ unusable: k < 57 ? 3 : 2, streak: false, partialCoverage: true }));
    expect(specs.reduce((n, s) => n + (s.unusable ?? 0), 0)).toBe(177);
    const r = last(specs);
    expect(r.triggered).toBeNull();
    expect(r.coverage).not.toBe("complete");
    expect(r.metrics.unusablePercent).toBeUndefined();
    expect(r.recovery.complete).toBe(false);
  });

  it("recovers over a later 30 complete minutes with at least 5 complete and at most 20% unusable", () => {
    const trigger: Spec[] = [U, U, U];
    const later = (complete: number, unusable: number): Spec[] => {
      const specs: Spec[] = fill(30, Z).map(() => ({}));
      for (let k = 0; k < complete; k++) specs[k * 5] = { complete: 1 };
      for (let k = 0; k < unusable; k++) specs[k * 5 + 2] = { unusable: 1, streak: false };
      return specs;
    };
    const ok = last([...trigger, ...later(5, 1)]); // 1/6 = 16.7%
    expect(ok.recovery.complete).toBe(true);
    expect(last([...trigger, ...later(5, 2)]).recovery.complete).toBe(false); // 2/7 = 28.6%
    expect(last([...trigger, ...later(4, 1)]).recovery.complete).toBe(false);
    expect(last([...trigger, ...later(5, 1).slice(0, 29)]).recovery.complete).toBe(false); // only 29 later minutes
  });

  it("an issue opened before a producer restart keeps its fingerprint and resolves after it (installation token key)", () => {
    const key = Buffer.alloc(32, 9);
    let now = T0;
    const windows: OperationalWindow[] = [];
    const producer = (previousEpoch = 0) => {
      const c = new HealthCounters({ producer: "server", now: () => now, detectors: ["extraction"] });
      c.setInstallationKey(key);
      c.startEpoch(INST, previousEpoch);
      return c;
    };
    const minute = (c: HealthCounters, work?: () => void) => { work?.(); now += MIN; windows.push(...c.rollUp(now)); };
    const before = producer();
    const source = before.deriveStableToken("extractor", "connection-1");
    minute(before);
    minute(before, () => { for (let k = 0; k < 3; k++) { before.extractionAdmitted(source, "claude"); before.extractionSettled(source, "claude", "unusable"); } });
    const opened = scans(extractionDetector, [input({ windows: windows.splice(0) })]);
    const issue = opened.last.find(r => r.triggered !== null)!;
    expect(issue.triggered).toBe("medium");
    expect(issue.tuple.sourceKey).toBe(source);

    const after = producer(before.currentEpoch); // a restart: new process, new epoch, the same persisted key
    const same = after.deriveStableToken("extractor", "connection-1");
    minute(after);
    for (let k = 1; k <= 40; k++) minute(after, k % 5 === 0 ? () => { after.extractionAdmitted(same, "claude"); after.extractionSettled(same, "claude", "complete"); } : undefined);
    windows.push(...after.flush(now));
    const resolved = scans(extractionDetector, [input({ windows: windows.splice(0) })], opened.state);
    const sameIssue = resolved.last.find(r => r.tuple.sourceKey === source)!;
    expect(sameIssue).toBeDefined();
    expect(sameIssue.recovery.complete).toBe(true);
    expect(resolved.last.filter(r => r.tuple.sourceKey !== source)).toEqual([]);
  });

  it(`follows at most ${EXTRACTION_SOURCES_MAX} sources, evicting the least recently active: a new failing source is never the one dropped`, () => {
    const key = (n: number) => `${n.toString(16).padStart(2, "0")}${SK.slice(2)}`;
    const unusableFrom = (i: number, sourceKey: string) => win(i, {
      counters: [{ detector: "extraction", engineKind: "claude", sourceKey, code: "unusable", value: 1 }],
      facts: [{ kind: "extraction-streak", sourceKey, engineKind: "claude", settledCount: 1, orderComplete: true, leadingUnusable: 1, trailingUnusable: 1, maxConsecutiveUnusable: 1 }],
    });
    // eight sources, each active once in minutes 1..8
    const early = Array.from({ length: EXTRACTION_SOURCES_MAX }, (_, k) => unusableFrom(k + 1, key(k + 1)));
    // a ninth source fails three times in a row at minutes 9..11
    const ninth = [9, 10, 11].map(i => unusableFrom(i, key(99)));
    const run = perWindow(extractionDetector, [...early, ...ninth]);
    const last = run.last;
    const newcomer = last.find(r => r.tuple.sourceKey === key(99))!;
    expect(newcomer.triggered).toBe("medium");
    // the source dropped is the one active longest ago, and it says so
    const retired = run.results.flat().filter(r => r.retired === "source-retired").map(r => r.tuple.sourceKey);
    expect(retired[0]).toBe(key(1));
    expect(retired).not.toContain(key(99));
    expect(Object.keys(run.state!.sources)).toHaveLength(EXTRACTION_SOURCES_MAX);
  });

  it("replayed windows never count twice", () => {
    const windows = series([U, U, U]);
    const first = scans(extractionDetector, [input({ windows })]);
    expect(first.last[0]!.occurrences).toBe(3);
    const again = scans(extractionDetector, [input({ windows })], first.state);
    expect(again.last[0]!.occurrences).toBe(0);
  });
});
