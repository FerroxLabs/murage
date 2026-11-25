// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b (the turn's exact pending wait) + memory-revocation runner (the window's closing marker). 1.0.20 checkfix-n8.
// The field (pre9): every owner turn waited the whole 65 s bound for its checking window and then started with recall withheld, because the
// turn doing the waiting is itself a live foreground turn and the closing marker trickles (a half slice every 250 ms) while any turn is live.
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertSendFence, pendingFenceCheck } from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { awaitExactPendingCheck } from "./fence-pending.ts";
import { memoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { resetRevokeWriteBudget, revokePaceTestHooks } from "./revoke-budget.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const THREADS = 400;
let f: WritetimeFixture;
beforeEach(() => {
  // one real notebook change opened a window on every thread (the import's all-threads narrowing); each thread has shown lines to walk
  f = new WritetimeFixture().cert(true);
  for (let t = 0; t < THREADS; t++) for (let i = 0; i < 4; i++) f.reply(`th-${t}`, `m-${t}-${i}`, 10 + t * 8 + i, { turnLsn: 9 + t * 8 + i });
  f.reply("zz-owner", "delegated", 20 + THREADS * 8, { turnLsn: 10 }).job(1, 30 + THREADS * 8);
  for (let t = 0; t < THREADS; t++) f.pending(`th-${t}`, 1);
  f.pending("zz-owner", 1);
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false;
});
afterEach(() => { stopMemoryRevocation(); f.close(); resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false; });
function refusal() {
  const built = buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [{ kind: "prefix", threadId: "zz-owner", headLsn: 20 + THREADS * 8 }])]);
  try { assertSendFence(built, CONTENT, f.db); } catch (error) { return { error, built }; }
  throw new Error("fixture must refuse");
}
const pendingRows = () => Number(f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()!.n);

// RED on pre11 103385c964 (live AND idle): one marker slice fills the revoke pace (revoke-budget.ts REVOKE_PACE 0.8 MB/min, the commit is held
// as copy debt and charged as the whole pace), so the closer gets one slice a minute and the turn hits the 65 s bound (field: outcome=deadline).
for (const live of [true, false]) it(`a turn waiting on a 400-thread window settles within 2 s (${live ? "foreground turn live" : "idle"})`, async () => {
  const { error, built } = refusal();
  wakeMemoryRevocation(() => f.db, { busy: () => live });
  const t0 = performance.now();
  const ok = await awaitExactPendingCheck(f.db, error, undefined, 2_000);
  const ms = Math.round(performance.now() - t0);
  console.log(`N8 live=${live} ok=${ok} ms=${ms} pending=${pendingRows()} budgetWaits=${memoryRevocationStats.budgetWaits} slices=${memoryRevocationStats.markerSlices}`);
  expect(ok).toBe(true);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "shown" });
  expect(() => assertSendFence(built, CONTENT, f.db)).not.toThrow();
}, 30_000);
