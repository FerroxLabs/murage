// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6, client half (§2, §11 merge 2): one server number orders every record, removal and roster row.
// Named regressions N1-N8, P1-P5, P8-P10, P15, the desktop archive list (Opus H-r6-1), C1 (static), and the DELETE effect's
// classes (P13 client half). The randomized order test is src/state/store.order.test.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TTL_MS, answerClock, asAnswer, fromAnswer } from "./answer-tag";
import { DELETE_RETRY_MAX, StoreProvider, initialState, reducer, useStore, type Action, type AppState, type Bot, type Task } from "./store";
import { httpNow } from "./test-origins";

const E1 = "e1";
const E2 = "e2";
const model = { instanceId: "acp", model: "fake" };
const task = (threadId: string, createdAt = 1): Task => ({ threadId, title: threadId, createdAt, modelSelection: model, autoApprove: false, alwaysAllow: [], unread: false } as unknown as Task);

function bot(id: string, seq: number, extra: Partial<Bot> & Record<string, unknown> = {}): Bot {
  return {
    id, threadId: `${id}-A`, name: id, title: "", description: "", notifications: true, color: "green", unread: false, modelSelection: model,
    messages: [], tasks: [task(`${id}-A`), task(`${id}-B`, 2)], tasksSeq: seq, tasksEpoch: E1, ...extra,
  } as unknown as Bot;
}
const roster = (bots: Bot[], extra: Partial<Extract<Action, { type: "hydrate" }>> = {}): Action =>
  ({ type: "hydrate", ...httpNow, bots, groups: [], computerControl: {}, tasksEpoch: E1, removed: [], ...extra }) as Action;
// A stream bot frame carries no transcript (the 2323 composite is the exception, built only by the switchedThread branch).
const frame = (record: Bot | Record<string, unknown>): Action => ({ type: "botPatched", source: "stream", bot: { ...record, messages: undefined } as unknown as Bot });
const answer = (record: Bot | Record<string, unknown>, extra: Record<string, unknown> = {}): Action => ({ type: "botPatched", ...httpNow, bot: record as Bot, ...extra }) as Action;
const run = (state: AppState, ...actions: Action[]) => actions.reduce(reducer, state);
const held = (state: AppState, id = "x") => state.bots.find((candidate) => candidate.id === id);
/** A numbered client holding X at e1/4 (inserted by the roster, before any later roster's send). */
const numbered = (...bots: Bot[]) => reducer(initialState, roster(bots.length ? bots : [bot("x", 4)], { sentTick: 0 }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("answer life (§0.4, r6 L6)", () => {
  it("an answer is tagged with its send time; past ANSWER_TTL_MS it is expired at dispatch, and a spread copy is caught", () => {
    const now = answerClock.now;
    try {
      let clock = 1_000;
      answerClock.now = () => clock;
      const body = asAnswer({ bot: { id: "x" }, bots: [{ id: "y" }] });
      expect(fromAnswer(body.bot)).toEqual({ source: "http", sentAt: 1_000, expired: false });
      clock += ANSWER_TTL_MS + 1;
      expect(fromAnswer(body.bots[0]).expired).toBe(true);
      expect(() => fromAnswer({ ...body.bot })).toThrow(/not an api\(\) answer/);
    } finally { answerClock.now = now; }
  });

  it("N1b: an expired answer is dropped and asks for the roster again; a fresh one applies", () => {
    let state = numbered();
    state = reducer(state, { type: "botPatched", source: "http", sentAt: 0, expired: true, bot: bot("x", 5, { name: "late" }) });
    expect(held(state)?.name).toBe("x");
    expect(state.reconcileRequested).toBe(1);
    state = reducer(state, answer(bot("x", 5, { name: "fresh" })));
    expect(held(state)?.name).toBe("fresh");
    expect(held(state)?.recordSeq).toBe(5);
  });
});

describe("deletions (§2.7)", () => {
  it("N1: a DELETE settles only by its own attempt and leaves a tombstone of the deletion's number", () => {
    let state = run(numbered(), { type: "deleteBot", source: "local", botId: "x", attempt: "a1" });
    expect(held(state)).toBeUndefined();
    state = reducer(state, { type: "deletionSettled", source: "http", botId: "x", attempt: "other", outcome: "deleted", tasksSeq: 5, tasksEpoch: E1 });
    expect(state.pendingDeletes?.x).toBeDefined();
    state = reducer(state, { type: "deletionSettled", source: "http", botId: "x", attempt: "a1", outcome: "deleted", tasksSeq: 5, tasksEpoch: E1 });
    expect(state.pendingDeletes?.x).toBeUndefined();
    expect(state.tombstones?.x).toMatchObject({ epoch: E1, seq: 5, kind: "deleted", streamAcked: false });
    // pre-deletion inputs on any channel stay out; a record numbered after it (a recreation) would apply
    expect(held(run(state, frame(bot("x", 5)), answer(bot("x", 4))))).toBeUndefined();
  });

  it("N3: while pending a GET 200 is dropped; a refusal ends pending, verifies, and the verify 200 (same number) re-inserts unloaded", () => {
    let state = run(numbered(), { type: "deleteBot", source: "local", botId: "x", attempt: "a1" });
    state = reducer(state, answer(bot("x", 4), { verified: true }));
    expect(held(state)).toBeUndefined();
    state = reducer(state, { type: "deletionSettled", source: "http", botId: "x", attempt: "a1", outcome: "refused", error: "busy" });
    expect(state.pendingDeletes?.x).toBeUndefined();
    expect(state.tombstones?.x).toBeUndefined();
    expect(state.verifyBots?.x).toBe(true);
    state = reducer(state, answer(bot("x", 4, { messages: [{ id: "m", role: "bot", kind: "text", text: "hi", at: 1 }] }), { verified: true }));
    expect(held(state)).toMatchObject({ id: "x", messagesUnloaded: true, messages: [] });
    expect(state.verifyBots?.x).toBeUndefined();
  });

  it("gaveUp ends pending with no tombstone and verifies; a 404 leaves the bot absent", () => {
    let state = run(numbered(), { type: "deleteBot", source: "local", botId: "x", attempt: "a1" });
    state = reducer(state, { type: "deletionSettled", source: "http", botId: "x", attempt: "a1", outcome: "gaveUp", error: "no answer" });
    expect(state.verifyBots?.x).toBe(true);
    state = reducer(state, { type: "verifySettled", botId: "x", gone: true });
    expect(held(state)).toBeUndefined();
    expect(state.verifyBots?.x).toBeUndefined();
  });

  it("a real deletion frame ends a pending delete; a hide frame never does (§9.2)", () => {
    const pending = run(numbered(), { type: "deleteBot", source: "local", botId: "x", attempt: "a1" });
    const hid = reducer({ ...pending, scopedClient: true }, { type: "botDeleted", source: "stream", botId: "x", hidden: true, tasksSeq: 5, tasksEpoch: E1 });
    expect(hid.pendingDeletes?.x).toBeDefined();
    const gone = reducer(pending, { type: "botDeleted", source: "stream", botId: "x", hidden: false, tasksSeq: 5, tasksEpoch: E1 });
    expect(gone.pendingDeletes?.x).toBeUndefined();
    expect(gone.tombstones?.x).toMatchObject({ seq: 5, kind: "deleted", streamAcked: true });
  });

  it("N3b: the sweep retires a stream-acked tombstone after the TTL, keeps an unacked one of this run, retires a past run's", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let state = numbered(bot("x", 4), bot("y", 4), bot("z", 4));
    state = reducer(state, { type: "botDeleted", source: "stream", botId: "x", hidden: false, tasksSeq: 5, tasksEpoch: E1 });
    state = run(state, { type: "deleteBot", source: "local", botId: "y", attempt: "a" }, { type: "deletionSettled", source: "http", botId: "y", attempt: "a", outcome: "deleted", tasksSeq: 5, tasksEpoch: E1 });
    state = run(state, { type: "deleteBot", source: "local", botId: "z", attempt: "b" }, { type: "deletionSettled", source: "http", botId: "z", attempt: "b", outcome: "deleted", tasksSeq: 5, tasksEpoch: "e0" });
    const later = 1_000_000 + ANSWER_TTL_MS + 1;
    state = reducer(state, { type: "tombstonesSweep", now: later });
    expect(Object.keys(state.tombstones ?? {}).sort()).toEqual(["y"]);
    expect(reducer(state, { type: "tombstonesSweep", now: later })).toBe(state);
  });

  it("N8: the archived list's delete is pending under its attempt; a scoped stale hidden answer changes nothing, a newer one removes and fences", () => {
    let state = run(numbered(bot("x", 4, { hidden: true })), { type: "deleteBot", source: "local", botId: "x", attempt: "arch", archived: true });
    expect(state.pendingDeletes?.x).toEqual({ attempt: "arch", archived: true });
    state = reducer(state, { type: "deletionSettled", source: "http", botId: "x", attempt: "arch", outcome: "deleted", tasksSeq: 4, tasksEpoch: E1 });
    expect(state.tombstones?.x?.kind).toBe("deleted");

    let phone = reducer({ ...numbered(bot("p", 7)), scopedClient: true }, answer(bot("p", 6, { hidden: true })));
    expect(held(phone, "p")).toBeDefined();
    phone = reducer(phone, answer(bot("p", 8, { hidden: true })));
    expect(held(phone, "p")).toBeUndefined();
    expect(phone.tombstones?.p).toMatchObject({ seq: 8, kind: "hidden" });
  });

  it("P2: restore/6, delete pending, hide frame/5 (pending kept, dropped), visible/6 answer (pending), the DELETE's answer: tombstone deleted/6", () => {
    let state: AppState = { ...numbered(bot("x", 5, { hidden: true })), scopedClient: false };
    state = reducer(state, frame(bot("x", 6, { hidden: false })));
    state = run(state, { type: "deleteBot", source: "local", botId: "x", attempt: "a" });
    state = reducer(state, { type: "botDeleted", source: "stream", botId: "x", hidden: true, tasksSeq: 5, tasksEpoch: E1 });
    expect(state.pendingDeletes?.x).toBeDefined();
    state = reducer(state, answer(bot("x", 6)));
    expect(held(state)).toBeUndefined();
    state = reducer(state, { type: "deletionSettled", source: "http", botId: "x", attempt: "a", outcome: "deleted", tasksSeq: 6, tasksEpoch: E1 });
    expect(state.tombstones?.x).toMatchObject({ seq: 6, kind: "deleted" });
  });
});

describe("numbers and runs (§2.3-2.5)", () => {
  it("N4: a delta frame past a base mismatch moves the record version, keeps the task base and marks it stale; an older answer changes nothing", () => {
    let state = numbered();
    state = reducer(state, frame({ ...bot("x", 6, { name: "six" }), tasks: undefined, tasksDelta: { upsert: [], count: 2, base: 5 } }));
    expect(held(state)).toMatchObject({ name: "six", recordSeq: 6, tasksSeq: 4, tasksStale: true });
    state = reducer(state, answer(bot("x", 5, { name: "five" })));
    expect(held(state)?.name).toBe("six");
  });

  it("N4b: a past run's task list or removal changes nothing", () => {
    let state = numbered();
    state = reducer(state, roster([bot("x", 1, { tasksEpoch: E2 })], { tasksEpoch: E2, sentTick: 10 }));
    expect(state.streamEpoch).toBe(E2);
    const before = held(state);
    state = reducer(state, { type: "tasksResynced", ...httpNow, botId: "x", tasks: [task("old")], tasksSeq: 9, tasksEpoch: E1 });
    expect(held(state)).toBe(before);
    state = reducer(state, { type: "botDeleted", source: "stream", botId: "x", hidden: false, tasksSeq: 9, tasksEpoch: E1 });
    expect(held(state)).toBeDefined();
  });

  it("an unfamiliar run never inserts: it verifies and asks for the roster; the current run beats a held copy of another", () => {
    let state = numbered();
    state = reducer(state, frame(bot("new", 1, { tasksEpoch: "e9" })));
    expect(held(state, "new")).toBeUndefined();
    expect(state.verifyBots?.new).toBe(true);
    expect(state.reconcileRequested).toBe(1);
    // an unnumbered record in numbered mode: completion only, never an insert
    state = reducer(state, frame({ ...bot("other", 1), tasksSeq: undefined, tasksEpoch: undefined }));
    expect(held(state, "other")).toBeUndefined();
  });

  it("N8b: same-version completion replaces a cut description and a stale task list, and nothing else", () => {
    let state = numbered(bot("x", 4, { description: "short", descriptionCut: true, tasksStale: true, name: "held" }));
    state = reducer(state, answer(bot("x", 4, { description: "the whole description", name: "other", tasks: [task("x-A"), task("x-C", 3)] })));
    expect(held(state)).toMatchObject({ description: "the whole description", name: "held", recordSeq: 4 });
    expect(held(state)?.descriptionCut).toBeUndefined();
    expect(held(state)?.tasksStale).toBeUndefined();
    expect(held(state)?.tasks?.map((row) => row.threadId)).toEqual(["x-A", "x-C"]);
  });
});

describe("visibility on a scoped client (§2.3 step 5, §9.1-9.3)", () => {
  it("P1: hidden/5, visible/6 delayed, hidden/7, then visible/6: absent, tombstone hidden/7", () => {
    let state: AppState = { ...numbered(bot("x", 4)), scopedClient: true };
    state = reducer(state, frame(bot("x", 5, { hidden: true })));
    expect(held(state)).toBeUndefined();
    state = reducer(state, answer(bot("x", 7, { hidden: true })));
    state = reducer(state, answer(bot("x", 6)));
    expect(held(state)).toBeUndefined();
    expect(state.tombstones?.x).toMatchObject({ seq: 7, kind: "hidden" });
  });

  it("P3: a hide of an earlier run is verified; a verified visible record of the current run clears it, a verified hidden one fences again", () => {
    let state: AppState = { ...numbered(bot("x", 4)), scopedClient: true };
    state = reducer(state, { type: "botDeleted", source: "stream", botId: "x", hidden: true, tasksSeq: 5, tasksEpoch: E1 });
    state = reducer(state, roster([], { tasksEpoch: E2, sentTick: 100 }));
    state = reducer(state, frame(bot("x", 1, { tasksEpoch: E2 })));
    expect(held(state)).toBeUndefined();
    expect(state.verifyBots?.x).toBe(true);
    const visible = reducer(state, answer(bot("x", 1, { tasksEpoch: E2 }), { verified: true }));
    expect(held(visible)).toBeDefined();
    expect(visible.tombstones?.x).toBeUndefined();
    const hidden = reducer(state, answer(bot("x", 2, { tasksEpoch: E2, hidden: true }), { verified: true }));
    expect(held(hidden)).toBeUndefined();
    expect(hidden.tombstones?.x).toMatchObject({ epoch: E2, seq: 2, kind: "hidden" });
  });
});

describe("hydrate (§2.8)", () => {
  it("N2: a buffered pre-delete frame drained after a roster whose removed[] numbers the deletion stays out; a later restore applies", () => {
    let state = numbered(bot("x", 3));
    state = reducer(state, roster([], { removed: [{ id: "x", tasksSeq: 5, tasksEpoch: E1, kind: "deleted" }], sentTick: state.admitTick }));
    state = reducer(state, frame(bot("x", 4)));
    expect(held(state)).toBeUndefined();
    state = reducer(state, frame(bot("x", 6)));
    expect(held(state)).toBeDefined();
  });

  it("N5: a roster row older than the held record keeps the held record; membership is by order of admission, not by run", () => {
    let state = numbered(bot("x", 4), bot("gone", 4));
    state = reducer(state, answer(bot("x", 7, { name: "seven" })));
    state = reducer(state, roster([bot("x", 6, { name: "six" })], { sentTick: state.admitTick }));
    expect(held(state)?.name).toBe("seven");
    expect(held(state, "gone")).toBeUndefined();
  });

  it("P9: a bot deleted during a long disconnect (removed[] already pruned) is dropped; one inserted after the send is kept and verified", () => {
    let state = numbered(bot("x", 4));
    const sentTick = state.admitTick ?? 0;
    state = reducer(state, frame(bot("y", 1)));
    expect(held(state, "y")?.admittedAt).toBeGreaterThan(sentTick);
    state = reducer(state, roster([], { sentTick }));
    expect(held(state, "x")).toBeUndefined();
    expect(held(state, "y")).toBeDefined();
    expect(state.verifyBots?.y).toBe(true);
    // the phone's archive path is the same rule: an omitted hidden bot is dropped
    let phone: AppState = { ...numbered(bot("p", 4)), scopedClient: true };
    phone = reducer(phone, roster([], { sentTick: phone.admitTick }));
    expect(held(phone, "p")).toBeUndefined();
  });

  it("Astra r5 #1: a restore of an already-held bot that lands after the roster's send keeps it (verified)", () => {
    let state: AppState = { ...numbered(bot("x", 4)), scopedClient: true };
    const sentTick = state.admitTick ?? 0;
    state = reducer(state, answer(bot("x", 6, { name: "restored" })));
    state = reducer(state, roster([], { sentTick }));
    expect(held(state)?.name).toBe("restored");
    expect(state.verifyBots?.x).toBe(true);
  });

  it("Opus H-r6-1: the desktop keeps a just-archived bot through a hydrate (hide entries never fence the desktop roster)", () => {
    let state = numbered(bot("x", 4));
    state = reducer(state, frame(bot("x", 5, { hidden: true })));
    state = reducer(state, roster([bot("x", 5, { hidden: true })], { removed: [{ id: "x", tasksSeq: 5, tasksEpoch: E1, kind: "hidden" }], sentTick: state.admitTick }));
    expect(held(state)?.hidden).toBe(true);
    expect(state.tombstones?.x).toBeUndefined();
  });

  it("P4: a TTL-valid roster of a run this client already left is ignored whole", () => {
    let state = numbered(bot("x", 4));
    state = reducer(state, roster([bot("x", 2, { tasksEpoch: E2 })], { tasksEpoch: E2, sentTick: 10 }));
    const after = reducer(state, roster([], { tasksEpoch: E1, sentTick: 99 }));
    expect(after).toBe(state);
  });

  it("P8: a roster tombstone is stream-acked only after the buffered frames were drained", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    let state = numbered(bot("x", 3));
    state = reducer(state, roster([], { removed: [{ id: "x", tasksSeq: 5, tasksEpoch: E1, kind: "deleted" }], sentTick: state.admitTick }));
    expect(state.tombstones?.x).toMatchObject({ streamAcked: false, ackOnDrain: true });
    const later = 5_000_000 + ANSWER_TTL_MS + 1;
    expect(reducer(state, { type: "tombstonesSweep", now: later }).tombstones?.x).toBeDefined();
    state = reducer(state, { type: "streamDrained" });
    expect(state.tombstones?.x?.streamAcked).toBe(true);
    expect(reducer(state, { type: "tombstonesSweep", now: later }).tombstones?.x).toBeUndefined();
  });
});

describe("page intent (§2.6 r6)", () => {
  const page = (id: string, threadId: string, seq: number, text: string, intent: number): Action => ({
    type: "taskSwitched", ...httpNow, intent,
    bot: bot(id, seq, { threadId, messages: [{ id: `${threadId}-m`, role: "bot", kind: "text", text, at: 1 }], activeLeafId: `${threadId}-m` }),
  }) as Action;

  it("N6: a search page asked for under intent 3 lands after intent 4 was asked: page ignored, record admitted; intent 4's page replaces", () => {
    let state = run(numbered(), { type: "pageRequested", botId: "x", intent: 3 }, { type: "pageRequested", botId: "x", intent: 4 });
    state = reducer(state, page("x", "x-B", 5, "from search", 3));
    expect(held(state)?.threadId).toBe("x-A");
    expect(held(state)?.recordSeq).toBe(5);
    state = reducer(state, page("x", "x-B", 5, "from switch", 4));
    expect(held(state)?.threadId).toBe("x-B");
    expect(held(state)?.messages.map((m) => m.text)).toEqual(["from switch"]);
  });

  it("P10: an own switch's echo frame (viewed thread still exists) leaves the intent; the answer's page applies", () => {
    let state = run(numbered(), { type: "pageRequested", botId: "x", intent: 1 });
    state = reducer(state, frame(bot("x", 5, { threadId: "x-B" })));
    expect(state.pageIntent?.x).toBe(1);
    expect(held(state)?.threadId).toBe("x-A");
    state = reducer(state, page("x", "x-B", 5, "switched", 1));
    expect(held(state)?.threadId).toBe("x-B");
  });

  it("P5: the server deleted the viewed task (switchedThread frame bumps the intent): a switch answer to it lands no page", () => {
    let state = run(numbered(), { type: "pageRequested", botId: "x", intent: 1 });
    state = reducer(state, frame(bot("x", 5, { threadId: "x-B", tasks: [task("x-B", 2)] })));
    expect(state.pageIntent?.x).toBe(2);
    expect(held(state)).toMatchObject({ threadId: "x-B", deletedThreadId: "x-A", awaitingThreadSnapshot: true });
    state = reducer(state, page("x", "x-A", 5, "deleted task", 1));
    expect(held(state)?.threadId).toBe("x-B");
    // a page for the deleted thread fails on deletedThreadId even under the current intent
    state = reducer(state, page("x", "x-A", 6, "deleted task", 2));
    expect(held(state)?.threadId).toBe("x-B");
  });

  it("the deleteTask answer fills the thread the record moved to, after the server's own frame numbered it first", () => {
    let state = run(numbered(), { type: "pageRequested", botId: "x", intent: 1 });
    state = reducer(state, frame(bot("x", 5, { threadId: "x-B", tasks: [task("x-B", 2)] })));
    state = reducer(state, answer(bot("x", 5, { threadId: "x-B", tasks: [task("x-B", 2)], messages: [{ id: "b1", role: "bot", kind: "text", text: "B", at: 1 }], activeLeafId: "b1" }), { intent: 1 }));
    expect(held(state)).toMatchObject({ threadId: "x-B", awaitingThreadSnapshot: false });
    expect(held(state)?.messages.map((m) => m.id)).toEqual(["b1"]);
  });
});

describe("another window deleted the viewed task (astra-botint H2)", () => {
  it("the server's record frame moves the thread, and its page frame at the same number completes the snapshot", () => {
    // The receiver asked for nothing: it only hears the deleting window's work on the stream.
    let state = numbered();
    state = reducer(state, frame(bot("x", 5, { threadId: "x-B", tasks: [task("x-B", 2)] })));
    expect(held(state)).toMatchObject({ threadId: "x-B", deletedThreadId: "x-A", awaitingThreadSnapshot: true });
    const pageFrame: Action = { type: "botPatched", source: "stream", bot: bot("x", 5, { threadId: "x-B", tasks: [task("x-B", 2)], messages: [{ id: "b1", role: "bot", kind: "text", text: "B", at: 1 }], activeLeafId: "b1" }) } as unknown as Action;
    state = reducer(state, pageFrame);
    expect(held(state)).toMatchObject({ threadId: "x-B", awaitingThreadSnapshot: false });
    expect(held(state)?.messages.map((m) => m.id)).toEqual(["b1"]);
    expect(held(state)?.recordSeq).toBe(5);
  });

  it("a same-number stream page for the deleted thread, or for a thread nobody waits on, lands nothing", () => {
    let state = numbered();
    state = reducer(state, frame(bot("x", 5, { threadId: "x-B", tasks: [task("x-B", 2)] })));
    const stale: Action = { type: "botPatched", source: "stream", bot: bot("x", 5, { threadId: "x-A", messages: [{ id: "a1", role: "bot", kind: "text", text: "A", at: 1 }] }) } as unknown as Action;
    state = reducer(state, stale);
    expect(held(state)).toMatchObject({ threadId: "x-B", awaitingThreadSnapshot: true, messages: [] });
    let quiet = numbered(bot("x", 4, { messages: [{ id: "a0", role: "bot", kind: "text", text: "kept", at: 1 }] } as never));
    quiet = reducer(quiet, { type: "botPatched", source: "stream", bot: bot("x", 4, { messages: [{ id: "z", role: "bot", kind: "text", text: "z", at: 2 }] }) } as unknown as Action);
    expect(held(quiet)?.awaitingThreadSnapshot).toBeFalsy();
  });
});

describe("P15 and C1 (static)", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("P15: the drain after a hydrate applies only frames of the current live-events generation", () => {
    const store = source("src/state/store.tsx");
    expect(store).toMatch(/pendingFrames\.splice\(0\)\) if \(pending\.liveGen === liveGen\)/);
    expect(store).toMatch(/pendingFrames\.push\(\{ frame, replayed: [^}]*liveGen \}\)/);
    expect(store).toMatch(/liveGen \+= 1;\s*\n\s*pendingFrames\.splice\(0\)/);
  });

  it("C1: every bot-record dispatch names its source; nothing built from an answer is local; every page caller asks first", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(process.cwd(), rel)).isDirectory()) { if (name !== "e2e") walk(rel); continue; }
        if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.spec\.ts$/.test(name)) files.push(rel);
      }
    };
    walk("src");
    const offenders: string[] = [];
    for (const file of files) {
      const text = source(file);
      for (const match of text.matchAll(/[dD]ispatch\(\{\s*type:\s*"(botAdded|botPatched|taskSwitched|threadDeltaApplied|tasksResynced|hydrate|deleteBot)"([\s\S]*?)\}\)/g)) {
        const rest = match[2];
        if (!/source:|\.\.\.fromAnswer\(|\.\.\.freshAnswer\(\)/.test(rest)) offenders.push(`${file}: ${match[0].slice(0, 120)}`);
        if (/source: "local"/.test(rest) && /fromAnswer|result|response|answer/.test(rest)) offenders.push(`${file} (local from an answer): ${match[0].slice(0, 120)}`);
        if ((match[1] === "taskSwitched" || match[1] === "threadDeltaApplied") && /fromAnswer/.test(rest) && !/intent/.test(rest)) offenders.push(`${file} (page without intent): ${match[0].slice(0, 120)}`);
      }
      if (/type:\s*"botRemoved"/.test(text)) offenders.push(`${file}: botRemoved`);
    }
    // multi-line hydrate dispatch in the provider and the 2323 composite
    const store = source("src/state/store.tsx");
    expect(store).toMatch(/type: "hydrate",\s*\n\s*\.\.\.fromAnswer\(answer\)/);
    expect(store).toMatch(/\{ type: "taskSwitched", source: "stream", bot: \{ \.\.\.before, \.\.\.bot/);
    expect(offenders).toEqual([]);
  });
});

describe("P13 (client half): the DELETE effect's classes", () => {
  async function deleteWith(respond: () => Promise<Response>) {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", ((input: RequestInfo | URL) => { calls.push(String(input)); return respond(); }) as typeof fetch);
    let dispatch: ((action: Action) => void) | null = null;
    const Probe = () => { dispatch = useStore().dispatch; return null; };
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
    let settled: unknown;
    dispatch!({ type: "deleteBot", source: "local", botId: "x", attempt: "a", archived: true, onSettled: (result) => { settled = result; } });
    for (let i = 0; i < 60 && settled === undefined; i += 1) await vi.advanceTimersByTimeAsync(30_000);
    return { calls, settled };
  }
  const json = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("a JSON {error} 500 is a refusal: one request, settled refused with the error", async () => {
    const { calls, settled } = await deleteWith(json(500, { error: "The cleanup journal could not be read." }));
    expect(calls.filter((url) => url.includes("/api/bots/x"))).toHaveLength(1);
    expect(settled).toEqual({ outcome: "refused", error: "The cleanup journal could not be read." });
  });

  it("a non-JSON 502 is retried with the same attempt until DELETE_RETRY_MAX, then given up", async () => {
    const { calls, settled } = await deleteWith(() => Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 })));
    expect(calls.filter((url) => url.includes("/api/bots/x?ifArchived=1"))).toHaveLength(DELETE_RETRY_MAX);
    expect(settled).toMatchObject({ outcome: "gaveUp" });
  });

  it("a 200 answer settles deleted (alreadyDeleted included)", async () => {
    const { settled } = await deleteWith(json(200, { ok: true, alreadyDeleted: true, tasksSeq: 5, tasksEpoch: E1 }));
    expect(settled).toEqual({ outcome: "deleted" });
  });

  describe("an archived bot's drafts (astra-botint H3)", () => {
    function memoryStorage() {
      const values = new Map<string, string>();
      return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(), key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } };
    }
    const DRAFTS = JSON.stringify({ "bot:x:x-A": "unsent words", "bot:y:y-A": "another bot" });
    const drafts = () => JSON.parse(localStorage.getItem("murage-drafts") ?? "{}") as Record<string, string>;

    it("a refused (409) archived Delete keeps the bot's unsent drafts", async () => {
      vi.stubGlobal("localStorage", memoryStorage());
      localStorage.setItem("murage-drafts", DRAFTS);
      const { settled } = await deleteWith(json(409, { error: "This bot is no longer archived." }));
      expect(settled).toEqual({ outcome: "refused", error: "This bot is no longer archived." });
      expect(drafts()).toEqual({ "bot:x:x-A": "unsent words", "bot:y:y-A": "another bot" });
    });

    it("a given-up archived Delete keeps them too", async () => {
      vi.stubGlobal("localStorage", memoryStorage());
      localStorage.setItem("murage-drafts", DRAFTS);
      const { settled } = await deleteWith(() => Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 })));
      expect(settled).toMatchObject({ outcome: "gaveUp" });
      expect(drafts()["bot:x:x-A"]).toBe("unsent words");
    });

    it("a confirmed archived Delete (alreadyDeleted included) removes only that bot's drafts", async () => {
      vi.stubGlobal("localStorage", memoryStorage());
      localStorage.setItem("murage-drafts", DRAFTS);
      const { settled } = await deleteWith(json(200, { ok: true, alreadyDeleted: true, tasksSeq: 5, tasksEpoch: E1 }));
      expect(settled).toEqual({ outcome: "deleted" });
      expect(drafts()).toEqual({ "bot:y:y-A": "another bot" });
    });
  });
});

