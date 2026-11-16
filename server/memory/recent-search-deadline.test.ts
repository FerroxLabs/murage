// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { beforeEach, afterEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { clearMemorySearchCache, recallHydrationLimitMs, searchMemory } from "./search.ts";
import { prepareRecallContext, stopRecallViewMaintenance } from "./recall-view.ts";
import { VIEW_RECENT_PAGE_SQL } from "./recall-view-index.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "a", threadId: "thread-a", section: "crew" }], groups: [] };
beforeEach(async () => {
  closeMemoryIndexReader(); closeDatabase(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); clearMemorySearchCache();
});
afterEach(async () => { closeMemoryIndexReader(); closeDatabase(); await stopWalMaintenance(); });
it.each([80, 800])("recent fallback shares the search deadline across %i granted scopes and reports incomplete coverage", async scopes => {
  const db = database(); db.exec("BEGIN");
  for (let n = 0; n < scopes; n++) {
    const scope = ensureScope("bot", "extra-" + n);
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot','a',0,'granted','{}')").run("grant-" + n, scope);
  }
  // MAIN RULING INT-CONFLICT-DEFAULT 2a6ffba1cde2 c87407505e: the admitted reference page replaces
  // the legacy per-scope query; keep every deadline and partial-result assertion.
  const scope = ensureScope("bot", "a");
  const insert = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'continuity-brief','fixture','owner-statement','active',0,1,NULL,NULL,1)");
  for (let n = 0; n < 2048; n++) insert.run(`fixture-${n}`, scope);
  db.exec("COMMIT");
  await prepareRecallContext("a", "thread-a", roster); stopRecallViewMaintenance();
  const registry = new InternalCapabilities(), generation = registry.begin("a", "thread-a");
  const token = registry.mint({ botId: "a", threadId: "thread-a", generation, depth: 0, kind: "memory", skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  expect(access.scopeIds.length).toBeGreaterThanOrEqual(scopes);
  const realNow = performance.now.bind(performance), prepare = db.prepare.bind(db);
  let cost = 0, reads = 0;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql !== VIEW_RECENT_PAGE_SQL) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "all") return (...args: unknown[]) => { reads++; cost += 40; return Reflect.apply(value, target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof db.prepare;
  (performance as { now(): number }).now = () => realNow() + cost;
  try {
    const answer = await searchMemory("harbour lantern", access, { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: true }) },
      { allowance: LineageAllowance.tool(1_000_000_000), lexical: null });
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(Math.ceil(recallHydrationLimitMs("turn") / 40) + 1);
    expect(answer.hits).toEqual([]);
    expect(answer.partial).toBe(true);
    expect(answer.coverageComplete).toBe(false);
  } finally { (performance as { now(): number }).now = realNow; db.prepare = prepare as typeof db.prepare; }
});
