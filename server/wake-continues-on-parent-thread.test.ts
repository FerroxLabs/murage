// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 104 High 02-A1: in an ordinary room, A asks B and B asks C. When C ends, B's continuation wake is queued on B's own thread (not a room task).
// That wake is B's to continue: it is usable and starts on that thread, instead of being cancelled as "the room is gone" and taking B with it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { completeRequest, finishRequestTurn, insertRoomRequest, markRequestDispatched, wakeContinuesOnParentThread } from "./room-requests.ts";

let db: DatabaseSync;
const lineage = { rootThreadId: "room-t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); });

function chain() {
  const root = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g1:s1", lineage, payloadText: "hi", now: 1000 }).request;
  const a = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "lead", targetThreadId: "room-t", parentId: root.id, admissionKey: "room_turn:a", now: 1100, priority: "coordinator" }).request;
  markRequestDispatched(db, a.id, { now: 1110 });
  const ask = (parentId: string, from: string, to: string, key: string, now: number) => {
    const q = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: from, toBotId: to, parentId, admissionKey: key, now, payloadText: "check?", returnThreadId: "room-t", returnBotId: from, targetThreadId: `home-${to}` }).request;
    markRequestDispatched(db, q.id, { now: now + 1 });
    return q;
  };
  const b = ask(a.id, "lead", "bea", "ask:b", 1200), c = ask(b.id, "bea", "cal", "ask:c", 1210);
  finishRequestTurn(db, a.id, { ok: true, now: 1250 });
  // B's first turn ends while C is open: B parks. C ends: B's continuation wake is queued on B's own thread.
  completeRequest(db, b.id, { state: "done", now: 1300, resultMessageId: "m-b1" });
  const wake = completeRequest(db, c.id, { state: "done", now: 1400, resultMessageId: "m-c" }).wakes[0]!;
  return { a, b, c, wake };
}

it("a queued continuation wake of a request that ran on its worker's own thread continues on that thread", () => {
  const { b, wake } = chain();
  expect(wake.admissionKey).toBe(`wake:${b.id}`);
  expect(wake.targetThreadId).toBe("home-bea");
  expect(wakeContinuesOnParentThread(db, wake)).toBe(true);
});

it("a wake for another bot, another thread or another kind of key is not that continuation", () => {
  const { wake } = chain();
  expect(wakeContinuesOnParentThread(db, { ...wake, toBotId: "someone" })).toBe(false);
  expect(wakeContinuesOnParentThread(db, { ...wake, targetThreadId: "elsewhere" })).toBe(false);
  expect(wakeContinuesOnParentThread(db, { ...wake, admissionKey: `wake:review:${wake.parentId}:x` })).toBe(false);
  expect(wakeContinuesOnParentThread(db, { ...wake, verb: "room_turn" })).toBe(false);
});

it("the room treats such a wake as usable and starts it on the worker's thread", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  expect(source).toContain("Boolean(store.groupTaskByThread(group.id, threadId)) || wakeContinuesOnParentThread(database(), request)");
  expect(source).toContain("wakeContinuesOnParentThread(database(), request)) { startRequestOnOwnThread(request, claim); return; }");
});
