// SPDX-License-Identifier: AGPL-3.0-or-later
// A short query, or any query before the trigram index is ready, is answered
// from a bounded newest window and says so; it never LIKE-scans the table.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, searchMessagesWithMeta, SHORT_QUERY_WINDOW, TRIGRAM_CANDIDATE_CAP } from "./message-db.ts";
import { rebuildMessageSearchIndex } from "./message-search-index.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const msg = (id: string, text: string, at: number): Message => ({ id, role: "user", kind: "text", text, at });

beforeEach(() => {
  closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

function fill(total: number) {
  insertMessage("t", msg("oldest", "zq marker in the oldest row", 1));
  const db = database();
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't','f-'||v,1000+v,'user','text','filler line '||v,'{}' FROM n`).run(total);
  insertMessage("t", msg("newest", "zq marker in the newest row", 10_000_000));
}

for (const total of [1_000, 200_000]) {
  it(`a 2-character search is a bounded window with ${total} filler rows`, () => {
    fill(total);
    const result = searchMessagesWithMeta("zq");
    // partial only when the window ran out before the rows did: a small install's answer is complete
    expect(result.partial).toBe(total + 2 > SHORT_QUERY_WINDOW);
    // the newest row is found; the oldest, far outside the window, is not scanned for
    expect(result.hits.map((hit) => hit.messageId)).toContain("newest");
    if (total > 4_000) expect(result.hits.map((hit) => hit.messageId)).not.toContain("oldest");
  });

  it(`a 3-character search before the index is ready never scans the table with ${total} filler rows`, () => {
    fill(total);
    database().prepare("DROP TABLE IF EXISTS messages_fts").run();
    const result = searchMessagesWithMeta("marker");
    expect(result.hits.map((hit) => hit.messageId)).toContain("newest");
  });
}

/** A word said in `total` older rows, then a thousand newer rows without it. */
function common(total: number) {
  const db = database();
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't','c-'||v,1000+v,'user','text','about the email number '||v,'{}' FROM n`).run(total);
  // newer rows that never say it, so the newest-rows shortcut cannot fill a page and the trigram index must name the candidates
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't','n-'||v,10000000+v,'user','text','unrelated line '||v,'{}' FROM n`).run(1_000);
  rebuildMessageSearchIndex(db);
}

for (const total of [TRIGRAM_CANDIDATE_CAP + 500, 40_000]) {
  it(`a common word in ${total} rows stops at the first full page of hits and is partial`, () => {
    common(total);
    const db = database();
    const original = db.prepare.bind(db);
    const seen: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { seen.push(sql); return original(sql); }) as typeof db.prepare);
    let result: ReturnType<typeof searchMessagesWithMeta>;
    try { result = searchMessagesWithMeta("email"); } finally { spy.mockRestore(); }
    // a full page of verified hits ends the search at the first chunk: over the cap the answer is the newest-inserted candidates, so it says partial
    expect(result.partial).toBe(total > TRIGRAM_CANDIDATE_CAP);
    expect(result.hits).toHaveLength(40);
    expect(result.hits[0]!.messageId).toBe(`c-${total}`);
    expect(seen.some((sql) => /FROM messages_fts/.test(sql) && sql.includes("LIMIT ?"))).toBe(true);
    expect(seen.some((sql) => /count\(\*\)/i.test(sql) && /messages_fts/.test(sql))).toBe(false);
  });
}

it("a word under the cap: partial while matches lie beyond the page, complete once the page holds them all", () => {
  common(300);
  expect(searchMessagesWithMeta("email").hits).toHaveLength(40);
  expect(searchMessagesWithMeta("email").partial).toBe(true);
  expect(searchMessagesWithMeta("email", 300).hits).toHaveLength(300);
  expect(searchMessagesWithMeta("email", 300).partial).toBe(false);
});

/** One "email" row in thread A, then 2,500 newer "email" rows in thread B, then newer filler so the newest-rows shortcut cannot answer. */
function crowded(inB: number, inA = 1) {
  const db = database();
  const ins = (thread: string, prefix: string, base: number, n: number, text: string) =>
    db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT ?,?||v,?+v,'user','text',?||v,'{}' FROM n`).run(n, thread, prefix, base, text);
  ins("A", "a-", 1000, inA, "please send the email number ");
  ins("B", "b-", 100_000, inB, "another email number ");
  ins("B", "z-", 10_000_000, 1_000, "unrelated line ");
  ins("A", "y-", 20_000_000, 1_000, "unrelated line ");
  rebuildMessageSearchIndex(db);
}

it("a scoped search finds its one hit although 2,500 newer matches sit in another thread", () => {
  crowded(2_500);
  const result = searchMessagesWithMeta("email", 40, "A");
  expect(result.hits.map((hit) => hit.messageId)).toEqual(["a-1"]);
  expect(result.partial).toBe(false);
});

it("a scoped search with more in-scope candidates than the cap returns the newest page and stops there", () => {
  crowded(10, TRIGRAM_CANDIDATE_CAP + 300);
  const result = searchMessagesWithMeta("email", 40, "A");
  expect(result.partial).toBe(true);
  expect(result.hits).toHaveLength(40);
  expect(result.hits[0]!.messageId).toBe(`a-${TRIGRAM_CANDIDATE_CAP + 300}`);
  expect(result.hits.every((hit) => hit.threadId === "A")).toBe(true);
});

it("the scoped candidate query probes by rowid, with no scan of messages", () => {
  crowded(50);
  const plan = database().prepare(`EXPLAIN QUERY PLAN SELECT f.rowid AS rowid FROM messages_fts f CROSS JOIN messages s ON s.rowid = f.rowid WHERE messages_fts MATCH ? AND s.thread_id IN (SELECT value FROM json_each(?)) ORDER BY f.rowid DESC LIMIT ${TRIGRAM_CANDIDATE_CAP}`).all('"ema" "mai" "ail"', JSON.stringify(["A"])).map((r) => String((r as { detail: string }).detail));
  expect(plan.some((d) => /SCAN s\b|SCAN messages/.test(d))).toBe(false);
  expect(plan.some((d) => /SEARCH s USING INTEGER PRIMARY KEY/.test(d))).toBe(true);
});
