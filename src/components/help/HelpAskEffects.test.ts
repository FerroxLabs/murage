import { afterEach, expect, it, vi } from "vitest";
import { askView, startAskOpening, startAskPage, startAskFollow, startAskNudge, type AskRecord } from "./HelpAsk";
import { createAskLifetime } from "./help-ask-lifetime";
import type { Bot } from "@/state/store";

const record: AskRecord = { gen: 1, sendId: "s", botId: "b", threadId: "t", question: "Q", text: "Q", phase: "refused" };
const bot = { id: "b", threadId: "t", messages: [] } as unknown as Bot;
afterEach(() => vi.useRealTimers());

it("newest resend wins in the real append order and after delivery replaces the pending rows", () => {
  const old = { sendId: "s", queueId: "old", text: "Q", refused: { notice: "refused" } };
  const sending = { sendId: "s", queueId: "sending:s", text: "Q", sending: true, local: true };
  expect(askView(record, bot, undefined, undefined, [old, sending] as never).s).toBe("sending");
  const delivered = { sendId: "s", queueId: "q", text: "Q" };
  expect(askView(record, bot, undefined, undefined, [old, delivered] as never).s).toBe("queued");
  // A server snapshot can precede local sendingSettled; keep Sending until that local entry is removed.
  expect(askView(record, bot, undefined, undefined, [delivered, sending]).s).toBe("sending");
  expect(askView(record, bot, undefined, undefined, [{ sendId: "s", queueId: "q", text: "Q" }]).s).toBe("queued");
  expect(askView(record, { ...bot, messages: [{ role: "user", sendId: "s", dispatchedIn: "turn" }] } as Bot, undefined, undefined, []).s).toBe("running");
});

it("opening cleanup removes listener, timers and late attempts", async () => {
  vi.useFakeTimers();
  const life = createAskLifetime(); life.keep(record);
  const show = vi.fn();
  const opening = { current: null as ReturnType<typeof life.open> | null };
  const closing = { current: { signal: new AbortController().signal } };
  const late = vi.fn();
  const handle = setTimeout(late, 20) as unknown as ReturnType<typeof setTimeout>;
  const timers = { current: new Set<ReturnType<typeof setTimeout>>([handle]) };
  const cleanup = startAskOpening({ life, show, opening, closing, timers });
  const attempt = opening.current!.begin();
  cleanup(); show.mockClear();
  life.keep({ ...record, phase: "accepted" });
  await vi.runAllTimersAsync();
  expect(show).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled();
  expect(attempt.live()).toBe(false); expect(closing.current.signal.aborted).toBe(true);
  expect(timers.current.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("page cleanup cancels retries and guards even an already captured callback", () => {
  vi.useFakeTimers();
  const dispatch = vi.fn(); const loads = { current: { key: "", tries: 0 } };
  startAskPage({ record, needsPage: true, loads, dispatch })();
  expect(dispatch).toHaveBeenCalledTimes(1);
  const spy = vi.spyOn(globalThis, "setTimeout");
  const cleanup = startAskPage({ record, needsPage: true, loads, dispatch });
  const late = spy.mock.calls[0][0] as () => void;
  cleanup(); late();
  expect(dispatch).toHaveBeenCalledTimes(1); expect(loads.current.tries).toBe(1);
  expect(vi.getTimerCount()).toBe(0); spy.mockRestore();
});

it("real follow activation and nudge wiring read again; cleanup fences late results and subscriptions", async () => {
  vi.useFakeTimers();
  const life = createAskLifetime(); life.next(); life.keep({ ...record, phase: "accepted" });
  const outer = new AbortController(); const add = vi.spyOn(outer.signal, "addEventListener"); const remove = vi.spyOn(outer.signal, "removeEventListener");
  const nudge = { current: undefined as (() => void) | undefined };
  let resolve!: (word: { state: string }) => void;
  const get = vi.fn().mockResolvedValueOnce({ state: "running" }).mockImplementation(() => new Promise(r => { resolve = r; }));
  const deps = { life, record: life.record, view: { s: "running" as const, turnId: "turn", answer: [] }, turnId: "turn", closing: { current: outer }, nudge, get };
  startAskFollow({ ...deps, view: { s: "refused" } })();
  expect(get).not.toHaveBeenCalled();
  const cleanup = startAskFollow(deps);
  await vi.advanceTimersByTimeAsync(0);
  const unhint = startAskNudge(nudge);
  expect(get).toHaveBeenCalledTimes(2);
  const lateNudge = nudge.current!;
  cleanup(); unhint();
  const before = life.record;
  resolve({ state: "ended" }); lateNudge(); startAskNudge(nudge)();
  await vi.runAllTimersAsync();
  expect(life.record).toBe(before); expect(get).toHaveBeenCalledTimes(2);
  expect(nudge.current).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
});

it("computes the operational deadline once before starting the follow", () => {
  vi.useFakeTimers();
  const life = createAskLifetime(); life.next(); life.keep({ ...record, phase: "accepted" });
  const order: string[] = [];
  const operationalDeadline = life.deadline;
  const deadline = vi.spyOn(life, "deadline").mockImplementation((...args) => {
    order.push("deadline"); return operationalDeadline(...args);
  });
  const controller = new AbortController();
  const closing = { current: { get signal() { order.push("outer signal"); return controller.signal; } } };
  const get = vi.fn().mockImplementation(async () => {
    order.push("read");
    expect(deadline).toHaveBeenCalledTimes(1);
    return { state: "running" };
  });
  const cleanup = startAskFollow({ life, record: life.record, view: { s: "queued", removing: false },
    closing, nudge: { current: undefined }, get });
  expect(deadline).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["deadline", "outer signal", "read"]);
  cleanup();
});
