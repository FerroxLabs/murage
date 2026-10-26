// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K / SL-I in the window: what the owner sees for chats that follow
// their bot, the limit offer card, Refresh permissions and limit waits.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { scheduleAt } from "@/lib/routine-calendar";
import { pendingApprovals } from "./PendingApproval";
import { PermissionModeMenu } from "./PermissionModeMenu";
import { isLimitOfferCard, limitWaitLabel, ownModelChats, ownModelLine } from "./ThreadFollowControls";

const limitCard = (answered?: string): Message => ({
  id: "m1", role: "bot", kind: "options", text: "", ts: 0,
  card: {
    title: "Claude is at its limit until 3:00 PM.", subtitle: "Pick an engine to answer your message now, or wait for the limit to reset.",
    options: ["Codex (your plan)", "Wait"], requestId: "limit-1", tool: "murage_limit_offer", ...(answered ? { answered } : {}),
    limitOffer: { sourceMessageId: "u1", from: { instanceId: "claude", model: "opus" }, resetsAt: null, choices: [{ label: "Codex (your plan)", selection: { instanceId: "codex", model: "gpt" }, billing: "own-subscription" }], nextTimeLabel: "Also use it next time", routinesLabel: "Also for routines" },
  },
} as unknown as Message);

describe("chats that follow their bot", () => {
  it("counts only chats with a model of their own and says so", () => {
    expect(ownModelChats({ tasks: [{ followsBotModel: true }, { followsBotModel: false }, { followsBotModel: false }] as never })).toBe(2);
    expect(ownModelLine(2)).toBe("2 chats use their own model");
    expect(ownModelLine(1)).toBe("1 chat uses its own model");
  });
});

describe("the limit offer card", () => {
  it("is its own card, never a permission waiting in the approval queue or read out on a call", () => {
    expect(isLimitOfferCard(limitCard())).toBe(true);
    expect(pendingApprovals([limitCard()])).toEqual([]);
  });
});

describe("Refresh permissions", () => {
  it("sits under the levels in the composer's menu when the composer passes it", () => {
    const html = renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Ember", current: "ask", desktop: true, onPick: () => {}, footer: createElement("div", { "data-refresh-permissions": "" }, "Refresh permissions") }));
    expect(html).toContain("Refresh permissions");
  });
});

describe("routine limit waits", () => {
  it("names the engine a run is waiting on", () => {
    expect(limitWaitLabel("engine:claude", [{ instanceId: "claude", displayName: "Claude Code" }])).toBe("waiting for a limit on Claude Code");
    expect(limitWaitLabel("connection:abc", [])).toBe("waiting for a limit on a connected account");
  });
  it("a limit reset routine is not moved by dragging its marker", () => {
    expect(scheduleAt({ type: "limit_reset", engineKey: "engine:claude" }, 0, 1000)).toEqual({ type: "limit_reset", engineKey: "engine:claude" });
  });
});
