// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pre-release, owner sends, round 6 (Astra r5):
//   1 a restored owner send older than the retention that still owes its words is recovered and never pruned
//   2 a restored `done` owner send whose room turns were never created is held as a chip, never fanned out
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeProjectTables, prepareProjectTablesForRestore } from "./project-tables.ts";
import {
  insertRoomRequest, markOwnerWordsKept, ownerSendsOwingWords, pruneTerminalRoomRequests, OWNER_CANCEL_NOTE, RESTORE_EXPIRED_NOTE, RESTORE_FANOUT_HELD,
  ROOM_REQUEST_RETENTION_MS,
} from "./room-requests.ts";
import { holdFencedFanouts } from "./restore-fanout.ts";
import { initializeOwnerSends, neutralizeRestoredSends, SendStore } from "./send-store.ts";

const lineage = (rootThreadId: string) => ({ rootThreadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });
const seed = (db: DatabaseSync, key: string, state: string, finishedAt: number, extra = "") => {
  const r = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: key, lineage: lineage("t1"), targetThreadId: "t1", payloadText: "words", sendId: `send-${key}-123456`, priority: "owner", now: 1 } as never).request;
  db.prepare(`UPDATE room_requests SET state=?, finished_at=? ${extra} WHERE id=?`).run(state, finishedAt, r.id);
  return r.id;
};
const count = (db: DatabaseSync) => Number((db.prepare("SELECT COUNT(*) AS n FROM room_requests").get() as { n: number }).n);

describe("1 owed owner words survive age and pruning", () => {
  it("four restore-marked owner sends past the retention are recovered, and a prune keeps them until their words are a chip", () => {
    const db = new DatabaseSync(":memory:");
    initializeProjectTables(db);
    const now = 10 * ROOM_REQUEST_RETENTION_MS;
    const owed = ["failed", "expired", "unknown", "cancelled"].map((state, i) => seed(db, `o${i}`, state, 5));
    const done = seed(db, "done", "done", 5);
    const ownerCancel = seed(db, "oc", "cancelled", 5, `, outcome_note='${OWNER_CANCEL_NOTE}'`);
    prepareProjectTablesForRestore(db, { groups: [], botIds: new Set(), now } as never);
    expect(ownerSendsOwingWords(db, now).map((r) => r.id).sort()).toEqual([...owed].sort());
    expect(ownerSendsOwingWords(db, now).every((r) => r.outcomeNote === RESTORE_EXPIRED_NOTE)).toBe(true);
    // the sweep found the finished send is not shared work and settled its owed row; an unsettled owed row is delivery debt and is never pruned
    db.prepare("DELETE FROM room_request_owed WHERE request_id IN (?,?)").run(done, ownerCancel);
    pruneTerminalRoomRequests(db, now);
    const left = (db.prepare("SELECT id FROM room_requests").all() as Array<{ id: string }>).map((r) => r.id);
    expect(left.sort()).toEqual([...owed].sort());
    expect(left).not.toContain(done);
    expect(left).not.toContain(ownerCancel);
    // once the words are a chip the receipt lets the row age out like any other
    for (const id of owed) markOwnerWordsKept(db, id);
    db.exec("DELETE FROM room_request_owed");   // the sweep settled the owner sends (not shared work)
    pruneTerminalRoomRequests(db, now);
    expect(count(db)).toBe(0);
  });
});

describe("2 a restored done owner send is not fanned out", () => {
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    initializeProjectTables(db);
    initializeOwnerSends(db);
    return { db, sends: new SendStore(() => db) };
  };
  it("the restore fences a childless done root; startup holds it as a chip that only a post-restore Send again runs", () => {
    const { db, sends } = setup();
    const fenced = seed(db, "a", "done", 5, ", result_message_id='m1'");
    const answered = seed(db, "b", "done", 5, ", result_message_id='m2'");
    insertRoomRequest(db, { groupId: "g", verb: "room_turn", fromKind: "owner", admissionKey: "child", lineage: lineage("t1"), targetThreadId: "t1", parentId: answered, priority: "coordinator", now: 2 } as never);
    prepareProjectTablesForRestore(db, { groups: [], botIds: new Set(), now: 9 } as never);
    neutralizeRestoredSends(db);
    const note = (id: string) => (db.prepare("SELECT outcome_note AS n FROM room_requests WHERE id=?").get(id) as { n: string | null }).n;
    expect(note(fenced)).toBe(RESTORE_FANOUT_HELD);
    expect(note(answered)).not.toBe(RESTORE_FANOUT_HELD);
    const lines = [{ id: "m1", role: "user", text: "words" }];
    expect(holdFencedFanouts(db, sends, () => lines)).toBe(1);
    const chip = sends.byQueueId("g", fenced);
    expect(chip).toMatchObject({ status: "refused", restoreHeld: true, text: "words" });
    expect(chip?.restoreGen).toBeTruthy();
    // idempotent, and a dismissed chip is not made again
    expect(holdFencedFanouts(db, sends, () => lines)).toBe(0);
    // the startup fan-out query excludes the fenced root
    const candidates = db.prepare(`SELECT o.id FROM room_requests o WHERE o.verb='owner_send' AND o.state='done' AND o.result_message_id IS NOT NULL AND COALESCE(o.outcome_note,'')<>?
      AND NOT EXISTS (SELECT 1 FROM room_requests c WHERE c.root_id=o.id AND c.id <> o.id)`).all(RESTORE_FANOUT_HELD);
    expect(candidates).toEqual([]);
  });
  it("a done root whose line is not the thread's last is not held", () => {
    const { db, sends } = setup();
    seed(db, "a", "done", 5, ", result_message_id='m1'");
    prepareProjectTablesForRestore(db, { groups: [], botIds: new Set(), now: 9 } as never);
    expect(holdFencedFanouts(db, sends, () => [{ id: "m1", role: "user", text: "words" }, { id: "m2", role: "bot", text: "hi" }])).toBe(0);
  });
});
