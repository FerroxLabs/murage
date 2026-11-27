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

// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS, 06:57:58Z): this row pinned the controller's own start forking
// the real helper on an IDLE minute and the drained idle helper's exit/respawn. Idle now starts no helper and writes no capture
// (io-budget.ts idleQuiet). The row keeps the real helper, the T10/T1000 profiles and the restart, and asserts the new shape: an idle
// minute forks nothing, asks no grant and writes nothing; the next ACTIVE minute's ordinary start lands every owed capture once.
/** Real-time idle window: the controller is woken repeatedly while the owner is away; any helper it forks talks within this time. */
async function idleWindow(controller: MemoryWorkerController) {
  for (let k = 0; k < 10; k++) { controller.wake(); controller.warmForIntent(); await new Promise(done => setTimeout(done, 500)); }
}
it.each([["T10", 10], ["T1000", 1000]] as const)("CHANGED-EXPECTATION idle DO LESS, real helper, %s: with the owner idle and captures owed, the controller forks no real helper and writes nothing; the next active minute's ordinary start lands each capture once, and a restarted server does the same on the index it left", async (_cell, threads) => {
  history(threads);
  say(0); say(1);
  ioBudget.setIsIdle(() => true);
  expect(ioMeterTotal(), "fixture: the write meter is valid before any helper runs").not.toBeNull();
  const first = start();
  await idleWindow(first);
  expect({ child: alive(first).child, talked: said.length, grants: grants.length, statuses: jobs().map(j => j.status), captured: captured(), attempts: jobs().map(j => j.attempts), idle: ioBudget.admissionIdle(), reserved: ioBudget.admissionState().reserved }, `idle minute: no real helper forked, no grant asked, nothing captured (DO LESS): ${state(first)}`).toEqual({ child: false, talked: 0, grants: 0, statuses: ["pending", "pending"], captured: [0, 0], attempts: [0, 0], idle: true, reserved: 0 });
  // the owner is back: the next active minute
  ioBudget.setIsIdle(() => false); origin += 60_000; first.wake();
  await vi.waitFor(() => expect(jobs().map(j => j.status), state(first)).toEqual(["complete", "complete"]), { timeout: 100_000, interval: 100 });
  expect({ idle: ioBudget.admissionIdle(), forked: said.length > 0, captured: captured(), attempts: jobs().map(j => j.attempts) }, "active minute: the ordinary start forked the real helper and each capture landed once, no attempt spent").toEqual({ idle: false, forked: true, captured: [1, 1], attempts: [0, 0] });
  expect(ioMeterTotal(), "the real helper's receipts left the write meter valid").not.toBeNull();
  // the restart: a new process's controller, idle as every relaunch begins, one more capture owed; the index file exists now
  await first.stop(); controllers.splice(controllers.indexOf(first), 1);
  closeDatabase(); resetProcessLeaseOwnersForTests();
  origin += 120_000; ioBudget.resetAdmissionForFixture(); said.length = 0; grants.length = 0;
  say(2);
  ioBudget.setIsIdle(() => true);
  const second = start();
  await idleWindow(second);
  expect({ child: alive(second).child, talked: said.length, grants: grants.length, statuses: jobs().map(j => j.status), captured: captured(), idle: ioBudget.admissionIdle() }, `relaunched and idle: no real helper forked, the owed capture waits (DO LESS): ${state(second)}`).toEqual({ child: false, talked: 0, grants: 0, statuses: ["complete", "complete", "pending"], captured: [1, 1, 0], idle: true });
  ioBudget.setIsIdle(() => false); origin += 60_000; second.wake();
  await vi.waitFor(() => expect(jobs().map(j => j.status), state(second)).toEqual(["complete", "complete", "complete"]), { timeout: 100_000, interval: 100 });
  expect({ idle: ioBudget.admissionIdle(), captured: captured(), attempts: jobs().map(j => j.attempts) }, "the relaunch finished on the active minute: none lost, none doubled").toEqual({ idle: false, captured: [1, 1, 1], attempts: [0, 0, 0] });
}, 480_000);
