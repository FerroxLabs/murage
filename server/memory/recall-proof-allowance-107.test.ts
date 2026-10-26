// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 memory-recall-hydration D3: recall's search spends its own allowance (its time is the search's own hydration limit), and the bundle
// hydrates and re-proves the hits it selects on a fresh allowance of its own (recallProofBudget). Before this the two shared one allowance:
// a search that spent it made the bundle drop every hit the search had proved. F7: the bundle never shows a hit its own re-proof refused.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { recallHydrationLimitMs, searchMemory } from "./search.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

const roster = () => ({ bots: [{ id: "a", threadId: "new", tasks: [{ threadId: "new" }, { threadId: "old" }] }], groups: [] });
function access() {
  const r = roster(); reconcileMemoryRoster(r);
  const registry = new InternalCapabilities(), generation = registry.begin("a", "new");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "a", threadId: "new", generation, depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => r);
}
const empty = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
function remembered() {
  const a = access();
  appendMessage("old", { id: "preference", at: 123, role: "user", kind: "text", text: "My report colour is charcoal." });
  catchUpRecentMemory(a);
  return a;
}

it("the bundle hydrates and re-proves the hits it selected on its own proof allowance, never the search's: the search's allowance pays for the search alone", async () => {
  const a = remembered();
  // what the search alone spends (the same query, reader and limit the bundle asks with)
  const alone = LineageAllowance.tool(100_000);
  expect((await searchMemory("report colour", a, empty, { limit: 20, allowance: alone })).hits.length).toBeGreaterThan(0);
  const searched = LineageAllowance.tool(100_000), proof = LineageAllowance.tool(100_000);
  const bundle = await buildMemoryBundle("report colour", a, empty, { allowance: LineageAllowance.turn(), recallAllowance: searched, recallProofAllowance: proof });
  expect(bundle.text).toContain("charcoal");
  expect(bundle.recallPartial).toBeUndefined();
  expect(proof.remaining).toBeLessThan(100_000);
  expect(searched.remaining).toBeGreaterThanOrEqual(alone.remaining);
});

it("F7 the bundle never shows a hit its own re-proof refused: with the proof allowance spent the search's proven hit is left out, partial", async () => {
  const a = remembered();
  const proof = LineageAllowance.tool(); proof.close();
  const searched = LineageAllowance.search(recallHydrationLimitMs("turn"));
  const held = await buildMemoryBundle("report colour", a, empty, { allowance: LineageAllowance.turn(), recallAllowance: searched, recallProofAllowance: proof });
  expect(searched.hit).toBe(false); // the search proved its hit
  expect(held.text).not.toContain("charcoal");
  expect(held.recallPartial).toBe(true);
});

it("the search allowance's time is the search's own hydration limit: a turn's 1,000 ms, a tool's 3,500 ms", () => {
  expect(recallHydrationLimitMs("turn")).toBe(1000);
  expect(recallHydrationLimitMs("tool")).toBe(3500);
  expect(LineageAllowance.search(1000).scope).toBe("tool");
});
