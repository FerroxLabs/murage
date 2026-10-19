import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, visibleMessages, type AppState, type Bot, type Group, type Message } from "@/state/store";
import { transcriptState } from "@/state/transcript-seq";
import { createFirstPageTopUp, createScrollback, DEEP_LINK_MAX_PAGES, firstPageRetryDelayMs, MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE, needsFirstPage, heardReplyAfter, unheardMessages, callStartHeard } from "./scrollback";

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

describe("loadThrough on a branch page", () => {
  // The branch is b0..b599 with a late-stored ancestor `late` spliced in between
  // b49 and b50: storage order puts it after the newest row, so paging by
  // `before` (storage order) never reaches it; the branch's parent links do.
  function branchRig() {
    const chain: Message[] = Array.from({ length: 600 }, (_, i) => ({ id: `b${i}`, at: i, role: "user", kind: "text", text: `#${i}`, parentId: i ? (i === 300 ? "late" : `b${i - 1}`) : null }) as never as Message);
    const late = { id: "late", at: 500, role: "user", kind: "text", text: "late", parentId: "b299" } as never as Message;
    const ancestry = [...chain.slice(0, 300), late, ...chain.slice(300)]; // root first
    const held = ancestry.slice(-30);
    const bot = { id: "bot", threadId: "t", messages: held, hasMore: true, olderFrom: ancestry[ancestry.length - 31]!.id, activeLeafId: "b599" } as never as Bot;
    let state: AppState = { ...initialState, bots: [bot] };
    const requests: string[] = [];
    const request = vi.fn(async (path: string) => {
      requests.push(path);
      const url = new URL(path, "http://x");
      const limit = Number(url.searchParams.get("limit"));
      const around = url.searchParams.get("around");
      if (around) return { messages: ancestry.filter((m) => m.id === around), hasMore: true };
      const from = url.searchParams.get("branchFrom");
      if (!from) throw new Error("storage-order paging cannot reach a late-stored ancestor");
      const end = ancestry.findIndex((m) => m.id === from) + 1;
      const start = Math.max(0, end - limit);
      return { messages: ancestry.slice(start, end), hasMore: start > 0, olderFrom: start > 0 ? ancestry[start - 1]!.id : null };
    });
    const scrollback = createScrollback({ getState: () => state, dispatch: (a) => { state = reducer(state, a); }, request, onError: vi.fn(), settle: () => Promise.resolve() });
    return { scrollback, requests, get state() { return state; } };
  }

  it("R3: a jump to a late-stored spliced ancestor follows the branch cursor and keeps it correct", async () => {
    const r = branchRig();
    await expect(r.scrollback.loadThrough("t", "late")).resolves.toBe("fetched");
    expect(r.requests.slice(1).every((path) => path.includes("branchFrom="))).toBe(true);
    const bot = r.state.bots[0]!;
    expect(bot.messages.some((m) => m.id === "late")).toBe(true);
    // the cursor moved on with the page: further paging continues from the oldest held ancestor
    expect(bot.hasMore).toBe(true);
    expect(bot.olderFrom).toBeTruthy();
    expect(bot.messages.some((m) => m.id === bot.olderFrom)).toBe(false);
    expect(r.state.loadingOlder).toEqual({});
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

describe("boot without rows (view=sidebar, desktop and phone alike)", () => {
  it("a conversation needs its first page while unloaded or stale, and not while one is on the wire", () => {
    expect(needsFirstPage({ messagesUnloaded: true })).toBe(true);
    expect(needsFirstPage({ pageStale: true })).toBe(true);
    expect(needsFirstPage({ messagesUnloaded: true, firstPageEvents: [] })).toBe(false);
    expect(needsFirstPage({})).toBe(false);
  });

  it("tops up a slim thread to a full page with one ordinary scrollback request", async () => {
    const r = rig(300, 1);
    await r.scrollback.loadOlder("t");
    expect(r.requests).toEqual([`/api/threads/t/messages?limit=${MESSAGE_PAGE_SIZE}&before=m299`]);
    expect(r.state.bots[0].messages).toHaveLength(MESSAGE_PAGE_SIZE + 1);
  });

  it("leaves a short thread alone once it holds all of it", async () => {
    const r = rig(40, 1);
    await r.scrollback.loadOlder("t");
    expect(r.state.bots[0].messages).toHaveLength(40);
    expect(r.state.bots[0].hasMore).toBe(false);
  });

  // The store asks once per (thread, transcript generation).
  it("fetches the page on a re-attempt after a resync dropped the first as stale", async () => {
    const r = rig(300, 1);
    const pending = r.scrollback.loadOlder("t");
    r.state = { ...r.state, transcriptGeneration: { t: 1 } };
    await pending;
    expect(r.state.bots[0].messages).toHaveLength(1);
    expect(r.state.loadingOlder).toEqual({});
    await r.scrollback.loadOlder("t");
    expect(r.requests).toHaveLength(2);
    expect(r.state.bots[0].messages).toHaveLength(MESSAGE_PAGE_SIZE + 1);
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

// r6 Q4: a numbered room whose transcript has a gap (a windowed page landed over a row held in front of it) pages the gap first, by number.
describe("loadOlder and loadThrough fill a gap before they continue past it (ROOM-ORDER-DESIGN r6 Q4)", () => {
  function gapRig() {
    const all: Message[] = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, at: 0, role: "user", kind: "text", text: `#${i + 1}`, seq: i + 1 }));
    // held: m1 and the newest window m10..m12, the tail known; m2..m9 sit in the gap before m10
    const group = { id: "room", threadId: "t", memberIds: ["x"], messages: [all[0]!, ...all.slice(9)], numbered: true, tail: 12 } as never as Group;
    let state: AppState = { ...initialState, groups: [group] };
    const requests: string[] = [];
    const request = vi.fn(async (path: string) => {
      requests.push(path);
      const url = new URL(path, "http://x");
      const limit = Number(url.searchParams.get("limit"));
      const around = url.searchParams.get("around");
      if (around) return { messages: all.filter((m) => m.id === around), hasMore: true, newestSeq: 12 };
      const end = all.findIndex((m) => m.id === url.searchParams.get("before"));
      const start = Math.max(0, end - limit);
      return { messages: all.slice(start, end), hasMore: start > 0, newestSeq: 12 };
    });
    const scrollback = createScrollback({ getState: () => state, dispatch: (a) => { state = reducer(state, a); }, request, onError: vi.fn(), settle: () => Promise.resolve() });
    return { scrollback, requests, all, get state() { return state; } };
  }
  const ids = (r: { state: AppState }) => r.state.groups[0]!.messages.map((m) => m.id);

  it("loadOlder asks for the page before the held row just above the gap, holds it by number, and the room is complete", async () => {
    const r = gapRig();
    await r.scrollback.loadOlder("t");
    expect(r.requests).toEqual([`/api/threads/t/messages?limit=${MESSAGE_PAGE_SIZE}&before=m10`]);
    expect(ids(r)).toEqual(r.all.map((m) => m.id));
    expect(transcriptState(r.state.groups[0]!)).toBe("complete");
    expect(r.state.loadingOlder).toEqual({});
    // nothing left to page: the flag clears without a request
    await r.scrollback.loadOlder("t");
    expect(r.requests).toHaveLength(1);
  });

  it("loadThrough walks the gap to a message inside it", async () => {
    const r = gapRig();
    await expect(r.scrollback.loadThrough("t", "m4")).resolves.toBe("fetched");
    expect(r.requests[1]).toBe(`/api/threads/t/messages?limit=${MESSAGE_PAGE_MAX}&before=m10`);
    expect(ids(r)).toEqual(r.all.map((m) => m.id));
    expect(r.state.loadingOlder).toEqual({});
  });

  it("a room whose next page is the newest one asks it through the first-page path", () => {
    const r = gapRig();
    const room = { ...r.state.groups[0]!, tail: undefined };
    expect(needsFirstPage(room)).toBe(true);
    expect(needsFirstPage({ ...room, firstPageEvents: [] })).toBe(false);
  });
});

describe("the first-page top-up asks again after a failed page, with a growing wait (r5)", () => {
  function plan() {
    const asked: string[] = [];
    const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
    const topUp = createFirstPageTopUp({
      ask: (threadId) => asked.push(threadId),
      later: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    });
    const wake = vi.fn();
    return { topUp, asked, timers, wake };
  }

  it("asks once per thread and generation, waits 1 s, 2 s, 4 s ... 30 s after each failure, and asks again when the wait is over", () => {
    const p = plan();
    p.topUp.review("t", 0, false, p.wake);
    expect(p.asked).toEqual(["t"]);
    // the page is on the wire: nothing
    p.topUp.review("t", 0, true, p.wake);
    expect(p.asked).toEqual(["t"]);
    // it came back failed (still needs its page, nothing on the wire): a retry is scheduled, not sent
    p.topUp.review("t", 0, false, p.wake);
    expect(p.asked).toEqual(["t"]);
    expect(p.timers.map((t) => t.ms)).toEqual([1000]);
    // reviews meanwhile schedule nothing more
    p.topUp.review("t", 0, false, p.wake);
    expect(p.timers).toHaveLength(1);
    p.timers[0]!.run();
    expect(p.wake).toHaveBeenCalledTimes(1);
    p.topUp.review("t", 0, false, p.wake);
    expect(p.asked).toEqual(["t", "t"]);
    const waits: number[] = [];
    for (let failure = 0; failure < 7; failure++) {
      p.topUp.review("t", 0, true, p.wake);
      p.topUp.review("t", 0, false, p.wake);
      const timer = p.timers[p.timers.length - 1]!;
      waits.push(timer.ms);
      timer.run();
      p.topUp.review("t", 0, false, p.wake);
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(p.asked).toHaveLength(9);
    expect(firstPageRetryDelayMs(1)).toBe(1000);
    expect(firstPageRetryDelayMs(9)).toBe(30000);
  });

  it("a thread switch or the window coming back (forget) drops the wait and asks at once; a page that landed forgets the failures", () => {
    const p = plan();
    p.topUp.review("t", 0, false, p.wake);
    p.topUp.review("t", 0, false, p.wake);
    expect(p.timers).toHaveLength(1);
    p.topUp.forget();
    expect(p.timers[0]!.cancelled).toBe(true);
    p.topUp.review("t", 0, false, p.wake);
    expect(p.asked).toEqual(["t", "t"]);
    // a new transcript generation is a new question
    p.topUp.review("t", 1, false, p.wake);
    expect(p.asked).toEqual(["t", "t", "t"]);
    // loaded: nothing needs a page; the next time it does, the wait starts over at 1 s
    p.topUp.review(null, 0, false, p.wake);
    p.topUp.review("t", 2, false, p.wake);
    p.topUp.review("t", 2, false, p.wake);
    expect(p.timers[p.timers.length - 1]!.ms).toBe(1000);
  });
});
