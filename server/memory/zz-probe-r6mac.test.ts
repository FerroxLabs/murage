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
  // TEMPORARY PROBE (not for merge): where the 100k denied-population search spends its time on each OS.
  it("probe: the 100k STATE search, cold, warm and after a checkpoint", { timeout: 600_000 }, async () => {
    (() => fixture(true))();
    await new Promise(resolve => setTimeout(resolve, 500)); collectGarbage();
    for (const round of ["cold", "warm-os-cache", "after-checkpoint", "again"]) {
      if (round !== "cold") { closeMemoryIndexReader(); clearMemorySearchCache(); }
      if (round === "after-checkpoint") database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const cpu = process.cpuUsage(), ru = process.resourceUsage();
      let tele: unknown;
      const r = await measured(() => searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20, profile: true, telemetry: facts => { tele = facts; } }));
      const used = process.cpuUsage(cpu), ru2 = process.resourceUsage();
      console.log(`PROBE ${process.platform} ${round} wall=${Math.round(r.ms)} user=${Math.round(used.user / 1000)} sys=${Math.round(used.system / 1000)} vcsw=${ru2.voluntaryContextSwitches - ru.voluntaryContextSwitches} ivcsw=${ru2.involuntaryContextSwitches - ru.involuntaryContextSwitches} fsRead=${ru2.fsRead - ru.fsRead} majflt=${ru2.majorPageFault - ru.majorPageFault} longest=${Math.round(r.longest)} p99=${Math.round(r.p99)} hits=${r.value.hits.length} partial=${String(r.value.partial ?? false)} tele=${JSON.stringify(tele)}`);
    }
  });
});

void [lexicalPageSliced, readableMemoryRecord, recentMemoryHits, deniedByWalk, expectLoopFree];
