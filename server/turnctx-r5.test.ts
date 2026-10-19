// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// turnctx last gap (Astra r4c): "prepared" means every row of the thread has a branch entry, including a lone legacy row patched
// before its first fill; and a file a delete had to keep (the attachment-name index was not complete) is decided as soon as the
// index completes, not at the next start, and is reported as still pending until then.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { branchTester, isPrepared, prepareThread } from "./branch-store.ts";
import * as messages from "./message-db.ts";
import { ConversationDeletions } from "./conversation-deletion.ts";
import * as backfill from "./transcript-backfill.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const T = "t-r5";
const msg = (id: string, parentId: string | null, extra: object = {}): Message => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user", kind: "text", ...extra }) as Message;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const entries = () => (database().prepare("SELECT count(*) AS n FROM msg_branch b JOIN messages m ON m.rowid = b.mrow WHERE m.thread_id = ?").get(T) as { n: number }).n;

it("r5 #1: a lone legacy row patched before its first fill is covered; appending after it keeps both on the branch", async () => {
  const db = database();
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(T, "A", 1, "user", "text", "words of A", JSON.stringify(msg("A", null)));
  messages.updateMessage(T, msg("A", null, { text: "patched" })); // parent unchanged, before any fill
  if (isPrepared(T)) expect(entries()).toBe(1); // prepared must mean every row has an entry
  expect(branchTester(T, "A")("A")).toBe(true);
  messages.appendMessage(T, msg("B", "A"));
  await prepareThread(T);
  expect(isPrepared(T)).toBe(true);
  expect(entries()).toBe(2);
  const test = branchTester(T, "B");
  expect([test("A"), test("B")]).toEqual([true, true]);
});

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r5-")));
afterAll(() => removeTempDirSync(scratch));
const uuidName = (n: number) => `0b7c1f2e-2222-4333-8444-${String(n).padStart(12, "0")}.pdf`;

it("r5 #2: a deferred attachment is decided when the index completes, with no restart; the shared file stays; the delete reports it pending", async () => {
  const data = join(scratch, "data");
  mkdirSync(join(data, "attachments"), { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec(`CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));
    CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE attachment_name(name TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(name, thread_id, id)) WITHOUT ROWID;`);
  const names = [uuidName(1), uuidName(2)];
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  put.run("doomed", "d0", 1, "bot", "text", "hi", JSON.stringify({ attachments: names.map((n) => ({ kind: "file", path: join(data, "attachments", n) })) }));
  put.run("th1", "ref", 2, "user", "text", "x", JSON.stringify({ text: `see ${names[1]}` })); // not indexed yet
  for (const n of names) writeFileSync(join(data, "attachments", n), "x");
  const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
  const entry = deletions.begin({ threadIds: ["doomed"] });
  db.prepare("DELETE FROM messages WHERE thread_id='doomed'").run();
  const report = await deletions.finish(entry);
  expect(report.failed).toEqual([]);
  expect(report.leftovers.some((l) => /attachment/i.test(l.what))).toBe(true); // honest: not stated as cleanly done
  expect(deletions.pending()).toHaveLength(1);
  while ((backfill as { indexAttachmentNamesChunk?: (db: DatabaseSync) => boolean }).indexAttachmentNamesChunk?.(db)) { /* the index completes */ }
  let settled: Promise<number> = Promise.resolve(0);
  const off = backfill.onAttachmentIndexComplete(() => { settled = deletions.settleDeferred(() => false); });
  backfill.notifyAttachmentIndexComplete();
  off();
  await settled;
  expect(existsSync(join(data, "attachments", names[0]!))).toBe(false);
  expect(existsSync(join(data, "attachments", names[1]!))).toBe(true);
  expect(deletions.pending()).toHaveLength(0);
  db.close();
});
