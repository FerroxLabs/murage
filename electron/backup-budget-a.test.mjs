// 1.0.13 BACKUP-BUDGET-A: the two parents of a long run wait for it (designs/BACKUP-BUDGET-A-1013.md).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createServerChildLifecycle } from "./server-child-lifecycle.mjs";
import { runInstallationRecoveryWorker } from "./installation-recovery-runner.mjs";
import { launchClosedCapture } from "../scripts/backup-schedule-trigger.ts";

const MIN = 60_000;
afterEach(() => { vi.useRealTimers(); });

it("the runner lets a worker run past 30:30 under a longer budget", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
  const valid = { ok: true, operation: "backup", path: "/selected/a.zip", sha256: "a".repeat(64), snapshotId: "12345678-1234-1234-1234-123456789abc" };
  let settled = false;
  const run = runInstallationRecoveryWorker({ fork: () => child, entry: "owned-worker", args: ["backup"], env: {}, track: createServerChildLifecycle, timeoutMs: 79 * MIN + 30_000 }).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(30 * MIN + 31_000); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(30 * MIN);
  child.stdout.end(JSON.stringify(valid)); child.emit("exit", 0);
  await vi.advanceTimersByTimeAsync(1);
  expect((await run).path).toBe(valid.path);
});

it("the closed-app parent leaves a run alone past 32 minutes", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  void launchClosedCapture({ executable: "x", args: [], env: {} }, { spawnChild: () => child });
  await vi.advanceTimersByTimeAsync(4 * 60 * MIN); expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5 * MIN + 1); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

