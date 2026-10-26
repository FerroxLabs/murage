// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// All chats and the chat pop-up (CHATS-FINDABILITY-DESIGN 3.5): a line the owner forgot is never a hit there, the owner included.
// Every other caller is answered as before: the owner's own search still finds it.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, deleteThread, searchMessagesWithMeta } from "./message-db.ts";
import { rebuildMessageSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => {
  closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

function put(thread: string, id: string, at: number, text: string, json: Record<string, unknown> = {}) {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(thread, id, at, "user", "text", text, JSON.stringify(json));
}
function tombstone(thread: string, id: string, reason: string) {
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,NULL,NULL,1,?,1)")
    .run(`tomb-${thread}-${id}-${reason}`, "source", `message:${thread}:${id}`, reason);
}
function deletedSource(thread: string, id: string) {
  database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('scope-1','conversation','owner-1','[]',0)").run();
  database().prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,NULL,1,'h','message','owner','captured',NULL,'deleted')")
    .run(`message:${thread}:${id}`, "scope-1", thread, id);
}

/** Every way a line can be forgotten, beside a line that is not. */
function seed() {
  put("A", "kept", 1000, "the austin lease, kept");
  put("A", "stamped", 2000, "the austin lease, stamped forgotten", { withheldFromBots: "forgotten" });
  put("A", "owner-forget", 3000, "the austin lease, its source forgotten");
  tombstone("A", "owner-forget", "owner-forget");
  put("B", "supporting", 4000, "the austin lease, a forgotten memory rested on it");
  tombstone("B", "supporting", "forgotten-supporting-source");
  put("B", "deleted", 5000, "the austin lease, source deleted");
  // withheld from bots for another reason (it used something changed): the owner's own line, still shown
  put("B", "withheld", 6000, "the austin lease, withheld for a change", { withheldFromBots: true });
  // a tombstone for another reason is not a forget
  put("B", "other", 7000, "the austin lease, other bookkeeping");
  tombstone("B", "other", "forgotten-original");
}

const ids = (r: ReturnType<typeof searchMessagesWithMeta>) => r.hits.map((hit) => hit.messageId).sort();

describe("excludeForgotten", () => {
  for (const indexed of [false, true]) {
    it(`leaves every forgotten line out for the owner too (${indexed ? "trigram index" : "window walk"})`, () => {
      seed();
      deletedSource("B", "deleted");
      // A fresh database trusts its (empty) index at open, and these rows are written past it: rebuild it, or reopen so the rows past
      // the index are searched by the window walk while the fill has not run.
      if (indexed) rebuildMessageSearchIndex(database());
      else closeMessageDb();
      const chats = searchMessagesWithMeta("austin lease", 40, undefined, { owner: true, excludeForgotten: true });
      expect(ids(chats)).toEqual(["kept", "other", "withheld"]);
      // scoped to a thread as well
      expect(ids(searchMessagesWithMeta("austin lease", 40, ["A"], { owner: true, excludeForgotten: true }))).toEqual(["kept"]);
      // without the option the owner's search is what it was: every row, forgotten ones included
      expect(ids(searchMessagesWithMeta("austin lease", 40, undefined, { owner: true }))).toEqual(
        ["deleted", "kept", "other", "owner-forget", "stamped", "supporting", "withheld"],
      );
    });
  }

  it("counts the page in rows this view may show, so a forgotten line never takes a hit's place", () => {
    for (let i = 0; i < 5; i++) put("A", `f${i}`, 10_000 + i, `the austin lease forgotten ${i}`, { withheldFromBots: "forgotten" });
    put("A", "kept", 1000, "the austin lease, kept");
    put("A", "kept2", 900, "the austin lease, kept too");
    closeMessageDb();
    const page = searchMessagesWithMeta("austin lease", 2, undefined, { owner: true, excludeForgotten: true });
    expect(page.hits.map((hit) => hit.messageId)).toEqual(["kept", "kept2"]);
    expect(page.partial).toBe(false);
  });

  it("changes nothing for a reader that is not the owner", () => {
    seed();
    closeMessageDb();
    const before = ids(searchMessagesWithMeta("austin lease", 40, undefined, {}));
    expect(before).not.toContain("stamped");
    const withOption = ids(searchMessagesWithMeta("austin lease", 40, undefined, { excludeForgotten: true }));
    expect(withOption.every((id) => before.includes(id))).toBe(true);
    expect(withOption).not.toContain("owner-forget");
  });

  it("does not return deleted conversations even when their text was indexed", () => {
    seed();
    rebuildMessageSearchIndex(database());
    deleteThread("A");
    expect(searchMessagesWithMeta("austin lease", 40, undefined, { owner: true, excludeForgotten: true }).hits.some(hit => hit.threadId === "A")).toBe(false);
  });
});
