// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 4 (lanes/msearch-review/r4/REPORT.md, BLOCK on 5c36e29b1). Every test here failed on that head.
//  P1  denied records changed the order of readable results (vector cache capacity; equal ranks) and the coverage, paging and
//      cursor a reader sees (256 unvectored, 12,000 eligible);
//  P2  a deferred index merge existed only in memory and a busy helper never ran it;
//  P2  one reader's cursors evicted another's;
//  P2  the helper-memory gate read a removed field as zero and passed;
//  P2  the comparison oracle compared a cached answer with itself (msearch-review.test.ts).
//
// ACCEPTED RESIDUAL (owner decision, 1.0.2): BM25 corpus statistics (inverse document frequency, average length) are computed
// by the shared FTS index over every document in it, denied documents included, so denied documents can move the ORDER of
// readable results that tie or nearly tie by words. Closing it needs a per-scope index (the retention lane). One test below
// pins that behaviour as known, so a change to it is noticed rather than assumed.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { eligibleLimits, MemoryEligibility } from "./eligibility.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, lexicalPage } from "./index-reader.ts";
import { MEMORY_CURSOR_MAX_CHARS } from "./cursor-limits.ts";
import { MAINTENANCE_MAX_DEFER_MS, MAINTENANCE_POLL_MS, maintenanceMayRun, type MaintenanceClock } from "./maintenance-schedule.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { recentMemoryHits } from "./recent.ts";
import { pageByRank } from "./rank-ties.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, searchMemory, type MemorySearchBridge } from "./search.ts";
import { answerQuery, scanLimits } from "./worker-query.ts";
import { workerMemoryGate } from "./worker-rss-gate.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }, { id: "b", threadId: "thread-b", section: "crew" }], groups: [] };
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const QUERY = "harbour lantern";

beforeEach(() => {
  closeMemoryIndexReader(); closeDatabase(); clearMemorySearchCache();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(ROSTER); setMemoryMode("active");
});
afterEach(() => { closeMemoryIndexReader(); eligibleLimits.chunk = 12000; scanLimits.chunks = 8; scanLimits.budgetMs = 700; });

function accessOf(bot = "a", thread = "thread-a"): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
}
/** Readable: an owner statement needs no evidence. Refused by memory_get and search alike: a tool observation with none. */
function add(id: string, scope: string, text: string, readable: boolean, status = "indexed") {
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',1,0,NULL,NULL,0)").run(id, scope, text);
  database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,?,'indexed',NULL)").run(id, status);
  if (readable) return;
  // Refused only by a full read, so it stays an eligible candidate: derived from a record that was forgotten. (A record with no
  // evidence is not eligible at all since round 5, so it could no longer stand in for a candidate the reader is refused.)
  if (!database().prepare("SELECT 1 FROM memory_records WHERE id='p-forgotten'").get()) {
    database().prepare("INSERT INTO memory_records VALUES('p-forgotten',1,?,'fact','gone','owner-statement','deleted',1,0,NULL,NULL,0)").run(scope);
    database().prepare("INSERT INTO memory_tombstones VALUES('t-p-forgotten','record','p-forgotten',NULL,NULL,1,'owner-forget',0)").run();
    // two steps up: the parent of each refused record is itself fine, so no statement over the record's direct parent spares it (round 6)
    database().prepare("INSERT INTO memory_records VALUES('p-middle',1,?,'fact','middle','owner-statement','active',1,0,NULL,NULL,0)").run(scope);
    database().prepare("INSERT INTO memory_derivations VALUES('p-forgotten',1,'p-middle',1)").run();
  }
  database().prepare("INSERT INTO memory_derivations VALUES('p-middle',1,?,1)").run(id);
}
const entry = (id: string, scopeId: string, text: string): IndexedMemory => ({ id, version: 1, scopeId, text, deleted: false });
function world(records: IndexedMemory[], vectors: Record<string, number[]> = {}) {
  closeMemoryIndexReader(); clearMemorySearchCache();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.upsert(records);
  for (const record of records) if (vectors[record.id]) index.vector(record, "model", 0, vectors[record.id]);
  return index;
}
/** The helper's real answer (answerQuery: eligibility, scan, lists) over a real index, as the worker gives it. */
function helper(index: MemoryIndex, vector: number[] | null): MemorySearchBridge {
  return { search: async (input: MemorySearchInput) => {
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    try { return answerQuery(index, eligibility, input, vector, "model").result; } finally { eligibility.close(); }
  } };
}
/** An answer with the parts that may legitimately differ between two calls (none of them) removed. */
const shown = (answer: Awaited<ReturnType<typeof searchMemory>>) => JSON.parse(JSON.stringify(answer));

describe("P1: equal scores order by (score, record id, version), never by cache or write order", () => {
  it("equal similarities order by record id whatever order the vectors were written in", () => {
    const records = ["m", "c", "x", "a"].map(id => entry(id, "s", "unrelated words"));
    const index = world(records, Object.fromEntries(records.map(record => [record.id, [1, 0]])));
    const found = index.search("nothing", records.map(record => ({ id: record.id, version: 1 })), [1, 0], "model", 20);
    expect(found.hits.map(hit => hit.id)).toEqual(["a", "c", "m", "x"]);
    expect(found.vectorRanked.map(ref => ref[0])).toEqual(["a", "c", "m", "x"]);
    index.close();
  });

  it("crossing the vector cache's capacity does not reorder equal-score results", { tags: ["nightly"], timeout: 60_000 }, () => {
    // 12,001 vectors written one after another overflow the resident cache (it is dropped and reloaded in table order);
    // before, results that tie came out in whichever order the cache happened to hold them.
    const ids = ["tie-z", "tie-b", "tie-m"];
    const small = world(ids.map(id => entry(id, "s", "alpha")), Object.fromEntries(ids.map(id => [id, [1, 0]])));
    const resident = small.search("alpha", ids.map(id => ({ id, version: 1 })), [1, 0], "model", 20).hits.map(hit => hit.id);
    small.close();
    const filler = Array.from({ length: 12_000 }, (_, n) => entry(`zz-filler-${String(n).padStart(5, "0")}`, "s", "filler"));
    const records = [...ids.map(id => entry(id, "s", "alpha")), ...filler];
    closeMemoryIndexReader();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
    const big = new MemoryIndex(INDEX_PATH());
    big.prepareModel("model");
    big.upsert(records);
    // one commit for the 12,003 writes: the cache sees them one after another all the same, and the run does not
    // measure the disk's flush (each autocommit was a full fsync: past the 60 s limit on a hosted Windows runner, 4 s on macOS)
    const file = (big as unknown as { db: DatabaseSync }).db;
    file.exec("BEGIN");
    for (const record of records) big.vector(record, "model", 0, ids.includes(record.id) ? [1, 0] : [0, 1]);
    file.exec("COMMIT");
    const crossed = big.search("alpha", ids.map(id => ({ id, version: 1 })), [1, 0], "model", 20).hits.map(hit => hit.id);
    big.close();
    expect(resident).toEqual(["tie-b", "tie-m", "tie-z"]);
    expect(crossed).toEqual(resident);
  });

  it("equal word ranks order by record id however the rows were written, through the helper's list and the main process's page", () => {
    const text = "harbour lantern notes for the Friday review";
    const ids = ["r-30", "r-10", "r-20"];
    const index = world(ids.map(id => entry(id, "s", text)));
    const helperList = index.search(QUERY, ids.map(id => ({ id, version: 1 })), null, "model", 20).lexicalRanked.map(ref => ref[0]);
    index.close();
    expect(helperList).toEqual(["r-10", "r-20", "r-30"]);
    const page = lexicalPage(QUERY, ["s"], 50);
    expect(page?.hits.map(hit => hit.id)).toEqual(["r-10", "r-20", "r-30"]);
  });

  it("a page is exact positions of the order (rank, id, version), also when a run of equal ranks spans the page edges", () => {
    // 12 rows, ranked -2 for the first 8 (written in descending id order) then -1: pages of 5 cut the run of 8 at 5
    const rows = Array.from({ length: 12 }, (_, n) => ({ id: `id-${String(n < 8 ? 7 - n : n).padStart(2, "0")}`, version: 1, rank: n < 8 ? -2 : -1 }));
    const fetch = (start: number, count: number) => rows.slice(start, start + count);
    const first = pageByRank(fetch, 0, 5), second = pageByRank(fetch, 5, 5), third = pageByRank(fetch, 10, 5);
    expect(first.rows.map(row => row.id)).toEqual(["id-00", "id-01", "id-02", "id-03", "id-04"]);
    expect(second.rows.map(row => row.id)).toEqual(["id-05", "id-06", "id-07", "id-08", "id-09"]);
    expect(third.rows.map(row => row.id)).toEqual(["id-10", "id-11"]);
    expect([first.more, second.more, third.more]).toEqual([true, true, false]);
  });

  it("a run of equal ranks longer than the first read is completed by one more read, and pages stay exact positions", () => {
    // 600 documents of one rank, written in descending id order, then 5 of a worse rank
    const rows = [...Array.from({ length: 600 }, (_, n) => ({ id: `d-${String(599 - n).padStart(3, "0")}`, version: 1, rank: -3 })), ...Array.from({ length: 5 }, (_, n) => ({ id: `e-${n}`, version: 1, rank: -1 }))];
    let reads = 0;
    const fetch = (start: number, count: number) => { reads++; return rows.slice(start, start + count); };
    const page = pageByRank(fetch, 100, 50);
    expect(page.rows.map(row => row.id)).toEqual(Array.from({ length: 50 }, (_, n) => `d-${String(100 + n).padStart(3, "0")}`));
    expect(page.more).toBe(true);
    expect(reads).toBe(2);
    reads = 0;
    expect(pageByRank(fetch, 0, 50).rows[0].id).toBe("d-000");
    expect(reads).toBe(2);
    reads = 0;
    pageByRank((start, count) => { reads++; return rows.slice(600).slice(start, start + count); }, 0, 3);
    expect(reads).toBe(1); // a short run (here none) costs no extra read
  });

  it("a whole response is the same however the equal-score records were written", async () => {
    const scope = ensureScope("bot", "a");
    for (const id of ["t-b", "t-a", "t-c"]) add(id, scope, "harbour lantern notes", true);
    const forward = world(["t-a", "t-b", "t-c"].map(id => entry(id, scope, "harbour lantern notes")), { "t-a": [1, 0], "t-b": [1, 0], "t-c": [1, 0] });
    const first = shown(await searchMemory(QUERY, accessOf(), helper(forward, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    forward.close();
    const backward = world(["t-c", "t-b", "t-a"].map(id => entry(id, scope, "harbour lantern notes")), { "t-c": [1, 0], "t-b": [1, 0], "t-a": [1, 0] });
    const second = shown(await searchMemory(QUERY, accessOf(), helper(backward, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    backward.close();
    expect(first.hits.map((hit: { id: string }) => hit.id)).toEqual(["t-a", "t-b", "t-c"]);
    expect(second).toEqual(first);
  });

  it("recent and keyword fallbacks order ties by record id, not by when a record was written", () => {
    const scope = ensureScope("bot", "a");
    for (const id of ["q-3", "q-1", "q-2"]) add(id, scope, "harbour lantern", true, "pending");
    expect(recentMemoryHits(QUERY, accessOf()).map(hit => hit.id)).toEqual(["q-1", "q-2", "q-3"]);
  });
});

describe("accepted residual: BM25 statistics are shared with denied documents", () => {
  it("PINNED AS KNOWN: eight denied documents move the order of two readable ones that tied (needs a per-scope index to close)", async () => {
    const scope = ensureScope("bot", "a");
    const fillers = Array.from({ length: 6 }, (_, n) => ({ id: `filler-${n}`, text: `lantern light number ${n} over the quay` }));
    const readable = [{ id: "A", text: "alpha notes about the quay" }, { id: "B", text: "beta notes about the quay" }, ...fillers];
    for (const row of readable) add(row.id, scope, row.text, true);
    const without = world(readable.map(row => entry(row.id, scope, row.text)));
    const quiet = await searchMemory("alpha beta", accessOf(), helper(without, null), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    without.close();
    const denied = Array.from({ length: 8 }, (_, n) => ({ id: `denied-${n}`, text: `alpha alpha alpha secret ${n}` }));
    for (const row of denied) add(row.id, scope, row.text, false);
    const withDenied = world([...readable, ...denied].map(row => entry(row.id, scope, row.text)));
    const noisy = await searchMemory("alpha beta", accessOf(), helper(withDenied, null), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    withDenied.close();
    expect(quiet.hits.map(hit => hit.id).slice(0, 2)).toEqual(["A", "B"]);
    expect(noisy.hits.map(hit => hit.id).slice(0, 2)).toEqual(["B", "A"]);
    // and nothing else about the answer moved: no denied id, no coverage or paging change
    expect(noisy.coverageComplete).toBe(quiet.coverageComplete);
    expect(JSON.stringify(noisy)).not.toContain("denied-");
  });
});

describe("P1: coverage, paging and cursors are decided over records the reader may read", () => {
  const kept = "harbour lantern notes for the Friday review of the long quiet quay and its many lights";
  const vectors = { kept: [0.6, 0.8] };

  for (const count of [0, 256, 257, 600, 1000]) {
    it(`${count} denied records without a vector leave coverage as it was`, async () => {
      const scope = ensureScope("bot", "a");
      add("kept", scope, kept, true);
      const records = [entry("kept", scope, kept)];
      database().exec("BEGIN");
      for (let n = 0; n < count; n++) { const id = `denied-${String(n).padStart(5, "0")}`; add(id, scope, "x", false); records.push(entry(id, scope, "x")); }
      database().exec("COMMIT");
      const index = world(records, vectors);
      const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
      index.close();
      expect(answer.hits.map(hit => hit.id)).toEqual(["kept"]);
      expect(answer.coverageComplete).toBe(true);
      expect(answer).not.toHaveProperty("nextCursor");
      expect(answer).not.toHaveProperty("degradedReason");
    }, 60_000);
  }

  it("a readable record without a vector makes coverage incomplete however many denied ones come first", async () => {
    const scope = ensureScope("bot", "a");
    add("kept", scope, kept, true);
    const records = [entry("kept", scope, kept)];
    for (let n = 0; n < 300; n++) { const id = `a-denied-${String(n).padStart(4, "0")}`; add(id, scope, "x", false); records.push(entry(id, scope, "x")); }
    add("zz-waiting", scope, "harbour lantern waiting for its vector", true);
    records.push(entry("zz-waiting", scope, "harbour lantern waiting for its vector"));
    const index = world(records, vectors);
    const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    index.close();
    expect(answer.coverageComplete).toBe(false);
  }, 60_000);

  it("past the 1,024 records the helper names, refused ones are read through to the end: coverage is as it was (round 5, no bound)", async () => {
    const scope = ensureScope("bot", "a");
    add("kept", scope, kept, true);
    const records = [entry("kept", scope, kept)];
    database().exec("BEGIN");
    for (let n = 0; n < 1100; n++) { const id = `denied-${String(n).padStart(5, "0")}`; add(id, scope, "x", false); records.push(entry(id, scope, "x")); }
    database().exec("COMMIT");
    const index = world(records, vectors);
    const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    index.close();
    expect(answer.hits.map(hit => hit.id)).toEqual(["kept"]);
    expect(answer.coverageComplete).toBe(true);
  }, 60_000);

  /** Found by meaning only (its words do not match the query), so the scan over the chunks is what finds it. */
  const quiet = "quiet quay notes about the boats";
  /** Records past the first scan chunk: `denied` refused ones ahead of the readable one in id order. Chunks of 40 stand in for 12,000. */
  function overChunk(denied: number, options: { keptLast?: boolean } = {}) {
    eligibleLimits.chunk = 40;
    const scope = ensureScope("bot", "a");
    const records: IndexedMemory[] = [];
    const vector: Record<string, number[]> = {};
    database().exec("BEGIN");
    for (let n = 0; n < denied; n++) { const id = `a-denied-${String(n).padStart(4, "0")}`; add(id, scope, "x", false); records.push(entry(id, scope, "x")); vector[id] = [1, 0]; }
    const keptId = options.keptLast === false ? "0-kept" : "z-kept";
    add(keptId, scope, quiet, true);
    records.push(entry(keptId, scope, quiet)); vector[keptId] = [0.6, 0.8];
    database().exec("COMMIT");
    return { index: world(records, vector), keptId };
  }
  /** The same reader and the same readable record with the refused ones gone (archived, so no longer eligible). */
  const alone = async () => {
    database().prepare("UPDATE memory_records SET state='archived' WHERE id LIKE 'a-denied-%'").run();
    const scope = ensureScope("bot", "a");
    const index = world([entry("z-kept", scope, quiet)], { "z-kept": [0.6, 0.8] });
    const answer = shown(await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    index.close();
    return answer;
  };

  it("eligible records the reader may not read, past the resident chunk, change nothing it sees (before: semantic-capacity-paged, a cursor, a lost hit)", async () => {
    const { index } = overChunk(130); // 130 refused records ahead of the readable one: four chunks of 40
    const crowded = shown(await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    index.close();
    const without = await alone();
    expect(crowded.hits.map((hit: { id: string }) => hit.id)).toEqual(["z-kept"]);
    expect(crowded).not.toHaveProperty("nextCursor");
    expect(crowded).not.toHaveProperty("degradedReason");
    expect(crowded).toEqual(without);
  }, 60_000);

  it("a scan that stops before the end pages on only when a record the reader may read is past the stop", async () => {
    scanLimits.chunks = 2; // two chunks of 40 scanned; the readable record is in the fourth
    const { index } = overChunk(130);
    const stopped = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    expect(stopped.degradedReason).toBe("semantic-capacity-paged");
    expect(stopped.coverageComplete).toBe(false);
    expect(stopped.nextCursor).toBeTruthy();
    expect(stopped.hits).toEqual([]);
    // following the cursor continues the scan and finds it
    clearMemorySearchCache();
    scanLimits.chunks = 8;
    const next = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20, cursor: stopped.nextCursor! });
    index.close();
    expect(next.hits.map(hit => hit.id)).toEqual(["z-kept"]);
    expect(next).not.toHaveProperty("nextCursor");
  }, 60_000);

  it("a scan that stops before the end while only refused records remain issues no cursor and does not change coverage", async () => {
    scanLimits.chunks = 1;
    const { index } = overChunk(130, { keptLast: false }); // the readable record sorts first; everything past the first chunk is refused
    const stopped = shown(await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    index.close();
    expect(stopped.hits.map((hit: { id: string }) => hit.id)).toEqual(["0-kept"]);
    expect(stopped).not.toHaveProperty("nextCursor");
    expect(stopped).not.toHaveProperty("degradedReason");
    expect(stopped.coverageComplete).toBe(true);
  }, 60_000);

  it("the helper reports where its scan stopped and nothing else about the size of the eligible set", () => {
    scanLimits.chunks = 2;
    const scope = ensureScope("bot", "a");
    const records: IndexedMemory[] = [];
    for (let n = 0; n < 130; n++) { const id = `r-${String(n).padStart(4, "0")}`; add(id, scope, "x", true); records.push(entry(id, scope, "x")); }
    eligibleLimits.chunk = 40;
    const index = world(records, Object.fromEntries(records.map(record => [record.id, [1, 0]])));
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    const access = accessOf();
    const input: MemorySearchInput = { query: QUERY, scopeIds: [...access.scopeIds], policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch, historical: false, cursor: "", limit: 10, semantic: true };
    const answered = answerQuery(index, eligibility, input, [1, 0], "model").result;
    eligibility.close(); index.close();
    expect(answered.vectorRows).toBe(80);
    expect(JSON.parse(answered.resumeAfter!)).toEqual(["r-0079", 1]);
    expect(answered).not.toHaveProperty("nextCursor");
    expect(answered).not.toHaveProperty("degradedReason");
  });

  it("pending projections in other scopes, or that the reader may not read, do not decide coverage", async () => {
    const scope = ensureScope("bot", "a"), other = ensureScope("bot", "b");
    add("kept", scope, kept, true);
    const failing: MemorySearchBridge = { search: async () => { throw new Error("MEMORY_WORKER_EXITED"); } };
    const index = world([entry("kept", scope, kept)]);
    const quiet = shown(await searchMemory(QUERY, accessOf(), failing, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    expect(quiet.coverageComplete).toBe(true);
    // somebody else's record is still owed its projection, and so is a record of this reader's that it may not read
    clearMemorySearchCache();
    add("theirs", other, kept, true, "pending");
    add("refused", scope, kept, false, "pending");
    const busy = shown(await searchMemory(QUERY, accessOf(), failing, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    expect(busy).toEqual(quiet);
    // one the reader may read is owed: coverage says so
    clearMemorySearchCache();
    add("readable-pending", scope, `${kept} pending`, true, "pending");
    const behind = await searchMemory(QUERY, accessOf(), failing, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    index.close();
    expect(behind.coverageComplete).toBe(false);
  });

  it("what other readers write cannot push this reader's unindexed records out of the recent fallback's window", () => {
    const scope = ensureScope("bot", "a"), other = ensureScope("bot", "b");
    add("mine", scope, "harbour lantern notes", true, "pending");
    database().exec("BEGIN");
    for (let n = 0; n < 3000; n++) add(`theirs-${n}`, other, "unrelated", true, "pending");
    database().exec("COMMIT");
    expect(recentMemoryHits(QUERY, accessOf()).map(hit => hit.id)).toEqual(["mine"]);
  });

  it("profile timings are private telemetry, not part of the answer", async () => {
    const scope = ensureScope("bot", "a");
    add("kept", scope, kept, true);
    const index = world([entry("kept", scope, kept)]);
    let service: unknown;
    const answer = await searchMemory(QUERY, accessOf(), helper(index, null), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", profile: true, telemetry: facts => { service = (facts as { service?: unknown }).service; } });
    index.close();
    expect(answer).not.toHaveProperty("serviceProfile");
    expect(answer).not.toHaveProperty("profileCacheHit");
    expect(service).toMatchObject({ cacheHit: false });
  });
});

describe("P2: cursors are stateless, so no reader's tokens can evict another's", () => {
  it("256 tokens issued to one reader do not invalidate another reader's fresh token", async () => {
    const { openMemoryCursor, sealMemoryCursor } = await import("./cursor.ts");
    const a = accessOf(), b = accessOf("b", "thread-b");
    const fresh = sealMemoryCursor("raw-for-a", a, false);
    for (let n = 0; n < 1000; n++) sealMemoryCursor(`raw-${n}`, b, false);
    expect(openMemoryCursor(fresh, a, false)).toBe("raw-for-a");
  });
  it("a token is refused to another reader, another history mode, after expiry, and when altered; and every token has one length", async () => {
    const { openMemoryCursor, sealMemoryCursor } = await import("./cursor.ts");
    const a = accessOf(), b = accessOf("b", "thread-b");
    const short = sealMemoryCursor("x", a, false, 1000), long = sealMemoryCursor(JSON.stringify(["a-very-long-record-id-".repeat(4), 7]), a, false, 1000);
    expect(short.length).toBe(long.length);
    expect(short.length).toBeLessThanOrEqual(MEMORY_CURSOR_MAX_CHARS); // what the memory tool and route accept
    expect(openMemoryCursor(short, a, false, 2000)).toBe("x");
    expect(() => openMemoryCursor(short, b, false, 2000)).toThrow("INVALID_MEMORY_CURSOR");
    expect(() => openMemoryCursor(short, a, true, 2000)).toThrow("INVALID_MEMORY_CURSOR");
    expect(() => openMemoryCursor(short, a, false, 1000 + 11 * 60_000)).toThrow("INVALID_MEMORY_CURSOR");
    const bytes = Buffer.from(short, "base64url"); bytes[20] ^= 1;
    expect(() => openMemoryCursor(bytes.toString("base64url"), a, false, 2000)).toThrow("INVALID_MEMORY_CURSOR");
    expect(() => openMemoryCursor("not-a-token", a, false, 2000)).toThrow("INVALID_MEMORY_CURSOR");
  });
});

describe("P2: a merge a deletion owes is durable and cannot be starved", () => {
  const rolled = (version: number) => ({ id: "checkpoint:t", version, scopeId: "s", text: "", deleted: true, rolled: true });
  const seed = (index: MemoryIndex) => index.upsert([1, 2, 3, 4].map(version => ({ id: "checkpoint:t", version, scopeId: "s", text: `Working evidence: version ${version}`, deleted: false })));

  it("the obligation survives a restart and is cleared only when the merge has run", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-merge-owed-")), path = join(root, "index.db");
    try {
      const first = new MemoryIndex(path);
      seed(first);
      first.upsert([rolled(1), rolled(2)]);
      expect(first.maintenanceOwed()).toBe(true);
      first.close(); // the app stops before the stepped maintenance ran
      const second = new MemoryIndex(path);
      expect(second.maintenanceOwed()).toBe(true);
      let steps = 0;
      while (!second.purgeRolledCheckpoints().done) if (++steps > 10_000) throw new Error("the stepped maintenance did not finish");
      expect(second.maintenanceOwed()).toBe(false);
      second.close();
      const third = new MemoryIndex(path);
      expect(third.maintenanceOwed()).toBe(false);
      third.close();
    } finally { removeTempDirSync(root); }
  });

  it("under load that never goes quiet, one bounded step still runs every MAINTENANCE_MAX_DEFER_MS", () => {
    const clock: MaintenanceClock = { deferredSince: null };
    const runs: number[] = [];
    for (let now = 0; now <= 10_000; now += MAINTENANCE_POLL_MS) if (maintenanceMayRun(clock, true, now)) runs.push(now);
    expect(runs.length).toBeGreaterThanOrEqual(9);
    for (let n = 1; n < runs.length; n++) expect(runs[n] - runs[n - 1]).toBeLessThanOrEqual(MAINTENANCE_MAX_DEFER_MS + MAINTENANCE_POLL_MS);
    // quiet: runs at once and resets the clock
    expect(maintenanceMayRun(clock, false, 20_000)).toBe(true);
    expect(clock.deferredSince).toBeNull();
    expect(maintenanceMayRun(clock, true, 20_001)).toBe(false);
  });
});

describe("P2: the helper-memory gate fails when nothing was measured", () => {
  const limit = 1024 ** 3;
  it("missing, zero, non-numeric and over-limit figures fail; a real measurement under the limit passes", () => {
    expect(workerMemoryGate({}, limit).ok).toBe(false);
    expect(workerMemoryGate({ workerPeakRssBytes: 0, workerRssSamples: 0 }, limit).ok).toBe(false);
    expect(workerMemoryGate({ workerPeakRssBytes: 500_000_000, workerRssSamples: 0 }, limit).ok).toBe(false);
    expect(workerMemoryGate({ workerPeakRssBytes: 0, workerRssSamples: 12 }, limit).ok).toBe(false);
    expect(workerMemoryGate({ workerPeakRssBytes: "n/a", workerRssSamples: 12 }, limit).ok).toBe(false);
    expect(workerMemoryGate({ workerPeakRssBytes: limit + 1, workerRssSamples: 12 }, limit).ok).toBe(false);
    expect(workerMemoryGate({ workerPeakRssBytes: 400_000_000, workerRssSamples: 12 }, limit).ok).toBe(true);
  });
});
