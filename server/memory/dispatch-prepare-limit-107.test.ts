// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 RC3 Windows gate (fuigo.5): a manual routine run ended status=failed error=MEMORY_REPLAY_LIMIT 0.8 s in, before any engine turn.
// MemoryDispatchReceipt's constructor (prepareMemoryDisclosure) and assertCurrent() re-prove the whole frame with assertMemoryBundle on one
// tool read's allowance (100 ms). A record that reads "checking", or a re-proof that runs out of that allowance, threw the raw limit error,
// which no dispatch caller rebuilds on: index.ts startTurn's catch passed it to onDispatchError, and routines.failThread wrote it as the
// run's error. The limit means "not proven yet, withheld for now" and must never fail a turn or a run: both now refuse as a revoked context
// (MEMORY_CONTEXT_REVOKED, tagged unproven, the limit kept as its cause), the same mapping acceptance already uses, so the turn rebuilds.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryBundle, buildMemoryBundle } from "./bundle.ts";
import { authorityStamp, bumpAuthorityHard } from "./authority-epoch.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { LineageAllowance, setLineageTimeBudgetForTest } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setLineageTimeBudgetForTest(undefined); vi.restoreAllMocks(); closeDatabase(); });

const empty = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
/** A built frame holding one remembered record, no receipt yet. */
async function frame() {
  const roster = { bots: [{ id: "a", threadId: "new", tasks: [{ threadId: "new" }, { threadId: "old" }] }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin("a", "new");
  const access = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "a", threadId: "new", generation, depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  appendMessage("old", { id: "preference", at: 123, role: "user", kind: "text", text: "My report colour is charcoal." });
  catchUpRecentMemory(access);
  const bundle = await buildMemoryBundle("report colour", access, empty, { allowance: LineageAllowance.turn() });
  expect(bundle.text).toContain("charcoal");
  const row = database().prepare("SELECT scope_id FROM memory_records WHERE text LIKE '%charcoal%' LIMIT 1").get()!;
  return { bundle, access, scopeId: String(row.scope_id) };
}
function refusalOf(run: () => void): Error & { unproven?: unknown; cause?: unknown } {
  try { run(); } catch (error) { return error as Error & { unproven?: unknown; cause?: unknown }; }
  throw new Error("expected a refusal");
}
const expectUnprovenRevoke = (refusal: Error & { unproven?: unknown; cause?: unknown }) => {
  expect(refusal.message).toBe("MEMORY_CONTEXT_REVOKED");
  expect(refusal.unproven).toBe("memory-frame-checking");
  expect((refusal.cause as Error).message).toBe("MEMORY_REPLAY_LIMIT");
};

it("prepare: a frame record checking when the receipt is made is refused as a revoked context, never the raw limit, and nothing is prepared", async () => {
  const { bundle, access, scopeId } = await frame();
  new WritetimeFixture(database()).pendingScope(scopeId, 1);
  expectUnprovenRevoke(refusalOf(() => new MemoryDispatchReceipt(bundle, access, "driver")));
  expect(database().prepare("SELECT COUNT(*) AS n FROM memory_disclosures").get()!.n).toBe(0);
});

it("prepare: the frame re-proof running out of its allowance (forced: a 0 ms budget, the slow first run) is refused the same way", async () => {
  const { bundle, access } = await frame();
  setLineageTimeBudgetForTest(0);
  expectUnprovenRevoke(refusalOf(() => new MemoryDispatchReceipt(bundle, access, "driver")));
});

it("assertCurrent: a frame record checking right before dispatch is refused as a revoked context, never the raw limit", async () => {
  const { bundle, access, scopeId } = await frame();
  const receipt = new MemoryDispatchReceipt(bundle, access, "driver");
  new WritetimeFixture(database()).pendingScope(scopeId, 1);
  // the per-stamp memo may answer for an unmoved stamp; a source write moves it, as the gate's concurrent capture did
  appendMessage("old", { id: "later", at: 124, role: "user", kind: "text", text: "Unrelated later note." });
  catchUpRecentMemory(access);
  const refusal = (() => { try { receipt.assertCurrent(); return undefined; } catch (error) { return error as Error & { unproven?: unknown; cause?: unknown }; } })();
  // memoised pass at an unmoved stamp is fine; what must never happen is the raw limit escaping
  if (refusal) expectUnprovenRevoke(refusal);
  setLineageTimeBudgetForTest(0);
  appendMessage("old", { id: "later2", at: 125, role: "user", kind: "text", text: "Another later note." });
  catchUpRecentMemory(access);
  const forced = (() => { try { receipt.assertCurrent(); return undefined; } catch (error) { return error as Error & { unproven?: unknown; cause?: unknown }; } })();
  if (forced) expectUnprovenRevoke(forced);
});

it("any other prepare failure keeps its own error: only the limit error is mapped", async () => {
  const { bundle, access } = await frame();
  expect(refusalOf(() => new MemoryDispatchReceipt(bundle, access, "")).message).toBe("INVALID_MEMORY_DRIVER");
});

// The wasted-rebuild risk: the re-proof ran the WHOLE frame on one tool read's allowance (100 ms), while the build proved it on one budget per
// group (recall hits on recallProofBudget, the continuity brief on briefBudget, the rest on the turn's). On a slow machine that one allowance
// ran out on a frame the build had proven, so every rebuild was refused the same way down to a turn with no memory. Each group is now
// re-proven on its own budget, as at build: at most three tool allowances (300 ms of timed reads).
it("budget: the frame's recall hits are re-proven on recall's own proof budget, so a spent allowance for the rest does not refuse them", async () => {
  const { bundle, access } = await frame();
  const tool = LineageAllowance.tool.bind(LineageAllowance);
  const made: LineageAllowance[] = [];
  // every allowance the re-proof makes is spent before it starts, except the one recallProofBudget makes
  vi.spyOn(LineageAllowance, "tool").mockImplementation((nodes?: number) => {
    const allowance = tool(nodes); made.push(allowance);
    if (!String(new Error().stack).includes("recallProofBudget")) allowance.close();
    return allowance;
  });
  expect(() => assertMemoryBundle(bundle, access)).not.toThrow();
  expect(made.length).toBeLessThanOrEqual(3);
});

it("budget: the re-proof does consult its allowances: with every one spent the frame is not proven (the limit, mapped by the receipt)", async () => {
  const { bundle, access } = await frame();
  const tool = LineageAllowance.tool.bind(LineageAllowance);
  vi.spyOn(LineageAllowance, "tool").mockImplementation((nodes?: number) => { const allowance = tool(nodes); allowance.close(); return allowance; });
  expect(() => assertMemoryBundle(bundle, access)).toThrow("MEMORY_REPLAY_LIMIT");
  expectUnprovenRevoke(refusalOf(() => new MemoryDispatchReceipt(bundle, access, "driver")));
});

it("assertCurrent (deterministic): a re-proof that cannot finish after the stamp moved is refused as a revoked context, every call", async () => {
  const { bundle, access } = await frame();
  const receipt = new MemoryDispatchReceipt(bundle, access, "driver");
  const tool = LineageAllowance.tool.bind(LineageAllowance);
  vi.spyOn(LineageAllowance, "tool").mockImplementation((nodes?: number) => { const allowance = tool(nodes); allowance.close(); return allowance; });
  for (let call = 0; call < 2; call++) {
    // the memo answers only for an unmoved stamp: move it, so this call re-proves
    const before = authorityStamp(); bumpAuthorityHard(database()); expect(authorityStamp()).not.toBe(before);
    expectUnprovenRevoke(refusalOf(() => receipt.assertCurrent()));
  }
});
