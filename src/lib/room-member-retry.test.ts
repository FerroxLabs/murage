// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { roomRetryTarget } from "./room-member-retry";
import type { Message } from "@/state/store";

let n = 0;
const user = (text: string): Message => ({ id: `u${++n}`, at: n, role: "user", kind: "text", text });
const botText = (botId: string, text: string): Message => ({ id: `b${++n}`, at: n, role: "bot", kind: "text", text, from: { botId, name: botId } } as Message);
const failure = (botId: string): Message => ({ id: `e${++n}`, at: n, role: "bot", kind: "activity", tool: { name: "error: not signed in" }, from: { botId, name: botId } } as Message);
const opts = { memberIds: ["ada", "bo"], roomBusy: false };

describe("retry on a room member's failed turn", () => {
  it("targets the member that failed, with the words it was answering", () => {
    const failed = failure("bo");
    const room = [user("plan the launch"), botText("ada", "ok"), user("and the invite list"), failed];
    expect(roomRetryTarget(room, failed, opts)).toEqual({ responderId: "bo", text: "and the invite list" });
  });

  it("does not pick the last message of the room when another member answered after", () => {
    const failed = failure("bo");
    const room = [user("first"), failed, botText("ada", "done"), user("second")];
    expect(roomRetryTarget(room, failed, opts)).toEqual({ responderId: "bo", text: "first" });
  });

  it("offers nothing once the same member has spoken again", () => {
    const failed = failure("bo");
    expect(roomRetryTarget([user("x"), failed, botText("bo", "fine now")], failed, opts)).toBeNull();
  });

  it("offers nothing while the room is busy, for a removed member, or with nothing to answer", () => {
    const failed = failure("bo");
    expect(roomRetryTarget([user("x"), failed], failed, { ...opts, roomBusy: true })).toBeNull();
    expect(roomRetryTarget([user("x"), failed], failed, { memberIds: ["ada"], roomBusy: false })).toBeNull();
    expect(roomRetryTarget([failed], failed, opts)).toBeNull();
  });
});

describe("the room draws the same error card as a direct chat", () => {
  const source = readFileSync(new URL("../components/GroupView.tsx", import.meta.url), "utf8");
  it("renders ErrorRow for a member's failed row, pinned to that member's engine and retry", () => {
    expect(source).toContain("<RoomErrorRow");
    expect(source).toContain("<ErrorRow");
    expect(source).toContain("member.modelSelection.instanceId");
    expect(source).toContain("responderId: target.responderId");
  });
});

describe("room error card details (117)", () => {
  const source = readFileSync(new URL("../components/GroupView.tsx", import.meta.url), "utf8");
  const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
  it("looks the incident up in the room's thread, not the member's direct thread", () => {
    expect(source).toContain("incident={{ threadId: roomThreadId, messageId: message.id }}");
    expect(source).not.toContain("threadId: member.threadId, messageId: message.id");
    expect(source).toContain("roomThreadId={group.threadId}");
  });
  it("labels the button as a fresh send to that member, with no dashes", () => {
    expect(source).toContain('t("room.sendAgainTo", { name: member.name })');
    expect(en["room.sendAgainTo"]).toBe("Send again to {name}");
    expect(en["room.sendAgainTo"]).not.toMatch(/[–—]/);
  });
});
