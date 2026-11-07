// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (7C, boot log): "database is not open" at record-keys.ts, the isTransaction check after the writer-gate wait. The handle from
// startRecordKeysBuild was discarded in index.ts, so nothing stopped the build when shutdown (or a restore) closed the connection, and the
// next tick read a closed handle as an unhandled rejection. Now index.ts keeps each background build's handle and stops it in the database
// close hooks (they run before the handle closes), and a build whose connection closed under its wait ends as stop() does. The record keys,
// owner search index and past chats builds share the same tick shape, so all three are held here. Synthetic data only.
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, onDatabaseClose, transaction } from "../database.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { startOwnerTailIndexBuild } from "./owner-tail-index.ts";
import { startPastChatsBuild } from "./past-chats-build.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { startRecordKeysBuild } from "./record-keys.ts";
import { dropOwnerTail, dropRecordKeys, ensureRecordKeys, recordKeysReady } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };
beforeEach(() => {
  closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "a", threadId: "ta" }], groups: [] });
  rejections.length = 0; process.on("unhandledRejection", onRejection);
});
afterEach(() => { process.off("unhandledRejection", onRejection); closeMemoryIndexReader(); closeDatabase(); });

const idOf = (n: number) => { const h = createHash("sha256").update(`rec-${n}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
/** `count` records as an older build left them: the key table and the owner tail both missing, so both builds have work to start. */
function seed(count: number): void {
  const scope = ensureScope("bot", "a");
  dropRecordKeys(database());
  transaction(tx => {
    const add = tx.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)");
    for (let n = 0; n < count; n++) add.run(idOf(n), scope, `note ${n}`, n + 1, n + 1);
  });
  ensureRecordKeys(database());
  dropOwnerTail(database());
}
/** The writer-gate wait, during which shutdown closes the connection: what the boot log caught. */
const closeDuringWait = async () => { closeDatabase(); await new Promise(resolve => setTimeout(resolve, 5)); };
/** Lets any tick still queued run, so a rejection it would raise is seen before the test ends. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const within = <T>(done: Promise<T>) => Promise.race([done, new Promise<"still running">(resolve => setTimeout(() => resolve("still running"), 2_000))]);

it("the record keys build whose connection closes under its wait ends quietly: done is false, no unhandled rejection, no onError", async () => {
  seed(50);
  expect(recordKeysReady(database())).toBe(false);
  const errors: Error[] = [];
  const build = startRecordKeysBuild(database(), { gate: null, busy: () => false, admit: closeDuringWait, log: () => {}, onError: error => { errors.push(error); } });
  expect(await within(build.done)).toBe(false);
  await settle();
  expect(rejections).toEqual([]);
  expect(errors).toEqual([]);
});

it("the owner search index build whose connection closes under its wait ends quietly the same way", async () => {
  seed(50);
  const errors: Error[] = [];
  const build = startOwnerTailIndexBuild(database(), { gate: null, busy: () => false, admit: closeDuringWait, onError: error => { errors.push(error); } });
  expect(await within(build.done)).toBe(false);
  await settle();
  expect(rejections).toEqual([]);
  expect(errors).toEqual([]);
});

it("the past chats build whose connection closes under its wait ends quietly the same way", async () => {
  const errors: Error[] = [];
  const store = { bots: [], groups: [] } as unknown as Parameters<typeof startPastChatsBuild>[1];
  const build = startPastChatsBuild(database(), store, () => ({ bots: [], groups: [] }), { gate: null, busy: () => false, admit: closeDuringWait, onError: error => { errors.push(error); } });
  expect(await within(build.done)).toBe(false);
  await settle();
  expect(rejections).toEqual([]);
  expect(errors).toEqual([]);
});

it("a build stopped from the close hooks, as index.ts wires it, never ticks on the closed connection", async () => {
  seed(50);
  let admits = 0;
  const build = startRecordKeysBuild(database(), { gate: null, busy: () => false, admit: async () => { admits++; }, pauseMs: 20, log: () => {} });
  onDatabaseClose(() => build.stop());
  closeDatabase();
  expect(await within(build.done)).toBe(false);
  const seen = admits;
  await settle();
  expect(admits).toBe(seen);
  expect(rejections).toEqual([]);
});

it("a tick suspended in the writer wait when the close hooks stop the build reads nothing after the wait", async () => {
  seed(50);
  let entered!: () => void, release!: () => void;
  const inWait = new Promise<void>(resolve => { entered = resolve; });
  const gateOpen = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const db = database();
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => { entered(); await gateOpen; }, log: () => {} });
  onDatabaseClose(() => build.stop());
  await inWait;
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => { reads++; return original(sql); };
  closeDatabase();
  release();
  expect(await within(build.done)).toBe(false);
  await settle();
  expect(reads).toBe(0);
  expect(rejections).toEqual([]);
});

it("index.ts keeps the handle of each background build and stops it in the database close hooks", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  for (const start of ["startRecordKeysBuild(", "startOwnerTailIndexBuild(", "startPastChatsBuild("]) {
    const at = source.indexOf(`const build = ${start}`);
    expect(at, `${start} keeps its handle`).toBeGreaterThan(-1);
    const line = source.slice(at, source.indexOf("\n", at));
    expect(line, `${start} stops in the close hooks`).toContain("onDatabaseClose(() => build.stop())");
  }
});
