import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { readMessage, searchMessages } from "../message-db.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "mail-fixture";
const text = "mailbox-body-sentinel";
const pixels = Buffer.from("mailbox-screen-sentinel").toString("base64");
const open = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => closeDatabase());

function seal() {
  // This fixture starts with a completed seal. Migration has its own witnesses.
  database().exec(`
    CREATE TABLE IF NOT EXISTS mailbox_sealed_threads (
      thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mailbox_sealed_rows (
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(thread_id, message_id)
    );
  `);
  database().prepare("INSERT INTO mailbox_sealed_threads(thread_id, generation, state) VALUES (?, 1, 'complete')").run(thread);
}

function sealedRow(messageId: string) {
  const row = database().prepare("SELECT json FROM mailbox_sealed_rows WHERE thread_id=? AND message_id=?").get(thread, messageId);
  return row ? JSON.parse(String(row.json)) : null;
}

function genericRows() {
  return database().prepare("SELECT text,json FROM messages WHERE thread_id=?").all(thread);
}

describe("common mailbox custody", () => {
  it("S6 rolls back append when the sealed insert fails, before any publication", () => {
    seal();
    const store = open(), frames: unknown[] = [];
    store.onChange(change => frames.push(change));
    database().exec(`CREATE TRIGGER fixture_fail_sealed BEFORE INSERT ON mailbox_sealed_rows BEGIN SELECT RAISE(ABORT, 'fixture sealed write failed'); END`);
    expect(() => store.appendMessage(thread, { role: "user", kind: "text", text })).toThrow(/fixture sealed write failed/);
    expect(genericRows()).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("S6b fails closed when SQLite cannot read the seal", () => {
    seal();
    const store = open();
    database().exec("DROP TABLE mailbox_sealed_threads");
    expect(() => store.appendMessage(thread, { role: "user", kind: "text", text })).toThrow();
    expect(genericRows()).toEqual([]);
  });

  it.each([true, false])("S1 keeps append and branch results generic for a loaded=%s thread", loaded => {
    seal();
    const owner = open();
    const first = owner.appendMessage(thread, { role: "user", kind: "text", text: "original" });
    const store = loaded ? owner : open();
    const changes: unknown[] = [];
    store.onChange(change => changes.push(change));
    expect(store.cachedThreadIds().includes(thread)).toBe(loaded);
    const second = store.appendAfterHead(thread, first.id, { role: "bot", kind: "text", text })!;
    const leaf = store.branchMessage(thread, first.id, text)!;
    expect(second).toMatchObject({ parentId: first.id, sealed: true });
    expect(leaf).toMatchObject({ parentId: first.parentId, sealed: true });
    expect(store.activeLeafOf(thread)).toBe(leaf.id);
    expect(JSON.stringify([genericRows(), changes, second, leaf, store.messagesFor(thread)])).not.toContain(text);
    expect(sealedRow(second.id)).toMatchObject({ id: second.id, text });
    expect(sealedRow(leaf.id)).toMatchObject({ id: leaf.id, text });
  });

  it("S1 keeps rewritten text out of SQL, generic search and Store events", () => {
    seal();
    const store = open(), frames: unknown[] = [];
    const original = store.appendMessage(thread, { role: "bot", kind: "text", text: "original" });
    store.onChange(change => frames.push(change));
    const patched = store.patchMessage(thread, original.id, { text });
    expect(patched).toMatchObject({ id: original.id, sealed: true, text: "Email conversation" });
    expect(JSON.stringify([genericRows(), store.messagesFor(thread), frames, patched])).not.toContain(text);
    expect(searchMessages("mailbox", 5, thread, { owner: true })).toEqual([]);
    expect(sealedRow(original.id)).toMatchObject({ id: original.id, text });
  });

  it("S1 splits a fresh hosted reply before an existing row and keeps its lineage", () => {
    seal();
    const store = open(), frames: unknown[] = [];
    const anchor = store.appendMessage(thread, { role: "user", kind: "text", text: "start" });
    const leaf = store.appendMessage(thread, { role: "bot", kind: "text", text: "following" });
    store.onChange(change => frames.push(change));
    const inserted = store.insertMessageBefore(thread, leaf.id, { role: "bot", kind: "text", text });
    expect(inserted).toMatchObject({ parentId: anchor.id, insertedBefore: leaf.id, sealed: true });
    expect(store.activeLeafOf(thread)).toBe(leaf.id);
    expect(readMessage(thread, leaf.id)?.parentId).toBe(inserted.id);
    expect(JSON.stringify([genericRows(), store.messagesFor(thread), frames, inserted])).not.toContain(text);
    expect(sealedRow(inserted.id)).toMatchObject({ id: inserted.id, text, parentId: anchor.id });
    expect(sealedRow(leaf.id)).toMatchObject({ text: "following", parentId: inserted.id });
  });

  it("S1 splits a late screen after its anchor and keeps the current leaf", () => {
    seal();
    const store = open(), frames: unknown[] = [];
    const anchor = store.appendMessage(thread, { role: "bot", kind: "text", text: "first" });
    const leaf = store.appendMessage(thread, { role: "user", kind: "text", text: "follow-up" });
    store.onChange(change => frames.push(change));
    const inserted = store.insertMessageAfter(thread, anchor.id, { role: "bot", kind: "screen", png: pixels });
    expect(inserted).toMatchObject({ parentId: anchor.id, sealed: true });
    expect(store.activeLeafOf(thread)).toBe(leaf.id);
    expect(readMessage(thread, leaf.id)?.parentId).toBe(inserted.id);
    expect(JSON.stringify([genericRows(), store.messagesFor(thread), frames, inserted])).not.toContain(pixels);
    expect(sealedRow(inserted.id)).toMatchObject({ id: inserted.id, png: pixels, parentId: anchor.id });
  });
});
