// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The failed-turn and empty-turn lines read the closing turn's rows on every eligible completion (index.ts turn.completed). That
// read goes through the turn index (store.turnRowsBounded), so a loaded conversation of 3,000 rows costs the same statements and
// rows as one of 20, and the loaded history is never filtered. Murage's own retry note, persisted as the fold writes it, is not
// something the engine produced.
import { beforeAll, expect, it } from "vitest";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { prepareThread } from "./branch-store.ts";
import { Store, type Message } from "./store.ts";
import { murageLine } from "./murage-line.ts";
import { turnProducedSomething, turnWroteText, wantsEmptyTurnLine } from "./failed-turn-line.ts";
import { expectSameReads, measureReads } from "./testing/bounded-reads.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
let store: Store, small: string, large: string;
type Loaded = { threads: Map<string, { messages: Message[] }> };

function seed(threadId: string, history: number) {
  for (let i = 0; i < history; i++) store.appendMessage(threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `earlier ${i}`, ...(i % 2 ? { turnId: `old-${i}` } : {}) });
  store.appendMessage(threadId, { role: "user", kind: "text", text: "hi", turnId: "turn-1" });
  // turn.retrying as the fold persists it (index.ts pushMessage): an activity row with no provider reply, stamped murageLine,
  // carrying the turn's id, with no actorKind
  const retry: Omit<Message, "id" | "at"> = { role: "bot", kind: "activity", turnId: "turn-1", tool: { name: "retrying: attempt 2/3 in 5s: overloaded", ok: true } };
  store.appendMessage(threadId, murageLine(retry));
  store.appendMessage(threadId, { role: "bot", kind: "text", text: "  ", turnId: "turn-1" });
}

beforeAll(async () => {
  removeTempDirSync(DATA_DIR);
  store = new Store(selection);
  small = store.createBot({ name: "Twenty" }).threadId;
  large = store.createBot({ name: "Three thousand" }).threadId;
  for (const [threadId, history] of [[small, 20], [large, 3_000]] as const) {
    store.messagesFor(threadId);
    await prepareThread(threadId);
    seed(threadId, history);
  }
}, 120_000);

it("reads the closing turn's rows through the turn index: same reads at 20 and 3,000 rows, the loaded history never filtered", async () => {
  const threads = (store as unknown as Loaded).threads;
  const outcomes = [];
  const reads = [];
  for (const threadId of [small, large]) {
    const loaded = threads.get(threadId);
    expect(loaded, "the thread is loaded, the case the old filter scaled with").toBeDefined();
    // the history array must not be walked: a filter over it now throws
    Object.defineProperty(loaded!.messages, "filter", { configurable: true, value: () => { throw new Error("filtered the loaded history"); } });
    try {
      const { result, reads: measured } = await measureReads(threadId, join(DATA_DIR, "messages.db"), () => store.turnRowsBounded(threadId, "turn-1"));
      reads.push(measured);
      outcomes.push({ rows: result.length, produced: turnProducedSomething(result), wroteText: turnWroteText(result) });
      expect(result.find((row) => row.kind === "activity")).toMatchObject({ murageLine: true, turnId: "turn-1" });
    } finally {
      delete (loaded!.messages as { filter?: unknown }).filter;
    }
  }
  expect(outcomes).toEqual([{ rows: 3, produced: false, wroteText: false }, { rows: 3, produced: false, wroteText: false }]);
  expectSameReads(reads[0], reads[1]);
});

it("a retry note and an empty finished reply still get the empty-turn line", () => {
  const rows = store.turnRowsBounded(large, "turn-1");
  const direct = { directOwnerTurn: true, replacementOwnsThread: false, delegated: false, routine: false, lateRedispatch: false, errorShown: false, failureRowShown: false };
  expect(wantsEmptyTurnLine({ ok: true, stopReason: "end_turn" }, { ...direct, produced: turnProducedSomething(rows) })).toBe(true);
});
