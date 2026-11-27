import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { activeTextLines, branchChain, branchStep, migrateMailboxMessageBatch, readThreadAfter, readThreadAround, searchMessages } from "../message-db.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { readChatsGen, syncThreadSummary } from "../thread-summary.ts";
import { wireThread } from "../transcript-page.ts";
import { readRoomTurnRows } from "../room-turn-rows.ts";

const threadId = "fixture-second-thread";
const sentinel = "fixture-body-before-seal";
const open = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => closeDatabase());

function persistedSeal() {
  using observer = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  return observer.prepare("SELECT state, cursor FROM mailbox_sealed_threads WHERE thread_id=?").get(threadId);
}

it("scrubs the persisted chat preview with the durable seal and keeps summary rebuilds generic", () => {
  const store = open();
  store.appendMessage(threadId, {
    role: "bot", kind: "text", text: sentinel, from: { botId: "fixture", name: "fixture sender", color: "#888888" },
  });
  const preview = () => database().prepare("SELECT snippet,last_from FROM thread_summary WHERE thread_id=?").get(threadId);
  expect(preview()).toEqual({ snippet: sentinel, last_from: "fixture sender" });
  const before = readChatsGen(database());

  store.beginMailboxSeal(threadId);

  expect(persistedSeal()?.state).toBe("pending");
  expect(preview()).toEqual({ snippet: "Email conversation", last_from: null });
  expect(readChatsGen(database())).toEqual({ epoch: before.epoch, rev: before.rev + 1 });
  syncThreadSummary(database(), threadId);
  expect(preview()).toEqual({ snippet: "Email conversation", last_from: null });
  database().prepare("UPDATE thread_summary SET snippet=?,last_from=? WHERE thread_id=?").run(sentinel, "fixture sender", threadId);
  migrateMailboxMessageBatch(threadId);
  expect(preview()).toEqual({ snippet: "Email conversation", last_from: null });
});

it("rolls back the mailbox seal when the preview cannot be scrubbed", () => {
  const store = open();
  store.appendMessage(threadId, { role: "user", kind: "text", text: sentinel });
  database().exec("CREATE TRIGGER fixture_stop_preview BEFORE UPDATE ON thread_summary BEGIN SELECT RAISE(ABORT, 'fixture interrupted preview'); END");
  expect(() => store.beginMailboxSeal(threadId)).toThrow(/fixture interrupted preview/);
  expect(persistedSeal()).toBeUndefined();
  expect(store.messagesFor(threadId)[0]?.text).toBe(sentinel);
});

it.each([
  ["database branch", (_store: Store, id: string) => branchChain(threadId, id, 4)?.messages],
  ["database branch step", (_store: Store, id: string) => [branchStep(threadId, id)?.message]],
  ["database window", (_store: Store, id: string) => readThreadAround(threadId, id, 4)?.messages],
  ["database catch-up", (_store: Store, _id: string, anchor: string) => readThreadAfter(threadId, anchor, 4)],
  ["Store branch", (store: Store) => store.branchPage(threadId, 4)?.messages],
  ["Store window", (store: Store, id: string) => store.messageWindow(threadId, id, 4)?.messages],
] as const)("projects an unmigrated row in the pending-seal %s", (_label, read) => {
  const store = open();
  const anchor = store.appendMessage(threadId, { role: "user", kind: "text", text: "fixture anchor" });
  const original = store.appendMessage(threadId, { role: "user", kind: "text", text: sentinel });
  const row = () => read(store, original.id, anchor.id)?.find(message => message?.id === original.id);
  expect(row()).toMatchObject({ id: original.id, text: sentinel });
  store.beginMailboxSeal(threadId);

  expect(row()).toMatchObject({ id: original.id, sealed: true, text: "Email conversation" });
});

it("withholds pending and completed sealed history from generic engine replay", () => {
  const store = open();
  const row = store.appendMessage(threadId, { role: "user", kind: "text", text: sentinel });
  const readers = [
    () => activeTextLines(threadId, row.id, 4).messages,
    () => store.activeTextLines(threadId, 4).messages,
  ];
  for (const read of readers) expect(read()).toMatchObject([{ id: row.id, text: sentinel }]);
  store.beginMailboxSeal(threadId);
  for (const read of readers) expect(read()).toEqual([]);
  migrateMailboxMessageBatch(threadId);
  database().prepare("UPDATE mailbox_sealed_threads SET state='complete' WHERE thread_id=?").run(threadId);
  for (const read of readers) expect(read()).toEqual([]);
});

it("keeps generic transcript and search closed as soon as the pending seal is durable", () => {
  const store = open();
  const original = store.appendMessage(threadId, { role: "user", kind: "text", text: sentinel });
  const read = () => wireThread(store, threadId, { messages: store.messagesFor(threadId) }, { ownerOnly: true });
  expect(read().messages[0]).toMatchObject({ id: original.id, text: sentinel });
  expect(searchMessages("fi", 4, threadId, { owner: true })).toHaveLength(1);

  store.beginMailboxSeal(threadId);

  expect(persistedSeal()).toMatchObject({ state: "pending", cursor: 0 });
  expect(read().messages[0]).toMatchObject({ id: original.id, sealed: true, text: "Email conversation" });
  expect(searchMessages("fi", 4, threadId, { owner: true })).toEqual([]);
  expect(() => store.appendMessage(threadId, { role: "bot", kind: "text", text: sentinel })).toThrow(/conversation is paused/);
});

it("reopens at the committed cursor when copying the first batch aborts", () => {
  const store = open();
  const original = store.appendMessage(threadId, { role: "user", kind: "text", text: sentinel });
  store.beginMailboxSeal(threadId);
  database().exec("CREATE TRIGGER fixture_stop_copy BEFORE INSERT ON mailbox_sealed_rows BEGIN SELECT RAISE(ABORT, 'fixture interrupted copy'); END");
  expect(() => migrateMailboxMessageBatch(threadId)).toThrow(/fixture interrupted copy/);
  closeDatabase();
  expect(persistedSeal()).toMatchObject({ state: "pending", cursor: 0 });
  const reopened = open();
  expect(reopened.messagesFor(threadId)[0]).toMatchObject({ id: original.id, sealed: true });
  database().exec("DROP TRIGGER fixture_stop_copy");
  expect(migrateMailboxMessageBatch(threadId)).toEqual({ copied: 1, done: true });
  expect(migrateMailboxMessageBatch(threadId)).toEqual({ copied: 0, done: true });
  expect(persistedSeal()).toMatchObject({ state: "pending" });
  const sealed = database().prepare("SELECT json FROM mailbox_sealed_rows WHERE thread_id=? AND message_id=?").get(threadId, original.id);
  expect(JSON.parse(String(sealed?.json))).toMatchObject({ id: original.id, text: sentinel });
  expect(JSON.stringify(database().prepare("SELECT text,json FROM messages WHERE thread_id=?").all(threadId))).not.toContain(sentinel);
});

it.each(["room prompt window", "latest room user"] as const)(
  "withholds the %s before pending seal migration copies any row",
  (surface) => {
    const store = open();
    const room = store.createGroup("Fixture room", []);
    const line = store.appendMessage(room.threadId, { role: "user", kind: "text", text: sentinel });
    const read = () => surface === "room prompt window"
      ? readRoomTurnRows(store, room.threadId, undefined).rows[0]
      : store.newestLineOnBranch(room.threadId, message => message.role === "user");
    expect(read()).toMatchObject({ id: line.id, text: sentinel });

    store.beginMailboxSeal(room.threadId);

    expect(database().prepare("SELECT state,cursor FROM mailbox_sealed_threads WHERE thread_id=?").get(room.threadId))
      .toEqual({ state: "pending", cursor: 0 });
    expect(database().prepare("SELECT text FROM messages WHERE thread_id=? AND id=?").get(room.threadId, line.id)?.text).toBe(sentinel);
    expect(read()).toBeUndefined();
  },
);
