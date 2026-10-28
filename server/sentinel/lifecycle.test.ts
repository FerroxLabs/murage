// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The section 6.2 issue lifecycle and the section 8.2 page policy: episodes, counts and timestamps, recovery freezing,
// explicit retirement, one page per fingerprint and episode, the 24 h reopen cooldown and the 3-per-24 h cap.
import { describe, expect, it } from "vitest";
import type { DetectorResult, Severity } from "./types.ts";
import { fingerprint } from "./types.ts";
import { EMPTY_LEDGER, PAGE_CAP, PAGE_COOLDOWN_MS, applyResult, decidePage, step, type IssueRecord, type PageLedger, type StepContext } from "./lifecycle.ts";

const INST = "0123456789abcdef0123456789abcdef";
const H = 60 * 60_000;
const T = Date.UTC(2026, 9, 27, 12);
const tuple = { installationId: INST, detectorId: "backup" as const, subsystem: "backup" as const, engineKind: null, sourceKey: null, errorClass: "not-protected" };

function result(over: Partial<DetectorResult> & { sev?: Severity | null; positive?: boolean; complete?: boolean } = {}): DetectorResult {
  const { sev = null, positive = false, complete = false, ...rest } = over;
  return {
    tuple, triggered: sev, occurrences: sev ? 1 : 0, recovery: { positive, complete }, coverage: "complete", pageEligible: false,
    titleKey: "health.backup.not-protected", window: { startAt: T - H, endAt: T }, metrics: {}, evidence: [], ...rest,
  };
}
const ctx = (now: number, extra: Partial<StepContext> = {}): StepContext => ({ now, detectorVersion: 1, discontinuity: false, ...extra });
const apply = (prior: IssueRecord | null, r: DetectorResult, now: number, extra: Partial<StepContext> = {}) => applyResult(prior, r, ctx(now, extra));

describe("issue lifecycle", () => {
  it("absent + trigger opens episode 1 with the fixed fingerprint; no trigger leaves nothing", () => {
    expect(apply(null, result(), T).record).toBeNull();
    const { record, transition } = apply(null, result({ sev: "medium" }), T);
    expect(transition).toBe("opened");
    expect(record!.issue).toMatchObject({ state: "open", episode: 1, firstSeenAt: T, openedAt: T, lastSeenAt: T, count: 1, severity: "medium", fingerprint: fingerprint(tuple) });
  });

  it("open + trigger counts only new occurrences, severity only rises, lastSeenAt moves only with new evidence", () => {
    const opened = apply(null, result({ sev: "high" }), T).record!;
    const noNew = apply(opened, result({ sev: "medium", occurrences: 0 }), T + H).record!;
    expect(noNew.issue).toMatchObject({ severity: "high", count: 1, lastSeenAt: T });
    const more = apply(noNew, result({ sev: "medium", occurrences: 3 }), T + 2 * H).record!;
    expect(more.issue).toMatchObject({ count: 4, lastSeenAt: T + 2 * H, severity: "high" });
  });

  it("open -> recovering -> resolved with observed-recovery; recovering + trigger reopens the same episode", () => {
    const opened = apply(null, result({ sev: "medium" }), T).record!;
    const recovering = apply(opened, result({ positive: true }), T + H);
    expect(recovering.transition).toBe("recovering");
    expect(recovering.record!.recoveryStartedAt).toBe(T + H);
    const back = apply(recovering.record, result({ sev: "medium" }), T + 2 * H);
    expect(back.transition).toBe("reopened");
    expect(back.record!.issue).toMatchObject({ state: "open", episode: 1 });
    expect(back.record!.recoveryStartedAt).toBeNull();
    const rec2 = apply(back.record, result({ positive: true }), T + 3 * H).record!;
    const done = apply(rec2, result({ positive: true, complete: true }), T + 4 * H);
    expect(done.transition).toBe("resolved");
    expect(done.record!.issue).toMatchObject({ state: "resolved", resolution: "observed-recovery", resolvedAt: T + 4 * H });
  });

  it("missing input, sleep, a clock jump or a crashed window freezes recovery and keeps state and severity", () => {
    const opened = apply(null, result({ sev: "high" }), T).record!;
    for (const frozen of [apply(opened, result({ positive: true, complete: true, coverage: "partial" }), T + H), apply(opened, result({ positive: true, complete: true }), T + H, { discontinuity: true })]) {
      expect(frozen.transition).toBe("frozen");
      expect(frozen.record!.issue).toMatchObject({ state: "open", severity: "high" });
    }
    expect(apply(opened, result({ positive: true, complete: true, coverage: "unavailable" }), T + H).record!.issue.coverage.overall).toBe("unavailable");
  });

  it("explicit retirement resolves as policy-ended or source-retired, never as recovered", () => {
    const opened = apply(null, result({ sev: "high" }), T).record!;
    const retired = apply(opened, result({ retired: "policy-ended" }), T + H);
    expect(retired.transition).toBe("retired");
    expect(retired.record!.issue).toMatchObject({ state: "resolved", resolution: "policy-ended" });
    expect(apply(null, result({ retired: "source-retired" }), T).record).toBeNull();
  });

  it("a resolved issue that triggers again opens a new episode, keeping first seen and clearing the resolution", () => {
    const opened = apply(null, result({ sev: "medium" }), T).record!;
    const resolved = apply(opened, result({ positive: true, complete: true }), T + H).record!;
    expect(resolved.issue.state).toBe("resolved");
    const again = apply(resolved, result({ sev: "medium" }), T + 5 * H).record!;
    expect(again.issue).toMatchObject({ state: "open", episode: 2, firstSeenAt: T, openedAt: T + 5 * H, count: 2 });
    expect(again.issue.resolution).toBeUndefined();
    expect(again.issue.resolvedAt).toBeUndefined();
  });
});

describe("page policy", () => {
  const eligible = (over: Partial<DetectorResult> = {}) => result({ sev: "high", pageEligible: true, ...over });
  const pageRun = (prior: IssueRecord | null, r: DetectorResult, ledger: PageLedger, now: number) => step(prior, r, ledger, ctx(now));

  it("only a page-eligible trigger pages, and only once per fingerprint and episode", () => {
    const digestOnly = pageRun(null, result({ sev: "high" }), EMPTY_LEDGER, T);
    expect(digestOnly.intent).toBeNull();
    expect(digestOnly.record!.delivery).toBe("digest");
    const first = pageRun(null, eligible(), EMPTY_LEDGER, T);
    expect(first.intent).toEqual({ delivery: "page", reason: "page" });
    expect(first.ledger.attempts).toEqual([T]);
    const second = pageRun(first.record, eligible(), first.ledger, T + H);
    expect(second.intent).toBeNull();
    // recovering then reopening in the same episode never pages again
    const rec = pageRun(second.record, result({ positive: true }), second.ledger, T + 2 * H);
    expect(pageRun(rec.record, eligible(), rec.ledger, T + 3 * H).intent).toBeNull();
  });

  it("a digest-only episode that escalates to the page condition pages once", () => {
    const medium = pageRun(null, result({ sev: "medium" }), EMPTY_LEDGER, T);
    const escalated = pageRun(medium.record, eligible(), medium.ledger, T + H);
    expect(escalated.intent).toEqual({ delivery: "page", reason: "page" });
  });

  it("a reopened episode waits 24 h after the fingerprint's last page", () => {
    const first = pageRun(null, eligible(), EMPTY_LEDGER, T);
    const resolved = pageRun(first.record, result({ positive: true, complete: true }), first.ledger, T + H);
    const early = pageRun(resolved.record, eligible(), resolved.ledger, T + PAGE_COOLDOWN_MS - 1);
    expect(early.intent).toEqual({ delivery: "digest", reason: "cooldown" });
    const resolved2 = pageRun(first.record, result({ positive: true, complete: true }), first.ledger, T + H);
    const onTime = pageRun(resolved2.record, eligible(), resolved2.ledger, T + PAGE_COOLDOWN_MS);
    expect(onTime.intent).toEqual({ delivery: "page", reason: "page" });
  });

  it("at most 3 page attempts per installation in a rolling 24 h; the rest go to the digest", () => {
    expect(PAGE_CAP).toBe(3);
    let ledger: PageLedger = EMPTY_LEDGER;
    const tupleFor = (n: number) => ({ ...tuple, errorClass: `class-${n}` });
    for (let n = 0; n < 3; n++) {
      const out = pageRun(null, eligible({ tuple: tupleFor(n) }), ledger, T + n * H);
      expect(out.intent!.delivery).toBe("page");
      ledger = out.ledger;
    }
    const fourth = pageRun(null, eligible({ tuple: tupleFor(4) }), ledger, T + 3 * H);
    expect(fourth.intent).toEqual({ delivery: "digest", reason: "cap" });
    expect(fourth.ledger.attempts).toHaveLength(3);
    // the first attempt leaves the window at exactly 24 h (left-exclusive), freeing one slot
    const later = decidePage(apply(null, eligible({ tuple: tupleFor(5) }), T + 24 * H).record!, eligible({ tuple: tupleFor(5) }), ledger, T + 24 * H);
    expect(later.intent).toEqual({ delivery: "page", reason: "page" });
    expect(later.ledger.attempts.length).toBeLessThanOrEqual(PAGE_CAP);
  });
});
