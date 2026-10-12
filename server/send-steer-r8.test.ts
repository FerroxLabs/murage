// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 8 (Astra r7 P1): the words of a deleted conversation never come back as a chip. Deleting the thread scrubs
// its room requests, chip creation refuses a conversation that is gone, and startup purges what was already orphaned.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, deleteThread, insertMessage } from "./message-db.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { sendStore, ThreadGoneError } from "./send-store.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import {
  completeRequest, insertRoomRequest, ownerSendsOwingWords, roomRequest, scrubOwnerSendsOfGoneThreads, markOwnerWordsKept, type RoomRequest,
} from "./room-requests.ts";

const WORDS = "R8_WORDS the person typed";
const lineage = { rootThreadId: "t-del", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const ownerSend = (key: string, threadId: string) =>
  insertRoomRequest(database(), { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: key, lineage: { ...lineage, rootThreadId: threadId }, targetThreadId: threadId, payloadText: WORDS, priority: "owner", now: 1 } as never).request;
const rows = () => (database().prepare("SELECT thread_id AS t FROM owner_sends").all() as Array<{ t: string }>).map((r) => r.t);

/** What index.ts does for a closed owner send, with the live-thread gate. */
function keep(request: RoomRequest): void {
  try {
    sendStore.accept({
      kind: "group", ownerId: request.groupId, threadId: request.targetThreadId ?? request.rootThreadId, text: request.payloadText!, status: "refused", notice: "refused",
      queueId: request.id, fingerprint: sendFingerprint(request.payloadText!, undefined, "chat", undefined), mode: "chat",
    });
    markOwnerWordsKept(database(), request.id);
  } catch (error) { if (!(error instanceof ThreadGoneError)) throw error; }
}

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  initializeProjectTables(database());
  sendStore.use(() => database());
});
afterEach(() => { sendStore.reset(); closeMessageDb(); });

describe("a deleted conversation's words stay deleted (r7 P1)", () => {
  it("deleting the thread, then closing its running request, makes no chip", () => {
    insertMessage("t-del", { id: "m1", role: "user", kind: "text", text: "hi", at: 1 });
    const request = ownerSend("k-run", "t-del");
    database().prepare("UPDATE room_requests SET state='running' WHERE id=?").run(request.id);
    deleteThread("t-del");
    expect(roomRequest(database(), request.id)!.payloadText).toBeNull();
    completeRequest(database(), request.id, { state: "failed", now: 5 }, { ownerWords: (_db, done) => keep(done) });
    expect(rows()).toEqual([]);
    expect(sendStore.pending("t-del")).toEqual([]);
  });

  it("deleting the thread cancels its queued request and nothing is left owing", () => {
    const request = ownerSend("k-queued", "t-del");
    deleteThread("t-del");
    const after = roomRequest(database(), request.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.payloadText).toBeNull();
    expect(ownerSendsOwingWords(database(), 10)).toEqual([]);
  });

  it("recovery after deletion makes no chip for a request that closed before the delete", () => {
    const request = ownerSend("k-closed", "t-del");
    database().prepare("UPDATE room_requests SET state='running' WHERE id=?").run(request.id);
    completeRequest(database(), request.id, { state: "failed", now: 5 });
    expect(ownerSendsOwingWords(database(), 10)).toHaveLength(1);
    deleteThread("t-del");
    expect(ownerSendsOwingWords(database(), 10)).toEqual([]);
  });

  it("the ledger refuses a refused chip for a conversation that is gone, in the same transaction", () => {
    sendStore.setThreadGate((threadId) => threadId !== "t-gone");
    const make = (threadId: string) => sendStore.accept({ kind: "group", ownerId: "g", threadId, text: WORDS, status: "refused", notice: "refused", fingerprint: sendFingerprint(WORDS) });
    expect(() => make("t-gone")).toThrow(ThreadGoneError);
    expect(rows()).toEqual([]);
    expect(make("t-live").kind).toBe("new");
    expect(rows()).toEqual(["t-live"]);
  });

  it("startup purges owner_sends rows of threads and owners that no longer exist, and scrubs gone requests", () => {
    for (const [threadId, ownerId, kind] of [["t-live", "bot-live", "bot"], ["t-gone", "bot-live", "bot"], ["t-live2", "g-gone", "group"]] as const) {
      sendStore.accept({ kind, ownerId, threadId, text: `${WORDS} ${threadId}`, status: "refused", notice: "refused", fingerprint: sendFingerprint(threadId) });
    }
    const orphanRequest = ownerSend("k-orphan", "t-gone");
    const liveRequest = ownerSend("k-live", "t-live");
    const touched = sendStore.purgeOrphans((threadId, ownerId) => threadId !== "t-gone" && ownerId !== "g-gone");
    expect(touched.sort()).toEqual(["t-gone", "t-live2"]);
    expect(rows()).toEqual(["t-live"]);
    scrubOwnerSendsOfGoneThreads(database(), (threadId) => threadId !== "t-gone");
    expect(roomRequest(database(), orphanRequest.id)!.payloadText).toBeNull();
    expect(roomRequest(database(), liveRequest.id)!.payloadText).toBe(WORDS);
  });
});
