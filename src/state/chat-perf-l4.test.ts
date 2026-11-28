// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { installDOMHarness, mount } from "../testing/dom-harness";
import { initialState, messageVersions, olderOpenCards, openIntakeQuestion, reducer, StoreProvider, useStore, visibleMessages, type Bot, type Message } from "./store";

function transcript(openCards?: Message[]) {
  let idReads = 0;
  const rows: Message[] = Array.from({ length: 5000 }, (_, i) => new Proxy<Message>({
    id: `row-${i}`, parentId: i === 0 ? "unloaded-parent" : `row-${i - 1}`,
    at: i, role: "bot", kind: "text", text: "Held transcript row",
  }, {
    get(target, key, receiver) {
      if (key === "id" || key === "parentId") idReads++;
      return Reflect.get(target, key, receiver);
    },
  }));
  const bot: Bot = {
    id: "chat-fixture", threadId: "thread-fixture", name: "Planner", title: "Planner",
    description: "Chat scale fixture", color: "blue", notifications: false,
    activity: "idle", busy: false, unread: false, messages: rows, tasks: [],
    activeLeafId: "row-4999", hasMore: true, openCards, openCardsLeaf: "row-4999",
    modelSelection: { instanceId: "fixture", model: "fixture" },
  };
  return {
    bot,
    state: { ...initialState, bots: [bot] },
    reset() { idReads = 0; },
    count(label: string) { console.info(label, idReads); return idReads; },
  };
}

function card(id: string, parentId: string, at: number): Message {
  return { id, parentId, at, role: "bot", kind: "options", card: {
    title: "Choose a plan", subtitle: "Fixture", options: ["Continue"],
  } };
}

it("projects the visible branch and older card after two real appends between reads", () => {
  const older = card("older", "older-parent", -10);
  const fixture = transcript([older]);
  const before = olderOpenCards(fixture.bot, visibleMessages(fixture.bot));
  expect(before[0]?.id).toBe("older");
  fixture.reset();
  let state = fixture.state;
  for (const [id, parentId] of [["first", "row-4999"], ["second", "first"]]) {
    state = reducer(state, { type: "messageAdded", threadId: fixture.bot.threadId, message: {
      id, parentId, at: id === "first" ? 5000 : 5001, role: "bot", kind: "text", text: "Appended row",
    } });
  }
  const bot = state.bots[0]!;
  const projection = olderOpenCards(bot, visibleMessages(bot));
  expect(projection.at(0)?.id).toBe("older");
  expect(projection.at(-2)?.id).toBe("first");
  expect(projection.at(-1)?.id).toBe("second");
  expect(projection.length).toBe(5003);
  expect(fixture.count("Batched appends and older-card projection ID reads")).toBeLessThan(500);
});

it.each(["answerCard", "dismissCard"] as const)("handles a loaded tail card via %s without reading held history", type => {
  const fixture = transcript();
  const tail = card("tail", "row-4999", 5000);
  const state = reducer(fixture.state, { type: "messageAdded", threadId: fixture.bot.threadId, message: tail });
  expect(visibleMessages(state.bots[0]!).at(-1)).toBe(tail);
  fixture.reset();
  const bot = reducer(state, type === "answerCard"
    ? { type, botId: fixture.bot.id, messageId: tail.id, answer: "Continue" }
    : { type, botId: fixture.bot.id, messageId: tail.id }).bots[0]!;
  expect(bot.messages.at(-1)?.card?.dismissed).toBe(true);
  if (type === "answerCard") expect(bot.messages.at(-1)?.card?.answered).toBe("Continue");
  expect(state.bots[0]?.messages.at(-1)?.card?.dismissed).toBeUndefined();
  expect(fixture.count(type + " loaded-history ID reads")).toBeLessThan(500);
});

it.each(["answerCard", "dismissCard"] as const)("dispatches %s to the native question route without a history scan", async type => {
  const fixture = transcript();
  const tail = card("tail", "row-4999", 5000);
  tail.card!.requestId = "question-fixture";
  const restore = installDOMHarness();
  const posted: unknown[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/desktop-secret")) return Promise.resolve(new Response("{}", { status: 404 }));
    if (!String(input).endsWith("/respond")) return new Promise<Response>(() => {});
    posted.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
  });
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    return null;
  }
  try {
    mount(createElement(StoreProvider, { children: createElement(Probe) }));
    act(() => store.dispatch({
      type: "hydrate", source: "http", sentAt: Date.now(), expired: false, bots: [fixture.bot], groups: [], computerControl: {},
    }));
    act(() => store.dispatch({ type: "messageAdded", threadId: fixture.bot.threadId, message: tail }));
    expect(visibleMessages(store.state.bots[0]!).at(-1)).toBe(tail);
    fixture.reset();
    await act(async () => store.dispatch(type === "answerCard"
      ? { type, botId: fixture.bot.id, messageId: tail.id, answer: "Continue" }
      : { type, botId: fixture.bot.id, messageId: tail.id }));
    expect(posted).toEqual([{
      requestId: "question-fixture", threadId: fixture.bot.threadId,
      ...(type === "answerCard" ? { behavior: "answer", message: "Continue" } : { behavior: "skip" }),
    }]);
    expect(fixture.count(type + " dispatch ID reads")).toBeLessThan(500);
  } finally {
    restore();
    vi.unstubAllGlobals();
  }
});

it("keeps the visible branch bounded when an older card settles", () => {
  const older = card("older", "older-parent", -10);
  const fixture = transcript([older]);
  expect(olderOpenCards(fixture.bot, visibleMessages(fixture.bot)).at(0)?.id).toBe("older");
  fixture.reset();
  const updated = { ...older, card: { ...older.card!, answered: "Continue" } };
  const bot = reducer(fixture.state, {
    type: "messagePatched", threadId: fixture.bot.threadId, message: updated,
  }).bots[0]!;
  const projected = olderOpenCards(bot, visibleMessages(bot));
  expect(projected.at(0)?.card?.answered).toBe("Continue");
  expect(projected.at(-1)?.id).toBe("row-4999");
  expect(older.card?.answered).toBeUndefined();
  expect(fixture.count("Older-card settlement ID reads")).toBeLessThan(500);
});

it("selects the newest valid intake question and removes it when its answer arrives", () => {
  const fixture = transcript();
  const first = card("intake-first", "row-4999", 5000);
  first.card!.intake = { step: "open", asked: 1 };
  const second = card("intake-second", first.id, 5001);
  second.card!.intake = { step: "narrow", asked: 2 };
  const apply = (state: typeof fixture.state, type: "messageAdded" | "messagePatched", message: Message) =>
    reducer(state, { type, threadId: fixture.bot.threadId, message });

  const firstOpen = apply(fixture.state, "messageAdded", first);
  expect(openIntakeQuestion(firstOpen.bots[0]!)).toBe(first);
  const bothOpen = apply(firstOpen, "messageAdded", second);
  expect(openIntakeQuestion(bothOpen.bots[0]!)).toBe(second);
  const firstAnswered = apply(bothOpen, "messagePatched", { ...first, card: { ...first.card!, answered: "Continue" } });
  expect(openIntakeQuestion(firstAnswered.bots[0]!)).toBe(second);
  const bothAnswered = apply(firstAnswered, "messagePatched", { ...second, card: { ...second.card!, answered: "Continue" } });
  expect(openIntakeQuestion(bothAnswered.bots[0]!)).toBeNull();
  expect(openIntakeQuestion(bothOpen.bots[0]!)).toBe(second);
});

it("retains the transcript order of equally timed edits after a row patch", () => {
  const { bot } = transcript();
  const first: Message = { id: "first-version", parentId: null, at: 1, role: "user", kind: "text", text: "Draft" };
  const second: Message = { ...first, id: "second-version", text: "Another draft" };
  bot.messages = [first, second];
  expect(messageVersions(bot, first)).toEqual([first, second]);
  const patched = { ...first, text: "Edited draft" };
  const state = reducer({ ...initialState, bots: [bot] }, { type: "messagePatched", threadId: bot.threadId, message: patched });
  expect(messageVersions(state.bots[0]!, patched)).toEqual([patched, second]);
  expect(messageVersions(bot, first)).toEqual([first, second]);
});
