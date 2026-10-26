// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PATCH a conversation's link (104 item 160), over the real harness server.
import { describe, expect, it } from "vitest";
import { STATE_ONLY_SELECTION, api, desktopApi } from "./testing/index-harness.ts";

describe("PATCH /api/bots/:id/tasks/:threadId with a link", () => {
  const taskOf = async (botId: string, threadId: string) => {
    const state = await desktopApi("GET", "/api/bots");
    return state.body.bots.find((b: { id: string }) => b.id === botId)?.tasks?.find((t: { threadId: string }) => t.threadId === threadId);
  };

  it("assigns, shows and removes an http(s) link; removing it switches suggestions off", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const url = "https://github.com/o/r/pull/7";
    const set = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { link: url });
    expect(set.status).toBe(200);
    expect(set.body.task.link).toBe(url);
    expect((await taskOf(bot.id, bot.threadId)).link).toBe(url);
    const cleared = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { link: null });
    expect(cleared.status).toBe(200);
    const after = await taskOf(bot.id, bot.threadId);
    expect(after.link).toBeUndefined();
    expect(after.linkAuto).toBe(false);
  });

  it("refuses an address that is not http(s)", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    for (const link of ["javascript:alert(1)", "file:///etc/passwd", "nope", 5]) {
      const refused = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { link });
      expect(refused.status).toBe(400);
    }
    expect((await taskOf(bot.id, bot.threadId)).link).toBeUndefined();
  });
});
