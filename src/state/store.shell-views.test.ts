// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.13 shell views (lane L2A, HANDOFF-1013-UX-L2A.md shell contract):
// Today, Needs you (with its tab) and Health, and where a launch lands.
import { describe, expect, it } from "vitest";
import { initialState, landsOnToday, reducer } from "./store";

const overlays = { settingsOpen: true, computerOpen: true, inspectorOpen: true, appSettingsOpen: true, pluginsOpen: true };
const closed = { settingsOpen: false, computerOpen: false, inspectorOpen: false, appSettingsOpen: false, pluginsOpen: false };

describe("shell views", () => {
  it("opens Today, Needs you and Health, closing what was open over the chat", () => {
    expect(reducer({ ...initialState, ...overlays }, { type: "showToday" })).toMatchObject({ activeView: "today", ...closed });
    expect(reducer({ ...initialState, ...overlays }, { type: "showHealth" })).toMatchObject({ activeView: "health", ...closed });
    expect(reducer({ ...initialState, ...overlays }, { type: "showNeedsYou" })).toMatchObject({ activeView: "needs-you", needsYouTab: "decisions", ...closed });
  });

  it("opens Needs you on the tab asked for, and changes tab without leaving the page", () => {
    const results = reducer(initialState, { type: "showNeedsYou", tab: "results" });
    expect(results.needsYouTab).toBe("results");
    const approvals = reducer(results, { type: "setNeedsYouTab", tab: "approvals" });
    expect(approvals).toMatchObject({ activeView: "needs-you", needsYouTab: "approvals" });
    expect(reducer(approvals, { type: "setNeedsYouTab", tab: "approvals" })).toBe(approvals);
    // a door press goes back to the umbrella
    expect(reducer(approvals, { type: "showNeedsYou" }).needsYouTab).toBe("decisions");
  });

  it("goes back to the chat when a chat is picked", () => {
    const state = { ...initialState, bots: [{ id: "nova", threadId: "t", name: "Nova", messages: [] } as never], activeView: "today" as const };
    expect(reducer(state, { type: "select", id: "nova" }).activeView).toBe("chat");
  });
});

describe("where a launch lands", () => {
  it("lands a returning owner on Today, once, on the first roster", () => {
    expect(landsOnToday({ hydrated: false, activeView: "chat", conversationPicks: 0 }, "nova")).toBe(true);
    expect(landsOnToday({ hydrated: true, activeView: "chat", conversationPicks: 0 }, "nova")).toBe(false);
  });
  it("keeps a fresh install (no saved conversation: setup not finished) on the Chief's chat", () => {
    expect(landsOnToday({ hydrated: false, activeView: "chat", conversationPicks: 0 }, undefined)).toBe(false);
  });
  it("lets a pick or another view that came first win", () => {
    expect(landsOnToday({ hydrated: false, activeView: "chat", conversationPicks: 1 }, "nova")).toBe(false);
    expect(landsOnToday({ hydrated: false, activeView: "routines", conversationPicks: 0 }, "nova")).toBe(false);
  });
});
