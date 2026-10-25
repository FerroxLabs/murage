// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "./store";

describe("the All chats view state", () => {
  it("opens unfiltered, or filtered to the bot or channel it was expanded from, and closes back to the chat", () => {
    const open = reducer({ ...initialState, settingsOpen: true }, { type: "showAllChats" });
    expect(open.activeView).toBe("all-chats");
    expect(open.allChatsScope).toBeUndefined();
    expect(open.settingsOpen).toBe(false);
    expect(reducer(initialState, { type: "showAllChats", botId: "ember" }).allChatsScope).toEqual({ botId: "ember" });
    expect(reducer(initialState, { type: "showAllChats", groupId: "move" }).allChatsScope).toEqual({ groupId: "move" });
    const closed = reducer(reducer(initialState, { type: "showAllChats", botId: "ember" }), { type: "closeAllChats" });
    expect(closed.activeView).toBe("chat");
    expect(closed.allChatsScope).toBeUndefined();
    // closing from elsewhere changes nothing
    const map = { ...initialState, activeView: "team-map" as const };
    expect(reducer(map, { type: "closeAllChats" })).toBe(map);
  });
});
