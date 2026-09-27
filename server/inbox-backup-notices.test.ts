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
