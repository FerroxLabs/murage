// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN r3 T7: a stop reaches every await of maintenance. maintainPip with its signal aborted (a) before entry, (b) while the reaper's
// look is blocked in a helper that never exits and while killAndVerify waits out its grace, (c) during a 1,000-entry orphan sweep, (d) during
// the trace read, (e) on Windows with a job helper that never answers: each settles within 200 ms, writes nothing, leaves the attempt
// uncertain-transport with its transport record (an interrupted look is never "gone"), and MemoryWorkerController.stop() with each in flight
// resolves within 200 ms.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeTempDirSync } from "../testing/cleanup.ts";
// every helper look (ps, powershell) hangs until its signal aborts it, as a never-exiting child would
const helpers = vi.hoisted(() => ({ started: 0 }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const execFile = (_cmd: string, _args: string[], options: { signal?: AbortSignal }, callback: (error: Error | null, out: string) => void) => {
    helpers.started++;
    options?.signal?.addEventListener("abort", () => callback(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR", name: "AbortError" }), ""), { once: true });
    return { kill() {} };
  };
  return { ...real, execFile };
});

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { reconcileMemoryRoster } = await import("./policy.ts");
const { captureMessage } = await import("./capture.ts");
const { setMemoryCaptureRoster } = await import("./capture-scope.ts");
const { setMemoryMode } = await import("./repository.ts");
const { maintainPip, mutateReflect, pipReadHooks, readReflectState, reconcilePipRuns } = await import("./pip-reflect.ts");
const { MemoryWorkerController } = await import("./worker-controller.ts");
const { stopWindowsJob } = await import("./pip-job.ts");
const { killAndVerify, sweepByArgv, sweepOrphanTempDirs } = await import("./pip-reaper.ts");
type ReflectDeps = import("./pip-reflect.ts").ReflectDeps;
type ReaperDeps = import("./pip-reaper.ts").ReaperDeps;

const T0 = 1_760_000_000_000, MIN = 60_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  helpers.started = 0;
});
afterEach(() => { setMemoryCaptureRoster(null); pipReadHooks.between = undefined; });

const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
const depsWith = (reaper: ReaperDeps, now = T0 + 60 * MIN): ReflectDeps => ({
  now: () => now, bootEpoch: { pid: 2, startedAt: 2 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
  resolveRoute: async () => { throw new Error("not used"); }, reaper,
});
/** A run of an older boot epoch whose attempt is uncertain-transport, with a registered child: the reaper must kill and verify it. */
function uncertainAttempt(jobName?: string) {
  const tempRoot = join(DATA_DIR, "pip-tmp", "attempt-root");
  mkdirSync(tempRoot, { recursive: true });
  mutateReflect("moss", s => {
    s.run = {
      runId: "run-1", kind: "reflect", threadId: "private", fromMessageId: null, toMessageId: null, toAt: 0, window: { bytes: 0 }, bootEpoch: { pid: 1, startedAt: 1 }, createdAt: T0, fingerprint: "fp",
      families: { lived: { state: "uncertain-transport", attempt: 1, snapshotGen: "g", transport: { kind: "cli", intent: { runId: "run-1", family: "lived", attempt: 1, tempRoot, bootEpoch: { pid: 1, startedAt: 1 }, intentAt: T0, deadlineAt: T0 + MIN, ...(jobName ? { jobName } : {}) }, child: { pid: 424242, startTime: "then", registeredAt: T0 } } } },
    };
  });
  return tempRoot;
}
const family = () => readReflectState(database(), "moss").run?.families.lived;
async function within(ms: number, body: (signal: AbortSignal) => Promise<unknown>, abortAfter: number): Promise<number> {
  const stop = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => stop.abort(), abortAfter);
  try { await body(stop.signal); } finally { clearTimeout(timer); }
  const took = performance.now() - started - abortAfter;
  expect(took).toBeLessThan(ms);
  return took;
}

describe("T7: maintenance cancellation", () => {
  it("(a) aborted before entry: returns at once and writes nothing", async () => {
    const root = uncertainAttempt();
    const stop = new AbortController(); stop.abort();
    const started = performance.now();
    await maintainPip(depsWith({ platform: "darwin" }), { startup: true, signal: stop.signal });
    expect(performance.now() - started).toBeLessThan(200);
    expect(family()).toMatchObject({ state: "uncertain-transport" });
    expect(family()?.transport?.intent.tempRoot).toBe(root);
    expect(helpers.started).toBe(0);
  });

  it("(b) the reaper's look is blocked on a helper that never exits: the stop ends it and the attempt keeps its record", async () => {
    const root = uncertainAttempt();
    await within(200, signal => maintainPip(depsWith({ platform: "darwin" }), { signal }), 50);
    expect(helpers.started).toBeGreaterThan(0);
    expect(family()).toMatchObject({ state: "uncertain-transport" });
    expect(family()?.transport?.child?.pid).toBe(424242);
    // an interrupted look is not a failed reap: nothing is charged
    expect(family()?.transport?.reaperFailures).toBeUndefined();
    expect(existsSync(root)).toBe(true);
  });

  it("(b) killAndVerify in its 3 s grace: the stop ends the poll and answers not verified", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = performance.now();
    // the group is alive and never goes away
    const ok = await killAndVerify(424242, { platform: "linux", signal: () => {}, abort: stop.signal });
    expect(ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
    // and through maintainPip: present with the same start time, so it kills and waits the grace
    uncertainAttempt();
    await within(200, signal => maintainPip(depsWith({ platform: "linux", observe: async () => ({ state: "present", startTime: "then" }), signal: () => {} }), { signal }), 50);
    expect(family()).toMatchObject({ state: "uncertain-transport" });
    expect(family()?.transport?.reaperFailures).toBeUndefined();
  });

  it("(c) a 1,000-entry orphan sweep stops between entries and keeps the rest for the next pass", async () => {
    const base = join(DATA_DIR, "pip-tmp");
    for (let i = 0; i < 1000; i++) mkdirSync(join(base, `orphan-${i}`), { recursive: true });
    const sweep = async () => { await new Promise(resolve => setTimeout(resolve, 1)); return []; };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);
    const started = performance.now();
    const out = await sweepOrphanTempDirs(base, new Set(), { platform: "linux", sweep, abort: stop.signal });
    expect(performance.now() - started).toBeLessThan(230);
    expect(out.removed.length).toBeLessThan(1000);
    expect(readdirSync(base).length).toBe(1000 - out.removed.length);
    // through maintainPip at startup (orphan discovery)
    const before = readdirSync(base).length;
    await within(200, signal => maintainPip(depsWith({ platform: "linux", sweep }), { startup: true, signal }), 30);
    expect(readdirSync(base).length).toBeGreaterThan(0);
    expect(readdirSync(base).length).toBeLessThanOrEqual(before);
  });

  it("(d) during the trace read: nothing is written and the day is kept", async () => {
    const db = database(), day = new Date(2026, 9, 5, 9).getTime();
    for (let i = 0; i < 100; i++) {
      captureMessage(db, "private", { id: `o${i}`, at: day + i * 1000, role: "user", kind: "text", text: `Note ${i}.`, origin: "desktop" } as never);
      captureMessage(db, "private", { id: `b${i}`, at: day + i * 1000 + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
    }
    db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
    const stop = new AbortController();
    pipReadHooks.between = () => { stop.abort(); };
    const started = performance.now();
    await maintainPip(depsWith({ platform: "linux", sweep: async () => [] }, new Date(2026, 9, 8, 12).getTime()), { signal: stop.signal });
    expect(stop.signal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
    expect(readReflectState(database(), "moss").lastTraceDay).toBeUndefined();
  });

  it.each([false, true])("(f) a joiner of the reconciliation in flight (discoverOrphans %s) stops on its own signal; the pass in flight keeps its starter's", async discoverOrphans => {
    uncertainAttempt();
    // the first pass blocks in killAndVerify's grace wait, which only its own signal ends
    const deps = depsWith({ platform: "linux", observe: async () => ({ state: "present", startTime: "then" }), signal: () => {} });
    const first = new AbortController();
    let firstDone = false;
    const running = reconcilePipRuns(deps, { signal: first.signal }).then(out => { firstDone = true; return out; });
    await new Promise(resolve => setTimeout(resolve, 20));
    const joined = await within(200, signal => reconcilePipRuns(deps, { discoverOrphans, signal }).then(out => { expect(out).toEqual({ retried: 0, unstable: 0, unconfirmed: 0, swept: 0 }); }), 30);
    expect(joined).toBeLessThan(200);
    expect(firstDone).toBe(false);
    first.abort();
    await running;
    expect(firstDone).toBe(true);
    expect(family()).toMatchObject({ state: "uncertain-transport" });
    expect(family()?.transport?.reaperFailures).toBeUndefined();
  });

  it("(g) the Linux argv sweep hands the loop back between /proc entries: a stop reaches it and answers a failed look, never an empty list", async () => {
    const root = join(DATA_DIR, "fake-proc");
    for (let i = 1; i <= 1000; i++) { mkdirSync(join(root, String(100_000 + i)), { recursive: true }); writeFileSync(join(root, String(100_000 + i), "cmdline"), i === 777 ? "node\u0000--root\u0000/tmp/pip-needle-1\u0000" : "sleep\u0000100\u0000"); }
    writeFileSync(join(root, "not-a-pid"), "");
    expect(await sweepByArgv("/tmp/pip-needle-1", "linux", undefined, root)).toEqual([100_777]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 1);
    const started = performance.now();
    expect(await sweepByArgv("/tmp/pip-needle-1", "linux", stop.signal, root)).toBeNull();
    expect(stop.signal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("(e) Windows: a job helper that never answers is ended by the stop and answers not verified gone", async () => {
    const never = () => new Promise<{ ok: boolean; out: string }>(() => {});
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = performance.now();
    expect(await stopWindowsJob("Local\\murage-pip-abc", 4_000, never, stop.signal)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
    // through the reaper and maintainPip
    uncertainAttempt("Local\\murage-pip-abc");
    await within(200, signal => maintainPip(depsWith({ platform: "win32", jobRunner: never }), { signal }), 50);
    expect(family()).toMatchObject({ state: "uncertain-transport" });
    expect(family()?.transport?.intent.jobName).toBe("Local\\murage-pip-abc");
    expect(family()?.transport?.reaperFailures).toBeUndefined();
  });

  it.each(["helper", "grace", "windows"] as const)("MemoryWorkerController.stop() with maintenance in flight (%s) resolves within 200 ms", async kind => {
    uncertainAttempt(kind === "windows" ? "Local\\murage-pip-abc" : undefined);
    const reaper: ReaperDeps = kind === "helper" ? { platform: "darwin" }
      : kind === "grace" ? { platform: "linux", observe: async () => ({ state: "present", startTime: "then" }), signal: () => {} }
      : { platform: "win32", jobRunner: () => new Promise(() => {}) };
    const deps = depsWith(reaper);
    const worker = new MemoryWorkerController({ onMaintenance: (startup, signal) => maintainPip(deps, { startup, signal }) });
    const tick = worker as unknown as { independentWork(startup?: boolean): void; maintenanceTask: Promise<void> | null };
    tick.independentWork();
    expect(tick.maintenanceTask).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = performance.now();
    await worker.stop();
    expect(performance.now() - started).toBeLessThan(200);
    expect(family()).toMatchObject({ state: "uncertain-transport" });
  });
});
