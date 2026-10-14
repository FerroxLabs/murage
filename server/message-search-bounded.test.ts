// SPDX-License-Identifier: AGPL-3.0-or-later
// A short query, or any query before the trigram index is ready, is answered
// from a bounded newest window and says so; it never LIKE-scans the table.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, searchMessagesWithMeta, TRIGRAM_CANDIDATE_CAP } from "./message-db.ts";
import { rebuildMessageSearchIndex } from "./message-search-index.ts";
import type { Message } from "./store.ts";

const msg = (id: string, text: string, at: number): Message => ({ id, role: "user", kind: "text", text, at });

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
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
    expect(result.partial).toBe(true);
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
  it(`a common word in ${total} rows reads at most ${TRIGRAM_CANDIDATE_CAP} candidates, answers from the newest and says partial`, () => {
    common(total);
    const db = database();
    const original = db.prepare.bind(db);
    const seen: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { seen.push(sql); return original(sql); }) as typeof db.prepare);
    let result: ReturnType<typeof searchMessagesWithMeta>;
    try { result = searchMessagesWithMeta("email"); } finally { spy.mockRestore(); }
    expect(result.partial).toBe(true);
    expect(result.hits).toHaveLength(40);
    expect(result.hits[0]!.messageId).toBe(`c-${total}`);
    expect(seen.some((sql) => sql.includes(`ORDER BY rowid DESC LIMIT ${TRIGRAM_CANDIDATE_CAP}`))).toBe(true);
  });
}

it("a word under the cap is a complete answer, not partial", () => {
  common(300);
  expect(searchMessagesWithMeta("email").partial).toBe(false);
  expect(searchMessagesWithMeta("email").hits).toHaveLength(40);
});
