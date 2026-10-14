// Lane E (1.0.2 scale): an old unanswered card rides beside the page, and bot
// frames carry only the task rows that changed. Each block starts from the
// failure the lane E review (ui-review/REPORT.md) reproduced.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openQuestions, pendingApprovals } from "@/components/PendingApproval";
import { createScrollback } from "@/lib/scrollback";
import {
  branchHeadMissing,
  cardsFetchNeeded,
  initialState,
  olderOpenCards,
  readyRevOf,
  reducer,
  visibleMessages,
  withTaskDelta,
  type AppState,
  type Bot,
  type Message,
  type Task,
} from "./store";

// m4 is older than the page: m5's parent is not held, as on a real page.
const message = (id: string, at: number, parentId: string | null = `m${at - 1}`) => ({ id, at, role: "user", kind: "text", text: id, parentId }) as never as Message;
const card = (id: string, at: number, extra: object = {}) =>
  ({ id, at, role: "bot", kind: "options", parentId: null, card: { title: id, options: [], requestId: `r-${id}`, tool: "Bash", ...extra } }) as never as Message;
const bot = (extra: object = {}) => ({ id: "b", threadId: "t", messages: [], tasks: [], ...extra }) as never as Bot;
const switched = (extra: object): AppState =>
  reducer({ ...initialState, bots: [bot()] }, { type: "taskSwitched", bot: bot({ activeLeafId: "m6", hasMore: true, ...extra }) });
const approvalsOf = (b: Bot) => pendingApprovals(olderOpenCards(b, visibleMessages(b))).map((p) => p.message.id);

describe("old open cards beside the page", () => {
  it("P1: the composer still counts a card separated from the page by unloaded rows", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)] });
    const held = state.bots[0]!;
    // the card is not folded into the transcript the branch walk reads
    expect(held.messages.map((m) => m.id)).toEqual(["m5", "m6"]);
    expect(visibleMessages(held).map((m) => m.id)).toEqual(["m5", "m6"]);
    expect(approvalsOf(held)).toEqual(["c1"]);
  });

  it("a branch whose root is held (an edit inside the page) does not pass through the older cards", () => {
    const state = switched({ messages: [message("m5", 5, null), message("m6", 6)], openCards: [card("c1", 1)] });
    expect(approvalsOf(state.bots[0]!)).toEqual([]);
  });

  it("P1: a selected head older than the page shows nothing and is fetched, never another fork's rows", () => {
    const state = switched({ messages: [message("f1", 1, "x"), message("f2", 2, "f1")], activeLeafId: "a9" });
    const held = state.bots[0]!;
    expect(visibleMessages(held)).toEqual([]);
    expect(branchHeadMissing(held)).toBe(true);
    // a whole thread held (no more to fetch) still falls back to the flat list
    expect(visibleMessages({ ...held, hasMore: false })).toHaveLength(2);
  });

  it("P2: another window's switch frame leaves this window's cards and scrollback anchor alone", async () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)], tasks: [{ threadId: "t" }, { threadId: "u" }] });
    // window B switched this bot to thread u; its frame carries u's page and cards
    const next = reducer(state, {
      type: "botPatched",
      bot: bot({ threadId: "u", tasks: [{ threadId: "t" }, { threadId: "u" }], messages: [message("u1", 50, null)], openCards: [card("cu", 40)], hasMore: true }),
    });
    const held = next.bots[0]!;
    expect(held.threadId).toBe("t");
    expect(held.messages.map((m) => m.id)).toEqual(["m5", "m6"]);
    expect(held.openCards?.map((m) => m.id)).toEqual(["c1"]);
    const asked: string[] = [];
    const scrollback = createScrollback({
      getState: () => next,
      dispatch: () => {},
      request: async (path) => { asked.push(path); return { messages: [], hasMore: false }; },
      onError: () => {},
      settle: async () => {},
    });
    await scrollback.loadOlder("t");
    expect(asked[0]).toContain("before=m5");
  });

  it("P2: a stale older page does not resurrect a card answered while it was on the wire", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c4", 4)] });
    const generation = state.transcriptGeneration["t"] ?? 0;
    // the server's patch: answered from the phone while the page request is out
    const answered = reducer(state, { type: "messagePatched", threadId: "t", message: card("c4", 4, { answered: "allow" }) });
    expect(approvalsOf(answered.bots[0]!)).toEqual([]);
    // the page answers with the card as it stood when the page was read
    const paged = reducer(answered, { type: "olderMessages", threadId: "t", generation, messages: [message("m3", 3), card("c4", 4)], hasMore: true });
    const held = paged.bots[0]!;
    expect(held.messages.map((m) => m.id)).toEqual(["m3", "c4", "m5", "m6"]);
    expect(held.messages[1]!.card?.answered).toBe("allow");
    expect(held.openCards).toBeUndefined();
    expect(approvalsOf(held)).toEqual([]);
  });

  it("a card answered here is answered beside the page too", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)] });
    const next = reducer(state, { type: "answerCard", botId: "b", messageId: "c1", answer: "allow" });
    expect(next.bots[0]!.openCards?.[0]!.card?.answered).toBe("allow");
    expect(approvalsOf(next.bots[0]!)).toEqual([]);
  });
});

describe("bot frames with changed tasks only", () => {
  const task = (threadId: string, busy = false) => ({ threadId, title: threadId, busy }) as never as Task;
  const held = (seq = 1): AppState => ({ ...initialState, bots: [bot({ tasks: [task("t1"), task("t2"), task("t3")], tasksSeq: seq })] });
  const delta = (upsert: Task[], base: number, count = 3) => ({ type: "botPatched", bot: { id: "b", tasksSeq: base + 1, tasksDelta: { upsert, count, base } } }) as never;
  const rows = (state: AppState) => state.bots[0]!.tasks?.map((t) => `${t.threadId}:${t.busy}`);

  it("P2: two deltas drained in one batch both land (each laid over the rows the reducer holds)", () => {
    const first = reducer(held(), delta([task("t1", true)], 1));
    const both = reducer(first, delta([task("t2", true)], 2));
    expect(rows(both)).toEqual(["t1:true", "t2:true", "t3:false"]);
    expect(both.bots[0]!.tasksSeq).toBe(3);
  });

  it("a delta that does not build on the held list keeps it and marks it for a refetch; a whole list clears that", () => {
    const skipped = reducer(held(), delta([task("t2", true)], 5));
    expect(rows(skipped)).toEqual(["t1:false", "t2:false", "t3:false"]);
    expect(skipped.bots[0]!.tasksStale).toBe(true);
    expect(skipped.bots[0]!.tasksSeq).toBe(1);
    expect(reducer(held(), delta([task("t2", true)], 1, 4)).bots[0]!.tasksStale).toBe(true);
    const repaired = reducer(skipped, { type: "botPatched", bot: { id: "b", tasks: [task("t1"), task("t2", true), task("t3")], tasksSeq: 6 } as never });
    expect(repaired.bots[0]!.tasksStale).toBe(false);
    expect(rows(repaired)).toEqual(["t1:false", "t2:true", "t3:false"]);
  });

  it("the row being read is cleared as the delta lands", () => {
    const unread = { ...task("t2"), unread: true } as Task;
    const next = withTaskDelta({ id: "b", tasksDelta: { upsert: [unread], count: 3, base: 1, read: "t2" } } as never, { tasks: [task("t1"), task("t2"), task("t3")], tasksSeq: 1 });
    expect(next.tasks?.find((t) => t.threadId === "t2")?.unread).toBe(false);
    expect(next.unread).toBe(false);
    expect("tasksDelta" in next).toBe(false);
  });
});

// Round 2 (ui-review-r2/REPORT.md).

describe("round 2: every kind of held request, and only on the branch it belongs to", () => {
  const question = (id: string, at: number) => ({ id, at, role: "bot", kind: "options", parentId: null, card: { title: id, options: [], requestId: `r-${id}`, questions: [{ question: "Which?", options: [] }] } }) as never as Message;
  const publish = (id: string, at: number) => ({ id, at, role: "bot", kind: "options", parentId: null, card: { title: id, kind: "publish", options: [], requestId: `r-${id}` } }) as never as Message;

  it("P1: a held question and a held publish card are rows of the transcript, and a call asks the question", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [question("q1", 1), publish("p1", 2)] });
    const held = state.bots[0]!;
    const rows = olderOpenCards(held, visibleMessages(held));
    // what the chat renders: both cards, in front of the page
    expect(rows.map((m) => m.id)).toEqual(["q1", "p1", "m5", "m6"]);
    // what a call asks aloud: the question, held or not
    expect(openQuestions(rows).map((m) => m.id)).toContain("q1");
  });

  it("P2: cards belong to the branch head they were worked out for; a sibling branch does not show them", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)], openCardsLeaf: "m6" });
    const held = state.bots[0]!;
    expect(approvalsOf(held)).toEqual(["c1"]);
    // the branch grows past the head the cards were worked out for: still theirs
    const grown = { ...held, messages: [...held.messages, message("m7", 7)], activeLeafId: "m7" };
    expect(approvalsOf(grown)).toEqual(["c1"]);
    // the owner edits m6: a sibling branch that does not pass through m6
    const sibling = reducer(state, { type: "messageAdded", threadId: "t", message: message("m6b", 8, "m5") });
    const forked = reducer(sibling, { type: "threadActive", threadId: "t", activeLeafId: "m6b" }).bots[0]!;
    expect(visibleMessages(forked).map((m) => m.id)).toEqual(["m5", "m6b"]);
    expect(approvalsOf(forked)).toEqual([]);
    // and the cards the server then sends for that branch are bound to it
    const refreshed = reducer(reducer(sibling, { type: "threadActive", threadId: "t", activeLeafId: "m6b" }), { type: "openCardsRefreshed", threadId: "t", leafId: "m6b", cards: [card("c2", 2)], rev: 0 }).bots[0]!;
    expect(approvalsOf(refreshed)).toEqual(["c2"]);
    // an answer for a branch the person has since left is dropped
    expect(reducer(state, { type: "openCardsRefreshed", threadId: "t", leafId: "m5", cards: [card("c3", 3)], rev: 0 }).bots[0]!.openCards?.map((m) => m.id)).toEqual(["c1"]);
  });

  it("R3: an older card refresh never replaces a newer patch of the same card (a denial)", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)], openCardsLeaf: "m6" });
    const held = state.bots[0]!;
    // the refresh was asked for at this revision
    const asked = held.cardsRev ?? 0;
    // a denial arrives over SSE while the REST answer is on the wire
    const denied = reducer(state, { type: "messagePatched", threadId: "t", message: card("c1", 1, { answered: "deny" }) });
    expect(approvalsOf(denied.bots[0]!)).toEqual([]);
    // the older response still lists the card as unanswered: it must be dropped
    const late = reducer(denied, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [card("c1", 1)], rev: asked });
    expect(approvalsOf(late.bots[0]!)).toEqual([]);
    expect(late.bots[0]!.openCards?.[0]?.card?.answered).toBe("deny");
    // an optimistic answer on the client fences it the same way
    const answering = reducer(state, { type: "answerCard", botId: "b", messageId: "c1", answer: "allow" } as never);
    const lateAgain = reducer(answering, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [card("c1", 1)], rev: asked });
    expect(approvalsOf(lateAgain.bots[0]!)).toEqual([]);
    // a refresh asked for at the current revision still lands
    const fresh = reducer(denied, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [card("c9", 2)], rev: denied.bots[0]!.cardsRev ?? 0 });
    expect(fresh.bots[0]!.openCards?.map((m) => m.id)).toEqual(["c9"]);
  });

  it("P2: a task list fetched to repair a delta is not laid over a newer frame of the same server run", () => {
    const task = (threadId: string) => ({ threadId, title: threadId }) as never as Task;
    const seven = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map(task);
    const eight = [...seven, task("t8")];
    // the full frame 9 has 8 tasks; a snapshot read at frame 7 (7 tasks) lands afterwards
    const live: AppState = { ...initialState, bots: [bot({ tasks: eight, tasksSeq: 9, tasksEpoch: "run-a", tasksStale: true })] };
    const stale = reducer(live, { type: "tasksResynced", botId: "b", tasks: seven, tasksSeq: 7, tasksEpoch: "run-a" });
    expect(stale.bots[0]!.tasks).toHaveLength(8);
    // a snapshot at least as new lands, and clears the stale flag
    const fresh = reducer(live, { type: "tasksResynced", botId: "b", tasks: eight, tasksSeq: 9, tasksEpoch: "run-a" });
    expect(fresh.bots[0]!.tasksStale).toBe(false);
    // numbers from another run of the server are not comparable: the snapshot is the newer truth
    const restarted = reducer(live, { type: "tasksResynced", botId: "b", tasks: seven, tasksSeq: 2, tasksEpoch: "run-b" });
    expect(restarted.bots[0]!.tasks).toHaveLength(7);
  });

  it("P2: a branch page is paged back by the cursor the server gave, and the cursor moves with each page", async () => {
    const requests: string[] = [];
    let state: AppState = { ...initialState, bots: [bot({ messages: [message("m5", 5), message("m6", 6)], activeLeafId: "m6", hasMore: true, olderFrom: "m2" })] };
    const scrollback = createScrollback({
      getState: () => state,
      dispatch: (action) => { state = reducer(state, action as never); },
      request: async (path) => { requests.push(path); return { messages: [message("m3", 3), message("m4", 4)], hasMore: true, olderFrom: "m1" }; },
      onError: () => { throw new Error("unexpected"); },
    });
    await scrollback.loadOlder("t");
    expect(requests).toEqual(["/api/threads/t/messages?limit=100&branchFrom=m2"]);
    expect(state.bots[0]!.olderFrom).toBe("m1");
    expect(state.bots[0]!.messages.map((m) => m.id)).toEqual(["m3", "m4", "m5", "m6"]);
  });
});

describe("open cards while the server is still preparing the thread", () => {
  it("a pending answer never clears the cards held, only adds to them", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)], openCardsLeaf: "m6" });
    const rev = state.bots[0]!.cardsRev ?? 0;
    const empty = reducer(state, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [], rev, pending: true }).bots[0]!;
    expect(empty.openCards?.map((m) => m.id)).toEqual(["c1"]);
    expect(empty.openCardsPending).toBe(true);
    const more = reducer(state, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [card("c2", 2)], rev, pending: true }).bots[0]!;
    expect(more.openCards?.map((m) => m.id)).toEqual(["c1", "c2"]);
  });

  it("the exact answer replaces the list and clears pending", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCards: [card("c1", 1)], openCardsLeaf: "m6", openCardsPending: true });
    expect(state.bots[0]!.openCardsPending).toBe(true);
    const rev = state.bots[0]!.cardsRev ?? 0;
    const exact = reducer(state, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [card("c2", 2)], rev }).bots[0]!;
    expect(exact.openCards?.map((m) => m.id)).toEqual(["c2"]);
    expect(exact.openCardsPending).toBeUndefined();
    const none = reducer(state, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [], rev }).bots[0]!;
    expect(none.openCards).toBeUndefined();
  });

  it("an open-cards.ready frame is kept for that conversation only, whether or not it is on screen", () => {
    const state = switched({ messages: [message("m5", 5), message("m6", 6)], openCardsPending: true });
    const ready = reducer(state, { type: "openCardsReady", threadId: "t" });
    expect(readyRevOf(ready, "t")).toBe(1);
    expect(readyRevOf(reducer(ready, { type: "openCardsReady", threadId: "t" }), "t")).toBe(2);
    const other = reducer(state, { type: "openCardsReady", threadId: "other" });
    expect(readyRevOf(other, "t")).toBe(0);
    expect(readyRevOf(other, "other")).toBe(1); // kept although no conversation holds it yet
  });

  it("the global completion frame (threadId null) counts for every conversation, and only a conversation still waiting asks again", () => {
    const waiting = switched({ messages: [message("m5", 5), message("m6", 6)], openCardsPending: true });
    const all = reducer(waiting, { type: "openCardsReady", threadId: null });
    expect(cardsFetchNeeded(all, all.bots[0])).toBe(true);
    const settled = switched({ messages: [message("m5", 5), message("m6", 6)] });
    expect(cardsFetchNeeded(reducer(settled, { type: "openCardsReady", threadId: null }), settled.bots[0])).toBe(false);
  });

  it("fulfilment is set by the reducer alone and a failed readiness fetch is retried with backoff (wiring)", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("fulfilledReady");
    expect(source).toContain("cardsFetchNeeded(state, readyOwner)");
    // one request per thread, transcript generation, leaf, readiness revision, card revision and retry
    expect(source).toContain("`${readyThread}:${readyGeneration}:${readyLeaf}:${readyRev}:${readyCardsRev}`");
    expect(source).toContain("`${base}:${readyRetry}`");
    // (r8, Fable r7 #10) each new question (thread, generation, head, revision) starts its own count of the eight retries
    expect(source).toContain("if (readyBase.current !== base) { readyBase.current = base; readyFailures.current = 0; }");
    expect(source).toContain("readyRev, gen: readyGeneration");
    expect(source).toMatch(/2 \*\* \(attempt - 1\)/);
    expect(source).toMatch(/frame\.threadId === null[\s\S]{0,120}openCardsReady", threadId: null/);
  });

  it("r6-5: a response for the leaf the client has since left is discarded and fulfils nothing; the response for the new leaf is accepted once and clears pending", () => {
    const base = switched({ messages: [message("m5", 5), message("m6", 6)], openCardsPending: true });
    const asked = reducer(base, { type: "openCardsReady", threadId: "t" });
    const rev = base.bots[0]!.cardsRev ?? 0;
    // the request for leaf m6 is on the wire; a normal message moves the conversation to m7 (cardsRev does not move)
    const moved = reducer(asked, { type: "threadActive", threadId: "t", activeLeafId: "m7" });
    expect(moved.bots[0]!.cardsRev ?? 0).toBe(rev);
    const old = reducer(moved, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [], rev, pending: false, readyRev: 1, gen: 0, requestLeaf: "m6" }).bots[0]!;
    expect(cardsFetchNeeded(reducer(moved, { type: "openCardsRefreshed", threadId: "t", leafId: "m6", cards: [], rev, pending: false, readyRev: 1, gen: 0, requestLeaf: "m6" }), old)).toBe(true);
    expect(old.openCardsPending).toBe(true);
    const acceptedState = reducer(moved, { type: "openCardsRefreshed", threadId: "t", leafId: "m7", cards: [], rev, pending: false, readyRev: 1, gen: moved.transcriptGeneration.t ?? 0, requestLeaf: "m7" });
    const current = acceptedState.bots[0]!;
    expect(acceptedState.cardsFulfilled.t?.rev).toBe(1);
    expect(current.openCardsPending).toBeUndefined();
    // a response from an earlier transcript generation is discarded too
    const regenerated = { ...moved, transcriptGeneration: { ...moved.transcriptGeneration, t: (moved.transcriptGeneration.t ?? 0) + 3 } };
    expect(reducer(regenerated, { type: "openCardsRefreshed", threadId: "t", leafId: "m7", cards: [], rev, readyRev: 1, gen: (moved.transcriptGeneration.t ?? 0) + 2, requestLeaf: "m7" }).cardsFulfilled.t).toBeUndefined();
    // and one that does not carry the readiness revision never fulfils
    expect(reducer(moved, { type: "openCardsRefreshed", threadId: "t", leafId: "m7", cards: [], rev }).cardsFulfilled.t).toBeUndefined();
  });

  it("the store refetches /open-cards on the ready frame (wiring)", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(source).toContain('case "open-cards.ready"');
    expect(source).toMatch(/readyRevOf[\s\S]{0,4000}\/open-cards/);
  });
});

describe("r7: readiness is scoped to the conversation and its transcript generation, for tasks and rooms", () => {
  const room = (extra: object = {}) => ({ id: "g", name: "room", threadId: "room-t", memberIds: [], messages: [message("r5", 5), message("r6", 6)], tasks: [], ...extra }) as never as AppState["groups"][number];
  it("P2-2 delayed task snapshot: task B's notice that lands before B's partial snapshot is kept, and the previous task's fulfilment does not stand in for it", () => {
    // task A: notice 1 asked for and fulfilled
    let state = reducer({ ...initialState, bots: [bot({ threadId: "taskA", activeLeafId: "a2", messages: [message("a2", 2)], openCardsPending: true })] }, { type: "openCardsReady", threadId: "taskA" });
    const a = state.bots[0]!;
    state = reducer(state, { type: "openCardsRefreshed", threadId: "taskA", leafId: "a2", cards: [], rev: a.cardsRev ?? 0, readyRev: 1, gen: state.transcriptGeneration.taskA ?? 0, requestLeaf: "a2" });
    expect(state.cardsFulfilled.taskA?.rev).toBe(1);
    // switching to B: B's notice arrives first (the held thread is still A), then B's earlier, partial snapshot
    state = reducer(state, { type: "openCardsReady", threadId: "taskB" });
    expect(readyRevOf(state, "taskB")).toBe(1);
    state = reducer(state, { type: "taskSwitched", bot: bot({ threadId: "taskB", activeLeafId: "b2", hasMore: true, messages: [message("b2", 2)], openCardsPending: true }) });
    const b = state.bots[0]!;
    expect(b.threadId).toBe("taskB");
    expect(b.openCardsPending).toBe(true);
    // the old code read A's 1/1 here and asked for nothing
    expect(cardsFetchNeeded(state, b)).toBe(true);
    // the answer is accepted once, fulfils B, and pending clears
    const done = reducer(state, { type: "openCardsRefreshed", threadId: "taskB", leafId: "b2", cards: [card("c1", 1)], rev: b.cardsRev ?? 0, readyRev: 1, gen: state.transcriptGeneration.taskB ?? 0, requestLeaf: "b2" });
    expect(done.bots[0]!.openCards?.map((m) => m.id)).toEqual(["c1"]);
    expect(done.bots[0]!.openCardsPending).toBeUndefined();
    expect(cardsFetchNeeded(done, done.bots[0])).toBe(false);
  });

  it("P2-2 rooms: both the thread notice and the global notice reach a room, and an exact answer replaces its partial list", () => {
    const partial = { ...initialState, groups: [room({ openCards: [card("c1", 1)], openCardsLeaf: "r6", openCardsPending: true })] };
    for (const notice of ["room-t", null] as const) {
      const noticed = reducer(partial, { type: "openCardsReady", threadId: notice });
      expect(cardsFetchNeeded(noticed, noticed.groups[0])).toBe(true);
      const exact = reducer(noticed, { type: "openCardsRefreshed", threadId: "room-t", leafId: "r6", cards: [card("c1", 1), card("c2", 2)], rev: 0, readyRev: readyRevOf(noticed, "room-t"), gen: noticed.transcriptGeneration["room-t"] ?? 0 });
      expect(exact.groups[0]!.openCards?.map((m) => m.id)).toEqual(["c1", "c2"]);
      expect(exact.groups[0]!.openCardsPending).toBeUndefined();
      expect(cardsFetchNeeded(exact, exact.groups[0])).toBe(false);
    }
    // a card patched meanwhile makes an older answer stale for a room as for a bot
    const noticed = reducer(partial, { type: "openCardsReady", threadId: "room-t" });
    const patched = reducer(noticed, { type: "messagePatched", threadId: "room-t", message: card("c1", 1, { answered: "deny" }) });
    expect(reducer(patched, { type: "openCardsRefreshed", threadId: "room-t", leafId: "r6", cards: [card("c1", 1)], rev: 0, readyRev: 1 }).groups[0]!.openCards?.[0]?.card?.answered).toBe("deny");
  });

  it("P3: an answer for another branch head is asked for again (wiring)", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/readyIsBot && result\.activeLeafId !== undefined && result\.activeLeafId !== readyLeaf\) askAgain\(\)/);
  });
});
