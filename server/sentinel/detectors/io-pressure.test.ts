// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S02 database write pressure: 3-of-5 complete minutes for Medium, 10 consecutive minutes or idle >= 50 MiB/min for
// 5 minutes for High (the only page), 10 calm complete minutes to recover, and the revocation-repeat annotation.
import { describe, expect, it } from "vitest";
import { IO_SOURCE_CLASSES, type IoMinuteFact } from "../../../shared/health-protocol.mjs";
import type { DetectorResult } from "../types.ts";
import { IO_ERROR_CLASS, IO_RING_MINUTES, ioPressureDetector } from "./io-pressure.ts";
import { MIB, input, io, perWindow, scans, win } from "./fixtures.ts";

type Minute = number | "gap" | "partial" | { rate: number; idle?: boolean; priorDeleted?: number; sample?: Partial<IoMinuteFact> };

/** Minutes 1..n: a number is an idle charged rate in bytes/min; "gap" sends no window; "partial" an incomplete one. */
function run(minutes: Minute[], extra: { start?: number } = {}) {
  const start = extra.start ?? 1;
  const windows = minutes.flatMap((m, index) => {
    const i = start + index;
    if (m === "gap") return [];
    if (m === "partial") return [win(i, { complete: false, facts: [io(0)] })];
    const spec = typeof m === "number" ? { rate: m } : m;
    const counters = spec.priorDeleted ? [{ detector: "io-pressure" as const, engineKind: "none" as const, code: "prior-deleted", value: spec.priorDeleted }] : [];
    return [win(i, { counters, facts: [io(spec.rate, { idle: spec.idle ?? true, ...spec.sample })] })];
  });
  return perWindow(ioPressureDetector, windows);
}
const sev = (scan: readonly DetectorResult[]) => scan[0]?.triggered ?? null;
const severities = (minutes: Minute[]) => run(minutes).results.map(sev);
const B = 2 * MIB; // an idle breach
const OK = 0;

describe("S02 io-pressure detector", () => {
  it("idle budget: exactly 1 MiB/min is within budget, one byte more breaches", () => {
    expect(severities([MIB, MIB, MIB, OK, OK]).at(-1)).toBeNull();
    expect(severities([MIB + 1, MIB + 1, MIB + 1, OK, OK]).at(-1)).toBe("medium");
  });

  it("active budget: exactly 50 MiB/min is within budget, one byte more breaches", () => {
    const active = (rate: number): Minute => ({ rate, idle: false });
    expect(severities([active(50 * MIB), active(50 * MIB), active(50 * MIB), OK, OK]).at(-1)).toBeNull();
    expect(severities([active(50 * MIB + 1), active(50 * MIB + 1), active(50 * MIB + 1), OK, OK]).at(-1)).toBe("medium");
  });

  it("Medium needs 3 of 5 complete consecutive minutes: 2 of 5 is not enough, and a gap or partial minute breaks the span", () => {
    expect(severities([B, OK, B, OK, OK]).at(-1)).toBeNull();
    expect(severities([B, OK, B, OK, B]).at(-1)).toBe("medium");
    expect(severities([B, "gap", B, B, OK]).at(-1)).toBeNull();
    expect(severities([B, "partial", B, B, OK]).at(-1)).toBeNull();
    // fewer than five minutes observed cannot establish the threshold
    expect(severities([B, B, B, B])).toEqual([null, null, null, null]);
  });

  it("an invalid sample (interval outside 45-90 s or a discontinuity) makes its minute incomplete", () => {
    const shortSample: Minute = { rate: B, sample: { intervalMs: 44_999 } };
    const jumped: Minute = { rate: B, sample: { discontinuity: true } };
    expect(severities([B, shortSample, B, B, OK]).at(-1)).toBeNull();
    expect(severities([B, jumped, B, B, OK]).at(-1)).toBeNull();
    expect(severities([B, { rate: B, sample: { intervalMs: 45_000, applicationBytes: B * 0.75 } }, B, OK, OK]).at(-1)).toBe("medium");
  });

  it("High when the Medium condition holds for 10 consecutive minutes, not 9", () => {
    // Medium first holds at minute 3+2=5 when minutes 1..5 all breach; 10 consecutive Medium minutes end at minute 14.
    const s = severities(Array(14).fill({ rate: B, idle: false } as Minute).map(() => ({ rate: 51 * MIB, idle: false })));
    expect(s[12]).toBe("medium");
    expect(s[13]).toBe("high");
  });

  it("idle charged writes at 50 MiB/min for 5 consecutive minutes are High and page-eligible; 4 minutes or 1 byte less is not", () => {
    const heavy = 50 * MIB;
    const out = run([heavy, heavy, heavy, heavy, heavy]).results.map(scan => scan[0]!);
    expect(out[3]!.triggered).toBeNull();
    expect(out[4]!.triggered).toBe("high");
    expect(out[4]!.pageEligible).toBe(true);
    const below = run([heavy, heavy, heavy, heavy, heavy - 1]).last[0]!;
    expect(below.triggered).toBe("medium");
    expect(below.pageEligible).toBe(false);
    // active heavy writes never page
    const active = run(Array(14).fill(0).map(() => ({ rate: 60 * MIB, idle: false }))).last[0]!;
    expect(active.triggered).toBe("high");
    expect(active.pageEligible).toBe(false);
  });

  it("F:21/F:30-36 trace: sustained writes with prior-deleted >= 1,000/min in 3 of 5 minutes carry the revocation annotation", () => {
    const pd = (priorDeleted: number): Minute => ({ rate: B, priorDeleted });
    const annotated = run([pd(1000), pd(1000), pd(1000), B, B]).last[0]!;
    expect(annotated.triggered).toBe("medium");
    expect(annotated.metrics.revocationRepeat).toBe(1);
    const below = run([pd(999), pd(1000), pd(1000), B, B]).last[0]!;
    expect(below.triggered).toBe("medium");
    expect(below.metrics.revocationRepeat).toBeUndefined();
    // the annotation alone never makes an issue
    const quietMinute = (priorDeleted: number): Minute => ({ rate: 0, priorDeleted });
    expect(run([quietMinute(5000), quietMinute(5000), quietMinute(5000), OK, OK]).last[0]!.triggered).toBeNull();
  });

  it("recovery: positive on the first calm complete minute, complete after 10, and a partial minute restarts the run", () => {
    const after = (calm: Minute[]) => run([B, B, B, B, B, ...calm]).last[0]!;
    // Medium still holds while 3 of the last 5 minutes breach; the first scan without a trigger is positive.
    expect(after([OK, OK]).triggered).toBe("medium");
    const first = after([OK, OK, OK]);
    expect(first.triggered).toBeNull();
    expect(first.recovery.positive).toBe(true);
    expect(first.recovery.complete).toBe(false);
    expect(after(Array(9).fill(OK)).recovery.complete).toBe(false);
    expect(after(Array(10).fill(OK)).recovery.complete).toBe(true);
    expect(after([...Array(5).fill(OK), "partial", ...Array(9).fill(OK)]).recovery.complete).toBe(false);
  });

  it("counts breach minutes once: a replayed window never counts again", () => {
    const w = [1, 2, 3, 4, 5].map(i => win(i, { facts: [io(B)] }));
    const first = scans(ioPressureDetector, [input({ windows: w })]);
    expect(first.last[0]!.occurrences).toBe(5);
    const again = scans(ioPressureDetector, [input({ windows: w })], first.state);
    expect(again.last[0]!.occurrences).toBe(0);
    expect(again.last[0]!.triggered).toBeNull();
  });

  it("measures the process-wide rate: a top writer that alternates between classes still reaches High, the page and recovery", () => {
    const heavy = 60 * MIB;
    const classes = ["messages-db", "memory-index-db"] as const;
    const w = Array.from({ length: 5 }, (_, k) => win(k + 1, { facts: [io(heavy, { sourceClass: classes[k % 2] })] }));
    const results = scans(ioPressureDetector, [input({ windows: w })]).last;
    expect(results).toHaveLength(1);
    expect(results[0]!.tuple.errorClass).toBe(IO_ERROR_CLASS);
    expect(results[0]!.triggered).toBe("high");
    expect(results[0]!.pageEligible).toBe(true);
    expect(results[0]!.metrics.topSourceClass).toBe(IO_SOURCE_CLASSES.indexOf("messages-db") + 1); // the newest breach minute's top writer
    const calm = Array.from({ length: 10 }, (_, k) => win(k + 6, { facts: [io(0, { sourceClass: classes[k % 2] })] }));
    // the next scans bring the calm minutes, whichever class wrote least: 9 are not enough, 10 recover
    const after = (n: number) => scans(ioPressureDetector, [input({ windows: w }), ...calm.slice(0, n).map(c => input({ windows: [c] }))]).last[0]!;
    expect(after(9).recovery.complete).toBe(false);
    expect(after(10).recovery.complete).toBe(true);
  });

  it("a minute with no sample is a gap, never calm: it breaks the heavy run and freezes recovery, and coverage says so", () => {
    const heavy = 60 * MIB;
    const noSample = (i: number) => win(i, { facts: [] });
    // four heavy minutes, one minute with a window but no sample, then a fifth heavy minute: no five-minute run, no page
    const broken = scans(ioPressureDetector, [input({ windows: [1, 2, 3, 4].map(i => win(i, { facts: [io(heavy)] })).concat(noSample(5), win(6, { facts: [io(heavy)] })) })]).last[0]!;
    expect(broken.pageEligible).toBe(false);
    // after an open issue, minutes without samples never add up to a recovery
    const open = [1, 2, 3, 4, 5].map(i => win(i, { facts: [io(heavy)] }));
    const missing = Array.from({ length: 12 }, (_, k) => noSample(k + 6));
    const frozen = scans(ioPressureDetector, [input({ windows: open }), input({ windows: missing })]);
    expect(frozen.last[0]!.recovery).toEqual({ positive: false, complete: false });
    expect(frozen.last[0]!.coverage).toBe("partial");
  });

  it("keeps a fixed ring: state does not grow with history", () => {
    const long = scans(ioPressureDetector, Array.from({ length: 200 }, (_, k) => input({ windows: [win(k + 1, { facts: [io(k % 2 ? B : 0)] })] })));
    expect(long.state!.ring.length).toBe(IO_RING_MINUTES);
  });
});
