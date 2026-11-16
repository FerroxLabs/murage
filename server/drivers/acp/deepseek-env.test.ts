import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const control = vi.hoisted(() => ({ gate: undefined as SharedArrayBuffer | undefined, workers: [] as import("node:worker_threads").Worker[], slowStop: false,
  stopReal: undefined as ((worker: import("node:worker_threads").Worker) => Promise<number>) | undefined }));
vi.mock("node:worker_threads", async original => {
  const real = await original<typeof import("node:worker_threads")>();
  control.stopReal = worker => real.Worker.prototype.terminate.call(worker);
  return { ...real, Worker: class extends real.Worker {
    terminate(): Promise<number> { return control.slowStop ? new Promise(() => {}) : super.terminate(); }
    constructor(source: string, options: import("node:worker_threads").WorkerOptions) {
      const prefix = control.gate ? `
const testGate = new Int32Array(require('node:worker_threads').workerData.gate);
require('node:worker_threads').workerData = require('node:worker_threads').workerData.paths;
const testFs = require('node:fs'), originalRead = testFs.readSync;
testFs.readSync = (...args) => { Atomics.store(testGate, 0, 1); Atomics.wait(testGate, 1, 0, 15000); return originalRead(...args); };
` : "";
      super(prefix + source, control.gate ? { ...options, workerData: { paths: options.workerData, gate: control.gate } } : options);
      control.workers.push(this);
    }
  } };
});
import { readDeepseekEnv } from "./deepseek-env.ts";
import { deepseekDestinationAnswer, resolveDeepseekDestination } from "./deepseek-destination.ts";

let root: string | undefined;
afterEach(async () => {
  for (const worker of control.workers) await control.stopReal!(worker);
  control.workers.length = 0; control.gate = undefined; control.slowStop = false;
  if (root) removeTempDirSync(root);
  root = undefined;
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), "deepseek-env-"));
  const project = join(root, "project"), home = join(root, "home");
  mkdirSync(project); mkdirSync(home);
  const path = join(home, ".env");
  writeFileSync(path, "# fixture\n");
  control.gate = new SharedArrayBuffer(8);
  return { project, home, path };
}
async function reading() {
  await vi.waitFor(() => expect(Atomics.load(new Int32Array(control.gate!), 0)).toBe(1), { timeout: 1500, interval: 10 });
}
it("Stop interrupts a stalled regular-file read after the CLI probe exits and joins its worker", async () => {
  const { project: cwd, home } = fixture();
  const script = join(root!, "probe.mjs");
  writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify([{ name: "@deepseek-ai/dsh-llm-deepseek-api-key", config: {} }]))});`);
  const controller = new AbortController();
  const pending = resolveDeepseekDestination({ cwd, env: { DSH_HOME: home }, model: "deepseek-official/model",
    cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, signal: controller.signal, memoryOff: true });
  const outcome = pending.catch(error => error);
  await reading();
  const stoppedAt = performance.now();
  controller.abort();
  expect(await outcome).toBeInstanceOf(Error);
  expect(performance.now() - stoppedAt).toBeLessThan(1000);
  expect(control.workers).toHaveLength(1);
  expect(control.workers[0].threadId).toBe(-1);
});
it("a stalled regular-file read times out while the server event loop stays responsive", async () => {
  const { project: cwd, home } = fixture();
  const pending = deepseekDestinationAnswer(JSON.stringify([{ name: "@deepseek-ai/dsh-llm-deepseek-api-key", config: {} }]), { cwd, env: { DSH_HOME: home }, model: "deepseek-official/model" });
  await reading();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    expect(await pending).toMatchObject({ unknown: "deepseek-config" });
    expect(ticks).toBeGreaterThan(5);
    expect(control.workers[0].threadId).toBe(-1);
  } finally { clearInterval(timer); }
}, 5000);
it("an already stopped read starts no worker", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(readDeepseekEnv(["unused"], controller.signal)).rejects.toThrow("stopped");
  expect(control.workers).toHaveLength(0);
});

it("unconfirmed filesystem worker stops settle promptly, retain bounded ownership and release capacity only on exit", async () => {
  const { path } = fixture();
  control.slowStop = true;
  const controller = new AbortController();
  const pending = Promise.all(Array.from({ length: 4 }, () => readDeepseekEnv([path], controller.signal).catch(error => error)));
  await reading();
  const stoppedAt = performance.now();
  controller.abort();
  const results = await pending;
  expect(performance.now() - stoppedAt).toBeLessThan(1000);
  for (const result of results) expect(result).toBeInstanceOf(Error);
  expect(control.workers).toHaveLength(4);
  await expect(readDeepseekEnv([path])).rejects.toThrow("config probe busy");
  expect(control.workers).toHaveLength(4);
  for (const worker of control.workers) await control.stopReal!(worker);
  control.slowStop = false; control.gate = undefined;
  expect(await readDeepseekEnv([path])).toEqual(["# fixture\n"]);
}, 5000);
