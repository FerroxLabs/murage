// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyNotificationPreferences, resolveNotificationPreferences } from "../../shared/notification-preferences.ts";
import { buildWaitingNotification, waitingPushSentence } from "./waiting-push.ts";

const bot = { id: "sable", name: "Sable", threadId: "t1" };
const lookup = (id: string) => (id === "sable" ? bot : undefined);
const at = new Date("2026-09-06T12:00:00Z");

describe("memories waiting push", () => {
  it("says a count and the bot's name only", () => {
    expect(waitingPushSentence("Sable", 11)).toBe("Sable would like to remember 11 things");
    expect(waitingPushSentence("Sable", 1)).toBe("Sable would like to remember 1 thing");
    const frame = buildWaitingNotification({ subject: "bot", id: "sable", name: "Sable", waiting: 11 }, lookup);
    expect(frame).toMatchObject({ kind: "memories-waiting", title: "Memories waiting for you", body: "Sable would like to remember 11 things" });
  });
  it("stays quiet for rooms, unknown bots and bots with notifications off", () => {
    expect(buildWaitingNotification({ subject: "room", id: "sable", name: "x", waiting: 3 }, lookup)).toBeNull();
    expect(buildWaitingNotification({ subject: "bot", id: "gone", name: "x", waiting: 3 }, lookup)).toBeNull();
    expect(buildWaitingNotification({ subject: "bot", id: "sable", name: "Sable", waiting: 3 }, () => ({ ...bot, notifications: false }))).toBeNull();
  });
  it("is on by default and the preference switches it off", () => {
    expect(resolveNotificationPreferences().memories).toBe(true);
    const frame = buildWaitingNotification({ subject: "bot", id: "sable", name: "Sable", waiting: 4 }, lookup)!;
    expect(applyNotificationPreferences(frame, undefined, at)).toBe(frame);
    expect(applyNotificationPreferences(frame, { memories: false }, at)).toBeNull();
    expect(applyNotificationPreferences(frame, { attention: false }, at)).toBe(frame);
  });
  it("hides even the name when previews are off", () => {
    const frame = buildWaitingNotification({ subject: "bot", id: "sable", name: "Sable", waiting: 4 }, lookup)!;
    expect(applyNotificationPreferences(frame, { previewContent: false }, at)).toMatchObject({ title: "Murage", body: "Memories are waiting for you.", privatePreview: true });
  });
});
