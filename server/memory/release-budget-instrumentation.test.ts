import { expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { fixtureContract } from "./testing/writetime-fixture.ts";
const module = await import(new URL("./release-budget.ts", import.meta.url).href).catch(() => null);
function api() {
  expect(module?.accountedStatement, "T-BUDGET-REAL-WORK: cached statement executions need a pre-execution reservation").toBeTypeOf("function");
  return module!;
}
// red-at-4df086541: statement reuse previously bypassed generation accounting.
it("T-BUDGET-REAL-WORK charges each execution of one cached SQL statement", () => {
  const { ReleaseBudget, RELEASE_LIMITS, accountedStatement, withReleaseBudgets } = api();
  const db = new DatabaseSync(":memory:");
  try {
    const statement = accountedStatement(db.prepare("SELECT 1 AS n")), budget = new ReleaseBudget(vi.fn());
    withReleaseBudgets([budget], () => { expect(statement.get()?.n).toBe(1); expect(statement.get()?.n).toBe(1); });
    expect(budget.counts.statements).toBe(2);
    budget.charge({ statements: RELEASE_LIMITS.statements - 2 });
    expect(() => withReleaseBudgets([budget], () => statement.get())).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(budget.counts.statements).toBe(RELEASE_LIMITS.statements);
  } finally { db.close(); }
});
// red-at-4df086541: row charging followed materialization/visitation.
it("T-BUDGET-REAL-WORK exhausts before the first returned row is visited", () => {
  const { ReleaseBudget, RELEASE_LIMITS, accountedStatement, withReleaseBudgets } = api();
  const next = vi.fn(() => ({ done: false, value: { private: "row" } }));
  const statement = accountedStatement({ iterate: () => ({ next }), all: vi.fn() });
  const budget = new ReleaseBudget(vi.fn()); budget.charge({ work: RELEASE_LIMITS.work - 1 });
  expect(() => withReleaseBudgets([budget], () => statement.all())).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(next).not.toHaveBeenCalled();
});
// red-at-4df086541: normalization copies and receipt scope visits were free.
it("T-BUDGET-REAL-WORK pays before normalization and leaves input untouched", async () => {
  const { ReleaseBudget, RELEASE_LIMITS, withReleaseBudgets } = api();
  const refs = await import("./retained-refs.ts").catch(() => null);
  expect(refs?.normalizeRetainedRefs, "retained normalization must be metered").toBeTypeOf("function");
  const input = Object.freeze([{ kind: "prefix" as const, threadId: "t", headLsn: 1, shown: Object.freeze(["a", "b"]) }]);
  const budget = new ReleaseBudget(vi.fn()); budget.charge({ work: RELEASE_LIMITS.work });
  expect(() => withReleaseBudgets([budget], () => refs!.normalizeRetainedRefs(input))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(input[0].shown).toEqual(["a", "b"]);
});
// red-at-4df086541: actual drain measurement and lookup statements were uncharged.
it("T-BUDGET-DRAIN-DIAGNOSIS refuses a drain before its first statement", async () => {
  const { ReleaseBudget, RELEASE_LIMITS, withReleaseBudgets } = api();
  const drain = await import("./memory-revocation.ts");
  const db = new DatabaseSync(":memory:"), stop = vi.fn(), budget = new ReleaseBudget(stop);
  budget.charge({ statements: RELEASE_LIMITS.statements });
  try {
    expect(() => withReleaseBudgets([budget], () => drain.drainRevokeMarkerBounded(db))).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(db.isTransaction).toBe(false); expect(stop).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});

// red-at-4df086541: refusal diagnosis could perform unchecked repeat lookups.
it("T-BUDGET-DRAIN-DIAGNOSIS pays before diagnosing even the first part", async () => {
  const { ReleaseBudget, RELEASE_LIMITS, withReleaseBudgets } = api();
  const { fenceRefusalCounts } = await import("./send-fence.ts");
  const get = vi.fn();
  const db = { prepare: vi.fn(() => ({ get })) } as unknown as DatabaseSync;
  const budget = new ReleaseBudget(vi.fn()); budget.charge({ work: RELEASE_LIMITS.work });
  const built = { parts: [{ lineageOf: [{ kind: "line", threadId: "t", messageId: "x" }] }] } as unknown as Parameters<typeof fenceRefusalCounts>[1];
  expect(() => withReleaseBudgets([budget], () => fenceRefusalCounts(db, built, { audience: null }))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(db.prepare).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
});
// red-at-4df086541: a budget crossing could append refs or run attribution first.
it.each(["bytes", "work", "attempts", "statements"] as const)("T-RELEASE-BUDGET %s exhaustion cannot mutate a proposed ledger", async key => {
  const { RELEASE_LIMITS } = api();
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const { emitConsumingTurnResponse, registerConsumingDescriptor } = await import("../consuming-turn-response.ts");
  const f = consumingFixture();
  try {
    const parents = f.turn.parents, write = vi.fn(), commit = vi.fn();
    f.budget.charge({ [key]: RELEASE_LIMITS[key] - f.budget.counts[key] });
    expect(() => emitConsumingTurnResponse(f.binding, registerConsumingDescriptor("gateway:json-error-limit-done", "body"), {
      bytes: 1, refs: [{ kind: "line", threadId: "T", messageId: "Y" }], commitAttribution: commit, write,
    })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(f.turn.parents).toBe(parents); expect(write).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(f.refusals).toBe(1);
  } finally { f.close(); }
});
// red-at-4df086541: an allowance/reader reset could replace generation accounting.
it("T-BUDGET-NO-RESET makes the concrete generation budget non-replaceable", async () => {
  api();
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const f = consumingFixture();
  try {
    expect(Reflect.set(f.turn, "budget", null)).toBe(false);
    expect((f.turn as { budget?: unknown }).budget).toBe(f.budget);
    const count = f.budget.counts.bytes;
    f.budget.charge({ bytes: 1 }); await Promise.resolve();
    expect(f.budget.counts.bytes).toBe(count + 1);
  } finally { f.close(); }
});

// red-at-4df086541: merged proposals did not reserve every member before mutation.
it.each([0, 1])("T-BUDGET-MERGED-MEMBERS refuses member %i without committing either ledger", async exhausted => {
  const { RELEASE_LIMITS } = api();
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const lineage = await import("./lineage-write.ts");
  const { prepareRetainedFence } = await import("./send-fence.ts");
  const f = consumingFixture(undefined, { empty: true });
  const second = lineage.openTurnLineage(f.f.db, { threadId: "T", turnId: `${f.turn.turnId}-second` });
  try {
    prepareRetainedFence(second, { audience: null }, vi.fn(), f.f.db);
    const merged = lineage.runningTurnFor("T")!;
    const members = lineage.checkedOpenTurns(merged);
    expect(members).toHaveLength(2);
    const parents = members.map(member => member.parents);
    const before = members.map(member => member.budget!.counts.work);
    members[exhausted]!.budget!.charge({ work: RELEASE_LIMITS.work - before[exhausted]! });
    expect(() => lineage.proposeTurnParents(merged, [{ kind: "line", threadId: "T", messageId: "Y" }])).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(members[1 - exhausted]!.budget!.counts.work).toBeGreaterThan(before[1 - exhausted]!);
    for (let i = 0; i < members.length; i++) expect(members[i]!.parents).toBe(parents[i]);
  } finally { lineage.closeTurnLineage(second); f.close(); }
});

// control: a live merged proposal commits its provenance to both concrete members.
it("T-BUDGET-MERGED-MEMBERS under-cap control charges both members", async () => {
  api();
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const lineage = await import("./lineage-write.ts");
  const { prepareRetainedFence } = await import("./send-fence.ts");
  const f = consumingFixture(undefined, { empty: true });
  const second = lineage.openTurnLineage(f.f.db, { threadId: "T", turnId: `${f.turn.turnId}-second` });
  try {
    prepareRetainedFence(second, { audience: null }, vi.fn(), f.f.db);
    const merged = lineage.runningTurnFor("T")!;
    const members = lineage.checkedOpenTurns(merged), before = members.map(member => member.budget!.counts.work);
    const ref = { kind: "line" as const, threadId: "T", messageId: "Y" };
    lineage.commitTurnParents(lineage.proposeTurnParents(merged, [ref]));
    for (let i = 0; i < members.length; i++) {
      expect(members[i]!.parents).toContainEqual(ref);
      expect(members[i]!.budget!.counts.work).toBeGreaterThan(before[i]!);
    }
  } finally { lineage.closeTurnLineage(second); f.close(); }
});

const fixtures: Array<{ close(): void }> = [];
afterEach(() => fixtures.splice(0).forEach(f => f.close()));

// red-at-4df086541: exercise actual SQL/row visits made by the live retained
// checker, not a mock count of assertRetainedFence calls.
it("T-RELEASE-BUDGET instruments SQL and visited lineage on repeated checks", async () => {
  await fixtureContract(new URL("../consuming-turn-response.ts", import.meta.url), "§12.4 retained checks must reserve actual database work before execution");
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const f = consumingFixture(); fixtures.push(f);
  const { assertRetainedFence } = await import("./send-fence.ts");
  const before = { ...f.budget.counts };
  assertRetainedFence(f.turn, f.f.db);
  const first = { ...f.budget.counts };
  expect(first.statements).toBeGreaterThan(before.statements);
  expect(first.work).toBeGreaterThan(first.statements - before.statements);
  assertRetainedFence(f.turn, f.f.db);
  expect(f.budget.counts.statements).toBeGreaterThan(first.statements);
  expect(f.budget.counts.work).toBeGreaterThan(first.work);
});

// red-at-4df086541: a statement that cannot be reserved must not execute and
// a failed checker must seal before the prospective write callback.
it.each(["statements", "work"] as const)("T-RELEASE-BUDGET %s exhaustion blocks the actual emitter", async key => {
  const api = await fixtureContract<typeof import("../consuming-turn-response.ts")>(new URL("../consuming-turn-response.ts", import.meta.url), "complete-ledger emission required before database work");
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const { RELEASE_LIMITS } = await import("./release-budget.ts");
  const f = consumingFixture(); fixtures.push(f);
  const write = vi.fn();
  f.budget.charge({ [key]: RELEASE_LIMITS[key] - f.budget.counts[key] });
  expect(() => api.emitConsumingTurnResponse(f.binding, api.registerConsumingDescriptor("POST /api/internal/memory/get:body", "body"), { bytes: 1, refs: [], write })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});

// R1 supersedes historical three-charge behavior: exactly one emitted attempt.
// Proposals and retained validators still charge work and statements.
it("T-RELEASE-BUDGET one accepted emission charges exactly one attempt, and its fence checks still charge work", async () => {
  const api = await fixtureContract<typeof import("../consuming-turn-response.ts")>(new URL("../consuming-turn-response.ts", import.meta.url), "complete-ledger emission required before database work");
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const f = consumingFixture(); fixtures.push(f);
  const write = vi.fn();
  const before = { ...f.budget.counts };
  api.emitConsumingTurnResponse(f.binding, api.registerConsumingDescriptor("POST /api/internal/memory/get:body", "body"), { bytes: 1, refs: [], write });
  expect(write).toHaveBeenCalledTimes(1);
  expect(f.budget.counts.attempts - before.attempts).toBe(1);
  expect(f.budget.counts.statements).toBeGreaterThan(before.statements);
  expect(f.budget.counts.work - before.work).toBeGreaterThanOrEqual(4);
});

it("closes a real SQLite iterator when a work reservation fails between rows", () => {
  const { ReleaseBudget, RELEASE_LIMITS, accountedStatement, withReleaseBudgets } = api();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE cursor_rows(id INTEGER); INSERT INTO cursor_rows VALUES(1),(2)");
    const rows = accountedStatement(db.prepare("SELECT * FROM cursor_rows")).iterate();
    expect(rows.next().done).toBe(false);
    const budget = new ReleaseBudget(vi.fn());
    budget.charge({ work: RELEASE_LIMITS.work });
    expect(() => withReleaseBudgets([budget], () => rows.next())).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(() => db.exec("DROP TABLE cursor_rows")).not.toThrow();
  } finally { db.close(); }
});
