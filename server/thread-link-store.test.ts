// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The link a conversation carries (104 item 160): suggested from the bot's own
// pull request, never over a person's choice.
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const PR = "https://github.com/o/r/pull/12";

describe("Store.suggestTaskLink", () => {
  beforeEach(() => { removeTempDirSync(DATA_DIR); });

  it("links the last pull request the bot named, on its own", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.suggestTaskLink(bot.id, bot.threadId, `Opened https://github.com/o/r/pull/3 and then ${PR}.`);
    expect(task?.link).toBe(PR);
    expect(task?.linkAuto).toBe(true);
    expect(store.suggestTaskLink(bot.id, bot.threadId, PR)).toBeNull();
  });

  it("never overwrites a link the person chose", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, { link: "https://example.com/mine", linkAuto: undefined });
    expect(store.suggestTaskLink(bot.id, bot.threadId, PR)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.link).toBe("https://example.com/mine");
  });

  it("stays off after the person removes the suggestion", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.suggestTaskLink(bot.id, bot.threadId, PR);
    store.patchTask(bot.id, bot.threadId, { link: undefined, linkAuto: false });
    expect(store.suggestTaskLink(bot.id, bot.threadId, "https://github.com/o/r/pull/99")).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.link).toBeUndefined();
  });

  it("ignores text with no pull request", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.suggestTaskLink(bot.id, bot.threadId, "See https://example.com and https://github.com/o/r/issues/3")).toBeNull();
  });

  it("links a merge request on an unknown host only when the folder's remote names that host", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const text = "Opened https://git.example.org/team/repo/-/merge_requests/8";
    expect(store.suggestTaskLink(bot.id, bot.threadId, text)).toBeNull();
    expect(store.suggestTaskLink(bot.id, bot.threadId, text, ["git.example.org"])?.link).toBe("https://git.example.org/team/repo/-/merge_requests/8");
  });
});
