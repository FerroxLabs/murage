// SPDX-License-Identifier: AGPL-3.0-or-later
// METERDL (1.0.20 blocker): on macOS the server aborted (exited code=6) after about 498 short-lived workers. Each worker made and loaded its own
// private copy of the meter addon, every loaded image held a thread-local key for the life of the process, and the copy that found no key left
// aborted in _tlv_bootstrap_error <- m_read. Only the main thread may make the copy; workers load the main thread's proven file.
// These witnesses run the real compiled addon in a fresh process, and every worker opens SQLite through server/sqlite-open.ts, the same entry the
// per-job workers (inbox-fill, transcript-read, engine-history via counted-fs) use. Linux has no key limit, so the witness counts what causes the
// abort instead: temporary copy folders and distinct addon images mapped into the process.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { METER_COPY_FILE, METER_COPY_MARKER, realCleanupHost, sweepStaleMeterCopies } from "./meter-copy-cleanup.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let root = "", binary = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "meter-workers-")));
  binary = join(root, "engine-exclusion.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
});
afterAll(() => { if (root) removeTempDirSync(root); });

const url = (file: string): string => JSON.stringify(pathToFileURL(resolve(file)).href);

interface Run { mainOk: boolean; mainPath: string | null; workers: number; qualified: number; samePath: number; metered: number; copyDirs: number; images: string[]; mainGrew: boolean; errors: string[] }

/** One fresh process: the main thread loads the meter, then `count` workers (batches of 12) each load it and write a row to their own database. */
function runWorkers(count: number, opts: { tamper?: "sha" | "none" } = {}): Run {
  const tmp = realpathSync(mkdtempSync(join(root, "tmp-")));
  const worker = join(root, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(worker, `import { parentPort, workerData } from "node:worker_threads";
    import { ensureIoMeter, ioMeterNativePath, ioMeterTotal } from ${url("server/io-meter.ts")};
    import { DatabaseSync } from ${url("server/sqlite-open.ts")};
    const db = new DatabaseSync(workerData.file);
    db.exec("CREATE TABLE t(v)"); const before = ioMeterTotal() ?? -1;
    db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(8192)); db.close();
    parentPort.postMessage({ ok: ensureIoMeter(), path: ioMeterNativePath() ?? null, metered: (ioMeterTotal() ?? -1) > before && before >= 0 });`);
  const script = `import { Worker, setEnvironmentData } from "node:worker_threads";
    import { readdirSync, readFileSync } from "node:fs"; import { join } from "node:path";
    import { ensureIoMeter, ioMeterNativePath, ioMeterTotal } from ${url("server/io-meter.ts")};
    const mainOk = ensureIoMeter(), mainPath = ioMeterNativePath() ?? null, start = ioMeterTotal() ?? 0;
    const tamper = ${JSON.stringify(opts.tamper ?? null)};
    // Imported only by the tamper runs, so W1 runs unchanged on a tree without the hand-off and goes RED by its counts.
    const { IO_METER_HANDOFF_KEY } = tamper ? await import(${url("server/engine-exclusion.ts")}) : {};
    if (tamper === "none") setEnvironmentData(IO_METER_HANDOFF_KEY, undefined);
    if (tamper === "sha") { const { getEnvironmentData } = await import("node:worker_threads"); const h = getEnvironmentData(IO_METER_HANDOFF_KEY); setEnvironmentData(IO_METER_HANDOFF_KEY, { ...h, id: { ...h.id, sha256: "0".repeat(64) } }); }
    const out = { mainOk, mainPath, workers: 0, qualified: 0, samePath: 0, metered: 0, errors: [] };
    const one = i => new Promise(done => {
      const w = new Worker(${JSON.stringify(worker)}, { workerData: { file: join(process.env.TMPDIR, "w" + i + ".db") } });
      w.once("message", m => { out.workers++; if (m.ok) out.qualified++; if (m.path && m.path === mainPath) out.samePath++; if (m.metered) out.metered++; });
      w.once("error", e => { if (out.errors.length < 3) out.errors.push(String(e && e.stack).slice(0, 400)); });
      w.once("exit", done);
    });
    for (let i = 0; i < ${count}; i += 12) await Promise.all(Array.from({ length: Math.min(12, ${count} - i) }, (_, k) => one(i + k)));
    out.copyDirs = readdirSync(process.env.TMPDIR).filter(n => n.startsWith("murage-meter-")).length;
    out.images = [...new Set(readFileSync("/proc/self/maps", "utf8").split("\\n").map(l => l.trim().split(/\\s+/).slice(5).join(" ")).filter(p => p.endsWith("/engine-exclusion.node")))];
    out.mainGrew = (ioMeterTotal() ?? 0) > start;
    console.log(JSON.stringify(out));`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: binary, TMPDIR: tmp, MURAGE_DATA_DIR: join(root, "data") };
  for (const key of ["MURAGE_PACKAGED", "MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH"]) delete env[key];
  // A file, not --input-type=module -e: workers inherit execArgv, and Node refuses --input-type for a file worker.
  const main = join(root, `main-${Math.random().toString(36).slice(2)}.mjs`); writeFileSync(main, script);
  const raw = execFileSync(process.execPath, [main], { env, cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 << 20, timeout: 400_000 });
  return JSON.parse(raw.trim().split("\n").at(-1)!) as Run;
}

it.skipIf(process.platform !== "linux")("METERDL-W1: 600 workers in one process load the meter from the main thread's one copy: one temp folder, one addon image", () => {
  const run = runWorkers(600);
  expect(run.errors.join(" | ")).toBe("");
  expect(run.mainOk, "positive control: the main thread qualified the real compiled addon").toBe(true);
  expect(run.workers).toBe(600);
  expect(run.qualified, "every worker is metered (no worker drops to unqualified)").toBe(600);
  expect(run.samePath, "every worker loaded exactly the main thread's private copy").toBe(600);
  expect(run.metered, "each worker's SQLite write went through the shared meter").toBe(600);
  expect(run.mainGrew, "worker writes are visible in the process meter on the main thread").toBe(true);
  expect(run.copyDirs, "one murage-meter-* folder for the whole process, never one per worker").toBe(1);
  expect(run.images, "one addon image mapped (dlopen) for 601 threads: one thread-local key, not 601").toEqual([run.mainPath]);
}, 420_000);

it.skipIf(process.platform !== "linux")("METERDL-W2: a worker with no hand-off, or a hand-off whose bytes do not match, stays unqualified and makes no copy", () => {
  for (const tamper of ["none", "sha"] as const) {
    const run = runWorkers(4, { tamper });
    expect(run.errors.join(" | "), tamper).toBe("");
    expect(run.mainOk, `${tamper}: positive control`).toBe(true);
    expect(run.workers, tamper).toBe(4);
    expect(run.qualified, `${tamper}: fail closed: the worker is unqualified`).toBe(0);
    expect(run.copyDirs, `${tamper}: the worker never makes a copy of its own`).toBe(1);
    expect(run.images, tamper).toEqual([run.mainPath]);
  }
}, 120_000);

it("METERDL-W3: one start removes a backlog of 600 dead folders (one install held 554)", () => {
  const base = realpathSync(mkdtempSync(join(root, "sweep-")));
  for (let i = 0; i < 600; i++) {
    const dir = join(base, `murage-meter-${i.toString(36).padStart(6, "0")}`); mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, METER_COPY_FILE), "x");
    writeFileSync(join(dir, METER_COPY_MARKER), JSON.stringify({ v: 1, pid: 999_999_001 + (i % 7), start: null }));
  }
  const host = { ...realCleanupHost(), alive: (pid: number) => pid === process.pid };
  const removed = sweepStaleMeterCopies([base], null, host);
  expect(removed.length).toBe(600);
  for (let i = 0; i < 600; i += 97) expect(existsSync(join(base, `murage-meter-${i.toString(36).padStart(6, "0")}`))).toBe(false);
});

// METERORDER: the real start order. server/index.ts imports io-copy-bootstrap.ts before any other server module, then boot-progress-start.ts spawns
// the first Worker during module loading, long before the main thread's first metered write. A Worker copies environment data at creation, so a
// worker started before the main thread publishes the hand-off is unmetered for life. This run imports only the bootstrap (no ensureIoMeter call,
// no write) and then starts a worker, as index.ts does.
it.skipIf(process.platform !== "linux")("METERORDER-W4: a worker started right after the server bootstrap import (before any main-thread write) is metered on the main thread's copy", () => {
  const tmp = realpathSync(mkdtempSync(join(root, "tmp-")));
  const worker = join(root, `order-worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(worker, `import { parentPort, workerData } from "node:worker_threads";
    import { ensureIoMeter, ioMeterNativePath, ioMeterTotal } from ${url("server/io-meter.ts")};
    import { DatabaseSync } from ${url("server/sqlite-open.ts")};
    const db = new DatabaseSync(workerData.file); db.exec("CREATE TABLE t(v)"); const before = ioMeterTotal() ?? -1;
    db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(8192)); db.close();
    parentPort.postMessage({ ok: ensureIoMeter(), path: ioMeterNativePath() ?? null, metered: (ioMeterTotal() ?? -1) > before && before >= 0 });`);
  const main = join(root, `order-main-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(main, `import { Worker } from "node:worker_threads"; import { join } from "node:path";
    await import(${url("server/io-copy-bootstrap.ts")});
    const m = await new Promise((done, fail) => { const w = new Worker(${JSON.stringify(worker)}, { workerData: { file: join(process.env.TMPDIR, "o.db") } }); w.once("message", done); w.once("error", fail); });
    const { ensureIoMeter, ioMeterNativePath } = await import(${url("server/io-meter.ts")});
    console.log(JSON.stringify({ ...m, mainOk: ensureIoMeter(), mainPath: ioMeterNativePath() ?? null }));`);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: binary, TMPDIR: tmp, MURAGE_DATA_DIR: join(root, "data-order") };
  for (const key of ["MURAGE_PACKAGED", "MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH"]) delete env[key];
  const raw = execFileSync(process.execPath, [main], { env, cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 << 20, timeout: 100_000 });
  const run = JSON.parse(raw.trim().split("\n").at(-1)!) as { ok: boolean; path: string | null; metered: boolean; mainOk: boolean; mainPath: string | null };
  expect(run.mainOk, "positive control: the main thread qualified the real compiled addon").toBe(true);
  expect(run.ok, "the early worker is metered, not left unqualified").toBe(true);
  expect(run.path, "the early worker loaded the main thread's private copy").toBe(run.mainPath);
  expect(run.metered, "the early worker's SQLite write went through the meter").toBe(true);
}, 120_000);

it("METERORDER-W5: server/index.ts imports io-copy-bootstrap before every other server module, so the hand-off precedes the first worker", () => {
  const source = readFileSync(resolve("server/index.ts"), "utf8");
  const local = [...source.matchAll(/^import\s[^;]*?["'](\.\/[^"']+)["'];?/gm)].map(m => m[1]);
  expect(local[0]).toBe("./io-copy-bootstrap.ts");
  expect(local.indexOf("./boot-progress-start.ts")).toBeGreaterThan(0);
});
