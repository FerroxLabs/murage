// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search reads candidates newest-first in chunks and stops at a full page. The cost is counted in statements and rows read, never in time, and it is the
// same with 20,000 rows that say the word as with 200,000.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { CANDIDATE_WALK_ROWS, closeMessageDb, SCOPED_WINDOW_THREADS, SEARCH_CHUNK, searchMessagesWithMeta, SHORT_QUERY_WINDOW, TRIGRAM_CANDIDATE_CAP, WINDOW_CHUNK } from "./message-db.ts";
import { rebuildMessageSearchIndex, trigramQuery } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => {
  closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

function rows(thread: string, prefix: string, base: number, n: number, text: string, kind = "text", json = "{}") {
  database().prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT ?,?||v,?+v,'user',?,?||v,? FROM n`).run(n, thread, prefix, base, kind, text, json);
}

/** Every statement the search prepares, with the rows each `.all()` handed back. */
function watch<T>(run: () => T): { out: T; statements: Array<{ sql: string; rows: number; calls: number }> } {
  const db = database(), original = db.prepare.bind(db), statements: Array<{ sql: string; rows: number; calls: number }> = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = original(sql), entry = { sql, rows: 0, calls: 0 };
    statements.push(entry);
    return new Proxy(statement, { get(target, key) {
      const value = (target as never)[key] as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (key === "all" || key === "get") entry.calls++;
        if (key === "all") entry.rows += (out as unknown[]).length; else if (key === "get") entry.rows += out ? 1 : 0;
        return out;
      };
    } });
  }) as typeof db.prepare);
  try { return { out: run(), statements }; } finally { spy.mockRestore(); }
}
const calls = (list: Array<{ calls: number }>) => list.reduce((sum, s) => sum + s.calls, 0);
const verifies = (statements: Array<{ sql: string; rows: number; calls: number }>) => statements.filter((s) => /CROSS JOIN messages m ON m\.rowid = c\.value/.test(s.sql));
/** The newest-window statements of a short query over the whole table (the at-index walk: `at < ?` chunks and `at = ? AND rowid < ?` runs). */
const windows = (statements: Array<{ sql: string; rows: number; calls: number }>) => statements.filter((s) => /FROM messages m INDEXED BY messages_at WHERE/.test(s.sql));
/** The per-thread walk's statements (the (kind, thread_id, at) index). */
const threadWalks = (statements: Array<{ sql: string; rows: number; calls: number }>) => statements.filter((s) => /WHERE m\.kind = \? AND m\.thread_id = \? AND m\.at/.test(s.sql));
const rowsOf = (list: Array<{ rows: number }>) => list.reduce((sum, s) => sum + s.rows, 0);
const MAX = Number.MAX_SAFE_INTEGER;
const planOf = (sql: string, ...args: Array<string | number>) => (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((d) => d.detail).join(" | ");

for (const total of [20_000, 120_000]) {
  it(`"email" in ${total} text rows and 200 tool rows with 50 KB JSON: at most 2 chunk statements, 400 rows verified, no count over the index`, () => {
    rows("t", "e-", 1000, total, "about the email number ");
    rows("t", "tool-", 5_000_000, 200, "", "activity", JSON.stringify({ tool: { name: "run" }, big: "x".repeat(50_000) }));
    rows("t", "later-", 9_000_000, 1_000, "unrelated line ");
    rebuildMessageSearchIndex(database());
    const { out, statements } = watch(() => searchMessagesWithMeta("email", 40));
    expect(out.hits).toHaveLength(40);
    expect(out.hits[0]!.messageId).toBe(`e-${total}`);
    expect(out.partial).toBe(true);
    const chunks = statements.filter((s) => /FROM messages_fts/.test(s.sql));
    // one bounded (rowid, at) read of at most cap+1 candidates, then at most two verify pages
    expect(calls(chunks)).toBe(1);
    expect(calls(verifies(statements))).toBeLessThanOrEqual(2);
    const candidateRows = chunks.reduce((sum, s) => sum + s.rows, 0);
    expect(candidateRows).toBeLessThanOrEqual(TRIGRAM_CANDIDATE_CAP + 1);
    expect(statements.some((s) => /count\(\*\)/i.test(s.sql))).toBe(false);
    // the tool rows' JSON is never parsed: none of them is a candidate for a text word
    expect(statements.filter((s) => /json_extract/.test(s.sql)).every((s) => s.rows <= SEARCH_CHUNK)).toBe(true);
  });
}

it("a rare word (3 hits in 20,000 rows) is complete, not partial, in a handful of chunks", () => {
  rows("t", "e-", 1000, 20_000, "about the email number ");
  rows("t", "rare-", 100, 3, "a quokka named ");
  rebuildMessageSearchIndex(database());
  const { out, statements } = watch(() => searchMessagesWithMeta("quokka", 40));
  expect(out.hits.map((hit) => hit.messageId).sort()).toEqual(["rare-1", "rare-2", "rare-3"]);
  expect(out.partial).toBe(false);
  expect(calls(statements.filter((s) => /FROM messages_fts/.test(s.sql)))).toBeLessThanOrEqual(2);
  expect(calls(verifies(statements))).toBeLessThanOrEqual(10);
});

it("hits come back newest first", () => {
  rows("t", "a-", 1000, 30, "the email number ");
  rows("t", "b-", 5000, 30, "the email number ");
  rebuildMessageSearchIndex(database());
  const { hits } = searchMessagesWithMeta("email", 40);
  expect(hits.map((hit) => hit.at)).toEqual([...hits.map((hit) => hit.at)].sort((x, y) => y - x));
  expect(hits[0]!.messageId).toBe("b-30");
});

it("candidates that never verify run to the cap, then the answer says partial; the cap bounds the statements", () => {
  rows("t", "real-", 100, 3, "please send the email number ");
  // all three trigrams, not adjacent: the index names them, the LIKE check refuses them
  rows("t", "decoy-", 100_000, TRIGRAM_CANDIDATE_CAP + 500, "ema mai ail ");
  rebuildMessageSearchIndex(database());
  const { out, statements } = watch(() => searchMessagesWithMeta("email", 40));
  expect(out.hits).toEqual([]);
  expect(out.partial).toBe(true);
  // every candidate verified once, a chunk at a time: at most a chunk per SEARCH_CHUNK candidates plus one remainder per at-index walk chunk
  expect(calls(verifies(statements))).toBeLessThanOrEqual(TRIGRAM_CANDIDATE_CAP / SEARCH_CHUNK + TRIGRAM_CANDIDATE_CAP / WINDOW_CHUNK);
  expect(calls(verifies(statements))).toBeGreaterThanOrEqual(TRIGRAM_CANDIDATE_CAP / SEARCH_CHUNK);
});

it("the thread scope stays inside the cap: another thread's newer matches never count", () => {
  rows("A", "a-", 1000, 5, "the email number ");
  rows("B", "b-", 100_000, 3_000, "the email number ");
  rows("B", "z-", 10_000_000, 1_000, "unrelated line ");
  rebuildMessageSearchIndex(database());
  const { out } = watch(() => searchMessagesWithMeta("email", 40, "A"));
  expect(out.hits.map((hit) => hit.messageId).sort()).toEqual(["a-1", "a-2", "a-3", "a-4", "a-5"]);
  expect(out.hits.every((hit) => hit.threadId === "A")).toBe(true);
  expect(out.partial).toBe(false);
});

it("the candidate chunk is an index range on the rowid with a probe per row, never a scan of messages", () => {
  rows("A", "a-", 1000, 50, "the email number ");
  rebuildMessageSearchIndex(database());
  const { statements } = watch(() => searchMessagesWithMeta("email", 40, "A"));
  const sql = statements.find((s) => /FROM messages_fts/.test(s.sql))!.sql;
  const plan = (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(JSON.stringify(["A"]), trigramQuery("email"), TRIGRAM_CANDIDATE_CAP + 1) as Array<{ detail: string }>).map((d) => d.detail);
  expect(plan.some((d) => /SCAN s\b|SCAN messages(?!_fts)/.test(d))).toBe(false);
  expect(plan.some((d) => /SEARCH s USING INTEGER PRIMARY KEY/.test(d))).toBe(true);
});

it("a verify chunk probes each candidate by rowid: the plan never walks the kind index (rc9: 103,000 index entries per chunk, 1.4 s a search)", () => {
  rows("A", "a-", 1000, 50, "the email number ");
  rebuildMessageSearchIndex(database());
  for (const scope of [undefined, "A"]) {
    const { statements } = watch(() => searchMessagesWithMeta("email", 40, scope));
    const sql = verifies(statements)[0]!.sql;
    const plan = planOf(sql, JSON.stringify([1, 2, 3]), ...(scope ? [JSON.stringify([scope])] : []), "%email%", "%email%");
    expect(plan).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(plan).not.toMatch(/MULTI-INDEX|messages_inbox|SCAN m\b|SCAN messages(?!_fts)/);
  }
});

for (const total of [2_500, 100_000]) {
  it(`a 2-character query whose hits are older than the window reads at most SHORT_QUERY_WINDOW rows in ${total} rows, by covering-index chunks and rowid probes`, () => {
    rows("t", "old-", 100, 10, "zq said long ago ");
    rows("t", "filler-", 1000, total, "a line without the pair ");
    const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40));
    const chunks = windows(statements);
    // a chunk is an `at < ?` read plus, when its last timestamp was cut, one `at = ?` read; the window's end looks one chunk further to tell a
    // complete answer from a partial one
    expect(calls(chunks)).toBeLessThanOrEqual(2 * (SHORT_QUERY_WINDOW / WINDOW_CHUNK) + 2);
    expect(rowsOf(chunks)).toBeLessThanOrEqual(SHORT_QUERY_WINDOW + 2 * WINDOW_CHUNK);
    expect(calls(verifies(statements))).toBeLessThanOrEqual(SHORT_QUERY_WINDOW / WINDOW_CHUNK + 1);
    if (total > SHORT_QUERY_WINDOW) {
      expect(out.hits).toEqual([]);
      expect(out.partial).toBe(true);
      expect(verifies(statements).reduce((sum, s) => sum + s.calls, 0)).toBe(SHORT_QUERY_WINDOW / WINDOW_CHUNK);
    } else {
      expect(out.hits).toHaveLength(10);
      expect(out.partial).toBe(false);
    }
    for (const chunk of chunks) {
      const plan = /m\.at = \?/.test(chunk.sql) ? planOf(chunk.sql, 5, MAX, WINDOW_CHUNK) : planOf(chunk.sql, MAX, WINDOW_CHUNK);
      expect(plan).toMatch(/USING COVERING INDEX messages_at/);
      expect(plan).not.toMatch(/SCAN m\b|SCAN messages|MULTI-INDEX|TEMP B-TREE/);
    }
  });
}

it("a 2-character query scoped to a few threads walks those threads through the kind index: 100,000 newer rows in another thread cost nothing", () => {
  rows("A", "a-", 1000, 5, "zq in thread A ");
  rows("B", "b-", 100_000, 100_000, "zq in thread B ");
  const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40, "A"));
  expect(out.hits.map((hit) => hit.messageId).sort()).toEqual(["a-1", "a-2", "a-3", "a-4", "a-5"]);
  expect(out.hits.every((hit) => hit.threadId === "A")).toBe(true);
  expect(out.partial).toBe(false);
  const perThread = threadWalks(statements);
  // one read of thread A's text rows (5, short: the thread is done) and one of its activity rows (none)
  expect(calls(perThread)).toBe(2);
  expect(rowsOf(perThread)).toBe(5);
  expect(calls(verifies(statements))).toBe(1);
  expect(windows(statements)).toEqual([]);
  for (const walk of perThread) {
    const plan = /m\.at = \?/.test(walk.sql) ? planOf(walk.sql, "text", "A", 5, MAX, WINDOW_CHUNK) : planOf(walk.sql, "text", "A", MAX, WINDOW_CHUNK);
    expect(plan).toMatch(/COVERING INDEX messages_inbox_kind_thread_at/);
    expect(plan).not.toMatch(/SCAN m\b|SCAN messages|TEMP B-TREE/);
  }
});

it("a scope wider than SCOPED_WINDOW_THREADS walks the table's newest rows in bounded chunks and checks the scope by rowid probe", () => {
  const scope = Array.from({ length: SCOPED_WINDOW_THREADS + 1 }, (_, i) => `s${i}`);
  for (const id of scope) rows(id, `${id}-`, 1000, 20, "zq here ");
  rows("other", "o-", 5_000_000, 1_000, "zq newer elsewhere ");
  const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40, scope));
  expect(out.hits).toHaveLength(40);
  expect(out.hits.every((hit) => scope.includes(hit.threadId))).toBe(true);
  // 180 in-scope rows say it and 40 come back: more matches exist, so the answer says partial
  expect(out.partial).toBe(true);
  const chunks = windows(statements);
  expect(rowsOf(chunks)).toBeLessThanOrEqual(SHORT_QUERY_WINDOW + 2 * WINDOW_CHUNK);
  expect(threadWalks(statements)).toEqual([]);
  const plan = planOf(verifies(statements)[0]!.sql, JSON.stringify([1]), JSON.stringify(scope), "%zq%", "%zq%");
  expect(plan).toMatch(/SEARCH m USING INTEGER PRIMARY KEY/);
  expect(plan).not.toMatch(/messages_thread|messages_inbox/);
});

it("a 2-character query reads newest-first chunks of 500 and stops at a full page", () => {
  rows("t", "old-", 1000, 50_000, "zq in a line ");
  rows("t", "new-", 9_000_000, 100, "zq in a newer line ");
  rebuildMessageSearchIndex(database());
  const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40));
  expect(out.hits[0]!.messageId).toBe("new-100");
  expect(out.hits).toHaveLength(40);
  // 50,100 rows say it: the page is full and more exist, so partial
  expect(out.partial).toBe(true);
  expect(calls(verifies(statements))).toBe(1);
  expect(rowsOf(windows(statements))).toBeLessThanOrEqual(2 * WINDOW_CHUNK);
});

/** The scenario from review: 40 recent matches, then 201 older matching messages imported later (higher rowids). */
function importedLater() {
  rows("t", "recent-", 5_000_000, 40, "the email number ");
  rows("t", "import-", 1000, 201, "the email number ");
  rebuildMessageSearchIndex(database());
}

it("older messages imported later (higher rowids) never push the recent matches out of the page", () => {
  importedLater();
  const { out } = watch(() => searchMessagesWithMeta("email", 40));
  expect(out.hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 40 }, (_, i) => `recent-${40 - i}`));
  // 241 matches, 40 returned
  expect(out.partial).toBe(true);
});

it("over the cap: bounded candidate read, partial, sorted by time, and the plan has no unbounded walk", () => {
  importedLater();
  rows("t", "imp2-", 100, TRIGRAM_CANDIDATE_CAP + 100, "the email number ");
  rebuildMessageSearchIndex(database());
  for (const scope of [undefined, "t"]) {
    const { out, statements } = watch(() => searchMessagesWithMeta("email", 40, scope));
    expect(out.partial).toBe(true);
    expect(out.hits).toHaveLength(40);
    expect(out.hits.map((hit) => hit.at)).toEqual([...out.hits.map((hit) => hit.at)].sort((x, y) => y - x));
    const fts = statements.filter((s) => /FROM messages_fts/.test(s.sql));
    expect(calls(fts)).toBe(1);
    expect(fts.reduce((sum, s) => sum + s.rows, 0)).toBeLessThanOrEqual(TRIGRAM_CANDIDATE_CAP + 1);
    const sql = fts[0]!.sql;
    const args = [...(scope ? [JSON.stringify([scope])] : []), trigramQuery("email"), TRIGRAM_CANDIDATE_CAP + 1];
    const plan = (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((d) => d.detail).join(" | ");
    expect(plan).not.toMatch(/SCAN s\b|SCAN messages(?!_fts)/);
    if (scope) {
      expect(statements.some((s) => /INDEXED BY|messages_at/.test(s.sql))).toBe(false);
      expect(plan).toMatch(/SEARCH s USING INTEGER PRIMARY KEY/);
    } else {
      // unscoped: the candidate read touches no message row; time order comes from a bounded covering-index walk
      expect(plan).not.toMatch(/messages(?!_fts)|SEARCH s/);
      const walks = windows(statements);
      expect(rowsOf(walks)).toBeLessThanOrEqual(CANDIDATE_WALK_ROWS + 2 * WINDOW_CHUNK);
      for (const walk of walks) expect(noSort(walk.sql)).toMatch(/USING COVERING INDEX messages_at/);
      for (const walk of walks) expect(noSort(walk.sql)).not.toMatch(/TEMP B-TREE|SCAN m\b|SCAN messages/);
    }
  }
});

// rc13 data run: an unscoped common word read every candidate's row for its timestamp (2,001 random table pages a search; 53 to 249 ms while
// the memory upgrade's commits kept dropping the page cache). The candidates are now put in time order by the at index.
describe("an unscoped search over many candidates", () => {
  const rowReads = (statements: Array<{ sql: string; rows: number; calls: number }>) =>
    statements.filter((s) => /LEFT JOIN messages s|SELECT c\.value AS rowid, m\.at AS at/.test(s.sql));

  it("reads no row per candidate: the at index orders them and only the rows verified are read", () => {
    rows("t", "e-", 1000, 20_000, "about the email number ");
    rows("t", "later-", 9_000_000, 1_000, "unrelated line ");
    rebuildMessageSearchIndex(database());
    const { out, statements } = watch(() => searchMessagesWithMeta("email", 40));
    expect(out.hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 40 }, (_, i) => `e-${20_000 - i}`));
    expect(out.partial).toBe(true);
    expect(rowReads(statements)).toEqual([]);
    // the walk stops a chunk or so past the newest page of hits (1,000 newer rows without the word, then the hits)
    expect(rowsOf(windows(statements))).toBeLessThanOrEqual(1_000 + 2 * WINDOW_CHUNK);
    // rows verified: one chunk of what the walk picked out, never the cap
    expect(calls(verifies(statements))).toBe(1);
  });

  it("candidates past the walk's bound are read by rowid, and the page is still in exact time order", () => {
    rows("t", "old-", 1000, 300, "the email number ");
    rows("t", "filler-", 1_000_000, CANDIDATE_WALK_ROWS + 1_000, "unrelated line ");
    // imported later: higher rowids, older timestamps
    rows("t", "imp-", 100, 300, "the email number ");
    rebuildMessageSearchIndex(database());
    const { out, statements } = watch(() => searchMessagesWithMeta("email", 40));
    expect(out.hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 40 }, (_, i) => `old-${300 - i}`));
    expect(out.partial).toBe(true);
    expect(rowsOf(windows(statements))).toBeLessThanOrEqual(CANDIDATE_WALK_ROWS + 2 * WINDOW_CHUNK);
    expect(rowsOf(rowReads(statements))).toBe(600);
    const complete = searchMessagesWithMeta("email", 100);
    expect(complete.hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 100 }, (_, i) => `old-${300 - i}`));
  });

  it("matches the time order of the old full read, ties by newest-inserted, across walk chunks", () => {
    rowsAt("t", "eq-", 5_000, 700, "the email said at once ");
    rows("t", "after-", 6_000, 300, "the email after ");
    rows("t", "before-", 100, 300, "the email before ");
    rebuildMessageSearchIndex(database());
    const { hits, partial } = searchMessagesWithMeta("email", 100);
    expect(hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 100 }, (_, i) => `after-${300 - i}`));
    expect(partial).toBe(true);
    const deep = searchMessagesWithMeta("email", 1_000).hits.map((hit) => hit.messageId);
    expect(deep.slice(300, 1_000)).toEqual(Array.from({ length: 700 }, (_, i) => `eq-${700 - i}`));
  });
});

for (const history of [2_000, 40_000]) {
  it(`cost is flat with ${history} matching rows in history: candidate rows read stay near the cap`, () => {
    importedLater();
    rows("t", "bulk-", 100, history, "the email number ");
    rebuildMessageSearchIndex(database());
    const { out, statements } = watch(() => searchMessagesWithMeta("email", 40));
    // over the cap the answer is the newest-inserted candidates, partial; here only boundedness and time order are promised
    expect(out.partial).toBe(true);
    expect(out.hits.map((hit) => hit.at)).toEqual([...out.hits.map((hit) => hit.at)].sort((x, y) => y - x));
    const read = statements.filter((s) => /FROM messages_fts/.test(s.sql)).reduce((sum, s) => sum + s.rows, 0);
    expect(read).toBeLessThanOrEqual(TRIGRAM_CANDIDATE_CAP + 1);
  });
}

/** n rows that all carry one timestamp. */
function rowsAt(thread: string, prefix: string, at: number, n: number, text: string) {
  database().prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT ?,?||v,?,'user','text',?||v,'{}' FROM n`).run(n, thread, prefix, at, text);
}
const walkStatements = (statements: Array<{ sql: string; rows: number; calls: number }>) => [...windows(statements), ...threadWalks(statements)];
const noSort = (sql: string) => {
  const args = /m\.kind = \?/.test(sql) ? ["text", "t"] : [];
  return planOf(sql, ...args, ...(/m\.at = \?/.test(sql) ? [5, MAX] : [MAX]), WINDOW_CHUNK);
};

// rc12 review: the window ordered by (at DESC, rowid DESC) over indexes that hold equal timestamps in ascending rowid order, so SQLite sorted every
// run of equal timestamps it met (USE TEMP B-TREE FOR LAST TERM OF ORDER BY): 100,000 equal timestamps were ~1.7M steps for 500 rows.
for (const scope of [undefined, "t"]) {
  it(`100,000 rows with one timestamp: the walk reads index order only, bounded by the window (${scope ? "one thread" : "whole table"})`, () => {
    rowsAt("t", "eq-", 5_000, 100_000, "a line without the pair ");
    const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40, scope));
    expect(out.hits).toEqual([]);
    expect(out.partial).toBe(true);
    const walks = walkStatements(statements);
    expect(walks.length).toBeGreaterThan(0);
    // rows handed back by every walk statement: the window, plus the cut chunk re-read as one timestamp and the look past the window's end
    expect(rowsOf(walks)).toBeLessThanOrEqual(SHORT_QUERY_WINDOW + 2 * WINDOW_CHUNK);
    expect(calls(walks)).toBeLessThanOrEqual(2 * (SHORT_QUERY_WINDOW / WINDOW_CHUNK) + 4);
    expect(rowsOf(verifies(statements))).toBe(0);
    expect(calls(verifies(statements))).toBe(SHORT_QUERY_WINDOW / WINDOW_CHUNK);
    for (const walk of walks) {
      const plan = noSort(walk.sql);
      expect(plan, walk.sql).toMatch(/USING COVERING INDEX/);
      expect(plan, walk.sql).not.toMatch(/TEMP B-TREE|SCAN m\b|SCAN messages/);
    }
  });
}

it("hits that share a timestamp come back newest-inserted first, across chunk boundaries", () => {
  rowsAt("t", "eq-", 5_000, 1_200, "zq said at once ");
  for (const scope of [undefined, "t"]) {
    const { hits, partial } = searchMessagesWithMeta("zq", 100, scope);
    expect(hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 100 }, (_, i) => `eq-${1_200 - i}`));
    expect(partial).toBe(true);
    // the whole run, in the same order, when the page can hold it
    const all = searchMessagesWithMeta("zq", 1_200, scope);
    expect(all.hits.map((hit) => hit.messageId)).toEqual(Array.from({ length: 1_200 }, (_, i) => `eq-${1_200 - i}`));
    expect(all.partial).toBe(false);
  }
});

// rc12 review: `LIMIT 2001` counted after the scope filter, so thread A's one match behind 100,000 newer matches in thread B probed all of them.
it("a scoped search examines at most the cap of index matches: thread A's one match behind 100,000 newer matches in thread B", () => {
  rows("A", "a-", 1000, 1, "please send the email number ");
  rows("A", "y-", 2000, 300, "unrelated line ");
  rows("B", "b-", 100_000, 100_000, "another email number ");
  rebuildMessageSearchIndex(database());
  const { out, statements } = watch(() => searchMessagesWithMeta("email", 40, "A"));
  expect(out.hits.map((hit) => hit.messageId)).toEqual(["a-1"]);
  // every row of thread A was looked at and its one match returned
  expect(out.partial).toBe(false);
  const fts = statements.filter((s) => /FROM messages_fts/.test(s.sql));
  expect(calls(fts)).toBe(1);
  expect(rowsOf(fts)).toBeLessThanOrEqual(TRIGRAM_CANDIDATE_CAP + 1);
  // then thread A's own rows, newest first, bounded by the window
  expect(rowsOf(threadWalks(statements))).toBeLessThanOrEqual(301);
  expect(rowsOf(verifies(statements))).toBe(1);
});

it("a wide scope examines at most the cap of index matches, and says partial when it stopped there", () => {
  const scope = Array.from({ length: SCOPED_WINDOW_THREADS + 1 }, (_, i) => `s${i}`);
  for (const id of scope) rows(id, `${id}-`, 1000, 1, "please send the email number ");
  rows("B", "b-", 100_000, 100_000, "another email number ");
  rebuildMessageSearchIndex(database());
  const { out, statements } = watch(() => searchMessagesWithMeta("email", 40, scope));
  expect(out.partial).toBe(true);
  expect(out.hits.every((hit) => scope.includes(hit.threadId))).toBe(true);
  const fts = statements.filter((s) => /FROM messages_fts/.test(s.sql));
  expect(calls(fts)).toBe(1);
  expect(rowsOf(fts)).toBeLessThanOrEqual(TRIGRAM_CANDIDATE_CAP + 1);
  expect(walkStatements(statements)).toEqual([]);
  // the same scope with few enough matches to examine them all is complete
  closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  for (const id of scope) rows(id, `${id}-`, 1000, 1, "please send the email number ");
  rows("B", "b-", 100_000, 500, "another email number ");
  rebuildMessageSearchIndex(database());
  const small = searchMessagesWithMeta("email", 40, scope);
  expect(small.hits).toHaveLength(scope.length);
  expect(small.partial).toBe(false);
});

// rc12 review: partial is true exactly when matches exist beyond the page or the search stopped with candidates in scope left unexamined.
describe("the partial contract", () => {
  for (const [name, needle, index] of [["short query", "zq", false], ["trigram", "email", true]] as const) {
    it(`${name}: 60 matches with limit 40 is partial; 40 with limit 40 is not`, () => {
      rows("t", "m-", 1000, 60, `the ${needle} line `);
      if (index) rebuildMessageSearchIndex(database());
      const over = searchMessagesWithMeta(needle, 40);
      expect(over.hits).toHaveLength(40);
      expect(over.partial).toBe(true);
      expect(searchMessagesWithMeta(needle, 40, "t").partial).toBe(true);
      const whole = searchMessagesWithMeta(needle, 60);
      expect(whole.hits).toHaveLength(60);
      expect(whole.partial).toBe(false);
      expect(searchMessagesWithMeta(needle, 60, "t").partial).toBe(false);
    });
  }

  it("a window of exactly SHORT_QUERY_WINDOW rows that all were examined is complete; one row more is partial", () => {
    rows("t", "n-", 1000, SHORT_QUERY_WINDOW, "a line without the pair ");
    expect(searchMessagesWithMeta("zq", 40)).toEqual({ hits: [], partial: false });
    expect(searchMessagesWithMeta("zq", 40, "t")).toEqual({ hits: [], partial: false });
    rows("t", "old-", 100, 1, "a line without the pair ");
    expect(searchMessagesWithMeta("zq", 40)).toEqual({ hits: [], partial: true });
    expect(searchMessagesWithMeta("zq", 40, "t")).toEqual({ hits: [], partial: true });
  });

  it("a scoped trigram search past the cap walks the scope: complete when the scope ran out, partial when the window did", () => {
    rows("A", "a-", 1000, 3, "please send the email number ");
    rows("B", "b-", 100_000, TRIGRAM_CANDIDATE_CAP + 100, "another email number ");
    rebuildMessageSearchIndex(database());
    expect(searchMessagesWithMeta("email", 40, "A")).toMatchObject({ partial: false });
    rows("A", "z-", 10_000_000, SHORT_QUERY_WINDOW, "unrelated line ");
    const crowded = searchMessagesWithMeta("email", 40, "A");
    expect(crowded.hits).toEqual([]);
    expect(crowded.partial).toBe(true);
  });
});

// The owner is shown every row of their own transcripts; any other reader never gets a row the owner withheld from bots.
describe("rows withheld from bots", () => {
  for (const [name, needle, index] of [["short query", "zq", false], ["trigram", "email", true]] as const) {
    it(`${name}: shown to the owner, never to another reader`, () => {
      rows("t", "open-", 1000, 2, `the ${needle} line `);
      rows("t", "held-", 2000, 1, `the ${needle} line `, "text", JSON.stringify({ withheldFromBots: true }));
      rows("t", "forgot-", 3000, 1, `the ${needle} line `, "text", JSON.stringify({ withheldFromBots: "forgotten" }));
      rows("t", "check-", 4000, 1, `the ${needle} line `, "text", JSON.stringify({ withheldFromBots: "checking" }));
      rows("t", "cleared-", 5000, 1, `the ${needle} line `, "text", JSON.stringify({ withheldFromBots: false }));
      if (index) rebuildMessageSearchIndex(database());
      const owner = searchMessagesWithMeta(needle, 40, undefined, { owner: true }).hits.map((hit) => hit.messageId).sort();
      expect(owner).toEqual(["check-1", "cleared-1", "forgot-1", "held-1", "open-1", "open-2"]);
      for (const scope of [undefined, "t"]) {
        // a "checking" left on disk is no note (never a stored verdict, R2): the row is a hit for every reader
        const other = searchMessagesWithMeta(needle, 40, scope).hits.map((hit) => hit.messageId).sort();
        expect(other).toEqual(["check-1", "cleared-1", "open-1", "open-2"]);
        // a page of one: LIMIT counts rows this reader may get
        expect(searchMessagesWithMeta(needle, 1, scope).hits.map((hit) => hit.messageId)).toEqual(["cleared-1"]);
      }
    });
  }
});
