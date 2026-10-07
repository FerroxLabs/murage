// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { messageActorKind } from "./message-actor.ts";

describe("messageActorKind (SPEC-P 10 back-compat order)", () => {
  it("prefers the stored kind", () => {
    expect(messageActorKind({ role: "user", actorKind: "person" }, true)).toBe("person");
    expect(messageActorKind({ role: "bot", actorKind: "murage", from: { botId: "x" } }, true)).toBe("murage");
  });
  it("reads a legacy routine prompt as the routine, whatever its role", () => {
    expect(messageActorKind({ role: "user", routineRunPrompt: { trigger: "schedule", routineName: "R" } }, true)).toBe("routine");
  });
  it("reads the owner only in the owner's thread from a proven surface", () => {
    expect(messageActorKind({ role: "user", origin: "desktop" }, true)).toBe("owner");
    expect(messageActorKind({ role: "user" }, true)).toBe("owner");
    expect(messageActorKind({ role: "user", origin: "unproven" }, true)).toBe("person");
    expect(messageActorKind({ role: "user", origin: "desktop" }, false)).toBe("person");
  });
  it("reads a bot row with a sender as the bot, and one without as Murage", () => {
    expect(messageActorKind({ role: "bot", from: { botId: "x" } }, true)).toBe("bot");
    expect(messageActorKind({ role: "bot" }, true)).toBe("murage");
  });
});
