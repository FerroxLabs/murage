// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The roster carries preview rows (`truncated`). A conversation that holds one fetches its newest page and the full rows REPLACE the cut ones; the older
// top-up only prepends, so without this a truncated newest row would stay truncated for as long as the thread was open.
import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, type AppState, type Bot, type Message } from "@/state/store";
import { createScrollback, needsNewestPage } from "@/lib/scrollback";

const full = (i: number): Message => ({ id: `m${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: `full text ${i} ${"y".repeat(5000)}` });
const preview = (i: number): Message => ({ ...full(i), text: `full text ${i}`, truncated: true });

function rig(total: number, held: Message[], hasMore: boolean) {
  const all = Array.from({ length: total }, (_, i) => full(i));
  let state: AppState = { ...initialState, bots: [{ id: "bot", threadId: "t", messages: held, hasMore } as never as Bot] };
  const requests: string[] = [];
  const request = vi.fn(async (path: string) => {
    requests.push(path);
    const limit = Number(new URL(path, "http://x").searchParams.get("limit"));
    const start = Math.max(0, total - limit);
    return { messages: all.slice(start), hasMore: start > 0 };
  });
  const scrollback = createScrollback({ getState: () => state, dispatch: (action) => { state = reducer(state, action); }, request, onError: vi.fn(), settle: () => Promise.resolve() });
  return { scrollback, requests, get bot() { return state.bots[0]!; } };
}

describe("preview rows from the roster", () => {
  it("a thread holding a truncated row needs its newest page, even when the server says there is nothing older", () => {
    expect(needsNewestPage({ messages: [preview(2)], hasMore: false })).toBe(true);
    expect(needsNewestPage({ messages: [full(2)], hasMore: false })).toBe(false);
  });

  it("opening the thread replaces every truncated row with the full row, in order, with no cursor", async () => {
    const t = rig(10, [preview(7), preview(8), full(9)], true);
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).not.toContain("before=");
    expect(t.bot.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
    expect(t.bot.messages.some((m) => m.truncated)).toBe(false);
    expect(t.bot.messages.find((m) => m.id === "m8")!.text!.length).toBeGreaterThan(5000);
    expect(t.bot.hasMore).toBe(false);
    expect(needsNewestPage(t.bot)).toBe(false);
  });

  it("a row that arrived live while the page was on the wire is kept", async () => {
    const live: Message = { id: "live", at: 99, role: "bot", kind: "text", text: "just now" };
    const t = rig(10, [preview(9), live], true);
    await t.scrollback.loadOlder("t");
    expect(t.bot.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "live"]);
    expect(t.bot.messages.some((m) => m.truncated)).toBe(false);
  });

  it("a page that has older rows leaves hasMore true and still replaces the cut rows", async () => {
    const t = rig(250, [preview(248), preview(249)], true);
    await t.scrollback.loadOlder("t");
    expect(t.bot.messages).toHaveLength(100);
    expect(t.bot.messages.some((m) => m.truncated)).toBe(false);
    expect(t.bot.hasMore).toBe(true);
  });

  it("without preview rows the older page is asked for by cursor, as before", async () => {
    const t = rig(10, [full(8), full(9)], true);
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toContain("before=m8");
  });
});

// An expanded roster page (selected branch head, open cards) can hold more cut rows than the newest page reaches.
describe("expanded roster page", () => {
  function expandedRig(broken: Set<string> = new Set()) {
    const total = 400;
    const all = Array.from({ length: total }, (_, i) => full(i));
    const cut = new Set(Array.from({ length: 30 }, (_, k) => 250 + k * 5)); // 30 cut rows spread over rows 250..395
    const held = all.slice(250, 400).map((m, k) => (cut.has(250 + k) ? preview(250 + k) : m));
    let state: AppState = { ...initialState, bots: [{ id: "bot", threadId: "t", messages: held, hasMore: true } as never as Bot] };
    const requests: string[] = [];
    const request = vi.fn(async (path: string) => {
      requests.push(path);
      const q = new URL(path, "http://x").searchParams;
      const limit = Number(q.get("limit"));
      const around = q.get("around"), before = q.get("before");
      if (around && broken.has(around)) throw new Error("gone");
      if (around) return { messages: [all[Number(around.slice(1))]!], hasMore: true };
      const end = before ? Number(before.slice(1)) : total;
      const start = Math.max(0, end - limit);
      return { messages: all.slice(start, end), hasMore: start > 0 };
    });
    const scrollback = createScrollback({ getState: () => state, dispatch: (a) => { state = reducer(state, a); }, request, onError: vi.fn(), settle: () => Promise.resolve() });
    return { scrollback, requests, get bot() { return state.bots[0]!; } };
  }

  it("replaces every cut row, then Load earlier pages by cursor from the oldest held row", async () => {
    const t = expandedRig();
    await t.scrollback.loadOlder("t");
    expect(t.bot.messages).toHaveLength(150);
    expect(t.bot.messages.some((m) => m.truncated)).toBe(false);
    expect(needsNewestPage(t.bot)).toBe(false);
    expect(t.bot.hasMore).toBe(true);
    // the 10 cut rows older than the newest page (250..299) came by id
    expect(t.requests.filter((r) => r.includes("around="))).toHaveLength(10);
    t.requests.length = 0;
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toContain("before=m250");
    expect(t.bot.messages[0]!.id).toBe("m150");
    expect(t.bot.messages).toHaveLength(250);
  });

  it("never fetches the newest page twice for one thread without progress", async () => {
    const t = expandedRig();
    await t.scrollback.loadOlder("t");
    const newest = () => t.requests.filter((r) => !r.includes("around=") && !r.includes("before="));
    expect(newest()).toHaveLength(1);
    await t.scrollback.loadOlder("t");
    await t.scrollback.loadOlder("t");
    expect(newest()).toHaveLength(1);
    expect(new Set(t.requests).size).toBe(t.requests.length);
  });

  it("a cut row that cannot be fetched is asked for once and paging still moves", async () => {
    const t = expandedRig(new Set(["m255"]));
    await t.scrollback.loadOlder("t");
    expect(t.bot.messages.filter((m) => m.truncated).map((m) => m.id)).toEqual(["m255"]);
    await t.scrollback.loadOlder("t");
    await t.scrollback.loadOlder("t");
    expect(t.requests.filter((r) => r.includes("around=m255"))).toHaveLength(1);
    expect(t.requests.filter((r) => r.includes("before="))).toHaveLength(2);
  });

  it("a live row that arrived meanwhile is kept", async () => {
    const t = expandedRig();
    const live: Message = { id: "live", at: 999, role: "bot", kind: "text", text: "now" };
    t.bot.messages.push(live);
    await t.scrollback.loadOlder("t");
    expect(t.bot.messages.at(-1)!.id).toBe("live");
    expect(t.bot.messages).toHaveLength(151);
  });
});
