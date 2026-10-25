// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AllChatsView, type AllChatsViewProps } from "./AllChatsPage";
import { NO_CHATS, appendChatPage, type ChatRow } from "@/lib/all-chats";
import type { Bot, Group } from "@/state/store";
import type { SearchHit } from "@/lib/search-hit";
import { pageChats, type ChatSourceBot } from "../../server/chat-list";

const NOW = Date.parse("2026-10-24T12:00:00-04:00");
// SAFETY: the view reads only id, name, hidden, threadId and the task window of a bot; the avatar falls back to its initials
const bot = (id: string, name: string, extra: Partial<Bot> = {}) => ({ id, name, threadId: `${id}-main`, color: "ember", tasks: [], ...extra }) as unknown as Bot;
// SAFETY: as above, for a channel
const group = (id: string, name: string, extra: Partial<Group> = {}) => ({ id, name, threadId: `${id}-main`, memberIds: [], tasks: [], ...extra }) as unknown as Group;
const row = (threadId: string, hoursAgo: number, extra: Partial<ChatRow> = {}): ChatRow => ({ threadId, title: `Chat ${threadId}`, createdAt: 0, lastActivityAt: NOW - hoursAgo * 3_600_000, botId: "ember", ...extra });

const render = (over: Partial<AllChatsViewProps> = {}) => renderToStaticMarkup(createElement(AllChatsView, {
  bots: [bot("ember", "Ember"), bot("sage", "Sage"), bot("old", "Old", { hidden: true })],
  groups: [group("move", "Office move", { channelProject: { purpose: "Move" } as never }), group("launch", "Launch room"), group("dm", "Ember and Sage", { dm: true })],
  filters: {},
  onFilters: vi.fn(),
  query: "",
  onQuery: vi.fn(),
  held: NO_CHATS,
  loading: null,
  failed: null,
  hitRows: null,
  searchingMessages: false,
  hitsPartial: false,
  hitsFailed: null,
  onOpenRow: vi.fn(),
  onOpenHit: vi.fn(),
  onLoadMore: vi.fn(),
  onClose: vi.fn(),
  now: NOW,
  timeZone: "America/New_York",
  locale: "en-US",
  ...over,
}));

const BANNED = [/—/, /\bsafe\b/i, /\bunsafe\b/i, /\bsafety\b/i, /composio/i, /\$\d/, /\bprice\b/i];

describe("All chats view", () => {
  it("says what it is doing while the first page loads", () => {
    const html = render({ loading: "first" });
    expect(html).toContain("Loading your chats…");
    expect(html).toContain('role="status"');
  });

  it("shows one page grouped by day with pinned first, the bot, the title, the place and the time", () => {
    const held = appendChatPage(NO_CHATS, {
      chats: [row("a", 1), row("b", 30, { botId: "sage", place: { kind: "project", groupId: "move", name: "Office move" } }), row("c", 24 * 40, { groupId: "launch", botId: undefined, place: { kind: "channel", groupId: "launch", name: "Launch room" }, unread: true })],
      pinned: [row("p", 24 * 90, { pinned: true })],
      next: "cursor",
      total: 30_000,
    }, true);
    const html = render({ held });
    expect(html.indexOf(">Pinned<")).toBeLessThan(html.indexOf(">Today<"));
    expect(html.indexOf(">Today<")).toBeLessThan(html.indexOf(">Yesterday<"));
    expect(html).toContain("Project: Office move");
    expect(html).toContain("Channel: Launch room");
    expect(html).toContain("#Launch room");
    expect(html).toContain("Chat b");
    expect(html).toContain('aria-label="Pinned"');
    expect(html).toContain("Show older chats (4 of 30000 shown)");
    expect(html).toContain("· 30000");
    expect(html.match(/data-chat-row=/g)).toHaveLength(4);
    // a bot-to-bot room is not a place to filter by; an archived bot is offered only under Archived
    expect(html).not.toContain(">Ember and Sage<");
    expect(html).not.toContain(">Old<");
    expect(html).toContain('<optgroup label="Projects"><option value="move">Office move</option></optgroup>');
    for (const pattern of BANNED) expect(html).not.toMatch(pattern);
  });

  it("renders a page of 50 rows from a 30,000-chat history: the markup follows what is held, not the history", () => {
    const held = appendChatPage(NO_CHATS, { chats: Array.from({ length: 50 }, (_, i) => row(`t${i}`, i)), next: "more", total: 30_000 }, true);
    const html = render({ held });
    expect(html.match(/data-chat-row=/g)).toHaveLength(50);
  });

  it("does the same row work on repeated renders with 100 or 30,000 records, including later pages", () => {
    const costs: number[] = [];
    for (const count of [100, 30_000]) {
      const tasks = Array.from({ length: count }, (_, i) => ({ threadId: `t-${i}`, title: `Chat ${i}`, createdAt: NOW - i * 1000 }));
      const record: ChatSourceBot = { id: "ember", name: "Ember", threadId: "t-0", tasks };
      const source = { bots: [record], groups: [], desktop: true, lastActivityAt: () => undefined, routineOf: () => undefined };
      const first = pageChats(source, {}, null, 50)!;
      const second = pageChats(source, {}, first.next, 50)!;
      // The renderer may use owner identity, never the history behind it.
      const owner = bot("ember", "Ember");
      Object.defineProperty(owner, "tasks", { get() { throw new Error("render read the task history"); } });
      Object.defineProperty(owner, "extraTasks", { get() { throw new Error("render read older task history"); } });
      for (const page of [first, second]) {
        let reads = 0;
        const chats = page.chats.map(row => new Proxy(row, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } }));
        const held = appendChatPage(NO_CHATS, { ...page, chats }, true);
        reads = 0;
        for (let paint = 0; paint < 3; paint++) {
          const html = render({ bots: [owner], held });
          expect(html.match(/data-chat-row=/g)).toHaveLength(50);
        }
        costs.push(reads);
      }
    }
    expect(costs[0]).toBeGreaterThan(0);
    expect(costs[2]).toBe(costs[0]);
    expect(costs[3]).toBe(costs[1]);
  });

  it("offers newer page navigation without rendering previous pages", () => {
    const held = appendChatPage(NO_CHATS, { chats: [row("older", 100)], next: "next", total: 150 }, true);
    const html = render({ held, pageIndex: 1, onPrevious: vi.fn() });
    expect(html).toContain("Show newer chats");
    expect(html).toContain("Show older chats (51 of 150 shown)");
    expect(html.match(/data-chat-row=/g)).toHaveLength(1);
  });

  it("shows the archived filter's rows labelled, and every filter as a control", () => {
    const held = appendChatPage(NO_CHATS, { chats: [row("o", 2, { botId: "old", archived: true })], next: null, total: 1 }, true);
    const html = render({ held, filters: { archived: true } });
    expect(html).toContain(">Archived<");
    expect(html).toContain("Old (archived)");
    for (const label of ["Pinned", "Unread", "Archived", "Include routine runs"]) expect(html).toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${label}<`));
    expect(html).toContain("Clear filters");
    expect(html).toContain('aria-label="Bot"');
    expect(html).toContain('aria-label="Project or channel"');
    expect(html).toContain("Direct chats only");
  });

  it("titles the view after the bot it was opened from", () => {
    expect(render({ filters: { botId: "ember" } })).toContain("Chats with Ember");
  });

  it("shows message matches one row per chat with the match marked, and says what it is doing while it searches", () => {
    const searching = render({ query: "lease", searchingMessages: true });
    expect(searching).toContain("Searching your messages for “lease”…");
    const hit: SearchHit = { threadId: "a", messageId: "m1", botId: "ember", name: "Ember", task: "Austin lease", role: "user", kind: "text", at: NOW - 1000, snippet: "the lease runs to March", matchStart: 4, matchLength: 5 };
    const html = render({ query: "lease", hitRows: [{ threadId: "a", hit, count: 3 }] });
    expect(html).toContain("Matches in messages · 1 chat");
    expect(html).toContain('<mark class="rounded-sm bg-accent/25 px-0.5 text-ink">lease</mark>');
    expect(html).toContain(" · 3 matches");
    expect(html).toContain('data-chat-hit="a"');
    expect(html).toContain("Chat titles");
  });

  it("explains an empty list in plain words", () => {
    expect(render()).toContain("No chats yet. Start one with any bot.");
    expect(render({ filters: { pinned: true } })).toContain("No chats match these filters.");
    expect(render({ query: "zz" })).toContain("No chat titles match “zz”. Try a shorter word, or clear the filters.");
  });

  it("stacks on a phone: the time moves under the title below the small breakpoint", () => {
    const held = appendChatPage(NO_CHATS, { chats: [row("a", 1)], next: null, total: 1 }, true);
    const html = render({ held });
    expect(html).toContain("grid-cols-[28px_1fr]");
    expect(html).toContain("sm:grid-cols-[28px_1fr_auto]");
    expect(html).toContain("col-start-2");
  });
});
