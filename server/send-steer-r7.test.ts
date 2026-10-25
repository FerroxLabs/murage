// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 7 (Astra r6): every non-transcript state of an accepted owner send is a visible chip, the closure of a
// room request and its chip are one transaction (or recovered), the engine only runs what committed, and pruning
// reads an index that holds just the prunable rows.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeOwnerSends, pendingItem, PRUNABLE, sendStore } from "./send-store.ts";
import { drainSteeredMessages, queueSteeredMessage, type SteerStore } from "./steer-queue.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { initializeProjectTables } from "./project-tables.ts";
import {
  completeRequest, insertRoomRequest, markOwnerWordsKept, OWNER_CANCEL_NOTE, ownerSendsOwingWords, roomRequest, cancelRoomRequest, type RoomRequest,
} from "./room-requests.ts";
import { createRoomDispatcher, type RoomDispatcherDeps } from "./room-dispatcher.ts";
import type { BotRecord, Message } from "./store.ts";

const WORDS = "R7_WORDS the person typed";
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); initializeOwnerSends(db); sendStore.use(() => db); });
afterEach(() => { sendStore.reset(); });

/** What index.ts does for a closed owner send (the words become a chip keeping the request's id, then the receipt). */
function keep(request: RoomRequest): void {
  sendStore.accept({
    kind: "group", ownerId: request.groupId, threadId: request.targetThreadId ?? request.rootThreadId, text: request.payloadText!, status: "refused", notice: "refused",
    queueId: request.id, ...(request.sendId ? { sendId: request.sendId } : {}), fingerprint: sendFingerprint(request.payloadText!, undefined, "chat", undefined), mode: "chat",
  });
  markOwnerWordsKept(db, request.id);
}
const ownerSend = (key: string, over: Record<string, unknown> = {}) =>
  insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: key, lineage, targetThreadId: "t", payloadText: WORDS, priority: "owner", now: 1, ...over } as never).request;
const dispatcherDeps = (over: Partial<RoomDispatcherDeps>): RoomDispatcherDeps => ({
  db: () => db, admission: {} as never, now: () => 10, open: () => true, roomUsable: () => false, roomBusy: () => false,
  projectContext: () => undefined, memberIds: () => [], audienceStillValid: () => true, ownerOrigin: () => true,
  startOwnerSend: () => { throw new Error("must not start"); }, startMemberTurn: () => {}, onClosed: () => {}, onStillWaiting: () => {}, changed: () => {},
  ...over,
});

describe("a failed send with no transcript line is a visible chip (r6 P1 #1)", () => {
  it("every receipt-less failure is listed, each is its own chip, and dismissal removes it", () => {
    const rows = ["send-r7-aaaaaaaaaaaaaa01", "send-r7-aaaaaaaaaaaaaa02", "send-r7-aaaaaaaaaaaaaa03"].map((sendId) => {
      const row = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", sendId, text: `${WORDS} ${sendId}`, fingerprint: sendFingerprint(`${WORDS} ${sendId}`) }).row;
      sendStore.markDispatched(row.seq);
      sendStore.settle(row.seq, "failed");
      return row;
    });
    expect(sendStore.pending("t1")).toHaveLength(3);
    expect(sendStore.pendingThreads()).toEqual(["t1"]);
    expect(pendingItem(sendStore.bySeq(rows[0]!.seq)!)).toMatchObject({ state: "refused", text: `${WORDS} send-r7-aaaaaaaaaaaaaa01` });
    expect(sendStore.cancel("bot-1", rows[1]!.queueId)).not.toBeNull();
    expect(sendStore.pending("t1").map((r) => r.seq)).toEqual([rows[0]!.seq, rows[2]!.seq]);
  });

  it("the bot send route settles a send that ran nothing and has no line as refused, never failed", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/else sendStore\.refuse\(row\.seq\);/);
    expect(source).not.toMatch(/else sendStore\.settle\(row\.seq, "failed"\)/);
  });

  it("a late refusal with no steered line becomes a chip", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/if \(!messageId\) \{ try \{ sendStore\.settle\(seq, "refused", undefined, "lateRefused"\)/);
    const row = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", sendId: "send-r7-late-0000000001", text: WORDS, fingerprint: sendFingerprint(WORDS) }).row;
    sendStore.markDispatched(row.seq);
    sendStore.holdForLateAnswer(row.seq);
    sendStore.settle(row.seq, "refused", undefined, "lateRefused");
    expect(sendStore.bySeq(row.seq)).toMatchObject({ status: "refused", text: WORDS, notice: "lateRefused" });
    expect(sendStore.drainable("t1", "bot")).toEqual([]);
  });
});

describe("a closure the system made is not the owner's dismissal (r6 P1 #2)", () => {
  it("only the owner's note or a dismissed chip keeps a send id cancelled; the room's closure resends under a fresh key", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('durable.state === "cancelled" && (durable.outcomeNote === OWNER_CANCEL_NOTE || prior?.status === "cancelled")');
    expect(source).toContain('["failed", "expired", "unknown", "cancelled"].includes(latest.state)');
    expect(source).not.toContain('note: "cancelled by you"');
  });

  it("the owner's cancel leaves no chip; every other closure of an owner send owes one", () => {
    const hookCalls: string[] = [];
    const hooks = { ownerWords: (_d: DatabaseSync, r: RoomRequest) => { hookCalls.push(r.id); keep(r); } };
    const byOwner = ownerSend("o1");
    cancelRoomRequest(db, byOwner.id, { now: 5, note: OWNER_CANCEL_NOTE }, hooks);
    const byRoom = ownerSend("o2");
    completeRequest(db, byRoom.id, { state: "cancelled", now: 5, outcomeNote: "This conversation's audience changed; ask again." }, hooks);
    const done = ownerSend("o3");
    completeRequest(db, done.id, { state: "done", now: 5 }, hooks);
    const expired = ownerSend("o4");
    completeRequest(db, expired.id, { state: "expired", now: 5, outcomeNote: "not answered in time" }, hooks);
    expect(hookCalls).toEqual([byRoom.id, expired.id]);
    expect(sendStore.pending("t").map((r) => r.queueId)).toEqual([byRoom.id, expired.id]);
  });
});

describe("the engine only runs what committed (r6 P1 #3)", () => {
  it("a row whose line could not be written becomes a chip and is not in the prompt", () => {
    const a = queueSteeredMessage("bot-1", "t1", "first words", { sendId: "send-r7-prompt-00000001" });
    const b = queueSteeredMessage("bot-1", "t1", "second words", { sendId: "send-r7-prompt-00000002" });
    const lines: Message[] = [];
    let n = 0;
    const store = {
      bot: () => ({ id: "bot-1", threadId: "t1", busy: false, name: "b" }) as unknown as BotRecord,
      appendMessage: (_t: string, message: Record<string, unknown>, id?: string) => {
        n += 1;
        if (n === 2) throw new Error("disk full");
        const full = { id: id ?? `m${n}`, at: 0, ...message } as unknown as Message;
        lines.push(full);
        return full;
      },
      patchMessage: () => null,
    } as unknown as SteerStore;
    const prompts: string[] = [];
    drainSteeredMessages(store, (_bot, _thread, prompt) => { prompts.push(prompt); });
    expect(prompts).toEqual(["first words"]);
    expect(sendStore.byQueueId("bot-1", a.id)).toMatchObject({ status: "started" });
    expect(sendStore.byQueueId("bot-1", b.id)).toMatchObject({ status: "refused", text: "second words" });
  });
});

describe("every unusable-room closure keeps the owner's words (r6 P1 #4)", () => {
  it("deleting the last member (no members at all) keeps the words of a send pinned to that member", () => {
    const send = ownerSend("last", { toBotId: "only" });
    const kept: string[] = [];
    createRoomDispatcher(dispatcherDeps({ roomExists: () => true, keepOwnerWords: (request) => { kept.push(request.id); keep(request); } })).pump();
    expect(kept).toEqual([send.id]);
    expect(roomRequest(db, send.id)).toMatchObject({ state: "cancelled", refusal: "owner_words_kept", outcomeNote: "The member you picked is no longer in this room; ask again." });
    expect(sendStore.pending("t")).toHaveLength(1);
  });

  it("the room being gone keeps the words too", () => {
    const send = ownerSend("gone");
    const kept: string[] = [];
    createRoomDispatcher(dispatcherDeps({ keepOwnerWords: (request) => { kept.push(request.id); } })).pump();
    expect(kept).toEqual([send.id]);
    expect(roomRequest(db, send.id)!.outcomeNote).toBe("the room is gone");
  });
});

describe("closure and chip are one transaction, or recovered (r6 P1 #5)", () => {
  it("a chip that cannot be written rolls the closure back with it", () => {
    const send = ownerSend("atomic");
    expect(() => completeRequest(db, send.id, { state: "cancelled", now: 5, outcomeNote: "x" }, { ownerWords: () => { throw new Error("ledger write failed"); } })).toThrow();
    expect(roomRequest(db, send.id)!.state).toBe("queued");
  });

  it("a closed owner send with no receipt is found at startup and gets its chip once", () => {
    const send = ownerSend("recover");
    completeRequest(db, send.id, { state: "failed", now: 5, outcomeNote: "could not start" }, {});
    const owing = ownerSendsOwingWords(db, 6);
    expect(owing.map((r) => r.id)).toEqual([send.id]);
    for (const request of owing) keep(request);
    expect(ownerSendsOwingWords(db, 6)).toEqual([]);
    expect(sendStore.pending("t").map((r) => r.queueId)).toEqual([send.id]);
    // an owner cancel and a finished send are never owed a chip
    const cancelled = ownerSend("recover-cancel");
    cancelRoomRequest(db, cancelled.id, { now: 7, note: OWNER_CANCEL_NOTE });
    completeRequest(db, ownerSend("recover-done").id, { state: "done", now: 7 }, {});
    expect(ownerSendsOwingWords(db, 8)).toEqual([]);
  });

  it("the closing paths all go through the hook, and startup recovery runs after the restart reconcile", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("ownerWords: (_db, request) => keepRefusedOwnerSend(request),");
    expect(source).toMatch(/reconcileRoomRequestsAtBoot\(db, Date\.now\(\), roomCompletionHooks\);\n\s*recoverOwnerWords\(\);/);
    expect(source).toMatch(/outcomeNote: "could not start", ending: status\("delegated_turn_could_not_start", \{ why: "setup" \}\) \}, roomCompletionHooks\)\);\n\s*roomRequestsChanged/);
  });
});

describe("pruning reads an eligibility-specific ordered index (r6 P2 #7)", () => {
  const plan = (sql: string, ...args: number[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
  it("both batch selections use owner_sends_prunable and need no sort of the history", () => {
    const age = plan(`SELECT seq FROM owner_sends INDEXED BY owner_sends_prunable WHERE ${PRUNABLE} AND updated_at<? ORDER BY updated_at, seq LIMIT ?`, 1, 200);
    expect(age).toContain("owner_sends_prunable");
    expect(age).not.toContain("TEMP B-TREE");
    const cap = plan(`SELECT seq FROM owner_sends INDEXED BY owner_sends_prunable WHERE ${PRUNABLE} AND (updated_at, seq)<=(?, ?) ORDER BY updated_at, seq LIMIT ?`, 1, 1, 200);
    expect(cap).toContain("owner_sends_prunable");
    expect(cap).not.toContain("TEMP B-TREE");
    const pivot = plan(`SELECT updated_at, seq FROM owner_sends INDEXED BY owner_sends_prunable WHERE ${PRUNABLE} ORDER BY updated_at DESC, seq DESC LIMIT 1 OFFSET ?`, 5000);
    expect(pivot).toContain("owner_sends_prunable");
    expect(pivot).not.toContain("TEMP B-TREE");
  });

  it("still prunes only eligible rows and keeps lateOpen rows", async () => {
    const mk = (id: string) => sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", sendId: id, text: WORDS, fingerprint: sendFingerprint(WORDS + id) }).row;
    const done = mk("send-r7-prune-0000000001");
    sendStore.markDispatched(done.seq); sendStore.settle(done.seq, "started", "line-1");
    const held = mk("send-r7-prune-0000000002");
    sendStore.markDispatched(held.seq); sendStore.settle(held.seq, "unconfirmed", "line-2"); sendStore.holdForLateAnswer(held.seq); sendStore.scrub(held.seq);
    const chip = mk("send-r7-prune-0000000003");
    sendStore.markDispatched(chip.seq); sendStore.refuse(chip.seq);
    const removed = await sendStore.pruneResolved(0, Date.now() + 10_000, 5000, 2);
    expect(removed).toBe(1);
    expect(sendStore.bySeq(done.seq)).toBeUndefined();
    expect(sendStore.bySeq(held.seq)).toBeDefined();
    expect(sendStore.bySeq(chip.seq)).toBeDefined();
  });
});
