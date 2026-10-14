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
