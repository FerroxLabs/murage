// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { initialState, reducer, type Group, type Message } from "./store";
const group: Group = { id: "g", name: "Room", threadId: "t1", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [], tasks: [{ threadId: "t1", title: "One", createdAt: 1 }, { threadId: "t2", title: "Two", createdAt: 2 }] };
const message: Message = { id: "m", role: "bot", kind: "text", text: "Done", at: 3 };
it("uses server task counts and leaves legacy records at zero", () => {
  let state = { ...initialState, groups: [group], selectedId: "g" };
  state = reducer(state, { type: "messageAdded", threadId: "t2", message });
  expect(state.groups[0].tasks?.[1].unreadCount ?? 0).toBe(0);
  expect(state.groups[0].messages).toEqual([]);
  state = reducer(state, { type: "messageAdded", threadId: "t2", message });
  expect(state.groups[0].tasks?.[1].unreadCount ?? 0).toBe(0);
  state = reducer(state, { type: "groupPatched", group: { ...group, threadId: "t2", messages: [message] } });
  expect(state.groups[0].tasks?.[1].unreadCount).toBe(0);
});
it("does not count the active visible task or tool-only work", () => {
  const state = { ...initialState, groups: [group], selectedId: "g" };
  expect(reducer(state, { type: "messageAdded", threadId: "t1", message }).groups[0].tasks?.[0].unreadCount ?? 0).toBe(0);
  expect(reducer(state, { type: "messageAdded", threadId: "t2", message: { ...message, kind: "activity" } }).groups[0].tasks?.[1].unreadCount ?? 0).toBe(0);
});

it("does not add local counts after a durable server snapshot", () => {
  const durable = { ...group, tasks: group.tasks!.map(task => ({ ...task, unreadCount: task.threadId === "t2" ? 3 : 0 })) };
  let state: typeof initialState = { ...initialState, groups: [durable], selectedId: "g" };
  state = reducer(state, { type: "messageAdded", threadId: "t2", message });
  expect(state.groups[0].tasks?.[1].unreadCount).toBe(3);
  state = reducer(state, { type: "groupPatched", group: { ...durable, tasks: durable.tasks.map(task => ({ ...task, unreadCount: 0 })) } });
  expect(state.groups[0].tasks?.[1].unreadCount).toBe(0);
});
