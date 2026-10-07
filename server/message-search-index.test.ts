// SPDX-License-Identifier: AGPL-3.0-or-later
// The trigram search index (messages_fts) must change WHICH rows a search
// reads, never WHICH rows it returns. Every test here either proves the index
// stays in step with messages through each write path, or compares the
// indexed search against the plain scan it replaced.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, deleteThread, insertMessage, searchMessages, updateMessage } from "./message-db.ts";
import {
  backfillMessageSearchIndex,
  messageSearchIndexReady,
  rebuildMessageSearchIndex,
  trigramQuery,
} from "./message-search-index.ts";
import type { Message } from "./store.ts";

let clock = 1_000;
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: ++clock, ...extra });
const chip = (id: string, tool: string): Message =>
  ({ id, role: "bot", kind: "activity", at: ++clock, tool: { name: tool, ok: true } }) as Message;

/** The query searchMessages() ran before the index existed, verbatim. */
function scan(needle: string, limit = 40, thread?: string) {
  const folded = needle.trim().toLowerCase();
  const pattern = `%${folded.replace(/([\\%_])/g, "\\$1")}%`;
  return database()
    .prepare(
      "SELECT thread_id, id FROM messages " +
        `WHERE ${thread ? "thread_id = ? AND " : ""}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\') ` +
        "   OR (kind = 'activity' AND json_extract(json, '$.tool.name') IS NOT NULL AND lower(json_extract(json, '$.tool.name')) LIKE ? ESCAPE '\\')) " +
        "ORDER BY at DESC, rowid DESC LIMIT ?",
    )
    .all(...(thread ? [thread] : []), pattern, pattern, limit)
    .map((row) => `${row.thread_id}/${row.id}`);
}
const found = (query: string, limit = 40, thread?: string) =>
  searchMessages(query, limit, thread).map((hit) => `${hit.threadId}/${hit.messageId}`);
const indexedRows = () => Number(database().prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get()!.n);
const fts = (query: string) =>
  database().prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(trigramQuery(query)).length;

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

describe("index stays in step with every write path", () => {
  it("indexes inserts and answers from the index", () => {
    insertMessage("t", msg("m1", "Deploy the Railway service"));
    insertMessage("t", chip("c1", "Bash: alembic upgrade head"));
    insertMessage("t", { ...msg("m2", "an options card"), kind: "options" });
    expect(messageSearchIndexReady(database())).toBe(true);
    expect(indexedRows()).toBe(2); // the text row and the chip; not the card
    expect(found("railway")).toEqual(["t/m1"]);
    expect(found("ALEMBIC upgrade")).toEqual(["t/c1"]);
    expect(found("options card")).toEqual([]);
    expect(fts("railway")).toBe(1);
  });

  it("an edit re-indexes: the old words stop matching, the new ones start", () => {
    insertMessage("t", msg("m1", "first draft about alpacas"));
    updateMessage("t", msg("m1", "second draft about llamas"));
    expect(found("alpacas")).toEqual([]);
    expect(found("llamas")).toEqual(["t/m1"]);
    expect(fts("alpacas")).toBe(0);
    expect(indexedRows()).toBe(1);
  });

  it("a patch that leaves the text alone does not disturb the entry", () => {
    insertMessage("t", msg("m1", "stable words here"));
    updateMessage("t", { ...msg("m1", "stable words here"), attachments: [] });
    expect(found("stable words")).toEqual(["t/m1"]);
    expect(indexedRows()).toBe(1);
  });

  it("a message that changes kind or loses its text leaves the index", () => {
    insertMessage("t", msg("m1", "will become a card"));
    insertMessage("t", msg("m2", "will lose text"));
    updateMessage("t", { ...msg("m1", "will become a card"), kind: "options" });
    updateMessage("t", { id: "m2", role: "user", kind: "text", at: 5 } as Message);
    expect(found("become a card")).toEqual([]);
    expect(found("lose text")).toEqual([]);
    expect(indexedRows()).toBe(0);
  });

  it("an activity chip is found by tool name and follows a rename", () => {
    insertMessage("t", chip("c1", "Bash: ls"));
    updateMessage("t", chip("c1", "Grep: needle"));
    expect(found("bash")).toEqual([]);
    expect(found("grep: needle")).toEqual(["t/c1"]);
  });

  it("re-inserting an id (INSERT OR REPLACE gives it a new rowid) leaves exactly one entry", () => {
    insertMessage("t", msg("m1", "version one text"));
    insertMessage("t", msg("m2", "neighbour"));
    insertMessage("t", msg("m1", "version two text"));
    expect(found("version one")).toEqual([]);
    expect(found("version two")).toEqual(["t/m1"]);
    expect(indexedRows()).toBe(2);
    // replacing the newest row reuses its rowid: the entry must still be right
    insertMessage("t", msg("m1", "version three text"));
    expect(found("version two")).toEqual([]);
    expect(found("version three")).toEqual(["t/m1"]);
    expect(indexedRows()).toBe(2);
  });

  it("deleting a thread removes its entries and merges them out of the index", () => {
    insertMessage("a", msg("m1", "qzvxkjw keepsake"));
    insertMessage("b", msg("m2", "zzqwvmx secret conversation"));
    deleteThread("b");
    expect(found("secret conversation")).toEqual([]);
    expect(found("keepsake")).toEqual(["a/m1"]);
    expect(indexedRows()).toBe(1);
    const db = database();
    db.exec("CREATE VIRTUAL TABLE temp.terms USING fts5vocab(main, messages_fts, 'row')");
    try {
      const terms = db.prepare("SELECT term FROM temp.terms").all().map((row) => String(row.term));
      expect(terms).toContain("qzv");
      expect(terms.filter((term) => "zzqwvmx secret conversation".includes(term) && !"qzvxkjw keepsake".includes(term))).toEqual([]);
    } finally { db.exec("DROP TABLE temp.terms"); }
  });

  it("scoped search sees only its threads, with LIMIT counted among visible rows", () => {
    for (let i = 0; i < 5; i++) insertMessage("noisy", msg(`n${i}`, "needle in the noise"));
    insertMessage("quiet", msg("q1", "needle in the quiet"));
    expect(found("needle", 40, "quiet")).toEqual(["quiet/q1"]);
    expect(searchMessages("needle", 3, ["quiet", "noisy"]).length).toBe(3);
    expect(searchMessages("needle", 40, [])).toEqual([]);
  });
});

describe("indexed search equals the scan it replaced", () => {
  it("agrees on a mixed corpus: case, wildcards, quotes, FTS syntax, CJK, emoji, accents", () => {
    const corpus = [
      "Railway deploy RAILWAY up", "50% done_ready", "she said \"hello world\" twice", "NEAR(a b) AND OR NOT *star* ^caret -dash",
      "日本語のテキストを検索する", "你好，世界。再见", "हिन्दी में खोज", "emoji 😀😀😀 party", "Café crème brûlée ÉCOLE",
      "col:umn t:filter {braces} (parens) 'single'", "tab\tand\nnewline spaced   out", "ab", "x".repeat(300) + " tail needle",
    ];
    corpus.forEach((text, i) => insertMessage(i % 2 ? "odd" : "even", msg(`m${i}`, text)));
    insertMessage("odd", chip("chip", "Edit: Café.ts"));
    const queries = [
      "railway", "RAILWAY UP", "50%", "_ready", "done_", "\"hello", "hello world\"", "\"hello world\"", "near(a b)", "and or", "*star*", "^caret", "-dash",
      "日本語", "日本", "本語の", "テキストを検索", "你好", "你好，世界", "世界。再", "हिन्दी", "😀😀😀", "😀😀", "é", "café", "CAFÉ", "crème", "École", "brûlée",
      "col:umn", "t:filter", "{braces}", "(parens)", "'single'", "tab\tand", "newline spaced", "ab", "a", "tail needle", "Edit: Café", "nomatchatall", "x".repeat(40), "%", "_", "\\",
    ];
    for (const query of queries) expect({ query, got: found(query) }).toEqual({ query, got: scan(query) });
  });

  it("agrees with a limit and with a thread scope", () => {
    for (let i = 0; i < 30; i++) insertMessage(i % 3 ? "x" : "y", msg(`m${i}`, `common phrase number ${i}`));
    expect(found("common phrase", 7)).toEqual(scan("common phrase", 7));
    expect(found("common phrase", 40, "y")).toEqual(scan("common phrase", 40, "y"));
  });

  it("agrees across the newest-rows shortcut and the index: dense word, rare word, equal timestamps, scope", () => {
    const db = database();
    db.exec("BEGIN");
    for (let i = 0; i < 1200; i++) {
      const text = `filler ${i} dense${i % 7 === 0 ? " common-word" : ""}${i === 3 ? " ancient-needle" : ""}`;
      const at = i < 20 ? 5 : i; // a run of rows sharing one timestamp
      db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', ?, ?)")
        .run(i % 2 ? "x" : "y", `m${i}`, at, text, JSON.stringify({ id: `m${i}`, at, role: "user", kind: "text", text }));
    }
    db.exec("COMMIT");
    closeMessageDb(); // reopen backfills
    for (const [query, limit, thread] of [["common-word", 40], ["common-word", 5], ["common-word", 300], ["ancient-needle", 40], ["dense", 40], ["filler 1", 25], ["common-word", 40, "x"], ["ancient-needle", 40, "y"], ["ancient-needle", 40, "x"]] as const) {
      expect({ query, limit, thread, got: found(query, limit, thread) }).toEqual({ query, limit, thread, got: scan(query, limit, thread) });
    }
  });

  it("short queries and queries under three code points scan and still find everything", () => {
    insertMessage("t", msg("m1", "日本の天気"));
    insertMessage("t", msg("m2", "😀😀 two faces"));
    insertMessage("t", msg("m3", "go to ab"));
    expect(found("日本")).toEqual(["t/m1"]); // 2 code points: below a trigram
    expect(found("😀😀")).toEqual(["t/m2"]); // 4 UTF-16 units, 2 code points
    expect(found("ab")).toEqual(["t/m3"]);
    expect(found("の")).toEqual(["t/m1"]);
    expect(found("日本の")).toEqual(["t/m1"]); // 3 code points: indexed
  });

  it("searches without the index when it is gone, and writes keep working", () => {
    insertMessage("t", msg("m1", "before the index broke"));
    database().exec("DROP TABLE messages_fts");
    expect(found("index broke")).toEqual(["t/m1"]); // query fails, falls back to the scan
    expect(messageSearchIndexReady(database())).toBe(false);
    expect(() => insertMessage("t", msg("m2", "after the index broke"))).not.toThrow();
    expect(found("index broke")).toEqual(["t/m2", "t/m1"]);
  });
});

describe("backfill", () => {
  const raw = (id: string, text: string, at: number, kind = "text") =>
    database()
      .prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES ('t', ?, ?, 'user', ?, ?, ?)")
      .run(id, at, kind, text, JSON.stringify({ id, at, role: "user", kind, text, ...(kind === "activity" ? { tool: { name: text } } : {}) }));

  it("builds the index for existing rows on open, once, and only above what it covers", () => {
    insertMessage("t", msg("m1", "indexed already"));
    raw("m2", "added by an older release", 5);
    raw("m3", "Bash: from an old chip", 6, "activity");
    closeMessageDb(); // the next open runs the backfill
    expect(found("older release")).toEqual(["t/m2"]);
    expect(found("old chip")).toEqual(["t/m3"]);
    expect(indexedRows()).toBe(3);
    expect(backfillMessageSearchIndex(database())).toBe(0); // idempotent
    expect(indexedRows()).toBe(3);
  });

  it("builds a whole index from nothing (a database restored from before the index) in chunks", () => {
    const db = database();
    db.exec("BEGIN");
    for (let i = 0; i < 1300; i++) raw(`r${i}`, `restored row number ${i} with some text`, i + 1);
    db.exec("COMMIT");
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('delete-all')");
    expect(indexedRows()).toBe(0);
    closeMessageDb();
    expect(found("number 1234 with")).toEqual(["t/r1234"]);
    expect(indexedRows()).toBe(1300);
  });

  it("resumes an interrupted backfill and agrees with the scan afterwards", () => {
    const db = database();
    for (let i = 0; i < 40; i++) raw(`r${i}`, `resumable row ${i}`, i + 1);
    rebuildMessageSearchIndex(db);
    db.prepare("DELETE FROM messages_fts WHERE rowid > 20").run(); // killed halfway
    closeMessageDb();
    for (const query of ["resumable row 3", "resumable row 39", "resumable"]) expect(found(query)).toEqual(scan(query));
    expect(indexedRows()).toBe(40);
  });

  it("survives VACUUM and VACUUM INTO: rowids, and so the index, are unchanged", () => {
    for (let i = 0; i < 50; i++) insertMessage("t", msg(`m${i}`, `vacuum subject ${i}`));
    deleteThread("t"); // leave holes in the rowid space
    for (let i = 0; i < 50; i++) insertMessage("u", msg(`n${i}`, `vacuum survivor ${i}`));
    const db = database();
    const before = db.prepare("SELECT rowid, id FROM messages ORDER BY rowid").all().map((row) => `${row.rowid}:${row.id}`);
    db.exec("VACUUM");
    expect(db.prepare("SELECT rowid, id FROM messages ORDER BY rowid").all().map((row) => `${row.rowid}:${row.id}`)).toEqual(before);
    expect(found("vacuum survivor 7")).toEqual(scan("vacuum survivor 7"));
    expect(found("vacuum survivor 7")).toEqual(["u/n7"]);
    const copy = join(DATA_DIR, "copy.db");
    db.prepare("VACUUM INTO ?").run(copy);
    
    const other = new DatabaseSync(copy);
    try {
      expect(other.prepare("SELECT rowid, id FROM messages ORDER BY rowid").all().map((row) => `${row.rowid}:${row.id}`)).toEqual(before);
      expect(other.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get(trigramQuery("survivor 7"))!.n).toBe(1);
    } finally { other.close(); }
  });
});
