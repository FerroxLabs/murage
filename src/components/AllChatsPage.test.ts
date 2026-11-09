import { chatsGenHello } from "@/lib/chats-gen";
const previewGen = { epoch: "view-fixture", rev: 0 };
beforeEach(() => chatsGenHello(previewGen));
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { AllChatsBack, AllChatsClose, AllChatsView, type AllChatsViewProps } from "./AllChatsPage";
import { en, loadLocalePack, localeChoices } from "@/locales";
import { NO_CHATS, appendChatPage, type ChatRow } from "@/lib/all-chats";
import type { Bot, Group } from "@/state/store";
import type { SearchHit } from "@/lib/search-hit";
import { CHATS_SECTIONS_MIN, chatHome, chatsSections, chatsSectionTitle, chatsSectionsShown, chatsWaitingThreads } from "@/lib/chats-sections";
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
  listGen: previewGen,
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
  it("shows owner snippets, date ranges, active filters, readiness and more message results", () => {
    const held = appendChatPage(NO_CHATS, { chats: [row("a", 1, { snippet: "Lease renewal", lastRole: "user" })], total: 1, next: null, partial: true }, true);
    const html = render({ held, filters: { date: "custom", pinned: true, unread: true, archived: true }, hitRows: [], onMoreHits: vi.fn() });
    expect(html).toContain("You: Lease renewal");
    expect(html).toContain('aria-label="From date"');
    expect(html).toContain('aria-label="Through date"');
    expect(html).toContain("Past week");
    expect(html).toContain("Past month");
    expect(html).toContain("More results");
    expect(html).toContain("Chat previews are still getting ready.");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
  });
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
    // 30,000 chats: the sections replace the day list, and each chat's own row
    // (pin, place, time) still draws inside the section it belongs to.
    const html = render({ held, sectionsOpen: ["bots:ember", "older:channels"] });
    expect(html).toContain("data-chats-sections");
    // the date filter also offers "Today" (CHATS-S2 C1): only a day heading counts
    expect(html).not.toMatch(/<h3[^>]*>Today</);
    const at = (key: string) => html.indexOf(`data-chats-section="${key}"`);
    expect(at("bots")).toBeGreaterThan(-1);
    expect(at("bots")).toBeLessThan(at("projects"));
    expect(at("projects")).toBeLessThan(at("channels"));
    const botsPart = html.slice(at("bots"), at("projects"));
    expect(botsPart).toContain('aria-label="Chats with Ember"');
    expect(botsPart).toContain("2 chats");
    expect(botsPart).toContain('data-chat-row="p"');
    expect(botsPart).toContain('aria-label="Pinned"');
    expect(botsPart.lastIndexOf('data-chat-row="a"')).toBeLessThan(botsPart.indexOf('data-chat-row="p"'));
    const projectsPart = html.slice(at("projects"), at("channels"));
    expect(projectsPart).toContain("Office move");
    expect(projectsPart).toContain("Chat b");
    // the 40-day-old channel chat sits in its section's older fold, opened here
    expect(html.slice(at("channels"))).toContain("Launch room");
    expect(html.slice(at("channels"))).toContain("Show less");
    expect(html).toContain("Show older chats (4 of 30000 shown)");
    expect(html).toContain("· 30000");
    // one row each for Ember, the project and the channel, plus Ember's two chats opened: never the list flat
    expect(html.match(/data-chat-row=/g)).toHaveLength(5);
    // a bot-to-bot room is not a place to filter by; an archived bot is offered only under Archived
    expect(html).not.toContain(">Ember and Sage<");
    expect(html).not.toContain(">Old<");
    expect(html).toContain('<optgroup label="Projects"><option value="move">Office move</option></optgroup>');
    for (const pattern of BANNED) expect(html).not.toMatch(pattern);
  });

  it("renders a page of 50 rows from a 30,000-chat history: the markup follows what is held, not the history", () => {
    const held = appendChatPage(NO_CHATS, { chats: Array.from({ length: 50 }, (_, i) => row(`t${i}`, i)), next: "more", total: 30_000 }, true);
    // folded: one row for the bot that holds all 50, never the page flat
    const folded = render({ held });
    expect(folded).toContain("data-chats-sections");
    expect(folded.match(/data-chats-owner=/g)).toHaveLength(1);
    expect(folded).toContain("50 chats");
    expect(folded.match(/data-chat-row=/g)).toHaveLength(1);
    // opened under its bot: the 50 held rows inside the Bots section, still not the 30,000
    const open = render({ held, sectionsOpen: ["bots:ember"] });
    expect(open.match(/data-chat-row=/g)).toHaveLength(51);
    expect(open.slice(open.indexOf('data-chats-section="bots"')).match(/data-chat-row=/g)).toHaveLength(51);
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
          // the sections at this scale: one Ember row, opened to the 50 held chats
          const html = render({ bots: [owner], held, sectionsOpen: ["bots:ember"] });
          expect(html).toContain("data-chats-sections");
          expect(html.match(/data-chats-owner=/g)).toHaveLength(1);
          expect(html.match(/data-chat-row=/g)).toHaveLength(51);
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
    const html = render({ query: "lease", hitRows: [{ threadId: "a", hit, count: 3, countComplete: true }] });
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

  it("has a way out on screen: Back with its word on the left, a close X at the far right of the header", () => {
    const html = render();
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const back = header.match(/<button[^>]*data-all-chats-back[^>]*>.*?<\/button>/)?.[0] ?? "";
    const close = header.match(/<button[^>]*data-all-chats-close[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(back).toContain(">Back</button>");
    expect(back).toContain('title="Back (Esc)"');
    expect(close).toContain('aria-label="Close"');
    // a 40 px hit area that never shrinks, the app's hover and focus ring
    for (const button of [back, close]) for (const cls of ["shrink-0", "hover:bg-raised", "focus-visible:outline-focus"]) expect(button).toContain(cls);
    expect(close).toContain("size-10");
    expect(back).toContain("min-h-10");
    // Back comes before the title; close is the header's last control, after the search box
    expect(header.indexOf("data-all-chats-back")).toBeLessThan(header.indexOf('id="all-chats-title"'));
    expect(header.indexOf("data-all-chats-close")).toBeGreaterThan(header.indexOf('role="search"'));
    expect(header.slice(header.indexOf("data-all-chats-close")).match(/<button/g)).toBeNull();
    for (const pattern of BANNED) expect(header).not.toMatch(pattern);
  });

  it("closes the page from either button, and the view wires both to its onClose", () => {
    const onClose = vi.fn();
    (AllChatsBack({ onClose }) as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
    (AllChatsClose({ onClose }) as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(onClose).toHaveBeenCalledTimes(2);
    const source = readFileSync(new URL("./AllChatsPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("<AllChatsBack onClose={onClose} />");
    expect(source).toContain("<AllChatsClose onClose={onClose} />");
  });

  it("says Back and Close in every shipped language", async () => {
    expect(en["allChats.back"]).toBe("Back");
    expect(en["allChats.close"]).toBe("Close");
    for (const { code } of localeChoices) {
      if (code === "en") continue;
      const pack = await loadLocalePack(code);
      for (const key of ["allChats.back", "allChats.backHint", "allChats.close"] as const) {
        expect(pack[key], `${code} ${key}`).toBeTruthy();
        expect(pack[key], `${code} ${key}`).not.toBe(en[key]);
      }
    }
  });

  it("stacks on a phone: the time moves under the title below the small breakpoint", () => {
    const held = appendChatPage(NO_CHATS, { chats: [row("a", 1)], next: null, total: 1 }, true);
    const html = render({ held });
    expect(html).toContain("grid-cols-[28px_1fr]");
    expect(html).toContain("sm:grid-cols-[28px_1fr_auto]");
    expect(html).toContain("col-start-2");
  });
});

// UX L6B (scale, UX-FIRSTRUN-SCALE-1012.md 2.2): at 50+ chats the door shows
// Bots, Projects, Channels and Archived, one row per bot or place, never 54
// flat rows; past 30 days folds; waiting rolls up into the header.
describe("Chats sections at 50+ chats", () => {
  const many = (): ChatRow[] => [
    ...Array.from({ length: 30 }, (_, i) => row(`e${i}`, i + 1, { title: i === 0 ? "Morning brief" : `Ember ${i}` })),
    ...Array.from({ length: 20 }, (_, i) => row(`s${i}`, i + 2, { botId: "sage" })),
    row("m1", 3, { botId: "sage", place: { kind: "project", groupId: "move", name: "Office move" } }),
    row("l1", 5, { groupId: "launch", botId: undefined, place: { kind: "channel", groupId: "launch", name: "Launch room" } }),
    row("o1", 24 * 45, { botId: "old2" }),
    row("o2", 24 * 60, { botId: "old3" }),
  ];
  const held = () => appendChatPage(NO_CHATS, { chats: many(), next: "cursor", total: 54 }, true);
  const waitingBots = [bot("ember", "Ember", { tasks: [{ threadId: "e3", title: "x", createdAt: 0, activity: "waiting-on-you" }] as never }), bot("sage", "Sage", { activity: "waiting-on-you", threadId: "s0" }), bot("old2", "Olga"), bot("old3", "Otto")];

  it("groups by owner and never lists the page flat", () => {
    const html = render({ held: held(), bots: waitingBots, waitingThreads: chatsWaitingThreads(waitingBots), archived: { total: 9, rows: [] } });
    expect(html).toContain("data-chats-sections");
    // the date filter also offers "Today" (CHATS-S2 C1): only a day heading counts
    expect(html).not.toMatch(/<h3[^>]*>Today</);
    // one row per bot or place: Ember, Sage, the project, the channel (the old two are folded)
    expect(html.match(/data-chats-owner=/g)).toHaveLength(4);
    expect(html).toContain("Morning brief");
    expect(html).toContain("30 chats");
    expect(html).toContain("20 chats");
    expect(html).toContain("Bots · 2 waiting");
    expect(html.indexOf(">Bots · 2 waiting")).toBeLessThan(html.indexOf("data-chats-section=\"projects\""));
    expect(html).toContain("2 older");
    expect(html).toContain("Archived · 9");
    // Archived starts folded: its header only
    expect(html).toMatch(/data-chats-section="archived"[^]*aria-expanded="false"/);
  });

  it("keeps the day list for a short list, a search, a filter or a later page", () => {
    const short = appendChatPage(NO_CHATS, { chats: many().slice(0, 10), next: null, total: 10 }, true);
    expect(render({ held: short })).not.toContain("data-chats-sections");
    expect(render({ held: held(), query: "brief" })).not.toContain("data-chats-sections");
    expect(render({ held: held(), filters: { unread: true } })).not.toContain("data-chats-sections");
    expect(render({ held: held(), pageIndex: 1 })).not.toContain("data-chats-sections");
  });

  it("files each chat under its place first, then its channel, then its bot", () => {
    expect(chatHome(row("a", 1))).toEqual({ section: "bots", owner: "ember" });
    expect(chatHome(row("b", 1, { place: { kind: "project", groupId: "move", name: "Office move" } }))).toEqual({ section: "projects", owner: "move" });
    expect(chatHome(row("c", 1, { groupId: "launch", botId: undefined }))).toEqual({ section: "channels", owner: "launch" });
    expect(chatHome(row("d", 1, { archived: true }))?.section).toBe("archived");
    const views = chatsSections(many(), NOW, () => 0);
    const bots = views.find((view) => view.key === "bots")!;
    expect(bots.rows.map((owner) => owner.key)).toEqual(["bots:ember", "bots:sage"]);
    expect(bots.rows[0]!.latest.threadId).toBe("e0");
    expect(bots.older.map((owner) => owner.key)).toEqual(["bots:old2", "bots:old3"]);
    expect(views.some((view) => view.key === "archived")).toBe(false);
    expect(chatsSectionTitle({ key: "bots", label: "Bots", waiting: 0 })).toBe("Bots");
    expect(chatsSectionsShown(CHATS_SECTIONS_MIN, "", 0)).toBe(true);
    expect(chatsSectionsShown(CHATS_SECTIONS_MIN - 1, "", 0)).toBe(false);
    // waiting is read once from the store: a chat's own state, or the bot's for its main thread
    expect([...chatsWaitingThreads(waitingBots)].sort()).toEqual(["e3", "s0"]);
  });

  it("copy keeps the house rules", () => {
    const html = render({ held: held(), bots: waitingBots, waitingThreads: chatsWaitingThreads(waitingBots), archived: { total: 9, rows: [] } });
    for (const banned of BANNED) expect(html).not.toMatch(banned);
  });
});
