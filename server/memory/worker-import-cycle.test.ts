// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-cycle (owners: this witness = q1023-cycle; the checkpoint predicate = checkpoints.ts / checkpoint-sql.ts; the controller = recall-fix-c).
// The memory worker is entered at server/memory/worker.ts. Its imports reach checkpoints.ts first (worker.ts -> eligibility.ts ->
// checkpoints.ts -> database.ts -> ... -> oneindex.ts), so oneindex.ts was evaluated while checkpoints.ts was still on the stack, and
// its module-level SQL read CURRENT_CHECKPOINT_SQL before it was initialised: the worker exited at start (ReferenceError), every
// search answered MEMORY_WORKER_EXITED with index=blocked. These witnesses start the worker the way production does and require it to
// come up; the last one imports every server/memory module first in its own process, so no other module-level read of an import inside
// a cycle can do the same.
import { fork, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { fixtureHelperPermits } from "./testing/helper-permits.ts";
import { CURRENT_CHECKPOINT_SQL } from "./checkpoints.ts";

const TDZ = /before initialization|ReferenceError/;
let controller: MemoryWorkerController | null = null, scratch = "";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); scratch = mkdtempSync(join(tmpdir(), "boot-order-")); });
afterEach(async () => { await controller?.stop().catch(() => {}); controller = null; closeDatabase(); removeTempDirSync(scratch); });

it("W-CYCLE-ENTRY: the worker entry, forked first exactly as the controller forks it, reports ready and stays up", async () => {
  const permits = fixtureHelperPermits();
  const child = fork(SPAWNED_PROXIES.memoryWorker, [], { execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...permits.env, ELECTRON_RUN_AS_NODE: "1", MURAGE_DATA_DIR: scratch } });
  permits.attach(child);
  let stderr = "", exited: number | null | undefined;
  child.stderr!.on("data", d => { stderr = (stderr + d).slice(-4000); });
  child.stdout!.on("data", () => {});
  child.on("exit", code => { exited = code; });
  const ready = await new Promise<boolean>(done => {
    const timer = setTimeout(() => done(false), 30_000);
    child.on("message", m => { if ((m as { type?: string }).type === "ready") { clearTimeout(timer); done(true); } });
    child.on("exit", () => { clearTimeout(timer); done(false); });
  });
  // Still up a moment after ready: a load error after the first message must not pass for a start.
  if (ready) await new Promise(r => setTimeout(r, 2_000));
  try {
    expect({ ready, exited, tdz: TDZ.test(stderr) ? stderr.split("\n").find(l => TDZ.test(l)) : null }).toEqual({ ready: true, exited: undefined, tdz: null });
  } finally { child.kill("SIGKILL"); }
}, 60_000);

it("W-CYCLE-CONTROLLER: the real controller's start forks a worker that becomes ready, with no start failure or exit recorded", async () => {
  setMemoryMode("active");
  controller = new MemoryWorkerController();
  controller.start();
  controller.warmForIntent();
  const until = Date.now() + 45_000;
  while (Date.now() < until && !controller.status().ready && !controller.status().errors.MEMORY_WORKER_START_FAILED && !controller.status().errors.MEMORY_WORKER_EXITED) await new Promise(r => setTimeout(r, 100));
  const s = controller.status();
  expect({ ready: s.ready, startFailed: Boolean(s.errors.MEMORY_WORKER_START_FAILED), exited: Boolean(s.errors.MEMORY_WORKER_EXITED) }).toEqual({ ready: true, startFailed: false, exited: false });
}, 60_000);

/** Import one module first in a fresh process and say how it went. */
function importFirst(file: string): Promise<string> {
  const code = `try{await import(${JSON.stringify(pathToFileURL(resolve(file)).href)});console.log("IMPORTED");process.exit(0)}catch(e){console.log("THREW "+String(e&&e.stack||e).split("\\n").slice(0,2).join(" | "));process.exit(0)}`;
  return new Promise(done => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, NODE_ENV: "test", MURAGE_DATA_DIR: mkdtempSync(join(scratch, "d-")) } });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 60_000);
    child.stdout!.on("data", d => { out += d; });
    child.on("exit", () => { clearTimeout(timer); done(out.split("\n").find(l => l.startsWith("IMPORTED") || l.startsWith("THREW")) ?? "NO-ANSWER"); });
  });
}

it("W-CYCLE-SWEEP: every server/memory module imported first in its own process reads no import before it is initialised", async () => {
  const files = readdirSync("server/memory").filter(f => f.endsWith(".ts") && !/\.(test|perf\.test|fixture|d)\.ts$/.test(f)).map(f => `server/memory/${f}`).sort();
  expect(files).toContain("server/memory/worker.ts");
  const results: Array<[string, string]> = [];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < files.length) { const f = files[next++]!; results.push([f, await importFirst(f)]); } }));
  const tdz = results.filter(([, r]) => TDZ.test(r)).map(([f, r]) => `${f}: ${r}`).sort();
  expect(tdz).toEqual([]);
}, 600_000);

it("W-CYCLE-BUNDLE: in the bundled worker (scripts/bundle-server.mjs options), oneindex.ts's HELD SQL holds the checkpoint predicate, never \"undefined\"", async () => {
  // MAIN 2026-11-27T06:28:24Z: a bundle turns the cycle's TDZ throw into CURRENT_CHECKPOINT_SQL === undefined, so HELD read "AND undefined" and every
  // index drain failed ("no such column: undefined", packaged smart-search qualification). A test-only load step appends one line to oneindex.ts in
  // the bundle that reports HELD as that module is evaluated, in the bundle's own order; production code is not changed for it.
  const out = mkdtempSync(join(resolve("server"), ".cycle-bundle-"));
  try {
    await build({ entryPoints: [resolve("server/memory/worker.ts")], bundle: true, platform: "node", target: "node20", format: "esm", outdir: out, logLevel: "silent",
      packages: "external", banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; import { fileURLToPath as __harnessPath } from "node:url"; const require = __harnessRequire(import.meta.url); const __filename = __harnessPath(import.meta.url); const __dirname = __filename.replace(/[\\\\/][^\\\\/]*$/, "");' },
      // The Windows child-process shim stays a file of its own (production rewrites it with windowsHideBundlePlugin); every server module is bundled.
      plugins: [{ name: "held-probe", setup(b) { b.onResolve({ filter: /win-hide-child-process\.(mjs|cjs)$/ }, args => ({ path: resolve(args.resolveDir, args.path), external: true })); b.onLoad({ filter: /[\\/]server[\\/]memory[\\/]oneindex\.ts$/ }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8") + "\n;process.send?.({type:\"held-probe\",held:HELD});\n" })); } }] });
    // The files a bundled module reads from beside itself at load (scripts/bundle-server.mjs RUNTIME_SIBLINGS that the worker inlines).
    for (const file of ["murage-exec", "murage-exec.shapes"]) copyFileSync(resolve("server/drivers", file), join(out, file));
    const permits = fixtureHelperPermits();
    const child = fork(join(out, "worker.js"), [], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...permits.env, ELECTRON_RUN_AS_NODE: "1", MURAGE_DATA_DIR: scratch } });
    permits.attach(child);
    let stderr = "";
    child.stdout!.on("data", () => {}); child.stderr!.on("data", d => { stderr = (stderr + d).slice(-1500); });
    const held = await new Promise<string | null>(done => {
      const timer = setTimeout(() => done(null), 30_000);
      child.on("message", m => { const msg = m as { type?: string; held?: string }; if (msg.type === "held-probe") { clearTimeout(timer); done(String(msg.held)); } });
      child.on("exit", () => { clearTimeout(timer); done(null); });
    });
    child.kill("SIGKILL");
    expect({ probed: held !== null, undefinedInSql: held?.includes("undefined") ?? null, predicate: held?.includes(CURRENT_CHECKPOINT_SQL) ?? null, stderr: held === null ? stderr : "" }).toEqual({ probed: true, undefinedInSql: false, predicate: true, stderr: "" });
  } finally { rmSync(out, { recursive: true, force: true }); }
}, 120_000);
