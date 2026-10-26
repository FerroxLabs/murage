// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// createBot is all or nothing (1.0.7): a busy database or a failure after the roster write leaves no bot behind (not in the live
// roster, not in bots.json, no opening lines, no announcement), so a retry after the error makes exactly one bot.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, isDatabaseBusy, transaction } from "./database.ts";
import { Store, type StoreChange } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
// a rollback schedules a deferred roster save: it lands in this test's folder, never in the next one's
afterEach(() => { flushCoalesced(); });

const selection = () => ({ instanceId: "fixture", model: "model" });
const fileIds = () => (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<{ id: string }>).map(bot => bot.id);
const rowsFor = (threadId: string) => (database().prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?").get(threadId) as { n: number }).n;

function world() {
  const store = new Store(selection);
  const first = store.createBot({ name: "First" });
  const changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  return { store, first, changes, ids: () => store.bots.map(bot => bot.id) };
}

it("a database another writer holds refuses the create before anything changes, and the retry makes one bot", () => {
  const { store, first, changes, ids } = world();
  const before = ids(), onDisk = fileIds();
  expect(onDisk).toEqual([first.id]);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let error: unknown;
  try { store.createBot({ name: "Second" }); } catch (caught) { error = caught; }
  finally { other.exec("ROLLBACK"); other.close(); }
  expect(isDatabaseBusy(error), String(error)).toBe(true);
  expect(ids()).toEqual(before);
  expect(fileIds()).toEqual(onDisk);
  expect(changes.filter(change => change.type === "bot")).toEqual([]);
  expect(new Store(selection).bots.map(bot => bot.id)).toEqual(before);

  const retried = store.createBot({ name: "Second" });
  expect(ids()).toEqual([retried.id, ...before]);
  expect(store.bots.filter(bot => bot.name === "Second")).toHaveLength(1);
  expect(fileIds()).toEqual([retried.id, ...onDisk]);
});

it("a failure after the roster was written rolls the whole create back: roster, file, opening lines and announcement", () => {
  const { store, changes, ids } = world();
  const before = ids(), onDisk = fileIds();
  const append = store.appendMessage.bind(store);
  let calls = 0;
  const spy = vi.spyOn(store, "appendMessage").mockImplementation((...args: Parameters<Store["appendMessage"]>) => {
    // the opening line lands, then the second write fails the way a lock that outlasted its wait does
    if (++calls === 2) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked" });
    return append(...args);
  });
  let threadId = "";
  const seen = store.onChange(change => { if (change.type === "message") threadId = change.threadId; });
  expect(() => store.createBot({ name: "Second" })).toThrow(/database is locked/);
  seen(); spy.mockRestore();
  expect(calls).toBe(2);
  expect(ids()).toEqual(before);
  expect(fileIds()).toEqual(onDisk);
  expect(changes).toEqual([]);
  expect(threadId).toBe("");
  expect((database().prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n).toBe(rowsFor(store.bots[0]!.threadId));
  expect(new Store(selection).bots.map(bot => bot.id)).toEqual(before);

  const retried = store.createBot({ name: "Second" });
  expect(store.bots.filter(bot => bot.name === "Second").map(bot => bot.id)).toEqual([retried.id]);
  expect(fileIds()).toEqual([retried.id, ...onDisk]);
  expect(rowsFor(retried.threadId)).toBe(2);
});

it("an enclosing transaction that rolls back two creates leaves the roster, the file and the memory bindings as they were", () => {
  const { store, changes, ids } = world();
  const before = ids(), onDisk = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
  const bindings = () => database().prepare("SELECT id,scope_id,subject_type,subject_id,state,intent FROM memory_scope_bindings ORDER BY id").all();
  const scopes = () => database().prepare("SELECT id,kind,owner_key FROM memory_scopes ORDER BY id").all();
  const held = { bindings: bindings(), scopes: scopes() };
  expect(() => transaction(() => { store.createBot({ name: "A" }); store.createBot({ name: "B" }); throw new Error("outer failed"); })).toThrow("outer failed");
  expect(ids()).toEqual(before);
  expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(onDisk);
  expect({ bindings: bindings(), scopes: scopes() }).toEqual(held);
  expect(changes).toEqual([]);
});
