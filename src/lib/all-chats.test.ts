// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { NO_CHATS, activeFilterCount, appendChatPage, chatTitle, chatsRequestPath, chatsSearchPath, foldChatHits, groupChats, type ChatRow } from "./all-chats";
import type { SearchHit } from "./search-hit";

const NOW = Date.parse("2026-10-24T12:00:00-04:00");
const clock = { timeZone: "America/New_York", locale: "en-US" };
const at = (iso: string) => Date.parse(iso);
const row = (threadId: string, when: string, extra: Partial<ChatRow> = {}): ChatRow => ({ threadId, title: threadId, createdAt: 0, lastActivityAt: at(when), botId: "ember", ...extra });

describe("the All chats request", () => {
  it("carries the filters, the cursor and the title search", () => {
    expect(chatsRequestPath({}, null)).toBe("/api/chats?limit=50");
    expect(chatsRequestPath({ botId: "ember", groupId: "direct", pinned: true, unread: true, archived: true, routines: true }, "9:t", " lease "))
      .toBe("/api/chats?limit=50&before=9%3At&bot=ember&group=direct&pinned=1&unread=1&archived=1&routines=1&q=lease");
  });

  it("asks the message search for the chats view, where a forgotten line is never a hit", () => {
    expect(chatsSearchPath(" austin lease ")).toBe("/api/search?q=austin%20lease&limit=40&view=chats");
  });

  it("sends every record filter to message search before the server applies the hit limit", () => {
    const params = new URL(chatsSearchPath("lease", { botId: "ember", groupId: "move", pinned: true, unread: true, archived: true, routines: true }), "http://fixture").searchParams;
    expect(Object.fromEntries(params)).toEqual({ q: "lease", limit: "40", view: "chats", bot: "ember", group: "move", pinned: "1", unread: "1", archived: "1", routines: "1" });
  });

  it("uses chat for the placeholder while preserving routine task titles", () => {
    expect(chatTitle("New task")).toBe("New chat");
    expect(chatTitle("New task", true)).toBe("New task");
    expect(chatTitle("Austin lease")).toBe("Austin lease");
  });
});

describe("paging", () => {
  it("joins pages each chat once, keeps pinned from the first page, and starts over on a new first page", () => {
    const first = appendChatPage(NO_CHATS, { chats: [row("a", "2026-10-24T10:00:00-04:00"), row("b", "2026-10-24T09:00:00-04:00")], pinned: [row("p", "2026-10-01T09:00:00-04:00", { pinned: true })], next: "c1", total: 5 }, true);
    expect(first.chats.map((r) => r.threadId)).toEqual(["a", "b"]);
    expect(first.pinned.map((r) => r.threadId)).toEqual(["p"]);
    // "b" had new activity between the requests and comes back on page two: it stays where it was shown
    const second = appendChatPage(first, { chats: [row("b", "2026-10-24T11:00:00-04:00"), row("c", "2026-10-20T09:00:00-04:00")], next: null, total: 5 }, false);
    expect(second.chats.map((r) => r.threadId)).toEqual(["a", "b", "c"]);
    expect(second.pinned.map((r) => r.threadId)).toEqual(["p"]);
    expect(second.next).toBeNull();
    const restart = appendChatPage(second, { chats: [row("z", "2026-10-24T10:00:00-04:00")], next: null, total: 1 }, true);
    expect(restart.chats.map((r) => r.threadId)).toEqual(["z"]);
    expect(restart.pinned).toEqual([]);
  });
});

describe("grouping", () => {
  it("puts Pinned first, then Today, Yesterday, Previous 7 days, Earlier this month, then months", () => {
    const sections = groupChats({
      pinned: [row("p", "2026-08-01T09:00:00-04:00", { pinned: true })],
      chats: [
        row("today", "2026-10-24T08:00:00-04:00"),
        row("yesterday", "2026-10-23T20:00:00-04:00"),
        row("week", "2026-10-19T20:00:00-04:00"),
        row("month", "2026-10-03T20:00:00-04:00"),
        row("sept", "2026-09-12T20:00:00-04:00"),
        row("aug", "2026-08-02T20:00:00-04:00"),
      ],
    }, NOW, clock);
    expect(sections.map((s) => s.label)).toEqual(["Pinned", "Today", "Yesterday", "Previous 7 days", "Earlier this month", "September 2026", "August 2026"]);
  });

  it("folds runs across intervening chats within a date group", () => {
    const run = (id: string, when: string) => row(id, when, { routine: { routineId: "brief", routineName: "Morning brief" } });
    const [today] = groupChats({ pinned: [], chats: [run("r1", "2026-10-24T09:00:00-04:00"), run("r2", "2026-10-24T08:00:00-04:00"), row("chat", "2026-10-24T07:00:00-04:00"), run("r3", "2026-10-24T06:00:00-04:00")] }, NOW, clock);
    expect(today!.entries.map((e) => (e.type === "runs" ? `runs:${e.runs.length}` : e.row.threadId))).toEqual(["runs:3", "chat"]);
  });
});

describe("message matches", () => {
  const hit = (threadId: string, messageId: string, extra: Partial<SearchHit> = {}): SearchHit => ({
    threadId, messageId, name: "Ember", botId: "ember", role: "user", kind: "text", at: 1, snippet: "the austin lease", matchStart: 4, matchLength: 6, ...extra,
  });

  it("folds hits to one row per chat with the count, newest hit standing for the chat", () => {
    const rows = foldChatHits([hit("t1", "m3"), hit("t2", "m9"), hit("t1", "m1")], {}, () => ({}));
    expect(rows.map((r) => [r.threadId, r.hit.messageId, r.count])).toEqual([["t1", "m3", 2], ["t2", "m9", 1]]);
  });

  it("applies the Bot, Project or channel, Pinned, Unread, Archived and routine filters", () => {
    const hits = [hit("t1", "a"), hit("t2", "b", { botId: undefined, groupId: "move" }), hit("t3", "c"), hit("t4", "d", { botId: "sage" })];
    const facts = (h: SearchHit) => ({ t1: { pinned: true }, t2: {}, t3: { archived: true }, t4: { routine: true, unread: true } } as Record<string, object>)[h.threadId]!;
    expect(foldChatHits(hits, {}, facts).map((r) => r.threadId)).toEqual(["t1", "t2"]);
    expect(foldChatHits(hits, { archived: true }, facts).map((r) => r.threadId)).toEqual(["t3"]);
    expect(foldChatHits(hits, { routines: true }, facts).map((r) => r.threadId)).toEqual(["t1", "t2", "t4"]);
    expect(foldChatHits(hits, { pinned: true }, facts).map((r) => r.threadId)).toEqual(["t1"]);
    expect(foldChatHits(hits, { unread: true, routines: true }, facts).map((r) => r.threadId)).toEqual(["t4"]);
    expect(foldChatHits(hits, { botId: "ember" }, facts).map((r) => r.threadId)).toEqual(["t1"]);
    expect(foldChatHits(hits, { groupId: "move" }, facts).map((r) => r.threadId)).toEqual(["t2"]);
    expect(foldChatHits(hits, { groupId: "direct" }, facts).map((r) => r.threadId)).toEqual(["t1"]);
    expect(activeFilterCount({ botId: "x", pinned: true, unread: false })).toBe(2);
  });
});

describe("at extreme scale", () => {
  it("groups what is held (pages of 50), whatever the owner's history: 30,000 chats cost one page of work", () => {
    // the server pages 30,000 chats; the view holds the pages asked for, so grouping touches only those rows
    const page = Array.from({ length: 50 }, (_, i) => row(`t${i}`, new Date(NOW - i * 3_600_000).toISOString()));
    const held = appendChatPage(NO_CHATS, { chats: page, next: "more", total: 30_000 }, true);
    const sections = groupChats(held, NOW, clock);
    expect(sections.reduce((n, s) => n + s.entries.length, 0)).toBe(50);
    expect(held.total).toBe(30_000);
  });
});
