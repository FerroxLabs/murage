// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (revoke-marker.ts quarantineFailingJobs / retryQuarantinedOnNewVersion). Consumer owner: the start at
// listen (memory-revocation.ts retryQuarantinedAtStart, reached by the wake that passes options).
// Astra d2e7ff4df4 (High): a job quarantined while the running version could not be read kept a NULL stamp, and the next start on any
// readable version retried it without proving that version newer (MAIN-RULING REVOKEHEALTH-1022: retry only on a NEWER version).
// The version source is the only stand-in (it cannot be made unreadable from a test); the runner, quarantine and start retry are real.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WritetimeFixture } from "./testing/writetime-fixture.ts";

// the setup file has already loaded the memory modules, so the stand-in is installed on a fresh module graph the test imports below
const version = { value: null as string | null };
vi.resetModules();
vi.doMock("./app-version.ts", async importOriginal => ({ ...await importOriginal<typeof import("./app-version.ts")>(), runningAppVersion: () => version.value }));
const { refsLookup } = await import("./deny-read.ts");
const runner = await import("./memory-revocation.ts");
const { stopMemoryRevocation, wakeMemoryRevocation } = runner;
const { resetRevokeWriteBudget, revokePaceTestHooks } = await import("./revoke-budget.ts");
const marker = await import("./revoke-marker.ts");
const { CONTENT, WritetimeFixture: Fixture } = await import("./testing/writetime-fixture.ts");

let f: WritetimeFixture;
const backoff = { ...marker.JOB_BACKOFF };
beforeEach(() => {
  f = new Fixture().cert(true);
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false;
  marker.JOB_BACKOFF.firstMs = 1; marker.JOB_BACKOFF.capMs = 4;
});
afterEach(() => {
  stopMemoryRevocation(); f.close(); resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false;
  marker.JOB_BACKOFF.firstMs = backoff.firstMs; marker.JOB_BACKOFF.capMs = backoff.capMs; version.value = null;
});
async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise(resolve => setTimeout(resolve, 20));
}
const jobState = (id: number) => f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.state;
const stamp = (id: number) => marker.quarantineStamp(f.db, id); // 1.0.22 f2boot: a memory_scope_bindings row, never a table of its own
const wake = () => wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });

it("W-VERSION-NULL-STAMP a job quarantined while the version was unreadable is not retried by the next start (it takes that version as its stamp); a start on a newer one retries it once", async () => {
  f.reply("line-1", "reply", 10, { turnLsn: 9 }).job(1, 11).pending("line-1", 1, 1);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=1").run();
  marker.enqueueNode(f.db, 1, { kind: "line", threadId: "line-1", lsn: 10 });
  f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
  version.value = null;
  wake();
  await until(() => jobState(1) === "quarantined", 8_000);
  expect([jobState(1), stamp(1)]).toEqual(["quarantined", null]);
  stopMemoryRevocation();
  version.value = "9.0.2";
  const retries = runner.memoryRevocationStats.errorRetries, quarantined = runner.memoryRevocationStats.quarantined;
  wake();
  await new Promise(resolve => setTimeout(resolve, 300));
  // pre-fix d2e7ff4df4: the NULL stamp read as "retry": the job ran again on 9.0.2 (errorRetries grew, quarantined again)
  expect([jobState(1), stamp(1), runner.memoryRevocationStats.errorRetries, runner.memoryRevocationStats.quarantined]).toEqual(["quarantined", "9.0.2", retries, quarantined]);
  expect(refsLookup(f.db, [{ kind: "line", threadId: "line-1", messageId: "reply" }], CONTENT)).toEqual({ state: "withheld", reason: "deny-range" });
  stopMemoryRevocation();
  version.value = "9.0.3";
  wake();
  await until(() => runner.memoryRevocationStats.quarantined > quarantined, 8_000);
  expect([runner.memoryRevocationStats.quarantined, stamp(1)]).toEqual([quarantined + 1, "9.0.3"]);
}, 30_000);
