// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { healthCoversBackup, withBackupNotices } from "./inbox-backup-notices.ts";

const page = { items: [], total: 3, decisions: 3, approvals: 0, questions: 0, connections: 3 };
const failed = { sentence: "The last backup stopped.", at: 1 };
const waiting = { bots: [{ threadId: "t1", name: "Pickle" }] } as never;

describe("the backup rows on the Inbox read (rt4 L2)", () => {
  it("counts a backup that stopped in Needs you, and in no segment", () => {
    const body = withBackupNotices(page, { backupFailed: failed });
    expect(body.backupFailed).toEqual(failed);
    expect(body.decisions).toBe(4);
    expect([body.approvals, body.questions, body.connections]).toEqual([0, 0, 3]);
  });

  it("does not count a backup waiting on a card, because the card is counted", () => {
    const body = withBackupNotices(page, { backupWaiting: waiting });
    expect(body.backupWaiting).toBe(waiting);
    expect(body.decisions).toBe(3);
  });

  it("counts the stopped backup once when both rows show", () => {
    expect(withBackupNotices(page, { backupWaiting: waiting, backupFailed: failed }).decisions).toBe(4);
  });

  it("leaves the read alone when there is neither, and a body with no count stays without one", () => {
    expect(withBackupNotices(page, { backupWaiting: null, backupFailed: null })).toBe(page);
    const error = { error: "nope" } as { error: string; decisions?: number };
    expect(withBackupNotices(error, { backupFailed: failed }).decisions).toBeUndefined();
  });
});

// 1.0.9 Sentinel: a stopped backup that Sentinel's backup issue covers is shown inside the owner's Health card, once.
describe("the stopped backup inside Health (1.0.9 Sentinel)", () => {
  const row = (detectorId: string, state = "open") => ({ fingerprint: "f".repeat(64), detectorId, titleKey: "health.backup.not-protected", severity: "high", state, delivery: "page",
    firstSeenAt: 1, lastSeenAt: 2, count: 1, coverage: "complete", nextAction: "backups" }) as never;
  const health = (rows: never[], status: "ready" | "waiting" = "ready") => ({ status, summary: null, rows, digest: null });
  it("moves the notice into Health when S01 is open there, keeping its sentence and counting it once", () => {
    const body = withBackupNotices(page, { backupFailed: failed, health: health([row("backup")]) });
    expect(body.backupFailed).toEqual({ ...failed, inHealth: true });
    expect(body.decisions).toBe(4);
    expect(body.health?.rows).toHaveLength(1);
    expect(healthCoversBackup(body.health)).toBe(true);
  });
  it("keeps the separate card when Health has no open backup issue, or is not ready", () => {
    for (const h of [health([]), health([row("io-pressure")]), health([row("backup", "resolved")]), health([row("backup")], "waiting")]) {
      const body = withBackupNotices(page, { backupFailed: failed, health: h });
      expect(body.backupFailed).toEqual(failed);
      expect(body.decisions).toBe(4);
    }
  });
  it("never attaches Health to a read that did not pass it (less privileged reads)", () => {
    const body = withBackupNotices(page, { backupFailed: failed });
    expect("health" in body).toBe(false);
    expect(body.backupFailed).toEqual(failed);
    expect(withBackupNotices(page, { health: null })).toBe(page);
  });
  it("adds no attention of its own: Health alone leaves the counts untouched", () => {
    const body = withBackupNotices(page, { health: health([row("backup")]) });
    expect(body.decisions).toBe(3);
    expect(body.backupFailed).toBeUndefined();
  });
});
