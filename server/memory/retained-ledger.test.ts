import { afterEach, describe, expect, it, vi } from "vitest";
import { addTurnParents, closeTurnLineage, openTurnLineage, runningTurnFor, type OpenTurn } from "./lineage-write.ts";
import { existsSync } from "node:fs";
import { refsLookup } from "./deny-read.ts";
import { buildPrompt, noneRef, ownReplayRefs, promptPart } from "./prompt-parts.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import "./send-fence.ts";
import type { LineageRef, TurnLineage } from "./lineage-types.ts";
const { refuseRetainedTurn } = await import("./lineage-write.ts");
const fenceApi = await import("./send-fence.ts");
const refsApi = existsSync(new URL("./retained-refs.ts", import.meta.url)) ? await import("./retained-refs.ts") : undefined;
const assertRetainedFence: typeof import("./send-fence.ts").assertRetainedFence = (...args) => {
  expect(fenceApi.assertRetainedFence, "live retained parents must be checked independently of deny_generation").toBeTypeOf("function");
  return fenceApi.assertRetainedFence(...args);
};
const prepareRetainedFence: typeof import("./send-fence.ts").prepareRetainedFence = (...args) => {
  expect(fenceApi.prepareRetainedFence, "each concrete turn requires a frozen reader and refusal lifecycle").toBeTypeOf("function");
  return fenceApi.prepareRetainedFence(...args);
};
const normalizeRetainedRefs: typeof import("./retained-refs.ts").normalizeRetainedRefs = (...args) => {
  expect(refsApi?.normalizeRetainedRefs, "same-key prefixes must preserve all ids and strict judgments").toBeTypeOf("function");
  expect(refsApi?.normalizeRetainedRefs, "T-PREFIX-UNION requires lossless per-line normalization, absent from baseline first-wins dedupe").toBeTypeOf("function");
  return refsApi!.normalizeRetainedRefs(...args);
};
const retainedRefCounts: typeof import("./retained-refs.ts").retainedRefCounts = (...args) => {
  expect(refsApi?.retainedRefCounts, "caps count distinct retained lines after lossless union").toBeTypeOf("function");
  expect(refsApi?.retainedRefCounts, "T-X1 requires distinct line/object capacity accounting").toBeTypeOf("function");
  return refsApi!.retainedRefCounts(...args);
};

const fixtures: WritetimeFixture[] = [], turns: TurnLineage[] = [];
afterEach(() => { for (const turn of turns.splice(0)) closeTurnLineage(turn); for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
function fixture() { const f = new WritetimeFixture(); fixtures.push(f); return f; }
function turn(f: WritetimeFixture, id = "a") { const t = openTurnLineage(f.db, { threadId: "T", turnId: id }); turns.push(t); return t; }

describe("LASTRESORT-AUDIENCE retained ledger", () => {
  // red-at-4df086541: merged handles dropped receipt additions and retained
  // only a snapshot of same-key prefixes. Both insertion orders are exercised
  // through the real response acceptance, with distinct member readers.
  it.each([false, true])("T-M-LIVE unknown-member receipt and prefix union/%s", async reverse => {
    expect(fenceApi.prepareRetainedFence, "shared results require live concrete members").toBeTypeOf("function");
    const response = await import("../consuming-turn-response.ts");
    const f = fixture().reply("T", "X", 1).reply("T", "Y", 2).receipt("shared", "T", "driver", "session");
    const a = turn(f, "receipt-a"), b = turn(f, "receipt-b"), stopA = vi.fn(), stopB = vi.fn(), write = vi.fn();
    prepareRetainedFence(a, CONTENT, stopA, f.db); prepareRetainedFence(b, MEMBER, stopB, f.db);
    const members = reverse ? [b, a] : [a, b];
    addTurnParents(members[0]!, [{ kind: "prefix", threadId: "T", shown: ["X"], content: true }]);
    addTurnParents(members[1]!, [{ kind: "prefix", threadId: "T", shown: ["Y"] }]);
    const merged = runningTurnFor("T")!;
    const binding = response.bindConsumingTurn({ identity: { botId: "B", threadId: "T", dispatchGeneration: "shared",
      lineageTurnIds: [a.turnId, b.turnId], adapterLeaseId: "shared" }, turn: merged, db: f.db, isCurrent: () => true,
      onLedgerRefused: () => {} });
    const receipt: LineageRef = { kind: "receipt", bundleId: "shared", lsn: a.turnLsn, scopeIds: [] };
    const release = () => response.emitConsumingTurnResponse(binding, response.registerConsumingDescriptor("native:openai:tool-append", "native"), {
      bytes: 2, refs: [receipt, { kind: "prefix", threadId: "T", shown: ["X", "Y"] }], write,
    });
    release(); expect(write).toHaveBeenCalledTimes(1);
    for (const member of [a, b]) {
      expect(member.parents).toContainEqual(receipt);
      expect(retainedRefCounts(member.parents)).toEqual({ lines: 2, objects: 1 });
    }
    f.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)"); f.denyLine("T", 2, 7);
    expect(() => assertRetainedFence(a, f.db)).not.toThrow();
    expect(release).toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).toHaveBeenCalledTimes(1);
    expect(stopA).not.toHaveBeenCalled(); expect(stopB).toHaveBeenCalledTimes(1);
  });

  // red-at-4df086541: the tool boundary authorized a merged snapshot instead
  // of each live concrete member. All-pass is the delivery control.
  it.each(["all-pass", "late-parent", "overflow", "closed", "replacement"])("T-M-LIVE tool release/%s", async failure => {
    expect(fenceApi.prepareRetainedFence, "merged release needs live members").toBeTypeOf("function");
    const response = await import("../consuming-turn-response.ts");
    const f = fixture().reply("T", "X", 1), a = turn(f, "a"), b = turn(f, "b");
    const stopA = vi.fn(), stopB = vi.fn(), write = vi.fn();
    prepareRetainedFence(a, CONTENT, stopA, f.db); prepareRetainedFence(b, MEMBER, stopB, f.db);
    const merged = runningTurnFor("T")!;
    const binding = response.bindConsumingTurn({ identity: { botId: "B", threadId: "T", dispatchGeneration: "merged",
      lineageTurnIds: [a.turnId, b.turnId], adapterLeaseId: "merged" }, turn: merged, db: f.db, isCurrent: () => true,
      onLedgerRefused: () => {} });
    if (failure === "late-parent") {
      addTurnParents(b, ownReplayRefs("T", ["X"]));
      f.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)"); f.denyLine("T", 1, 7);
    }
    if (failure === "overflow") (b as import("./lineage-write.ts").OpenTurn).over = true;
    if (failure === "closed" || failure === "replacement") closeTurnLineage(b);
    let replacement: TurnLineage | undefined;
    const replacementStop = vi.fn();
    if (failure === "replacement") { replacement = turn(f, "b"); prepareRetainedFence(replacement, CONTENT, replacementStop, f.db); }
    const release = () => response.emitConsumingTurnResponse(binding,
      response.registerConsumingDescriptor("native:openai:tool-append", "native"), {
        bytes: 2, refs: [{ kind: "line", threadId: "T", messageId: "X" }], write,
      });
    if (failure === "all-pass") {
      release(); expect(write).toHaveBeenCalledTimes(1);
      expect(a.parents).toEqual(b.parents); expect(a.parents).toContainEqual({ kind: "line", threadId: "T", messageId: "X" });
    } else { expect(release).toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled(); }
    expect(stopA).not.toHaveBeenCalled(); expect(replacementStop).not.toHaveBeenCalled();
    if (replacement) expect(() => assertRetainedFence(replacement!, f.db)).not.toThrow();
  });

  // red-at-4df086541: cap crossing could commit provenance and release the
  // crossing bytes. Duplicate and 4095 -> 4096 rows are delivery controls.
  it.each(["initial", "tool-return", "steer"].flatMap(boundary => ["line", "prefix-union", "object", "duplicate", "at-cap"]
    .map(growth => ({ boundary, growth }))))("T-CAP-CROSSING-WRITE $boundary/$growth", async ({ boundary, growth }) => {
    expect(fenceApi.prepareRetainedFence, "crossing release needs prospective validation").toBeTypeOf("function");
    const f = fixture(), t = turn(f), stop = vi.fn(), write = vi.fn(), onFence = vi.fn();
    const count = growth === "at-cap" ? 4095 : 4096;
    let extra: LineageRef;
    if (growth === "object") {
      for (let i = 0; i <= 512; i++) f.receipt(`r${i}`, "T", "driver", "session");
      addTurnParents(t, Array.from({ length: 512 }, (_, i) => ({ kind: "receipt" as const, bundleId: `r${i}`, lsn: t.turnLsn, scopeIds: [] })));
      extra = { kind: "receipt", bundleId: "r512", lsn: t.turnLsn, scopeIds: [] };
    } else {
      // Named lines must exist: missing rows are tombstones, even for content readers.
      f.db.exec("BEGIN");
      for (let i = 0; i < count; i++) f.message("T", String(i), "user");
      f.message("T", "extra", "user");
      f.db.exec("COMMIT");
      addTurnParents(t, [{ kind: "prefix", threadId: "T", shown: Array.from({ length: count }, (_, i) => String(i)), content: true }]);
      extra = growth === "prefix-union" ? { kind: "prefix", threadId: "T", shown: ["extra"], content: true }
        : { kind: "line", threadId: "T", messageId: growth === "duplicate" ? "0" : "extra", judge: "content" };
    }
    const reader = prepareRetainedFence(t, CONTENT, stop, f.db), before = t.parents;
    const accepted = growth === "duplicate" || growth === "at-cap";
    const release = async () => {
      if (boundary === "initial") { buildPrompt(t, [promptPart("new", [extra])]); onFence(); write("new"); }
      else if (boundary === "steer") {
        const { steerBuilt } = await import("../drivers/engine-input.ts");
        const { emitEngineWire } = await import("../drivers/engine-wire.ts");
        await steerBuilt({ steer: async (_thread, text, check) => { check!(); emitEngineWire(check, text, () => write(text)); return true; } }, "T",
          buildPrompt(undefined, [promptPart("new", [noneRef("owner-turn")])]), { reader, retained: t, db: f.db },
          () => { addTurnParents(t, [extra]); onFence(); });
      } else {
        const response = await import("../consuming-turn-response.ts");
        const binding = response.bindConsumingTurn({ identity: { botId: "B", threadId: "T", dispatchGeneration: "G",
          lineageTurnIds: [t.turnId], adapterLeaseId: "G" }, turn: t, db: f.db, isCurrent: () => true, onLedgerRefused: verdict => refuseRetainedTurn(t as OpenTurn, verdict) });
        response.emitConsumingTurnResponse(binding, response.registerConsumingDescriptor("native:openai:tool-append", "native"), {
          bytes: 3, refs: [extra], write: () => { onFence(); write("new"); },
        });
      }
    };
    if (accepted) { await release(); expect(write).toHaveBeenCalledTimes(1); expect(onFence).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled(); }
    else {
      await expect(release()).rejects.toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled(); expect(onFence).not.toHaveBeenCalled();
      expect(t.parents).toBe(before); expect((t as import("./lineage-write.ts").OpenTurn).over).toBe(true); expect(stop).toHaveBeenCalledTimes(1);
    }
  });
  // red-at-4df086541: T-CAP-CROSSING-WRITE, the exact crossing steer wrote before bounded proposal validation.
  it("T-CAP-CROSSING-WRITE emits zero bytes for the crossing CLI steer", async () => {
    const f = fixture(), t = turn(f), stop = vi.fn(), write = vi.fn();
    f.db.exec("BEGIN");
    for (let i = 0; i < 4096; i++) f.message("T", String(i), "user");
    f.message("T", "extra", "user");
    f.db.exec("COMMIT");
    addTurnParents(t, [{ kind: "prefix", threadId: "T", shown: Array.from({ length: 4096 }, (_, i) => String(i)), content: true }]);
    const reader = prepareRetainedFence(t, CONTENT, stop, f.db);
    const { steerBuilt } = await import("../drivers/engine-input.ts");
    const { emitEngineWire } = await import("../drivers/engine-wire.ts");
    const before = t.parents;
    const adapter = { steer: async (_thread: string, text: string, check?: () => void) => { check?.(); emitEngineWire(check, text, () => write(text)); return true; } };
    await expect(steerBuilt(adapter, "T", buildPrompt(undefined, [promptPart("new quote", [noneRef("owner-turn")])]),
      { reader, retained: t, db: f.db }, () => addTurnParents(t, [{ kind: "line", threadId: "T", messageId: "extra", judge: "content" }]))).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled(); expect(t.parents).toBe(before); expect(stop).toHaveBeenCalledTimes(1);
    expect((t as import("./lineage-write.ts").OpenTurn).over).toBe(true);
  });

  // red-at-4df086541: T-M-LIVE merged snapshots omitted parents appended after the handle was created.
  it("T-M-LIVE checks late parents against each original member's reader", () => {
    const f = fixture().reply("T", "X", 1), a = turn(f, "a"), b = turn(f, "b");
    prepareRetainedFence(a, CONTENT, vi.fn(), f.db); prepareRetainedFence(b, MEMBER, vi.fn(), f.db);
    const merged = runningTurnFor("T")!;
    addTurnParents(b, ownReplayRefs("T", ["X"]));
    f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)").run(); f.denyLine("T", 1, 7);
    expect(() => assertRetainedFence(a, f.db)).not.toThrow();
    expect(() => assertRetainedFence(merged, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  });
  // red-at-4df086541: T-DD, T-PREFIX-UNION; baseline first-wins loses IDs/judgments.
  it.each([false, true])("unions mixed prefixes losslessly in either order (%s)", reverse => {
    const refs: LineageRef[] = [
      { kind: "prefix", threadId: "T", shown: ["A", "B"], content: true },
      { kind: "prefix", threadId: "T", shown: ["B", "C"] },
    ];
    const normalized = normalizeRetainedRefs(reverse ? refs.reverse() : refs);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ shownJudges: { A: "content", B: "audience", C: "audience" } });
    expect(retainedRefCounts(normalized)).toEqual({ lines: 3, objects: 0 });
  });
  it.each([false, true])("preserves and unions unlisted prefix spans in either order (%s)", reverse => {
    const prefix = (held: number | null | undefined): LineageRef => ({ kind: "prefix", threadId: "T", headLsn: 30, shown: ["A"], ...(held !== undefined ? { held } : {}) });
    for (const [a, b, expected] of [[null, null, null], [5, null, 5], [5, 15, 15], [undefined, null, 30], [undefined, 5, 30]] as const) {
      const refs = [prefix(a), prefix(b)];
      const [merged] = normalizeRetainedRefs(reverse ? refs.reverse() : refs);
      expect(merged?.kind).toBe("prefix");
      if (merged?.kind !== "prefix") throw new Error("missing prefix");
      expect(merged.held === undefined ? merged.headLsn : merged.held).toBe(expected);
    }
    expect(normalizeRetainedRefs([prefix(null)])[0]).toMatchObject({ held: null });
    expect(normalizeRetainedRefs([prefix(5)])[0]).toMatchObject({ held: 5 });
  });
  // red-at-4df086541: T-DD; a strict line overrides copy/prefix content in either order.
  it.each([false, true])("keeps strict overlap with copy origins (%s)", reverse => {
    const refs: LineageRef[] = [
      { kind: "line", threadId: "T", messageId: "A", copyOfShown: true },
      { kind: "line", threadId: "T", messageId: "A" },
      { kind: "prefix", threadId: "T", shown: ["A"], content: true },
    ];
    expect(normalizeRetainedRefs(reverse ? refs.reverse() : refs)).toEqual(expect.arrayContaining([
      { kind: "line", threadId: "T", messageId: "A" },
      expect.objectContaining({ shownJudges: { A: "audience" } }),
    ]));
  });
  // red-at-4df086541: T-A FLIP, T-O FLIP; generation stays unchanged.
  it("refuses a retained replay on an audience-only mark without a generation bump", () => {
    const f = fixture().reply("T", "X", 1), t = turn(f), stop = vi.fn();
    prepareRetainedFence(t, MEMBER, stop, f.db);
    addTurnParents(t, ownReplayRefs("T", ["X"]));
    assertRetainedFence(t, f.db);
    f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)").run();
    f.denyLine("T", 1, 7);
    expect(() => assertRetainedFence(t, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  // control: T-A OWN; direct-owner audience-only marks must not block valid content.
  it("keeps owner content after an audience-only mark", () => {
    const f = fixture().reply("T", "X", 1), t = turn(f);
    fenceApi.prepareRetainedFence?.(t, CONTENT, vi.fn(), f.db);
    addTurnParents(t, ownReplayRefs("T", ["X"], "content"));
    f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)").run();
    f.denyLine("T", 1, 7);
    if (fenceApi.assertRetainedFence) expect(() => fenceApi.assertRetainedFence(t, f.db)).not.toThrow();
    else expect(refsLookup(f.db, t.parents, CONTENT).state).toBe("shown");
  });
  // red-at-4df086541: T-M, T-M-LIVE; merged additions used to disappear.
  it("adds to both original members and refuses a closed member", () => {
    const f = fixture().reply("T", "X", 1), a = turn(f, "a"), b = turn(f, "b");
    const stopA = vi.fn(), stopB = vi.fn();
    prepareRetainedFence(a, CONTENT, stopA, f.db); prepareRetainedFence(b, MEMBER, stopB, f.db);
    const merged = runningTurnFor("T")!;
    addTurnParents(merged, ownReplayRefs("T", ["X"]));
    expect(a.parents).toHaveLength(1); expect(b.parents).toHaveLength(1);
    assertRetainedFence(merged, f.db);
    closeTurnLineage(a);
    expect(() => assertRetainedFence(merged, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  });
  // red-at-4df086541: T-X1; crossing additions must not partially commit.
  it("rejects prefix-union-only cap growth without committing parents", () => {
    const f = fixture(), t = turn(f);
    addTurnParents(t, [{ kind: "prefix", threadId: "T", shown: Array.from({ length: 4096 }, (_, i) => String(i)) }]);
    const before = t.parents;
    expect(() => addTurnParents(t, [{ kind: "prefix", threadId: "T", shown: ["extra"] }])).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(t.parents).toBe(before);
  });
  // control: duplicate-at-cap retains every line and adds no capacity.
  it("accepts a duplicate at the line cap", () => {
    const f = fixture(), t = turn(f);
    addTurnParents(t, [{ kind: "prefix", threadId: "T", shown: Array.from({ length: 4096 }, (_, i) => String(i)) }]);
    addTurnParents(t, [{ kind: "line", threadId: "T", messageId: "0" }]);
    const named = new Set(t.parents.flatMap(ref => ref.kind === "prefix" ? ref.shown ?? [] : ref.kind === "line" ? [ref.messageId] : []));
    expect(named.size).toBe(4096);
    if (refsApi) expect(retainedRefCounts(t.parents).lines).toBe(4096);
    const lines = new Set(t.parents.flatMap(ref => ref.kind === "prefix" ? (ref.shown ?? []) : ref.kind === "line" ? [ref.messageId] : []));
    expect(lines.size).toBe(4096);
  });
});

// red-at-4df086541: T-PREFIX-UNION tests the live ledger, not only the shape of
// normalized output. B/C must retain audience judgment in both insertion orders.
it.each([false, true].flatMap(reverse => ["B", "C"].map(id => ({ reverse, id }))))
  ("T-PREFIX-UNION late flip $id reverse=$reverse", ({ reverse, id }) => {
    const f = fixture().reply("T", "A", 1).reply("T", "B", 2).reply("T", "C", 3), t = turn(f);
    prepareRetainedFence(t, MEMBER, vi.fn(), f.db);
    const refs: LineageRef[] = [{ kind: "prefix", threadId: "T", shown: ["A", "B"], content: true }, { kind: "prefix", threadId: "T", shown: ["B", "C"] }];
    for (const ref of reverse ? refs.reverse() : refs) addTurnParents(t, [ref]);
    assertRetainedFence(t, f.db); f.audienceFlip("T", id === "B" ? 2 : 3);
    expect(() => assertRetainedFence(t, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  });

// control: T-OW own and copy-origin exceptions stay content-only even though
// owner rooms have a non-null audience object.
it.each(["own", "copy"])("T-OW %s preserves owner-room delivery", kind => {
  const f = fixture().reply("T", "X", 1).reply("S", "origin", 2), t = turn(f);
  prepareRetainedFence(t, OWNER, vi.fn(), f.db);
  addTurnParents(t, kind === "own" ? [{ kind: "prefix", threadId: "T", shown: ["X"], content: true }]
    : [{ kind: "line", threadId: "S", messageId: "origin", copyOfShown: true }]);
  f.audienceFlip(kind === "own" ? "T" : "S", kind === "own" ? 1 : 2);
  const delivered: string[] = []; assertRetainedFence(t, f.db); delivered.push("SECRET");
  expect(delivered).toEqual(["SECRET"]);
});
// red-at-4df086541: T-OW plain cross-thread lines never inherit own-content exemption.
it("T-OW owner-room cross-thread plain line refuses after flip", () => {
  const f = fixture().reply("S", "origin", 1), t = turn(f);
  prepareRetainedFence(t, OWNER, vi.fn(), f.db);
  addTurnParents(t, [{ kind: "line", threadId: "S", messageId: "origin" }]);
  assertRetainedFence(t, f.db); f.audienceFlip("S", 1);
  expect(() => assertRetainedFence(t, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
});
// red-at-4df086541: T-M-LIVE must read additions made after the merged handle
// was formed, using each member's own reader instead of the snapshot union.
it("T-M-LIVE checks a late strict member independently of a content member", () => {
  const f = fixture().reply("T", "X", 1), a = turn(f, "owner"), b = turn(f, "member");
  const stopA = vi.fn(), stopB = vi.fn();
  prepareRetainedFence(a, CONTENT, stopA, f.db); prepareRetainedFence(b, MEMBER, stopB, f.db);
  const merged = runningTurnFor("T")!;
  addTurnParents(b, ownReplayRefs("T", ["X"]));
  assertRetainedFence(merged, f.db); f.audienceFlip("T", 1);
  expect(() => assertRetainedFence(merged, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(stopA).not.toHaveBeenCalled(); expect(stopB).toHaveBeenCalledOnce();
});
