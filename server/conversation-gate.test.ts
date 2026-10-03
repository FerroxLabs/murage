// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { conversationSubject, isConversationRoute } from "./conversation-gate.ts";

describe("which paths are conversation routes", () => {
  it.each([
    "/api/bots", "/api/bots/b1", "/api/bots/b1/messages", "/api/bots/b1/interrupt", "/api/bots/b1/tasks/t1",
    "/api/threads/t1/messages", "/api/threads/t1/export", "/api/threads/t1/respond", "/api/threads/t1/messages/m1/image",
    "/api/groups", "/api/groups/g1", "/api/groups/g1/messages", "/api/groups/g1/interrupt",
    "/api/search", "/api/events",
  ])("%s is gated", (path) => expect(isConversationRoute(path)).toBe(true));

  it.each([
    "/api/health", "/api/config", "/api/internal/memory/save", "/api/box/exec", "/api/repo/status", "/api/opencode/x",
    "/api/botsx", "/api/threadsx/1", "/api/groupsx", "/api/searches", "/api/events/extra", "/api/desktop-secret", "/api/attachments/a.png",
  ])("%s is not", (path) => expect(isConversationRoute(path)).toBe(false));
});

describe("which conversation a path acts on", () => {
  it("names the bot, room or thread", () => {
    expect(conversationSubject("/api/bots/b1/messages")).toEqual({ scope: "bot", botId: "b1" });
    expect(conversationSubject("/api/groups/g1/interrupt")).toEqual({ scope: "group", groupId: "g1" });
    expect(conversationSubject("/api/threads/t-1/export")).toEqual({ scope: "thread", threadId: "t-1" });
    expect(conversationSubject("/api/bots")).toBeNull();
    expect(conversationSubject("/api/search")).toBeNull();
  });
});
