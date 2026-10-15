// SPDX-License-Identifier: AGPL-3.0-or-later
// T11 (CLAIM-DESIGN-FABLE.md 5, 8.2): a deleted conversation, a deleted scope or a forgotten source is never claimed or revived,
// whatever the start order of the memory worker (redrive, first claims) and the revocation runner. The deny row is written by the
// product function the delete commit uses (revoke-commit.ts commitRevoke), the runner is NOT run, the process restarts, then the
// worker's start (redrive) and claims until none is left. Every payload read is recorded: none may be of a denied source.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { captureSource } from "./capture.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { applyForgetTombstones } from "./restore.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";
import { forgetMemory } from "./forget.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { resetClaimSettleSweep, resetParkSweep } from "./park.ts";
import { measure } from "./testing/claim-rows.ts";

const NOW = Date.now() + 60_000;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture"); jobs.resetMemoryClaimCursor(); resetParkSweep(); resetClaimSettleSweep();
  database().exec("PRAGMA synchronous=OFF");
});
afterEach(() => { vi.restoreAllMocks(); });

const OPEN = "('pending','partial','deferred','leased')";
/** 50 captured messages; of their jobs 10 failed by the helper's exit, 10 pending, 5 leased by a worker that is gone, the rest done. */
function conversation(thread: string, n = 50) {
  const db = database();
  for (let i = 0; i < n; i++) captureSource(db, { id: `${thread}-s${i}`, threadId: thread, kind: "text", speaker: "owner", outcome: "recorded", text: `message ${i} of ${thread}` });
  const ids = db.prepare("SELECT j.id AS id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? ORDER BY j.rowid").all(thread).map(r => String(r.id));
  expect(ids).toHaveLength(n);
  const set = db.prepare("UPDATE memory_jobs SET status=?,error=?,lease_until=?,lease_owner=? WHERE id=?");
  ids.forEach((id, k) => {
    if (k < 10) set.run("failed", "MEMORY_WORKER_EXITED", 0, null, id);
    else if (k < 20) { /* pending, as captured */ }
    else if (k < 25) set.run("leased", null, NOW - 1, "gone-worker", id);
    else set.run("complete", null, 0, null, id);
  });
  return { failed: ids.slice(0, 10), open: ids.slice(10, 25) };
}
const scopeOf = (thread: string) => String(database().prepare("SELECT scope_id FROM memory_sources WHERE thread_id=? LIMIT 1").get(thread)!.scope_id);
const rowsOf = (ids: string[]) => ids.map(id => database().prepare("SELECT status,error FROM memory_jobs WHERE id=?").get(id)!);
const openOf = (thread: string) => Number(database().prepare(`SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status IN ${OPEN}`).get(thread)!.n);

/** A new process: nothing in memory carries over. Then the worker's start: the redrive, then claims until none is left. */
function restartAndDrain() {
  closeDatabase(); jobs.resetMemoryClaimCursor(); resetClaimSettleSweep(); resetParkSweep();
  database().exec("PRAGMA synchronous=OFF");
  return measure(() => {
    const redriven = jobs.redriveTransientFailedJobs(1000, NOW);
    const claimed: string[] = [];
    for (let n = 0; n < 500; n++) { const work = jobs.claimMemoryJob("w", NOW); if (!work) break; claimed.push(work.sourceId); }
    return { redriven, claimed };
  });
}
function payloadSources(m: ReturnType<typeof restartAndDrain>) {
  return m.sqls.flatMap((sql, at) => (sql === jobs.MEMORY_CLAIM_SQL.payload ? [String(m.params[at]![0])] : []));
}

describe("T11: nothing deleted or forgotten is claimed or revived before the revocation runner gets to it", () => {
  it("a deleted conversation: its open jobs are settled `denied`, its failed ones stay failed, none is read; the runner changes nothing more", () => {
    const doomed = conversation("doomed"), alive = conversation("alive");
    transaction(db => { commitRevoke(db, { kind: "thread", threadId: "doomed", cause: "delete-conversation" }); });
    expect(database().prepare("SELECT 1 AS x FROM memory_deny WHERE kind='thread' AND id='doomed'").get()).toBeTruthy();
    const m = restartAndDrain();
    expect(m.result.redriven).toBe(10);  // the other conversation's ten
    expect(m.result.claimed.every(id => id.startsWith("alive-"))).toBe(true);
    expect(m.result.claimed).toHaveLength(25);
    expect(payloadSources(m).filter(id => id.startsWith("doomed-"))).toEqual([]);
    expect(rowsOf(doomed.failed).every(r => r.status === "failed" && r.error === "MEMORY_WORKER_EXITED")).toBe(true);
    expect(rowsOf(doomed.open)).toEqual(doomed.open.map(() => ({ status: "cancelled", error: "settled:denied" })));
    expect(openOf("doomed")).toBe(0);
    expect(rowsOf(alive.failed).every(r => r.status === "leased")).toBe(true);
    // the runner's thread phase, run to completion: the settled jobs stay as they are; nothing of the conversation is open again
    const before = JSON.stringify(rowsOf(doomed.open));
    transaction(db => { applyForgetTombstones(db, { sources: [], records: [] }, { job: { thread: "doomed", threads: ["doomed"], cause: "thread-deletion" }, before: ["thread"] }); });
    runRevocationJobsNow(database());
    expect(JSON.stringify(rowsOf(doomed.open))).toBe(before);
    expect(openOf("doomed")).toBe(0);
    // (its own job cancel also closes the failed rows: status!='cancelled' in memory-revocation.ts sourceWorkPage; they never reopen)
    expect(rowsOf(doomed.failed).every(r => r.status === "failed" || r.status === "cancelled")).toBe(true);
    expect(jobs.redriveTransientFailedJobs(1000, NOW)).toBe(0);
  });

  it("a deleted scope: the same", () => {
    const doomed = conversation("doomed-scope"); conversation("alive");
    const scope = scopeOf("doomed-scope");
    transaction(db => { commitRevoke(db, { kind: "scope", scopeId: scope, cause: "scope-deny" }); });
    expect(database().prepare("SELECT 1 AS x FROM memory_deny WHERE kind='scope' AND id=?").get(scope)).toBeTruthy();
    const m = restartAndDrain();
    expect(m.result.redriven).toBe(10);
    expect(m.result.claimed.every(id => id.startsWith("alive-"))).toBe(true);
    expect(payloadSources(m).filter(id => id.startsWith("doomed-scope-"))).toEqual([]);
    expect(rowsOf(doomed.failed).every(r => r.status === "failed")).toBe(true);
    expect(rowsOf(doomed.open)).toEqual(doomed.open.map(() => ({ status: "cancelled", error: "settled:denied" })));
    expect(openOf("doomed-scope")).toBe(0);
  });

  it("a forgotten source (forgetMemory): never claimed or revived", () => {
    const doomed = conversation("forgotten"); conversation("alive");
    const sourceOf = (jobId: string) => String(database().prepare("SELECT source_id FROM memory_jobs WHERE id=?").get(jobId)!.source_id);
    // one failed, one pending and one expired-leased job's sources are forgotten by the owner
    const targets = [doomed.failed[0]!, doomed.open[0]!, doomed.open[12]!];
    for (const id of targets) forgetMemory(ownerMemoryTicket(), { kind: "source", id: sourceOf(id) });
    const m = restartAndDrain();
    const forgotten = new Set(targets.map(sourceOf));
    expect(payloadSources(m).filter(id => forgotten.has(id))).toEqual([]);
    expect(m.result.claimed.filter(id => forgotten.has(id))).toEqual([]);
    for (const row of rowsOf(targets)) expect(["failed", "cancelled"]).toContain(row.status);
  });

  it("a tombstone written before the source's state is flipped (a supporting tombstone the runner's later pages end): settled `denied`, never claimed or revived", () => {
    const doomed = conversation("tombstoned"); conversation("alive");
    const db = database();
    const sources = [...doomed.failed.slice(0, 3), ...doomed.open.slice(0, 3), ...doomed.open.slice(10, 12)].map(id => String(db.prepare("SELECT source_id FROM memory_jobs WHERE id=?").get(id)!.source_id));
    sources.forEach((id, k) => db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,?,NULL,1,'supporting',1)").run(`tomb-${k}`, id, k % 2 ? null : 1));
    const m = restartAndDrain();
    const tombstoned = new Set(sources);
    expect(payloadSources(m).filter(id => tombstoned.has(id))).toEqual([]);
    expect(m.result.claimed.filter(id => tombstoned.has(id))).toEqual([]);
    expect(rowsOf(doomed.failed.slice(0, 3)).every(r => r.status === "failed")).toBe(true);
    expect(rowsOf([...doomed.open.slice(0, 3), ...doomed.open.slice(10, 12)])).toEqual(Array.from({ length: 5 }, () => ({ status: "cancelled", error: "settled:denied" })));
    // the rest of that conversation is untouched: its seven other failed jobs were redriven and claimed, with its ten other open ones
    expect(m.result.claimed.filter(id => id.startsWith("tombstoned-"))).toHaveLength(7 + 10);
  });
});
