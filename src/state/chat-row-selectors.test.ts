import { describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Action, type AppState, type Message } from "./store";
import { createStoreSubscriptions } from "./store-subscriptions";
import { commChipAction } from "../lib/comm-chip-visibility";
import { bubbleSelector, activitySelector, messagesSelector } from "./chat-row-selectors";

// The production subscription store, driven by the real application reducer.
// These count notifications, not mounted React renders.
function fixture() {
  const store = createStoreSubscriptions(initialState);
  return { ...store, dispatch(action: Action) { store.publish(reducer(store.getSnapshot(), action)); } };
}

describe("chat row subscriptions", () => {
  it.each([
    ["bubble", () => bubbleSelector(), (s: AppState): Action => ({ type: "configStatus", config: { ...s.config, tts: { voice: "changed" } } as NonNullable<AppState["config"]> })],
    ["activity", () => activitySelector({ withBotId: "peer", groupId: "room" }), (): Action => ({ type: "hydrate", bots: [], groups: [{ id: "room" }], instances: [] } as unknown as Action)],
    ["messages", () => messagesSelector("thread"), (): Action => ({ type: "focusMessage", threadId: "thread", messageId: "message" })],
  ] as const)("%s ignores unrelated changes and notifies for its own data", (_name, makeSelector, relevant) => {
    const store = fixture();
    const selection = store.select<object>(makeSelector());
    const listener = vi.fn();
    const unsubscribe = selection.subscribe(listener);
    const first = selection.getSnapshot();
    store.dispatch({ type: "error", message: "unrelated" });
    expect(selection.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(0);
    store.dispatch(relevant(store.getSnapshot()));
    expect(selection.getSnapshot()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: "error", message: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});


describe("activity selection preserves comm chip admission", () => {
  const comm = { withBotId: "peer", groupId: "room" };
  it.each([
    ["present", [{ id: "room" }], "open"],
    ["missing", [{ id: "other" }], "blocked"],
    // Companion visibility removes hidden groups before they reach the store.
    ["hidden on companion", [], "blocked"],
    ["still loading", initialState.groups, "blocked"],
    // The original helper checks membership, not a hidden flag on a held row.
    ["hidden but retained on desktop", [{ id: "room", hidden: true }], "open"],
  ] as const)("%s uses the same admission decision", (_name, groups, expected) => {
    const state = { ...initialState, groups: [...groups] } as AppState;
    const { groupVisible } = activitySelector(comm)(state);
    for (const phone of [true, false]) {
      const selected = commChipAction({ phone, groupId: comm.groupId, groups: groupVisible ? [{ id: comm.groupId }] : [] });
      expect(selected).toBe(commChipAction({ phone, groupId: comm.groupId, groups: state.groups }));
      expect(selected).toBe(phone ? expected : "open");
    }
  });

  it("notifies only the affected activity selection when its group arrives or disappears", () => {
    const store = fixture();
    const selection = store.select(activitySelector(comm));
    const other = store.select(activitySelector({ ...comm, groupId: "other" }));
    const changed = vi.fn(), unchanged = vi.fn();
    const stop = selection.subscribe(changed), stopOther = other.subscribe(unchanged);
    const action = () => commChipAction({ phone: true, groupId: comm.groupId, groups: selection.getSnapshot().groupVisible ? [{ id: comm.groupId }] : [] });
    const hydrate = (groups: Array<{ id: string }>) => store.dispatch({ type: "hydrate", bots: [], groups, instances: [] } as unknown as Action);
    expect(action()).toBe("blocked");
    hydrate([{ id: "room" }]);
    expect(action()).toBe("open");
    expect(changed).toHaveBeenCalledTimes(1);
    hydrate([{ id: "room" }]);
    expect(changed).toHaveBeenCalledTimes(1);
    hydrate([]);
    expect(action()).toBe("blocked");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(unchanged).not.toHaveBeenCalled();
    stop(); stopOther();
  });
});


it("peer messages and busy changes do not notify comm rows; every avatar field does", () => {
  const store = fixture();
  let peer = { id: "peer", name: "Peer", color: "blue", messages: [], busy: false } as unknown as AppState["bots"][number];
  const publish = () => store.dispatch({ type: "hydrate", bots: [peer], groups: [], instances: [] } as unknown as Action);
  publish();
  const selection = store.select(activitySelector({ withBotId: "peer", groupId: "room" }));
  const listener = vi.fn();
  const stop = selection.subscribe(listener);
  const first = selection.getSnapshot();
  peer = { ...peer, messages: [{ id: "new", text: "hello" }] as Message[] };
  publish();
  expect(listener).toHaveBeenCalledTimes(0);
  peer = { ...peer, busy: true };
  publish();
  expect(listener).toHaveBeenCalledTimes(0);
  expect(selection.getSnapshot()).toBe(first);
  const changes = { name: "Renamed", color: "red", mascotBody: "ember", avatarUrl: "/api/attachments/peer.png",
    avatarCrop: "circle", avatarZoom: 2, avatarFocusX: 0.2, avatarFocusY: 0.8 };
  let count = 0;
  for (const [key, value] of Object.entries(changes)) {
    peer = { ...peer, [key]: value };
    publish();
    expect(listener).toHaveBeenCalledTimes(++count);
    expect(selection.getSnapshot().peer).toHaveProperty(key, value);
  }
  stop();
});
