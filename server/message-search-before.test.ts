// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// `before` is a walk start on every search path: rows at or above it are never returned (thread recall r6 rule 5).
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, searchMessagesWithMeta, TRIGRAM_CANDIDATE_CAP } from "./message-db.ts";
import { rebuildMessageSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => {
  closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

const BEFORE = 5_000;

function put(thread: string, id: string, at: number, text: string, kind = "text", json = "{}") {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(thread, id, at, "user", kind, kind === "text" ? text : null, json);
}
/** n rows of `text` in `thread` at times start+1 .. start+n. */
function bulk(thread: string, prefix: string, start: number, n: number, text: string, kind = "text") {
  database().prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?,?||v,?+v,'user',?,?||v,'{}' FROM n`).run(n, thread, prefix, start, kind, text);
}
const ids = (r: ReturnType<typeof searchMessagesWithMeta>) => r.hits.map((hit) => hit.messageId);

it("indexed scoped batch: only rows below before, newest first, none at before", () => {
  put("A", "old1", 1000, "the email one");
  put("A", "old2", 2000, "the email two");
  put("A", "eq", BEFORE, "the email at the cutoff");
  put("A", "new", 9000, "the email newer");
  put("B", "other", 1500, "the email elsewhere");
  rebuildMessageSearchIndex(database());
  const r = searchMessagesWithMeta("email", 40, "A", {}, BEFORE);
  expect(ids(r)).toEqual(["old2", "old1"]);
  expect(r.partial).toBe(false);
  expect(ids(searchMessagesWithMeta("email", 40, "A"))).toEqual(["new", "eq", "old2", "old1"]);
});

it("whole-table index path honours before too", () => {
  put("A", "old", 1000, "the email one");
  put("A", "eq", BEFORE, "the email at the cutoff");
  put("B", "new", 9000, "the email newer");
  bulk("A", "pad-", 20_000, 700, "email padding ");
  rebuildMessageSearchIndex(database());
  const r = searchMessagesWithMeta("email", 40, undefined, {}, BEFORE);
  expect(ids(r)).toEqual(["old"]);
});

it("both walk statements seek the same index with a start timestamp", () => {
  put("A", "x", 1000, "the email one");
  bulk("A", "pad-", 20_000, 50, "email padding ");
  const db = database();
  const original = db.prepare.bind(db);
  const seen: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { seen.push(sql); return original(sql); }) as typeof db.prepare);
  try { searchMessagesWithMeta("em", 40, "A", {}, BEFORE); } finally { spy.mockRestore(); }
  const walks = seen.filter((sql) => /m\.at < \? ORDER BY m\.at DESC/.test(sql) || /m\.at = \? AND m\.rowid < \?/.test(sql));
  expect(walks).toHaveLength(4); // older + tied, for the text and activity streams
  const plan = (sql: string, params: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  for (const sql of walks) {
    const withStart = plan(sql, /m\.at < \?/.test(sql) ? ["text", "A", BEFORE, 500] : ["text", "A", BEFORE - 1, 100, 500]);
    const without = plan(sql, /m\.at < \?/.test(sql) ? ["text", "A", Number.MAX_SAFE_INTEGER, 500] : ["text", "A", 1, Number.MAX_SAFE_INTEGER, 500]);
    expect(withStart).toBe(without);
    expect(withStart).not.toMatch(/SCAN/);
    expect(withStart).not.toMatch(/TEMP B-TREE/);
  }
});

it("capped: CAP+1 newer matches and a 9-thread set answers empty and partial", () => {
  const threads = Array.from({ length: 9 }, (_, i) => `T${i}`);
  put("T0", "old", 1000, "an email long ago");
  bulk("T1", "n-", 100_000, TRIGRAM_CANDIDATE_CAP + 5, "newer email ");
  rebuildMessageSearchIndex(database());
  const r = searchMessagesWithMeta("email", 40, threads, {}, BEFORE);
  expect(r.hits).toEqual([]);
  expect(r.partial).toBe(true);
});

it("capped: an 8-thread set walks each thread below before and nothing outside it", () => {
  const threads = Array.from({ length: 8 }, (_, i) => `T${i}`);
  put("T0", "old0", 1000, "an email long ago");
  put("T3", "old3", 2000, "an email a bit later");
  put("T3", "eq", BEFORE, "an email at the cutoff");
  put("OUT", "out", 1500, "an email outside the set");
  bulk("OUT", "n-", 100_000, TRIGRAM_CANDIDATE_CAP + 5, "newer email ");
  rebuildMessageSearchIndex(database());
  const r = searchMessagesWithMeta("email", 40, threads, {}, BEFORE);
  expect(ids(r)).toEqual(["old3", "old0"]);
});

it("fallback: a 2-codepoint query walks per thread below before, with scope and kind", () => {
  put("A", "old", 1000, "xx one");
  put("A", "eq", BEFORE, "xx cutoff");
  put("A", "new", 9000, "xx newer");
  put("OUT", "out", 1200, "xx outside");
  put("A", "chip", 1100, "", "activity", '{"tool":{"name":"xxtool"}}');
  put("OUT", "outchip", 1300, "", "activity", '{"tool":{"name":"xxtool"}}');
  for (const ready of [true, false]) {
    if (!ready) database().prepare("DROP TABLE IF EXISTS messages_fts").run();
    const r = searchMessagesWithMeta("xx", 40, "A", {}, BEFORE);
    expect(ids(r)).toEqual(["chip", "old"]);
  }
});

it("fallback: the trigram index not ready with a 3+ char query also starts below before", () => {
  put("A", "old", 1000, "marker one");
  put("A", "eq", BEFORE, "marker cutoff");
  put("OUT", "out", 1200, "marker outside");
  database().prepare("DROP TABLE IF EXISTS messages_fts").run();
  expect(ids(searchMessagesWithMeta("marker", 40, "A", {}, BEFORE))).toEqual(["old"]);
});

it("fallback: a whole-table walk (set larger than the window set) starts below before", () => {
  const threads = Array.from({ length: 9 }, (_, i) => `T${i}`);
  put("T2", "old", 1000, "xx one");
  put("T2", "eq", BEFORE, "xx cutoff");
  put("T4", "new", 9000, "xx newer");
  put("OUT", "out", 1200, "xx outside");
  expect(ids(searchMessagesWithMeta("xx", 40, threads, {}, BEFORE))).toEqual(["old"]);
  expect(ids(searchMessagesWithMeta("xx", 40, undefined, {}, BEFORE))).toEqual(["out", "old"]);
});

it("ties: three rows 1 ms below before and two at before: the two are absent, the three come rowid DESC", () => {
  put("A", "b1", BEFORE - 1, "xx tie");
  put("A", "e1", BEFORE, "xx tie");
  put("A", "b2", BEFORE - 1, "xx tie");
  put("A", "e2", BEFORE, "xx tie");
  put("A", "b3", BEFORE - 1, "xx tie");
  expect(ids(searchMessagesWithMeta("xx", 40, "A", {}, BEFORE))).toEqual(["b3", "b2", "b1"]);
  expect(ids(searchMessagesWithMeta("xx", 40, undefined, {}, BEFORE))).toEqual(["b3", "b2", "b1"]);
  rebuildMessageSearchIndex(database());
  expect(ids(searchMessagesWithMeta("tie", 40, "A", {}, BEFORE))).toEqual(["b3", "b2", "b1"]);
});

it("index failure: the walk restarts below before with scoping, nothing at or above leaks", () => {
  put("A", "old", 1000, "an email one");
  put("A", "eq", BEFORE, "an email cutoff");
  put("A", "new", 9000, "an email newer");
  put("OUT", "out", 1200, "an email outside");
  rebuildMessageSearchIndex(database());
  const db = database();
  const original = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (/messages_fts MATCH/.test(sql)) throw new Error("fts broke");
    return original(sql);
  }) as typeof db.prepare);
  let r: ReturnType<typeof searchMessagesWithMeta>;
  try { r = searchMessagesWithMeta("email", 40, "A", {}, BEFORE); } finally { spy.mockRestore(); }
  expect(ids(r)).toEqual(["old"]);
  expect(r.partial).toBe(false);
});

it("door judge: withheld rows are kept for the door to judge, activity rows are not candidates", () => {
  put("A", "plain", 1000, "an email one");
  put("A", "held", 2000, "an email held", "text", '{"withheldFromBots":true}');
  put("A", "chip", 3000, "", "activity", '{"tool":{"name":"emailer"}}');
  expect(ids(searchMessagesWithMeta("em", 40, "A", {}))).toEqual(["chip", "plain"]);
  expect(ids(searchMessagesWithMeta("em", 40, "A", { judge: "door" }))).toEqual(["held", "plain"]);
  expect(ids(searchMessagesWithMeta("em", 40, "A", { judge: "door" }, 2000))).toEqual(["plain"]);
});
