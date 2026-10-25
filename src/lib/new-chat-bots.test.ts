// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { newChatBots } from "./new-chat-bots";

const bots = [
  { id: "a", name: "Ada", sidebarLine: { at: 5 } },
  { id: "b", name: "Bea", sidebarLine: { at: 50 } },
  { id: "c", name: "Cy" },
  { id: "chief", name: "Sable", chiefOfStaff: true, chiefScope: "workspace" as const },
  { id: "gone", name: "Archive", hidden: true },
  { id: "d", name: "Dee" },
];

describe("new chat bot list", () => {
  it("puts the Chief first, then the most recent, then by name; archived bots are left out", () => {
    expect(newChatBots(bots, "").map((b) => b.id)).toEqual(["chief", "b", "a", "c", "d"]);
  });
  it("filters by name with prefix matches first", () => {
    expect(newChatBots([{ id: "1", name: "Mia Ada" }, { id: "2", name: "Ada" }], "ad").map((b) => b.id)).toEqual(["2", "1"]);
    expect(newChatBots(bots, "zzz")).toEqual([]);
  });
  it("every visible bot is offered", () => {
    expect(newChatBots(bots, "")).toHaveLength(5);
  });
});

import { hasEmptyConversation } from "./new-chat-bots";

describe("reusing an empty conversation", () => {
  it("is empty only with no sidebar line and no rows", () => {
    expect(hasEmptyConversation({ messages: [] })).toBe(true);
    expect(hasEmptyConversation({})).toBe(true);
    expect(hasEmptyConversation({ sidebarLine: { at: 1 } })).toBe(false);
    expect(hasEmptyConversation({ messages: [{}] })).toBe(false);
  });
});
