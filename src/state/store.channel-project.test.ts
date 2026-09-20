// The two things a channel gained in 0.1.57: it can be filed away, and it
// can be given a purpose. Both arrive through the same patchGroup action,
// and they behave differently on purpose — one is a boolean the client
// already knows the final value of, the other is an input the SERVER turns
// into the stored block. This file pins that difference down.
import { describe, expect, it } from "vitest";

import { initialState, reducer, type Group } from "./store";

const channel = {
  id: "room",
  threadId: "t1",
  name: "Website launch",
  memberIds: ["bot-1"],
  defaultResponder: { kind: "everyone" },
  bulletin: "",
  unread: false,
  createdAt: 1,
  messages: [],
} satisfies Group;

const withChannel = (group: Group = channel) => ({ ...initialState, groups: [group] });

describe("archiving a channel", () => {
  it("takes the row off the list the moment it is asked for, without waiting on the server", () => {
    const next = reducer(withChannel(), { type: "patchGroup", groupId: "room", patch: { hidden: true } });
    expect(next.groups[0]?.hidden).toBe(true);
  });

  it("brings it back when the flag is cleared", () => {
    const archived = reducer(withChannel(), { type: "patchGroup", groupId: "room", patch: { hidden: true } });
    const restored = reducer(archived, { type: "patchGroup", groupId: "room", patch: { hidden: false } });
    expect(restored.groups[0]?.hidden).toBe(false);
  });

  it("keeps every message: archiving files the channel away, it does not empty it", () => {
    const talked = { ...channel, messages: [{ id: "m1", role: "user", text: "hello", at: 1 }] } as Group;
    const next = reducer(withChannel(talked), { type: "patchGroup", groupId: "room", patch: { hidden: true } });
    expect(next.groups[0]?.messages).toHaveLength(1);
  });
});

describe("giving a channel a purpose", () => {
  // The wire carries a goal. The stored block carries a goal, a status and
  // three timestamps, and only the server may write those. Merging the input
  // optimistically would put a half-built block on screen — a project with
  // no status — so this one field waits for the reply.
  it("does not write a goal-only block into local state", () => {
    const next = reducer(withChannel(), {
      type: "patchGroup",
      groupId: "room",
      patch: { channelProject: { goal: "Open the new site by spring" } },
    });
    expect(next.groups[0]?.channelProject).toBeUndefined();
  });

  it("still applies everything else in the same patch", () => {
    const next = reducer(withChannel(), {
      type: "patchGroup",
      groupId: "room",
      patch: { name: "Spring launch", channelProject: { goal: "Open the new site" } },
    });
    expect(next.groups[0]?.name).toBe("Spring launch");
    expect(next.groups[0]?.channelProject).toBeUndefined();
  });

  it("takes the whole block from the server frame the PATCH reply produces", () => {
    const next = reducer(withChannel(), {
      type: "groupPatched",
      group: {
        id: "room",
        channelProject: { goal: "Open the new site", status: "active", startedAt: 10, updatedAt: 10 },
      },
    });
    expect(next.groups[0]?.channelProject).toEqual({
      goal: "Open the new site",
      status: "active",
      startedAt: 10,
      updatedAt: 10,
    });
    // and the chat it already had is untouched
    expect(next.groups[0]?.messages).toEqual([]);
    expect(next.groups[0]?.name).toBe("Website launch");
    expect(next.groups[0]?.bulletin).toBe("");
  });

  it("clears the purpose when the server says there is none, leaving the channel intact", () => {
    const project = {
      ...channel,
      channelProject: { goal: "Open the new site", status: "active" as const, startedAt: 10, updatedAt: 10 },
    } satisfies Group;
    const next = reducer(withChannel(project), {
      type: "groupPatched",
      group: { id: "room", channelProject: undefined },
    });
    expect(next.groups[0]?.channelProject).toBeUndefined();
    expect(next.groups[0]?.memberIds).toEqual(["bot-1"]);
  });
});
