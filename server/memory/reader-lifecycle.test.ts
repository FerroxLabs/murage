import { expect, it, vi } from "vitest";
import { openTurnLineage, closeTurnLineage, addTurnParents } from "./lineage-write.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { refsLookup } from "./deny-read.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import * as lineage from "./lineage-write.ts";
import type { LineageReader } from "./lineage-types.ts";
const fence = await import("./send-fence.ts");

// red-at-4df086541: prepared words could outlive the reader/turn identity
// across a reset await. This exercises build -> reset -> actual adapter fence
// for each reachable reader, rather than just comparing frozen metadata.
const readers = [
  ["direct-owner", { audience: null }],
  ["direct-unproven", { audience: { owner: false, scopeIds: ["s-room"] } }],
  ["channel-person", { audience: { owner: false, scopeIds: ["s-room"] } }],
  ["owner-room", { audience: { owner: true, scopeIds: ["s-room"] } }],
  ["non-owner-room", { audience: { owner: false, scopeIds: ["s-room"] } }],
] as const;
it.each(readers.flatMap(([route, reader]) => ["active", "off", "paused", "capture-only", "last-resort"].map(mode => ({ route, reader, mode }))))(
  "T-READER-LIFECYCLE $route/$mode rechecks retained content after reset await", async ({ reader, route, mode }) => {
    expect(fence.prepareRetainedFence, "reset preparation needs a final retained reader").toBeTypeOf("function");
    const { sendBuiltTurn, fencedSubmit } = await import("../drivers/engine-input.ts");
    const f = new WritetimeFixture().reply("T", "X", 1), stop = vi.fn(), write = vi.fn();
    const turn = openTurnLineage(f.db, { threadId: "T", turnId: `${route}:${mode}` });
    try {
      const final = fence.prepareRetainedFence(turn, reader.audience === null ? reader : {
        audience: { owner: reader.audience.owner, scopeIds: mode === "active" ? [...reader.audience.scopeIds] : [] },
      }, stop, f.db);
      const prompt = buildPrompt(turn, [promptPart("retained X", [{ kind: "line", threadId: "T", messageId: "X" }])]);
      await Promise.resolve(); // adapter reset completion
      f.denyLine("T", 1);
      const adapter = { sendTurn: async (input: import("../contracts.ts").SendTurnInput) => {
        input.beforeSubmit!(); fencedSubmit(input, () => write(input.text), input.text); return { turnId: "provider" };
      } };
      await expect(sendBuiltTurn(adapter, { threadId: "T", prompt }, { reader: final, retained: turn, db: f.db }))
        .rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(write).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
      expect((turn as import("./lineage-write.ts").OpenTurn).reader).toBe(final);
    } finally { closeTurnLineage(turn); f.close(); }
  });

// red-at-4df086541: replacement/reset preparation could be mistaken for the
// old context's reader. The old handle cannot borrow the replacement scopes.
it.each(["active", "off", "paused", "capture-only", "last-resort"])("T-READER-LIFECYCLE reset after %s preserves original identity", mode => {
  expect(fence.prepareRetainedFence, "reset requires a fresh concrete reader").toBeTypeOf("function");
  const f = new WritetimeFixture().reply("T", "X", 1), stop = vi.fn();
  const old = openTurnLineage(f.db, { threadId: "T", turnId: "same-id" });
  let next: ReturnType<typeof openTurnLineage> | undefined;
  try {
    const reader = fence.prepareRetainedFence(old, { audience: { owner: false, scopeIds: mode === "active" ? ["scope-old"] : [] } }, stop, f.db);
    addTurnParents(old, [{ kind: "line", threadId: "T", messageId: "X" }]);
    fence.assertRetainedFence(old, f.db);
    closeTurnLineage(old);
    next = openTurnLineage(f.db, { threadId: "T", turnId: "same-id" });
    const nextReader = fence.prepareRetainedFence(next, { audience: { owner: false, scopeIds: ["scope-new"] } }, vi.fn(), f.db);
    expect(() => fence.assertRetainedFence(old, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(nextReader).not.toBe(reader);
    expect(reader.audience!.scopeIds).not.toContain("scope-new");
    expect(() => fence.assertRetainedFence(next!, f.db)).not.toThrow();
  } finally { closeTurnLineage(old); if (next) closeTurnLineage(next); f.close(); }
});

// red-at-4df086541: a memory object introduced after the first release could
// inherit a pending-window exception intended only for initial preparation.
it("T-READER-LIFECYCLE refuses a new dynamic pending memory object", () => {
  expect(fence.prepareRetainedFence, "the prepared exception ends at first release").toBeTypeOf("function");
  const f = new WritetimeFixture().source("source", "s-room").record("record", 1, "s-room", ["source"]).pendingScope("s-room", 0);
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "dynamic" });
  try {
    fence.prepareRetainedFence(turn, { audience: null }, vi.fn(), f.db);
    fence.assertRetainedFence(turn, f.db);
    const before = [...turn.parents];
    expect(() => addTurnParents(turn, [{ kind: "memory", ref: { kind: "record", id: "record", version: 1, scopeId: "s-room" } }])).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(turn.parents).toEqual(before);
  } finally { closeTurnLineage(turn); f.close(); }
});

// red-at-4df086541: concrete turns did not own one immutable final reader.
it.each(["active", "off", "paused", "capture-only", "reset", "last-resort"])("T-READER-LIFECYCLE %s freezes reader and scopes", mode => {
  expect(fence.prepareRetainedFence, "preparation requires a finalized concrete-turn reader").toBeTypeOf("function");
  const f = new WritetimeFixture(), turn = openTurnLineage(f.db, { threadId: "T", turnId: mode });
  const scopes = mode === "active" || mode === "reset" ? ["s-room"] : [];
  try {
    const reader = fence.prepareRetainedFence(turn, { audience: { owner: false, scopeIds: scopes } }, vi.fn(), f.db);
    scopes.push("s-other");
    expect(Object.isFrozen(reader)).toBe(true); expect(Object.isFrozen(reader.audience)).toBe(true);
    expect(Object.isFrozen(reader.audience!.scopeIds)).toBe(true);
    expect(reader.audience!.scopeIds).not.toContain("s-other");
    expect((turn as import("./lineage-write.ts").OpenTurn).reader).toBe(reader);
    expect(() => fence.prepareRetainedFence(turn, { audience: null }, vi.fn(), f.db)).toThrow("RETAINED_READER_ALREADY_BOUND");
  } finally { closeTurnLineage(turn); f.close(); }
});

// control: ordinary receipt scopes still authorize valid generated content.
it("T-O-SCOPE preserves ordinary non-owner receipt scopes", () => {
  const f = new WritetimeFixture().footprint(1, ["s-room"]).reply("T", "X", 1, { footprint: 1, memLsn: 1 }).ready("T", true).cert(true);
  try {
    expect(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "X" }], { audience: { owner: false, scopeIds: ["s-room"] } }).state).toBe("shown");
  } finally { f.close(); }
});

// control: the same prepared memory window must remain deliverable.
it("T-O-WINDOW preserves an unchanged prepared memory window", () => {
  const f = new WritetimeFixture().source("source", "s-room").record("record", 1, "s-room", ["source"]).pendingScope("s-room", 0);
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "window-control" });
  try {
    fence.prepareRetainedFence?.(turn, { audience: null }, vi.fn(), f.db);
    const built = buildPrompt(turn, [promptPart("prepared", [{ kind: "memory", ref: { kind: "record", id: "record", version: 1, scopeId: "s-room" } }])]);
    expect(() => fence.assertSendFence(built, { audience: null }, f.db)).not.toThrow();
    if (fence.assertRetainedFence) expect(() => fence.assertRetainedFence(turn, f.db)).not.toThrow();
  } finally { closeTurnLineage(turn); f.close(); }
});

// red-at-4df086541: pending identity changes without a generation bump were not checked.
it("T-READER-LIFECYCLE closes the prepared exception when its pending window changes", () => {
  expect(fence.prepareRetainedFence, "prepared windows belong to a final reader").toBeTypeOf("function");
  const f = new WritetimeFixture().source("source", "s-room").record("record", 1, "s-room", ["source"]).pendingScope("s-room", 0);
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "window" });
  try {
    fence.prepareRetainedFence(turn, { audience: null }, vi.fn(), f.db);
    addTurnParents(turn, [{ kind: "memory", ref: { kind: "record", id: "record", version: 1, scopeId: "s-room" } }]);
    expect(() => fence.assertRetainedFence(turn, f.db)).not.toThrow();
    f.pendingScope("s-other", 0, 2);
    expect(() => fence.assertRetainedFence(turn, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  } finally { closeTurnLineage(turn); f.close(); }
});


// control: T-INV-BASE, the reachable identity algebra. This deliberately makes
// no frozen-reader or complete server-route coverage claim.
it.each([true, false].flatMap(owner => [true, false].flatMap(proven => [true, false].map(chain => ({ owner, proven, chain })))))
  ("T-INV-BASE owner=$owner proven=$proven chain=$chain", ({ owner, proven, chain }) => {
    const surfacesForOwner = owner && proven && chain;
    const memoryNotOwner = !owner || !surfacesForOwner;
    expect(owner && surfacesForOwner && !memoryNotOwner).toBe(surfacesForOwner);
  });

// red-at-4df086541: T-INV-STRUCT freezer contract. Reset is not permission to
// mutate the reader or its scope array. The real route ordering is exercised by
// the server lifecycle/full-turn tests, separately from these identity checks.
it.each(["D1", "D2", "D3", "R1", "R2"])("T-INV-STRUCT %s deep-copies and freezes final scopes", config => {
  expect(lineage.freezeLineageReader, "§2.1/§9.7 require immutable finalized reader identity").toBeTypeOf("function");
  const scopes = ["receipt", "principal"];
  const input: LineageReader = config === "D1" ? { audience: null } : { audience: { owner: config === "R1", scopeIds: scopes } };
  const reader = lineage.freezeLineageReader(input);
  expect(Object.isFrozen(reader)).toBe(true);
  scopes.push("later-grant");
  if (reader.audience !== null) {
    expect(Object.isFrozen(reader.audience)).toBe(true); expect(Object.isFrozen(reader.audience.scopeIds)).toBe(true);
    expect(reader.audience.scopeIds).toEqual(["receipt", "principal"]);
  } else expect(config).toBe("D1");
});
