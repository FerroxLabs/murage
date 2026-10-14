// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine-history jobs run one at a time, and "one at a time" means the previous worker has really exited (r9 finding 3),
// and shutdown waits for that exit (finding 4).
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { resumeEngineHistory, runEngineHistoryOffThread, stopEngineHistory } from "./engine-history-offthread.ts";

/** A worker whose exit the test controls: terminate() is asked for, but the thread leaves only when the test says so (as a
 * thread stuck in native code does). */
class FakeWorker extends EventEmitter {
  threadId = 1;
  posted: unknown[] = [];
  terminated = 0;
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() { this.terminated++; return Promise.resolve(0); }
}
const job = { homes: [{ engine: "claude" as const, home: "/h" }], folders: [], memoryFolders: [], sessions: {} };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function factory() {
  const workers: FakeWorker[] = [];
  return { workers, createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; } };
}

afterEach(() => { resumeEngineHistory(); });

it("r9 finding 3: after a timeout the next job starts only when the timed-out worker has really exited", async () => {
  const { workers, createWorker } = factory();
  const first = runEngineHistoryOffThread(job, { createWorker, timeoutMs: 30 });
  const second = runEngineHistoryOffThread(job, { createWorker, timeoutMs: 5000 });
  // the caller still gets its timeout answer promptly
  expect((await first).failed).toEqual(["/h"]);
  expect(workers[0]!.terminated).toBe(1);
  await sleep(150);
  expect(workers).toHaveLength(1); // the second job has NOT started: the first thread is still alive
  workers[0]!.emit("error", new Error("stuck")); // an error notice is not an exit
  await sleep(100);
  expect(workers).toHaveLength(1);
  workers[0]!.emit("exit", 1); // the real exit
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  workers[1]!.emit("message", { type: "result", result: { removed: ["x"], failed: [], leftovers: [] } });
  expect((await second).removed).toEqual(["x"]);
  workers[1]!.emit("exit", 0);
});

it("r9 finding 3: a queued job whose predecessor never leaves is reported failed, and stays behind it", async () => {
  const { workers, createWorker } = factory();
  const first = runEngineHistoryOffThread(job, { createWorker, timeoutMs: 20 });
  const second = runEngineHistoryOffThread(job, { createWorker, exitWaitMs: 80 });
  const third = runEngineHistoryOffThread(job, { createWorker, exitWaitMs: 80 });
  await first;
  expect((await second).failed).toEqual(["/h"]);
  expect((await third).failed).toEqual(["/h"]);
  expect(workers).toHaveLength(1);
  workers[0]!.emit("exit", 0);
  const fourth = runEngineHistoryOffThread(job, { createWorker, timeoutMs: 5000 });
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  workers[1]!.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [] } });
  expect((await fourth).failed).toEqual([]);
  workers[1]!.emit("exit", 0);
});

it("r9 finding 4: stopping waits for the worker's exit event, refuses new jobs, and an error alone is not an exit", async () => {
  const { workers, createWorker } = factory();
  const running = runEngineHistoryOffThread(job, { createWorker, timeoutMs: 60_000 });
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  const stopping = stopEngineHistory(20, 5000);
  await sleep(80);
  expect(workers[0]!.terminated).toBe(1); // grace over: ended
  workers[0]!.emit("error", new Error("boom")); // not an exit
  let settled: boolean | undefined;
  void stopping.then(value => { settled = value; });
  await sleep(50);
  expect(settled).toBeUndefined(); // still waiting for the real exit
  workers[0]!.emit("exit", 1);
  expect(await stopping).toBe(true);
  expect((await running).failed).toEqual(["/h"]);
  // a job that arrives after shutdown began never starts a worker
  expect((await runEngineHistoryOffThread(job, { createWorker })).failed).toEqual(["/h"]);
  expect(workers).toHaveLength(1);
  // and a worker that never leaves is reported alive
  resumeEngineHistory();
  const again = factory();
  void runEngineHistoryOffThread(job, { createWorker: again.createWorker, timeoutMs: 60_000 });
  await vi.waitFor(() => expect(again.workers).toHaveLength(1));
  expect(await stopEngineHistory(10, 30)).toBe(false);
  again.workers[0]!.emit("exit", 0);
  expect(await stopEngineHistory(10, 30)).toBe(true);
});

it("r14 finding 7: when the worker cannot be started no engine file is touched, the job fails with a reason, and the thread is not held", async () => {
  const { fsOps, mutOps } = await import("./engine-fs.ts");
  const calls: string[] = [];
  const spies: Array<[Record<string, unknown>, string, unknown]> = [];
  for (const layer of [fsOps as unknown as Record<string, (...args: unknown[]) => unknown>, mutOps as unknown as Record<string, (...args: unknown[]) => unknown>]) {
    for (const name of Object.keys(layer)) {
      spies.push([layer, name, layer[name]]);
      layer[name] = (...args: unknown[]) => { calls.push(name); return (spies.find(([l, n]) => l === layer && n === name)![2] as (...a: unknown[]) => unknown)(...args); };
    }
  }
  try {
    const beats: number[] = [];
    const started = Date.now();
    const heartbeat = setTimeout(() => beats.push(Date.now() - started), 1);
    const result = await runEngineHistoryOffThread({ ...job, kind: "plan" }, { createWorker: () => { throw new Error("no thread"); } });
    clearTimeout(heartbeat);
    expect(result.failed).toEqual(["/h"]);
    expect(result.failedHomes).toEqual(["claude\0/h"]);
    expect(result.homeReasons).toEqual({ "claude\0/h": "worker-unavailable" });
    expect(calls).toEqual([]); // no read and no change was attempted on this thread
    expect(beats.length === 0 || beats[0]! < 50).toBe(true);
  } finally {
    for (const [layer, name, original] of spies) layer[name] = original;
  }
});
