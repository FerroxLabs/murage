// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 6 (lanes/msearch-review/r6/REPORT.md, BLOCK on d25523046). Every test here failed on that head.
//  P1  denied populations decided hits and coverage: the index ranked and limited records no reader can read;
//  P1  an expired revalidation advanced the revision stamp and returned records it had not read again;
//  P2  the word scan restarted at every write, had no deadline, and an expanding tail could prolong it;
//  P2  the recent fallback cut to 128 matches before authorization.
import v8 from "node:v8";
import vm from "node:vm";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced } from "./index-reader.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { readableMemoryRecord } from "./readable.ts";
import { recentMemoryHits } from "./recent.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, searchMemory, type MemorySearchBridge } from "./search.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { settleWal } from "../wal-maintenance.ts";

const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }, { id: "b", threadId: "thread-b", section: "crew" }], groups: [] };
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const QUERY = "harbour lantern";
const TEXT = "harbour lantern notes for the Friday review of the long quiet quay and its many lights";

beforeEach(() => {
  closeMemoryIndexReader(); closeDatabase(); clearMemorySearchCache();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(ROSTER); setMemoryMode("active");
});
afterEach(() => { closeMemoryIndexReader(); });

function accessOf(bot = "a", thread = "thread-a"): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
}
const entry = (id: string, scopeId: string, text: string): IndexedMemory => ({ id, version: 1, scopeId, text, deleted: false });
function addRecord(id: string, scope: string, text: string, assertion: string, status = "indexed", state = "active") {
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,?,1,0,NULL,NULL,0)").run(id, scope, text, assertion, state);
  database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,?,'indexed',NULL)").run(id, status);
}
const readable = (id: string, scope: string, text = TEXT, status = "indexed") => addRecord(id, scope, text, "owner-statement", status);
/** Derived directly from a record that has since been forgotten: the index query spares it. */
function deniedByAncestry(id: string, scope: string, text = TEXT, status = "indexed") {
  const db = database();
  if (!db.prepare("SELECT 1 FROM memory_records WHERE id='p-forgotten'").get()) {
    db.prepare("INSERT INTO memory_records VALUES('p-forgotten',1,?,'fact','gone','owner-statement','deleted',1,0,NULL,NULL,0)").run(scope);
    db.prepare("INSERT INTO memory_tombstones VALUES('t-p-forgotten','record','p-forgotten',NULL,NULL,1,'owner-forget',0)").run();
  }
  addRecord(id, scope, text, "owner-statement", status);
  db.prepare("INSERT INTO memory_derivations VALUES('p-forgotten',1,?,1)").run(id);
}
/** Derived from a record that is fine, itself derived from one that was forgotten: only the walk (a full read) refuses it. */
function deniedByWalk(id: string, scope: string, text = TEXT, status = "indexed") {
  const db = database();
  if (!db.prepare("SELECT 1 FROM memory_records WHERE id='p-middle'").get()) {
    deniedByAncestry("p-top", scope, "other words");
    readable("p-middle", scope, "other words");
    db.prepare("INSERT INTO memory_derivations VALUES('p-top',1,'p-middle',1)").run();
  }
  addRecord(id, scope, text, "owner-statement", status);
  db.prepare("INSERT INTO memory_derivations VALUES('p-middle',1,?,1)").run(id);
}
function world(records: IndexedMemory[]) {
  closeMemoryIndexReader(); clearMemorySearchCache();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = new MemoryIndex(INDEX_PATH());
  index.prepareModel("model");
  index.upsert(records);
  return index;
}
const emptyBridge: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: true }) };
function collectGarbage() { v8.setFlagsFromString("--expose-gc"); (vm.runInNewContext("gc") as () => void)(); }
const bulk = (work: () => void) => { database().exec("BEGIN"); try { work(); } finally { database().exec("COMMIT"); } };
/** The event loop while `work` runs: every gap between two 1 ms ticks. */
/** The fixture's 100,000-record commit leaves an ~87 MB log, which the log checkpointer (wal-maintenance.ts) copies in the background
 * in the first seconds after it. On the hosted macOS runner that copy overlapped the search and doubled to tripled it: one cold
 * search measured 2526 ms wall on 1174 ms of CPU with 4252 voluntary context switches and came back partial at the tool budget
 * (nightly 39529669758; probe CI 39699260907), while the same search after the copy took 726 ms with 2 switches. The search is the
 * subject here, not that one-off copy, so the log is settled (copied and restarted) before it is measured, as the server's own
 * maintenance leaves it. */
async function settledLog(): Promise<void> {
  expect(await settleWal({ nudge: true, deadlineAt: Date.now() + 120_000 })).toBe(true);
}
async function measured<T>(work: () => Promise<T>) {
  const gaps: number[] = [];
  let last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 1);
  last = performance.now();
  const started = performance.now();
  try {
    const value = await work();
    const sorted = [...gaps].sort((a, b) => a - b);
    return { value, longest: sorted.at(-1) ?? 0, p99: sorted[Math.floor(0.99 * (sorted.length - 1))] ?? 0, ms: performance.now() - started };
  } finally { clearInterval(ticker); }
}
/** The loop stays free: the slices are short (p99 under 30 ms on every OS) and no single stall passes the OS's ceiling. Measured on
 * hosted runners (CI 39361520531, 1 ms ticks over the whole search): p99 15.6-16.2 ms Linux, 16.1-21.7 ms macOS, 17.9-22.0 ms
 * Windows; the longest gap 26.6-35.0 ms Linux, 27.0-37.5 ms Windows, and 44-63 ms on the 3-core macOS VM, where one tick in a few
 * hundred lands on a scheduler pause (nightly 39345477364, CI 39357825825) while its p99 matches Linux. */
const LONGEST_STALL_MS = process.platform === "darwin" ? 100 : 50;
function expectLoopFree(run: { longest: number; p99: number }): void {
  expect(run.p99).toBeLessThan(30);
  expect(run.longest).toBeLessThan(LONGEST_STALL_MS);
}

describe("P1: a population no reader can read decides nothing the reader sees", () => {
  /** 10 readable records, and (with `denied`) 99,990 records refused by state, by a forgotten record, or by scope. Each denied
   * record is still in the word index (the index lags the authoritative tables, as it does after a forget). */
  function fixture(denied: boolean) {
    const scope = ensureScope("bot", "a"), foreign = ensureScope("bot", "b");
    const records: IndexedMemory[] = [];
    for (let n = 0; n < 10; n++) { const id = `z-kept-${n}`; readable(id, scope); records.push(entry(id, scope, TEXT)); }
    if (denied) {
      bulk(() => {
        for (let n = 0; n < 99_990; n++) {
          const id = `a-denied-${String(n).padStart(6, "0")}`;
          switch (n % 4) {
            case 0: addRecord(id, scope, TEXT, "owner-statement", "indexed", "deleted"); break;
            case 1: addRecord(id, scope, TEXT, "owner-statement"); database().prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,1,'owner-forget',0)").run(`t-${id}`, id); break;
            case 2: addRecord(id, foreign, TEXT, "owner-statement"); break;
            default: deniedByAncestry(id, scope);
          }
          records.push(entry(id, n % 4 === 2 ? foreign : scope, TEXT));
        }
      });
    }
    world(records).close();
  }

  it("99,990 records denied by state, forgetting, scope and a forgotten parent leave all ten readable hits, identical to the corpus without them, with the loop free", { tags: ["nightly"], timeout: 300_000 }, async () => {
    (() => fixture(true))();
    await new Promise(resolve => setTimeout(resolve, 500)); await settledLog(); collectGarbage();
    const crowded = await measured(() => searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    console.log(`R6-100K-STATE max event-loop stall ${Math.round(crowded.longest * 10) / 10} ms (p99 ${Math.round(crowded.p99 * 10) / 10}), ${Math.round(crowded.ms)} ms, hits ${crowded.value.hits.length}, partial ${String(crowded.value.partial ?? false)}`);
    expectLoopFree(crowded);
    expect(crowded.value.hits.map(hit => hit.id).sort()).toEqual(Array.from({ length: 10 }, (_, n) => `z-kept-${n}`));
    expect(crowded.value).not.toHaveProperty("partial");
    expect(crowded.value).not.toHaveProperty("degradedReason");
    expect(JSON.stringify(crowded.value)).not.toContain("denied");
    closeMemoryIndexReader(); closeDatabase(); clearMemorySearchCache();
    removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    reconcileMemoryRoster(ROSTER); setMemoryMode("active");
    fixture(false);
    const alone = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
    const plain = (answer: typeof alone) => JSON.parse(JSON.stringify(answer).replace(/"scopeId":"[^"]*"/g, '"scopeId":"S"'));
    expect(plain(crowded.value)).toEqual(plain(alone));
  });

  it("99,990 records only a two-step ancestry refuses (no query can spare them): the readable hits are all returned inside the limit, or the answer says it is partial", { tags: ["nightly"], timeout: 300_000 }, async () => {
    const scope = ensureScope("bot", "a");
    (() => {
      const records: IndexedMemory[] = [];
      for (let n = 0; n < 10; n++) { const id = `z-kept-${n}`; readable(id, scope); records.push(entry(id, scope, TEXT)); }
      bulk(() => { for (let n = 0; n < 99_990; n++) { const id = `a-denied-${String(n).padStart(6, "0")}`; deniedByWalk(id, scope); records.push(entry(id, scope, TEXT)); } });
      world(records).close();
    })();
    await new Promise(resolve => setTimeout(resolve, 500)); await settledLog(); collectGarbage();
    const run = await measured(() => searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 }));
    const answer = run.value;
    console.log(`R6-100K-ANCESTRY max event-loop stall ${Math.round(run.longest * 10) / 10} ms (p99 ${Math.round(run.p99 * 10) / 10}), ${Math.round(run.ms)} ms, hits ${answer.hits.length}, partial ${String(answer.partial ?? false)}`);
    expectLoopFree(run);
    expect(run.ms).toBeLessThan(6000);
    expect(JSON.stringify(answer)).not.toContain("denied");
    if (answer.hits.length === 10) expect(answer.hits.map(hit => hit.id).sort()).toEqual(Array.from({ length: 10 }, (_, n) => `z-kept-${n}`));
    // Not all ten: the answer says it is incomplete, cut at its deadline (partial) or past the newest matches it may read (bounded; since the
    // scoped postings, msearch2 r2c, the walk reaches that bound well inside the deadline).
    else { expect(answer.partial === true || answer.note !== undefined).toBe(true); expect(answer.coverageComplete).toBe(false); }
  });

  it("the index query never refuses a record readableMemoryRecord accepts (evidence, sources, tombstones, history), and refuses the ones nobody can read", async () => {
    const db = database(), scope = ensureScope("bot", "a");
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
    addRecord("owner", scope, TEXT, "owner-statement");
    addRecord("forgotten", scope, TEXT, "owner-statement");
    db.prepare("INSERT INTO memory_tombstones VALUES('t-f','record','forgotten',NULL,NULL,1,'owner-forget',0)").run();
    addRecord("no-evidence", scope, TEXT, "tool-observation");
    const ids = ["good", "deleted-source", "stale-revision", "tombstoned-source", "archived", "owner", "forgotten", "no-evidence"];
    world(ids.map(id => entry(id, scope, TEXT))).close();
    const access = accessOf();
    for (const mode of ["current", "historical"] as const) {
      const page = await lexicalPageSliced(QUERY, access.scopeIds, 50, 0, undefined, { eligible: true, historical: mode === "historical" });
      const returned = new Set(page!.hits.map(hit => hit.id));
      for (const id of ids) {
        const accepted = typeof readableMemoryRecord(id, 1, access, { allowance: LineageAllowance.tool(1_000_000_000), mode, agent: true }) !== "string";
        if (accepted) expect({ mode, id, returned: returned.has(id) }).toEqual({ mode, id, returned: true });
      }
      expect([...returned].sort()).toEqual(mode === "current" ? ["good", "owner"] : ["archived", "good", "owner", "stale-revision"]);
    }
  });
});

describe("P1: an expired revalidation returns nothing it did not read again", () => {
  it("a record forgotten after it was accepted is not answered when the deadline ends the second read", async () => {
    const scope = ensureScope("bot", "a");
    readable("kept", scope); readable("withdrawn", scope);
    world(["kept", "withdrawn"].map(id => entry(id, scope, TEXT))).close();
    let stamps = 0, skew = 0, forgotten = false;
    const originalNow = performance.now.bind(performance), db = database(), prepare = db.prepare.bind(db);
    // The first read of the revision stamp happens when the records are accepted; the second starts the revalidation. Just before
    // it: a record already accepted is forgotten, and the clock jumps past the hydration limit.
    db.prepare = ((sql: string) => {
      if (sql.includes("SELECT data_revision,policy_revision,deletion_epoch FROM memory_meta") && ++stamps === 2) {
        prepare("UPDATE memory_records SET state='deleted' WHERE id='withdrawn'").run();
        prepare("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1").run();
        forgotten = true; skew = 60_000;
      }
      return prepare(sql);
    }) as typeof db.prepare;
    (performance as { now: () => number }).now = () => originalNow() + skew;
    try {
      const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
      expect(forgotten).toBe(true);
      expect(answer.hits.map(hit => hit.id)).not.toContain("withdrawn");
      expect(answer.hits).toEqual([]);
      expect(answer.partial).toBe(true);
    } finally {
      (performance as { now: () => number }).now = originalNow;
      db.prepare = prepare as typeof db.prepare;
    }
  }, 60_000);
});

describe("P2: the word scan reads one snapshot and stops at its deadline", () => {
  const ids = Array.from({ length: 6000 }, (_, n) => `d-${String(n).padStart(4, "0")}`);
  const same = "harbour lantern notes for the Friday review";

  it("a writer that commits at every yield cannot restart or starve the scan, and the page is the snapshot's", async () => {
    const index = world(ids.map(id => entry(id, "s", same)));
    const expected = (await lexicalPageSliced(QUERY, ["s"], 50, 0))!.hits.map(hit => hit.id);
    closeMemoryIndexReader();
    let yields = 0;
    // Since 1.0.2 a scan steps only the matches it needs, which a fast machine does inside one slice: the clock runs fast here
    // (7 ms for every 20 reads), so the scan releases the loop many times whatever the machine, and a writer commits at each.
    const originalNow = performance.now.bind(performance);
    let reads = 0;
    (performance as { now: () => number }).now = () => originalNow() + Math.floor(reads++ / 20) * 7;
    let page;
    try {
      page = await lexicalPageSliced(QUERY, ["s"], 50, 0, async () => {
        index.upsert([entry(`a-late-${yields++}`, "s", same)]);
        await new Promise<void>(resolve => setImmediate(resolve));
      });
    } finally { (performance as { now: () => number }).now = originalNow; }
    index.close();
    expect(yields).toBeGreaterThan(1);
    expect(page).not.toBeNull();
    expect(page!.hits.map(hit => hit.id)).toEqual(expected);
    expect(page).not.toHaveProperty("partial");
  }, 120_000);

  it("at its deadline the scan answers what it read, flagged partial, with no further windows read", async () => {
    const index = world(ids.map(id => entry(id, "s", same)));
    let yields = 0;
    const page = await lexicalPageSliced(QUERY, ["s"], 50, 0, async () => { yields++; await new Promise<void>(resolve => setTimeout(resolve, 25)); }, { deadlineAt: Date.now() + 5 });
    const late = await lexicalPageSliced(QUERY, ["s"], 50, 0, undefined, { deadlineAt: Date.now() - 1 });
    index.close();
    expect(page?.partial).toBe(true);
    expect(page?.more).toBe(false);
    expect(yields).toBeLessThanOrEqual(2);
    expect(late?.partial).toBe(true);
    expect(late?.hits).toEqual([]);
  }, 120_000);

  it("a search whose scan hit its deadline reports partial, never complete", async () => {
    const scope = ensureScope("bot", "a");
    const records: IndexedMemory[] = [];
    bulk(() => { for (let n = 0; n < 3000; n++) { const id = `r-${String(n).padStart(4, "0")}`; readable(id, scope); records.push(entry(id, scope, TEXT)); } });
    world(records).close();
    const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20, lexical: (q, scopes, limit, offset) => lexicalPageSliced(q, scopes, limit, offset, undefined, { eligible: true, deadlineAt: Date.now() - 1 }) });
    expect(answer.partial).toBe(true);
    expect(answer.coverageComplete).toBe(false);
  }, 120_000);
});

describe("P2: the recent fallback authorizes before it selects", () => {
  it("128 refused equal-score matches in one scope do not exclude another scope's readable match", async () => {
    const busy = ensureScope("bot", "a"), quiet = ensureScope("conversation", "thread-a");
    bulk(() => {
      for (let n = 0; n < 128; n++) deniedByWalk(`a-denied-${String(n).padStart(3, "0")}`, busy, TEXT, "pending");
      readable("z-match", quiet, TEXT, "pending");
    });
    expect(recentMemoryHits(QUERY, accessOf()).map(hit => hit.id)).toContain("z-match");
    const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20, lexical: null });
    expect(answer.hits.map(hit => hit.id)).toEqual(["z-match"]);
    expect(answer.recentFallback).toBe(true);
  });

  it("matches nobody can read (forgotten, resting on nothing) are not candidates at all", () => {
    const scope = ensureScope("bot", "a");
    bulk(() => {
      for (let n = 0; n < 200; n++) { const id = `a-gone-${String(n).padStart(3, "0")}`; addRecord(id, scope, TEXT, "owner-statement", "pending"); database().prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,1,'owner-forget',0)").run(`t-${id}`, id); }
      addRecord("no-evidence", scope, TEXT, "tool-observation", "pending");
      readable("z-ok", scope, TEXT, "pending");
    });
    expect(recentMemoryHits(QUERY, accessOf()).map(hit => hit.id)).toEqual(["z-ok"]);
  });
});
