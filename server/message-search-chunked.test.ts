// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search reads candidates newest-first in chunks and stops at a full page. The cost is counted in statements and rows read, never in time, and it is the
// same with 20,000 rows that say the word as with 200,000.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, SCOPED_WINDOW_THREADS, SEARCH_CHUNK, searchMessagesWithMeta, SHORT_QUERY_WINDOW, TRIGRAM_CANDIDATE_CAP, WINDOW_CHUNK } from "./message-db.ts";
import { rebuildMessageSearchIndex, trigramQuery } from "./message-search-index.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
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
/** The newest-window chunk statements of a short query (the at-index walk; the per-thread form says UNION ALL). */
const windows = (statements: Array<{ sql: string; rows: number; calls: number }>) => statements.filter((s) => /SELECT m\.rowid AS rowid, m\.at AS at FROM messages m WHERE m\.at <= \?/.test(s.sql) && !/UNION ALL/.test(s.sql));
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
  expect(calls(verifies(statements))).toBe(TRIGRAM_CANDIDATE_CAP / SEARCH_CHUNK);
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
  const plan = (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(trigramQuery("email"), JSON.stringify(["A"]), TRIGRAM_CANDIDATE_CAP + 1) as Array<{ detail: string }>).map((d) => d.detail);
  expect(plan.some((d) => /SCAN s\b|SCAN messages/.test(d))).toBe(false);
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
    expect(calls(chunks)).toBeLessThanOrEqual(SHORT_QUERY_WINDOW / WINDOW_CHUNK + 1);
    expect(chunks.reduce((sum, s) => sum + s.rows, 0)).toBeLessThanOrEqual(SHORT_QUERY_WINDOW);
    expect(calls(verifies(statements))).toBeLessThanOrEqual(calls(chunks));
    if (total > SHORT_QUERY_WINDOW) {
      expect(out.hits).toEqual([]);
      expect(out.partial).toBe(true);
      expect(chunks.reduce((sum, s) => sum + s.rows, 0)).toBe(SHORT_QUERY_WINDOW);
    } else {
      expect(out.hits).toHaveLength(10);
      expect(out.partial).toBe(false);
    }
    const plan = planOf(chunks[0]!.sql, MAX, MAX, MAX, WINDOW_CHUNK);
    expect(plan).toMatch(/USING COVERING INDEX/);
    expect(plan).not.toMatch(/SCAN m\b|SCAN messages|MULTI-INDEX/);
  });
}

it("a 2-character query scoped to a few threads walks those threads through the kind index: 100,000 newer rows in another thread cost nothing", () => {
  rows("A", "a-", 1000, 5, "zq in thread A ");
  rows("B", "b-", 100_000, 100_000, "zq in thread B ");
  const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40, "A"));
  expect(out.hits.map((hit) => hit.messageId).sort()).toEqual(["a-1", "a-2", "a-3", "a-4", "a-5"]);
  expect(out.hits.every((hit) => hit.threadId === "A")).toBe(true);
  expect(out.partial).toBe(false);
  const perThread = statements.filter((s) => /UNION ALL/.test(s.sql));
  expect(calls(perThread)).toBe(1);
  expect(perThread[0]!.rows).toBe(5);
  expect(calls(verifies(statements))).toBe(1);
  const plan = planOf(perThread[0]!.sql, "text", "A", MAX, MAX, MAX, WINDOW_CHUNK, "activity", "A", MAX, MAX, MAX, WINDOW_CHUNK, WINDOW_CHUNK);
  expect(plan).toMatch(/COVERING INDEX messages_inbox_kind_thread_at/);
  expect(plan).not.toMatch(/SCAN m\b|SCAN messages/);
});

it("a scope wider than SCOPED_WINDOW_THREADS walks the table's newest rows in bounded chunks and checks the scope by rowid probe", () => {
  const scope = Array.from({ length: SCOPED_WINDOW_THREADS + 1 }, (_, i) => `s${i}`);
  for (const id of scope) rows(id, `${id}-`, 1000, 20, "zq here ");
  rows("other", "o-", 5_000_000, 1_000, "zq newer elsewhere ");
  const { out, statements } = watch(() => searchMessagesWithMeta("zq", 40, scope));
  expect(out.hits).toHaveLength(40);
  expect(out.hits.every((hit) => scope.includes(hit.threadId))).toBe(true);
  expect(out.partial).toBe(false);
  const chunks = windows(statements);
  expect(chunks.reduce((sum, s) => sum + s.rows, 0)).toBeLessThanOrEqual(SHORT_QUERY_WINDOW);
  expect(statements.some((s) => /UNION ALL/.test(s.sql))).toBe(false);
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
  expect(out.partial).toBe(false);
  expect(calls(verifies(statements))).toBe(1);
  expect(statements.reduce((sum, s) => sum + (/SELECT m\.rowid AS rowid, m\.at/.test(s.sql) ? s.rows : 0), 0)).toBeLessThanOrEqual(500);
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
  expect(out.partial).toBe(false);
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
    expect(statements.some((s) => /INDEXED BY|messages_at/.test(s.sql))).toBe(false);
    const sql = fts[0]!.sql;
    const args = [trigramQuery("email"), ...(scope ? [JSON.stringify([scope])] : []), TRIGRAM_CANDIDATE_CAP + 1];
    const plan = (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((d) => d.detail).join(" | ");
    expect(plan).not.toMatch(/SCAN s\b|SCAN messages(?!_fts)/);
    expect(plan).toMatch(/SEARCH s USING INTEGER PRIMARY KEY/);
  }
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
