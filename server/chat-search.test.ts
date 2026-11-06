// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, searchMessagesWithMeta } from "./message-db.ts";
import { parseSearchBefore, searchChatThreads } from "./chat-search.ts";
import { rebuildMessageSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
beforeEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMessageDb(); });
function put(thread: string, id: string, at: number, forgotten = false) {
  insertMessage(thread, { id, at, role: "user", kind: "text", text: `austin lease ${id}`, ...(forgotten ? { withheldFromBots: "forgotten" as const } : {}) });
}
it("groups before limiting, counts hits, excludes forgotten text and pages tied threads once", () => {
  for (let i = 0; i < 60; i++) put("a", `a${i}`, i);
  put("b", "b1", 59); put("c", "c1", 58); put("outside", "out", 100);
  put("a", "forgotten", 200, true);
  const first = searchChatThreads("austin", 1, ["a", "b", "c"]);
  expect(first.hits).toMatchObject([{ threadId: "a", messageId: "a59", hits: 60 }]);
  expect(first.next).toBe("59:a");
  const second = searchChatThreads("austin", 1, ["a", "b", "c"], parseSearchBefore(first.next)!);
  expect(second.hits).toMatchObject([{ threadId: "b", hits: 1 }]);
  const third = searchChatThreads("austin", 1, ["a", "b", "c"], parseSearchBefore(second.next)!);
  expect(third.hits.map(hit => hit.threadId)).toEqual(["c"]);
  expect(third.next).toBeNull();
  expect(third.partial).toBe(false);
  expect(searchChatThreads("austin", 40, []).hits).toEqual([]);
});
it("honours numeric before and accepts only finite cursor positions", () => {
  put("a", "old", 10); put("a", "equal", 20); put("b", "new", 30);
  expect(searchChatThreads("austin", 40, ["a", "b"], { at: 20 }).hits).toMatchObject([{ messageId: "old", hits: 1 }]);
  for (const bad of ["", "NaN", "Infinity", "-1", "2:", "2:a:more"]) expect(parseSearchBefore(bad)).toBeNull();
  expect(parseSearchBefore(null)).toBeUndefined();
});

it("keeps the partial flag when counts come from a bounded candidate window", () => {
  const db = database();
  db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<2100)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'a','m'||v,v,'user','text','austin lease','{}' FROM n`).run();
  rebuildMessageSearchIndex(db);
  const page = searchChatThreads("austin", 40, ["a"]);
  expect(page.hits).toHaveLength(1);
  expect(page.hits[0]!.hits).toBeLessThan(2100);
  expect(page.partial).toBe(true);
});
it("message paging keeps equal-time lines on both indexed and fallback paths", () => {
  for (let i = 0; i < 9; i++) put("a", `m${i}`, 10);
  for (const indexed of [true, false]) {
    if (indexed) rebuildMessageSearchIndex(database());
    else database().exec("DROP TABLE messages_fts");
    const seen: string[] = [];
    let cursor: { at: number; threadId?: string } | undefined;
    for (let page = 0; page < 4; page++) {
      const result = searchMessagesWithMeta("austin", 3, ["a"], { owner: true, excludeForgotten: true }, cursor?.at, cursor?.threadId ? Number(cursor.threadId) : undefined);
      seen.push(...result.hits.map(hit => hit.messageId));
      if (!result.partial) break;
      cursor = parseSearchBefore(result.hits.at(-1)!.cursor!)!;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  }
});
