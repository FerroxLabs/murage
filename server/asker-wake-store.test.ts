// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A wake cancellation whose write the disk refused reaches the disk at the retry (Astra build round 6): the store keeps the task's
// field as the disk has it when its save throws, so the retry does not return early on a field already cleared in memory.
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AskerWakes, type AskerWakeIntent } from "./asker-wake.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const onDisk = (botId: string): unknown => (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<{ id: string; tasks?: Array<{ askerWakes?: unknown }> }>)
  .find((bot) => bot.id === botId)?.tasks?.[0]?.askerWakes;
/** The disk refuses writes: the atomic write opens its temporary file in the data directory, and a directory without write permission
 * refuses that (the test user is not root; store.test.ts relies on the same). */
const refuse = (on: boolean) => chmodSync(DATA_DIR, on ? 0o500 : 0o700);

describe("asker wakes on the store", () => {
  beforeEach(() => { removeTempDirSync(DATA_DIR); });
  afterEach(() => { try { refuse(false); } catch { /* gone */ } });

  it("writes a cancellation the disk refused once it takes writes again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const wakes = new AskerWakes((botId, threadId, snapshot) => store.setTaskAskerWakes(botId, threadId, snapshot));
    const intent: AskerWakeIntent = { botId: bot.id, threadId: bot.threadId, depth: 0, coordination: { rootId: "r", path: [bot.id] }, notOwnerAudience: false, unattended: false };
    wakes.register("task-1", intent);
    wakes.deliver("task-1", { toBotId: "mate", toBotName: "Mate", ok: true, messageId: "m1" });
    expect((onDisk(bot.id) as { wakes: unknown[] }).wakes).toHaveLength(1);
    refuse(true);
    expect(() => store.setTaskAskerWakes(bot.id, bot.threadId, undefined)).toThrow();
    expect(store.taskByThread(bot.id, bot.threadId)?.askerWakes).toBeDefined(); // the record says what the disk says
    wakes.drop(bot.threadId, bot.id); // Stop: memory cancels at once, the disk refuses
    expect(wakes.has(bot.threadId)).toBe(false);
    expect((onDisk(bot.id) as { wakes: unknown[] }).wakes).toHaveLength(1);
    expect(wakes.retryWrites()).toBe(false);
    expect((onDisk(bot.id) as { wakes: unknown[] }).wakes).toHaveLength(1);
    refuse(false);
    expect(wakes.retryWrites()).toBe(true); // the retry reaches the disk although memory had already cleared the field
    expect(onDisk(bot.id)).toBeUndefined();
    // a restart after that finds nothing to wake
    const again = new Store(selection);
    expect(again.taskByThread(bot.id, bot.threadId)?.askerWakes).toBeUndefined();
  });
});
