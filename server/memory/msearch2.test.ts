// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane msearch2 (1.0.2): recall cost follows the query, not the size of the memory; owner search answers from the search index
// while projection jobs are pending. Every test here fails on 2441af103.
//  - recall walked every match of an OR of the first eight raw words, and ended at its deadline as MEMORY_RECALL_SCAN_LIMIT;
//  - owner search fell to a source-text scan of every record in scope when ONE record had no index receipt, and matched the whole
//    phrase instead of all the words.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, recallTerms, recallWork, RECALL_COMMON_POSTINGS, RECALL_QUERY_ROWS } from "./index-reader.ts";
import { ownerMemoryList, ownerSearchWork } from "./owner-list.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { LineageAllowance } from "./replay-lineage.ts";
import { memoryAccess, type MemoryAccess } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, searchMemory, type MemorySearchBridge } from "./search.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { dropOwnerTail } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const roster = { bots: [{ id: "a", threadId: "ta" }], groups: [] };
const COMMON = "pipeline renewals hiring weekly client report";

beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMemoryIndexReader(); });

/** An index of `count` records that all say the common words, a few of which also say a rare one. */
function bigIndex(count: number, rare: number) {
  closeMemoryIndexReader(); // a recall before this one left the cached reader open, and Windows will not remove an open file
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.close();
  const db = new DatabaseSync(INDEX_PATH());
  db.exec("BEGIN");
  const entry = db.prepare("INSERT INTO entries VALUES(?,1,'s',?)"), word = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (let n = 0; n < count; n++) {
    const text = `${COMMON} note${n} ${n % Math.max(1, Math.floor(count / rare)) === 0 ? "zephyrine" : ""} turn${n % 7000}`;
    const id = `r-${String(n).padStart(7, "0")}`;
    entry.run(id, text); word.run(id, text);
  }
  db.exec("COMMIT");
  db.close();
}
async function recallOnce(query: string) {
  const before = { ...recallWork };
  const started = performance.now();
  const page = await lexicalPageSliced(query, ["s"], 50, 0, undefined, { deadlineAt: Date.now() + 500 });
  return { ms: performance.now() - started, page: page!, matchRows: recallWork.matchRows - before.matchRows, judged: recallWork.judged - before.judged };
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe("recall: per-recall cost follows the query, not the size of the memory", () => {
  it("drops common words and keeps the rarest", () => {
    expect(recallTerms("What did we decide about pipeline? Turn 7000 zephyrine")).toEqual(["decide", "pipeline", "Turn", "7000", "zephyrine"]);
    expect(recallTerms("what did we do")).toEqual(["what", "did", "we", "do"]);
  });

  it("an ordinary question costs the same at 10k and at 500k records, and never hits the scan limit", { tags: ["nightly"], timeout: 600_000 }, async () => {
    const query = "What did we decide about pipeline? Turn 7000 zephyrine and the weekly client report";
    const small = [], large = [];
    bigIndex(10_000, 5);
    await recallOnce(query);
    for (let n = 0; n < 5; n++) small.push(await recallOnce(query));
    bigIndex(500_000, 5);
    closeMemoryIndexReader();
    await recallOnce(query);
    for (let n = 0; n < 5; n++) large.push(await recallOnce(query));
    for (const run of [...small, ...large]) {
      expect(run.page.partial).toBeUndefined();
      expect(run.page.hits.length).toBe(5);
    }
    // the work (rows stepped and records judged) is the same, and the time stays in the same band
    expect(large[0]!.matchRows).toBe(small[0]!.matchRows);
    expect(large[0]!.judged).toBe(small[0]!.judged);
    expect(large[0]!.matchRows).toBeLessThan(200);
    expect(median(large.map(run => run.ms))).toBeLessThan(Math.max(40, median(small.map(run => run.ms)) * 4));
  });

  it("a question made only of common words reads a bounded set, judges only the top, and is not cut off", { timeout: 600_000 }, async () => {
    bigIndex(200_000, 5);
    const run = await recallOnce("pipeline renewals hiring weekly client report");
    expect(run.page.partial).toBeUndefined();
    expect(run.page.hits).toHaveLength(50);
    expect(run.matchRows).toBeLessThanOrEqual(RECALL_COMMON_POSTINGS * 4);
    expect(run.judged).toBeLessThan(1000);
    expect(run.ms).toBeLessThan(500);
  });
});

/** An index holding exactly these records (all version 1), in this order: the first is the oldest. */
function indexOf(rows: Array<{ id: string; scope: string; text: string }>) {
  // the reader lets go before the file goes: Windows will not remove a file another handle holds open
  closeMemoryIndexReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.close();
  const db = new DatabaseSync(INDEX_PATH());
  db.exec("BEGIN");
  const entry = db.prepare("INSERT INTO entries VALUES(?,1,?,?)"), word = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (const row of rows) { entry.run(row.id, row.scope, row.text); word.run(row.id, row.text); }
  db.exec("COMMIT");
  db.close();
}
const ids = (page: { hits: Array<{ id: string }> }) => page.hits.map(hit => hit.id);

describe("recall: what other scopes hold never changes what a reader gets", () => {
  // 1,200 records the reader may read and 3,000 it may not, all about the pipeline; then one record elsewhere that also says "zephyrine".
  const crowd = () => [
    ...Array.from({ length: 1200 }, (_, n) => ({ id: `mine-${String(n).padStart(4, "0")}`, scope: "s", text: `pipeline note${n} quarterly` })),
    ...Array.from({ length: 3000 }, (_, n) => ({ id: `theirs-${String(n).padStart(4, "0")}`, scope: "x", text: `pipeline note${n} budget` })),
  ];
  it("a rare word that only another scope holds does not displace the reader's common word", async () => {
    indexOf(crowd());
    const without = await recallOnce("pipeline zephyrine");
    indexOf([...crowd(), { id: "theirs-private", scope: "x", text: "zephyrine pipeline launch plan" }]);
    const withPrivate = await recallOnce("pipeline zephyrine");
    expect(ids(without.page).length).toBeGreaterThan(0);
    expect(ids(withPrivate.page)).toEqual(ids(without.page));
    expect(ids(withPrivate.page).every(id => id.startsWith("mine-"))).toBe(true);
  });
  it("a word the reader holds once still narrows the query, whatever other scopes hold of it", async () => {
    indexOf([...crowd(), { id: "mine-rare", scope: "s", text: "pipeline zephyrine decision" }]);
    expect(ids((await recallOnce("pipeline zephyrine")).page)).toEqual(["mine-rare"]);
    indexOf([...crowd(), { id: "mine-rare", scope: "s", text: "pipeline zephyrine decision" }, ...Array.from({ length: 5000 }, (_, n) => ({ id: `theirs-z${n}`, scope: "x", text: `zephyrine other${n}` }))]);
    // not a list padded with every "pipeline" note: the word the reader holds once narrowed the query, though 5,000 records elsewhere say it
    expect(ids((await recallOnce("pipeline zephyrine")).page)).toEqual(["mine-rare"]);
  });
});

describe("recall: the work of one query is capped, however much history stands in the way", () => {
  it("a reader whose only match is the oldest behind a very large crowd of other scopes' matches reads only its own postings, and finds it", { timeout: 300_000 }, async () => {
    indexOf([{ id: "mine-oldest", scope: "s", text: `${COMMON} decision` }, ...Array.from({ length: RECALL_QUERY_ROWS + 30_000 }, (_, n) => ({ id: `theirs-${String(n).padStart(7, "0")}`, scope: "x", text: `${COMMON} note${n}` }))]);
    const run = await recallOnce(COMMON);
    expect(ids(run.page)).toEqual(["mine-oldest"]);
    expect(run.matchRows).toBe(1);
    expect(run.page.bounded).toBeUndefined();
    expect(run.page.partial).toBeUndefined();
  });
  it("a reader's own crowd of common matches is read up to the cap and says so", { timeout: 300_000 }, async () => {
    indexOf(Array.from({ length: RECALL_QUERY_ROWS + 30_000 }, (_, n) => ({ id: `mine-${String(n).padStart(7, "0")}`, scope: "s", text: `${COMMON} note${n}` })));
    const run = await recallOnce(COMMON);
    expect(run.page.hits).toHaveLength(50);
    expect(run.matchRows).toBeLessThanOrEqual(RECALL_QUERY_ROWS);
    expect(run.page.bounded).toBe(true);
    expect(run.page.partial).toBeUndefined();
  });
  it("common words rank nothing (no FTS ranking), narrow words still do", async () => {
    indexOf(Array.from({ length: 3000 }, (_, n) => ({ id: `r-${n}`, scope: "s", text: `${COMMON} note${n} ${n === 7 ? "zephyrine" : ""}` })));
    const before = recallWork.rankedScans;
    await recallOnce(COMMON);
    expect(recallWork.rankedScans - before).toBe(0);
    await recallOnce("zephyrine");
    expect(recallWork.rankedScans - before).toBe(1);
  });
  it("choosing the words counts a bounded number of the reader's own postings per word", async () => {
    indexOf(Array.from({ length: 12_000 }, (_, n) => ({ id: `r-${n}`, scope: "s", text: `${COMMON} note${n}` })));
    const before = { ...recallWork };
    await recallOnce("pipeline renewals hiring weekly client report");
    expect(recallWork.probes - before.probes).toBe(6);
    expect(recallWork.probeRows - before.probeRows).toBeLessThanOrEqual(6 * RECALL_COMMON_POSTINGS);
  });
});

describe("recall: a search that read only the newest matches does not claim to be complete", () => {
  const ROSTER = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }], groups: [] };
  function accessOf(): MemoryAccess {
    const registry = new InternalCapabilities(), generation = registry.begin("a", "thread-a");
    const token = registry.mint({ botId: "a", threadId: "thread-a", generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
  }
  const bridge: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: true }) };
  it("says coverage is incomplete, and tells a tool in plain words", async () => {
    reconcileMemoryRoster(ROSTER); setMemoryMode("active"); clearMemorySearchCache();
    const lexical = async () => ({ hits: [], more: false, bounded: true as const });
    const answer = await searchMemory("pipeline client", accessOf(), bridge, { allowance: LineageAllowance.tool(1e9), caller: "tool", lexical });
    expect(answer.coverageComplete).toBe(false);
    expect(answer.note).toContain("newest matches");
    expect(answer.partial).toBeUndefined();
    const full = await searchMemory("pipeline client", accessOf(), bridge, { allowance: LineageAllowance.tool(1e9), caller: "tool", lexical: async () => ({ hits: [], more: false }) });
    expect(full.coverageComplete).not.toBe(false);
    expect(full.note).toBeUndefined();
  });
});

describe("owner search says so when a limit may have kept a match out", () => {
  function seed(pending: number, indexed: number, oldestText: string) {
    reconcileMemoryRoster(roster);
    const scope = ensureScope("bot", "a");
    transaction(db => {
      const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)"), receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,'unavailable',NULL)");
      for (let n = 0; n < pending + indexed; n++) {
        const id = `rec-${String(n).padStart(6, "0")}`;
        record.run(id, scope, n === 0 ? oldestText : `Filler note ${n}`, n, n);
        receipt.run(id, n < pending ? "pending" : "indexed");
      }
    });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
    const index = new MemoryIndex(INDEX_PATH()); index.prepareModel("model"); index.close();
  }
  it("an old pending note beyond the newest 2,000 pending receipts is not found, and the owner is told", async () => {
    seed(2501, 0, "the zephyrine plan, never indexed");
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(found.rows).toEqual([]);
    expect(found).toMatchObject({ coverageComplete: false, searchNotice: expect.stringContaining("newest matches") });
  });
  it("pending notes beyond the newest 20,000 receipts are not looked at, and the owner is told", { timeout: 300_000 }, async () => {
    seed(20_100, 0, "the zephyrine plan, never indexed");
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(found).toMatchObject({ coverageComplete: false, searchNotice: expect.stringContaining("newest matches") });
  });
  it("more than 20,000 records with nothing pending and the owner-tail index built: complete, no notice", { timeout: 300_000 }, async () => {
    seed(0, 20_500, "the zephyrine plan");
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(found.coverageComplete).toBe(true);
    expect(found.searchNotice).toBeUndefined();
  });
  it("without the owner-tail table, records older than the newest 20,000 of the unprojected kinds are still reached (1.0.3: the key table's kind index), complete, no notice", { timeout: 300_000 }, async () => {
    seed(0, 20_500, "the zephyrine plan");
    dropOwnerTail(database());
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(found.coverageComplete).toBe(true);
    expect(found.searchNotice).toBeUndefined();
  });
  it("a small backlog read in full is found and claims nothing is missing", async () => {
    seed(10, 0, "the zephyrine plan, not yet indexed");
    const found = await ownerMemoryList({ botId: "a", query: "zephyrine" }, roster);
    expect(found.rows.map(row => String(row.id))).toEqual(["rec-000000"]);
    expect(found.coverageComplete).toBe(true);
    expect(String(found.searchNotice)).not.toContain("newest matches");
  });
});

describe("owner search answers from the search index while projection jobs are pending", () => {
  it("returns indexed hits with 25k unindexed jobs pending, matches all the words, and stays bounded", { timeout: 300_000 }, async () => {
    reconcileMemoryRoster(roster);
    const scope = ensureScope("bot", "a");
    const indexed = Array.from({ length: 3000 }, (_, n) => ({ id: `ix-${String(n).padStart(5, "0")}`, version: 1, scopeId: scope, text: n === 1500 ? "orchidneedle weekly quartz review" : `Durable note ${n}`, deleted: false }));
    transaction(db => {
      const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)"), receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,'unavailable',NULL)");
      indexed.forEach((row, n) => { record.run(row.id, scope, row.text, n, n); receipt.run(row.id, "indexed"); });
      for (let n = 0; n < 25_000; n++) {
        const id = `pend-${String(n).padStart(6, "0")}`, text = n === 24_990 ? "a fresh quartz note, not yet indexed, for the orchidneedle plan" : `Pending note ${n}`;
        record.run(id, scope, text, 10_000 + n, 10_000 + n); receipt.run(id, "pending");
      }
    });
    const index = new MemoryIndex(INDEX_PATH()); index.prepareModel("model"); index.upsert(indexed); index.close();
    const before = { ...ownerSearchWork };
    const started = performance.now();
    const found = await ownerMemoryList({ botId: "a", query: "orchidneedle quartz" }, roster);
    const ms = performance.now() - started;
    expect(found.searchMode).toBe("indexed");
    // the indexed record says the words apart (the whole phrase is nowhere in it), the pending one is matched by its text
    expect(found.rows.map(row => String(row.id)).sort()).toEqual(["ix-01500", "pend-024990"]);
    expect(ownerSearchWork.indexedQueries - before.indexedQueries).toBe(1);
    expect(ownerSearchWork.tailQueries - before.tailQueries).toBe(1);
    expect(ms).toBeLessThan(500);
    // nothing pending in the way of an ordinary indexed search either
    expect((await ownerMemoryList({ botId: "a", query: "orchidneedle" }, roster)).rows.map(row => String(row.id))).toEqual(["pend-024990", "ix-01500"]);
  });

  it("without an index file the text match answers over the newest records and says so", async () => {
    reconcileMemoryRoster(roster);
    const scope = ensureScope("bot", "a");
    database().prepare("INSERT INTO memory_records VALUES('c1',1,?,'fact','alpha then beta','assistant-inference','candidate',0,1,NULL,NULL,1)").run(scope);
    const found = await ownerMemoryList({ botId: "a", view: "review", query: "beta alpha" }, roster);
    expect(found).toMatchObject({ searchMode: "source-text", searchNotice: expect.stringContaining("catching up") });
    expect(found.rows.map(row => String(row.id))).toEqual(["c1"]);
  });
});
