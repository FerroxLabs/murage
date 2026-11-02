// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { withBackupNotices } from "./inbox-backup-notices.ts";

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

// Sean 11-01: only what the owner must act on reaches the Inbox, as an item counted once.
describe("Health on the Inbox read", () => {
  const need = (titleKey = "health.backup.not-protected") => ({ titleKey, issues: 1, lastSeenAt: 2 });
  const health = (needs: ReturnType<typeof need>[], level: "act" | "watch" | "note" | null = needs.length ? "act" : null) => ({ status: "ready" as const, level, needs });
  it("counts each need once, and a need brings no card of its own for the same stopped backup", () => {
    expect(withBackupNotices(page, { health: health([need()]) }).decisions).toBe(4);
    const both = withBackupNotices(page, { backupFailed: failed, health: health([need()]) });
    expect(both.decisions).toBe(4);
    expect(both.backupFailed).toEqual(failed);
    expect(both.health?.needs).toEqual([]);
  });
  it("a need that is not the same condition still counts beside a stopped backup", () => {
    const body = withBackupNotices(page, { backupFailed: failed, health: health([need("health.backup.other")]) });
    expect(body.decisions).toBe(5);
  });
  it("a watch or a note adds nothing to the count", () => {
    for (const level of ["watch", "note", null] as const) {
      const body = withBackupNotices(page, { health: health([], level) });
      expect(body.decisions).toBe(3);
      expect(body.health?.level).toBe(level);
    }
  });
  it("never attaches Health to a read that did not pass it (less privileged reads)", () => {
    const body = withBackupNotices(page, { backupFailed: failed });
    expect("health" in body).toBe(false);
    expect(body.backupFailed).toEqual(failed);
    expect(withBackupNotices(page, { health: null })).toBe(page);
  });
});
