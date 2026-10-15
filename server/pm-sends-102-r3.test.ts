// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pre-release, owner sends, round 3 (Astra r2):
//   A owner words are dropped only against a durable record of the OWNER's deletion, never on absence
//   C a Send again token belongs to one restore generation; a later restore makes it stale
//   E the room-request ownerWords hook publishes only after its transaction commits
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, deleteThread } from "./message-db.ts";
import { ownerDeletedThread, recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { completeRequest, insertRoomRequest, roomRequest, scrubOwnerSendsOfGoneThreads } from "./room-requests.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { currentRestoreGeneration, initializeOwnerSends, neutralizeRestoredSends, pendingItem, restoreGenerationCurrent, sendStore, SendStore } from "./send-store.ts";
import { importLegacyQueueFile } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { afterCommit, scopedTx } from "./tx-scope.ts";

const WORDS = "R3_WORDS the person typed";
const lineage = (rootThreadId: string) => ({ rootThreadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });
const ownerSend = (key: string, threadId: string) =>
  insertRoomRequest(database(), { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: key, lineage: lineage(threadId), targetThreadId: threadId, payloadText: WORDS, priority: "owner", now: 1 } as never).request;
const rows = () => (database().prepare("SELECT thread_id AS t FROM owner_sends ORDER BY seq").all() as Array<{ t: string }>).map((r) => r.t);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("A owner deletion is the only proof that lets owner words go", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    initializeProjectTables(database());
    sendStore.use(() => database());
  });
  afterEach(() => { sendStore.reset(); closeMessageDb(); });

  const chip = (threadId: string) => sendStore.accept({ kind: "bot", ownerId: "b", threadId, text: `${WORDS} ${threadId}`, status: "refused", notice: "refused", fingerprint: sendFingerprint(threadId) });

  it("an empty or partial registry destroys nothing: no purge, no scrub, however the registry answers", () => {
    chip("t1"); chip("t2");
    const request = ownerSend("k1", "t1");
    expect(sendStore.purgeOrphans(() => false)).toEqual([]); // empty registry: nothing is live
    expect(scrubOwnerSendsOfGoneThreads(database(), () => false)).toBe(0);
    expect(sendStore.purgeOrphans((t) => t === "t2")).toEqual([]); // partial registry
    expect(rows()).toEqual(["t1", "t2"]);
    expect(roomRequest(database(), request.id)!.payloadText).toBe(WORDS);
  });

  it("a recorded owner deletion purges exactly that conversation's rows and room payloads", () => {
    chip("t1"); chip("t2");
    const gone = ownerSend("k-gone", "t1"), kept = ownerSend("k-kept", "t2");
    recordOwnerDeletion(database(), "t1");
    expect(sendStore.purgeOrphans(() => false)).toEqual(["t1"]);
    expect(scrubOwnerSendsOfGoneThreads(database(), () => false)).toBe(1);
    expect(rows()).toEqual(["t2"]);
    expect(roomRequest(database(), gone.id)!.payloadText).toBeNull();
    expect(roomRequest(database(), kept.id)!.payloadText).toBe(WORDS);
  });

  it("the store's own deletions record the tombstone: bot, task, channel and its tasks", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Second", false)!;
    store.deleteTask(bot.id, task.threadId);
    expect(ownerDeletedThread(database(), task.threadId)).toBe(true);
    expect(ownerDeletedThread(database(), bot.threadId)).toBe(false);
    const group = store.createGroup("Room", [bot.id]);
    store.deleteGroup(group.id);
    expect(ownerDeletedThread(database(), group.threadId)).toBe(true);
    expect(ownerDeletedThread(database(), "group:" + group.id)).toBe(true);
    store.deleteBot(bot.id);
    expect(ownerDeletedThread(database(), bot.threadId)).toBe(true);
  });

  it("deleting a thread still takes its sends and room words with it, in the same transaction as the record", () => {
    chip("t1");
    const request = ownerSend("k1", "t1");
    deleteThread("t1");
    expect(ownerDeletedThread(database(), "t1")).toBe(true);
    expect(rows()).toEqual([]);
    expect(roomRequest(database(), request.id)!.payloadText).toBeNull();
  });

  it("legacy queued-messages.json: lines of an unrecognised conversation stay until the owner's deletion is recorded; then the file goes", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pm-r3-")), "queued-messages.json");
    dirs.push(join(file, ".."));
    writeFileSync(file, JSON.stringify([["gone", { botId: "b", items: [{ messageId: "a", text: "x", prompt: "x" }] }]]));
    const store = { appendMessage: () => ({}), messagesFor: () => [] };
    const ownerDeleted = (t: string) => ownerDeletedThread(database(), t);
    const logs: string[] = [];
    expect(importLegacyQueueFile(file, store, { threadIsLive: () => false, ownerDeleted, atomically: (w) => w(), log: (m) => logs.push(m) }).removed).toBe(false);
    expect(existsSync(file)).toBe(true);
    recordOwnerDeletion(database(), "gone");
    expect(importLegacyQueueFile(file, store, { threadIsLive: () => false, ownerDeleted, atomically: (w) => w(), log: (m) => logs.push(m) }).removed).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe("C a Send again token is bound to one restore generation", () => {
  const input = { kind: "bot" as const, ownerId: "b1", threadId: "t1", text: "do the thing", sendId: "s1", fingerprint: sendFingerprint("do the thing") };
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    const store = new SendStore(() => db);
    store.accept({ ...input, status: "queued" });
    neutralizeRestoredSends(db);
    return { db, store };
  };

  it("the held chip carries the token; the same id without it, or with a guess, stays held", () => {
    const { store } = setup();
    const row = store.bySendId("t1", "s1")!;
    expect(row.restoreGen).toBeTruthy();
    expect(pendingItem(row).restoreGen).toBe(row.restoreGen);
    expect(store.accept({ ...input, resend: true }).kind).toBe("existing");
    expect(store.accept({ ...input, resend: true, restoreGen: "guess" }).kind).toBe("existing");
    expect(store.bySendId("t1", "s1")!.restoreHeld).toBe(true);
  });

  it("a Send again from before a second restore is rejected with the held chip; the fresh token runs it", () => {
    const { db, store } = setup();
    const first = store.bySendId("t1", "s1")!.restoreGen!;
    expect(restoreGenerationCurrent(db, first)).toBe(true);
    neutralizeRestoredSends(db); // a second restore: the chip is still held, under a new token
    expect(restoreGenerationCurrent(db, first)).toBe(false);
    const second = store.bySendId("t1", "s1")!.restoreGen!;
    expect(second).not.toBe(first);
    expect(currentRestoreGeneration(db)).toBe(second);
    const stale = store.accept({ ...input, resend: true, restoreGen: first });
    expect(stale.kind).toBe("existing");
    expect(stale.row.status).toBe("refused");
    expect(stale.row.restoreHeld).toBe(true);
    expect(store.accept({ ...input, resend: true, restoreGen: second }).kind).toBe("new");
  });

  it("an automatic retry of an admitted Send again cannot carry the press across a later restore", () => {
    const { db, store } = setup();
    const token = store.bySendId("t1", "s1")!.restoreGen!;
    expect(store.accept({ ...input, resend: true, restoreGen: token }).row.status).toBe("sending"); // the click
    expect(store.accept({ ...input, resend: true, restoreGen: token }).kind).toBe("existing"); // its retry, same generation: no second run
    neutralizeRestoredSends(db); // a restore neutralizes the send the click made
    const retry = store.accept({ ...input, resend: true, restoreGen: token });
    expect(retry.kind).toBe("existing");
    expect(retry.row.restoreHeld).toBe(true);
    expect(retry.row.status).toBe("refused");
  });

  it("a chip made from restore-expired room work is held and takes the current generation", () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    neutralizeRestoredSends(db);
    const store = new SendStore(() => db);
    const made = store.accept({ kind: "group", ownerId: "g", threadId: "t1", text: "w", sendId: "s1", fingerprint: sendFingerprint("w"), status: "refused", notice: "refused", restoreHeld: true });
    expect(made.row.restoreHeld).toBe(true);
    expect(made.row.restoreGen).toBe(currentRestoreGeneration(db));
    expect(store.accept({ kind: "group", ownerId: "g", threadId: "t1", text: "w", sendId: "s1", fingerprint: sendFingerprint("w") }).kind).toBe("existing");
  });
});

describe("E the ownerWords hook publishes only after its transaction commits", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    initializeProjectTables(database());
    sendStore.use(() => database());
  });
  afterEach(() => { sendStore.reset(); closeMessageDb(); });

  it("a rollback after the hook leaves no chip row and nothing published; a commit publishes once, after commit", () => {
    const published: Array<{ inTx: boolean }> = [];
    const hook = (_db: DatabaseSync, done: ReturnType<typeof roomRequest> & object) => {
      sendStore.accept({ kind: "group", ownerId: "g", threadId: "t1", text: WORDS, status: "refused", notice: "refused", queueId: done.id, fingerprint: sendFingerprint(WORDS) });
      afterCommit(() => published.push({ inTx: database().isTransaction })); // what index.ts keepRefusedOwnerSend does
    };
    const request = ownerSend("k1", "t1");
    database().prepare("UPDATE room_requests SET state='running' WHERE id=?").run(request.id);
    expect(() => scopedTx(() => {
      database().exec("SAVEPOINT outer_owner");
      try {
        completeRequest(database(), request.id, { state: "failed", now: 5 }, { ownerWords: hook });
        throw new Error("outer failed");
      } catch (error) { database().exec("ROLLBACK TO outer_owner; RELEASE outer_owner"); throw error; }
    })).toThrow(/outer failed/);
    expect(published).toEqual([]);
    expect(rows()).toEqual([]);
    expect(roomRequest(database(), request.id)!.state).toBe("running");

    completeRequest(database(), request.id, { state: "failed", now: 6 }, { ownerWords: hook });
    expect(published).toEqual([{ inTx: false }]);
    expect(rows()).toEqual(["t1"]);
  });
});
