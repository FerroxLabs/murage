// SPDX-License-Identifier: AGPL-3.0-or-later
// A short query, or any query before the trigram index is ready, is answered
// from a bounded newest window and says so; it never LIKE-scans the table.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, searchMessagesWithMeta } from "./message-db.ts";
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
