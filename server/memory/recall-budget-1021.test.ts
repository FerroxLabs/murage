// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memv2 lane A (MEMORY-V2-DESIGN 4.2 A9; audit F10). Consumer owner of the wait: the dispatch step in server/index.ts (awaitRecall).
// The dispatch step waits for the overlapped recall through withRecallBudget. Before the fix the wait was 300 ms of wall clock, so a recall
// that had a few milliseconds of its own work left was dropped whenever this thread was held by something else for 300 ms (view upkeep,
// another turn), and the turn went out without recalled memory: 1 to 2 of 9 turns in the audit. The wait now counts recall's own elapsed
// work. F10-W asserts the effect on the real bundle text (bundle.ts buildMemoryBundle on a real store), composed with the real wait
// exactly as awaitRecall composes them; the other witnesses pin the bounds that keep memory from making a turn late.
// Not driven here: a whole turn through the real server (the dispatch step itself); the wiring test below pins its two lines by text.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess, fixtureCatchUpRecentMemory as catchUpRecentMemory } from "../testing/recall-access-fixture.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setAuthorizeSliceMsForTest } from "./search.ts";
import * as budget from "./recall-budget.ts";

const { withRecallBudget } = budget;
// The step-charging mechanism is witnessed with its own 300 ms budget (withRecallBudget takes the budget as an argument): the production default is 3,000
// since dev/1022 mem-strict (RECALL_WAIT_MS, witnessed in mem-strict-1022*.test.ts), and these scenarios are timed around 300.
const A9_BUDGET_MS = 300;
// Absent on a tree before the fix (the RED run on f6ae52c670): the ceiling there is the 300 ms wall clock itself.
const CEILING_MS = A9_BUDGET_MS * ((budget as { RECALL_WAIT_CEILING_FACTOR?: number }).RECALL_WAIT_CEILING_FACTOR ?? 1);

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setAuthorizeSliceMsForTest(8); closeDatabase(); });

const roster = () => ({ bots: [{ id: "a", threadId: "new", tasks: [{ threadId: "new" }, { threadId: "old" }] }], groups: [] });
function warmFixture(more = 0) {
  const r = roster();
  reconcileMemoryRoster(r);
  const registry = new InternalCapabilities(), generation = registry.begin("a", "new");
  const token = registry.mint({ botId: "a", threadId: "new", generation, depth: 0, kind: "memory", skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => r);
  appendMessage("old", { id: "preference", at: 123, role: "user", kind: "text", text: "My report colour is charcoal." });
  expect(catchUpRecentMemory(access)).toBe(1);
  // more records the same words reach: the real search reads them a slice at a time and yields the thread between slices
  for (let n = 0; n < more; n++) appendMessage("old", { id: `report-${n}`, parentId: n ? `report-${n - 1}` : "preference", at: 200 + n, role: "user", kind: "text", text: `The report colour note ${n} is filed.` });
  for (let pass = 0; more && pass < 16 && catchUpRecentMemory(access) > 0; pass++) { /* two jobs a pass */ }
  return access;
}
/** Other work on this thread: it holds the event loop for `ms` and is nothing of recall's. */
function hold(ms: number): void { const end = performance.now() + ms; while (performance.now() < end) { /* held */ } }
/** The helper's answer arrives a few turns of the event loop after the request, as a message from another process does. */
const helperAnswer = () => new Promise<void>(resolve => setTimeout(() => setImmediate(() => setImmediate(resolve)), 5));
const none = { hits: [], vectorRows: 0, degradedReason: "keyword-only" };
const immediate = { search: async () => none };

it("F10-W a warm turn whose thread is held by other work for longer than the recall wait still gets its recalled text in the bundle", async () => {
  const access = warmFixture(3);
  // The search's own slicing, one record a slice: after each slice it yields the thread (search.ts authorizeAll, yieldTurn).
  setAuthorizeSliceMsForTest(0);
  // Warm and idle: the record is recallable, and the real bundle carries its text.
  expect((await buildMemoryBundle("report colour", access, immediate, { allowance: LineageAllowance.tool() })).text).toContain("charcoal");
  // Other work now takes this thread again and again (view upkeep, another turn's steps): 110 ms at a time, with a turn of the event
  // loop between two holds. Recall gets every one of those turns; it is never the one holding the thread.
  let on = true, held = 0, holds = 0;
  const again = () => { if (!on) return; const at = performance.now(); hold(110); held += performance.now() - at; holds++; setTimeout(again, 1); };
  const bridge = { search: async () => { await helperAnswer(); return none; } };
  let waited: Awaited<ReturnType<typeof withRecallBudget<Awaited<ReturnType<typeof buildMemoryBundle>>>>>, wall = 0, heldDuring = 0;
  try {
    setTimeout(again, 0);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
    const started = performance.now(), heldBefore = held;
    // As the dispatch step does (server/index.ts awaitRecall): the early bundle is already building, the wait is A9_BUDGET_MS.
    const early = buildMemoryBundle("report colour", access, bridge, { allowance: LineageAllowance.tool() });
    waited = await withRecallBudget(early, A9_BUDGET_MS);
    wall = performance.now() - started; heldDuring = held - heldBefore;
  } finally { on = false; }
  console.log(`GATE-MEASURE F10-W recall ${"value" in waited ? "used" : "skipped"} wall_ms=${wall.toFixed(0)} held_by_other_work_ms=${heldDuring.toFixed(0)} holds=${holds} own_work_ms=${Math.max(0, wall - heldDuring).toFixed(0)} budget_ms=${A9_BUDGET_MS}`);
  expect(wall, "the scenario kept the thread busy past the wait").toBeGreaterThan(A9_BUDGET_MS);
  expect("value" in waited, "the recall was dropped although its own work was a few milliseconds").toBe(true);
  if ("value" in waited) expect(waited.value.text).toContain("charcoal");
  // recall's own share stayed far inside the budget
  expect(wall - heldDuring).toBeLessThan(A9_BUDGET_MS);
}, 30_000);

it("W-A9-CAP a recall that really needs more than its budget of own work is dropped on time, and the turn still gets a bundle", async () => {
  const access = warmFixture();
  const started = performance.now();
  // The real bundle, then one more second of recall's own waiting on a free thread (the bundle caps its own wait for the helper, so the
  // extra second stands for any recall step that is still out when the budget ends).
  const early = buildMemoryBundle("report colour", access, immediate, { allowance: LineageAllowance.tool() })
    .then(bundle => new Promise<typeof bundle>(resolve => setTimeout(() => resolve(bundle), 1_000)));
  const waited = await withRecallBudget(early, A9_BUDGET_MS);
  const wall = performance.now() - started;
  console.log(`GATE-MEASURE W-A9-CAP recall ${"value" in waited ? "used" : "skipped"} wall_ms=${wall.toFixed(0)} budget_ms=${A9_BUDGET_MS} bound_ms=${A9_BUDGET_MS * 2}`);
  expect(waited).toEqual({ skipped: "budget" });
  expect(wall).toBeGreaterThanOrEqual(A9_BUDGET_MS - 5);
  expect(wall).toBeLessThan(A9_BUDGET_MS * 2);
  // what the dispatch step builds instead: no query, so no excerpts, and it is a bundle
  const fallback = await buildMemoryBundle("", access, immediate, { allowance: LineageAllowance.tool() });
  expect(typeof fallback.text).toBe("string");
  expect(fallback.text).not.toContain("charcoal");
}, 30_000);

it("W-A9-CEILING on a thread that is held again and again the wait goes on past 300 ms of wall clock and ends at the named ceiling", async () => {
  const never = new Promise<string>(() => {});
  let on = true, holds = 0;
  const again = () => { if (!on) return; hold(150); holds++; setTimeout(again, 1); };
  setTimeout(again, 0);
  const started = performance.now();
  try {
    const waited = await withRecallBudget(never, A9_BUDGET_MS);
    const wall = performance.now() - started;
    console.log(`GATE-MEASURE W-A9-CEILING skipped wall_ms=${wall.toFixed(0)} holds=${holds} ceiling_ms=${CEILING_MS} uncapped_ms=${holds ? Math.round(wall / holds) * (A9_BUDGET_MS / 10) : 0}`);
    expect(waited).toEqual({ skipped: "budget" });
    // each step came back about 150 ms late: 30 steps would be about 4.5 s; the ceiling ends it, one hold late at most
    expect(wall).toBeGreaterThanOrEqual(CEILING_MS - 5);
    expect(wall).toBeLessThan(CEILING_MS + 600);
    expect(CEILING_MS).toBeGreaterThanOrEqual(2_000);
    expect(CEILING_MS).toBeLessThanOrEqual(2_400);
  } finally { on = false; }
}, 30_000);

it("W-A9-STEPS on a free thread the wait is the budget exactly: used one step before it, dropped at it", async () => {
  vi.useFakeTimers();
  try {
    let done!: (value: string) => void;
    const slow = new Promise<string>(resolve => { done = resolve; });
    const used = withRecallBudget(slow, A9_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(A9_BUDGET_MS - 10);
    done("bundle");
    await expect(used).resolves.toEqual({ value: "bundle" });
    let settled: unknown;
    const dropped = withRecallBudget(new Promise<string>(() => {}), A9_BUDGET_MS);
    void dropped.then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(A9_BUDGET_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ skipped: "budget" });
    // nothing is left armed after either outcome
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("wiring: the dispatch step waits for the early recall through withRecallBudget and builds a recall-free bundle when it is dropped", () => {
  const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  expect(source).toContain("withRecallBudget(early,RECALL_WAIT_MS)");
  expect(source).toContain('return buildMemoryBundle("",access,memoryWorker,memoryOptions);');
  expect(source).toContain("reason=budget wait=${RECALL_WAIT_MS}");
});
