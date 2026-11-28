// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1024-memsearch (cause D): full memory search answered nothing while capture was writing. Every captured message bumps
// memory_meta.data_revision (capture.ts), and turn recall read every accepted record again each time the revision moved while
// the loop was released, up to three rounds, then answered nothing; or ran out of its hydration allowance doing so and dropped
// all of it. Server log: "[memory] recall caller=turn cause=MEMORY_RECALL_HYDRATION_LIMIT outcome=empty hits=0 ms=1058".
// Owners: this witness and server/memory/search.ts recall = q1024-memsearch; capture writers = their own lanes (read only here).
import { openTestIndex, put } from "./testing/open-index.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import type { IndexedMemory } from "./index.ts";
import { closeMemoryIndexReader, resetScanAdmission } from "./index-reader.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, recallHydrationLimitMs, searchMemory, type MemorySearchBridge } from "./search.ts";
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
afterEach(() => { resetScanAdmission(); closeMemoryIndexReader(); });

function accessOf(): MemoryAccess {
  const registry = new InternalCapabilities(), generation = registry.begin("a", "thread-a");
  const token = registry.mint({ botId: "a", threadId: "thread-a", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
}
const emptyBridge: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: true }) };

async function history(count: number): Promise<string> {
  const scope = ensureScope("bot", "a");
  const insert = database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',1,0,NULL,NULL,0)");
  const receipt = database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,?,'indexed',NULL)");
  const records: IndexedMemory[] = [];
  database().exec("BEGIN");
  for (let n = 0; n < count; n++) {
    const id = `rec-${String(n).padStart(5, "0")}`;
    insert.run(id, scope, `${TEXT} ${n}`); receipt.run(id, "indexed");
    records.push({ id, version: 1, scopeId: scope, text: `${TEXT} ${n}`, deleted: false });
  }
  database().exec("COMMIT");
  closeMemoryIndexReader(); clearMemorySearchCache();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${INDEX_PATH()}${suffix}`, { force: true });
  const index = await openTestIndex(INDEX_PATH());
  index.prepareModel("model");
  await put(index, records);
  index.close();
  return scope;
}

/** What capture does for every captured message (capture.ts), on a timer, for as long as the search runs. */
function captureStorm(): () => number {
  const bump = database().prepare("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  let writes = 0;
  const timer = setInterval(() => { bump.run(); writes++; }, 1);
  return () => { clearInterval(timer); return writes; };
}

describe("q1024-memsearch D: turn recall answers while capture keeps writing", () => {
  for (const count of [400, 1000]) {
    it(`N=${count}: hits come back, not an empty answer, while data_revision moves under the search`, async () => {
      await history(count);
      const stop = captureStorm();
      let answer: Awaited<ReturnType<typeof searchMemory>>;
      try {
        answer = await searchMemory(QUERY, accessOf(), emptyBridge, { allowance: LineageAllowance.search(recallHydrationLimitMs("turn")), caller: "turn", limit: 20 });
      } finally { expect(stop()).toBeGreaterThan(0); }
      expect(answer.hits.length).toBe(20);
    }, 60_000);
  }

  // A record withdrawn while the loop is released is guarded by msearch-r7:78 and xthread-audience-recall :257 :280 :334 (DROP RED);
  // a row here could not reach a release between acceptance and the answer, so it guarded nothing and is not kept.
});
