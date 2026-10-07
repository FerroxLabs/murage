// A turn's memory search returns within its 500 ms budget whatever the worker is busy with:
// the budget starts before the synchronous preparation, a bridge that does not honour the
// abort cannot hold the turn, and the worker is told the deadline so it drops what no one waits for.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { searchMemory, SEARCH_BUDGET_MS, type MemorySearchBridge } from "./search.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";

const prep = vi.hoisted(() => ({ busyMs: 0 }));
vi.mock("./recent.ts", async importOriginal => {
  const original = await importOriginal<typeof import("./recent.ts")>();
  return { ...original, materializeRecentMemory: (...args: Parameters<typeof original.materializeRecentMemory>) => {
    const end = performance.now() + prep.busyMs; while (performance.now() < end) { /* a capture job holding the loop */ }
    return original.materializeRecentMemory(...args);
  } };
});

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); prep.busyMs = 0; });
function access() {
  const roster = { bots: [{ id: "a", threadId: "thread", section: "alpha" }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  registry.begin("a", "thread", "generation");
  const token = registry.mint({ botId: "a", threadId: "thread", generation: "generation", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}

it("a bridge busy on a long job and deaf to the abort cannot hold the turn past its budget", async () => {
  const slow: MemorySearchBridge = { search: () => new Promise(resolve => setTimeout(() => resolve({ hits: [], vectorRows: 0, coverageComplete: true }), 2500)) };
  // The roster and its fresh database are set up before the clock starts: the budget is the search's, not the fixture's.
  const memory = access();
  const started = performance.now();
  const result = await searchMemory("what is the plan", memory, slow);
  expect(performance.now() - started).toBeLessThan(SEARCH_BUDGET_MS + 300);
  expect(result.hits).toEqual([]);
  expect(result.degradedReason).toBe("MEMORY_RECALL_UNAVAILABLE");
});

it("the worker is told the deadline, counted from the start of the search and not from after its preparation", async () => {
  prep.busyMs = 200;
  let seen: MemorySearchInput | undefined;
  const bridge: MemorySearchBridge = { search: async input => { seen = input; return { hits: [], vectorRows: 0 }; } };
  const memory = access();
  const started = Date.now();
  await searchMemory("what is the plan", memory, bridge);
  expect(seen?.deadlineAt).toBeGreaterThanOrEqual(started + SEARCH_BUDGET_MS - 5);
  expect(seen?.deadlineAt).toBeLessThanOrEqual(started + SEARCH_BUDGET_MS + 60);
});
