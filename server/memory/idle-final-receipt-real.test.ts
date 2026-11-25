// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness and exit protocol owners: idle-r2-sol. Memory index and grant owners: scperf-p1. Ruling owner: MAIN.
import { execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdtempSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { ioBudget } from "../io-budget.ts";
import { ioMeterTotal, resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { writeTinyModel } from "./tiny-model-fixture.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

type Message = Record<string, unknown>;
type Event = { direction: "in" | "out"; at: number; message: Message };
type Run = {
  child: ChildProcess;
  events: Event[];
  exited?: { code: number | null; signal: string | null; at: number };
};
const fixture = vi.hoisted(() => ({
  preload: "", children: [] as Run[], wasm: false, library: "",
  beforeReceive: undefined as ((message: Message) => void) | undefined,
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fork = ((file: string, args: string[], options: import("node:child_process").ForkOptions) => {
    const child = actual.fork(file, args, {
      ...options,
      execArgv: [...(options.execArgv ?? []), "--import", `data:text/javascript,${encodeURIComponent(fixture.preload)}`],
      env: { ...options.env, ...(fixture.wasm ? { MURAGE_MEMORY_BACKEND: "wasm" } : {}),
        ...(fixture.library ? { LD_PRELOAD: fixture.library } : {}) },
    });
    const run: Run = { child, events: [] };
    fixture.children.push(run);
    child.on("message", (message: Message) => {
      run.events.push({ direction: "in", at: Date.now(), message });
      fixture.beforeReceive?.(message);
    });
    child.once("exit", (code, signal) => { run.exited = { code, signal, at: Date.now() }; });
    child.send = new Proxy(child.send, { apply(send, receiver, args) {
      run.events.push({ direction: "out", at: Date.now(), message: args[0] });
      return Reflect.apply(send, receiver, args);
    } });
    return child;
  }) as unknown as typeof actual.fork;
  return { ...actual, fork };
});

const root = mkdtempSync(join(tmpdir(), "idle-final-receipt-"));
const dbFile = join(DATA_DIR, "memory-index.db");
const modelDirectory = join(root, "model");
const previousMeter = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
const realRead = Reflect.get(ioBudget, "read");
const realAdmissionRead = Reflect.get(ioBudget, "admissionRead");
let live: MemoryWorkerController | undefined;
let manifest: ReturnType<typeof writeTinyModel>;
let idle = false;
let foregroundBytes = 0;
let clockOffset = 10_000;

beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9",
    "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;
  forgetExclusionAddon();
  resetIoMeterForTest();
  manifest = writeTinyModel(modelDirectory);
});
beforeEach(async () => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture");
  await stopWalMaintenance();
  await stopSearchIndex();
  const started = performance.now();
  const read = () => ({ at: clockOffset + Math.round(performance.now() - started), fsWriteBlocks: foregroundBytes / 512, cpuMicros: 0,
    // Admission reads the write meter only (memv2-D B1/I8: no OS counter): the fixture's foreground write is reported there too.
    meterBytes: foregroundBytes });
  Reflect.set(ioBudget, "read", read);
  Reflect.set(ioBudget, "admissionRead", read);
  idle = false;
  foregroundBytes = 0;
  clockOffset = 10_000;
  ioBudget.resetAdmissionForFixture();
  ioBudget.setIsIdle(() => idle);
  fixture.children.length = 0;
  fixture.preload = "";
  fixture.wasm = false;
  fixture.library = "";
  fixture.beforeReceive = undefined;
  forgetExclusionAddon();
  resetIoMeterForTest();
});
afterEach(async () => {
  const children = fixture.children.filter(run => !run.exited);
  await Promise.all(children.map(run => new Promise<void>(resolve => {
    run.child.once("exit", () => resolve());
    run.child.kill("SIGKILL");
  })));
  await live?.stop();
  live = undefined;
  closeDatabase();
  Reflect.set(ioBudget, "read", realRead);
  Reflect.set(ioBudget, "admissionRead", realAdmissionRead);
  ioBudget.setIsIdle(() => false);
  ioBudget.resetAdmissionForFixture();
});
afterAll(() => {
  if (previousMeter === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;
  else process.env.MURAGE_ENGINE_EXCLUSION_PATH = previousMeter;
  forgetExclusionAddon();
  resetIoMeterForTest();
  removeTempDirSync(root);
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = (assertion: () => void, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 25 });
const say = (id: number, text = `Remember fixture backup preference ${id}.`) => appendMessage("fixture-thread", {
  id: `fixture-message-${id}`, at: id + 1, role: "user", kind: "text", text,
});
const status = () => database().prepare("SELECT status FROM memory_jobs ORDER BY rowid").all().map(job => job.status);
const event = (run: Run, direction: Event["direction"], type: string) => run.events.find(e => e.direction === direction && e.message.type === type);
const accepted = (controller: MemoryWorkerController) => Reflect.get(controller, "childIo") as {
  receipts: { final: boolean; negotiated: boolean; bytes: number; blocks: number }; last?: string;
};
const meter = () => ioMeterTotal() !== null;
const failures = (controller: MemoryWorkerController) => ({
  initFailures: Reflect.get(controller, "initFailures"), respawnAt: Reflect.get(controller, "respawnAt"),
});
const formatTrace = (events: Event[]) => JSON.stringify(events.map(({ direction, at, message }) => ({
  direction, at: at - (events[0]?.at ?? at), type: message.type, purpose: message.purpose, outcome: message.outcome,
  ceiling: message.ceiling, bytes: message.type === "charge" ? message.bytes : undefined,
  granted: message.granted ?? (message.type === "bg-grant" ? message.ticket !== null : undefined),
})));
const diagnostics = (run: Run) => formatTrace(run.events.slice(-40));
function start(options: { idleStart?: boolean; wasm?: boolean; preload: string }) {
  idle = options.idleStart === true;
  fixture.wasm = options.wasm === true;
  fixture.preload = options.preload;
  say(0);
  expect(meter()).toBe(true);
  live = new MemoryWorkerController({ startHoldMs: 0, modelDirectory, manifest, wasmIdleExitMs: 3_000 });
  live.start();
  return live;
}
async function firstRun() {
  await waitFor(() => expect(fixture.children).toHaveLength(1));
  return fixture.children[0]!;
}
async function indexed(run: Run) {
  await waitFor(() => {
    expect(status(), diagnostics(run)).toEqual(["complete"]);
    expect(event(run, "in", "index-result"), diagnostics(run)).toBeDefined();
  });
}
async function beginCheckpoint(controller: MemoryWorkerController, run: Run, marker: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const checkpoint = controller.requestCheckpoint();
    await Promise.race([checkpoint, waitFor(() => expect(existsSync(marker)).toBe(true), 1_000).catch(() => {})]);
    if (existsSync(marker)) return;
    await checkpoint;
    await sleep(25);
  }
  expect(existsSync(marker), diagnostics(run)).toBe(true);
}
function writePressure(bytes: Buffer) {
  ioBudget.admissionState();
  const before = process.resourceUsage().fsWrite;
  const fd = openSync(join(root, "foreground-pressure"), "w");
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  foregroundBytes += (process.resourceUsage().fsWrite - before) * 512;
}
async function noGrant(controller: MemoryWorkerController) {
  idle = true;
  await waitFor(() => expect(Reflect.get(controller, "helperGrants").size).toBe(0));
}
function indexText() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { return db.prepare("SELECT text FROM entries ORDER BY id").all().map(row => String(row.text)); }
  finally { db.close(); }
}
const preload = (source: string) => `
  import { existsSync, writeFileSync, writeSync } from "node:fs";
  import { MemoryIndex } from ${JSON.stringify(pathToFileURL(resolve("server/memory/index.ts")).href)};
  import { IndexWalWriter, walTestHooks } from ${JSON.stringify(pathToFileURL(resolve("server/memory/index-wal.ts")).href)};
  import { MemoryEmbeddings } from ${JSON.stringify(pathToFileURL(resolve("server/memory/embeddings.ts")).href)};
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const block = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const prepare = MemoryIndex.prototype.prepareExit;
  let sealing = false;
  MemoryIndex.prototype.prepareExit = async function () {
    sealing = true;
    try { return await prepare.call(this); }
    finally { sealing = false; }
  };
  ${source}
`;
const sameReceipt = (controller: MemoryWorkerController, io: ReturnType<typeof accepted>, run: Run) => ({
  code: run.exited?.code,
  signal: run.exited?.signal,
  final: io.receipts.final,
  meter: meter(),
  ...failures(controller),
});
const finalExit = { code: 0, signal: null, final: true, meter: true, initFailures: 0, respawnAt: 0 };

it("W2 stop: wait for a real synchronous index checkpoint that crosses the quiet window", async () => {
  const marker = join(DATA_DIR, "checkpoint-entered");
  const controller = start({ preload: preload(`
    let normalCheckpoint = false;
    process.on("message", message => { if (message.type === "checkpoint") normalCheckpoint = true; });
    walTestHooks.checkpoint = (db, mode) => {
      if (normalCheckpoint && mode === "PASSIVE" && !globalThis.delayed) {
        globalThis.delayed = true;
        writeFileSync(${JSON.stringify(marker)}, "");
        block(40_000);
      }
      return db.prepare("PRAGMA wal_checkpoint(" + mode + ")").get();
    };
  `) });
  const run = await firstRun();
  await indexed(run);
  const io = accepted(controller);
  await beginCheckpoint(controller, run, marker);
  const began = Date.now();
  const stopped = controller.stop();
  await waitFor(() => expect(run.exited).toBeDefined(), 55_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect({ entered: existsSync(marker), waited: run.exited!.at - began >= 39_000 }).toEqual({ entered: true, waited: true });
  expect(indexText().join(" ")).toContain("fixture backup preference 0");
  await stopped;
}, 110_000);

const hangExit = preload(`
  const exit = process.exit;
  process.exit = code => {
    if (code === 0) { setInterval(() => {}, 1000); return; }
    exit.call(process, code);
  };
`);

it.each(["ladder", "stop"] as const)("W10 %s: the controller releases a worker that hangs after FINAL", async (entry) => {
  const controller = start({ preload: hangExit, idleStart: entry === "ladder" });
  const run = await firstRun();
  if (entry === "ladder") {
    await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
    expect(status()).toEqual(["complete"]);
  } else await indexed(run);
  const io = accepted(controller);
  const stopped = entry === "stop" ? controller.stop() : undefined;
  await waitFor(() => expect(io.receipts.final, diagnostics(run)).toBe(true));
  const ack = event(run, "out", "io-final-ack")!;
  await waitFor(() => expect(run.exited?.signal, diagnostics(run)).toBe("SIGKILL"), 8_000);
  expect(run.exited!.at - ack.at).toBeGreaterThanOrEqual(4_950);
  expect(run.exited!.at - ack.at).toBeLessThan(6_500);
  expect(sameReceipt(controller, io, run)).toEqual({ ...finalExit, code: null, signal: "SIGKILL" });
  if (entry === "stop") expect(indexText().join(" ")).toContain("fixture backup preference 0");
  else {
    expect(statSync(dbFile + "-wal").size).toBe(0);
    fixture.preload = "";
    say(1);
    await waitFor(() => expect(status()).toEqual(["complete", "complete"]), 65_000);
    expect(fixture.children.length).toBeGreaterThan(1);
  }
  await stopped;
}, 125_000);

async function dirtyIdleStart(delaySeal = 0, extra = "") {
  clockOffset = 53_000;
  ioBudget.resetAdmissionForFixture();
  const controller = start({ idleStart: true, preload: preload(`
    const charge = IndexWalWriter.prototype.chargeBeforeAttempt;
    let delayed = false, delayedOpen = false;
    IndexWalWriter.prototype.chargeBeforeAttempt = async function (bytes) {
      if (!sealing && bytes > 0 && !delayedOpen) { delayedOpen = true; await wait(8_000); }
      if (${delaySeal} && sealing && !delayed) {
        delayed = true;
        await wait(${delaySeal});
      }
      return charge.call(this, bytes);
    };
    ${extra}
  `) });
  let switched = false;
  fixture.beforeReceive = message => {
    if (message.type === "ready") idle = false;
    if (message.type === "charge" && message.opening === true && Number(message.bytes) > 0 && !switched) {
      switched = true;
      writePressure(Buffer.alloc(1024 * 1024, 1));
      idle = true;
    }
  };
  const run = await firstRun();
  await waitFor(() => expect(status()).toEqual(["complete"]));
  await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
  const asked = event(run, "out", "idle-exit")!;
  const io = accepted(controller);
  expect(statSync(dbFile + "-wal").size).toBeGreaterThan(0);
  expect(run.events.some(e => e.direction === "out" && e.message.type === "bg-grant" && e.message.ticket === null)).toBe(true);
  fixture.beforeReceive = undefined;
  return { controller, run, asked, io };
}

it("W1b ladder: a controller-initiated exit seal completes after the ladder's quiet window", async () => {
  const { controller, run, asked, io } = await dirtyIdleStart(180_000);
  fixture.preload = "";
  idle = false;
  say(1);
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 216_000);
  console.log("[W1b production IPC]", formatTrace(run.events));
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  const stop = event(run, "out", "io-stop")!;
  const receipt = run.events.find(e => e.direction === "in" && e.message.final === true)!;
  expect({
    neededForStartWindow: Boolean(stop && stop.at - asked.at >= 119_000),
    sealPassedQuiet: Boolean(stop && receipt.at - stop.at >= 59_000),
    outcome: receipt.message.outcome,
    acceptedBytes: io.receipts.bytes,
    acknowledged: Boolean(event(run, "out", "io-final-ack")),
    sealCharged: run.events.some(e => e.direction === "out" && (e.message.ticket as Message | undefined)?.purpose === "exit-seal"),
    walBytes: statSync(dbFile + "-wal", { throwIfNoEntry: false })?.size ?? 0,
  }).toEqual({
    neededForStartWindow: true, sealPassedQuiet: true, outcome: "sealed",
    acceptedBytes: receipt.message.ioBytes, acknowledged: true, sealCharged: true, walBytes: 0,
  });
  expect(io.last).toBe("sealed");
  const reopened = new DatabaseSync(dbFile, { readOnly: true });
  try { expect(reopened.prepare("SELECT value FROM index_meta WHERE key='wal_check'").get()).toBeDefined(); }
  finally { reopened.close(); }
  await waitFor(() => expect(status()).toEqual(["complete", "complete"]), 65_000);
  expect(fixture.children.length).toBeGreaterThan(1);
}, 310_000);

it("W1c stop: beats keep a real batch in its model stage beyond the quiet window", async () => {
  const marker = join(DATA_DIR, "model-entered");
  const controller = start({ preload: preload(`
    const embed = MemoryEmbeddings.prototype.embed;
    MemoryEmbeddings.prototype.embed = async function (...args) {
      writeFileSync(${JSON.stringify(marker)}, "");
      await wait(45_000);
      return embed.apply(this, args);
    };
  `) });
  const run = await firstRun();
  await waitFor(() => expect(existsSync(marker), diagnostics(run)).toBe(true));
  const io = accepted(controller);
  expect(Reflect.get(controller, "helperGrants").size, diagnostics(run)).toBe(0);
  const began = Date.now();
  const stopped = controller.stop();
  await waitFor(() => expect(run.exited).toBeDefined(), 60_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect(run.exited!.at - began).toBeGreaterThan(43_000);
  expect(run.events.filter(e => e.direction === "in" && e.message.type === "io-closing" && e.message.write === false).length).toBeGreaterThan(10);
  expect(indexText().join(" ")).toContain("fixture backup preference 0");
  await stopped;
}, 105_000);

it("W4 stop: a real grant request delivered as stop begins receives a refusal", async () => {
  let stopping: Promise<void> | undefined, io: ReturnType<typeof accepted> | undefined;
  const controller = start({ preload: "" });
  fixture.beforeReceive = message => {
    if (message.type !== "bg-grant-request" || message.purpose === "exit-seal" || stopping) return;
    io = accepted(controller);
    stopping = controller.stop();
  };
  const run = await firstRun();
  await waitFor(() => expect(event(run, "out", "io-stop"), diagnostics(run)).toBeDefined());
  const stop = event(run, "out", "io-stop")!;
  const request = event(run, "in", "bg-grant-request")!;
  const refusal = () => run.events.find(e => e.direction === "out" && e.message.type === "bg-grant" && e.at >= stop.at && e.at >= request.at);
  await waitFor(() => expect(refusal()?.message.ticket, diagnostics(run)).toBeNull(), 3_000);
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined());
  expect(sameReceipt(controller, io!, run), diagnostics(run)).toEqual(finalExit);
  await stopping;
}, 55_000);

const stalledBeforeSeal = (source: string) => preload(`
  MemoryIndex.prototype.prepareExit = async function () { ${source} return prepare.call(this); };
`);

it("W5 stop: a quiet worker without an open grant is killed after five seconds", async () => {
  const controller = start({ preload: stalledBeforeSeal("block(180_000);") });
  const run = await firstRun();
  await indexed(run);
  await noGrant(controller);
  const io = accepted(controller);
  expect(Reflect.get(controller, "helperGrants").size).toBe(0);
  const began = Date.now();
  const stopped = controller.stop();
  await waitFor(() => expect(run.exited?.signal, diagnostics(run)).toBe("SIGKILL"), 9_000);
  expect(sameReceipt(controller, io, run)).toEqual({
    code: null, signal: "SIGKILL", final: false, meter: false, initFailures: 1, respawnAt: expect.any(Number),
  });
  expect(run.exited!.at - began).toBeGreaterThanOrEqual(4_950);
  expect(run.exited!.at - began).toBeLessThan(7_000);
  expect(Number(Reflect.get(controller, "respawnAt")) - run.exited!.at).toBeGreaterThanOrEqual(29_950);
  await stopped;
}, 65_000);

it.each([
  ["beats", "await wait(165_000);"],
  ["stdout", 'for (let i = 0; i < 83; i++) { writeSync(1, "fixture still running\\n"); block(2_000); }'],
] as const)("W6 stop: %s without progress ends at the stall bound", async (_kind, stall) => {
  const controller = start({ preload: stalledBeforeSeal(stall) });
  const run = await firstRun();
  await indexed(run);
  const io = accepted(controller);
  const began = Date.now();
  const stopped = controller.stop();
  await sleep(115_000);
  expect(run.exited, diagnostics(run)).toBeUndefined();
  await waitFor(() => expect(run.exited?.signal, diagnostics(run)).toBe("SIGKILL"), 10_000);
  expect(run.exited!.at - began).toBeGreaterThanOrEqual(119_950);
  expect(run.exited!.at - began).toBeLessThan(125_000);
  expect(sameReceipt(controller, io, run)).toEqual({
    code: null, signal: "SIGKILL", final: false, meter: false, initFailures: 1, respawnAt: expect.any(Number),
  });
  await stopped;
}, 180_000);

function slowCheckpointLibrary(marker: string) {
  const source = join(root, "slow-checkpoint.c");
  const library = join(root, "slow-checkpoint.so");
  writeFileSync(source, `
    #define _GNU_SOURCE
    #include <dlfcn.h>
    #include <errno.h>
    #include <stdio.h>
    #include <string.h>
    #include <sys/types.h>
    #include <time.h>
    #include <unistd.h>

    static unsigned int slowed;
    static void pause_page(int fd) {
      const char *suffix = "/memory-index.db";
      if (slowed >= 5 || access(${JSON.stringify(marker)}, F_OK) != 0) return;
      char link[64], path[4096];
      snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
      ssize_t n = readlink(link, path, sizeof(path) - 1);
      size_t length = strlen(suffix);
      if (n < (ssize_t)length || memcmp(path + n - length, suffix, length) != 0) return;
      ++slowed;
      struct timespec wait = { 40, 0 };
      while (nanosleep(&wait, &wait) == -1 && errno == EINTR) {}
    }
    ssize_t pwrite(int fd, const void *buf, size_t n, off_t offset) {
      ssize_t (*next)(int, const void *, size_t, off_t) = dlsym(RTLD_NEXT, "pwrite");
      ssize_t result = next(fd, buf, n, offset);
      if (result > 0) pause_page(fd);
      return result;
    }
    ssize_t pwrite64(int fd, const void *buf, size_t n, off64_t offset) {
      ssize_t (*next)(int, const void *, size_t, off64_t) = dlsym(RTLD_NEXT, "pwrite64");
      ssize_t result = next(fd, buf, n, offset);
      if (result > 0) pause_page(fd);
      return result;
    }
  `);
  execFileSync("cc", ["-Wall", "-Werror", "-O2", "-fPIC", "-shared", source, "-ldl", "-o", library], { stdio: "pipe" });
  return library;
}

it.skipIf(process.platform !== "linux")("W8 stop: a synchronous checkpoint makes disk progress past 120 seconds", async () => {
  const marker = join(DATA_DIR, "inside-checkpoint");
  const armed = join(DATA_DIR, "arm-slow-checkpoint");
  fixture.library = slowCheckpointLibrary(marker);
  const controller = start({ preload: preload(`
    walTestHooks.checkpoint = (db, mode) => {
      if (existsSync(${JSON.stringify(armed)}) && mode === "PASSIVE" && !globalThis.delayed) {
        globalThis.delayed = true;
        writeFileSync(${JSON.stringify(marker)}, "");
      }
      return db.prepare("PRAGMA wal_checkpoint(" + mode + ")").get();
    };
  `) });
  const run = await firstRun();
  await indexed(run);
  const reader = new DatabaseSync(dbFile, { readOnly: true });
  let closed = false;
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM entries").get();
    fixture.beforeReceive = message => {
      if (closed || message.type !== "charge" || Number(message.bytes) < 32 * 1024) return;
      reader.exec("ROLLBACK");
      reader.close();
      closed = true;
      writeFileSync(armed, "");
    };
    const payload = Array.from({ length: 950 }, (_, i) => `fixture checkpoint token ${i}`).join(" ");
    say(1, payload);
    await waitFor(() => expect(existsSync(marker), diagnostics(run)).toBe(true));
  } finally {
    if (!closed) reader.close();
    fixture.beforeReceive = undefined;
  }
  const io = accepted(controller);
  const began = Date.now();
  const stopped = controller.stop();
  const firstWrite = statSync(dbFile, { bigint: true }).mtimeNs;
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 230_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect(run.exited!.at - began).toBeGreaterThanOrEqual(198_000);
  expect(statSync(dbFile, { bigint: true }).mtimeNs).toBeGreaterThan(firstWrite);
  const final = run.events.find(e => e.direction === "in" && e.message.final === true)!;
  expect(["clean", "sealed"]).toContain(final.message.outcome);
  expect(indexText().join(" ")).toContain("fixture backup preference 0");
  await stopped;
}, 280_000);

it("W3 ladder: a synchronous worker's 200 KiB of stdout keep it alive through the quiet window", async () => {
  const controller = start({ idleStart: true, preload: stalledBeforeSeal(`
    block(119_000);
    for (let i = 0; i < 20; i++) {
      writeSync(1, "fixture checkpoint pause " + "x".repeat(10 * 1024) + "\\n");
      block(2_000);
    }
  `) });
  const run = await firstRun();
  await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
  const io = accepted(controller);
  say(1);
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 175_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  const stop = event(run, "out", "io-stop");
  expect(stop).toBeDefined();
  expect(run.exited!.at - stop!.at).toBeGreaterThan(37_000);
  expect(status()[0]).toBe("complete");
}, 245_000);

it("W5 ladder: a silent worker is killed thirty seconds after its last stdout word", async () => {
  const controller = start({ idleStart: true, preload: stalledBeforeSeal(`
    block(140_000);
    writeSync(1, "fixture final word\\n");
    block(90_000);
  `) });
  const run = await firstRun();
  let wordAt = 0;
  run.child.stdout?.on("data", () => { wordAt = Date.now(); });
  await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
  fixture.preload = "";
  const io = accepted(controller);
  say(1);
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 185_000);
  const stop = event(run, "out", "io-stop");
  expect({ signal: run.exited?.signal, final: io.receipts.final, meter: meter(), failures: failures(controller).initFailures }).toEqual({
    signal: "SIGKILL", final: false, meter: false, failures: 1,
  });
  expect(wordAt - (stop?.at ?? 0)).toBeGreaterThan(18_000);
  expect(run.exited!.at - wordAt).toBeGreaterThanOrEqual(29_950);
  expect(run.exited!.at - wordAt).toBeLessThan(32_000);
  await waitFor(() => expect(status()).toEqual(["complete", "complete"]), 70_000);
  expect(fixture.children.length).toBeGreaterThan(1);
}, 290_000);

it.each([10, 1_000])("W7 T%i: a late clean idle exit writes no index frame and rest starts at exit", async (threads) => {
  for (let i = 0; i < threads; i++) {
    appendMessage(`history-${i}`, { id: `history-message-${i}`, at: i + 1, role: "user", kind: "text", text: `History entry ${i}` });
  }
  database().prepare("DELETE FROM memory_jobs").run();
  ioBudget.resetAdmissionForFixture();
  const controller = start({ idleStart: true, preload: stalledBeforeSeal("await wait(70_000);") });
  const run = await firstRun();
  await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
  const io = accepted(controller);
  const before = [dbFile, dbFile + "-wal"].map(path => statSync(path, { bigint: true, throwIfNoEntry: false }));
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 90_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  const final = run.events.find(e => e.direction === "in" && e.message.final === true)!;
  expect(final.message.outcome).toBe("clean");
  expect(io.last).toBe("clean");
  expect(run.exited!.at - event(run, "out", "idle-exit")!.at).toBeGreaterThanOrEqual(69_950);
  expect([dbFile, dbFile + "-wal"].map(path => statSync(path, { bigint: true, throwIfNoEntry: false })).map(stat => [stat?.size, stat?.mtimeNs]))
    .toEqual(before.map(stat => [stat?.size, stat?.mtimeNs]));
  const rest = Reflect.get(controller, "idleRestUntil");
  expect(rest - run.exited!.at).toBeGreaterThanOrEqual(29_950);
  expect(rest - run.exited!.at).toBeLessThan(30_100);
  fixture.preload = "";
  say(1);
  await waitFor(() => expect(status()).toEqual(["complete", "complete"]), 75_000);
  expect(fixture.children[1]!.events[0]!.at).toBeGreaterThanOrEqual(rest);
}, 210_000);

it("W9b stop: a dirty log whose seal grant is refused reports unknown without a failed start", async () => {
  const controller = start({ preload: "" });
  const run = await firstRun();
  await indexed(run);
  await noGrant(controller);
  idle = false;
  const io = accepted(controller);
  const bytes = Buffer.alloc(50 * 1024 * 1024, 1);
  let asks = 0;
  fixture.beforeReceive = message => {
    if (message.type !== "bg-grant-request" || message.purpose !== "exit-seal") return;
    writePressure(bytes);
    asks++;
  };
  const stopped = controller.stop();
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 85_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual({ ...finalExit, final: false, meter: false });
  expect({ asks, last: io.last, wal: statSync(dbFile + "-wal").size > 0 }).toEqual({ asks: 2, last: "unsealed:grant", wal: true });
  expect(indexText().join(" ")).toContain("fixture backup preference 0");
  await stopped;
}, 140_000);

it("W4 batch: stop answers the vector write's real grant request already in transit", async () => {
  const embedded = join(DATA_DIR, "batch-embedded");
  let stopping: Promise<void> | undefined, io: ReturnType<typeof accepted> | undefined;
  const controller = start({ preload: preload(`
    const embed = MemoryEmbeddings.prototype.embed;
    MemoryEmbeddings.prototype.embed = async function (...args) {
      const result = await embed.apply(this, args);
      writeFileSync(${JSON.stringify(embedded)}, "");
      return result;
    };
  `) });
  const run = await firstRun();
  fixture.beforeReceive = message => {
    if (message.type !== "bg-grant-request" || message.purpose !== "bg" || stopping || !existsSync(embedded)) return;
    io = accepted(controller);
    stopping = controller.stop();
  };
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined());
  expect(stopping, diagnostics(run)).toBeDefined();
  const stop = event(run, "out", "io-stop")!;
  const batch = event(run, "out", "index")!;
  const answer = run.events.find(e => e.direction === "out" && e.message.type === "bg-grant" && e.at >= stop.at && e.message.ticket === null);
  expect({ result: sameReceipt(controller, io!, run), answered: Boolean(answer), batchWasInFlight: batch.at < stop.at }).toEqual({
    result: finalExit, answered: true, batchWasInFlight: true,
  });
  expect(indexText().join(" ")).toContain("fixture backup preference 0");
  await stopping;
}, 55_000);


it("W9a ladder: an unneeded idle slot retries its refused exit seal at the next admission", async () => {
  const { controller, run, io } = await dirtyIdleStart();
  await waitFor(() => {
    expect(run.events.some(e => e.direction === "in" && e.message.type === "bg-grant-request" && e.message.purpose === "exit-seal")).toBe(true);
    const seal = run.events.findIndex(e => e.direction === "in" && e.message.purpose === "exit-seal");
    expect(run.events.slice(seal + 1).find(e => e.direction === "out" && e.message.type === "bg-grant")?.message.ticket).toBeNull();
  });
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 75_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect(io.last).toBe("sealed");
  expect(ioBudget.admissionIdle()).toBe(true);
  expect(event(run, "out", "io-stop")).toBeUndefined();
  expect(statSync(dbFile + "-wal").size).toBe(0);
  expect(run.events.some(e => e.direction === "out" && (e.message.ticket as Message | undefined)?.purpose === "exit-seal")).toBe(true);
}, 145_000);

it("W11 stop: io-stop during a real in-flight index open waits for the open's held check and seals FINAL after it", async () => {
  const entered = join(DATA_DIR, "open-entered"), left = join(DATA_DIR, "open-left");
  const controller = start({ preload: preload(`
    let held = false;
    walTestHooks.afterFirstOpenTxn = () => { held = true; };
    const check = IndexWalWriter.prototype.check;
    IndexWalWriter.prototype.check = async function (...args) {
      if (!held || globalThis.openHeld) return check.apply(this, args);
      globalThis.openHeld = true;
      writeFileSync(${JSON.stringify(entered)}, "");
      await wait(12_000);
      try { return await check.apply(this, args); }
      finally { writeFileSync(${JSON.stringify(left)}, String(Date.now())); }
    };
  `) });
  const run = await firstRun();
  await waitFor(() => expect(existsSync(entered), diagnostics(run)).toBe(true));
  const io = accepted(controller);
  const began = Date.now();
  const stopped = controller.stop();
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 60_000);
  const receipt = run.events.find(e => e.direction === "in" && e.message.final === true);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect({
    heldWriteSettled: existsSync(left),
    receiptAfterHeldWrite: Boolean(receipt && existsSync(left) && receipt.at >= Number(readFileSync(left, "utf8"))),
    stopWasDuringHold: existsSync(left) && Number(readFileSync(left, "utf8")) - began >= 5_000,
    outcome: receipt?.message.outcome,
  }, diagnostics(run)).toEqual({ heldWriteSettled: true, receiptAfterHeldWrite: true, stopWasDuringHold: true, outcome: "sealed" });
  await stopped;
}, 100_000);

// Ladder cells (design rows W2 and W6). Every ladder row enters through MemoryWorkerController.start(), the idle ask and
// the ladder's own closeChild: the fixture sends nothing and only reads the IPC it taps.
const admission = `import { helperHasGrant, withHelperGrant } from ${JSON.stringify(pathToFileURL(resolve("server/memory/helper-admission.ts")).href)};`;
const grantedStep = (marker: string, body: string) => stalledBeforeSeal(`
  await wait(110_000);
  const until = Date.now() + 20_000;
  while (!helperHasGrant(1024 * 1024) && Date.now() < until) await wait(50);
  withHelperGrant(1024 * 1024, () => { writeFileSync(${JSON.stringify(marker)}, ""); ${body} });
`) + admission;
async function ladderStop(run: Run, busy = false) {
  await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
  fixture.preload = ""; if (busy) idle = false;
  say(1);
  await waitFor(() => expect(event(run, "out", "io-stop"), diagnostics(run)).toBeDefined(), 150_000);
  return event(run, "out", "io-stop")!;
}

it("W2 ladder: a synchronous step blocked under a real open grant outlives the ladder's quiet window", async () => {
  const marker = join(DATA_DIR, "granted-step-entered");
  const controller = start({ idleStart: true, preload: grantedStep(marker, "block(65_000);") });
  const run = await firstRun();
  const stop = await ladderStop(run, true);
  const io = accepted(controller);
  expect({ entered: existsSync(marker), grants: Reflect.get(controller, "helperGrants").size > 0, alive: run.exited === undefined }, diagnostics(run))
    .toEqual({ entered: true, grants: true, alive: true });
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 90_000);
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect(run.exited!.at - stop.at).toBeGreaterThan(35_000);
}, 300_000);

it.each([
  ["beats", "await wait(290_000);"],
  ["stdout", 'for (let i = 0; i < 145; i++) { writeSync(1, "fixture still running\\n"); block(2_000); }'],
] as const)("W6 ladder: %s without progress ends at the stall bound", async (_kind, stall) => {
  const controller = start({ idleStart: true, preload: stalledBeforeSeal(stall) });
  const run = await firstRun();
  const stop = await ladderStop(run);
  const io = accepted(controller);
  await sleep(Math.max(0, stop.at + 115_000 - Date.now()));
  expect(run.exited, diagnostics(run)).toBeUndefined();
  await waitFor(() => expect(run.exited?.signal, diagnostics(run)).toBe("SIGKILL"), 12_000);
  expect(run.exited!.at - stop.at).toBeGreaterThanOrEqual(119_950);
  expect(run.exited!.at - stop.at).toBeLessThan(126_000);
  expect({ final: io.receipts.final, meter: meter(), failures: failures(controller).initFailures }).toEqual({ final: false, meter: false, failures: 1 });
}, 330_000);
it("W1a stop: a real async index batch write paused 10 s per slice for 150 s, one granted page charge per slice, finishes with FINAL and no kill", async () => {
  const armed = join(DATA_DIR, "arm-slow-write");
  const writing = join(DATA_DIR, "slow-write-entered");
  const settled = join(DATA_DIR, "pool-settled-before-write");
  // Forced ordering (MAIN-RULING 2026-11-23T08:02:31Z; fixture owner: idle-w1a-fable, grant owners: scperf-p1): the batch sent before
  // io-stop is held in its 15 charged slices, then the pool it was sent under is settled BEFORE its write asks. The write's own ask is
  // therefore always made by a stopping helper; no run can finish the write inside the earlier pool.
  const controller = start({ preload: preload(`
    const charge = IndexWalWriter.prototype.chargeBeforeAttempt;
    let writer, paused = false;
    IndexWalWriter.prototype.chargeBeforeAttempt = function (bytes) { writer = this; return charge.call(this, bytes); };
    const applyBatch = MemoryIndex.prototype.applyBatch;
    MemoryIndex.prototype.applyBatch = async function (...args) {
      if (!paused && existsSync(${JSON.stringify(armed)})) {
        paused = true;
        writeFileSync(${JSON.stringify(writing)}, String(Date.now()));
        for (let slice = 0; slice < 15; slice++) {
          await wait(10_000);
          if (!(await charge.call(writer, 4096))) break;
        }
        stopHelperAdmission();
        writeFileSync(${JSON.stringify(settled)}, "");
      }
      return applyBatch.apply(this, args);
    };
  `) + `import { stopHelperAdmission } from ${JSON.stringify(pathToFileURL(resolve("server/memory/helper-admission.ts")).href)};` });
  const run = await firstRun();
  await indexed(run);
  writeFileSync(armed, "");
  say(1);
  await waitFor(() => expect(existsSync(writing), diagnostics(run)).toBe(true), 60_000);
  const io = accepted(controller);
  const began = Date.now();
  const stopped = controller.stop();
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 200_000);
  console.log("[W1a production IPC]", formatTrace(run.events));
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  expect({ midWrite: began - Number(readFileSync(writing, "utf8")) < 30_000, waited: run.exited!.at - began >= 115_000 }).toEqual({ midWrite: true, waited: true });
  // The forced ordering really ran: the pool the batch was sent under was settled while stopping, before the batch's write.
  const stop = run.events.findIndex(e => e.direction === "out" && e.message.type === "io-stop");
  const pool = run.events.findIndex((e, at) => at > stop && e.direction === "in" && e.message.type === "bg-grant-settle");
  expect({ settled: existsSync(settled), stopSent: stop > 0, poolSettledWhileStopping: pool > stop }, diagnostics(run))
    .toEqual({ settled: true, stopSent: true, poolSettledWhileStopping: true });
  const text = indexText().join(" ");
  for (let id = 0; id <= 1; id++) expect(text, diagnostics(run)).toContain(`fixture backup preference ${id}`);
  // The write ran under one named grant asked after that settle; every unnamed bg ask of the stopping helper stays a refusal (W4 stop, W4 batch).
  const after = run.events.slice(pool);
  const named = after.filter(e => e.direction === "in" && e.message.type === "bg-grant-request" && e.message.batch === run.events[stop]!.message.batch);
  const granted = after.filter(e => e.direction === "out" && e.message.type === "bg-grant" && e.message.ticket
    && (e.message.ticket as { purpose?: string }).purpose !== "exit-seal");
  expect({ named: named.length > 0 && typeof run.events[stop]!.message.batch === "string", granted: granted.length }, diagnostics(run)).toEqual({ named: true, granted: 1 });
  await stopped;
}, 300_000);

it("W2 ladder: a real synchronous exit-seal checkpoint blocked 40 s after io-stop ends in FINAL", async () => {
  const marker = join(DATA_DIR, "seal-checkpoint-blocked");
  const { controller, run, io } = await dirtyIdleStart(140_000, `
    walTestHooks.checkpoint = (db, mode) => {
      if (sealing && mode === "TRUNCATE" && !globalThis.delayed) {
        globalThis.delayed = true;
        writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
        block(40_000);
      }
      return db.prepare("PRAGMA wal_checkpoint(" + mode + ")").get();
    };
  `);
  fixture.preload = "";
  idle = false;
  say(1);
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 240_000);
  console.log("[W2 ladder production IPC]", formatTrace(run.events));
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  const stop = event(run, "out", "io-stop")!;
  const receipt = run.events.find(e => e.direction === "in" && e.message.final === true)!;
  const blockedAt = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : Number.NaN;
  expect({
    blockedAfterStop: Boolean(stop) && blockedAt >= stop.at,
    survivedBlock: receipt.at - blockedAt >= 39_000,
    outcome: receipt.message.outcome,
  }).toEqual({ blockedAfterStop: true, survivedBlock: true, outcome: "sealed" });
  await waitFor(() => expect(status()).toEqual(["complete", "complete"]), 65_000);
}, 340_000);

it.each([
  ["beats", "await wait(400_000);"],
  ["stdout", 'for (let i = 0; i < 200; i++) { writeSync(1, "fixture still running\\n"); block(2_000); }'],
] as const)("W6 ladder: %s without progress ends at the stall bound after io-stop", async (_kind, stall) => {
  const controller = start({ idleStart: true, preload: stalledBeforeSeal(stall) });
  const run = await firstRun();
  await waitFor(() => expect(event(run, "out", "idle-exit"), diagnostics(run)).toBeDefined());
  fixture.preload = "";
  const io = accepted(controller);
  say(1);
  await waitFor(() => expect(event(run, "out", "io-stop"), diagnostics(run)).toBeDefined(), 150_000);
  const stop = event(run, "out", "io-stop")!;
  await sleep(Math.max(0, stop.at + 115_000 - Date.now()));
  expect(run.exited, diagnostics(run)).toBeUndefined();
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 15_000);
  expect({ signal: run.exited?.signal, final: io.receipts.final, meter: meter(), failures: failures(controller).initFailures }).toEqual({
    signal: "SIGKILL", final: false, meter: false, failures: 1,
  });
  expect(run.exited!.at - stop.at).toBeGreaterThanOrEqual(119_950);
  expect(run.exited!.at - stop.at).toBeLessThan(125_000);
}, 330_000);

it.skipIf(process.platform !== "linux")("W8 ladder: the exit seal's synchronous PASSIVE checkpoint makes disk progress well past the quiet window", async () => {
  const marker = join(DATA_DIR, "inside-seal-checkpoint");
  fixture.library = slowCheckpointLibrary(marker);
  const { controller, run, io } = await dirtyIdleStart(140_000, `
    walTestHooks.checkpoint = (db, mode) => {
      if (sealing && mode === "PASSIVE" && !globalThis.delayed) {
        globalThis.delayed = true;
        writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
      }
      return db.prepare("PRAGMA wal_checkpoint(" + mode + ")").get();
    };
  `);
  fixture.preload = "";
  fixture.library = "";
  idle = false;
  const firstWrite = statSync(dbFile, { bigint: true }).mtimeNs;
  say(1);
  await waitFor(() => expect(run.exited, diagnostics(run)).toBeDefined(), 400_000);
  console.log("[W8 ladder production IPC]", formatTrace(run.events));
  expect(sameReceipt(controller, io, run), diagnostics(run)).toEqual(finalExit);
  const stop = event(run, "out", "io-stop")!;
  const receipt = run.events.find(e => e.direction === "in" && e.message.final === true)!;
  const slowedAt = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : Number.NaN;
  expect({
    slowedAfterStop: Boolean(stop) && slowedAt >= stop.at,
    survivedQuiet: receipt.at - slowedAt >= 75_000,
    diskMoved: statSync(dbFile, { bigint: true }).mtimeNs > firstWrite,
    outcome: receipt.message.outcome,
  }).toEqual({ slowedAfterStop: true, survivedQuiet: true, diskMoved: true, outcome: "sealed" });
}, 480_000);
