// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S01 backups never completing: exact thresholds at one below / at / one above, page eligibility only for "no current
// verified backup", recovery only on a later committed verification, and Off as policy, not a fault.
import { describe, expect, it } from "vitest";
import { parseBackupStatus, type BackupStatus } from "../../../shared/health-protocol.mjs";
import { BACKUP_CAPTURE_OVERRUN_MS, BACKUP_DUE_GRACE_MS, BACKUP_FIRST_VERIFY_MS, BACKUP_MAX_AGE_MS, backupDetector } from "./backup.ts";
import { HOUR_MS, INST, T0, byClass, input, scans } from "./fixtures.ts";

const C = T0; // configuredAt
function status(over: Partial<BackupStatus> = {}): BackupStatus {
  const raw = {
    schemaVersion: 1, installationId: INST, revision: 1, at: T0, enabled: true, configuredAt: C, policyRevision: 1, dueAt: null, nextDueAt: null,
    phase: "idle", currentBindingMatches: true, lastVerified: null, coverage: "complete", ...over,
  };
  const parsed = parseBackupStatus(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}
const verified = (verifiedAt: number) => ({ verifiedAt, snapshotToken: "abcdef0123456789", bytes: 1024, verification: "artifact-reread" as const });
const once = (s: BackupStatus | null, now: number) => backupDetector.evaluate(input({ now, backupStatus: s }), null).results;

describe("S01 backup detector", () => {
  it("thresholds are the design values", () => {
    expect(BACKUP_FIRST_VERIFY_MS).toBe(24 * HOUR_MS);
    expect(BACKUP_DUE_GRACE_MS).toBe(6 * HOUR_MS);
    expect(BACKUP_MAX_AGE_MS).toBe(48 * HOUR_MS);
    expect(BACKUP_CAPTURE_OVERRUN_MS).toBe(5 * 60_000);
  });

  it("no verified receipt: nothing at 24 h minus 1 ms, High and page-eligible at and after 24 h", () => {
    expect(byClass(once(status(), C + 24 * HOUR_MS - 1), "not-protected")!.triggered).toBeNull();
    for (const now of [C + 24 * HOUR_MS, C + 24 * HOUR_MS + 1]) {
      const r = byClass(once(status(), now), "not-protected")!;
      expect(r.triggered).toBe("high");
      expect(r.pageEligible).toBe(true);
    }
  });

  it("one explicit capture failure with no current-binding receipt is High and page-eligible at once", () => {
    const r = byClass(once(status({ phase: "failed", failureCode: "capture-failed", failureAt: C + 60_000 }), C + 120_000), "not-protected")!;
    expect(r.triggered).toBe("high");
    expect(r.pageEligible).toBe(true);
  });

  it("a receipt under a changed binding is not current protection", () => {
    const s = status({ currentBindingMatches: false, lastVerified: verified(C + 1000), failureCode: "binding-changed", failureAt: C + 2000 });
    expect(byClass(once(s, C + 3000), "not-protected")!.triggered).toBe("high");
  });

  it("a receipt whose binding could not be checked is never current: no recovery, partial coverage, and its 24 h rule waits", () => {
    const unknown = status({ currentBindingMatches: null, lastVerified: verified(C + 1000) });
    const r = byClass(once(unknown, C + 25 * HOUR_MS), "not-protected")!;
    expect(r.triggered).toBeNull();
    expect(r.recovery).toEqual({ positive: false, complete: false });
    expect(r.coverage).toBe("partial");
    // an explicit failure still stands on its own
    const failed = status({ currentBindingMatches: null, lastVerified: verified(C + 1000), phase: "failed", failureCode: "capture-failed", failureAt: C + 2000 });
    expect(byClass(once(failed, C + 3000), "not-protected")!.triggered).toBe("high");
    // an open issue is never resolved by an unknown binding
    const run = scans(backupDetector, [input({ now: C + 3000, backupStatus: failed }), input({ now: C + 4000, backupStatus: { ...unknown, revision: 2 } })]);
    expect(byClass(run.results[1]!, "not-protected")!.recovery.complete).toBe(false);
  });

  it("a binding that comes back does not resolve not-protected: only a later committed verification does", () => {
    const changed = status({ currentBindingMatches: false, lastVerified: verified(C + 1000), failureCode: "binding-changed", failureAt: C + 2000 });
    const restored = status({ currentBindingMatches: true, lastVerified: verified(C + 1000), revision: 2 });
    const newer = status({ currentBindingMatches: true, lastVerified: verified(C + 5000), revision: 3 });
    const run = scans(backupDetector, [input({ now: C + 3000, backupStatus: changed }), input({ now: C + 4000, backupStatus: restored }), input({ now: C + 6000, backupStatus: newer })]);
    expect(byClass(run.results[0]!, "not-protected")!.triggered).toBe("high");
    expect(byClass(run.results[1]!, "not-protected")!.recovery.complete).toBe(false);
    expect(byClass(run.results[2]!, "not-protected")!.recovery.complete).toBe(true);
  });

  it("overdue: a manifest that stops updating still comes due at its published next occurrence plus 6 h", () => {
    const monday = C + 24 * HOUR_MS;
    const tuesday = monday + 24 * HOUR_MS;
    // Written after Monday's backup: nothing due, the next occurrence Tuesday. Then nothing more is ever written.
    const stale = status({ lastVerified: verified(monday), dueAt: null, nextDueAt: tuesday });
    const at = (now: number) => input({ now, backupStatus: stale });
    const run = scans(backupDetector, [at(tuesday - 1000), at(tuesday + 6 * HOUR_MS), at(tuesday + 6 * HOUR_MS + 1), at(tuesday + 7 * HOUR_MS)]);
    expect(run.results.map(scan => byClass(scan, "overdue")!.triggered)).toEqual([null, null, "high", "high"]);
    expect(run.results.reduce((n, scan) => n + byClass(scan, "overdue")!.occurrences, 0)).toBe(1);
    // a verification at or after that occurrence meets it
    const met = status({ lastVerified: verified(tuesday + 60_000), dueAt: null, nextDueAt: tuesday, revision: 2 });
    const after = scans(backupDetector, [input({ now: tuesday + 7 * HOUR_MS + 1, backupStatus: met })], run.state);
    expect(byClass(after.last, "overdue")!.triggered).toBeNull();
  });

  it("F:20 trace: five failures with no verified success count five occurrences, each once", () => {
    const inputs = [1, 2, 3, 4, 5].flatMap(n => {
      const s = status({ phase: "failed", failureCode: "capture-failed", failureAt: C + n * HOUR_MS, revision: n });
      // each failure is seen by two scans: the second must not re-count it
      return [input({ now: C + n * HOUR_MS + 1, backupStatus: s }), input({ now: C + n * HOUR_MS + 120_000, backupStatus: s })];
    });
    const { results } = scans(backupDetector, inputs);
    const total = results.reduce((n, scan) => n + byClass(scan, "not-protected")!.occurrences, 0);
    expect(total).toBe(5);
    expect(results.every(scan => byClass(scan, "not-protected")!.triggered === "high")).toBe(true);
    // no overdue or stall claims without a receipt or a capture in progress
    expect(results.every(scan => byClass(scan, "overdue")!.triggered === null && byClass(scan, "capture-stalled")!.triggered === null)).toBe(true);
  });

  it("overdue: strictly after dueAt + 6 h, digest only", () => {
    const due = C + 30 * HOUR_MS;
    const s = status({ lastVerified: verified(due - HOUR_MS), dueAt: due });
    expect(byClass(once(s, due + 6 * HOUR_MS - 1), "overdue")!.triggered).toBeNull();
    expect(byClass(once(s, due + 6 * HOUR_MS), "overdue")!.triggered).toBeNull();
    const r = byClass(once(s, due + 6 * HOUR_MS + 1), "overdue")!;
    expect(r.triggered).toBe("high");
    expect(r.pageEligible).toBe(false);
    expect(byClass(once(s, due + 6 * HOUR_MS + 1), "not-protected")!.triggered).toBeNull();
  });

  it("overdue: latest verification strictly older than 48 h", () => {
    const v = C + HOUR_MS;
    const s = status({ lastVerified: verified(v) });
    expect(byClass(once(s, v + 48 * HOUR_MS), "overdue")!.triggered).toBeNull();
    expect(byClass(once(s, v + 48 * HOUR_MS + 1), "overdue")!.triggered).toBe("high");
  });

  it("waiting for an owner card still ages the backup and is reported as waiting", () => {
    const v = C + HOUR_MS;
    const r = byClass(once(status({ lastVerified: verified(v), phase: "waiting-owner", pendingOwnerSince: v + HOUR_MS }), v + 49 * HOUR_MS), "overdue")!;
    expect(r.triggered).toBe("high");
    expect(r.metrics.waitingOwner).toBe(1);
  });

  it("capture stalled: at and after 5 min past the published deadline, not before", () => {
    const d = C + 2 * HOUR_MS;
    const s = status({ lastVerified: verified(C + HOUR_MS), phase: "capturing", captureDeadlineAt: d });
    expect(byClass(once(s, d + 5 * 60_000 - 1), "capture-stalled")!.triggered).toBeNull();
    expect(byClass(once(s, d + 5 * 60_000), "capture-stalled")!.triggered).toBe("high");
    expect(byClass(once(s, d + 5 * 60_000 + 1), "capture-stalled")!.pageEligible).toBe(false);
  });

  it("recovers only on a later committed current-binding verification", () => {
    const failing = status({ phase: "failed", failureCode: "capture-failed", failureAt: C + 1000 });
    const healed = status({ lastVerified: verified(C + HOUR_MS), revision: 2 });
    const { results } = scans(backupDetector, [input({ now: C + 2000, backupStatus: failing }), input({ now: C + 2 * HOUR_MS, backupStatus: healed })]);
    expect(byClass(results[0]!, "not-protected")!.recovery.complete).toBe(false);
    expect(byClass(results[1]!, "not-protected")!.recovery).toEqual({ positive: true, complete: true });

    // overdue recovers only with a verification newer than the one that went stale
    const v = C + HOUR_MS;
    const stale = status({ lastVerified: verified(v) });
    const fresh = status({ lastVerified: verified(v + 50 * HOUR_MS), revision: 3 });
    const run = scans(backupDetector, [input({ now: v + 49 * HOUR_MS, backupStatus: stale }), input({ now: v + 49 * HOUR_MS + 1, backupStatus: { ...stale, at: T0 + 1 } }), input({ now: v + 50 * HOUR_MS + 1, backupStatus: fresh })]);
    expect(byClass(run.results[1]!, "overdue")!.triggered).toBe("high");
    expect(byClass(run.results[2]!, "overdue")!.recovery.complete).toBe(true);
  });

  it("partial coverage cannot establish recovery", () => {
    const r = byClass(once(status({ coverage: "partial", lastVerified: verified(C) }), C + 1000), "not-protected")!;
    expect(r.coverage).toBe("partial");
    expect(r.recovery.complete).toBe(false);
  });

  it("disabling backups retires every class as policy-ended, never recovered", () => {
    const rs = once(status({ enabled: false, phase: "off" }), C + 100 * HOUR_MS);
    expect(rs).toHaveLength(3);
    for (const r of rs) {
      expect(r.retired).toBe("policy-ended");
      expect(r.triggered).toBeNull();
      expect(r.recovery.complete).toBe(false);
    }
  });

  it("a missing or foreign manifest is unavailable coverage, never a fault or an all clear", () => {
    for (const s of [null, { ...status(), installationId: "ffffffffffffffffffffffffffffffff" }]) {
      for (const r of once(s, C + 100 * HOUR_MS)) {
        expect(r.coverage).toBe("unavailable");
        expect(r.triggered).toBeNull();
        expect(r.recovery.positive).toBe(false);
      }
    }
  });
});
