// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeOwnerSends, neutralizeRestoredSends, SendStore } from "./send-store.ts";
import { initializeSendAttempts, SendAttemptStore } from "./send-attempt-state.ts";
import { initializeOwnerLimitStorage } from "./owner-limit-continuation.ts";
import { fenceRestoredSql, RESTORE_FENCED_STORES } from "./restore-fence.ts";

const connections: DatabaseSync[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); connections.push(db);
  initializeOwnerSends(db); initializeSendAttempts(db);
  const sends = new SendStore(() => db), attempts = new SendAttemptStore(db);
  const input = { kind: "group" as const, ownerId: "room", threadId: "thread", sendId: "original-send", text: "kept words", fingerprint: "kept fingerprint", status: "queued" as const, isolated: true };
  const row = sends.accept(input).row;
  return { db, sends, attempts, input, row };
}

describe("review restore receipts", () => {
  it("retains a receipt-backed room chip when a replacement request retires it", () => {
    const { db, sends, row } = fixture();
    sends.settle(row.seq, "refused", undefined, "refused");
    neutralizeRestoredSends(db, "first-restore");
    const receipt = sends.attemptFor(sends.bySeq(row.seq)!)!;
    const before = sends.bySeq(row.seq)!;
    sends.retire(row.seq);
    expect(sends.bySendId(row.threadId, row.sendId!)).toEqual(before);
    neutralizeRestoredSends(db, "second-restore");
    expect(sends.bySeq(row.seq)).toMatchObject({ text: "kept words", status: "refused", restoreHeld: true, restoreGen: "second-restore" });
    expect(sends.attemptFor(sends.bySeq(row.seq)!)).toEqual(receipt);
  });

  it("settles a restored unbound queue receipt and admits only a current-token fresh press", () => {
    const { db, sends, input, row } = fixture();
    neutralizeRestoredSends(db, "first-restore");
    const original = sends.attemptFor(sends.bySeq(row.seq)!)!;
    expect(original).toMatchObject({ phase: "terminal", terminalOutcome: "refused", delivery: "not_submitted", isolated: true, queueOnly: true, replayPolicy: "exclude" });
    neutralizeRestoredSends(db, "second-restore");
    expect(sends.accept({ ...input, resend: true, actionId: "stale-press", restoreGen: "first-restore" }).kind).toBe("existing");
    expect(sends.bySendId(input.threadId, "r-stale-press")).toBeUndefined();
    const result = sends.accept({ ...input, resend: true, actionId: "fresh-press", restoreGen: "second-restore" });
    expect(result.kind).toBe("new");
    expect(result.row).toMatchObject({ sendId: "r-fresh-press", status: "queued", restoreHeld: false, isolated: true, queueOnly: true });
    expect(sends.attemptFor(sends.bySeq(row.seq)!)).toEqual(original);
    expect(sends.accept({ ...input, resend: true, actionId: "fresh-press", restoreGen: "second-restore" }).kind).toBe("existing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM send_attempts").get()).toEqual({ n: 2 });
  });

  it("does not manufacture terminal delivery proof for a bound or uncertain attempt", () => {
    const { db, sends, attempts, input, row } = fixture();
    const receipt = sends.attemptFor(row)!;
    const key = attempts.bind([receipt.attemptId], { generation: "provider-generation", providerInstanceId: "fake-provider" })[0]!;
    attempts.recordInvocation(key, attempts.byId(receipt.attemptId)!.revision, false);
    const before = attempts.byId(receipt.attemptId)!;
    const binding = db.prepare("SELECT * FROM send_attempt_bindings WHERE attempt_id=?").get(receipt.attemptId);
    neutralizeRestoredSends(db, "current-restore");
    expect(attempts.byId(receipt.attemptId)).toEqual(before);
    expect(db.prepare("SELECT * FROM send_attempt_bindings WHERE attempt_id=?").get(receipt.attemptId)).toEqual(binding);
    expect(() => sends.accept({ ...input, resend: true, actionId: "unsafe-press", restoreGen: "current-restore" })).toThrow();
    expect(sends.bySendId(input.threadId, "r-unsafe-press")).toBeUndefined();
  });

  it("inventories owner-limit applications and removes every pre-restore execution ticket", () => {
    const db = new DatabaseSync(":memory:"); connections.push(db); initializeOwnerLimitStorage(db);
    for (const state of ["pending", "submitted"]) db.prepare("INSERT INTO owner_limit_applications VALUES(?,?,1,?,?)").run(state, "thread", state, "{}");
    const entry = RESTORE_FENCED_STORES.find(item => item.tables?.includes("owner_limit_applications"));
    expect(entry).toMatchObject({ mode: "dropped" });
    fenceRestoredSql(db, "current-restore");
    expect(db.prepare("SELECT COUNT(*) AS n FROM owner_limit_applications").get()).toEqual({ n: 0 });
    for (const proof of entry!.proof!) expect(db.prepare(proof).get()).toEqual({ n: 0 });
  });
});
