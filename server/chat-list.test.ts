// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// All chats, slice 1 (server/chat-list.ts): paging, the filters, and a page whose cost follows the number of chats, never the history.
import { describe, expect, it } from "vitest";

import { CHAT_PAGE_MAX, chatFiltersFromQuery, chatSearchThreads, chatListWork, decodeChatCursor, pageChats, type ChatPage, type ChatSource, type ChatSourceBot, type ChatSourceGroup } from "./chat-list.ts";

function source(bots: ChatSourceBot[], groups: ChatSourceGroup[] = [], activity: Record<string, number> = {}, extra: Partial<ChatSource> = {}): ChatSource {
  return {
    bots,
    groups,
    lastActivityAt: (threadId) => activity[threadId],
    routineOf: () => undefined,
    desktop: true,
    ...extra,
  };
}

const ids = (rows: Array<{ threadId: string }> | undefined) => (rows ?? []).map((row) => row.threadId);

describe("pageChats", () => {
  const bots: ChatSourceBot[] = [
    { id: "ember", name: "Ember", threadId: "e1", tasks: [
      { threadId: "e1", title: "Austin lease", createdAt: 100 },
      { threadId: "e2", title: "Dinner ideas", createdAt: 200, pinned: true },
      { threadId: "e3", title: "Office desk", createdAt: 300, channelProjectDesk: { groupId: "move" } },
    ] },
    { id: "sage", name: "Sage", threadId: "s1", tasks: [
      { threadId: "s1", title: "Q4 numbers", createdAt: 150, unread: true },
    ] },
    { id: "old", name: "Old", threadId: "o1", hidden: true, tasks: [{ threadId: "o1", title: "Archived bot chat", createdAt: 50 }] },
  ];
  const groups: ChatSourceGroup[] = [
    { id: "move", name: "Office move", threadId: "m1", createdAt: 10, channelProject: { purpose: "move" }, tasks: [{ threadId: "m1", title: "Landlord call", createdAt: 120 }] },
    { id: "launch", name: "Launch room", threadId: "l1", createdAt: 10, hidden: true, tasks: [{ threadId: "l1", title: "Launch plan", createdAt: 130 }] },
    { id: "dm", name: "Ember and Sage", threadId: "d1", createdAt: 10, dm: true },
  ];
  // the last message decides the order, not when the chat was made
  const activity = { e1: 9_000, s1: 8_000, m1: 7_000, e3: 6_000 };

  it("lists newest activity first, pinned apart on the first page, archived and bot-to-bot rooms left out", () => {
    const page = pageChats(source(bots, groups, activity), {}, null, 50)!;
    expect(ids(page.chats)).toEqual(["e1", "s1", "m1", "e3"]);
    expect(ids(page.pinned)).toEqual(["e2"]);
    expect(page.total).toBe(5);
    expect(page.next).toBeNull();
    expect(page.chats.find((row) => row.threadId === "e3")?.place).toEqual({ kind: "project", groupId: "move", name: "Office move" });
    expect(page.chats.find((row) => row.threadId === "m1")).toMatchObject({ groupId: "move", place: { kind: "project" } });
    expect(page.chats.find((row) => row.threadId === "s1")?.unread).toBe(true);
    expect(page.chats.find((row) => row.threadId === "e1")?.lastActivityAt).toBe(9_000);
  });

  it("pages with a cursor it gave, each chat once, and refuses one it did not", () => {
    const first = pageChats(source(bots, groups, activity), {}, null, 2)!;
    expect(ids(first.pinned)).toEqual(["e2"]);
    expect(ids(first.chats)).toEqual(["e1"]);
    expect(first.next).not.toBeNull();
    const second = pageChats(source(bots, groups, activity), {}, first.next, 2)!;
    expect(ids(second.chats)).toEqual(["s1", "m1"]);
    expect(second.pinned).toEqual([]);
    const third = pageChats(source(bots, groups, activity), {}, second.next, 2)!;
    expect(ids(third.chats)).toEqual(["e3"]);
    expect(third.next).toBeNull();
    expect(pageChats(source(bots, groups, activity), {}, "nonsense", 2)).toBeNull();
    expect(decodeChatCursor(first.next!)).toEqual({ at: 9_000, threadId: "e1" });
  });

  it("pages more than 50 pinned chats without dropping or repeating one, even when times tie", () => {
    const tasks = Array.from({ length: 123 }, (_, i) => ({ threadId: `t-${String(i).padStart(3, "0")}`, title: "Chat", createdAt: 1, pinned: i < 75 }));
    const s = source([{ id: "b", name: "Bot", threadId: "t-000", tasks }]);
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const page: ChatPage = pageChats(s, {}, before, 50)!;
      const rows = [...page.pinned ?? [], ...page.chats];
      expect(rows.length).toBeLessThanOrEqual(50);
      seen.push(...ids(rows));
      before = page.next;
    } while (before);
    expect(seen).toEqual(tasks.map(task => task.threadId));
    for (const cursor of ["", "0:NaN:t", "0:Infinity:t", "2:1:t", "0::t"]) expect(decodeChatCursor(cursor)).toBeNull();
  });

  it("filters by bot, by project or channel, direct only, pinned, unread and title", () => {
    const s = source(bots, groups, activity);
    expect(ids(pageChats(s, { botId: "ember" }, null, 50)!.chats)).toEqual(["e1", "e3"]);
    expect(ids(pageChats(s, { groupId: "move" }, null, 50)!.chats)).toEqual(["m1", "e3"]);
    expect(ids(pageChats(s, { groupId: "direct" }, null, 50)!.chats)).toEqual(["e1", "s1"]);
    const pinned = pageChats(s, { pinned: true }, null, 50)!;
    expect(ids(pinned.chats)).toEqual(["e2"]);
    expect(pinned.pinned).toBeUndefined();
    expect(ids(pageChats(s, { unread: true }, null, 50)!.chats)).toEqual(["s1"]);
    expect(ids(pageChats(s, { q: "lease" }, null, 50)!.chats)).toEqual(["e1"]);
  });

  it("shows archived chats only under the Archived filter, and never off the desktop", () => {
    const desk = pageChats(source(bots, groups, activity), { archived: true }, null, 50)!;
    expect(ids(desk.chats).sort()).toEqual(["l1", "o1"]);
    expect(desk.chats.every((row) => row.archived)).toBe(true);
    const phone = pageChats(source(bots, groups, activity, { desktop: false }), { archived: true }, null, 50)!;
    expect(phone.chats).toEqual([]);
    const phoneAll = pageChats(source(bots, groups, activity, { desktop: false }), {}, null, 50)!;
    expect([...ids(phoneAll.chats), ...ids(phoneAll.pinned)]).not.toContain("o1");
    expect([...ids(phoneAll.chats), ...ids(phoneAll.pinned)]).not.toContain("l1");
  });

  it("leaves routine runs out unless they are included", () => {
    const s = source(bots, groups, activity, { routineOf: (threadId) => (threadId === "s1" ? { routineId: "r", routineName: "Morning brief" } : undefined) });
    expect(ids(pageChats(s, {}, null, 50)!.chats)).not.toContain("s1");
    const included = pageChats(s, { routines: true }, null, 50)!;
    expect(included.chats.find((row) => row.threadId === "s1")?.routine).toEqual({ routineId: "r", routineName: "Morning brief" });
  });

  it("reads the route's query, empty values meaning any", () => {
    expect(chatFiltersFromQuery(new URLSearchParams("bot=ember&group=&pinned=1&unread=0&q=%20Lease%20"))).toEqual({
      botId: "ember", groupId: undefined, pinned: true, unread: false, archived: false, routines: false, q: "lease",
    });
  });

  it("uses all task records to scope message search before its limit, independently of a title match", () => {
    const s = source(bots, groups, activity);
    expect(chatSearchThreads(s, { botId: "ember", groupId: "move", q: "words in a message" })).toEqual(["e3"]);
    expect(chatSearchThreads(s, { pinned: true })).toEqual(["e2"]);
    expect(chatSearchThreads(s, { unread: true })).toEqual(["s1"]);
    expect(chatSearchThreads(s, { archived: true }).sort()).toEqual(["l1", "o1"]);
    expect(chatSearchThreads(s, { botId: "old" })).toEqual([]);
    expect(chatSearchThreads(s, { botId: "ember", pinned: true, unread: true })).toEqual([]);
  });
});

describe("All chats at extreme scale", () => {
  // 30,000 chats over 300 bots: every request returns one page and touches the records once; nothing reads a transcript (the source
  // offers none) and the time is asked only for chats that pass the filters.
  const BOTS = 300, PER_BOT = 100;
  const bots: ChatSourceBot[] = Array.from({ length: BOTS }, (_, b) => ({
    id: `bot-${b}`,
    name: `Bot ${b}`,
    threadId: `t-${b}-0`,
    tasks: Array.from({ length: PER_BOT }, (_, i) => ({ threadId: `t-${b}-${i}`, title: `Chat ${b}.${i}`, createdAt: b * PER_BOT + i })),
  }));
  let timeLookups = 0;
  const big = source(bots, [], {}, { lastActivityAt: (threadId) => { timeLookups++; return Number(threadId.split("-")[2]) * 1_000 + Number(threadId.split("-")[1]); } });

  it("answers three pages from 30,000 chats with no duplicates and no transcript access", () => {
    const seen = new Set<string>();
    let before: string | null = null;
    let pages = 0;
    const start = { ...chatListWork };
    for (;;) {
      timeLookups = 0;
      const page: ChatPage = pageChats(big, {}, before, 50)!;
      expect(page.total).toBe(BOTS * PER_BOT);
      expect(page.chats.length).toBeLessThanOrEqual(50);
      // one visit and at most one time lookup per chat per request: linear in chats, flat in history
      expect(timeLookups).toBeLessThanOrEqual(BOTS * PER_BOT);
      for (const row of page.chats) {
        expect(seen.has(row.threadId)).toBe(false);
        seen.add(row.threadId);
      }
      pages++;
      if (!page.next || pages >= 3) break;
      before = page.next;
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(150);
    expect(chatListWork.requests - start.requests).toBe(3);
    expect(chatListWork.rowsVisited - start.rowsVisited).toBe(3 * BOTS * PER_BOT);
  });

  it("asks the time only of chats that pass the filters", () => {
    timeLookups = 0;
    const page = pageChats(big, { botId: "bot-7" }, null, 50)!;
    expect(page.chats).toHaveLength(50);
    expect(page.total).toBe(PER_BOT);
    expect(timeLookups).toBe(PER_BOT);
  });

  it("caps a page at the maximum however much is asked", () => {
    expect(pageChats(big, {}, null, 10_000)!.chats).toHaveLength(CHAT_PAGE_MAX);
  });
});
