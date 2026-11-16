// SPDX-License-Identifier: AGPL-3.0-or-later
// A production build cannot arm a checkpointer park, and the park the tests use is bounded. (Grok GROK-WALHANG4 critical: the worker's park was
// an unbounded spin in production source that holdCopy could arm in any build.)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { barrierSource, createWalBarrier } from "./testing/wal-barrier.ts";
import { dateNowBusyWaits, isTestOnly, productionGraph, rel as relOf } from "./testing/production-graph.ts";

const server = dirname(fileURLToPath(import.meta.url)), repo = dirname(server);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); } else if (/\.(ts|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(repo, p).replace(/\\/g, "/");
const all = walk(server);
const production = all.filter(p => !/\.test\.(ts|mjs)$/.test(p) && !rel(p).startsWith("server/testing/"));

it("production source holds no test-controlled spin: no holdStart, holdGate or holdMs, and no Date.now busy-wait, in any file production reaches", () => {
  const files = [...productionGraph().keys()].filter(f => !isTestOnly(relOf(f)));
  expect(files.length, "the production graph was walked").toBeGreaterThan(200);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    expect(dateNowBusyWaits(text), `${relOf(f)}: a Date.now busy-wait`).toEqual([]);
    if (relOf(f) === "server/wal-maintenance.ts") expect(text, `${relOf(f)}: holdStart, holdGate or holdMs`).not.toMatch(/holdStart|holdGate|holdMs/);
  }
  // the guard itself recognises the shapes it forbids
  expect(dateNowBusyWaits("while (Atomics.load(shared, 11) && Date.now() < stop) {}")).toHaveLength(1);
  expect(dateNowBusyWaits("while (Date.now() < end) { /* held */ }")).toHaveLength(1);
  expect(dateNowBusyWaits("while(Date.now()<end);")).toHaveLength(1);
  expect(dateNowBusyWaits("while (f(Date.now()) < end) {}")).toHaveLength(1);
  expect(dateNowBusyWaits("while (Date.now() < end) { if (settled()) return; await wait(5); }")).toEqual([]);
  expect(dateNowBusyWaits("while(ok()&&Date.now()<limit)await new Promise(r=>setTimeout(r,5));")).toEqual([]);
});
it("production source holds no arming path and no spin: no holdCopy, no parkAt body, no unbounded Atomics spin in wal-maintenance.ts", () => {
  const text = readFileSync(join(server, "wal-maintenance.ts"), "utf8");
  expect(text).not.toMatch(/holdCopy|copyParkedAt|releaseCopy|function parkAt/);
  expect(text, "no empty-bodied wait on a cleared atomic flag").not.toMatch(/while\s*\(\s*!\s*Atomics\.load\([^)]*\)[^{;]*\)\s*(\{\s*\}|;)/);
  expect(text, "no worker slots 24 to 26 (the old park flags)").not.toMatch(/Atomics\.\w+\(\s*(active\.)?shared,\s*2[4-6]/);
  expect(text, "no barrier or hooks object in production source").not.toMatch(/workerData\.barrier|const hooks =/);
  expect(text, "no test-controlled hold, gate or start pause: those are test instrumentation (server/testing/wal-barrier.ts)").not.toMatch(/holdStart|holdGate|holdMs/);
  expect(dateNowBusyWaits(text), "no Date.now busy-wait").toEqual([]);
  expect(text, "production source declares no worker seam").not.toContain("walWorkerSeam");
});

it("only server/testing/wal-barrier.ts can set the seam, and no production file imports it", () => {
  for (const p of all) {
    const text = readFileSync(p, "utf8"), name = rel(p);
    if (/walWorkerSeam\.barrier\s*=[^=]/.test(text)) expect(name, "the one writer").toBe("server/testing/wal-barrier.ts");
  }
  for (const p of production) {
    const text = readFileSync(p, "utf8");
    expect(text, rel(p)).not.toMatch(/\b(from|import|require)\s*\(?\s*["\x27][^"\x27]*testing\/wal-barrier/); // from "x", import "x" (side effect), import("x"), require("x")
    if (rel(p) !== "server/wal-maintenance.ts") expect(text, rel(p)).not.toMatch(/walWorkerSeam/);
  }
});

it("the server build excludes server/testing, so the barrier module is not in a production bundle", () => {
  const build = JSON.parse(readFileSync(join(repo, "tsconfig.server.build.json"), "utf8")) as { exclude: string[] };
  expect(build.exclude).toContain("server/testing");
  // scripts/bundle-server.mjs bundles only its ENTRY_POINTS (esbuild follows imports) out of the tsc output of that build, so the module is in a
  // bundle only if an entry point imports it, and the production-import check above forbids that. No entry point names it either:
  expect(readFileSync(join(repo, "scripts", "bundle-server.mjs"), "utf8")).not.toMatch(/wal-barrier|server\/testing/);
});

it("a parked pass nobody releases is released by its own deadline and says so", async () => {
  const barrier = createWalBarrier(150);
  const shared = new SharedArrayBuffer(32 * 4);
  const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
    const hooks = (0, eval)("(" + workerData.src + ")")(workerData.buffer, new Int32Array(workerData.shared));
    hooks.park(2); parentPort.postMessage("returned");`, { eval: true, workerData: { src: barrierSource(), buffer: barrier.buffer, shared } });
  barrier.arm(2);
  const outcome = await Promise.race([new Promise<string>(resolve => { worker.once("message", () => resolve("returned")); worker.once("error", e => resolve(String(e))); }), new Promise<string>(resolve => setTimeout(() => resolve("still parked"), 5000))]);
  await worker.terminate();
  expect(outcome, "the pass came back without a release").toBe("returned");
  expect(barrier.expired(), "and the deadline was reported").toBe(1);
});

it.skipIf(process.platform === "win32")("the Windows-required runner never reports green off Windows: FAIL windows-required, exit 2", () => {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "run-windows-required.mjs")], { encoding: "utf8", cwd: repo });
  expect(run.status, "exit code").toBe(2);
  expect(run.stderr, "message").toContain("FAIL windows-required");
  expect(run.stdout, "no PASS line").not.toMatch(/PASS/);
});
