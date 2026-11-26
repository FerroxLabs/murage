// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (revoke-marker.ts job quarantine, memory-revocation.ts per-row backoff and owner notices, deny-read.ts
// quarantined windows). Consumer owner: every reader of the pending windows (deny-read.ts) and the owner notice route (GET /api/deletions/owed).
// 1.0.22 MUST-FIX items 1 and 2 (HIDDEN-COST-opus section 4): a revoke job that always throws was retried forever, its readers at "checking"
// for good and told to the console only; a bookkeeping row whose step throws blocked every row queued behind it.
import { afterEach, beforeEach, expect, it } from "vitest";
import { memoryLookup, refsLookup, sessionLookup } from "./deny-read.ts";
import type { LineageRef } from "./lineage-types.ts";
import * as runner from "./memory-revocation.ts";
import { createRevocationJob, stopMemoryRevocation, wakeMemoryRevocation, type RevocationJob } from "./memory-revocation.ts";
import { resetRevokeWriteBudget, revokePaceTestHooks } from "./revoke-budget.ts";
import * as marker from "./revoke-marker.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

let f: WritetimeFixture;
const backoff = { ...marker.JOB_BACKOFF };
beforeEach(() => {
  f = new WritetimeFixture().cert(true);
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false;
  // the production backoff (1 s doubling to 60 s) shortened so ten failures fit a test; the runner, selectors and readers are the real ones
  marker.JOB_BACKOFF.firstMs = 1; marker.JOB_BACKOFF.capMs = 4;
});
afterEach(() => {
  stopMemoryRevocation(); f.close(); resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false;
  marker.JOB_BACKOFF.firstMs = backoff.firstMs; marker.JOB_BACKOFF.capMs = backoff.capMs;
});
const notices = (): Array<{ id: string; text: string }> =>
  ((runner as unknown as Record<string, unknown>).revokeHealthNotices as ((db: unknown) => Array<{ id: string; text: string }>) | undefined)?.(f.db) ?? [];
async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise(resolve => setTimeout(resolve, 20));
}
const jobState = (id: number) => f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.state;
const pendingOf = (id: number) => Number(f.db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending WHERE revoke_id=?1)+(SELECT count(*) FROM memory_deny_pending_scope WHERE revoke_id=?1) AS n").get(id)!.n);

/** A line revoke in its mark phase (the walker's real input): the reply `reply` of thread `line-<id>`, held by its pending row. */
function seedLineJob(id: number): void {
  const threadId = `line-${id}`;
  f.reply(threadId, "reply", id * 10, { turnLsn: id * 10 - 1 }).job(id, id * 10 + 1).pending(threadId, 1, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(id);
  marker.enqueueNode(f.db, id, { kind: "line", threadId, lsn: id * 10 });
}
const line = (id: number) => refsLookup(f.db, [{ kind: "line", threadId: `line-${id}`, messageId: "reply" }], CONTENT);
const record = () => memoryLookup(f.db, [{ kind: "record", id: "rec-q", version: 1 }], CONTENT).get("record:rec-q:1");

// SITES.md rows of item 1, one per reader site of a quarantined job's window: the generated line (deny-read.ts lookupPage) and the memory
// object under the job's pending scope row (memoryScopeVerdict). Each reads "checking" while the job is live and withheld once quarantined.
it("W-QUARANTINE a revoke job that always throws is quarantined after JOB_QUARANTINE_AFTER failures: its line and its scope read withheld (not checking), the job behind it finishes, the owner is told, and its pending rows stay", async () => {
  f.scope("s-q").record("rec-q", 1, "s-q");
  seedLineJob(1);
  f.db.exec("UPDATE memory_record_lsn SET created_lsn=50 WHERE id='rec-q'");
  f.pendingScope("s-q", 1, 1);
  seedLineJob(2);
  // job 1 can never step: its frontier node is unreadable (the field's MEMORY_REVOKE_NODE_UNREADABLE)
  f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
  expect(line(1).state).toBe("checking");
  expect(record()?.state).toBe("checking");
  wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
  await until(() => line(1).state === "withheld" && jobState(2) !== "active", 8_000);
  // the behaviour: what the stuck job covers is withheld for good (base 68ed0def17: "checking" forever, every turn waits on it)
  expect(line(1)).toEqual({ state: "withheld", reason: "deny-range" });
  expect(record()).toEqual({ state: "withheld", reason: "scope-deny" });
  expect(jobState(1)).toBe("quarantined");
  // nothing is released: the job's pending rows (its whole window) stay
  expect(pendingOf(1)).toBe(2);
  // the job queued behind it ran to its end (V10, kept) and its own line is withheld by its mark
  expect(["done", undefined]).toContain(jobState(2));
  expect(line(2).state).toBe("withheld");
  expect(notices().map(notice => notice.id)).toContain("revoke:quarantined");
  // the runner is no longer trying it: no failure is charged after the quarantine
  const retries = runner.memoryRevocationStats.errorRetries;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(runner.memoryRevocationStats.errorRetries).toBe(retries);
}, 30_000);

it("W-ROW-HOL a bookkeeping row whose step always throws sits out its backoff: the row queued behind it runs to its end", async () => {
  f.scope("s-q");
  // a backoff that outlasts the runner's pause (as 1 s does in production against its ~24 ms pause)
  marker.JOB_BACKOFF.firstMs = 200; marker.JOB_BACKOFF.capMs = 1_000;
  // the first row's step throws on every try (a "supporting" phase with no record: a corrupt intent); the second is an ordinary row
  const bad = createRevocationJob(f.db, { v: 2, id: "bad", phases: ["supporting"], c: null } as unknown as RevocationJob)!;
  const good = createRevocationJob(f.db, { v: 2, id: "good", phases: [], c: null } as unknown as RevocationJob)!;
  const row = (id: string) => f.db.prepare("SELECT 1 AS x FROM memory_scope_bindings WHERE id=?").get(id);
  wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
  await until(() => !row(good), 4_000);
  // the behaviour: base 68ed0def17 picks the failing row first on every tick, so the row behind it never runs
  expect(row(good), JSON.stringify(runner.memoryRevocationStats)).toBeUndefined();
  // the failing row is kept (tried again after its backoff), never dropped
  expect(row(bad)).toBeDefined();
  expect(runner.memoryRevocationStats.errorRetries).toBeGreaterThan(0);
}, 30_000);

// MAIN-RULING REVOKEHEALTH-1022 (17:23Z): the quarantine records the version that made it; the first start on a newer version retries the job
// once (a later build that can finish it does), a start on the same version never does. Entry: the start at listen (the wake that passes options).
it("W-VERSION-RETRY a quarantined job is retried once by the first start on a newer version and finishes there; a start on the same version leaves it quarantined", async () => {
  const env = process.env.MURAGE_APP_VERSION;
  try {
    process.env.MURAGE_APP_VERSION = "9.0.1";
    seedLineJob(1);
    const node = String(f.db.prepare("SELECT node FROM memory_revoke_frontier WHERE revoke_id=1").get()!.node);
    f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await until(() => jobState(1) === "quarantined", 8_000);
    expect(jobState(1)).toBe("quarantined");
    // the field case: the next build reads the node this one could not (here: the node is repaired between the two versions)
    f.db.prepare("UPDATE memory_revoke_frontier SET node=? WHERE revoke_id=1").run(node);
    // a restart on the same version: no retry (never a loop within one version)
    stopMemoryRevocation();
    const quarantinedOnce = runner.memoryRevocationStats.quarantined, retriesOnce = runner.memoryRevocationStats.errorRetries;
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(jobState(1)).toBe("quarantined");
    expect(runner.memoryRevocationStats.errorRetries + runner.memoryRevocationStats.quarantined).toBe(retriesOnce + quarantinedOnce);
    // the first start on a newer version retries it once, and it runs to its end (pre-fix d0f33f8d76: quarantined for good)
    stopMemoryRevocation();
    process.env.MURAGE_APP_VERSION = "9.0.2";
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await until(() => jobState(1) !== "quarantined" && jobState(1) !== "active", 8_000);
    expect(["done", undefined]).toContain(jobState(1));
    expect(line(1).state).toBe("withheld");
  } finally { if (env === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = env; }
}, 30_000);

it("W-VERSION-REQUARANTINE a job that still fails on the newer version is quarantined again under that version, and a second start of it does not retry it", async () => {
  const env = process.env.MURAGE_APP_VERSION;
  try {
    process.env.MURAGE_APP_VERSION = "9.0.1";
    seedLineJob(1);
    f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await until(() => jobState(1) === "quarantined", 8_000);
    stopMemoryRevocation();
    process.env.MURAGE_APP_VERSION = "9.0.2";
    const before = runner.memoryRevocationStats.quarantined;
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await until(() => runner.memoryRevocationStats.quarantined > before, 8_000);
    // retried once on 9.0.2 and quarantined again (pre-fix d0f33f8d76: never retried, so never quarantined a second time)
    expect(runner.memoryRevocationStats.quarantined).toBe(before + 1);
    expect(jobState(1)).toBe("quarantined");
    expect(f.db.prepare("SELECT version FROM memory_revoke_quarantine WHERE revoke_id=1").get()?.version).toBe("9.0.2");
    expect(line(1)).toEqual({ state: "withheld", reason: "deny-range" });
    expect(pendingOf(1)).toBe(1);
  } finally { if (env === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = env; }
}, 30_000);

// MAIN-RULING REVOKEHEALTH-1022 "NEWER" (Astra precheck 7e7e14452d): a start on an older version (a downgrade) never retries a quarantined job,
// so alternating versions cannot retry one failing job again and again; versions are ordered by number (9.0.10 is newer than 9.0.2).
it("W-VERSION-DOWNGRADE a job quarantined on 9.0.2 stays quarantined with its stamp on a start of 9.0.1, and is retried on 9.0.10", async () => {
  const env = process.env.MURAGE_APP_VERSION;
  try {
    process.env.MURAGE_APP_VERSION = "9.0.2";
    seedLineJob(1);
    f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await until(() => jobState(1) === "quarantined", 8_000);
    stopMemoryRevocation();
    process.env.MURAGE_APP_VERSION = "9.0.1";
    const retries = runner.memoryRevocationStats.errorRetries;
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 300));
    // pre-fix 7e7e14452d: any other version retried it (the stamp moved to 9.0.1 and the job ran again)
    expect([jobState(1), f.db.prepare("SELECT version FROM memory_revoke_quarantine WHERE revoke_id=1").get()?.version, runner.memoryRevocationStats.errorRetries]).toEqual(["quarantined", "9.0.2", retries]);
    stopMemoryRevocation();
    process.env.MURAGE_APP_VERSION = "9.0.10";
    const before = runner.memoryRevocationStats.quarantined;
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    await until(() => runner.memoryRevocationStats.quarantined > before, 8_000);
    expect([runner.memoryRevocationStats.quarantined, f.db.prepare("SELECT version FROM memory_revoke_quarantine WHERE revoke_id=1").get()?.version]).toEqual([before + 1, "9.0.10"]);
  } finally { if (env === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = env; }
}, 30_000);

// SITES.md rows S3-S5 of item 1: the session readers of a quarantined job's window. deny-read.ts sessionLookup (a retained native session's
// verdict), prefixVerdict's retained-session cap (heldFrom + held) and its legacy wholesale rule (headLsn only). Each read "checking" for good
// on base 68ed0def17 (the job is never quarantined) and reads withheld deny-range once the runner quarantines the job.
it("W-QUARANTINE-SESSION the session readers of a quarantined job's window read withheld (deny-range), not checking", async () => {
  seedLineJob(1);
  f.sessionLineage("line-1", "inst-q", "sess-q", 5, 15);
  f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
  const session = () => sessionLookup(f.db, { threadId: "line-1", driverInstance: "inst-q", nativeSession: "sess-q" }, CONTENT);
  const retained = () => refsLookup(f.db, [{ kind: "prefix", threadId: "line-1", headLsn: 20, held: 15, heldFrom: 5, shown: [] } as unknown as LineageRef], CONTENT);
  const legacy = () => refsLookup(f.db, [{ kind: "prefix", threadId: "line-1", headLsn: 20, shown: [] } as unknown as LineageRef], CONTENT);
  expect([session().state, retained().state, legacy().state]).toEqual(["checking", "checking", "checking"]);
  wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
  await until(() => jobState(1) === "quarantined", 8_000);
  expect(session()).toEqual({ state: "withheld", reason: "deny-range" });
  expect(retained()).toEqual({ state: "withheld", reason: "deny-range" });
  expect(legacy()).toEqual({ state: "withheld", reason: "deny-range" });
  expect(pendingOf(1)).toBe(1);
}, 30_000);
