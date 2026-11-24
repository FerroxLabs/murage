// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b (the turn's exact pending wait) + revoke-marker (closeWaitedPending, the waiting thread's own pending row). 1.0.20 closer-n1.
// Option B (Fable pick): a turn waiting on a checking:pending window closes ITS thread's pending row first, once the revoke has written every
// mark; the background walk keeps its pace, a real mark still withholds, and a revoke still marking keeps the row (fail closed).
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertSendFence, pendingFenceCheck } from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { awaitExactPendingCheck } from "./fence-pending.ts";
import { closeWaitedPending, resetWaitedPendingAllowance, stopMemoryRevocation, WAITED_PENDING_ROWS, WAITED_PENDING_ROWS_PER_MIN, wakeMemoryRevocation } from "./memory-revocation.ts";
import { resetRevokeWriteBudget, revokePaceTestHooks } from "./revoke-budget.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const THREADS = 400, HEAD = 20 + THREADS * 8;
let f: WritetimeFixture;
beforeEach(() => {
  f = new WritetimeFixture().cert(true);
  for (let t = 0; t < THREADS; t++) for (let i = 0; i < 4; i++) f.reply(`th-${t}`, `m-${t}-${i}`, 10 + t * 8 + i, { turnLsn: 9 + t * 8 + i });
  f.reply("zz-owner", "delegated", HEAD, { turnLsn: 10 }).job(1, 30 + THREADS * 8);
  for (let t = 0; t < THREADS; t++) f.pending(`th-${t}`, 1);
  f.pending("zz-owner", 1);
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false; resetWaitedPendingAllowance();
});
afterEach(() => { stopMemoryRevocation(); f.close(); resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false; });
function refusal(listed = false) {
  // listed: the prefix names the line it shows (the shown chunk a revoke can mark)
  const built = buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [{ kind: "prefix", threadId: "zz-owner", headLsn: HEAD, ...(listed ? { shown: ["delegated"] } : {}) }])]);
  try { assertSendFence(built, CONTENT, f.db); } catch (error) { return { error, built }; }
  throw new Error("fixture must refuse");
}
const pendingRows = (thread?: string) => Number((thread
  ? f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=?").get(thread)
  : f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get())!.n);

// W2b: only the waiter's own row closed ahead of the walk; the other threads' rows still go at the paced tidy (no storm: the pace holds)
it("the waiter's own row closes first; the background tidy stays paced", async () => {
  const { error, built } = refusal();
  wakeMemoryRevocation(() => f.db, { busy: () => false });
  expect(await awaitExactPendingCheck(f.db, error, undefined, 2_000)).toBe(true);
  expect(pendingRows("zz-owner")).toBe(0);
  expect(pendingRows()).toBeGreaterThan(300);
  expect(() => assertSendFence(built, CONTENT, f.db)).not.toThrow();
}, 30_000);

// W3: a real revoke of the shown line in that thread still withholds once its pending row closes
it("a deny mark on the shown line still withholds after the waiter's row closes", async () => {
  const { error, built } = refusal(true);
  f.denyLine("zz-owner", HEAD);
  // every mark written (the walk is in its tidy): the waiter's own row is closed at its first poll, then the exact check reads the mark
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  wakeMemoryRevocation(() => f.db, { busy: () => false });
  expect(await awaitExactPendingCheck(f.db, error, undefined, 2_000)).toBe(true);
  expect(pendingRows("zz-owner")).toBe(0);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "withheld", reason: "deny-line" });
  expect(() => assertSendFence(built, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
}, 30_000);

// W4: a revoke whose walk has not written every mark keeps the waiter's row. Each guard alone: still in 'mark' (no frontier row), and in
// 'tidy' with a frontier row an inherit hold pushed. The runner is not woken here, so only the waiter's own close could delete the row.
for (const [label, phase, frontier] of [["still marking", "mark", false], ["tidy with an inherited frontier row", "tidy", true]] as const)
  it(`a revoke ${label} keeps the waiter's pending row (fail closed)`, async () => {
    const { error } = refusal();
    f.db.prepare("UPDATE memory_revoke_jobs SET phase=? WHERE revoke_id=1").run(phase);
    if (frontier) f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(1,1,'{}')").run();
    expect(await awaitExactPendingCheck(f.db, error, undefined, 300, () => {})).toBe(false);
    expect(pendingRows("zz-owner")).toBe(1);
    expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
  }, 30_000);

// W5: the foreground close is bounded for the whole process: a call takes at most WAITED_PENDING_ROWS rows and all waiters together at most
// WAITED_PENDING_ROWS_PER_MIN a minute (the storm bound holds even if many turns wait on many threads)
it("waiters together close at most the per-minute allowance", () => {
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  const threads = Array.from({ length: THREADS }, (_, t) => `th-${t}`);
  expect(closeWaitedPending(f.db, threads, [])).toBe(true);
  expect(pendingRows()).toBe(THREADS + 1 - WAITED_PENDING_ROWS);
  while (closeWaitedPending(f.db, threads, [])) { /* drain the allowance */ }
  expect(pendingRows()).toBe(THREADS + 1 - WAITED_PENDING_ROWS_PER_MIN);
  expect(closeWaitedPending(f.db, ["zz-owner"], [])).toBe(false);
  expect(pendingRows("zz-owner")).toBe(1);
});
