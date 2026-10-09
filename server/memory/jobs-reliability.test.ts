// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROPOSAL-v2 10.4: one unreadable job never blocks its scope, attempts are spent only on permanent
// causes, jobs failed for transient causes are given their attempts back once, and the daily allowance
// is traced to a place that spends no capture attempt.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { decodeCaptureSlice, failedMemoryJobsByCause, claimMemoryJob, MEMORY_CLAIM_SQL, parseJobError, publishMemoryWork, redriveTransientFailedJobs, resetMemoryClaimCursor, TRANSIENT_FREE_LIMIT } from "./jobs.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { resetWorkerLog } from "./worker-log.ts";

let lines: string[];
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] }); setMemoryMode("capture"); resetMemoryClaimCursor();
  lines = []; resetWorkerLog(); resetObserveWindows(); setObserveSink(line => lines.push(line));
});
afterEach(() => setObserveSink());

const NOW = 1_000_000;
function source(id: string, text: string, thread = "thread") {
  captureSource(database(), { id, threadId: thread, messageId: `m-${id}`, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text });
  return String(database().prepare("SELECT j.id FROM memory_jobs j WHERE j.source_id=?").get(id)!.id);
}
const job = (id: string) => database().prepare("SELECT status,attempts,error,retry_at,cursor FROM memory_jobs WHERE id=?").get(id)!;
const defer = (work: NonNullable<ReturnType<typeof claimMemoryJob>>, reason: string, now = NOW) =>
  publishMemoryWork(work, "w", { id: work.id, leaseGeneration: work.leaseGeneration, status: "deferred", nextCursor: work.cursor, chunks: [], reason }, now);

it("an unreadable job fails alone, with its cause, and the claim moves on to the next job of the scope", () => {
  // a lone surrogate escape is valid JSON but does not decode as UTF-8 once the text is read as bytes
  const poison = source("a-poison", "placeholder");
  database().prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='a-poison'").run('{"text":"abc \\ud800 def"}');
  const good = source("b-good", "A perfectly readable message.");
  const work = claimMemoryJob("w", NOW);
  expect(work?.id).toBe(good);
  expect(job(poison)).toMatchObject({ status: "failed", attempts: 3, error: "INVALID_SOURCE_UTF8" });
  expect(lines.some(line => line.includes("subsystem=capture cause=INVALID_SOURCE_UTF8"))).toBe(true);
  expect(failedMemoryJobsByCause()).toEqual([{ cause: "unreadable", count: 1 }]);
});

it("a resume cursor that starts inside a character moves forward past its tail, at most 3 bytes, and the source is covered to the end", () => {
  const id = source("accent", "éa");  // C3 A9 61
  database().prepare("UPDATE memory_jobs SET cursor=1 WHERE id=?").run(id);
  const work = claimMemoryJob("w", NOW)!;
  expect(work.cursor).toBe(2);
  expect(work.text).toBe("a");
  expect(work.totalBytes).toBe(3);
  publishMemoryWork(work, "w", captureWork(work), NOW);
  expect(job(id)).toMatchObject({ status: "complete", cursor: 3 });
});

it("slice decoding trims a cut tail only when the slice is not the end of the source", () => {
  const bytes = new TextEncoder().encode("ab€");  // 61 62 E2 82 AC
  expect(decodeCaptureSlice(bytes.subarray(0, 4), false)).toMatchObject({ text: "ab", skipped: 0, used: 2 });
  expect(decodeCaptureSlice(bytes.subarray(0, 4), true)).toBeNull();
  expect(decodeCaptureSlice(bytes.subarray(3), false)).toMatchObject({ text: "", skipped: 2 });
  expect(decodeCaptureSlice(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x61]), false)).toBeNull();
});

it("exit while stopping, a timeout, a busy database and an allowance deferral reschedule without spending an attempt", () => {
  for (const reason of ["MEMORY_WORKER_STOPPED", "MEMORY_WORKER_TIMEOUT", "MEMORY_DATABASE_BUSY", "daily-allowance"]) {
    const id = source(`s-${reason}`, "Some text to learn from.");
    defer(claimMemoryJob("w", NOW)!, reason);
    expect(job(id)).toMatchObject({ status: "deferred", attempts: 0, error: `transient:1:${reason}` });
    expect(Number(job(id).retry_at)).toBeGreaterThan(NOW);
  }
});

it("a permanent cause spends an attempt, three fail the job, and a job that keeps timing out is not retried for free forever", () => {
  const id = source("crash", "Text.");
  for (let n = 1; n <= 3; n++) { defer(claimMemoryJob("w", NOW + n * 100_000)!, "MEMORY_WORKER_EXITED", NOW + n * 100_000); expect(job(id).attempts).toBe(n); }
  expect(job(id)).toMatchObject({ status: "failed", error: "MEMORY_WORKER_EXITED" });

  const slow = source("slow", "More text.");
  let now = NOW;
  for (let n = 1; n <= TRANSIENT_FREE_LIMIT; n++) { now += 1_000_000; defer(claimMemoryJob("w", now)!, "MEMORY_WORKER_TIMEOUT", now); }
  expect(job(slow)).toMatchObject({ status: "deferred", attempts: 0 });
  expect(parseJobError(job(slow).error).transient).toBe(TRANSIENT_FREE_LIMIT);
  now += 1_000_000; defer(claimMemoryJob("w", now)!, "MEMORY_WORKER_TIMEOUT", now);
  expect(job(slow).attempts).toBe(1);
});

it("failed jobs with a transient cause get their attempts back once at the next start, capped; a second failure is final", () => {
  const ids = ["r1", "r2", "r3"].map(name => source(name, `Text ${name}.`));
  database().prepare("UPDATE memory_jobs SET status='failed',attempts=3,error='MEMORY_WORKER_EXITED' WHERE id IN (?,?)").run(ids[0], ids[1]);
  database().prepare("UPDATE memory_jobs SET status='failed',attempts=3,error='INVALID_SOURCE_UTF8' WHERE id=?").run(ids[2]);
  expect(redriveTransientFailedJobs(1, NOW)).toBe(1);
  expect(redriveTransientFailedJobs(1000, NOW)).toBe(1);
  expect(job(ids[0])).toMatchObject({ status: "pending", attempts: 0, error: "redriven:MEMORY_WORKER_EXITED" });
  expect(job(ids[2])).toMatchObject({ status: "failed", error: "INVALID_SOURCE_UTF8" });
  for (let n = 1; n <= 6; n++) { const work = claimMemoryJob("w", NOW + n * 100_000); if (!work) break; defer(work, "MEMORY_WORKER_EXITED", NOW + n * 100_000); }
  expect(database().prepare("SELECT id,status,error FROM memory_jobs WHERE status='failed' AND error='redriven:MEMORY_WORKER_EXITED'").all()).toHaveLength(2);
  expect(redriveTransientFailedJobs(1000, NOW)).toBe(0);
});

it("traced: the daily allowance is held in the learning pass and spends no attempt of the capture job", async () => {
  const id = source("allowance", "I prefer concise answers.");
  const work = claimMemoryJob("w", NOW)!;
  publishMemoryWork(work, "w", captureWork(work), NOW);
  updateMemoryLearning(database(), { dailyOutputTokens: 0 }, readMemoryLearning(database()).revision);
  const result = await consolidateMemorySource(work.id, async () => "[]", new AbortController().signal);
  expect(result).toMatchObject({ status: "deferred", reason: "budget-exhausted" });
  expect(job(id)).toMatchObject({ status: "complete", attempts: 0 });
  expect(database().prepare("SELECT DISTINCT stage FROM memory_jobs").all()).toEqual([{ stage: "capture" }]);
});

it("EXPLAIN QUERY PLAN: no claim statement scans the payload, record or receipt tables, or the job table without an index", () => {
  source("plan", "Some text.");
  for (const [name, sql] of Object.entries(MEMORY_CLAIM_SQL)) {
    const holes = (sql.match(/\?/g) ?? []).length;
    const plan = database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: holes }, () => 0)).map(row => String(row.detail)).join(" | ");
    expect(plan, `${name}: ${plan}`).not.toMatch(/\bSCAN (memory_source_versions|memory_records|memory_disclosures)\b/);
    expect(plan, `${name}: ${plan}`).not.toMatch(/\bSCAN (j|memory_jobs)\b(?! USING)/);
  }
});
