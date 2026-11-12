// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "../config.ts";
import { setImmediate as immediate } from "node:timers/promises";
import { closeDatabase } from "../database.ts";
import type { Message } from "../store.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { turnReplayInputs, type TurnReplayInputsArgs } from "./turn-replay-inputs.ts";

const rows = (n: number): Message[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: "x" }));
const args = (messages: Message[], reads: number[] = []): Omit<TurnReplayInputsArgs, "cooperative"> => ({
  store: { activeTextLines: (_thread, limit) => { reads.push(limit); return { messages: messages.slice(-limit), hasMore: messages.length > limit, exact: true }; } },
  threadId: "chat", botId: "bot", routeHasTools: true, externalUpdates: [], floor: null, projectCardRun: false,
  skip: new Set(), replayOptions: { maxBytes: 192 * 1024 },
});
beforeEach(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(() => closeDatabase());

describe("ALL.eld250: bounded cooperative transcript preparation", () => {
  it.each(["short", "skipped", "held", "project"])("bounds %s history even when the byte window cannot fill", kind => {
    const messages = rows(20_000), reads: number[] = [], input = args(messages, reads);
    if (kind === "skipped") input.skip = new Set(messages.map(m => m.id));
    if (kind === "held") { input.routeHasTools = false; messages.forEach(m => { m.inboundKind = "action"; }); }
    if (kind === "project") input.projectCardRun = true;
    const result = turnReplayInputs(input);
    expect(Math.max(...reads), "no read may grow past 1280 indexed text lines").toBeLessThanOrEqual(1280);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2480);
    expect(result.replayMore, "the existing earlier-lines notice must remain true").toBe(true);
    expect(result.tailIds.has("m19999")).toBe(true);
    if (kind === "short") expect(result.replayedMessages.at(-1)?.id).toBe("m19999");
    else expect(result.replayedMessages).toEqual([]);
  });

  it("services the event loop between bounded privacy/floor batches, with the same result as the warmer", async () => {
    const messages = rows(600), input = args(messages);
    let ticks = 0, lastTick = 0, maxBatch = 0;
    input.floor = batch => {
      maxBatch = Math.max(maxBatch, batch.length);
      expect(ticks, "I/O must run before each privacy batch").toBeGreaterThan(lastTick);
      lastTick = ticks;
      return undefined;
    };
    let running = true;
    const pulse = async () => { while (running) { await immediate(); ticks++; } };
    const heartbeat = pulse();
    try {
      const cooperative = { ...input, cooperative: true as const };
      const result = await turnReplayInputs(cooperative);
      expect(maxBatch).toBeLessThanOrEqual(40);
      expect(result).toEqual(turnReplayInputs({ ...args(messages) }));
    } finally { running = false; await heartbeat; }
  });
  it("keeps the warmer head slot and floor stand-ins at the row cap", async () => {
    const messages = rows(2000), user = { ...messages[0]!, id: "U" };
    const turnArgs = { ...args([...messages, user]), skip: new Set(["U"]), cooperative: true as const };
    const turn = await turnReplayInputs(turnArgs);
    const warm = turnReplayInputs({ ...args(messages), headSlot: 1 });
    expect(warm.window).toBe(turn.window);
    expect(warm.replayedMessages).toEqual(turn.replayedMessages);
    expect(warm.replayMore).toBe(true);
    const floorInput = args(messages);
    floorInput.floor = batch => ({
      messages: batch.map(m => m.role === "bot" ? { ...m, text: "withheld fixture" } : m),
      withheld: new Set(batch.filter(m => m.role === "bot").map(m => m.id)),
      forgotten: new Set(), checking: new Set(), checked: new Set(batch.map(m => m.id)),
    });
    const sync = turnReplayInputs(floorInput);
    const asyncResult = await turnReplayInputs({ ...floorInput, cooperative: true });
    expect(asyncResult).toEqual(sync);
    expect(asyncResult.replayFloor?.checked.size).toBe(1280);
    expect(asyncResult.replayFloor?.withheld.size).toBe(640);
    expect(asyncResult.replayedMessages.filter(m => m.role === "bot").every(m => m.text === "withheld fixture")).toBe(true);
  });

});
