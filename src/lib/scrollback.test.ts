import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, type AppState, type Bot, type Message } from "@/state/store";
import { createScrollback, hydratePageSize, MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE, needsNewestPage, PHONE_HYDRATE_PAGE, unheardMessages } from "./scrollback";

// A thread of `total` messages m0..m{total-1}; the client holds the newest
// `held`. The fake server answers `before=` and `around=` like the harness.
function rig(total: number, held: number) {
  const all: Message[] = Array.from({ length: total }, (_, i) => ({ id: `m${i}`, at: i, role: "user", kind: "text", text: `#${i}` }));
  const bot = { id: "bot", threadId: "t", messages: all.slice(total - held), hasMore: held < total } as never as Bot;
  let state: AppState = { ...initialState, bots: [bot] };
  const requests: string[] = [];
  const request = vi.fn(async (path: string) => {
    requests.push(path);
    const url = new URL(path, "http://x");
    const limit = Number(url.searchParams.get("limit"));
    const around = url.searchParams.get("around");
    if (around) {
      if (!all.some((m) => m.id === around)) throw Object.assign(new Error("no such message"), { status: 404 });
      return { messages: all.filter((m) => m.id === around), hasMore: true };
    }
    const end = all.findIndex((m) => m.id === url.searchParams.get("before"));
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  });
  const onError = vi.fn();
  const scrollback = createScrollback({
    getState: () => state,
    dispatch: (action) => { state = reducer(state, action); },
    request,
    onError,
    settle: () => Promise.resolve(),
  });
  return { scrollback, request, requests, onError, all, get state() { return state; }, set state(next) { state = next; } };
}

describe("loadOlder", () => {
  it("asks for the page before the oldest held message and prepends it", async () => {
    const r = rig(300, 100);
    await r.scrollback.loadOlder("t");
    expect(r.requests).toEqual([`/api/threads/t/messages?limit=${MESSAGE_PAGE_SIZE}&before=m200`]);
    expect(r.state.bots[0].messages.map((m) => m.id)).toEqual(r.all.slice(100).map((m) => m.id));
    expect(r.state.bots[0].hasMore).toBe(true);
    expect(r.state.loadingOlder).toEqual({});
  });

  it("asks once while a page is on the wire", async () => {
    const r = rig(300, 100);
    const first = r.scrollback.loadOlder("t");
    expect(r.scrollback.loadOlder("t")).toBeUndefined();
    await first;
    expect(r.request).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a thread the server said is whole", async () => {
    const r = rig(10, 10);
    expect(r.scrollback.loadOlder("t")).toBeUndefined();
    expect(r.request).not.toHaveBeenCalled();
    expect(r.state.loadingOlder).toEqual({});
  });

  it("clears the loading state and reports a failed page", async () => {
    const r = rig(300, 100);
    r.request.mockRejectedValueOnce(new Error("offline"));
    await r.scrollback.loadOlder("t");
    expect(r.onError).toHaveBeenCalled();
    expect(r.state.loadingOlder).toEqual({});
    expect(r.state.bots[0].hasMore).toBe(true);
  });
});

describe("loadThrough", () => {
  it("answers at once for a message already held", async () => {
    const r = rig(300, 100);
    await expect(r.scrollback.loadThrough("t", "m250")).resolves.toBe("held");
    expect(r.request).not.toHaveBeenCalled();
  });

  it("walks back contiguously until the target is held", async () => {
    const r = rig(1000, 100);
    await expect(r.scrollback.loadThrough("t", "m12")).resolves.toBe("fetched");
    const ids = r.state.bots[0].messages.map((m) => m.id);
    // no hole: every message from the target's page to the newest is held
    expect(ids).toEqual(r.all.slice(ids.length === 1000 ? 0 : 1000 - ids.length).map((m) => m.id));
    expect(ids).toContain("m12");
    expect(r.requests[0]).toBe("/api/threads/t/messages?around=m12&limit=1");
    expect(r.requests.slice(1).every((path) => path.includes(`limit=${MESSAGE_PAGE_MAX}&before=`))).toBe(true);
    expect(r.state.loadingOlder).toEqual({});
  });

  it("never walks the transcript for a message that is not in it", async () => {
    const r = rig(1000, 100);
    await expect(r.scrollback.loadThrough("t", "elsewhere")).resolves.toBe("missing");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.state.bots[0].messages).toHaveLength(100);
  });

  it("stops when the thread's transcript is replaced mid-walk", async () => {
    const r = rig(1000, 100);
    const request = r.request.getMockImplementation()!;
    let pages = 0;
    r.request.mockImplementation(async (path: string) => {
      const answer = await request(path);
      if (path.includes("before=") && ++pages === 1) r.state = reducer(r.state, { type: "threadActive", threadId: "t", activeLeafId: "m999" });
      return answer;
    });
    await expect(r.scrollback.loadThrough("t", "m12")).resolves.toBe("missing");
    // the page answered under the old generation was dropped, not prepended
    expect(r.state.bots[0].messages).toHaveLength(100);
    expect(r.state.loadingOlder).toEqual({});
  });

  it("waits for the thread a jump switched to", async () => {
    const r = rig(300, 100);
    const pending = r.scrollback.loadThrough("t2", "m5");
    r.state = { ...r.state, bots: [{ ...r.state.bots[0], threadId: "t2" }] };
    await expect(pending).resolves.toBe("fetched");
  });
});

describe("unheardMessages", () => {
  const m = (id: string) => ({ id });
  it("reads what arrived after the newest message already heard", () => {
    expect(unheardMessages([m("a"), m("b"), m("c")], new Set(["a"]))).toEqual([m("b"), m("c")]);
  });
  it("treats a page prepended mid-call as history", () => {
    expect(unheardMessages([m("old1"), m("old2"), m("a"), m("b")], new Set(["a"]))).toEqual([m("b")]);
  });
  it("reads everything when nothing was on screen", () => {
    expect(unheardMessages([m("a")], new Set())).toEqual([m("a")]);
  });
});

describe("phone hydrate (spec §6)", () => {
  it("asks for one row per thread on a phone and a full page elsewhere", () => {
    expect(hydratePageSize(true)).toBe(PHONE_HYDRATE_PAGE);
    expect(PHONE_HYDRATE_PAGE).toBe(1);
    expect(hydratePageSize(false)).toBe(MESSAGE_PAGE_SIZE);
  });

  it("tops up a slim thread to a full page with one ordinary scrollback request", async () => {
    const r = rig(300, 1);
    expect(needsNewestPage(r.state.bots[0])).toBe(true);
    await r.scrollback.loadOlder("t");
    expect(r.requests).toEqual([`/api/threads/t/messages?limit=${MESSAGE_PAGE_SIZE}&before=m299`]);
    expect(r.state.bots[0].messages).toHaveLength(MESSAGE_PAGE_SIZE + 1);
    expect(needsNewestPage(r.state.bots[0])).toBe(false);
  });

  it("leaves a short thread alone once it holds all of it", async () => {
    const r = rig(40, 1);
    await r.scrollback.loadOlder("t");
    expect(r.state.bots[0].messages).toHaveLength(40);
    expect(r.state.bots[0].hasMore).toBe(false);
    expect(needsNewestPage(r.state.bots[0])).toBe(false);
  });

  it("never tops up a desktop page, which is full whenever there is more", () => {
    expect(needsNewestPage({ messages: Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => ({ id: `m${i}` }) as Message), hasMore: true })).toBe(false);
    expect(needsNewestPage({ messages: [{ id: "m0" } as Message], hasMore: false })).toBe(false);
  });
});
