// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The roster carries preview rows (`truncated`) for the sidebar only. Opening a thread fetches a fresh first page and REPLACES what the thread held; the
// thread then holds no cut row and older history pages by the normal cursor. A failed or discarded fetch leaves the thread marked, so the next open asks again.
import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, type AppState, type Bot, type Message } from "@/state/store";
import { createScrollback, holdsPreviewRows, needsNewestPage } from "@/lib/scrollback";

const full = (i: number): Message => ({ id: `m${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: `full text ${i} ${"y".repeat(5000)}` });
const preview = (i: number): Message => ({ ...full(i), text: `full text ${i}`, truncated: true });

/** A server with `total` rows; the first page (no cursor) is the newest `limit`, a `before` page walks back by id. */
function rig(total: number, held: Message[], hasMore: boolean) {
  const all = Array.from({ length: total }, (_, i) => full(i));
  let state: AppState = { ...initialState, bots: [{ id: "bot", threadId: "t", messages: held, hasMore } as never as Bot] };
  const requests: string[] = [];
  let failNext = 0;
  let beforeLand: (() => void) | undefined;
  const request = vi.fn(async (path: string) => {
    requests.push(path);
    if (failNext > 0) { failNext--; throw new Error("offline"); }
    const q = new URL(path, "http://x").searchParams;
    const limit = Number(q.get("limit"));
    const before = q.get("before");
    const end = before ? Number(before.slice(1)) : total;
    const start = Math.max(0, end - limit);
    const answer = { messages: all.slice(start, end), hasMore: start > 0 };
    if (beforeLand) { const hook = beforeLand; beforeLand = undefined; hook(); }
    return answer;
  });
  const dispatch = (a: Parameters<typeof reducer>[1]) => { state = reducer(state, a); };
  const scrollback = createScrollback({ getState: () => state, dispatch, request, onError: vi.fn(), settle: () => Promise.resolve() });
  return {
    scrollback, requests,
    get bot() { return state.bots[0]!; },
    fail(n = 1) { failNext = n; },
    duringFetch(fn: () => void) { beforeLand = fn; },
    /** A rehydrate: a new transcript generation and the roster's preview rows again. */
    rehydrate(rows: Message[], hasMore: boolean) {
      state = { ...state, bots: [{ ...state.bots[0]!, messages: rows, hasMore, olderFrom: undefined }], transcriptGeneration: { ...state.transcriptGeneration, t: (state.transcriptGeneration.t ?? 0) + 1 } };
    },
    pushLive(message: Message) { state = { ...state, bots: [{ ...state.bots[0]!, messages: [...state.bots[0]!.messages, message] }] }; },
    get loading() { return Boolean(state.loadingOlder.t); },
  };
}

describe("opening a thread that holds roster preview rows", () => {
  it("a thread holding a truncated row is marked as needing a fresh page", () => {
    expect(needsNewestPage({ messages: [preview(2)], hasMore: false })).toBe(true);
    expect(needsNewestPage({ messages: [full(2)], hasMore: false })).toBe(false);
  });

  it("150 held rows with 30 cut: after open there is no cut row and the held rows are the fresh page", async () => {
    const held = Array.from({ length: 150 }, (_, k) => (k % 5 === 0 ? preview(250 + k) : full(250 + k)));
    expect(held.filter((m) => m.truncated)).toHaveLength(30);
    const t = rig(400, held, true);
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).not.toContain("before=");
    expect(holdsPreviewRows(t.bot)).toBe(false);
    expect(t.bot.messages.map((m) => m.id)).toEqual(Array.from({ length: 100 }, (_, k) => `m${300 + k}`));
    expect(t.bot.messages.every((m) => m.text!.length > 5000)).toBe(true);
    expect(t.bot.hasMore).toBe(true);
    expect(needsNewestPage(t.bot)).toBe(false);
    expect(t.loading).toBe(false);
  });

  it("Load earlier after the open pages by cursor from the oldest held row", async () => {
    const t = rig(400, [preview(398), preview(399)], true);
    await t.scrollback.loadOlder("t");
    t.requests.length = 0;
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toContain("before=m300");
    expect(t.bot.messages[0]!.id).toBe("m200");
    expect(t.bot.messages).toHaveLength(200);
  });

  it("a failed fresh fetch leaves the thread marked; opening again retries and fixes it", async () => {
    const t = rig(10, [preview(8), preview(9)], true);
    t.fail();
    await t.scrollback.loadOlder("t");
    expect(holdsPreviewRows(t.bot)).toBe(true);
    expect(needsNewestPage(t.bot)).toBe(true);
    expect(t.loading).toBe(false);
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(2);
    expect(t.requests.every((r) => !r.includes("before="))).toBe(true);
    expect(holdsPreviewRows(t.bot)).toBe(false);
    expect(t.bot.messages.map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, k) => `m${k}`));
    expect(t.bot.hasMore).toBe(false);
  });

  it("a fetch discarded by a newer generation leaves the thread marked and the next open fixes it", async () => {
    const t = rig(10, [preview(8), preview(9)], true);
    t.duringFetch(() => t.rehydrate([preview(8), preview(9)], true));
    await t.scrollback.loadOlder("t");
    expect(holdsPreviewRows(t.bot)).toBe(true);
    expect(t.loading).toBe(false);
    await t.scrollback.loadOlder("t");
    expect(holdsPreviewRows(t.bot)).toBe(false);
    expect(t.bot.messages).toHaveLength(10);
  });

  it("a rehydrate after a full fetch brings cut rows back; the next open fixes them again", async () => {
    const t = rig(10, [preview(8), preview(9)], true);
    await t.scrollback.loadOlder("t");
    expect(holdsPreviewRows(t.bot)).toBe(false);
    t.rehydrate([preview(7), preview(8), preview(9)], true);
    expect(needsNewestPage(t.bot)).toBe(true);
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(2);
    expect(holdsPreviewRows(t.bot)).toBe(false);
    expect(t.bot.messages).toHaveLength(10);
  });

  it("an expanded 500-row roster page holds no cut row after open, and Load earlier continues by cursor", async () => {
    const held = Array.from({ length: 500 }, (_, k) => (k % 3 === 0 ? preview(500 + k) : full(500 + k)));
    const t = rig(1200, held, true);
    await t.scrollback.loadOlder("t");
    expect(holdsPreviewRows(t.bot)).toBe(false);
    expect(t.bot.messages).toHaveLength(100);
    expect(t.requests).toHaveLength(1);
    await t.scrollback.loadOlder("t");
    expect(t.requests[1]).toContain("before=m1100");
  });

  it("a live row that arrived while the page was on the wire is kept behind the page", async () => {
    const live: Message = { id: "live", at: 999, role: "bot", kind: "text", text: "just now" };
    const t = rig(10, [preview(8), preview(9)], true);
    t.duringFetch(() => t.pushLive(live));
    await t.scrollback.loadOlder("t");
    expect(t.bot.messages.map((m) => m.id)).toEqual([...Array.from({ length: 10 }, (_, k) => `m${k}`), "live"]);
    expect(holdsPreviewRows(t.bot)).toBe(false);
  });

  it("without preview rows the older page is asked for by cursor, as before", async () => {
    const t = rig(10, [full(8), full(9)], true);
    await t.scrollback.loadOlder("t");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toContain("before=m8");
  });
});
