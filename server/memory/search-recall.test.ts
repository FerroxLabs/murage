// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROPOSAL-v2 10.2: recall reads the word index from this process, writes nothing, never waits for the
// helper for its words, and is never "unavailable" because the helper is busy.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { closeMemoryIndexReader, lexicalPage, memoryIndexReaderState, memoryIndexTerms, RECALL_FIRST_PAGE, RECALL_SEARCH_SQL, RECALL_TERM_LIMIT } from "./index-reader.ts";
import { flushMemoryCounters, memoryHealth, recordMemoryRetrieval, resetMemoryCounters } from "./health.ts";
import { SEARCH_BUDGET_MS, SEMANTIC_CUTOFF_MS, searchMemory } from "./search.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { accessFor, captureAndPublish, changes, emptyBridge, failingBridge, freshDataDir, hangingBridge, indexPendingRecords } from "./testing/recall-fixture.ts";

let lines: string[];
beforeEach(() => { freshDataDir("active"); resetMemoryCounters(); resetWorkerLog(); resetObserveWindows(); lines = []; setObserveSink(line => lines.push(line)); });
afterEach(() => { closeMemoryIndexReader(); setObserveSink(); });

function seed() {
  captureAndPublish("The quarterly launch review is on Friday at ten.");
  captureAndPublish("Sean prefers concise status reports every Monday.");
  captureAndPublish("Dinner reservations are at the harbour restaurant.");
  indexPendingRecords();
}

it("finds words through the persistent read-only handle and orders them by rank, within the caller's scopes only", () => {
  seed();
  const scopeId = String(database().prepare("SELECT DISTINCT scope_id FROM memory_records LIMIT 1").get()!.scope_id);
  const page = lexicalPage("launch review Friday", [scopeId], 10)!;
  expect(page.hits.length).toBeGreaterThan(0);
  expect(page.hits[0]).toMatchObject({ lexical: true });
  expect(page.hits[0].score).toBeGreaterThan(page.hits.at(-1)!.score - 1e-9);
  expect(lexicalPage("launch review Friday", ["some-other-scope"], 10)).toEqual({ hits: [], more: false });
  expect(memoryIndexReaderState()).toBe("ready");
  expect(memoryIndexTerms("a b c d e f g h i j k l")).toHaveLength(RECALL_TERM_LIMIT);
});

it("the ranked word query streams from the index in rank order: no sort, no scan of the word table", () => {
  seed();
  const db = new DatabaseSync(join(DATA_DIR, "memory-index.db"), { readOnly: true });
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${RECALL_SEARCH_SQL}`).all("\"launch\"", "[\"s\"]", 51, 0).map(row => String(row.detail)).join(" | ");
  db.close();
  expect(plan).toMatch(/VIRTUAL TABLE INDEX/);
  expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  expect(plan).toMatch(/SEARCH e USING (COVERING )?INDEX sqlite_autoindex_entries_1/);
});

it("answers from the words alone when the helper never answers: not unavailable, 50 of 50, each inside the budget", async () => {
  seed();
  const { access } = accessFor();
  let unavailable = 0, slowest = 0;
  for (let n = 0; n < 50; n++) {
    const started = performance.now();
    const result = await searchMemory("launch review Friday", access, hangingBridge);
    slowest = Math.max(slowest, performance.now() - started);
    if (result.degradedReason === "MEMORY_RECALL_UNAVAILABLE" || !result.hits.length) unavailable++;
    expect(result.degradedReason).toBe("semantic-skipped");
    expect(result.hits[0].text).toContain("launch review");
  }
  expect(unavailable).toBe(0);
  expect(slowest).toBeLessThan(SEMANTIC_CUTOFF_MS + 250);
  expect(SEMANTIC_CUTOFF_MS).toBeLessThan(SEARCH_BUDGET_MS);
});

it("a failing helper is logged with its cause and recall still answers from the words", async () => {
  seed();
  const result = await searchMemory("launch review", accessFor().access, failingBridge("MEMORY_WORKER_EXITED"));
  expect(result.hits.length).toBeGreaterThan(0);
  expect(result.degradedReason).toBe("semantic-skipped");
  expect(lines.some(line => line.includes("subsystem=recall cause=MEMORY_WORKER_EXITED"))).toBe(true);
});

it("the helper's fused hits and the words are merged without duplicates", async () => {
  seed();
  const record = database().prepare("SELECT id,version FROM memory_records WHERE text LIKE '%harbour%'").get()!;
  const bridge = { search: async () => ({ hits: [{ id: String(record.id), version: Number(record.version), score: 0.5, similarity: 0.9 }], vectorRows: 3, coverageComplete: true }) };
  const result = await searchMemory("harbour restaurant", accessFor().access, bridge);
  expect(result.hits.filter(hit => hit.id === record.id)).toHaveLength(1);
  expect(result.vectorRows).toBe(3);
  expect(result.degradedReason).toBeUndefined();
});

it("recall and bundle assembly write nothing at all", async () => {
  seed();
  const { access } = accessFor();
  await searchMemory("launch review", access, emptyBridge);  // warm anything lazy (the per-connection temp tables are made on first use)
  await buildMemoryBundle("launch review", access, emptyBridge);
  const before = changes();
  await searchMemory("launch review Friday", access, emptyBridge);
  await searchMemory("weekly reports", access, hangingBridge);
  await buildMemoryBundle("launch review Friday", access, emptyBridge);
  await buildMemoryBundle("anything else", access, hangingBridge);
  expect(changes()).toBe(before);
});

it("retrieval counters are held in memory and written by the idle sweep, and the Details figures still count them", async () => {
  seed();
  const { access } = accessFor();
  flushMemoryCounters(Date.now(), true);  // creates the counter row
  await searchMemory("launch review", access, emptyBridge);  // (the per-connection temp tables the dispatch checks use are made on first use)
  await buildMemoryBundle("launch review", access, emptyBridge);
  const queries = () => Number(memoryHealth(null).retrieved.queries);
  const base = queries();
  const before = changes();
  await searchMemory("launch review", access, emptyBridge);
  expect(changes()).toBe(before);
  expect(queries()).toBe(base + 1);
  expect(flushMemoryCounters(Date.now() + 1000)).toBe(false);          // within a minute of the last write
  expect(flushMemoryCounters(Date.now() + 61_000)).toBe(true);
  expect(changes()).toBeGreaterThan(before);
  expect(queries()).toBe(base + 1);
  recordMemoryRetrieval(2);
  expect(queries()).toBe(base + 2);
});

it("fewer survivors than asked for reads one more page, up to 200 ranked hits", async () => {
  captureAndPublish("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega alpha one two three four five six seven eight nine ten");
  // 60 shorter documents that rank above it for the word, none of them current
  const scope = String(database().prepare("SELECT scope_id FROM memory_records LIMIT 1").get()!.scope_id);
  const insert = database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','archived',0,0,NULL,NULL,0)");
  const receipt = database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)");
  for (let n = 0; n < 60; n++) { insert.run(`junk-${n}`, scope, "alpha alpha alpha"); receipt.run(`junk-${n}`); }
  indexPendingRecords();
  const page = lexicalPage("alpha", [scope], RECALL_FIRST_PAGE)!;
  expect(page.hits).toHaveLength(RECALL_FIRST_PAGE);
  expect(page.more).toBe(true);
  expect(page.hits.every(hit => hit.id.startsWith("junk-"))).toBe(true);
  const result = await searchMemory("alpha", accessFor().access, emptyBridge);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0].text).toContain("omega");
});

it("a missing or damaged index is logged, the helper answers, and a rebuilding index is not reported complete", async () => {
  seed();
  const record = database().prepare("SELECT id,version FROM memory_records WHERE text LIKE '%launch%' LIMIT 1").get()!;
  const bridge = { search: async () => ({ hits: [{ id: String(record.id), version: Number(record.version), score: 1 }], vectorRows: 1, coverageComplete: true }) };
  closeMemoryIndexReader();
  writeFileSync(join(DATA_DIR, "memory-index.db"), "this is not a database");
  const damaged = await searchMemory("launch", accessFor().access, bridge);
  expect(damaged.hits.length).toBe(1);
  expect(damaged.coverageComplete).toBe(false);
  expect(memoryIndexReaderState()).toBe("unreadable");
  expect(lines.some(line => line.includes("subsystem=recall"))).toBe(true);
});

it("words only is reported incomplete while records are waiting for the index, complete once they are in", async () => {
  captureAndPublish("The launch review is on Friday.");
  indexPendingRecords();
  captureAndPublish("A new launch fact the index has not seen.");
  const { access } = accessFor();
  expect((await searchMemory("launch", access, failingBridge())).coverageComplete).toBe(false);
  indexPendingRecords();
  expect((await searchMemory("launch", access, failingBridge())).coverageComplete).toBe(true);
});

it("a turn that was stopped still stops the search, and access that went away still refuses it", async () => {
  seed();
  const { access, registry } = accessFor();
  const stop = new AbortController(); stop.abort();
  await expect(searchMemory("launch", access, emptyBridge, { signal: stop.signal })).rejects.toThrow();
  registry.revokeThread("thread");
  await expect(searchMemory("launch", access, emptyBridge)).rejects.toThrow();
});
