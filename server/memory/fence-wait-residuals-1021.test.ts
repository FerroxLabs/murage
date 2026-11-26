// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b (the turn's exact pending wait, send-fence.ts target capture) + revoke runner owners (memory-revocation.ts
// closeWaitedPending). 1.0.21 closer2 (O6): the three 1.0.20 closer-n1 residuals. (C1) a refusal whose only pending refs are memory refs
// (a scoped record or source, or an object with no scope) closes its window too; (C2) the shared allowance is a rolling minute, never 512 rows
// across a window boundary; (C3) a revoke whose walk has written every mark but still reads 'mark' or 'hold' (no frontier row, no hold row)
// is closable without waiting for the paced runner's phase ticks. A revoke still walking or holding keeps its rows (fail closed).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertSendFence, pendingFenceCheck } from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { awaitExactPendingCheck } from "./fence-pending.ts";
import { closeWaitedPending, resetWaitedPendingAllowance, stopMemoryRevocation, WAITED_EXAMINE_ROWS, WAITED_PENDING_ROWS_PER_MIN } from "./memory-revocation.ts";
import { resetRevokeWriteBudget } from "./revoke-budget.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { LineageRef } from "./lineage-types.ts";

const HEAD = 40;
let f: WritetimeFixture;
beforeEach(() => {
  f = new WritetimeFixture().cert(true);
  f.reply("zz-owner", "delegated", HEAD, { turnLsn: 10 }).job(1, 100);
  f.scope("sc-a").record("rec-a", 1, "sc-a").source("src-a", "sc-a");
  resetRevokeWriteBudget(); resetWaitedPendingAllowance();
});
afterEach(() => { vi.useRealTimers(); stopMemoryRevocation(); f.close(); resetRevokeWriteBudget(); resetWaitedPendingAllowance(); });

function refusal(refs: LineageRef[]) {
  const built = buildPrompt(undefined, [promptPart("Re-sending the report", refs)]);
  try { assertSendFence(built, CONTENT, f.db); } catch (error) { return { error, built }; }
  throw new Error("fixture must refuse");
}
const phase = (p: string) => f.db.prepare("UPDATE memory_revoke_jobs SET phase=? WHERE revoke_id=1").run(p);
const frontier = () => f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(1,1,'{}')").run();
const holdRow = () => f.db.prepare("INSERT INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(1,'hold:job-x',0)").run();
const count = (table: string) => Number(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
// The runner is never woken (wake = no-op): only the waiter's own close can delete a row here.
const wait = (error: unknown, ms = 2_000) => awaitExactPendingCheck(f.db, error, undefined, ms, () => {});

// W-C1a: a refusal whose only pending refs are a scoped record or source (no scopeId on the ref: the scope is read from the row)
for (const ref of [{ kind: "record", id: "rec-a", version: 1 }, { kind: "source", id: "src-a", version: 1 }] as const)
  it(`a ${ref.kind}-only refusal closes its scope's window once the revoke has written every mark`, async () => {
    phase("tidy"); f.pendingScope("sc-a", 1);
    const { error, built } = refusal([{ kind: "memory", ref }]);
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
    expect(await wait(error)).toBe(true);
    expect(count("memory_deny_pending_scope")).toBe(0);
    expect(() => assertSendFence(built, CONTENT, f.db)).not.toThrow();
  }, 30_000);

// W-C1b: an object ref with no scope reads "checking" while ANY revoke is pending (deny-read.ts memoryPendingSince). Its wait adds no
// target and leaves other threads' rows to the paced tidy (fail closed: an any-scope pick would examine the whole backlog, Astra H1).
it("an unscoped object ref adds no target and leaves other threads' rows alone", async () => {
  phase("tidy"); f.pending("th-other", 1);
  const { error } = refusal([{ kind: "memory", ref: { kind: "card", id: "card-x" } }]);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
  expect(await wait(error, 300)).toBe(false);
  expect(count("memory_deny_pending")).toBe(1);
}, 30_000);

// W-C1d: the examined rows are bounded before the READY guard. A backlog of WAITED_EXAMINE_ROWS rows of a revoke still walking, then one
// ready row of another revoke in the same scope: a call examines only the backlog, closes nothing and charges nothing.
it("a backlog of rows still walking is examined only up to the bound and charges nothing", () => {
  phase("mark"); frontier();
  for (let r = 0; r < WAITED_EXAMINE_ROWS; r++) {
    f.job(1000 + r, 100).pendingScope("sc-a", 1, 1000 + r);
    f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(1000 + r);
    f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{}')").run(1000 + r);
  }
  // revoke 2 has written every mark; its row sorts after the backlog (since_lsn 2)
  f.job(2, 100).pendingScope("sc-a", 2, 2);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=2").run();
  expect(closeWaitedPending(f.db, [], ["sc-a"])).toBe(false);
  expect(count("memory_deny_pending_scope")).toBe(WAITED_EXAMINE_ROWS + 1);
  // nothing was charged: a scope whose only row is ready still closes the whole allowance's worth
  for (let k = 0; k < WAITED_PENDING_ROWS_PER_MIN; k++) f.pendingScope(`sc-b${k}`, 3, 2);
  let closed = 0;
  for (let k = 0; k < WAITED_PENDING_ROWS_PER_MIN && closeWaitedPending(f.db, [], [`sc-b${k}`]); k++) closed++;
  expect(closed).toBe(WAITED_PENDING_ROWS_PER_MIN);
});

// W-C1c: a record ref whose revoke is still walking keeps its window (fail closed)
it("a record-only refusal keeps its window while the revoke still has a frontier row", async () => {
  phase("mark"); frontier(); f.pendingScope("sc-a", 1);
  const { error } = refusal([{ kind: "memory", ref: { kind: "record", id: "rec-a", version: 1 } }]);
  expect(await wait(error, 300)).toBe(false);
  expect(count("memory_deny_pending_scope")).toBe(1);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
}, 30_000);

// W-C3: the walk wrote every mark (no frontier row, no hold row) but the job still reads 'mark' or 'hold': the runner turns it into 'tidy'
// with no further mark, so the waiter's row closes now. Each guard alone keeps the row.
for (const p of ["mark", "hold"] as const)
  it(`a revoke in '${p}' with no frontier and no hold row lets the waiter's row close`, async () => {
    phase(p); f.pending("zz-owner", 1);
    const { error, built } = refusal([{ kind: "prefix", threadId: "zz-owner", headLsn: HEAD }]);
    expect(await wait(error)).toBe(true);
    expect(count("memory_deny_pending")).toBe(0);
    expect(() => assertSendFence(built, CONTENT, f.db)).not.toThrow();
  }, 30_000);
for (const [label, setup] of [["'mark' with a frontier row", () => { phase("mark"); frontier(); }], ["'hold' with a hold row", () => { phase("hold"); holdRow(); }],
  ["'tidy' with a hold row", () => { phase("tidy"); holdRow(); }]] as const)
  it(`a revoke in ${label} keeps the waiter's row (fail closed)`, async () => {
    setup(); f.pending("zz-owner", 1);
    const { error } = refusal([{ kind: "prefix", threadId: "zz-owner", headLsn: HEAD }]);
    expect(await wait(error, 300)).toBe(false);
    expect(count("memory_deny_pending")).toBe(1);
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
  }, 30_000);

// W-C2: the allowance is a rolling minute. Before, a fixed 60 s window let 224 rows close at its 59th second and 256 more just after it
// reset: 480 rows inside one minute.
it("waiters together close at most the per-minute allowance in ANY rolling minute", () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  phase("tidy");
  const threads = Array.from({ length: 700 }, (_, t) => `t-${t}`);
  for (const t of threads) f.pending(t, 1);
  const drain = () => { let before = count("memory_deny_pending"); while (closeWaitedPending(f.db, threads, [])) { /* drain */ } return before - count("memory_deny_pending"); };
  expect(closeWaitedPending(f.db, threads, [])).toBe(true); // t0: 32 rows, the window starts
  vi.advanceTimersByTime(59_000);
  const late = drain();
  vi.advanceTimersByTime(1_100);
  const next = drain();
  expect(late + next).toBeLessThanOrEqual(WAITED_PENDING_ROWS_PER_MIN);
  // and the allowance does come back once the minute has passed
  vi.advanceTimersByTime(60_000);
  expect(drain()).toBe(WAITED_PENDING_ROWS_PER_MIN);
});
