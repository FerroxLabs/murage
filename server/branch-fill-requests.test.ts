// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Request paths never fill a thread (1.0.2 RC3 P1 #1). A search's branch membership, the first screen's cards outside the page and
// the inbox's project approvals, asked of a thread that is not prepared yet, read the same statements on 1,000 messages as on
// 200,000, never call prepareThreadSync, and queue the thread at the front of the background fill. The background pass then fills
// it in short slices, says so (onThreadCardsReady), and the thread reads through the index; a turn waits on the same fill.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database } from "./database.ts";
import { nextQueuedFill, prepareStats } from "./branch-fill.ts";
import { BOUNDED_WALK_ROWS, isPrepared, prepareThread } from "./branch-store.ts";
import { Store } from "./store.ts";
import { onThreadCardsReady, runTranscriptBackfill } from "./transcript-backfill.ts";
import { expectSameReads, measureReads } from "./testing/bounded-reads.ts";
import * as messages from "./message-db.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
let store: Store, side: DatabaseSync, small: string, large: string;

function chain(threadId: string, count: number) {
  side.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, 'c-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
      json_object('id','c-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v,'parentId',CASE WHEN v=1 THEN NULL ELSE 'c-'||(v-1) END) FROM n`).run(count, threadId);
  // an abandoned branch near the start: a sibling of c-3 that is not on the branch of the head
  const fork = { id: "fork", at: 1700000000003, role: "user", kind: "text", text: "fork", parentId: "c-2" };
  side.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(threadId, "fork", fork.at, "user", "text", "fork", JSON.stringify(fork));
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `c-${count}`);
  side.prepare("DELETE FROM thread_key WHERE thread_id=?").run(threadId);
}

beforeAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  store = new Store(selection);
  small = store.createBot({ name: "Thousand" }).threadId; large = store.createBot({ name: "Two hundred thousand" }).threadId;
  side = new DatabaseSync(join(DATA_DIR, "messages.db"));
  side.exec("PRAGMA busy_timeout=30000");
  chain(small, 1_000); chain(large, 200_000); COUNT.set(small, 1_000); COUNT.set(large, 200_000);
  side.exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending; DELETE FROM turn_first");
  store = new Store(selection);
}, 600_000);
afterAll(() => { side?.close(); });

const asked = (count: number) => ["c-1", "c-5", "fork", `c-${count - 5}`, "nothing"];
const COUNT = new Map<string, number>();
it("a search, the first screen's cards and the inbox on an unprepared thread read the same on 1,000 and 200,000 messages, and never fill", async () => {
  expect(isPrepared(small)).toBe(false); expect(isPrepared(large)).toBe(false);
  const syncBefore = prepareStats.syncPrepares, slicesBefore = prepareStats.slices;
  const read = (t: string) => {
    const known = store.branchMembershipKnown(t);                 // /api/search
    const placed = messages.cardsOnBranchStatus(t, messages.readActiveLeafOrNewest(t), asked(COUNT.get(t)!).map((id) => ({ id, rowid: 0 }))); // /api/bots?messages=100
    const on = store.branchMembership(t);                          // inbox project approvals
    return { known: asked(COUNT.get(t)!).map((id) => known(id)), unknown: placed.unknown, on: asked(COUNT.get(t)!).map((id) => on(id)) };
  };
  const a = await measureReads(small, join(DATA_DIR, "messages.db"), () => read(small));
  const b = await measureReads(large, join(DATA_DIR, "messages.db"), () => read(large));
  expectSameReads(a.reads, b.reads);
  expect(b.reads.rows).toBeLessThanOrEqual(BOUNDED_WALK_ROWS * 4);
  // the near-start rows are not placed by a bounded walk: unknown, and counted as on the branch where nothing may be hidden
  expect(b.result.known).toEqual([undefined, undefined, undefined, true, undefined]);
  expect(b.result.unknown).toBe(true);
  expect(b.result.on).toEqual([true, true, true, true, true]);
  expect(prepareStats.syncPrepares).toBe(syncBefore);
  expect(prepareStats.slices).toBe(slicesBefore);
  expect(isPrepared(small)).toBe(false); expect(isPrepared(large)).toBe(false);
  expect(nextQueuedFill(database())).toBeDefined();
}, 600_000);

it("the background pass fills the queued threads in short slices, says so, and the thread then answers through the index", async () => {
  for (const t of [small, large]) store.branchMembershipKnown(t)("c-5"); // a request queues the thread (the handle may have been reopened since)
  expect(nextQueuedFill(database())).toBeDefined();
  const ready: Array<string | null> = [];
  const off = onThreadCardsReady((id) => ready.push(id));
  const syncBefore = prepareStats.syncPrepares;
  prepareStats.sliceMs.length = 0; prepareStats.maxSliceMs = 0;
  await runTranscriptBackfill(database(), () => true, { gate: null });
  off();
  expect(isPrepared(small)).toBe(true); expect(isPrepared(large)).toBe(true);
  expect(ready).toContain(small); expect(ready).toContain(large);
  expect(prepareStats.syncPrepares).toBe(syncBefore);
  expect(prepareStats.slices).toBeGreaterThan(100); // 200,000 rows in slices of at most SLICE_ROWS
  for (const t of [small, large]) {
    const known = store.branchMembershipKnown(t);
    expect(asked(COUNT.get(t)!).map((id) => known(id))).toEqual([true, true, false, true, false]);
    expect(messages.cardsOnBranchStatus(t, messages.readActiveLeafOrNewest(t), asked(COUNT.get(t)!).map((id) => ({ id, rowid: 0 }))).unknown).toBe(false);
  }
  expect(nextQueuedFill(database())).toBeUndefined();
}, 600_000);

it("a turn on an unprepared thread waits on its slice fill, and reads the same before and after", async () => {
  const t = store.createBot({ name: "Turn" }).threadId;
  side.prepare("DELETE FROM messages WHERE thread_id=?").run(t);
  for (let i = 1; i <= 3_000; i++) {
    const m = { id: `t-${i}`, at: 1700000000000 + i, role: i % 2 ? "user" : "bot", kind: "text", text: `turn line ${i}`, turnId: i > 2_990 ? "turn-z" : undefined, parentId: i === 1 ? null : `t-${i - 1}` };
    side.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(t, m.id, m.at, m.role, m.kind, m.text, JSON.stringify(m));
  }
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(t, "t-3000");
  side.prepare("DELETE FROM thread_key WHERE thread_id=?").run(t);
  expect(isPrepared(t)).toBe(false);
  const slices = prepareStats.slices, sync = prepareStats.syncPrepares;
  await prepareThread(t);
  expect(isPrepared(t)).toBe(true);
  expect(prepareStats.slices - slices).toBeGreaterThan(1);
  expect(prepareStats.syncPrepares).toBe(sync);
  expect(messages.turnRows(t, "turn-z").map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `t-${2_991 + i}`));
});
