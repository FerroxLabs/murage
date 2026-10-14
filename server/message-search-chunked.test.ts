// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search reads candidates newest-first in chunks and stops at a full page. The cost is counted in statements and rows read, never in time, and it is the
// same with 20,000 rows that say the word as with 200,000.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, SEARCH_CHUNK, searchMessagesWithMeta, TRIGRAM_CANDIDATE_CAP } from "./message-db.ts";
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
const verifies = (statements: Array<{ sql: string; rows: number; calls: number }>) => statements.filter((s) => /json_each\(\?\)\) AND/.test(s.sql) && /FROM messages m/.test(s.sql));

for (const total of [20_000, 120_000]) {
  it(`"email" in ${total} text rows and 200 tool rows with 50 KB JSON: at most 2 chunk statements, 400 rows verified, no count over the index`, () => {
    rows("t", "e-", 1000, total, "about the email number ");
    rows("t", "tool-", 5_000_000, 200, "", "activity", JSON.stringify({ tool: { name: "run" }, big: "x".repeat(50_000) }));
    rows("t", "later-", 9_000_000, 1_000, "unrelated line ");
    rebuildMessageSearchIndex(database());
    const { out, statements } = watch(() => searchMessagesWithMeta("email", 40));
    expect(out.hits).toHaveLength(40);
    expect(out.hits[0]!.messageId).toBe(`e-${total}`);
    expect(out.partial).toBe(false);
    const chunks = statements.filter((s) => /FROM messages_fts/.test(s.sql));
    expect(calls(chunks)).toBe(1);
    expect(calls(verifies(statements))).toBeLessThanOrEqual(2);
    const candidateRows = chunks.reduce((sum, s) => sum + s.rows, 0);
    expect(candidateRows).toBeLessThanOrEqual(2 * SEARCH_CHUNK + 1);
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
  expect(calls(statements.filter((s) => /FROM messages_fts/.test(s.sql)))).toBe(TRIGRAM_CANDIDATE_CAP / SEARCH_CHUNK);
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
  const plan = (database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(trigramQuery("email"), JSON.stringify(["A"]), Number.MAX_SAFE_INTEGER, SEARCH_CHUNK + 1) as Array<{ detail: string }>).map((d) => d.detail);
  expect(plan.some((d) => /SCAN s\b|SCAN messages/.test(d))).toBe(false);
  expect(plan.some((d) => /SEARCH s USING INTEGER PRIMARY KEY/.test(d))).toBe(true);
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
