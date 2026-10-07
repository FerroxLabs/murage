// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { messageActor, sameThreadReply, channelReadOnlyReason, unreadTaskLabel } from "./project-presentation";
import { groupActivityRuns } from "./activity-runs";
import { sidebarGroupMark } from "./sidebar-attention";
import type { Message } from "@/state/store";
const message: Message = { id: "m", role: "bot", kind: "activity", at: 1, tool: { name: "queued", ok: true } };
it("honours actorKind before legacy routine, owner, person and bot attribution", () => {
  expect(messageActor({ ...message, actorKind: "murage", routineRunPrompt: { routineName: "Daily" } }, "owner")).toBe("murage");
  expect(messageActor({ ...message, role: "user", routineRunPrompt: { routineName: "Daily" } }, "owner")).toBe("routine");
  expect(messageActor({ ...message, role: "user", origin: "desktop" }, "owner")).toBe("owner");
  expect(messageActor({ ...message, role: "user", origin: "unproven" }, "owner")).toBe("person");
  expect(messageActor({ ...message, role: "user" }, "person")).toBe("person");
  expect(messageActor(message, "owner")).toBe("bot");
});
it("resolves replyTo only in the supplied thread, and never guesses old replies", () => {
  const reply = { ...message, replyToId: "target" };
  expect(sameThreadReply(reply, [message])).toBeUndefined();
  expect(sameThreadReply(reply, [{ ...message, id: "target" }])?.id).toBe("target");
  expect(sameThreadReply(message, [{ ...message, id: "target" }])).toBeUndefined();
});
it("keeps Murage activity and pair-room links out of hidden tool runs", () => {
  const murage: Message = { ...message, actorKind: "murage" };
  const comm: Message = { ...message, id: "c", comm: { groupId: "pair", withBotId: "b", withName: "Bot", withColor: "blue" } };
  const items = groupActivityRuns([murage, { ...murage, id: "next" }, comm]);
  expect(items.map((item) => item.kind)).toEqual(["message", "message", "message"]);
});
it("uses a projected read-only reason, without guessing from bot or message names", () => {
  expect(channelReadOnlyReason({ dm: true, readOnlyReason: "This is a channel person's delegated conversation." })).toContain("delegated");
  expect(channelReadOnlyReason({ dm: true })).toBeNull();
});
it("shows the authoritative decision count before working and honours CA2 working handoffs", () => {
  expect(sidebarGroupMark({ working: true, busyBotId: null })).toEqual({ kind: "working" });
  expect(sidebarGroupMark({ working: true, needsYou: 3 })).toEqual({ kind: "waiting", count: 3 });
});
it("names each task's own unread count", () => {
  expect(unreadTaskLabel({ unreadCount: 3 })).toBe("3 unread");
  expect(unreadTaskLabel({ unreadCount: 0 })).toBe("");
  expect(unreadTaskLabel({ unread: true })).toBe("Unread");
});

it("caps large task unread counts for display", () => {
  expect(unreadTaskLabel({ unreadCount: 120 })).toBe("99+ unread");
});

it("does not revive a cleared server count from a stale unread flag", () => {
  expect(unreadTaskLabel({ unreadCount: 0, unread: true })).toBe("");
});
