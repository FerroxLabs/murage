// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parsePhoneSendId } from "../send-idempotency.ts";
import { SendStore } from "../send-store.ts";
import { PhoneReceipts, phoneSendId } from "./receipts.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new SendStore(() => db);
  return { db, store, receipts: new PhoneReceipts(db, store) };
}
const ID = "s".repeat(16);

describe("PhoneReceipts", () => {
  it("receive inserts once and returns the existing row on a repeat", () => {
    const { receipts } = setup();
    const a = receipts.receive({ deviceId: "d1", kind: "share", id: ID, fingerprint: "f", generation: 2, allocatedThreadId: "t1", itemHashes: ["h"] });
    expect(a).toMatchObject({ deviceId: "d1", kind: "share", id: ID, state: "received", allocatedThreadId: "t1", itemHashes: ["h"], result: null, code: null });
    const b = receipts.receive({ deviceId: "d1", kind: "share", id: ID, fingerprint: "other", generation: 9, allocatedThreadId: "t2" });
    expect(b.fingerprint).toBe("f");
    expect(b.allocatedThreadId).toBe("t1");
    expect(receipts.get("d1", "ask", ID)).toBeNull();
  });
  it("a new-target share gets an allocated thread id here, and it is kept on a repeat", () => {
    const { receipts } = setup();
    const a = receipts.receive({ deviceId: "d1", kind: "share", id: ID, fingerprint: "f", generation: 1, newTarget: true });
    expect(a.allocatedThreadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipts.receive({ deviceId: "d1", kind: "share", id: ID, fingerprint: "f", generation: 1, newTarget: true }).allocatedThreadId).toBe(a.allocatedThreadId);
  });
  it("plan and setFiles persist on the row", () => {
    const { receipts } = setup();
    receipts.receive({ deviceId: "d1", kind: "share", id: ID, fingerprint: "f", generation: 1 });
    const planned = [{ n: 0, uploadId: "u".repeat(16), ext: "png", kind: "image" as const, mime: "image/png" }];
    receipts.plan("d1", "share", ID, planned);
    const files = [{ kind: "image" as const, path: "p.png", mime: "image/png" }];
    receipts.setFiles("d1", "share", ID, files);
    expect(receipts.get("d1", "share", ID)).toMatchObject({ planned, files });
  });
  it("rows older than 30 days are pruned at construction", () => {
    const { db, store } = setup();
    const first = new PhoneReceipts(db, store, { now: () => 1_000 });
    first.receive({ deviceId: "d1", kind: "ask", id: ID, fingerprint: "f", generation: 1 });
    new PhoneReceipts(db, store, { now: () => 1_000 + 29 * 86_400_000 });
    expect(first.get("d1", "ask", ID)).not.toBeNull();
    new PhoneReceipts(db, store, { now: () => 1_000 + 31 * 86_400_000 });
    expect(first.get("d1", "ask", ID)).toBeNull();
  });
  it("receipts and sends share one handle (AS11)", () => {
    const { store } = setup();
    expect(() => new PhoneReceipts(new DatabaseSync(":memory:"), store)).toThrow();
  });
});

describe("phoneSendId", () => {
  it("is namespaced by kind and device, and matches the phone id shape", () => {
    const ids = [phoneSendId("share", "d1", "X".repeat(16)), phoneSendId("share", "d2", "X".repeat(16)), phoneSendId("ask", "d1", "X".repeat(16))];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(parsePhoneSendId(id)).toBe(id);
    expect(ids[0]).toMatch(/^phone:share:[A-Za-z0-9_-]{43}$/);
  });
});
