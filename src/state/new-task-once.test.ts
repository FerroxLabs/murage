import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createNewTaskOnce, NEW_TASK_DEADLINE_MS, NewTaskStalled, withDeadline } from "./new-task-once";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("New conversation makes one conversation per action (upstream d124292a2)", () => {
  it("drops a second and third click while the first is being made", async () => {
    const once = createNewTaskOnce();
    let release!: () => void;
    let calls = 0;
    const make = () => { calls++; return new Promise<void>((resolve) => { release = resolve; }); };
    once("bot-1", undefined, () => undefined, make);
    once("bot-1", undefined, () => undefined, make);
    once("bot-1", undefined, () => undefined, make);
    await flush();
    expect(calls).toBe(1);
    release();
    await flush();
    once("bot-1", undefined, () => undefined, make);
    await flush();
    expect(calls).toBe(2);
  });

  it("runs a click for another folder once the first one is made", async () => {
    const once = createNewTaskOnce();
    const made: (string | undefined)[] = [];
    let release!: () => void;
    once("bot-1", "/a", () => undefined, () => { made.push("/a"); return new Promise<void>((resolve) => { release = resolve; }); });
    once("bot-1", "/b", () => undefined, async () => { made.push("/b"); });
    await flush();
    expect(made).toEqual(["/a"]);
    release();
    await flush(); await flush();
    expect(made).toEqual(["/a", "/b"]);
  });

  it("takes the page intent when a queued click is kept, so a later switch keeps the screen", async () => {
    const once = createNewTaskOnce();
    let counter = 0;
    const intents: number[] = [];
    let release!: () => void;
    once("bot-1", "/a", () => ++counter, (intent) => { intents.push(intent); return new Promise<void>((resolve) => { release = resolve; }); });
    once("bot-1", "/b", () => ++counter, async (intent) => { intents.push(intent); });
    // the person switches to another conversation while /a is still being made
    const switchIntent = ++counter;
    await flush();
    release();
    await flush(); await flush();
    expect(intents).toEqual([1, 2]);
    // the queued /b answer carries an intent older than the switch, which the reducer refuses
    expect(intents[1]).toBeLessThan(switchIntent);
  });

  it("does not take an intent for a dropped click", async () => {
    const once = createNewTaskOnce();
    let accepted = 0;
    let release!: () => void;
    once("bot-1", undefined, () => ++accepted, () => new Promise<void>((resolve) => { release = resolve; }));
    once("bot-1", undefined, () => ++accepted, async () => undefined);
    expect(accepted).toBe(1);
    await flush();
    release();
    await flush();
  });

  it("keeps one queued create per folder while another is being made", async () => {
    const once = createNewTaskOnce();
    const made: string[] = [];
    let release!: () => void;
    once("bot-1", "/a", () => undefined, () => { made.push("/a"); return new Promise<void>((resolve) => { release = resolve; }); });
    once("bot-1", "/b", () => undefined, async () => { made.push("/b"); });
    once("bot-1", "/b", () => undefined, async () => { made.push("/b"); });
    await flush();
    release();
    await flush(); await flush(); await flush();
    expect(made).toEqual(["/a", "/b"]);
  });

  it("frees the bot after a failed request, and keeps bots apart", async () => {
    const once = createNewTaskOnce();
    let calls = 0;
    once("bot-1", undefined, () => undefined, async () => { calls++; throw new Error("offline"); });
    once("bot-2", undefined, () => undefined, async () => { calls++; });
    await flush(); await flush();
    once("bot-1", undefined, () => undefined, async () => { calls++; });
    await flush();
    expect(calls).toBe(3);
  });

  it("is what the store's newTask effect goes through", () => {
    const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");
    expect(store).toContain("newTaskOnce(action.botId, action.cwd, () => requestPage(rawDispatch, stateRef.current, action.botId), (intent) =>");
  });

  it("a room's New conversation goes through its own guard: a double click makes one room conversation", () => {
    const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");
    const effect = store.slice(store.indexOf('case "newGroupTask":\n          '), store.indexOf('case "switchGroupTask":\n          api('));
    expect(effect).toContain("newGroupTaskOnce(action.groupId, undefined, () => undefined, () =>");
    expect(effect).toContain("api(`/api/groups/${action.groupId}/tasks`");
    expect(store).toContain("const newGroupTaskOnce = createNewTaskOnce();");
  });
});

describe("a New conversation that never answers does not leave the button dead", () => {
  it("gives up after the deadline, aborts the request, and the next click runs", async () => {
    vi.useFakeTimers();
    try {
      const once = createNewTaskOnce();
      const signals: AbortSignal[] = [];
      const outcomes: string[] = [];
      let calls = 0;
      const stalled = () => { calls++; return withDeadline(NEW_TASK_DEADLINE_MS, (signal) => { signals.push(signal); return new Promise<never>(() => {}); }).catch((e) => { outcomes.push(e instanceof NewTaskStalled ? "stalled" : "other"); }); };
      once("room-1", undefined, () => undefined, stalled);
      await vi.advanceTimersByTimeAsync(0);
      once("room-1", undefined, () => undefined, stalled); // dropped: the first is still being made
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(NEW_TASK_DEADLINE_MS);
      expect(outcomes).toEqual(["stalled"]);
      expect(signals[0]!.aborted).toBe(true);
      // The guard is free: the owner's next click makes the conversation.
      once("room-1", undefined, () => undefined, () => { calls++; return Promise.resolve(); });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stall before the request is sent still ends at the deadline; an answer in time is passed through and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const early = withDeadline(1000, () => new Promise<never>(() => {}));
      const caught = early.catch((e) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await caught).toBeInstanceOf(NewTaskStalled);
      await expect(withDeadline(1000, async () => "made")).resolves.toBe("made");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(withDeadline(1000, async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("both the bot and the room effect go through the deadline, with a sentence that says try again", () => {
    const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");
    expect(store).toContain("withDeadline(NEW_TASK_DEADLINE_MS, (signal) => api(`/api/bots/${action.botId}/tasks`");
    expect(store).toContain("withDeadline(NEW_TASK_DEADLINE_MS, (signal) => api(`/api/groups/${action.groupId}/tasks`");
    expect(store.match(/e instanceof NewTaskStalled \? new Error\(t\("newConversation\.stalled"\)\) : e/g)).toHaveLength(2);
  });
});
