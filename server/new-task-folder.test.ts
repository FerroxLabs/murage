// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A new conversation can start in a chosen folder (104 item 154): the same
// desktop authority and validation as changing the folder afterwards.
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_ONLY_SELECTION, api, desktopApi, home, phoneApi } from "./testing/index-harness.ts";

describe("POST /api/bots/:id/tasks with a folder", () => {
  const tasksOf = async (id: string): Promise<Array<{ threadId: string; cwd?: string }>> => {
    const state = await desktopApi("GET", "/api/bots");
    return state.body.bots.find((b: { id: string }) => b.id === id)?.tasks ?? [];
  };

  it("pins a valid folder on the new task from the start", async () => {
    const project = realpathSync.native(mkdtempSync(join(home, "new-task-folder-")));
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const made = await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { cwd: project });
    expect(made.status).toBe(201);
    expect(made.body.task.cwd).toBe(project);
    const task = (await tasksOf(bot.id)).find((t) => t.threadId === made.body.task.threadId);
    expect(task?.cwd).toBe(project);
  });

  it("refuses a relative, missing or non-folder path and creates no task", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const count = (await tasksOf(bot.id)).length;
    for (const cwd of ["relative/path", join(home, "does-not-exist-104"), 42]) {
      const refused = await desktopApi("POST", `/api/bots/${bot.id}/tasks`, { cwd });
      expect(refused.status).toBe(400);
    }
    expect((await tasksOf(bot.id)).length).toBe(count);
  });

  it("answers not found from a paired device and creates no task", async () => {
    const project = realpathSync.native(mkdtempSync(join(home, "new-task-folder-phone-")));
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const count = (await tasksOf(bot.id)).length;
    const refused = await phoneApi("POST", `/api/bots/${bot.id}/tasks`, { cwd: project });
    expect(refused.status).toBe(404);
    expect((await tasksOf(bot.id)).length).toBe(count);
  });

  it("a new task without a folder is unchanged", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const made = await api("POST", `/api/bots/${bot.id}/tasks`, {});
    expect(made.status).toBe(201);
    expect(made.body.task.cwd).toBeUndefined();
  });
});
