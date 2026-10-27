// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 5 (lanes/msearch-review/r5/REPORT.md, BLOCK on 3f0a9d2b5). Every test here failed on that head.
//  P1  the authorization pass held the event loop for as long as the refused candidates took to read (857 ms on the 60k fixture);
//  P1  coverage, paging and cursors still turned on how many REFUSED records were examined (1,024 bounds);
//  P1  equal-rank pages repeated or lost rows once a run of equal ranks was longer than the tie window;
//  P2  a merge a walk's deletion owed lived only in memory below the merge threshold;
//  P2  the recent fallback stopped visiting scopes after 128 rows, and cut to 20 before authorization.
//
// "Refused only by a full read" below means a record the cheap statement cannot refuse: an owner statement whose ancestor was
// forgotten. (A record with no evidence, or a forgotten one, is not eligible at all.)
import v8 from "node:v8";
import vm from "node:vm";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { eligibleLimits, MemoryEligibility } from "./eligibility.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, lexicalPage, lexicalPageSliced } from "./index-reader.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import * as readableModule from "./readable.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const { readableMemoryRecord } = readableModule;
const plausiblyReadable = (...args: Parameters<typeof readableModule.plausiblyReadable>) => readableModule.plausiblyReadable(...args);
import { recentMemoryHits } from "./recent.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, searchMemory, type MemorySearchBridge } from "./search.ts";
import { answerQuery, scanLimits } from "./worker-query.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";
import { LineageAllowance } from "./lineage-allowance.ts";

const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }, { id: "b", threadId: "thread-b", section: "crew" }], groups: [] };
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const QUERY = "harbour lantern";
const TEXT = "harbour lantern notes for the Friday review of the long quiet quay and its many lights";

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
const entry = (id: string, scopeId: string, text: string): IndexedMemory => ({ id, version: 1, scopeId, text, deleted: false });
function addRecord(id: string, scope: string, text: string, assertion: string, status = "indexed") {
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,'active',1,0,NULL,NULL,0)").run(id, scope, text, assertion);
  database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,?,'indexed',NULL)").run(id, status);
}
/** Readable: an owner statement needs no evidence. */
const readable = (id: string, scope: string, text = TEXT, status = "indexed") => addRecord(id, scope, text, "owner-statement", status);
/** An owner statement the cheap statement cannot refuse: it was derived from a record that has since been forgotten, so only a
 * full read (readableMemoryRecord) refuses it. */
function deniedByRead(id: string, scope: string, text = TEXT, status = "indexed") {
  const db = database();
  if (!db.prepare("SELECT 1 FROM memory_records WHERE id='p-forgotten'").get()) {
    db.prepare("INSERT INTO memory_records VALUES('p-forgotten',1,?,'fact','gone','owner-statement','deleted',1,0,NULL,NULL,0)").run(scope);
    db.prepare("INSERT INTO memory_tombstones VALUES('t-p-forgotten','record','p-forgotten',NULL,NULL,1,'owner-forget',0)").run();
    // two steps up: the parent of each refused record is itself fine, so no statement over the record's direct parent spares it (round 6)
    db.prepare("INSERT INTO memory_records VALUES('p-middle',1,?,'fact','middle','owner-statement','active',1,0,NULL,NULL,0)").run(scope);
    db.prepare("INSERT INTO memory_derivations VALUES('p-forgotten',1,'p-middle',1)").run();
  }
  addRecord(id, scope, text, "owner-statement", status);
  db.prepare("INSERT INTO memory_derivations VALUES('p-middle',1,?,1)").run(id);
}
function world(records: IndexedMemory[], vectors: Record<string, number[]> = {}) {
  closeMemoryIndexReader(); clearMemorySearchCache();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.upsert(records);
  for (const record of records) if (vectors[record.id]) index.vector(record, "model", 0, vectors[record.id]);
  return index;
}
function helper(index: MemoryIndex, vector: number[] | null): MemorySearchBridge {
  return { search: async (input: MemorySearchInput) => {
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db"));
    try { return answerQuery(index, eligibility, input, vector, "model").result; } finally { eligibility.close(); }
  } };
}
const emptyBridge: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: true }) };
const failing: MemorySearchBridge = { search: async () => { throw new Error("MEMORY_WORKER_EXITED"); } };
/** The fixture's own garbage is collected before the stall is measured, so a collection of it is not counted against the search. */
function collectGarbage() { v8.setFlagsFromString("--expose-gc"); (vm.runInNewContext("gc") as () => void)(); }
/** This thread's own CPU time in ms (user + system). */
const threadCpuMs = () => { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1000; };
/**
 * The longest time the loop was held by work on this thread. Each gap between 1 ms ticks counts only the CPU this
 * thread spent inside it (never more than the gap itself), so a host that takes the CPU away from the process (the
 * sharded suite runs 16 at once) is not read as the search holding the loop, while any synchronous work, garbage
 * collection on this thread included, still counts in full.
 */
function loopHoldMonitor() {
  let longest = 0, wall = performance.now(), cpu = threadCpuMs();
  const sample = () => {
    const nowWall = performance.now(), nowCpu = threadCpuMs();
    longest = Math.max(longest, Math.min(nowWall - wall, nowCpu - cpu));
    wall = nowWall; cpu = nowCpu;
  };
  const ticker = setInterval(sample, 1);
  // Include the final interval even if the measured work never yielded to a tick.
  return { stop: () => { clearInterval(ticker); sample(); return longest; } };
}
/** Holds this thread for `ms` of its own CPU time, however busy the host is. */
const holdThread = (ms: number) => { const until = threadCpuMs() + ms; while (threadCpuMs() < until) { /* spin */ } };
const bulk = (work: () => void) => { database().exec("BEGIN"); try { work(); } finally { database().exec("COMMIT"); } };

describe("P1: authorization never holds the event loop", () => {
  it("the hold monitor sees a synchronous block: 80 ms of this thread's CPU reads as a hold of at least 75 ms", async () => {
    const monitor = loopHoldMonitor();
    await new Promise(resolve => setTimeout(resolve, 5));
    holdThread(80);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(monitor.stop()).toBeGreaterThanOrEqual(75);
  });

  it("the hold monitor counts a 150 ms synchronous block even when stopped before its first tick", () => {
    const monitor = loopHoldMonitor();
    try {
      holdThread(150);
    } finally {
      expect(monitor.stop()).toBeGreaterThanOrEqual(145);
    }
  });

  it("1,000 candidates only a full read refuses leave the loop free (median maximum stall under 50 ms over five uncached runs) and change nothing the reader sees", async () => {
    const scope = ensureScope("bot", "a");
    readable("kept", scope);
    const records = [entry("kept", scope, TEXT)];
    bulk(() => { for (let n = 0; n < 1000; n++) { const id = `a-denied-${String(n).padStart(4, "0")}`; deniedByRead(id, scope); records.push(entry(id, scope, TEXT)); } });
    world(records).close();
    // ids sort ahead of the readable one, so every refused candidate is read before it is reached
    const longest: number[] = [];
    for (let run = 0; run < 5; run++) {
      closeMemoryIndexReader(); clearMemorySearchCache();
      const access = accessOf();
      const allowance = LineageAllowance.tool(1_000_000_000);
      // Exclude fixture/prior-run garbage and yield before starting each measurement.
      collectGarbage();
      await new Promise<void>(resolve => setImmediate(resolve));
      const monitor = loopHoldMonitor();
      let answer: Awaited<ReturnType<typeof searchMemory>>;
      try {
        answer = await searchMemory(QUERY, access, emptyBridge, { allowance, caller: "tool", limit: 20 });
      } finally {
        longest.push(monitor.stop());
      }
      expect(answer.hits.map(hit => hit.id), `run ${run + 1}`).toEqual(["kept"]);
      expect(JSON.stringify(answer), `run ${run + 1}`).not.toContain("denied");
    }
    // A fixed five samples tolerate two noisy runs, not a consistently slower search.
    // Keep the original budget: three stalls of 50 ms or more still fail, including
    // a repeated 150 ms block. Do not retry until a passing sample is obtained.
    const median = [...longest].sort((a, b) => a - b)[2]!;
    expect(median, `per-run maximum CPU stalls (ms): ${longest.map(ms => ms.toFixed(3)).join(", ")}`).toBeLessThan(50);
  }, 60_000);

  it("100,000 mostly refused records (99,990 only a full read refuses) leave the loop free: longest stall under 50 ms, the search answers what it can inside its limit", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
    const scope = ensureScope("bot", "a");
    // the fixture is built in its own function so none of it stays referenced while the search is measured
    (() => {
      const records: IndexedMemory[] = [];
      for (let n = 0; n < 10; n++) { const id = `z-kept-${n}`; readable(id, scope); records.push(entry(id, scope, TEXT)); }
      bulk(() => { for (let n = 0; n < 99_990; n++) { const id = `a-denied-${String(n).padStart(6, "0")}`; deniedByRead(id, scope); records.push(entry(id, scope, TEXT)); } });
      world(records).close();
    })();
    await new Promise(resolve => setTimeout(resolve, 500)); collectGarbage();
    const monitor = loopHoldMonitor();
    const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    const longest = monitor.stop();
    console.log(`R5-100K max event-loop stall ${Math.round(longest * 10) / 10} ms, hits ${answer.hits.length}, degraded ${String(answer.degradedReason ?? "none")}`);
    expect(longest).toBeLessThan(50);
    expect(JSON.stringify(answer)).not.toContain("denied");
  });

  it("candidates certain to be refused (forgotten, no evidence) are spared the full read: one statement decides them for all", () => {
    const scope = ensureScope("bot", "a");
    readable("ok", scope);
    addRecord("no-evidence", scope, TEXT, "tool-observation");
    addRecord("forgotten", scope, TEXT, "owner-statement");
    database().prepare("INSERT INTO memory_tombstones VALUES('t-f','record','forgotten',NULL,NULL,1,'owner-forget',0)").run();
    const refs = ["ok", "no-evidence", "forgotten", "missing"].map(id => ({ id, version: 1 }));
    expect([...plausiblyReadable(refs, accessOf().scopeIds)]).toEqual(["ok:1"]);
  });

  it("the statement never refuses what readableMemoryRecord accepts (evidence, sources, tombstones, history), and a foreign scope still throws", () => {
    const db = database(), scope = ensureScope("bot", "a"), foreign = ensureScope("bot", "b");
    const source = (id: string, state = "active", revisions = 1) => {
      db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,?,'hash','message','user','succeeded',NULL,?)").run(id, scope, revisions, state);
      for (let n = 1; n <= revisions; n++) db.prepare("INSERT INTO memory_source_versions VALUES(?,?,'hash',?,1)").run(id, n, JSON.stringify({ text: "harbour lantern evidence text", occurredAt: 1 }));
    };
    const cited = (id: string, sourceId: string, revision: number, state = "active") => {
      db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'tool-observation',?,1,0,NULL,NULL,0)").run(id, scope, TEXT, state);
      db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,0,10)").run(id, sourceId, revision);
    };
    source("s-ok"); cited("good", "s-ok", 1);
    source("s-deleted", "deleted"); cited("deleted-source", "s-deleted", 1);
    source("s-edited", "active", 2); cited("stale-revision", "s-edited", 1);
    source("s-tomb"); cited("tombstoned-source", "s-tomb", 1);
    db.prepare("INSERT INTO memory_tombstones VALUES('t-s','source','s-tomb',NULL,NULL,1,'owner-forget',0)").run();
    source("s-arch"); cited("archived", "s-arch", 1, "archived");
    db.prepare("INSERT INTO memory_records VALUES('elsewhere',1,?,'fact',?,'owner-statement','active',1,0,NULL,NULL,0)").run(foreign, TEXT);
    const ids = ["good", "deleted-source", "stale-revision", "tombstoned-source", "archived"];
    const access = accessOf(), refs = ids.map(id => ({ id, version: 1 }));
    for (const mode of ["current", "historical"] as const) {
      const survivors = plausiblyReadable(refs, access.scopeIds, mode);
      for (const id of ids) {
        const accepted = typeof readableMemoryRecord(id, 1, access, { allowance: LineageAllowance.tool(1_000_000_000), mode, agent: true }) !== "string";
        if (accepted) expect({ mode, id, kept: survivors.has(`${id}:1`) }).toEqual({ mode, id, kept: true });
      }
    }
    expect([...plausiblyReadable(refs, access.scopeIds, "current")]).toEqual(["good:1"]);
    expect([...plausiblyReadable(refs, access.scopeIds, "historical")].sort()).toEqual(["archived:1", "good:1", "stale-revision:1"]);
    // a record outside the reader's scopes is not spared: reading it throws, loudly
    expect(plausiblyReadable([{ id: "elsewhere", version: 1 }], access.scopeIds).has("elsewhere:1")).toBe(true);
    expect(() => readableMemoryRecord("elsewhere", 1, access, { allowance: LineageAllowance.tool(1_000_000_000), mode: "current", agent: true })).toThrow("MEMORY_SCOPE_DENIED");
  });

  it("data that changes while the loop is released is read again: a record forgotten mid-search is not answered", async () => {
    const scope = ensureScope("bot", "a");
    readable("kept", scope); readable("withdrawn", scope);
    const records = ["kept", "withdrawn"].map(id => entry(id, scope, TEXT));
    for (let n = 0; n < 300; n++) { const id = `a-denied-${String(n).padStart(4, "0")}`; deniedByRead(id, scope); records.push(entry(id, scope, TEXT)); }
    world(records).close();
    let forgotten = false;
    // the first release of the loop (setImmediate) forgets a record that has already been accepted
    const original = globalThis.setImmediate;
    (globalThis as { setImmediate: typeof setImmediate }).setImmediate = ((callback: () => void, ...rest: unknown[]) => {
      if (!forgotten) {
        forgotten = true;
        database().prepare("UPDATE memory_records SET state='deleted' WHERE id='withdrawn'").run();
        database().exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
      }
      return (original as unknown as (...args: unknown[]) => unknown)(callback, ...rest);
    }) as typeof setImmediate;
    try {
      const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
      expect(forgotten).toBe(true);
      expect(answer.hits.map(hit => hit.id)).toEqual(["kept"]);
    } finally { (globalThis as { setImmediate: typeof setImmediate }).setImmediate = original; }
  }, 60_000);
});

describe("P1: coverage, paging and cursors do not depend on how many refused records were examined", () => {
  const vectors = { kept: [0.6, 0.8] };

  for (const count of [0, 300, 1100, 2600]) {
    it(`${count} refused records (only a full read refuses them) with no vector leave coverage complete and issue no cursor`, async () => {
      const scope = ensureScope("bot", "a");
      readable("kept", scope);
      const records = [entry("kept", scope, TEXT)];
      bulk(() => { for (let n = 0; n < count; n++) { const id = `denied-${String(n).padStart(5, "0")}`; deniedByRead(id, scope, "x"); records.push(entry(id, scope, "x")); } });
      const index = world(records, vectors);
      const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
      index.close();
      expect(answer.hits.map(hit => hit.id)).toEqual(["kept"]);
      expect(answer.coverageComplete).toBe(true);
      expect(answer).not.toHaveProperty("nextCursor");
      expect(answer).not.toHaveProperty("degradedReason");
    }, 120_000);
  }

  it("a readable record waiting for its vector past 1,100 refused ones makes coverage incomplete", async () => {
    const scope = ensureScope("bot", "a");
    readable("kept", scope);
    const records = [entry("kept", scope, TEXT)];
    bulk(() => { for (let n = 0; n < 1100; n++) { const id = `a-denied-${String(n).padStart(5, "0")}`; deniedByRead(id, scope, "x"); records.push(entry(id, scope, "x")); } });
    readable("zz-waiting", scope, `${TEXT} waiting for its vector`);
    records.push(entry("zz-waiting", scope, `${TEXT} waiting for its vector`));
    const index = world(records, vectors);
    const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    index.close();
    expect(answer.coverageComplete).toBe(false);
  }, 120_000);

  it("a scan that stops early with 1,500 refused records past it issues no cursor and leaves coverage as it was", async () => {
    eligibleLimits.chunk = 40; scanLimits.chunks = 1;
    const scope = ensureScope("bot", "a");
    readable("0-kept", scope, "quiet quay notes about the boats");
    const records = [entry("0-kept", scope, "quiet quay notes about the boats")];
    const vector: Record<string, number[]> = { "0-kept": [0.6, 0.8] };
    bulk(() => { for (let n = 0; n < 1500; n++) { const id = `a-denied-${String(n).padStart(4, "0")}`; deniedByRead(id, scope, "x"); records.push(entry(id, scope, "x")); vector[id] = [1, 0]; } });
    const index = world(records, vector);
    const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    index.close();
    expect(answer.hits.map(hit => hit.id)).toEqual(["0-kept"]);
    expect(answer).not.toHaveProperty("nextCursor");
    expect(answer).not.toHaveProperty("degradedReason");
    expect(answer.coverageComplete).toBe(true);
  }, 120_000);

  it("a cursor is issued only because a readable record lies past the stop, however many refused ones come first", async () => {
    eligibleLimits.chunk = 40; scanLimits.chunks = 1;
    const scope = ensureScope("bot", "a");
    readable("0-kept", scope, "quiet quay notes about the boats");
    const records = [entry("0-kept", scope, "quiet quay notes about the boats")];
    const vector: Record<string, number[]> = { "0-kept": [0.6, 0.8] };
    bulk(() => { for (let n = 0; n < 1500; n++) { const id = `a-denied-${String(n).padStart(4, "0")}`; deniedByRead(id, scope, "x"); records.push(entry(id, scope, "x")); vector[id] = [1, 0]; } });
    readable("z-last", scope, "quiet quay notes about the boats"); records.push(entry("z-last", scope, "quiet quay notes about the boats")); vector["z-last"] = [0.6, 0.8];
    const index = world(records, vector);
    const answer = await searchMemory(QUERY, accessOf(), helper(index, [1, 0]), { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    index.close();
    expect(answer.degradedReason).toBe("semantic-capacity-paged");
    expect(answer.nextCursor).toBeTruthy();
    expect(answer.coverageComplete).toBe(false);
  }, 120_000);

  it("1,500 pending projections the reader may not read leave coverage as it was; one it may read changes it", async () => {
    const scope = ensureScope("bot", "a");
    readable("kept", scope);
    world([entry("kept", scope, TEXT)]).close();
    bulk(() => { for (let n = 0; n < 1500; n++) deniedByRead(`pending-denied-${String(n).padStart(4, "0")}`, scope, TEXT, "pending"); });
    const quiet = await searchMemory(QUERY, accessOf(), failing, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    expect(quiet.coverageComplete).toBe(true);
    clearMemorySearchCache();
    readable("zz-pending", scope, `${TEXT} pending`, "pending");
    const behind = await searchMemory(QUERY, accessOf(), failing, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    expect(behind.coverageComplete).toBe(false);
  }, 120_000);
});

describe("P1: equal ranks order exactly by (rank, id, version) across pages", () => {
  const ids = Array.from({ length: 6000 }, (_, n) => `d-${String(n).padStart(4, "0")}`);
  const same = "harbour lantern notes for the Friday review";

  it("6,000 identical documents written in descending id order page disjointly and in id order", () => {
    const index = world([...ids].reverse().map(id => entry(id, "s", same)));
    const seen: string[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = lexicalPage(QUERY, ["s"], 50, offset)!;
      seen.push(...page.hits.map(hit => hit.id));
      if (!page.more) break;
    }
    const helperList = index.search(QUERY, ids.map(id => ({ id, version: 1 })), null, "model", 20).lexicalRanked.map(ref => ref[0]);
    index.close();
    expect(seen).toEqual(ids);
    expect(helperList).toEqual(ids.slice(0, 1000));
  }, 120_000);

  it("pages that straddle the old 4,096-row extension are the same rows as one page read from the start", () => {
    const index = world([...ids].reverse().map(id => entry(id, "s", same)));
    for (const offset of [4000, 4050, 4090, 4096, 5950]) {
      expect(lexicalPage(QUERY, ["s"], 50, offset)!.hits.map(hit => hit.id)).toEqual(ids.slice(offset, offset + 50));
    }
    index.close();
  }, 120_000);

  it("the sliced read the search uses answers exactly what the one-statement read answers, and releases the loop between slices", async () => {
    // Exact for every page while the matches fit what a recall of common words reads (since 1.0.2 that is the newest 4,000).
    const index = world([...ids.slice(0, 3000)].reverse().map(id => entry(id, "s", same)));
    let yields = 0;
    // a fast clock (7 ms for every 20 reads), so the scan releases the loop whatever the machine
    const originalNow = performance.now.bind(performance);
    let reads = 0;
    try {
      for (const offset of [0, 50, 2900, 2950, 2990]) {
        (performance as { now: () => number }).now = () => originalNow() + Math.floor(reads++ / 20) * 7;
        const page = await lexicalPageSliced(QUERY, ["s"], 50, offset, async () => { yields++; await new Promise<void>(resolve => setImmediate(resolve)); });
        (performance as { now: () => number }).now = originalNow;
        expect(page).toEqual(lexicalPage(QUERY, ["s"], 50, offset));
      }
    } finally { (performance as { now: () => number }).now = originalNow; }
    expect(yields).toBeGreaterThan(0);
    index.close();
  }, 120_000);
});

describe("P2: a merge a walk's deletion owes is written with the deletion", () => {
  const seed = (index: MemoryIndex) => index.upsert([1, 2, 3, 4, 5, 6].map(version => ({ id: "checkpoint:t", version, scopeId: "s", text: `Working evidence: version ${version}`, deleted: false })));

  it("a walk that stops below the merge threshold still owes its merge after a restart", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-walk-owed-")), path = join(root, "index.db");
    try {
      const first = new MemoryIndex(path);
      seed(first);
      const step = first.purgeRolledCheckpoints({ maxExamined: 2 });
      expect(step.removed).toBe(2);
      expect(step.done).toBe(false);
      first.close(); // the app stops mid-walk, below the threshold: nothing had started merging
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

  it("a removal whose merge could not run still owes it after a restart, and a removal that merged owes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-remove-owed-")), path = join(root, "index.db");
    try {
      const index = new MemoryIndex(path);
      index.upsert([entry("p-1", "s", "continuity note one"), entry("p-2", "s", "continuity note two")]);
      const raw = (index as unknown as { db: { exec(sql: string): void } }).db, exec = raw.exec.bind(raw);
      raw.exec = (sql: string) => { if (sql.includes("'optimize'")) throw new Error("disk full"); exec(sql); };
      expect(index.purgeRecords(["p-1"])).toBeGreaterThan(0);
      index.close();
      const second = new MemoryIndex(path);
      expect(second.maintenanceOwed()).toBe(true);
      expect(second.purgeRecords(["p-2"])).toBeGreaterThan(0); // merges now
      second.close();
      const third = new MemoryIndex(path);
      expect(third.maintenanceOwed()).toBe(false);
      third.close();
    } finally { removeTempDirSync(root); }
  });
});

describe("P2: the recent fallback visits every reachable scope, then authorizes and selects across all of them", () => {
  for (const [crowded, other] of [["bot", "conversation"], ["conversation", "bot"]] as const) {
    it(`${crowded} scope's 300 unrelated unindexed rows do not hide ${other} scope's match`, () => {
      const owner = (kind: string) => ensureScope(kind as "bot", kind === "bot" ? "a" : "thread-a");
      const busy = owner(crowded), quiet = owner(other);
      bulk(() => {
        for (let n = 0; n < 300; n++) readable(`busy-${String(n).padStart(3, "0")}`, busy, "unrelated words about something else", "pending");
        readable("match", quiet, TEXT, "pending");
      });
      expect(recentMemoryHits(QUERY, accessOf()).map(hit => hit.id)).toContain("match");
    });
  }

  it("refused matches that outrank a readable one cannot crowd it out of what is answered", async () => {
    const scope = ensureScope("bot", "a");
    bulk(() => {
      for (let n = 0; n < 40; n++) deniedByRead(`a-denied-${String(n).padStart(3, "0")}`, scope, TEXT, "pending");
      readable("z-readable", scope, TEXT, "pending");
    });
    const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20, lexical: null });
    expect(answer.hits.map(hit => hit.id)).toEqual(["z-readable"]);
    expect(answer.recentFallback).toBe(true);
  });
});
