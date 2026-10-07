import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, visibleMessages, type AppState, type Bot, type Message } from "@/state/store";
import { createScrollback, DEEP_LINK_MAX_PAGES, hydratePageSize, MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE, needsNewestPage, PHONE_HYDRATE_PAGE, heardReplyAfter, unheardMessages, callStartHeard } from "./scrollback";

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

  it("gives up after the pages a deep link allows, and lands on the thread", async () => {
    const r = rig(3000, 100);
    await expect(r.scrollback.loadThrough("t", "m12", DEEP_LINK_MAX_PAGES)).resolves.toBe("missing");
    // the one-row probe, then at most DEEP_LINK_MAX_PAGES pages
    expect(r.requests.filter((path) => path.includes("before="))).toHaveLength(DEEP_LINK_MAX_PAGES);
    expect(r.state.loadingOlder).toEqual({});
  });

  it("still finds a linked message inside that reach, stopping where the thread begins", async () => {
    const r = rig(800, 100);
    await expect(r.scrollback.loadThrough("t", "m12", DEEP_LINK_MAX_PAGES)).resolves.toBe("fetched");
    // 700 older messages: four pages, the last of which says hasMore false
    expect(r.requests.filter((path) => path.includes("before="))).toHaveLength(4);
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
  it("reads text saved in front of a tool row the call already heard", () => {
    // visibleMessages after Store.insertMessageBefore: ask → lead → row
    expect(unheardMessages([m("ask"), m("lead"), m("row")], new Set(["ask", "row"]))).toEqual([m("lead")]);
    // and a page prepended in the same render is still history
    expect(unheardMessages([m("old"), m("ask"), m("lead"), m("row")], new Set(["ask", "row"]))).toEqual([m("lead")]);
  });
});

describe("unheardMessages before the oldest heard row", () => {
  const m = (id: string) => ({ id });
  it("reads text saved in front of the only row a phone's boot page held", () => {
    // the call started holding just the tool row; the lead-in arrived live
    // and the transcript reads it first
    expect(unheardMessages([m("lead"), m("row")], new Set(["row"]), [m("row"), m("lead")])).toEqual([m("lead")]);
  });
  it("still treats a page prepended mid-call as history, with a live insert behind it", () => {
    const transcript = [m("old1"), m("old2"), m("lead"), m("row")];
    expect(unheardMessages(transcript, new Set(["row"]), [m("old1"), m("old2"), m("row"), m("lead")])).toEqual([m("lead")]);
    // a lead-in saved before the call, loaded with that page, is history
    expect(unheardMessages(transcript, new Set(["row"]), [m("old1"), m("old2"), m("lead"), m("row")])).toEqual([]);
  });
  it("says it only when no later reply was heard", () => {
    const isReply = (message: { id: string }) => message.id !== "row";
    const transcript = [m("lead"), m("row"), m("answer")];
    expect(heardReplyAfter(transcript, new Set(["row"]), transcript[0]!, isReply)).toBe(false);
    expect(heardReplyAfter(transcript, new Set(["row", "answer"]), transcript[0]!, isReply)).toBe(true);
  });
  it("a call on a phone boot page hears the lead-in the server saves in front of its row", () => {
    const msg = (id: string, parentId: string | null, extra: Partial<Message> = {}) => ({ id, at: 1, role: "bot", kind: "text", text: id, parentId, ...extra }) as Message;
    const row = msg("row", "ask", { kind: "activity", text: undefined });
    const bot = { id: "bot", threadId: "t", messages: [row], activeLeafId: "row", hasMore: true } as never as Bot;
    let state: AppState = { ...initialState, bots: [bot] };
    const heard = new Set(visibleMessages(state.bots[0]!).map((message) => message.id)); // as CallView seeds spokenIds
    // Store.insertMessageBefore: the new row, then the moved row
    state = reducer(state, { type: "messageAdded", threadId: "t", message: msg("lead", "ask", { insertedBefore: "row" }) });
    state = reducer(state, { type: "messagePatched", threadId: "t", message: { ...row, parentId: "lead" } });
    const held = state.bots[0]!;
    expect(visibleMessages(held).map((message) => message.id)).toEqual(["lead", "row"]);
    expect(unheardMessages(visibleMessages(held), heard, held.messages).map((message) => message.id)).toEqual(["lead"]);
    const source = readFileSync(fileURLToPath(new URL("../components/CallView.tsx", import.meta.url)), "utf8");
    expect(source).toContain("unheardMessages(messages, spokenIds.current, bot.messages)");
  });
});

describe("callStartHeard", () => {
  const m = (id: string) => ({ id });
  it("a lead-in held but off screen at call start is history when its older page loads mid-call", () => {
    // held [T3,T4,T5,L]: L was saved before the call, in front of unloaded T1,
    // so the transcript on screen is only T3..T5
    const heard = callStartHeard([m("T3"), m("T4"), m("T5")], [m("T3"), m("T4"), m("T5"), m("L")]);
    // the older page is prepended; L now joins the transcript ahead of T1
    const arrival = [m("ask"), m("T1"), m("T2"), m("T3"), m("T4"), m("T5"), m("L")];
    const transcript = [m("ask"), m("L"), m("T1"), m("T2"), m("T3"), m("T4"), m("T5")];
    expect(unheardMessages(transcript, heard, arrival)).toEqual([]);
    // a lead-in that arrives live during the call is still news
    expect(unheardMessages([m("ask"), m("L2"), ...transcript.slice(1)], heard, [...arrival, m("L2")])).toEqual([m("L2")]);
    const source = readFileSync(fileURLToPath(new URL("../components/CallView.tsx", import.meta.url)), "utf8");
    expect(source).toContain("spokenIds.current = callStartHeard(messages, bot.messages)");
  });
});

describe("heardReplyAfter", () => {
  const msg = (id: string, reply = false) => ({ id, reply });
  const isReply = (message: { reply: boolean }) => message.reply;
  const transcript = [msg("ask"), msg("lead", true), msg("row"), msg("answer", true)];
  it("holds back a lead-in when the answer after it was already said", () => {
    expect(heardReplyAfter(transcript, new Set(["ask", "row", "answer"]), transcript[1]!, isReply)).toBe(true);
  });
  it("lets a lead-in through when it is the only reply", () => {
    expect(heardReplyAfter(transcript.slice(0, 3), new Set(["ask", "row"]), transcript[1]!, isReply)).toBe(false);
    // an unheard answer in the same burst is chosen as the newest reply instead
    expect(heardReplyAfter(transcript, new Set(["ask", "row"]), transcript[1]!, isReply)).toBe(false);
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

  // The store asks once per (thread, transcript generation).
  it("fetches the page on a re-attempt after a resync dropped the first as stale", async () => {
    const r = rig(300, 1);
    const pending = r.scrollback.loadOlder("t");
    r.state = { ...r.state, transcriptGeneration: { t: 1 } };
    await pending;
    expect(r.state.bots[0].messages).toHaveLength(1);
    expect(r.state.loadingOlder).toEqual({});
    expect(needsNewestPage(r.state.bots[0])).toBe(true);
    await r.scrollback.loadOlder("t");
    expect(r.requests).toHaveLength(2);
    expect(r.state.bots[0].messages).toHaveLength(MESSAGE_PAGE_SIZE + 1);
    expect(needsNewestPage(r.state.bots[0])).toBe(false);
  });

  it("leaves the generation alone on a hard failure, so the store does not ask again", async () => {
    const r = rig(300, 1);
    r.request.mockRejectedValueOnce(new Error("offline"));
    await r.scrollback.loadOlder("t");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.onError).toHaveBeenCalledTimes(1);
    expect(r.state.loadingOlder).toEqual({});
    expect(r.state.transcriptGeneration.t ?? 0).toBe(0);
    expect(r.state.bots[0].messages).toHaveLength(1);
  });

  it("never tops up a desktop page, which is full whenever there is more", () => {
    expect(needsNewestPage({ messages: Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => ({ id: `m${i}` }) as Message), hasMore: true })).toBe(false);
    expect(needsNewestPage({ messages: [{ id: "m0" } as Message], hasMore: false })).toBe(false);
  });
});

describe("loadOlder while a jump holds the thread", () => {
  it("clears the loading flag instead of leaving \"Load earlier\" disabled", async () => {
    const r = rig(300, 100);
    const jump = r.scrollback.loadThrough("t", "m50");
    // until the jump's probe is on the wire and holds the thread
    for (let tick = 0; tick < 20 && r.requests.length === 0; tick++) await Promise.resolve();
    expect(r.requests).toEqual(["/api/threads/t/messages?around=m50&limit=1"]);
    // the store's wrapped dispatch sets the flag before asking scrollback
    r.state = reducer(r.state, { type: "loadOlderMessages", threadId: "t" });
    expect(r.scrollback.loadOlder("t")).toBeUndefined();
    expect(r.state.loadingOlder).toEqual({});
    expect(r.state.bots[0].hasMore).toBe(true);
    await jump;
  });

  it("leaves its own page's flag for that page to clear", async () => {
    const r = rig(300, 100);
    const pending = r.scrollback.loadOlder("t");
    expect(r.scrollback.loadOlder("t")).toBeUndefined();
    expect(r.state.loadingOlder).toEqual({ t: true });
    await pending;
    expect(r.state.loadingOlder).toEqual({});
  });
});
