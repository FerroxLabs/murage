// SPDX-License-Identifier: AGPL-3.0-or-later
// The window's first /api/health is answered before any start-up work that
// follows listen runs; each step then runs in its own event-loop turn, named.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AFTER_LISTEN_BUSY_ATTEMPTS, runAfterListen } from "./after-listen.ts";
import { DatabaseBusyError } from "./database.ts";
import { ioBudget } from "./io-budget.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("runAfterListen", () => {
  it("waits for the first answer, then runs one step per turn and carries on past a failure", async () => {
    let answer!: () => void;
    const first = new Promise<void>(resolve => { answer = resolve; });
    const order: string[] = [];
    const done = runAfterListen([
      { name: "a", run: () => { order.push("a"); setImmediate(() => order.push("between")); } },
      { name: "b", run: () => { throw new Error("no"); } },
      { name: "c", run: () => order.push("c") },
    ], { first, fallbackMs: 60_000 });
    await sleep(20);
    expect(order).toEqual([]);
    answer();
    await done;
    expect(order).toEqual(["a", "between", "c"]);
  });
  it("keeps waiting for the first answer while the loop is still held by the boot", async () => {
    let answer!: () => void;
    const first = new Promise<void>(resolve => { answer = resolve; });
    const order: string[] = [];
    const done = runAfterListen([{ name: "memoryWorker", run: () => order.push("worker") }], { first, fallbackMs: 80, busyMs: 30, maxWaitMs: 5_000 });
    // a slow boot: the loop is held well past the fallback, so its timer fires late
    const until = performance.now() + 150;
    while (performance.now() < until) { /* synchronous boot work */ }
    await sleep(10);
    expect(order, "no worker before the first health answer").toEqual([]);
    answer();
    await done;
    expect(order).toEqual(["worker"]);
  });
  it("gives up waiting for a held loop after the longest wait", async () => {
    const order: string[] = [];
    const done = runAfterListen([{ name: "a", run: () => order.push("a") }], { first: new Promise<void>(() => {}), fallbackMs: 10, busyMs: 5, maxWaitMs: 60 });
    const until = performance.now() + 40;
    while (performance.now() < until) { /* held */ }
    await done;
    expect(order).toEqual(["a"]);
  });
  it("starts anyway after the fallback when nobody asks", async () => {
    const order: string[] = [];
    await runAfterListen([{ name: "a", run: () => order.push("a") }], { first: new Promise<void>(() => {}), fallbackMs: 10 });
    expect(order).toEqual(["a"]);
  });
});

// T5 (STALLS-FINAL-DESIGN 3.4): a step's synchronous part runs under the `startup` source (so its transactions take the background budget),
// the loops it starts do not inherit it, a step that met a held lock runs once more after the retry pause without holding the later steps
// back, and any other failure is warned once and skipped.
describe("runAfterListen sources and retries", () => {
  it("runs each step's synchronous part under the startup source, and only that part", async () => {
    const seen: Array<string | undefined> = [];
    let later: Promise<void> = Promise.resolve();
    await runAfterListen([{ name: "a", run: () => {
      seen.push(ioBudget.currentSource());
      later = new Promise<void>(resolve => setTimeout(() => { seen.push(ioBudget.currentSource()); resolve(); }, 1));
      ioBudget.withSource("memory-worker", () => seen.push(ioBudget.currentSource()));
    } }], { first: Promise.resolve() });
    await later;
    expect(seen).toEqual(["startup", "memory-worker", undefined]);
    expect(ioBudget.currentSource()).toBeUndefined();
  });
  it("runs a step that met a held lock again after the retry pause, and the later steps do not wait for it", async () => {
    const order: string[] = [];
    let attempts = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runAfterListen([
        { name: "locked", run: () => { attempts++; order.push(`locked${attempts}`); if (attempts === 1) throw new DatabaseBusyError("t5", 50); } },
        { name: "next", run: () => order.push("next") },
      ], { first: Promise.resolve(), busyRetryMs: 30 });
      expect(order).toEqual(["locked1", "next", "locked2"]);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it("tries a step that keeps meeting the lock AFTER_LISTEN_BUSY_ATTEMPTS times, then warns once; any other failure is warned once and not retried", async () => {
    let busy = 0, broken = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runAfterListen([
        { name: "busy", run: () => { busy++; throw new DatabaseBusyError("t5", 50); } },
        { name: "broken", run: () => { broken++; throw new Error("no"); } },
      ], { first: Promise.resolve(), busyRetryMs: 1 });
      expect(busy).toBe(AFTER_LISTEN_BUSY_ATTEMPTS);
      expect(broken).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
});

describe.skipIf(process.platform === "win32")("server start-up", () => {
  let child: ChildProcess | undefined, home = "";
  afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });

  it("answers /api/health before any deferred start-up step runs", async () => {
    const port = await freePortBlock([0, 1], 19_299, 200);
    const base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-after-listen-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {} }));
    let stdout = "", stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TURN_TRACE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(10);
    }
    while (!stdout.includes("phase=startup.deferred.done") && Date.now() < deadline) await sleep(20);
    const phases = [...stdout.matchAll(/phase=startup\.([\w.]+) ms=(\d+)/g)].map(match => ({ step: match[1]!, ms: Number(match[2]) }));
    const index = (step: string) => phases.findIndex(phase => phase.step === step);
    const deferred = phases.filter(phase => phase.step.startsWith("deferred."));
    expect(index("listen")).toBeGreaterThan(-1);
    expect(index("health.answered"), stdout).toBeGreaterThan(index("listen"));
    expect(deferred.length).toBeGreaterThan(10);
    for (const step of deferred) expect(phases.indexOf(step), step.step).toBeGreaterThan(index("health.answered"));
    const listenMs = phases[index("listen")]!.ms, healthMs = phases[index("health.answered")]!.ms;
    console.log(`[boot] listen=${listenMs} health=${healthMs} deferred.done=${phases[index("deferred.done")]?.ms}`);
    expect(healthMs - listenMs).toBeLessThan(250);
  }, 60_000);
});

// T6 (STALLS-FINAL-DESIGN 3.4, database.ts invariant 3): the stall watch runs before the port opens, so a block in the listen tick is named
// (`holder=listen.<name>`), and the serving thread writes nothing between listen and the first /api/health answer.
describe.skipIf(process.platform === "win32")("the listen tick", () => {
  let child: ChildProcess | undefined, home = "";
  afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });

  it("is watched from listen on and writes nothing before the first health answer", async () => {
    const port = await freePortBlock([0, 1], 19_399, 200);
    const base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-listen-tick-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {} }));
    let stdout = "", stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_STALL_MS: "250", MURAGE_TEST_LISTEN_BLOCK_MS: "300" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(10);
    }
    while (!/\[startup\] writes before first health=\d+/.test(stdout) && Date.now() < deadline) await sleep(20);
    while (!stdout.includes("holder=listen.testBlock") && Date.now() < deadline) await sleep(20);
    expect(stdout, stderr).toMatch(/\[startup\] writes before first health=0\b/);
    expect(stdout).toMatch(/\[loop\] stall blocked=\d+ms holder=listen\.testBlock:\d+ms/);
  }, 60_000);
});
