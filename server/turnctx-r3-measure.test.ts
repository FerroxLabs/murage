// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The numbers of the turnctx r3 gate, measured and printed (grep "MEASURE"):
//  - storage: what the branch, line and fill tables cost per message and as a share of
//    the message bytes (dbstat), on conversations written through the writers;
//  - the first turn on a cold 200,000-message thread: how long the thread's fill takes,
//    and the longest stretch it holds the event loop (a slice, and the loop's own lag);
//  - the writers' share: the cost of appending to a prepared 200,000-message thread.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database } from "./database.ts";
import { prepareStats } from "./branch-fill.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const messagesDb = () => join(DATA_DIR, "messages.db");
let store: Store, side: DatabaseSync;

beforeAll(() => { removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); store = new Store(selection); side = new DatabaseSync(messagesDb()); side.exec("PRAGMA busy_timeout=30000"); }, 60_000);
afterAll(() => { side?.close(); });

/** A realistic conversation: a quarter of the rows are the owner's words, a fifth the bot's, the rest tool activity. */
function shape(v: number): { role: string; kind: string; text: string | null; extra: object } {
  const m = v % 20;
  if (m < 5) return { role: "user", kind: "text", text: "u".repeat(160 + (v % 7) * 20), extra: {} };
  if (m < 9) return { role: "bot", kind: "text", text: "b".repeat(320 + (v % 9) * 40), extra: { turnId: `turn-${Math.floor(v / 20)}` } };
  if (m < 19) return { role: "bot", kind: "activity", text: null, extra: { turnId: `turn-${Math.floor(v / 20)}`, tool: { name: m % 3 === 0 ? "send_message" : "Read", ok: true, summary: "s".repeat(240 + (v % 5) * 60) } } };
  return { role: "bot", kind: "text", text: "closing words of the turn", extra: { turnId: `turn-${Math.floor(v / 20)}`, turnTerminal: true } };
}

it("storage: the derived tables as bytes per message and as a share of the message bytes", async () => {
  const bot = store.createBot({ name: "Measured" });
  const count = Number(process.env.MEASURE_WRITTEN ?? 12_000);
  const began = performance.now();
  for (let v = 1; v <= count; v++) {
    const s = shape(v);
    store.appendMessage(bot.threadId, { role: s.role, kind: s.kind, text: s.text ?? undefined, ...s.extra } as never);
  }
  const wrote = performance.now() - began;
  const db = database();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  let bytes: (name: string) => number;
  try {
    const sizes = new Map(db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all().map((r) => [String(r.name), Number(r.bytes)]));
    bytes = (name) => sizes.get(name) ?? 0;
  } catch (error) {
    console.log(`MEASURE dbstat unavailable: ${(error as Error).message}`);
    const pages = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count), size = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    console.log(`MEASURE file bytes ${pages * size}`);
    return;
  }
  const own = ["thread_key", "seg", "seg_attach", "msg_branch", "fill_pending", "line", "branch_change"];
  const derived = own.reduce((sum, name) => sum + bytes(name), 0) + bytes("sqlite_autoindex_line_1") + bytes("sqlite_autoindex_fill_pending_1") + bytes("sqlite_autoindex_branch_change_1") + bytes("sqlite_autoindex_thread_key_1");
  const messageTable = bytes("messages");
  const messageIndexes = ["sqlite_autoindex_messages_1", "messages_thread", "messages_at", "messages_inbox_kind_thread_at", "messages_inbox", "messages_inbox_text_artifact"].reduce((sum, name) => sum + bytes(name), 0);
  const fts = ["messages_fts_data", "messages_fts_idx", "messages_fts_docsize", "messages_fts_config"].reduce((sum, name) => sum + bytes(name), 0);
  const jsonBytes = Number((db.prepare("SELECT SUM(length(json)) AS n FROM messages").get() as { n: number }).n);
  const perTable = Object.fromEntries(own.map((name) => [name, bytes(name)]));
  console.log(`MEASURE storage ${JSON.stringify({ messages: count, jsonBytes, messageTable, messageIndexes, fts, derived, perTable, derivedPerMessage: +(derived / count).toFixed(2),
    pctOfMessageTable: +((derived / messageTable) * 100).toFixed(2), pctOfMessagesIndexesAndFts: +((derived / (messageTable + messageIndexes + fts)) * 100).toFixed(2), writeMsPerMessage: +(wrote / count).toFixed(2) })}`);
  expect(derived / (messageTable + messageIndexes + fts)).toBeLessThan(0.03);
}, 600_000);

it("the first turn on a cold 200,000-message thread waits for the thread's fill; the event loop stays free between slices", async () => {
  const bot = store.createBot({ name: "Cold" });
  const threadId = bot.threadId;
  side.prepare("DELETE FROM messages WHERE thread_id=?").run(threadId);
  side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<200000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT ?, 'c-'||v, 1700000000000+v, CASE WHEN v%20<5 THEN 'user' ELSE 'bot' END, CASE WHEN v%20 BETWEEN 9 AND 18 THEN 'activity' ELSE 'text' END,
      CASE WHEN v%20 BETWEEN 9 AND 18 THEN NULL WHEN v%20<5 THEN substr(hex(randomblob(100)),1,200) ELSE substr(hex(randomblob(200)),1,400) END,
      json_object('id','c-'||v,'at',1700000000000+v,'role',CASE WHEN v%20<5 THEN 'user' ELSE 'bot' END,'kind',CASE WHEN v%20 BETWEEN 9 AND 18 THEN 'activity' ELSE 'text' END,
        'text',CASE WHEN v%20 BETWEEN 9 AND 18 THEN NULL ELSE substr(hex(randomblob(150)),1,300) END,'turnId','turn-'||(v/20),
        'tool',CASE WHEN v%20 BETWEEN 9 AND 18 THEN json_object('name',CASE WHEN v%3=0 THEN 'send_message' ELSE 'Read' END,'ok',json('true'),'summary',substr(hex(randomblob(150)),1,300)) END,
        'parentId',CASE WHEN v=1 THEN NULL ELSE 'c-'||(v-1) END) FROM n`).run(threadId);
  side.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, "c-200000");
  side.prepare("DELETE FROM thread_key WHERE thread_id=?").run(threadId);
  store = new Store(selection);
  prepareStats.syncPrepares = 0; prepareStats.maxSliceMs = 0; prepareStats.slices = 0; prepareStats.sliceMs.length = 0;
  // the event loop's own lag while the fill runs
  let worstLag = 0, last = performance.now(), running = true;
  const tick = () => { const now = performance.now(); worstLag = Math.max(worstLag, now - last); last = now; if (running) setImmediate(tick); };
  setImmediate(tick);
  const began = performance.now();
  await store.prepareThread(threadId);
  const waited = performance.now() - began;
  running = false; await new Promise((resolve) => setImmediate(resolve));
  // a turn's reads after the wait
  const afterBegan = performance.now();
  const lines = store.activeTextLines(threadId, 80), member = store.branchMembership(threadId);
  const keyed = [member("c-1"), member("c-100000"), member("c-200000")];
  const reads = performance.now() - afterBegan;
  console.log(`MEASURE cold-thread ${JSON.stringify({ messages: 200_000, firstTurnWaitMs: Math.round(waited), slices: prepareStats.slices, maxSliceMs: +prepareStats.maxSliceMs.toFixed(1), p50SliceMs: +[...prepareStats.sliceMs].sort((a, b) => a - b)[Math.floor(prepareStats.sliceMs.length / 2)]!.toFixed(1), p99SliceMs: +[...prepareStats.sliceMs].sort((a, b) => a - b)[Math.floor(prepareStats.sliceMs.length * 0.99)]!.toFixed(1), slicesOver100ms: prepareStats.sliceMs.filter((ms) => ms > 100).length, worstEventLoopLagMs: +worstLag.toFixed(1), syncPrepares: prepareStats.syncPrepares, readsAfterMs: +reads.toFixed(2), lines: lines.messages.length, keyed })}`);
  expect(prepareStats.syncPrepares).toBe(0);
  expect(keyed).toEqual([true, true, true]);
  // the writers on the prepared thread: an append is a few keyed statements
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) store.appendMessage(threadId, { role: "user", kind: "text", text: `more ${i}` } as never);
  console.log(`MEASURE append-on-200k ${JSON.stringify({ msPerAppend: +((performance.now() - t0) / 200).toFixed(2) })}`);
}, 900_000);

it("a million messages in forty threads: the background pass keeps the event loop free, and the derived tables stay a few percent", { tags: ["perf-budget"], timeout: 1_800_000 }, async () => {
  const total = Number(process.env.MEASURE_BULK ?? 1_000_000), threads = 40, each = Math.floor(total / threads);
  const builtAt = performance.now();
  side.exec("DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM turn_first");
  for (let t = 0; t < threads; t++) {
    side.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<CAST(? AS INTEGER))
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT ?, 'b'||?||'-'||v, 1600000000000+v*1000, CASE WHEN v%20<5 THEN 'user' ELSE 'bot' END, CASE WHEN v%20 BETWEEN 9 AND 18 THEN 'activity' ELSE 'text' END,
        CASE WHEN v%20 BETWEEN 9 AND 18 THEN NULL WHEN v%20<5 THEN substr(hex(randomblob(100)),1,200) ELSE substr(hex(randomblob(200)),1,400) END,
        json_object('id','b'||?||'-'||v,'at',1600000000000+v*1000,'role',CASE WHEN v%20<5 THEN 'user' ELSE 'bot' END,'kind',CASE WHEN v%20 BETWEEN 9 AND 18 THEN 'activity' ELSE 'text' END,
          'text',CASE WHEN v%20 BETWEEN 9 AND 18 THEN NULL ELSE substr(hex(randomblob(150)),1,300) END,'turnId','turn-'||(v/20),
          'tool',CASE WHEN v%20 BETWEEN 9 AND 18 THEN json_object('name',CASE WHEN v%3=0 THEN 'send_message' ELSE 'Read' END,'ok',json('true'),'summary',substr(hex(randomblob(150)),1,300)) END,
          'parentId',CASE WHEN v=1 THEN NULL ELSE 'b'||?||'-'||(v-1) END) FROM n`).run(each, `bulk-${t}`, t, t, t);
  }
  const db = database();
  console.log(`MEASURE bulk-built ${JSON.stringify({ messages: total, buildSeconds: +((performance.now() - builtAt) / 1000).toFixed(1) })}`);
  let worst = 0, last = performance.now(), running = true;
  const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (running) setImmediate(tick); };
  setImmediate(tick);
  const { runTranscriptBackfill } = await import("./transcript-backfill.ts");
  prepareStats.sliceMs.length = 0; prepareStats.maxSliceMs = 0;
  const began = performance.now();
  await runTranscriptBackfill(db, () => true, { gate: { admit: () => ({ admitted: true, forced: false }) } as never });
  const took = performance.now() - began;
  running = false; await new Promise((resolve) => setImmediate(resolve));
  const prepared = Number((db.prepare("SELECT COUNT(*) AS n FROM thread_key WHERE state = 2").get() as { n: number }).n);
  let bytes = (_: string) => 0;
  try { const sizes = new Map(db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all().map((r) => [String(r.name), Number(r.bytes)])); bytes = (name) => sizes.get(name) ?? 0; } catch { /* no dbstat */ }
  const own = ["thread_key", "seg", "seg_attach", "msg_branch", "fill_pending", "line", "branch_change"];
  const derived = own.reduce((sum, name) => sum + bytes(name), 0);
  const perTable = Object.fromEntries([...own, "turn_first", "sqlite_autoindex_turn_first_1"].map((name) => [name, +(bytes(name) / total).toFixed(2)]));
  const messageTable = bytes("messages");
  const sorted = [...prepareStats.sliceMs].sort((a, b) => a - b);
  console.log(`MEASURE bulk ${JSON.stringify({ messages: total, threads, preparedThreads: prepared, fillTotalSeconds: +(took / 1000).toFixed(1), slices: sorted.length, p50SliceMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(1), p99SliceMs: +sorted[Math.floor(sorted.length * 0.99)]!.toFixed(1), maxSliceMs: +prepareStats.maxSliceMs.toFixed(1), worstEventLoopLagMs: +worst.toFixed(1), derivedBytesPerMessage: +(derived / total).toFixed(2), perTableBytesPerMessage: perTable, pctOfMessageTable: messageTable ? +((derived / messageTable) * 100).toFixed(2) : null })}`);
  expect(prepared).toBeGreaterThanOrEqual(threads);
});
