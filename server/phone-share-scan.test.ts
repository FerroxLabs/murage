// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-channels item 3: the startup share-orphan sweep (index.ts attachmentCleanup) asks "does any message name this file" through the
// attachment-name index, never a scan of every message. Real messages.db (database()), real Store writes (which keep attachment_name),
// real backfill state, real receipts and files. Every statement the sweep prepares is recorded and its plan read back.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import * as receiptsModule from "./phones/receipts.ts";
import { PhoneReceipts, reclaimShareOrphans } from "./phones/receipts.ts";
import { indexAttachmentNamesChunk } from "./transcript-backfill.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const DEVICE = "22222222-2222-4222-8222-222222222222";
const U = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
// The lookup index.ts hands the sweep. Before this change index.ts passed this lambda inline (index.ts:41350 at 68ed0def17); the base run
// of this witness uses that verbatim copy because the base has no export to import.
const lookupFor: (db: DatabaseSync) => (name: string) => boolean = (receiptsModule as { shareMessageNames?: (db: DatabaseSync) => (name: string) => boolean }).shareMessageNames
  ?? ((db) => (name) => db.prepare("SELECT 1 FROM messages WHERE json LIKE ? LIMIT 1").get(`%${name}%`) !== undefined);

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

function world(messages: number, backfilled = true, mentionExt = "png") {
  const db = database(), root = join(DATA_DIR, "share-files");
  db.exec("CREATE TABLE IF NOT EXISTS owner_sends (seq INTEGER PRIMARY KEY, status TEXT, attachments TEXT)");
  mkdirSync(root, { recursive: true });
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })), bot = store.createBot();
  const put = (n: number) => { const name = `${U(n)}.png`; writeFileSync(join(root, name), `file ${n}`); return name; };
  for (let i = 0; i < messages; i++) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `chat line ${i}` });
  const referenced = put(1), orphan = put(2);
  if (mentionExt === "png") store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a picture", attachments: [{ kind: "image", path: join(root, referenced), mime: "image/png" }] });
  else if (mentionExt === "after") store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `see ${U(9)}.${U(1)}.png for the picture` });
  else store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `see ${U(1)}.${mentionExt} for the picture` });
  if (backfilled) while (indexAttachmentNamesChunk(db, 100_000, 60_000)) { /* the startup backfill, to done */ }
  // rows written before the index existed: no pointer, and the backfill has not reached them yet
  else { db.exec("DELETE FROM attachment_name"); db.prepare("DELETE FROM transcript_index_state WHERE name = 'attachment_name'").run(); }
  const receipts = new PhoneReceipts(db, { database: () => db });
  receipts.receive({ deviceId: DEVICE, kind: "share", id: "s1", fingerprint: "f", generation: 1, allocatedThreadId: "t-s1" });
  receipts.setFiles(DEVICE, "share", "s1", [referenced, orphan].map((name) => ({ kind: "image" as const, path: join(root, name), mime: "image/png" })));
  receipts.flip(DEVICE, "share", "s1", { state: "refused", code: "bot_gone" as never });
  // every statement the sweep runs against messages.db, as prepared
  const prepared: string[] = [];
  const watched = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "prepare") return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
    return typeof value === "function" ? value.bind(target) : value;
  } }) as DatabaseSync;
  const sweep = () => reclaimShareOrphans(watched, { attachmentsDir: root, messageNames: lookupFor(watched),
    remove: (p) => { try { unlinkSync(p); return { ok: true }; } catch { return { ok: false }; } } });
  const fullScans = () => prepared.filter((sql) => /\bmessages\b/.test(sql)).filter((sql) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "x")) as Array<{ detail: string }>)
      .some((row) => /^SCAN messages\b/.test(row.detail)));
  return { root, referenced, orphan, sweep, fullScans, has: (name: string) => existsSync(join(root, name)) };
}

it.each([10, 1000])("with %i messages the sweep removes the orphan, keeps the file a message names, and never scans every message", (n) => {
  const w = world(n);
  expect(w.sweep()).toMatchObject({ deleted: 1, skipped: false });
  expect(w.has(w.orphan)).toBe(false);
  expect(w.has(w.referenced)).toBe(true);
  expect(w.fullScans()).toEqual([]);
});

it("GUARD: before the attachment-name backfill is done, the referenced file is still kept (the lookup falls back, data never lost)", () => {
  const w = world(10, false);
  expect(w.sweep()).toMatchObject({ deleted: 1, skipped: false });
  expect(w.has(w.referenced)).toBe(true);
  expect(w.has(w.orphan)).toBe(false);
});

it("GUARD (ASTRA c032857b8b H1): a message naming a longer token that starts with the file's name still keeps the file, as the old read did", () => {
  const w = world(10, true, "pngx");
  expect(w.sweep()).toMatchObject({ deleted: 1, skipped: false });
  expect(w.has(w.referenced)).toBe(true);
  expect(w.fullScans()).toEqual([]);
});

it("GUARD (ASTRA fdbaa365ec H1): a file named right after another name (the index holds only the first) is still kept, as the old read did", () => {
  const w = world(10, true, "after");
  expect(w.sweep()).toMatchObject({ deleted: 1, skipped: false });
  expect(w.has(w.referenced)).toBe(true);
  expect(w.fullScans()).toEqual([]);
});
