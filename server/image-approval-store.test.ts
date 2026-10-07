// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The Images setting and its guard on disk: they survive a restart, an older
// record carries neither (so it follows the permission level, no limit), and a
// hand-edited or corrupt value is dropped on load rather than trusted.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const disk = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe("Images setting persistence", () => {
  it("is absent on a new bot and on every older record", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.imageApproval).toBeUndefined();
    expect(bot.imageAskAfter).toBeUndefined();
    expect(Object.keys(disk()[0])).not.toContain("imageApproval");
    expect(new Store(selection).bot(bot.id)?.imageApproval).toBeUndefined();
  });

  it("survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { imageApproval: "allow", imageAskAfter: 3 });
    const reloaded = new Store(selection).bot(bot.id);
    expect(reloaded).toMatchObject({ imageApproval: "allow", imageAskAfter: 3 });
  });

  it("drops anything but an exact ask or allow, and a whole number from 1 to 50, when it loads", () => {
    const store = new Store(selection);
    const ids = ["ask", "allow", "follow", "ALLOW", "yes", "true"].map(() => store.createBot().id);
    const counts = [1, 50, 0, 51, 2.5, "3"].map(() => store.createBot().id);
    const values: unknown[] = ["ask", "allow", "follow", "ALLOW", "yes", true];
    const countValues: unknown[] = [1, 50, 0, 51, 2.5, "3"];
    const raw = disk();
    ids.forEach((id, index) => { raw.find(bot => bot.id === id)!.imageApproval = values[index]; });
    counts.forEach((id, index) => { raw.find(bot => bot.id === id)!.imageAskAfter = countValues[index]; });
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(ids.map(id => reloaded.bot(id)?.imageApproval)).toEqual(["ask", "allow", undefined, undefined, undefined, undefined]);
    expect(counts.map(id => reloaded.bot(id)?.imageAskAfter)).toEqual([1, 50, undefined, undefined, undefined, undefined]);
    // and the file is rewritten without them
    const saved = disk();
    for (const id of ids.slice(2)) expect(saved.find(bot => bot.id === id)).not.toHaveProperty("imageApproval");
    for (const id of counts.slice(2)) expect(saved.find(bot => bot.id === id)).not.toHaveProperty("imageAskAfter");
    expect(saved.find(bot => bot.id === ids[0])).toHaveProperty("imageApproval", "ask");
  });
});
