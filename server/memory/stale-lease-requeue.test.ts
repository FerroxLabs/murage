// RED2J: the policy revision moves while the owned worker holds a job — a
// bot, room or task created in the same window as a turn's capture, which
// every room or task test does right after a turn settles. The publication
// is refused as stale (p04), and the controller used to leave the job
// `leased` with nobody working it until the 30 s lease expired: the queue
// held one job the whole time, and a drain that waited on it timed out under
// load (turn-refused-at-acceptance-api.test.ts, checkpoint roll). The job is
// requeued at once and runs under the moved authority on the next tick, with
// no attempt spent and no worker error reported.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

// The authority moves inside the lease: the first publication finds the
// policy revision one ahead of the one the job was claimed under. Everything
// else is the real jobs module and the real forked worker.
const state = vi.hoisted(() => ({ moveOnce: false, publications: [] as string[] }));
vi.mock("./jobs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return {
    ...actual,
    publishMemoryWork: (...args: Parameters<typeof actual.publishMemoryWork>) => {
      if (state.moveOnce) { state.moveOnce = false; database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1"); }
      try { actual.publishMemoryWork(...args); state.publications.push("ok"); }
      catch (error) { state.publications.push(error instanceof Error ? error.message : String(error)); throw error; }
    },
  };
});

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); state.moveOnce = false; state.publications.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

it("requeues a job whose publication was refused as stale and completes it on the next claim, without an attempt or a worker error", async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "Durable evidence under a moving policy" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  state.moveOnce = true;
  const controller = new MemoryWorkerController(); controller.start();
  try {
    const job = () => database().prepare("SELECT status,attempts,lease_owner FROM memory_jobs").get() as { status: string; attempts: number; lease_owner: string | null };
    // Without the requeue the job stays `leased` here for the full 30 s lease.
    await vi.waitFor(() => expect(job().status).toBe("complete"), { timeout: 10000, interval: 50 });
    expect(job()).toMatchObject({ status: "complete", attempts: 0, lease_owner: null });
    expect(state.publications).toEqual(["STALE_MEMORY_SOURCE", "ok"]);
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='source'").get()?.n).toBe(1);
    expect(controller.error).toBeNull();
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([expect.stringMatching(/^\[memory\] worker result for job \S+ was STALE_MEMORY_SOURCE \(the authority moved while the job was leased\); requeued for the next claim$/)]);
  } finally { await controller.stop(); }
}, 20000);
