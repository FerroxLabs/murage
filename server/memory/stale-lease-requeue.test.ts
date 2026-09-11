// RED2J: the policy revision moves while the owned worker holds a job — a
// bot, room or task created in the same window as a turn's capture, which
// every room or task test does right after a turn settles. The publication
// is refused as stale (p04), and the controller used to leave the job
// `leased` with nobody working it until the 30 s lease expired: the queue
// held one job the whole time, and a drain that waited on it timed out under
// load (turn-refused-at-acceptance-api.test.ts, checkpoint roll). The job is
// requeued at once and runs under the moved authority on the next tick, with
// no attempt spent and no worker error reported.
//
// RED2K (RED2J verifier): that requeue is bounded. Under continuous churn a
// job could be claimed, refused and requeued forever, each round free. After
// STALE_MEMORY_REQUEUE_LIMIT stale requeues the next refusal defers the job
// with one attempt spent through the ordinary deferral path, so the attempt
// cap ends a job the authority never stands still for, and the log says why.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { STALE_MEMORY_REQUEUE_LIMIT } from "./jobs.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

// The authority moves inside the lease: the first `moveTimes` publications
// each find the policy revision one ahead of the one the job was claimed
// under. Everything else is the real jobs module and the real forked worker.
const state = vi.hoisted(() => ({ moveTimes: 0, publications: [] as string[] }));
vi.mock("./jobs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return {
    ...actual,
    publishMemoryWork: (...args: Parameters<typeof actual.publishMemoryWork>) => {
      if (state.moveTimes > 0) { state.moveTimes -= 1; database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1"); }
      try { actual.publishMemoryWork(...args); state.publications.push("ok"); }
      catch (error) { state.publications.push(error instanceof Error ? error.message : String(error)); throw error; }
    },
  };
});

const job = () => database().prepare("SELECT status,attempts,lease_owner,retry_at,error FROM memory_jobs").get() as { status: string; attempts: number; lease_owner: string | null; retry_at: number; error: string | null };
const sourceRecords = () => database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='source'").get()?.n;
const requeueLine = (count: number) => expect.stringMatching(new RegExp(`^\\[memory\\] worker result for job \\S+ was STALE_MEMORY_SOURCE \\(the authority moved while the job was leased\\); requeued for the next claim \\(stale requeue ${count} of ${STALE_MEMORY_REQUEUE_LIMIT}\\)$`));
const stale = (n: number) => Array.from({ length: n }, () => "STALE_MEMORY_SOURCE");

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); state.moveTimes = 0; state.publications.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

it("requeues a job whose publication was refused as stale and completes it on the next claim, without an attempt or a worker error", async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "Durable evidence under a moving policy" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.moveTimes = 1;
  const controller = new MemoryWorkerController(); controller.start();
  try {
    // Without the requeue the job stays `leased` here for the full 30 s lease.
    await vi.waitFor(() => expect(job().status).toBe("complete"), { timeout: 10000, interval: 50 });
    expect(job()).toMatchObject({ status: "complete", attempts: 0, lease_owner: null, error: null });
    expect(state.publications).toEqual(["STALE_MEMORY_SOURCE", "ok"]);
    expect(sourceRecords()).toBe(1);
    expect(controller.error).toBeNull();
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([requeueLine(1)]);
  } finally { await controller.stop(); }
}, 20000);

it(`requeues up to ${STALE_MEMORY_REQUEUE_LIMIT} stale refusals of one job with no attempt spent`, async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "Durable evidence under a policy that keeps moving" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.moveTimes = STALE_MEMORY_REQUEUE_LIMIT;
  const controller = new MemoryWorkerController(); controller.start();
  try {
    await vi.waitFor(() => expect(job().status).toBe("complete"), { timeout: 15000, interval: 50 });
    expect(job()).toMatchObject({ status: "complete", attempts: 0, lease_owner: null, error: null });
    expect(state.publications).toEqual([...stale(STALE_MEMORY_REQUEUE_LIMIT), "ok"]);
    expect(sourceRecords()).toBe(1);
    expect(controller.error).toBeNull();
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual(Array.from({ length: STALE_MEMORY_REQUEUE_LIMIT }, (_, index) => requeueLine(index + 1)));
  } finally { await controller.stop(); }
}, 30000);

it(`defers the job with one attempt spent on the stale refusal after ${STALE_MEMORY_REQUEUE_LIMIT} requeues, and the deferred job still completes later`, async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "Durable evidence under a policy that never stands still" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.moveTimes = STALE_MEMORY_REQUEUE_LIMIT + 1;
  const before = Date.now();
  const controller = new MemoryWorkerController(); controller.start();
  try {
    // Without the bound the job is requeued a sixth time, free, and completes
    // with attempts 0: the churn is never recorded anywhere.
    await vi.waitFor(() => expect(job().status).toBe("deferred"), { timeout: 15000, interval: 50 });
    const deferred = job();
    expect(deferred).toMatchObject({ status: "deferred", attempts: 1, lease_owner: null, error: "MEMORY_STALE_REQUEUE_LIMIT" });
    // the ordinary first-attempt backoff, as a worker's own deferral gets
    expect(deferred.retry_at).toBeGreaterThanOrEqual(before + 5000);
    expect(deferred.retry_at).toBeLessThanOrEqual(Date.now() + 5000);
    expect(state.publications).toEqual(stale(STALE_MEMORY_REQUEUE_LIMIT + 1));
    expect(sourceRecords()).toBe(0);
    expect(controller.error).toBe("MEMORY_STALE_REQUEUE_LIMIT");
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      ...Array.from({ length: STALE_MEMORY_REQUEUE_LIMIT }, (_, index) => requeueLine(index + 1)),
      expect.stringMatching(new RegExp(`^\\[memory\\] worker result for job \\S+ was STALE_MEMORY_SOURCE after ${STALE_MEMORY_REQUEUE_LIMIT} stale requeues \\(the authority kept moving while the job was leased\\); deferred with an attempt spent \\(MEMORY_STALE_REQUEUE_LIMIT\\)$`)),
    ]);
    // The attempt cap governs from here: the deferral is retried after its
    // backoff like any other, and completes under a standing authority with
    // the spent attempt on the row.
    await vi.waitFor(() => expect(job().status).toBe("complete"), { timeout: 15000, interval: 50 });
    expect(job()).toMatchObject({ status: "complete", attempts: 1, lease_owner: null, error: null });
    expect(state.publications).toEqual([...stale(STALE_MEMORY_REQUEUE_LIMIT + 1), "ok"]);
    expect(sourceRecords()).toBe(1);
    expect(controller.error).toBeNull();
    expect(warn).toHaveBeenCalledTimes(STALE_MEMORY_REQUEUE_LIMIT + 1);
  } finally { await controller.stop(); }
}, 40000);

it("a job that completes after a stale requeue keeps the attempts it had already spent and clears its error", async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "Durable evidence after an earlier deferral" });
  // One attempt was already spent by an earlier worker deferral of this job.
  database().prepare("UPDATE memory_jobs SET attempts=1,status='deferred',error='MEMORY_WORKER_TIMEOUT'").run();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.moveTimes = 1;
  const controller = new MemoryWorkerController(); controller.start();
  try {
    await vi.waitFor(() => expect(job().status).toBe("complete"), { timeout: 10000, interval: 50 });
    // the requeue spent nothing and the success reset nothing: the earlier
    // attempt stays on the row, its error is cleared by the publication
    expect(job()).toMatchObject({ status: "complete", attempts: 1, lease_owner: null, error: null });
    expect(state.publications).toEqual(["STALE_MEMORY_SOURCE", "ok"]);
    expect(sourceRecords()).toBe(1);
    expect(controller.error).toBeNull();
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([requeueLine(1)]);
  } finally { await controller.stop(); }
}, 20000);
