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
import { afterAll, describe, expect, it } from "vitest";
import { runAfterListen } from "./after-listen.ts";
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
