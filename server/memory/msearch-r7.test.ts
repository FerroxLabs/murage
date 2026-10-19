// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 7 (lanes/msearch-review/r7/REPORT.md). Both fail on 8fa045581.
//  P1  an incomplete revalidation kept the records it had already read again, though their source moved after that read;
//  P2  overlapping scan snapshots under continuous capture kept the write-ahead log from ever being truncated.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { MemoryIndex, walBytes, type IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, lexicalPageSliced, setWalCheckpointRequester, resetScanAdmission, setWalDrainThreshold } from "./index-reader.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, searchMemory, setAuthorizeSliceMsForTest, type MemorySearchBridge } from "./search.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const ROSTER: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a", section: "crew" }], groups: [] };
const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const QUERY = "harbour lantern";
const TEXT = "harbour lantern notes for the Friday review of the long quiet quay and its many lights";

beforeEach(() => {
  resetScanAdmission(); closeMemoryIndexReader(); closeDatabase(); clearMemorySearchCache();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(ROSTER); setMemoryMode("active");
});
afterEach(() => { resetScanAdmission(); closeMemoryIndexReader(); setWalCheckpointRequester(null); setWalDrainThreshold(64 * 1024 * 1024); setAuthorizeSliceMsForTest(8); });

function accessOf(): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin("a", "thread-a");
  const token = registry.mint({ botId: "a", threadId: "thread-a", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
}
const entry = (id: string, scopeId: string, text: string): IndexedMemory => ({ id, version: 1, scopeId, text, deleted: false });
function readable(id: string, scope: string) {
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',1,0,NULL,NULL,0)").run(id, scope, TEXT);
  database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,?,'indexed',NULL)").run(id, "indexed");
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

describe("P1: a half-finished revalidation keeps nothing it read before the loop was released", () => {
  it("A is read again, its source moves while the loop is released, the deadline comes before B: A is not answered", async () => {
    const scope = ensureScope("bot", "a");
    readable("rec-a", scope); readable("rec-b", scope);
    world(["rec-a", "rec-b"].map(id => entry(id, scope, TEXT))).close();
    setAuthorizeSliceMsForTest(0);
    let stamps = 0, skew = 0, moved = false, started = false;
    const originalNow = performance.now.bind(performance), originalImmediate = globalThis.setImmediate, db = database(), prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("SELECT data_revision,policy_revision,deletion_epoch FROM memory_meta") && ++stamps === 2) {
        prepare("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1").run();
        started = true;
      }
      return prepare(sql);
    }) as typeof db.prepare;
    // The first turn released after the revalidation began: the source of every accepted record moves, and the clock passes the limit.
    (globalThis as { setImmediate: unknown }).setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (started && !moved) {
        moved = true; skew = 60_000;
        prepare("UPDATE memory_records SET state='deleted' WHERE id IN ('rec-a','rec-b')").run();
        prepare("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1").run();
      }
      return originalImmediate(fn, ...args);
    }) as typeof setImmediate;
    (performance as { now: () => number }).now = () => originalNow() + skew;
    try {
      const answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.tool(1_000_000_000), caller: "tool", limit: 20 });
      expect(moved).toBe(true);
      expect(answer.hits).toEqual([]);
      expect(answer.partial).toBe(true);
    } finally {
      (performance as { now: () => number }).now = originalNow;
      (globalThis as { setImmediate: unknown }).setImmediate = originalImmediate;
      db.prepare = prepare as typeof db.prepare;
    }
  }, 60_000);
});

describe("P2: when the log is over its threshold, admission drains open scans so the log gets a window to be truncated", () => {
  const ids = Array.from({ length: 6000 }, (_, n) => `d-${String(n).padStart(4, "0")}`);
  const same = "harbour lantern notes for the Friday review";

  it("continuous capture plus overlapping scans: the writer checkpoints between them, so the log does not carry over", async () => {
    const index = world(ids.map(id => entry(id, "s", same)));
    setWalDrainThreshold(1);
    let truncated = 0;
    setWalCheckpointRequester(() => { const ok = index.checkpointIfLarge(1); if (ok) truncated++; return ok; });
    const events: string[] = [];
    let captures = 0, second: ReturnType<typeof lexicalPageSliced> | null = null, secondFirstLog = -1;
    const first = lexicalPageSliced(QUERY, ["s"], 50, 0, async () => {
      index.upsert([entry(`late-${captures++}`, "s", same)]);
      if (!second) {
        second = lexicalPageSliced(QUERY, ["s"], 50, 0, async () => {
          if (secondFirstLog < 0) { secondFirstLog = walBytes(INDEX_PATH()); events.push("second-reads"); }
          await new Promise<void>(resolve => setImmediate(resolve));
        }, { deadlineAt: Date.now() + 20_000 });
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }).then(page => { events.push("first-done"); return page; });
    const firstPage = await first;
    const secondPage = await second!;
    index.close();
    expect(captures).toBeGreaterThan(0);
    expect(firstPage).not.toBeNull();
    expect(secondPage).not.toBeNull();
    expect(events).toEqual(["first-done", "second-reads"]);
    expect(truncated).toBeGreaterThan(0);
    // when the second scan opened, no snapshot of the first was holding the log and it had been truncated
    expect(secondFirstLog).toBe(0);
  }, 120_000);
});
