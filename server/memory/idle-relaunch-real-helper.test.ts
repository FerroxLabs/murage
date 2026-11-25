// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness owner: cause-idlecap-fable (1.0.21). Controller owner: scperf-p1 (worker-controller.ts); real helper owner: scperf-p1 (worker.ts);
// job store owner: memory (jobs.ts); idle allowance owner: scperf-p1 ledger (io-budget.ts); ruling owner: MAIN.
//
// MAIN-RULING 2026-11-22T19:35:00Z idle-relaunch, with the REAL helper process: nothing is scripted or mocked here. The controller's own
// start() forks the product's helper (SPAWNED_PROXIES.memoryWorker) while the server is idle; the helper boots on the idle boot grant,
// asks its grants from the controller's handler and captures what is owed, on a new index and again after a restart on the index it
// left. Only the ledger's clock and the idle flag are the fixture's (the clock follows real time).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { ioMeterTotal, resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetProcessLeaseOwnersForTests } from "./jobs.ts";
const root = mkdtempSync(join(tmpdir(), "idle-relaunch-real-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
const realRead = Reflect.get(ioBudget, "read") as () => unknown;
const realAdmissionRead = Reflect.get(ioBudget, "admissionRead") as () => unknown;
const controllers: MemoryWorkerController[] = [];
let origin = 0, t0 = 0;
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
});
beforeEach(async () => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  await stopWalMaintenance(); await stopSearchIndex();
  // the ledger's clock follows real time from 10 s into minute 0
  origin = 10_000; t0 = performance.now(); const read = () => ({ at: origin + Math.round(performance.now() - t0), fsWriteBlocks: 0, cpuMicros: 0 });
  Reflect.set(ioBudget, "read", read); Reflect.set(ioBudget, "admissionRead", read); ioBudget.resetAdmissionForFixture(); ioBudget.setIsIdle(() => false);
});
afterEach(async () => { for (const c of controllers.splice(0)) await c.stop(); closeDatabase(); Reflect.set(ioBudget, "read", realRead); Reflect.set(ioBudget, "admissionRead", realAdmissionRead); ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture(); });
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

type Grant = { ceiling: number; purpose: unknown; replan: boolean; granted: number | null; step: number | null; at: number };
/** What the real helper asked the controller for, and what the controller's handler answered (read off the helper's own channel). */
const grants: Grant[] = []; const said: string[] = [];
function watch(controller: MemoryWorkerController) {
  const seen = new WeakSet<object>();
  const timer = setInterval(() => {
    const child = Reflect.get(controller, "child") as { on(e: string, f: (m: Record<string, unknown>) => void): void; send: (...a: unknown[]) => boolean } | null;
    if (!child || seen.has(child)) return; seen.add(child);
    const pending: Grant[] = [];
    child.on("message", m => { if (typeof m?.type === "string" && !["bg-grant-settle", "io-receipt", "result"].includes(m.type) && said.length < 200) said.push(m.type); if (m?.type === "bg-grant-request") { const g = { ceiling: Number(m.ceiling), purpose: m.purpose ?? null, replan: m.replan === true, granted: null, step: null, at: Math.round(performance.now() - t0) }; grants.push(g); pending.push(g); } });
    const send = child.send.bind(child);
    child.send = (...a: unknown[]) => { const m = a[0] as { type?: string; ticket?: { bytes: number } | null; stepBytes?: number }; if (m?.type === "bg-grant") { const g = pending.shift(); if (g) { g.granted = m.ticket ? m.ticket.bytes : 0; g.step = m.stepBytes ?? null; } } return send(...a); };
  }, 5);
  return () => clearInterval(timer);
}
const start = () => { const c = new MemoryWorkerController({ startHoldMs: 0 }); controllers.push(c); c.start(); const stop = watch(c); const real = c.stop.bind(c); c.stop = async () => { stop(); await real(); }; return c; };
const jobs = () => (database().prepare("SELECT id,status,attempts FROM memory_jobs ORDER BY rowid").all() as Array<{ id: string; status: string; attempts: number }>);
const captured = () => (database().prepare("SELECT j.id AS id,(SELECT count(*) FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=j.source_id AND r.kind='source') AS n FROM memory_jobs j ORDER BY j.rowid").all() as Array<{ id: string; n: number }>).map(r => Number(r.n));
const say = (k: number) => appendMessage("fixture-thread", { id: `fixture-message-${k}`, at: k + 1, role: "user", kind: "text", text: `Remember real helper fixture preference ${k}.` });
const state = (controller: MemoryWorkerController) => JSON.stringify({ jobs: jobs(), ready: Reflect.get(controller, "ready"), child: Boolean(Reflect.get(controller, "child")), error: Reflect.get(controller, "lastError") ?? null, respawnAt: Reflect.get(controller, "respawnAt"), admission: ioBudget.admissionState(), said: [...new Set(said)], grants: grants.slice(0, 40), grantCount: grants.length });

/** Whether a helper process is up, how many failed starts were counted, and the start backoff in force. */
const alive = (controller: MemoryWorkerController) => ({ child: Boolean(Reflect.get(controller, "child")), failures: Reflect.get(controller, "initFailures"), respawnAt: Reflect.get(controller, "respawnAt") });

// MAIN-RULING 2026-11-22T22:47:40Z idle-drained (1): "a DRAINED idle helper (no owed capture, nothing in flight) EXITS ... Witness: a
// drained helper exits inside the idle window on both T10 and T1000, and the next capture lands after a respawn." T10 and T1000 are a
// profile of 10 and of 1000 threads of history already captured (their queue rows are gone); the owed captures are the new messages.
function history(threads: number) {
  for (let k = 0; k < threads; k++) appendMessage(`fixture-history-${k}`, { id: `fixture-history-message-${k}`, at: k + 1, role: "user", kind: "text", text: `History fixture note ${k}.` });
  database().prepare("DELETE FROM memory_jobs").run();
  ioBudget.resetAdmissionForFixture(); origin = 10_000; t0 = performance.now(); grants.length = 0; said.length = 0;
}
const pids = (controller: MemoryWorkerController) => (Reflect.get(controller, "child") as { pid?: number } | null)?.pid ?? null;

it.each([["T10", 10], ["T1000", 1000]] as const)("idle relaunch, real helper, %s: with the owner idle and captures owed, the controller's own start forks the real helper and the captures land with no owner turn; the drained helper exits inside the idle window, the next capture lands after a respawn, and a restarted idle server does the same on the index it left", async (_cell, threads) => {
  history(threads);
  say(0); say(1);
  ioBudget.setIsIdle(() => true);
  expect(ioMeterTotal(), "fixture: the write meter is valid before any helper runs").not.toBeNull();
  const first = start();
  await vi.waitFor(() => expect(jobs().map(j => j.status), state(first)).toEqual(["complete", "complete"]), { timeout: 100_000, interval: 100 });
  expect(ioBudget.admissionIdle(), "the owner never returned: the server was idle throughout").toBe(true);
  expect({ captured: captured(), attempts: jobs().map(j => j.attempts) }, "each captured once, no attempt spent").toEqual({ captured: [1, 1], attempts: [0, 0] });
  // The queue drained. The real helper's index open asks an adaptive grant of about 11 MiB that no idle minute admits, so it cannot
  // initialise while the owner is away, and no step is opened for it to reach an exit: the controller ends it.
  const firstPid = pids(first);
  console.log(`[witness] real helper, new index, idle, drained: ${state(first)}`);
  await vi.waitFor(() => expect(alive(first), `the drained real helper exits inside the idle window, not a failed start: ${state(first)}`).toEqual({ child: false, failures: 0, respawnAt: 0 }), { timeout: 60_000, interval: 100 });
  const endedAt = performance.now();
  expect({ idle: ioBudget.admissionIdle(), opened: grants.filter(g => g.ceiling > 8192 && (g.granted ?? 0) > 0).length, initialised: said.includes("initialised") }, "no index step was opened to reach the exit, and the owner is still away").toEqual({ idle: true, opened: 0, initialised: false });
  expect(ioMeterTotal(), "the ended helper's write receipt was final: its exit does not invalidate the write meter").not.toBeNull();
  await new Promise(done => setTimeout(done, 3_000));
  expect({ ...alive(first), idle: ioBudget.admissionIdle() }, "nothing owed: no helper is started again while idle").toEqual({ child: false, failures: 0, respawnAt: 0, idle: true });
  // the next owed capture, same idle window, same server: a fresh helper lands it, then exits too
  say(2);
  // the pid is read while the helper is up: once the queue is drained the controller ends it, which can come before the line after the wait
  let secondPid: number | null = null; await vi.waitFor(() => { secondPid = pids(first) ?? secondPid; expect(jobs().map(j => j.status), state(first)).toEqual(["complete", "complete", "complete"]); }, { timeout: 100_000, interval: 100 });
  expect({ fresh: typeof secondPid === "number" && secondPid !== firstPid, waited: performance.now() - endedAt >= 25_000, idle: ioBudget.admissionIdle(), captured: captured(), attempts: jobs().map(j => j.attempts) }, `the next capture landed after a respawn on the start backoff, the owner still away: ${state(first)}`).toEqual({ fresh: true, waited: true, idle: true, captured: [1, 1, 1], attempts: [0, 0, 0] });
  await vi.waitFor(() => expect(alive(first), `the respawned real helper exits once the queue is drained again: ${state(first)}`).toEqual({ child: false, failures: 0, respawnAt: 0 }), { timeout: 60_000, interval: 100 });
  expect(ioMeterTotal(), "the respawned helper's exit left the write meter valid too").not.toBeNull();
  // the restart: a new process's controller, idle as every relaunch begins, one more capture owed; the index file exists now
  await first.stop(); controllers.splice(controllers.indexOf(first), 1);
  closeDatabase(); resetProcessLeaseOwnersForTests();
  origin += 120_000; ioBudget.resetAdmissionForFixture();
  say(3);
  ioBudget.setIsIdle(() => true);
  const second = start();
  await vi.waitFor(() => expect(jobs().map(j => j.status), state(second)).toEqual(["complete", "complete", "complete", "complete"]), { timeout: 100_000, interval: 100 });
  expect({ idle: ioBudget.admissionIdle(), captured: captured(), attempts: jobs().map(j => j.attempts) }, "none lost, none doubled, the owner still away").toEqual({ idle: true, captured: [1, 1, 1, 1], attempts: [0, 0, 0, 0] });
  console.log(`[witness] real helper, relaunch, idle, drained: ${state(second)}`);
  await vi.waitFor(() => expect(alive(second), `the relaunched real helper is ended once the queue is drained, not a failed start: ${state(second)}`).toEqual({ child: false, failures: 0, respawnAt: 0 }), { timeout: 60_000, interval: 100 });
}, 480_000);
