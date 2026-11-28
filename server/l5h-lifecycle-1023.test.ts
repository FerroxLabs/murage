// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H lifecycle (designs/HOOKS-LINEAGE-1023.md r2 section 1, Fable r1 L2 and r2 L3): an app-origin thread's origin row and turn
// rows leave only with the thread, through the real message-db deleteThread on the real home database, and every other
// thread's rows stay; a refusal in an app automation's Results chat writes its one thread card with the Results chat words,
// not the run words, through the real guard.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, deleteThread } from "./message-db.ts";
import { AppTriggerStore, type AppChildCard } from "./app-trigger-store.ts";
import { APP_CHILD_CARD_TEXT, APP_CHILD_NOT_ALLOWED, APP_CHILD_RESULTS_CARD_TEXT, refuseAppChild, wireAppChildGuard } from "./app-trigger-zero.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const dbs: DatabaseSync[] = [];
beforeEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { wireAppChildGuard(null); for (const db of dbs.splice(0)) db.close(); closeMessageDb(); });

const origin = (store: AppTriggerStore, threadId: string, kind: "run" | "results") =>
  store.putOrigin({ threadId, kind, triggerId: kind === "run" ? "trg-1" : null, routineId: "r-1", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, firstRunId: null, now: 1 });

describe("L5H lifecycle: origin and turn rows leave only with their thread", () => {
  it("D1 deleting an app-origin thread drops its origin row and turn rows, and leaves another thread's rows", () => {
    const store = new AppTriggerStore(database());
    origin(store, "thread-gone", "run");
    origin(store, "thread-kept", "run");
    store.bindTurn("thread-gone", "gen-1", null, 2);
    store.bindTurn("thread-kept", "gen-1", null, 2);
    deleteThread("thread-gone");
    const count = (table: string, threadId: string) => (database().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id=?`).get(threadId) as { n: number }).n;
    expect([count("app_origin_threads", "thread-gone"), count("app_event_turns", "thread-gone")]).toEqual([0, 0]);
    expect([count("app_origin_threads", "thread-kept"), count("app_event_turns", "thread-kept")]).toEqual([1, 1]);
  });
});

describe("L5H L3: the Results chat refusal card has the Results chat words", () => {
  it("L3 an owner turn in a Results chat asks a bot: refused, one thread card with the Results chat text; a run thread keeps the run text", () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const store = new AppTriggerStore(db);
    origin(store, "results-chat", "results");
    origin(store, "run-thread", "run");
    const cards: AppChildCard[] = [];
    wireAppChildGuard({ lineage: store, now: () => 10, onCard: card => { cards.push(card); }, defer: work => work() });
    expect(refuseAppChild({ threadId: "results-chat", generation: "gen-owner-1" }, "ask")?.code).toBe(APP_CHILD_NOT_ALLOWED);
    expect(refuseAppChild({ threadId: "run-thread", generation: "gen-owner-2" }, "ask")?.code).toBe(APP_CHILD_NOT_ALLOWED);
    expect(cards.map(card => [card.id, card.text])).toEqual([
      ["app-child-refusal:thread:results-chat", APP_CHILD_RESULTS_CARD_TEXT],
      ["app-child-refusal:thread:run-thread", APP_CHILD_CARD_TEXT],
    ]);
  });
});
