// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// messages.seq, the server half (ROOM-ORDER-DESIGN r6 Q1/Q2/Q8, r7 R1-R3/R5/R7, r8 R8): the column and its index, allocation in
// the row's write transaction, the bounded resumable numbering walk, numbered page readers, and the one delivery gate
// (transcript-page.ts wireThread). Fixtures r7 (1)-(4), (8) and r8 (11).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import * as mdb from "./message-db.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { OPTIONAL_INDEXES, optionalIndexText } from "./memory/optional-index.ts";
import { Store, type Message, type StoreChange } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";
import { numberSeqChunk, readIndexState, writeIndexState } from "./transcript-backfill.ts";
import { SEQ_INDEX, SEQ_INDEX_SQL, downgradeTranscriptSeqTo102, onSeqChunk, seqProgress, type SeqChunkFigures } from "./transcript-seq.ts";
import { transcriptPage, wirePage, wireThread } from "./transcript-page.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
import { downgradeMessageIdIndexTo102 } from "./message-id-index.ts";
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const msg = (id: string, text = id, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: Date.now(), ...extra });
const stores: Store[] = [];
const newStore = () => { const store = new Store(selection); stores.push(store); return store; };

/** Every row's (id, seq) of a thread, in storage order. */
const column = (threadId: string) => database().prepare("SELECT id, seq FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId) as Array<{ id: string; seq: number | null }>;
const seqOfColumn = (threadId: string, id: string) => column(threadId).find((row) => row.id === id)?.seq ?? null;
/** S1: a thread's numbers are exactly 1..COUNT(*). */
function expectS1(threadId: string) {
  const numbers = column(threadId).map((row) => row.seq);
  expect(numbers.every((n) => typeof n === "number")).toBe(true);
  expect([...numbers].sort((a, b) => a! - b!)).toEqual(numbers.map((_, i) => i + 1));
}
/** A file as 1.0.2 left it for these threads: the column NULL, the walk not begun. The handle is reopened, so nothing in memory remembers. */
function asOlderFile(threadIds?: string[]) {
  const db = database();
  if (threadIds) for (const t of threadIds) db.prepare("UPDATE messages SET seq = NULL WHERE thread_id = ?").run(t);
  else db.exec("UPDATE messages SET seq = NULL");
  writeIndexState(db, "seq", { done: 0, cursor: 0, skipped: 0 });
  mdb.closeMessageDb();
}
const walk = (rows = 1000) => { let chunks = 0; while (numberSeqChunk(database(), { rows })) chunks++; return chunks; };
/** The frame index.ts broadcasts for a change (the store listener there gates exactly so; static test below). */
const frames = (store: Store) => {
  const out: Array<Record<string, any>> = [];
  store.onChange((change: StoreChange) => {
    if (change.type === "message" || change.type === "message.patch") out.push({ kind: change.type, threadId: change.threadId, ...wireThread(store, change.threadId, { message: change.message }, { slim: false }) });
  });
  return out;
};

beforeEach(() => {
  mdb.closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { for (const store of stores.splice(0)) store.stopSeqStamps(); });

describe("the column, its index and allocation", () => {
  it("a fresh file makes the index with the schema and is numbered from its first row; json never holds seq; a REPLACE and an edit keep the number", () => {
    mdb.insertMessage("t", msg("a"));
    const b = msg("b");
    mdb.insertMessage("t", b);
    expect(b.seq).toBe(2);
    const db = database();
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(SEQ_INDEX)).toBeTruthy();
    expect(readIndexState(db, "seq").done).toBe(1);
    mdb.insertMessage("t", msg("c"));
    mdb.insertMessage("t", msg("a", "replaced")); // INSERT OR REPLACE of a held key: new rowid, same number
    mdb.updateMessage("t", msg("b", "edited", { seq: 99 } as Partial<Message>)); // a stale seq on the object is overwritten by the column's
    expect(column("t")).toEqual([{ id: "b", seq: 2 }, { id: "c", seq: 3 }, { id: "a", seq: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE json_extract(json, '$.seq') IS NOT NULL").get()).toEqual({ n: 0 });
    // pages are in number order for a numbered thread, so the replaced row stays where it was
    expect(mdb.readThreadNewest("t", 10)!.messages.map((m) => [m.id, m.seq])).toEqual([["a", 1], ["b", 2], ["c", 3]]);
    expect(mdb.readThreadBefore("t", "c", 10)!.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expectS1("t");
  });

  it("an existing file gets the column but not the index; it is one optional index with the schema's exact text, and until it exists every thread is legacy", () => {
    mdb.insertMessage("t", msg("a"));
    const db = database();
    db.exec(`DROP INDEX ${SEQ_INDEX}`);
    db.exec("UPDATE messages SET seq = NULL");
    mdb.closeMessageDb();
    const again = database();
    expect(again.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(SEQ_INDEX)).toBeUndefined();
    expect(readIndexState(again, "seq")).toMatchObject({ done: 0, cursor: 0 });
    expect(OPTIONAL_INDEXES.find((index) => index.name === SEQ_INDEX)).toMatchObject({ table: "messages", sql: SEQ_INDEX_SQL, logTag: "transcript-seq" });
    const b = msg("b");
    mdb.insertMessage("t", b);
    expect(b.seq).toBeUndefined();
    expect(mdb.threadIsNumbered("t")).toBe(false);
    expect(mdb.threadIsNumbered("brand-new")).toBe(false);
    expect(numberSeqChunk(again)).toBe(false); // no index: nothing walks
    expect(seqProgress(again)).toMatchObject({ phaseId: "transcript-seq", stillWorking: true, indexReady: false });
    // built (as the idle window builds it), the walk numbers the history and a new thread allocates from 1
    again.exec(SEQ_INDEX_SQL);
    expect(again.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(SEQ_INDEX)).toEqual({ sql: optionalIndexText(OPTIONAL_INDEXES.find((index) => index.name === SEQ_INDEX)!) });
    walk();
    expect(column("t")).toEqual([{ id: "a", seq: 1 }, { id: "b", seq: 2 }]);
    expect(seqProgress(again)).toMatchObject({ stillWorking: false });
  });

  it("importLegacy runs in BEGIN IMMEDIATE and numbers the imported thread in its time order (fixture 4, legacy import)", () => {
    writeFileSync(join(DATA_DIR, "messages-legacy.json"), JSON.stringify([msg("y", "two", { at: 2 }), msg("x", "one", { at: 1 })]));
    const store = newStore();
    const rows = store.messagesFor("legacy");
    expect(rows.map((m) => [m.id, m.seq])).toEqual([["x", 1], ["y", 2]]);
    expect(column("legacy")).toEqual([{ id: "x", seq: 1 }, { id: "y", seq: 2 }]);
    const source = readFileSync(new URL("./message-db.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("function importLegacy("), source.indexOf("function replaceRow("));
    expect(body).toContain('db().exec("BEGIN IMMEDIATE")');
    expect(body).not.toMatch(/exec\("BEGIN"\)/);
  });
});

describe("the numbering walk", () => {
  it("(1) interruption: killed after two chunks, restarted, every number given once and the cursor resumed", () => {
    for (let i = 0; i < 24; i++) mdb.insertMessage(`t${i % 3}`, msg(`m${i}`));
    asOlderFile();
    const db = database();
    expect(numberSeqChunk(db, { rows: 5 })).toBe(true);
    expect(numberSeqChunk(db, { rows: 5 })).toBe(true);
    const cursor = readIndexState(db, "seq").cursor;
    const firstTen = db.prepare("SELECT id, seq FROM messages WHERE rowid <= ? ORDER BY rowid").all(cursor);
    expect(firstTen.every((row) => row.seq !== null)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE rowid > ? AND seq IS NOT NULL").get(cursor)).toEqual({ n: 0 });
    mdb.closeMessageDb(); // the kill
    const reopened = database();
    expect(readIndexState(reopened, "seq").cursor).toBe(cursor);
    const seen: SeqChunkFigures[] = [];
    const stop = onSeqChunk((figures) => seen.push(figures));
    try { walk(5); } finally { stop(); }
    expect(seen[0]!.scanned).toBe(5);
    expect(seen.at(-1)!.done).toBe(true);
    expect(reopened.prepare("SELECT id, seq FROM messages WHERE rowid <= ? ORDER BY rowid").all(cursor)).toEqual(firstTen); // never reassigned
    for (const t of ["t0", "t1", "t2"]) {
      expectS1(t);
      expect(column(t).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // rowid order
    }
  });

  it("a chunk stops at a 25-row boundary once its 20 ms are spent, and its cursor is the last row written", () => {
    for (let i = 0; i < 450; i++) mdb.insertMessage("long", msg(`r${i}`));
    asOlderFile();
    const db = database();
    let clock = 0;
    const seen: SeqChunkFigures[] = [];
    const stop = onSeqChunk((figures) => seen.push(figures));
    try { numberSeqChunk(db, { rows: 1000, now: () => (clock += 10) }); } finally { stop(); }
    // checked at row 25 (10 ms after the start: go on) and row 50 (20 ms: cut)
    expect(seen[0]).toMatchObject({ scanned: 50, numbered: 50, cut: true });
    const last = db.prepare("SELECT rowid AS r FROM messages WHERE thread_id='long' AND seq = 50").get() as { r: number };
    expect(readIndexState(db, "seq").cursor).toBe(last.r);
    expect(mdb.threadIsNumbered("long")).toBe(false);
  });

  it("the bound counts the commit: the chunk stops once its time plus the predicted commit reaches 20 ms", () => {
    for (let i = 0; i < 450; i++) mdb.insertMessage("long", msg(`r${i}`));
    asOlderFile();
    const db = database();
    let clock = 0;
    const seen: SeqChunkFigures[] = [];
    const stop = onSeqChunk((figures) => seen.push(figures));
    // 1 ms per now() call, 0.05 ms of commit per row with four reserved for the tail (0.2 a row): row 25 is 1 + 5 ms, row 50 2 + 10, row 75
    // 3 + 15, row 100 4 + 20: cut
    try { numberSeqChunk(db, { rows: 1000, now: () => (clock += 1), commitMsPerRow: 0.05 }); } finally { stop(); }
    expect(seen[0]).toMatchObject({ scanned: 100, numbered: 100, cut: true });
  });

  it("(2) concurrency: a send to a pending thread is stored NULL and delivered legacy, then numbered n+1 after the flip; S1", () => {
    for (let i = 0; i < 3; i++) mdb.insertMessage("room", msg(`old${i}`));
    asOlderFile();
    const store = newStore();
    const out = frames(store);
    const during = store.appendMessage("room", { role: "user", kind: "text", text: "during the walk" });
    expect(seqOfColumn("room", during.id)).toBeNull();
    expect(out.at(-1)!.message.seq).toBeUndefined();
    expect(out.at(-1)!.newestSeq).toBeUndefined();
    walk(2);
    const after = store.appendMessage("room", { role: "user", kind: "text", text: "after the flip" });
    expect(seqOfColumn("room", during.id)).toBe(4);
    expect(after.seq).toBe(5);
    expect(out.at(-1)).toMatchObject({ message: { id: after.id, seq: 5 }, newestSeq: 5 });
    expectS1("room");
  });

  it("(3) cache promotion: a thread loaded under a live turn is stamped in place, and its next page carries seq on every row in seq order", () => {
    for (let i = 0; i < 6; i++) mdb.insertMessage("loaded", msg(`l${i}`));
    asOlderFile();
    const store = newStore();
    const held = store.messagesFor("loaded"); // the objects a turn in flight holds
    const legacy = wirePage(store, "loaded", transcriptPage(store, "loaded", 100, false), false);
    expect(legacy.newestSeq).toBeUndefined();
    expect(legacy.messages.some((m: any) => "seq" in m)).toBe(false);
    numberSeqChunk(database(), { rows: 3 }); // half: stamped, not flipped
    expect(held.slice(0, 3).map((m) => m.seq)).toEqual([1, 2, 3]);
    const half = wirePage(store, "loaded", transcriptPage(store, "loaded", 100, false), false);
    expect(half.newestSeq).toBeUndefined();
    expect(half.messages.some((m: any) => "seq" in m)).toBe(false); // a pending thread: no row carries seq on the wire
    walk();
    expect(held.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const page = wirePage(store, "loaded", transcriptPage(store, "loaded", 4, false), false);
    expect(page.messages.map((m: any) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(page.newestSeq).toBe(6);
    expect(wireThread(store, "loaded", store.messagePage("loaded", 2)!)).toMatchObject({ newestSeq: 6 });
  });
});

describe("(4) every delivery path carries the column's seq", () => {
  it("append, unloaded append, after-head, insert before/after, unloaded patch, storedMessage redelivery", () => {
    const store = newStore();
    const out = frames(store);
    const check = (threadId: string, message: Message) => {
      expect(message.seq).toBe(seqOfColumn(threadId, message.id));
      expect(typeof message.seq).toBe("number");
      const frame = out.filter((f) => f.message.id === message.id).at(-1)!;
      expect(frame.message.seq).toBe(message.seq);
      expect(frame.newestSeq).toBe(store.newestSeq(threadId));
    };
    const a = store.appendMessage("p", { role: "user", kind: "text", text: "one" });
    check("p", a);
    const b = store.appendMessage("p", { role: "bot", kind: "text", text: "two" });
    check("p", b);
    const before = store.insertMessageBefore("p", b.id, { role: "bot", kind: "activity", tool: { name: "note", ok: true } } as never);
    check("p", before);
    const afterIt = store.insertMessageAfter("p", a.id, { role: "bot", kind: "text", text: "after a" });
    check("p", afterIt);
    const cold = newStore(); // nothing loaded
    const coldOut = frames(cold);
    const unloaded = cold.appendMessage("p", { role: "user", kind: "text", text: "unloaded" });
    expect(unloaded.seq).toBe(seqOfColumn("p", unloaded.id));
    expect(coldOut.at(-1)!.message.seq).toBe(unloaded.seq);
    const head = mdb.readActiveLeafOrNewest("p")!;
    const afterHead = newStore().appendAfterHead("p", head, { role: "bot", kind: "text", text: "after head" })!;
    expect(afterHead.seq).toBe(seqOfColumn("p", afterHead.id));
    const patched = newStore().patchMessagePoint("p", a.id, { text: "patched cold" })!;
    expect(patched.seq).toBe(seqOfColumn("p", a.id));
    const redelivered = newStore().appendMessage("p", { role: "bot", kind: "text", text: "again" }, unloaded.id);
    expect(redelivered).toMatchObject({ id: unloaded.id, seq: unloaded.seq });
    expect(mdb.storedMessage("p", b.id)!.seq).toBe(b.seq);
    expectS1("p");
    // a POST answer and a page through the gate
    expect(wireThread(store, "p", { ok: true, threadId: "p", message: a }, { slim: false })).toMatchObject({ message: { seq: a.seq }, newestSeq: 6 });
    const around = store.messageWindow("p", b.id, 3)!;
    expect(wireThread(store, "p", around).messages.every((m: any) => typeof m.seq === "number")).toBe(true);
    // a branch page is in parent-link order: it goes out legacy
    const branch = wireThread(store, "p", { messages: store.branchPage("p", 10)!.messages }, { legacy: true });
    expect(branch.newestSeq).toBeUndefined();
    expect(branch.messages.some((m: any) => "seq" in m)).toBe(false);
    // an empty numbered thread says 0
    expect(wireThread(store, "empty", { messages: [] })).toEqual({ messages: [], newestSeq: 0 });
  });
});

describe("(11) a patch during a partial walk", () => {
  it("rows 1..3 numbered, row 4 NULL: the patch is legacy everywhere; the next chunk numbers row 4; the next patch carries seq 2 and newestSeq 4", () => {
    for (const id of ["r1", "r2", "r3", "r4"]) mdb.insertMessage("cut", msg(id));
    asOlderFile();
    numberSeqChunk(database(), { rows: 3 });
    expect(column("cut").map((row) => row.seq)).toEqual([1, 2, 3, null]);
    const store = newStore();
    const out = frames(store);
    const first = store.patchMessage("cut", "r2", { text: "edited once" })!;
    const answer = wireThread(store, "cut", { message: first }, { slim: false });
    const page = wireThread(store, "cut", store.messagePage("cut", 50)!);
    for (const body of [out.at(-1)!, answer, page] as Array<Record<string, any>>) {
      expect(body.newestSeq).toBeUndefined();
      for (const row of (body.messages ?? [body.message]) as any[]) expect("seq" in row).toBe(false);
    }
    expect(numberSeqChunk(database(), { rows: 3 })).toBe(true);
    expect(column("cut").map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    store.patchMessage("cut", "r2", { text: "edited twice" });
    expect(out.at(-1)).toMatchObject({ kind: "message.patch", message: { id: "r2", seq: 2 }, newestSeq: 4 });
    const numberedPage = wireThread(store, "cut", store.messagePage("cut", 50)!);
    expect(numberedPage.newestSeq).toBe(4);
    expect(numberedPage.messages.map((m: any) => m.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("(8) restore compatibility", () => {
  const scratch: string[] = [];
  afterEach(() => { for (const dir of scratch.splice(0)) removeTempDirSync(dir); });
  const file = () => { const dir = mkdtempSync(join(tmpdir(), "murage-seq-")); scratch.push(dir); return join(dir, "messages.db"); };
  const OLD_DDL = "CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id); CREATE INDEX messages_at ON messages(at DESC); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);";
  const put = (db: DatabaseSync, thread: string, id: string, parent: string | null) => db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,1,'user','text','x',?)").run(thread, id, JSON.stringify({ id, at: 1, role: "user", kind: "text", text: "x", parentId: parent }));

  it("a pre-sequence archive is accepted, opens legacy, builds its index and numbers", () => {
    const path = file();
    const old = new DatabaseSync(path);
    old.exec(OLD_DDL);
    put(old, "t", "a", null); put(old, "t", "b", "a");
    old.exec("INSERT INTO thread_state VALUES ('t','b')");
    expect(inspectInstallationDatabase(old)).toMatchObject({ messages: 2, threads: 1 });
    initializeMessageTables(old); // the open: column added, no index on a file with history
    expect(old.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(SEQ_INDEX)).toBeUndefined();
    expect(inspectInstallationDatabase(old)).toMatchObject({ messages: 2 }); // with the column, without its index
    old.exec(SEQ_INDEX_SQL);
    while (numberSeqChunk(old)) { /* chunks */ }
    expect(old.prepare("SELECT id, seq FROM messages ORDER BY rowid").all()).toEqual([{ id: "a", seq: 1 }, { id: "b", seq: 2 }]);
    old.close();
  });

  it("a numbered snapshot is accepted with every seq intact (S1), and an archive taken mid-walk resumes from its archived cursor", () => {
    const path = file();
    const live = new DatabaseSync(path);
    live.exec(OLD_DDL);
    for (let i = 0; i < 6; i++) put(live, "t", `m${i}`, i ? `m${i - 1}` : null);
    live.exec("INSERT INTO thread_state VALUES ('t','m5')");
    initializeMessageTables(live);
    live.exec(SEQ_INDEX_SQL);
    numberSeqChunk(live, { rows: 4 });
    const copy = file();
    live.exec(`VACUUM INTO '${copy}'`); // the archive, taken mid-walk
    while (numberSeqChunk(live)) { /* chunks */ }
    expect(inspectInstallationDatabase(live)).toMatchObject({ messages: 6 });
    expect(live.prepare("SELECT seq FROM messages ORDER BY rowid").all().map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    live.close();
    const restored = new DatabaseSync(copy);
    expect(inspectInstallationDatabase(restored)).toMatchObject({ messages: 6 });
    initializeMessageTables(restored);
    expect(readIndexState(restored, "seq")).toMatchObject({ done: 0, cursor: 4 });
    const seen: SeqChunkFigures[] = [];
    const stop = onSeqChunk((figures) => seen.push(figures));
    try { while (numberSeqChunk(restored)) { /* chunks */ } } finally { stop(); }
    expect(seen[0]).toMatchObject({ scanned: 2, numbered: 2 });
    expect(restored.prepare("SELECT seq FROM messages ORDER BY rowid").all().map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    restored.close();
  });
});

describe("the step back to 1.0.2 (Prepare to reinstall)", () => {
  // 1.0.2's known shapes for messages (installation-database-snapshot.ts at d02615fb4: the table text its initializers write, compared with
  // spacing ignored, its columns, and the only indexes it accepts on the table). Anything else is DATABASE_SCHEMA_UNSUPPORTED there.
  const KNOWN_102 = {
    table: "CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))",
    columns: ["thread_id", "id", "at", "role", "kind", "text", "json"],
    indexes: new Set(["messages_thread", "messages_at", "messages_inbox_kind_thread_at", "messages_inbox", "messages_inbox_text_artifact", "messages_pending_browser_check"]),
  };
  const normalized = (sql: string) => sql.replace(/\s+/g, " ").replace(/ ?([(),]) ?/g, "$1").trim();
  const shapeOk = (db: DatabaseSync) => {
    const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='messages'").get() as { sql: string };
    expect(normalized(table.sql)).toBe(KNOWN_102.table);
    expect((db.prepare("PRAGMA table_xinfo(messages)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual(KNOWN_102.columns);
    for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name='messages' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as Array<{ name: string }>) expect(KNOWN_102.indexes.has(row.name), row.name).toBe(true);
  };
  it("drops the index, the column and the walk's place in one step, keeps every row and its json, and a rerun is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-seq-down-"));
    try {
      const db = new DatabaseSync(join(dir, "messages.db"));
      initializeMessageTables(db);
      const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json,seq) VALUES (?,?,1,'user','text','x',?,?)");
      for (let i = 1; i <= 5; i++) put.run("t", `m${i}`, JSON.stringify({ id: `m${i}`, at: 1, role: "user", kind: "text", text: "x" }), i);
      const before = db.prepare("SELECT rowid, thread_id, id, json FROM messages ORDER BY rowid").all();
      expect(downgradeTranscriptSeqTo102(db)).toEqual({ dropped: true });
      // the downgrade's next step takes the other 1.0.3 index on the table (installation-memory-downgrade.ts, message-id-index.ts)
      expect(downgradeMessageIdIndexTo102(db)).toEqual({ dropped: true });
      shapeOk(db);
      expect(db.prepare("SELECT rowid, thread_id, id, json FROM messages ORDER BY rowid").all()).toEqual(before);
      expect(db.prepare("SELECT 1 FROM transcript_index_state WHERE name='seq'").get()).toBeUndefined();
      const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
      expect(downgradeTranscriptSeqTo102(db)).toEqual({ dropped: false });
      expect(db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
      // and 1.0.3 opening it again: the column back (NULL), no index on a file with history, the walk from the start
      initializeMessageTables(db);
      expect(readIndexState(db, "seq")).toMatchObject({ done: 0, cursor: 0 });
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(SEQ_INDEX)).toBeUndefined();
      db.close();
    } finally { removeTempDirSync(dir); }
  });
  it("is called by the downgrade before the application step", () => {
    const source = readFileSync(new URL("./installation-memory-downgrade.ts", import.meta.url), "utf8");
    expect(source.indexOf("downgradeTranscriptSeqTo102(db);")).toBeGreaterThan(0);
    expect(source.indexOf("downgradeTranscriptSeqTo102(db);")).toBeLessThan(source.indexOf("downgradeApplicationSchemaTo101(db,"));
  });
});

describe("static: one decoder, one exit", () => {
  const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  it("rowToMessage is the only JSON decoder of a stored row in message-db.ts and transcript-backfill.ts", () => {
    for (const name of ["message-db.ts", "transcript-backfill.ts"]) {
      const source = read(name);
      expect(source).not.toMatch(/JSON\.parse\(\s*[\w.]*\.json\b/);
      expect(source).not.toMatch(/const rowToMessage/);
      // the only other JSON.parse is the legacy file read
      expect((source.match(/JSON\.parse\(/g) ?? []).length).toBe(name === "message-db.ts" ? 1 : 0);
    }
  });
  it("wireThread is the only exit for thread rows: no slimMessage or newestSeq outside transcript-page.ts, every row answer gated", () => {
    const index = read("index.ts");
    expect(index).not.toMatch(/slimMessage/);
    expect(index).not.toMatch(/newestSeq/);
    expect(read("transcript-page.ts")).not.toMatch(/export function slimMessage/);
    // the frames, gated before broadcast (so the replay buffer holds the gated frame)
    expect(index).toMatch(/broadcast\(\{ kind: "message", threadId: change\.threadId, \.\.\.wireThread\(store, change\.threadId, \{ message: change\.message \}/);
    expect(index).toMatch(/broadcast\(\{ kind: "message\.patch", threadId: change\.threadId, \.\.\.wireThread\(store, change\.threadId, \{ message: change\.message \}/);
    // no answer serializes a row or a transcript outside the gate
    for (const line of index.split("\n")) {
      if (/json\(res, 20\d, \{[^}]*\bmessages?: (store\.|patched|landed|accepted|page\b|branch\.|window\b|message\b)/.test(line)) throw new Error(`a row answer outside wireThread: ${line.trim().slice(0, 160)}`);
      if (/^\s*messages: store\.messagesFor\(/.test(line)) throw new Error(`a transcript outside wireThread: ${line.trim().slice(0, 160)}`);
      if (/\.map\(slim/.test(line)) throw new Error(`a row mapper outside wireThread: ${line.trim().slice(0, 160)}`);
    }
    expect(index).toMatch(/return json\(res, 202, wireReceipt\(receipt\)\)/);
  });
});
