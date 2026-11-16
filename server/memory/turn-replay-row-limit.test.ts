// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import type { Message } from "../store.ts";
import { footprintHash, type LineageFootprint } from "./lineage-footprint.ts";
import { DIRECT_REPLAY_LINES_MAX, turnReplayInputs } from "./turn-replay-inputs.ts";

beforeEach(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(() => closeDatabase());

it("the direct row limit bounds terse history and the warmer checks exactly the next turn's lines", () => {
  const history = Array.from({ length: 2000 }, (_, n): Message => ({ id: `line-${n}`, at: n, role: "user", kind: "text", text: "x" }));
  const user: Message = { id: "current", at: 2000, role: "user", kind: "text", text: "now" };
  const run = (rows: Message[], headSlot: number, skip: Set<string>) => {
    const reads: number[] = [];
    const result = turnReplayInputs({
      store: { activeTextLines: (_thread, limit) => { reads.push(limit); return { messages: rows.slice(-limit), hasMore: rows.length > limit, exact: true }; } },
      threadId: "thread", botId: "bot", routeHasTools: true, externalUpdates: [], floor: null, projectCardRun: false, skip, headSlot,
      replayOptions: { maxBytes: 192 * 1024, maxLines: DIRECT_REPLAY_LINES_MAX },
    });
    return { reads, result };
  };
  const turn = run([...history, user], 0, new Set([user.id]));
  const warm = run(history, 1, new Set());
  expect(turn.reads).toEqual([80, 160, DIRECT_REPLAY_LINES_MAX]);
  expect(warm.reads).toEqual(turn.reads.map(n => n - 1));
  expect(turn.result.replayedMessages).toHaveLength(DIRECT_REPLAY_LINES_MAX - 1);
  expect(warm.result.replayedMessages).toEqual(turn.result.replayedMessages);
  expect(turn.result.replayMore).toBe(true);
  expect(turn.result.replayedMessages.at(-1)?.id).toBe(history.at(-1)?.id);
});

it("a warmer footprint for a different replay row limit cannot cover this turn", () => {
  const footprint: LineageFootprint = { botId: "bot", threadId: "thread", accessStamp: "fixture", userKind: "APPENDED", exclude: [], routeHasTools: true, externalUpdates: "[]", maxBytes: 192 * 1024, cursor: null };
  expect(footprintHash({ ...footprint, maxLines: DIRECT_REPLAY_LINES_MAX })).not.toBe(footprintHash(footprint));
  expect(footprintHash({ ...footprint, maxLines: DIRECT_REPLAY_LINES_MAX })).not.toBe(footprintHash({ ...footprint, maxLines: DIRECT_REPLAY_LINES_MAX * 2 }));
});
