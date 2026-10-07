// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 low (Windows RE-TEST 4 L2): a channel whose setup was never
// finished is left out of "Choose a channel", and the picker said "Create a
// channel from the sidebar first" about a channel sitting in the sidebar.
import { describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { goalChannelHint } = await import("./RoutineCalendarPage");

const channel = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, name, memberIds: [], messages: [], ...extra }) as never;

describe("the team-goal channel picker's empty state", () => {
  it("names a channel waiting on setup instead of telling them to create one", () => {
    expect(goalChannelHint([channel("Studio room", { setupCompletedAt: null, setupSkippedAt: null })]))
      .toBe("Studio room needs its setup finished before it can run a goal. Open it in the sidebar, finish setup, then come back.");
    expect(goalChannelHint([channel("A", { setupCompletedAt: null }), channel("B", { setupCompletedAt: null })]))
      .toBe("A and B need their setup finished before they can run a goal. Open one in the sidebar, finish setup, then come back.");
  });

  it("still asks for a channel when there is none, and ignores archived channels and direct messages", () => {
    expect(goalChannelHint([])).toBe("Create a channel from the sidebar first, then come back to schedule its goal.");
    expect(goalChannelHint([channel("Old", { setupCompletedAt: null, hidden: true }), channel("dm", { dm: true })]))
      .toBe("Create a channel from the sidebar first, then come back to schedule its goal.");
  });
});
