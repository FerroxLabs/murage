// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The boot roster (`GET /api/bots?view=sidebar`) carries one sidebar line per conversation and no rows. A conversation's rows exist in the
// client only once its first page (`view=switch`) has landed; live events for it while the page is on the wire are queued in the reducer and
// replayed over the page; live rows for a conversation never opened move only its line. Design: ROSTER-SIDEBARLINE-DESIGN.md section 8,
// tests 7 to 13 and 15.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { initialState, pendingThreadActionBlocked, reducer, type Action, type AppState, type Bot, type Group, type Message } from "@/state/store";
import { createScrollback, needsFirstPage, type FirstPageAnswer } from "@/lib/scrollback";
import { sidebarLineOf } from "../../shared/sidebar-line";
import { httpNow } from "../state/test-origins";

const LONG = "a long reply that the sidebar shows one line of ".repeat(40);
const row = (thread: string, i: number, extra: Partial<Message> = {}): Message => ({
  id: `${thread}-${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: `${thread} ${i} ${LONG}`, parentId: i ? `${thread}-${i - 1}` : null, ...extra,
});
const card = (thread: string, i: number, answered?: string): Message => ({
  ...row(thread, i), kind: "options", text: undefined, card: { title: "Allow the deploy?", subtitle: "", options: ["Yes", "No"], requestId: `req-${i}`, ...(answered ? { answered } : {}) },
} as Message);

/** A roster entry as `view=sidebar` sends it: the record and its line, no `messages`. */
const rosterBot = (id: string, thread: string, head: Message, extra: Partial<Bot> = {}) =>
  ({ id, name: id, threadId: thread, activeLeafId: head.id, sidebarLine: sidebarLineOf(head), tasks: [], ...extra }) as unknown as Bot;
const rosterRoom = (id: string, thread: string, head: Message, total: number) =>
  ({ id, name: id, threadId: thread, memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, tasks: [{ threadId: thread, title: "t" }], sidebarLine: sidebarLineOf(head), messagesTotal: total }) as unknown as Group;

const hydrate = (bots: Bot[], groups: Group[]): Action => ({ type: "hydrate", ...httpNow, bots, groups, computerControl: {} });

/** Every full row the fixture server holds, by id, so a held row can be compared with the row it came from. */
const fixtureRows = new Map<string, Message>();
const remember = (rows: Message[]) => { for (const message of rows) fixtureRows.set(message.id, message); return rows; };

/** No conversation holds a row while unloaded, and no held row is cut or carries a `truncated` key. */
function assertNoCutRows(state: AppState) {
  for (const owner of [...state.bots, ...state.groups]) {
    if (owner.messagesUnloaded) expect(owner.messages).toEqual([]);
    for (const message of [...owner.messages, ...(owner.openCards ?? [])]) {
      expect(message).not.toHaveProperty("truncated");
      const source = fixtureRows.get(message.id);
      if (source?.text) expect(message.text?.length ?? 0).toBeGreaterThanOrEqual(source.text.length);
    }
  }
}

/** A reducer and a scrollback over a server whose `view=switch` answer is `pages[threadId]`. */
function rig(state: AppState, pages: Record<string, () => FirstPageAnswer>) {
  const box = { state };
  const requests: string[] = [];
  let failNext = 0;
  let duringFetch: (() => void) | undefined;
  const dispatch = (action: Action) => { box.state = reducer(box.state, action); assertNoCutRows(box.state); };
  const request = vi.fn(async (path: string) => {
    requests.push(path);
    const url = new URL(path, "http://x");
    const threadId = url.pathname.split("/")[3]!;
    if (duringFetch) { const hook = duringFetch; duringFetch = undefined; hook(); }
    if (failNext > 0) { failNext--; throw new Error("offline"); }
    if (url.searchParams.get("view") === "switch") return pages[threadId]!();
    if (url.searchParams.get("around")) return { messages: [] };
    const all = [...fixtureRows.values()].filter((message) => message.id.startsWith(`${threadId}-`)).sort((a, b) => a.at - b.at);
    const before = url.searchParams.get("before") ?? url.searchParams.get("branchFrom");
    const end = before ? all.findIndex((message) => message.id === before) + (url.searchParams.get("branchFrom") ? 1 : 0) : all.length;
    const limit = Number(url.searchParams.get("limit"));
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0, ...(url.searchParams.get("branchFrom") ? { olderFrom: start > 0 ? all[start - 1]!.id : null } : {}) };
  });
  const scrollback = createScrollback({ getState: () => box.state, dispatch, request, onError: vi.fn(), settle: () => Promise.resolve() });
  return {
    scrollback, requests, dispatch,
    get state() { return box.state; },
    bot: (id: string) => box.state.bots.find((bot) => bot.id === id)!,
    group: (id: string) => box.state.groups.find((group) => group.id === id)!,
    fail(n = 1) { failNext = n; },
    during(fn: () => void) { duringFetch = fn; },
  };
}

const pageOf = (rows: Message[], extra: Partial<FirstPageAnswer> = {}): FirstPageAnswer => ({ messages: rows, hasMore: false, activeLeafId: rows.at(-1)?.id ?? null, version: "v1", ...extra });

function boot() {
  const a = remember(Array.from({ length: 30 }, (_, i) => row("ta", i)));
  const b = remember(Array.from({ length: 12 }, (_, i) => row("tb", i)));
  const g = remember(Array.from({ length: 8 }, (_, i) => row("tg", i, { from: { botId: "b1", name: "Ada", color: "blue" } })));
  let state = reducer({ ...initialState, selectedId: "b1" }, hydrate([rosterBot("b1", "ta", a.at(-1)!), rosterBot("b2", "tb", b.at(-1)!)], [rosterRoom("g1", "tg", g.at(-1)!, 8)]));
  state = { ...state, selectedId: "b1", activeView: "chat" };
  return { a, b, g, state };
}

describe("boot from view=sidebar", () => {
  it("test 7: no truncated row is reachable through any action, and an unloaded conversation holds nothing", async () => {
    const { a, b, g, state } = boot();
    for (const owner of [...state.bots, ...state.groups]) {
      expect(owner.messagesUnloaded).toBe(true);
      expect(owner.messages).toEqual([]);
      expect(needsFirstPage(owner)).toBe(true);
    }
    const t = rig(state, { ta: () => pageOf(a.slice(-20), { hasMore: true }), tb: () => pageOf(b), tg: () => pageOf(g) });
    const live = remember([row("tb", 12), row("ta", 30), row("tg", 8, { from: { botId: "b1", name: "Ada", color: "blue" } })]);
    // unopened, opened, and loading conversations all take live rows, patches and thread frames
    t.dispatch({ type: "messageAdded", threadId: "tb", message: live[0]! });
    t.dispatch({ type: "messagePatched", threadId: "tb", message: { ...live[0]!, text: `${live[0]!.text} edited` } });
    t.dispatch({ type: "threadActive", threadId: "tb", activeLeafId: "tb-11", sidebarLine: sidebarLineOf(b[11]!) });
    t.during(() => t.dispatch({ type: "messageAdded", threadId: "ta", message: live[1]! }));
    await t.scrollback.loadFirstPage("ta");
    t.dispatch({ type: "messageAdded", threadId: "tg", message: live[2]! });
    t.fail();
    await t.scrollback.loadFirstPage("tg");
    await t.scrollback.loadFirstPage("tg");
    t.dispatch({ type: "groupPatched", group: { id: "g1", name: "renamed" } });
    t.dispatch({ type: "taskSwitched", source: "local", bot: { ...t.bot("b2"), messages: b, hasMore: false } as Bot });
    t.dispatch(hydrate([rosterBot("b1", "ta", live[1]!), rosterBot("b2", "tb", b.at(-1)!)], [rosterRoom("g1", "tg", live[2]!, 9)]));
    assertNoCutRows(t.state);
    expect(t.bot("b2").messagesUnloaded).toBe(true);
  });

  it("test 8: the first page is the switch page: it reaches the branch head, carries the newer card beside it, and pages back by its cursor", async () => {
    // 50,000 stored rows; the selected head sits 400 rows back on a fork, so the server answers the head's branch page (cursor `olderFrom`)
    const rows = Array.from({ length: 600 }, (_, i) => row("tf", 49_400 + i));
    remember(rows);
    const head = rows[199]!;
    const branch = rows.slice(100, 200);
    const approval = card("tf", 1_000, undefined);
    const t = rig(reducer({ ...initialState, selectedId: "bf" }, hydrate([rosterBot("bf", "tf", head)], [])), {
      tf: () => pageOf(branch, { hasMore: true, olderFrom: rows[99]!.id, activeLeafId: head.id, openCards: [approval], openCardsLeaf: head.id }),
    });
    t.during(() => t.dispatch({ type: "messagePatched", threadId: "tf", message: card("tf", 1_000, "Yes") }));
    await t.scrollback.loadFirstPage("tf");
    expect(t.requests[0]).toBe("/api/threads/tf/messages?view=switch&limit=100");
    const bot = t.bot("bf");
    expect(bot.messagesUnloaded).toBeUndefined();
    expect(bot.activeLeafId).toBe(head.id);
    expect(bot.messages.at(-1)!.id).toBe(head.id);
    expect(bot.threadVersion).toBe("v1");
    expect(bot.openCards![0]!.card!.answered).toBe("Yes");
    expect(bot.olderFrom).toBe(rows[99]!.id);
    expect(bot.sidebarLine!.messageId).toBe(head.id);
    await t.scrollback.loadOlder("tf");
    expect(t.requests[1]).toContain(`branchFrom=${rows[99]!.id}`);
    expect(t.bot("bf").messages[0]!.id).toBe(rows[0]!.id);
  });

  it("test 9: a live row and a card answer that land while the page is on the wire are replayed over it, once, in order", async () => {
    const rows = remember(Array.from({ length: 5 }, (_, i) => row("tq", i)));
    const asked = remember([card("tq", 5)])[0]!;
    const t = rig(reducer({ ...initialState, selectedId: "bq" }, hydrate([rosterBot("bq", "tq", asked)], [])), {});
    t.dispatch({ type: "firstPageStarted", threadId: "tq" });
    expect(t.bot("bq").firstPageEvents).toEqual([]);
    const a = remember([row("tq", 6, { parentId: asked.id })])[0]!;
    t.dispatch({ type: "messageAdded", threadId: "tq", message: a });
    t.dispatch({ type: "messagePatched", threadId: "tq", message: card("tq", 5, "Yes") });
    // queued, not applied: nothing is held yet and the send path is open
    expect(t.bot("bq").messages).toEqual([]);
    expect(t.bot("bq").firstPageEvents).toHaveLength(2);
    expect(pendingThreadActionBlocked(t.state, { type: "send", botId: "bq", text: "hi" })).toBe(false);
    const generation = t.state.transcriptGeneration.tq ?? 0;
    t.dispatch({ type: "firstPage", threadId: "tq", generation, page: pageOf([...rows, asked]) });
    const held = t.bot("bq").messages;
    expect(held.map((m) => m.id)).toEqual([...rows.map((m) => m.id), asked.id, a.id]);
    expect(held.find((m) => m.id === asked.id)!.card!.answered).toBe("Yes");
    expect(t.bot("bq").activeLeafId).toBe(a.id);
    expect(t.bot("bq").sidebarLine!.messageId).toBe(a.id);
    expect(t.bot("bq").firstPageEvents).toBeUndefined();
    // the same row arriving again (the canonical frame after the POST answer) is folded once
    t.dispatch({ type: "messageAdded", threadId: "tq", message: a });
    expect(t.bot("bq").messages.filter((m) => m.id === a.id)).toHaveLength(1);
  });

  it("test 10: a live row for a conversation never opened moves its line and head only; a room's unread works as before", () => {
    const { b, g, state } = boot();
    let next = reducer(state, { type: "messageAdded", threadId: "tb", message: row("tb", 12) });
    const bot = next.bots.find((candidate) => candidate.id === "b2")!;
    expect(bot.messages).toEqual([]);
    expect(bot.activeLeafId).toBe("tb-12");
    expect(bot.sidebarLine!.messageId).toBe("tb-12");
    // a late artefact that does not adopt the head leaves the line on the head
    next = reducer(next, { type: "messageAdded", threadId: "tb", message: row("tb", 99, { parentId: b[3]!.id }) });
    expect(next.bots.find((candidate) => candidate.id === "b2")!.sidebarLine!.messageId).toBe("tb-12");
    // a patch to the line's row moves the line
    next = reducer(next, { type: "messagePatched", threadId: "tb", message: { ...row("tb", 12), text: "rewritten" } });
    expect(next.bots.find((candidate) => candidate.id === "b2")!.sidebarLine!.text).toBe("rewritten");
    // a room: the line, the count and the unread mark, without rows
    const reply = row("tg", 8, { role: "bot", from: { botId: "b1", name: "Ada", color: "blue" } });
    next = reducer(next, { type: "messageAdded", threadId: "tg", message: reply });
    next = reducer(next, { type: "messageAdded", threadId: "tg", message: reply });
    const room = next.groups[0]!;
    expect(room.messages).toEqual([]);
    expect(room.sidebarLine!.messageId).toBe(reply.id);
    expect(room.unread).toBe(true);
    expect(room.tasks![0]!.unreadMessageIds).toEqual([reply.id]);
    expect(room.messagesTotal).toBe(g.length + 1);
  });

  it("test 11: a failed first page leaves the conversation unloaded and sends open; it asks again; a discarded page leaves it unloaded", async () => {
    const { a, state } = boot();
    const t = rig(state, { ta: () => pageOf(a) });
    t.fail();
    await t.scrollback.loadFirstPage("ta");
    expect(t.bot("b1").messagesUnloaded).toBe(true);
    expect(t.bot("b1").firstPageEvents).toBeUndefined();
    expect(needsFirstPage(t.bot("b1"))).toBe(true);
    expect(pendingThreadActionBlocked(t.state, { type: "send", botId: "b1", text: "hi" })).toBe(false);
    // the store's effect asks again (reopen, visibility, online); here the same call
    await t.scrollback.loadFirstPage("ta");
    expect(t.bot("b1").messages).toHaveLength(30);
    // a page discarded because the transcript moved (a rehydrate) leaves the conversation unloaded
    const again = rig(boot().state, { ta: () => pageOf(a) });
    again.during(() => again.dispatch(hydrate([rosterBot("b1", "ta", a.at(-1)!, {}), rosterBot("b2", "tb", row("tb", 11))], [])));
    // b1 is on screen but held no rows: the rehydrate keeps it unloaded
    await again.scrollback.loadFirstPage("ta");
    expect(again.bot("b1").messagesUnloaded).toBe(true);
    expect(again.bot("b1").messages).toEqual([]);
  });

  it("test 12: a rehydrate keeps the rows of the conversation on screen and fetches it again; every other conversation drops its rows", async () => {
    const { a, b, state } = boot();
    const t = rig(state, { ta: () => pageOf(a), tb: () => pageOf(b) });
    await t.scrollback.loadFirstPage("ta");
    await t.scrollback.loadFirstPage("tb");
    expect(t.bot("b2").messages).toHaveLength(12);
    const onScreen = t.bot("b1").messages;
    t.dispatch(hydrate([rosterBot("b1", "ta", a.at(-1)!), rosterBot("b2", "tb", b.at(-1)!)], []));
    expect(t.bot("b1").messages).toBe(onScreen);
    expect(t.bot("b1").messagesUnloaded).toBeUndefined();
    expect(t.bot("b1").pageStale).toBe(true);
    expect(needsFirstPage(t.bot("b1"))).toBe(true);
    expect(t.bot("b2").messages).toEqual([]);
    expect(t.bot("b2").messagesUnloaded).toBe(true);
    const more = remember([row("ta", 30)]);
    const fresh = rig(t.state, { ta: () => pageOf([...a, ...more]) });
    await fresh.scrollback.loadFirstPage("ta");
    expect(fresh.bot("b1").pageStale).toBeUndefined();
    expect(fresh.bot("b1").messages.at(-1)!.id).toBe("ta-30");
  });

  it("test 13: a search jump into a conversation never opened waits for its first page, then walks back", async () => {
    const { state } = boot();
    const rows = remember(Array.from({ length: 300 }, (_, i) => row("tb", i)));
    const t = rig(state, { tb: () => pageOf(rows.slice(-100), { hasMore: true }) });
    const outcome = await t.scrollback.loadThrough("tb", "tb-20");
    expect(t.requests[0]).toBe("/api/threads/tb/messages?view=switch&limit=100");
    expect(outcome).toBe("fetched");
    expect(t.bot("b2").messages.some((m) => m.id === "tb-20")).toBe(true);
    expect(t.bot("b2").messages.at(-1)!.id).toBe("tb-299");
  });

  it("test 15: a call starts only once the first page is held, so a page landing mid-call is not recited", () => {
    for (const [file, owner] of [["CallView.tsx", "bot"], ["GroupCallView.tsx", "group"]] as const) {
      const source = readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
      expect(source).toContain(`if (!started.current && !${owner}.messagesUnloaded && !${owner}.pageStale && !${owner}.firstPageEvents) {`);
      expect(source).toMatch(/if \(!started\.current\) return;\n\s+const fresh = unheardMessages\(/);
    }
  });
});
