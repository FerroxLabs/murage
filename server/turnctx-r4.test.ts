// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// turnctx final round (Astra r3c): a thread is prepared only when its fill covered it; a rolled-back write leaves no line
// memory behind; a filtered room transcript's quotation extras never count toward the thirty-line window; and deleting a
// conversation asks an index, not every message, whether an attachment is used elsewhere.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("./memory/disclosures.ts", async (original) => ({
  ...(await original<typeof import("./memory/disclosures.ts")>()),
  // the newest line of the room (r100) is the one this reader may not see
  filterMemoryReplay: (_allowance: unknown, _thread: string, rows: readonly { id: string }[]) => rows.filter((m) => m.id !== "r100"),
}));

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { isPrepared, prepareThread } from "./branch-store.ts";
import * as messages from "./message-db.ts";
import { ConversationDeletions } from "./conversation-deletion.ts";
import * as backfill from "./transcript-backfill.ts";
import { roomTranscriptForTurn } from "./room-transcript.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { readRoomTurnRows, type RoomRowsStore } from "./room-turn-rows.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessages } from "./room-context.ts";
import type { MemoryAccess } from "./memory/policy.ts";
import type { Message } from "./store.ts";

const T = "t-r4";
const msg = (id: string, parentId: string | null, extra: object = {}): Message => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user", kind: "text", ...extra }) as Message;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

const textLines = (threadId: string) => {
  const db = database();
  const key = (db.prepare("SELECT key FROM thread_key WHERE thread_id = ?").get(threadId) as { key: number } | undefined)?.key;
  if (key === undefined) return [] as string[];
  return (db.prepare("SELECT m.id AS id FROM line l JOIN messages m ON m.rowid = l.mrow WHERE l.key = ? AND l.cls = 1 ORDER BY l.mrow").all(key) as Array<{ id: string }>).map((r) => r.id);
};

it("r4 #1: patching the oldest row of an upgraded, unfilled thread does not mark it prepared; the fill then covers every row", async () => {
  const db = database();
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= 1000; i++) put.run(T, `m${i}`, i, "user", "text", `w${i}`, JSON.stringify(msg(`m${i}`, i === 1 ? null : `m${i - 1}`, { at: i })));
  db.exec("COMMIT");
  expect(isPrepared(T)).toBe(false);
  messages.updateMessage(T, msg("m1", null, { text: "patched", at: 1 })); // the oldest row, its parent unchanged, before any fill
  expect(isPrepared(T)).toBe(false);
  await prepareThread(T);
  expect(isPrepared(T)).toBe(true);
  expect(textLines(T)).toHaveLength(1000);
});

it("r4 #2: a rolled-back append leaves no line memory: the next append reusing its rowid is in the line index", () => {
  expect(() => transaction(() => { messages.appendMessage(T, msg("A", null)); throw new Error("callback failed"); })).toThrow("callback failed");
  messages.appendMessage(T, msg("B", null));
  expect(textLines(T)).toEqual(["B"]);
  expect((database().prepare("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(T) as { n: number }).n).toBe(1);
});

it("r4 #3: quoted lines do not count toward the thirty-line window of a filtered room transcript", () => {
  const allowance = LineageAllowance.tool();
  const rows = (id: number): Message => ({ id: `r${id}`, at: id, role: id % 2 ? "user" : "bot", kind: "text", text: `line ${id}`, ...(id === 90 ? { replyToId: "r1" } : {}) }) as Message;
  const all = Array.from({ length: 100 }, (_, i) => rows(i + 1));
  const store: RoomRowsStore = {
    newestTextLines: (_t, limit) => all.slice(-limit),
    messageById: (_t, id) => all.find((m) => m.id === id),
  };
  const read = readRoomTurnRows(store, "room", undefined);
  const access = {} as MemoryAccess;
  const indexed = roomTranscriptForTurn(allowance, "room", read.rows, false, access, undefined, undefined, read.widen);
  const whole = roomTranscriptForTurn(allowance, "room", all, false, access, undefined, undefined);
  const shown = (turn: { messages: Message[] }) => roomContextMessages(turn.messages, GROUP_CONTEXT_MESSAGES).map((m) => m.id);
  expect(shown(whole)).toEqual(Array.from({ length: 30 }, (_, i) => `r${70 + i}`));
  expect(shown(indexed)).toEqual(shown(whole));
});

// ---- #7 --------------------------------------------------------------------
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r4-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
function deletionRig(threads: number, perThread: number, names: string[]) {
  const data = join(scratch, `data-${++counter}`);
  mkdirSync(join(data, "attachments"), { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec(`CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));
    CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE attachment_name(name TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(name, thread_id, id)) WITHOUT ROWID;`);
  const put = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)");
  const filler = "x".repeat(520);
  db.exec("BEGIN");
  put.run("doomed", "d0", 1, "bot", "text", "hi", JSON.stringify({ attachments: names.map((n) => ({ kind: "file", path: join(data, "attachments", n) })) }));
  for (let t = 0; t < threads; t++) for (let i = 0; i < perThread; i++) put.run(`th${t}`, `m${i}`, i, "user", "text", "w", JSON.stringify({ id: `m${i}`, text: filler }));
  db.exec("COMMIT");
  for (const n of names) writeFileSync(join(data, "attachments", n), "x");
  return { data, db, deletions: new ConversationDeletions({ dataDir: data, database: () => db }) };
}
const uuidName = (n: number) => `0b7c1f2e-1111-4222-8333-${String(n).padStart(12, "0")}.pdf`;

it("r4 #7: ten attachments over 103k messages in 648 threads are decided by an index, with no synchronous step over 50 ms", () => {
  const names = Array.from({ length: 10 }, (_, i) => uuidName(i + 1));
  const { db, deletions, data } = deletionRig(648, 159, names); // 103,032 messages
  while ((backfill as { indexAttachmentNamesChunk?: (db: DatabaseSync) => boolean }).indexAttachmentNamesChunk?.(db)) { /* the background pass, to its end */ }
  // one other conversation names the last file
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("th3", "ref", 9, "user", "text", "x", JSON.stringify({ text: `see ${names[9]}` }));
  db.prepare("INSERT INTO attachment_name(name, thread_id, id) VALUES(?,?,?)").run(names[9], "th3", "ref");
  const began = performance.now();
  const entry = deletions.begin({ threadIds: ["doomed"] });
  const took = performance.now() - began;
  expect(entry.attachments.slice().sort()).toEqual(names.slice(0, 9));
  console.info(`[r4 #7] begin() with 10 attachments over ${(db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n} messages: ${took.toFixed(1)} ms`);
  expect(took).toBeLessThan(50);
  db.close();
  expect(existsSync(join(data, "attachments", names[9]!))).toBe(true);
});

it("r4 #7: while the attachment-name index is not complete, a file is kept and decided on a later pass", async () => {
  const names = [uuidName(1), uuidName(2)];
  const { db, deletions, data } = deletionRig(3, 5, names);
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("th1", "ref", 9, "user", "text", "x", JSON.stringify({ text: `see ${names[1]}` })); // not indexed yet
  const entry = deletions.begin({ threadIds: ["doomed"] });
  expect(entry.attachments).toEqual([]);
  expect(entry.deferredAttachments?.slice().sort()).toEqual(names);
  db.prepare("DELETE FROM messages WHERE thread_id='doomed'").run();
  let report = await deletions.finish(entry);
  expect(report.failed).toEqual([]);
  expect(existsSync(join(data, "attachments", names[0]!))).toBe(true);
  expect(existsSync(join(data, "attachments", names[1]!))).toBe(true);
  expect(deletions.pending()).toHaveLength(1); // kept for the next pass
  while ((backfill as { indexAttachmentNamesChunk?: (db: DatabaseSync) => boolean }).indexAttachmentNamesChunk?.(db)) { /* the index completes */ }
  report = await deletions.finish(deletions.pending()[0]!);
  expect(report.failed).toEqual([]);
  expect(existsSync(join(data, "attachments", names[0]!))).toBe(false); // used nowhere else
  expect(existsSync(join(data, "attachments", names[1]!))).toBe(true); // th1 still names it
  expect(deletions.pending()).toHaveLength(0);
  db.close();
});

// ---- the scale track (Sean 2026-10-13: moved past the release; Astra r3c numbers) ----------------------------------
it.todo("scale #4: warm turns scan abandoned history (topRowsOnBranch pages through abandoned text rows): 1,000 -> 100,000 messages = branch-row reads 2,199 -> 200,199, 4 ms -> 345 ms");
it.todo("scale #5: one splice defeats the fill's time budget (settle() drains descendants without checking the slice budget): 100,001-message fixture = 353 ms slice, unspliced < 9 ms");
it.todo("scale #6: a second branch change synchronously drains the first (branch-change.ts uses Number.MAX_SAFE_INTEGER): 865 ms on a 100k-message chain");
