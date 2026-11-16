// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW r3.2.8b 5(e) / r3.2.8d D3, D-FALLBACK at the search level: while the main-process reader is blocked (the reset drain and the
// reset-exit), searchMemory answers without opening the index. The open counter is readerTestHooks.openIndexConnection (D3).
// - cache-miss row: the query cache is cleared and the bridge is called (so the answer is not a cache hit); the word index is not
//   readable, the helper fails, and the keyword fallback answers from the stored records with hydrated hits. Zero opens of the index path
//   and of every LOG_SUFFIXES name.
// - cache-hit control: an identical query answered by the helper is cached; the second call is a hit with zero bridge calls and zero opens.
// - open-counter control: unblocked, the same search does open the index (so a count of 0 above is not a dead counter).
// mV' (index-reader.ts handle() and borrowScan ignoring the block) is RED on the cache-miss row's open count.
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { blockMemoryIndexReader, closeMemoryIndexReader, readerTestHooks, resetScanAdmission, unblockMemoryIndexReader } from "./index-reader.ts";
import { clearMemorySearchCache, searchMemory, type MemorySearchBridge } from "./search.ts";
import { accessFor, captureAndPublish, failingBridge, freshDataDir, indexPendingRecords } from "./testing/recall-fixture.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const LOG_SUFFIXES = ["-wal", "-shm", "-walok", "-walattempt", "-walstop"];
const realOpen = readerTestHooks.openIndexConnection;
const opens: string[] = [];
const countsAsIndex = (path: string) => path === INDEX_PATH() || LOG_SUFFIXES.some(suffix => path === `${INDEX_PATH()}${suffix}`);
beforeEach(() => {
  closeMemoryIndexReader(); unblockMemoryIndexReader(); resetScanAdmission();
  freshDataDir("active"); clearMemorySearchCache();
  opens.length = 0;
  readerTestHooks.openIndexConnection = (path, options) => { if (countsAsIndex(path)) opens.push(path); return realOpen(path, options); };
});
afterEach(() => { readerTestHooks.openIndexConnection = realOpen; unblockMemoryIndexReader(); closeMemoryIndexReader(); resetScanAdmission(); clearMemorySearchCache(); });

const FACTS = ["The quarterly launch review is on Friday at ten.", "Sean prefers concise status reports every Monday.", "Dinner reservations are at the harbour restaurant."];
async function seed() { for (const text of FACTS) captureAndPublish(text); await indexPendingRecords(); }
const recordFor = (word: string) => database().prepare("SELECT id,version FROM memory_records WHERE text LIKE ? AND state='active' LIMIT 1").get(`%${word}%`)! as { id: string; version: number };
const allowance = () => LineageAllowance.tool(1_000_000_000);
/** A bridge that counts its calls and answers like a helper that read the record. */
function answering(record: { id: unknown; version: unknown }): MemorySearchBridge & { calls: number } {
  const bridge = { calls: 0, search: async () => { bridge.calls++; return { hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 3, coverageComplete: true }; } };
  return bridge as MemorySearchBridge & { calls: number };
}

it("cache-miss row: reader blocked, helper failing: the keyword fallback answers with hydrated hits and the index is opened 0 times", async () => {
  await seed();
  blockMemoryIndexReader();
  let bridgeCalls = 0;
  const failing: MemorySearchBridge = failingBridge();
  const bridge: MemorySearchBridge = { search: (...args: Parameters<MemorySearchBridge["search"]>) => { bridgeCalls++; return failing.search(...args); } };
  const result = await searchMemory("harbour restaurant", accessFor().access, bridge, { allowance: allowance(), caller: "tool" });
  expect(opens).toEqual([]); // first: the block held (mV' is RED here)
  expect(bridgeCalls).toBe(1); // a cache miss: the helper was asked
  expect(result.hits.map(hit => hit.text)).toEqual(["Dinner reservations are at the harbour restaurant."]);
  expect(result).toMatchObject({ recallMode: "keyword", degradedReason: "MEMORY_RECALL_PARTIAL" });
});

it("cache-hit control: a cached identical query answers with zero bridge calls and the index is opened 0 times", async () => {
  await seed();
  const record = recordFor("harbour");
  const bridge = answering(record);
  blockMemoryIndexReader();
  const first = await searchMemory("harbour restaurant", accessFor().access, bridge, { allowance: allowance(), caller: "tool" });
  expect(bridge.calls).toBe(1);
  expect(first.hits.some(hit => hit.id === record.id)).toBe(true);
  const second = await searchMemory("harbour restaurant", accessFor().access, bridge, { allowance: allowance(), caller: "tool" });
  expect(bridge.calls).toBe(1); // the hit: no second bridge call
  expect(second.hits.map(hit => hit.id)).toEqual(first.hits.map(hit => hit.id));
  expect(opens).toEqual([]);
});

it("open-counter control: unblocked, the same search opens the index (the counter is live)", async () => {
  await seed();
  const record = recordFor("harbour");
  const result = await searchMemory("harbour restaurant", accessFor().access, answering(record), { allowance: allowance(), caller: "tool" });
  expect(result.hits.some(hit => hit.id === record.id)).toBe(true);
  expect(opens.length).toBeGreaterThan(0);
  expect(opens.every(countsAsIndex)).toBe(true);
});
