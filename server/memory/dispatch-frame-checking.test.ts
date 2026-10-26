// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// designs/SEND-FENCE-RECEIPT-RACE.md R2 (F15). A record of a turn's memory frame that reads "checking" at acceptance (its scope under a
// revoke still being walked) is not known to be allowed now: MemoryDispatchReceipt.accepted() refuses the write as a revoked context
// (MEMORY_CONTEXT_REVOKED, tagged `unproven`, the limit error kept as its cause), so the turn takes the rebuild path instead of ending at once
// as "could not start this reply" (at the base it threw MEMORY_REPLAY_LIMIT, which no caller rebuilds on). Nothing is delivered either way.
// Both acceptance validations map the same way: assertMemoryDisclosureCurrent and deliverMemoryDisclosure's own (Astra design review A1).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt, refusalCauseNote } from "./dispatch.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

/** deliverMemoryDisclosure, passed through unless a test swaps it for one call (the deliver-path validation, below). */
const deliverHook = vi.hoisted(() => ({ next: undefined as undefined | (() => void) }));
vi.mock("./disclosures.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./disclosures.ts")>();
  return { ...actual, deliverMemoryDisclosure: (...args: Parameters<typeof actual.deliverMemoryDisclosure>) => {
    const next = deliverHook.next; deliverHook.next = undefined;
    return next ? next() : actual.deliverMemoryDisclosure(...args);
  } };
});

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); deliverHook.next = undefined; });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

const empty = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };
/** A turn whose frame holds one remembered record (the owner's preference), its receipt prepared and not yet accepted. */
async function frameTurn() {
  const roster = { bots: [{ id: "a", threadId: "new", tasks: [{ threadId: "new" }, { threadId: "old" }] }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin("a", "new");
  const access = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "a", threadId: "new", generation, depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  appendMessage("old", { id: "preference", at: 123, role: "user", kind: "text", text: "My report colour is charcoal." });
  catchUpRecentMemory(access);
  const bundle = await buildMemoryBundle("report colour", access, empty, { allowance: LineageAllowance.turn() });
  expect(bundle.text).toContain("charcoal");
  const row = database().prepare("SELECT scope_id FROM memory_records WHERE text LIKE '%charcoal%' LIMIT 1").get()!;
  return { receipt: new MemoryDispatchReceipt(bundle, access, "driver"), scopeId: String(row.scope_id) };
}
const disclosureState = () => database().prepare("SELECT state FROM memory_disclosures").get()?.state;
function refusalOf(run: () => void): Error & { unproven?: unknown; cause?: unknown } {
  try { run(); } catch (error) { return error as Error & { unproven?: unknown; cause?: unknown }; }
  throw new Error("expected a refusal");
}

it("F15: a frame record checking at acceptance (a revoke still being walked) is refused as a revoked context, tagged unproven, and never delivered", async () => {
  const { receipt, scopeId } = await frameTurn();
  new WritetimeFixture(database()).pendingScope(scopeId, 1);
  const refusal = refusalOf(() => receipt.accepted());
  expect(refusal.message).toBe("MEMORY_CONTEXT_REVOKED");
  expect(refusal.unproven).toBe("memory-frame-checking");
  expect((refusal.cause as Error).message).toBe("MEMORY_REPLAY_LIMIT");
  expect(refusalCauseNote(refusal)).toContain("memory-frame-checking");
  expect(refusalCauseNote(refusal)).toContain("not a revoke");
  expect(disclosureState()).toBe("prepared");
  // once the walk is done the same receipt is accepted and delivered (the rebuild would take a fresh one; nothing was written before)
  database().exec("DELETE FROM memory_deny_pending_scope");
  expect(() => receipt.accepted()).not.toThrow();
  expect(disclosureState()).toBe("delivered");
});

it("the deliver validation maps the limit error the same way (Astra A1), and leaves the receipt undelivered", async () => {
  const { receipt } = await frameTurn();
  deliverHook.next = () => { throw new Error("MEMORY_REPLAY_LIMIT"); };
  const refusal = refusalOf(() => receipt.accepted());
  expect(refusal.message).toBe("MEMORY_CONTEXT_REVOKED");
  expect(refusal.unproven).toBe("memory-frame-checking");
  expect((refusal.cause as Error).message).toBe("MEMORY_REPLAY_LIMIT");
  expect(disclosureState()).toBe("prepared");
  expect(() => receipt.accepted()).not.toThrow();
  expect(disclosureState()).toBe("delivered");
});

it("any other acceptance refusal keeps its own error (F17 unchanged): only the limit error is mapped", async () => {
  const { receipt } = await frameTurn();
  deliverHook.next = () => { throw new Error("MEMORY_UNAUTHORIZED"); };
  const refusal = refusalOf(() => receipt.accepted());
  expect(refusal.message).toBe("MEMORY_UNAUTHORIZED");
  expect(refusal.unproven).toBeUndefined();
  expect(disclosureState()).toBe("prepared");
});
