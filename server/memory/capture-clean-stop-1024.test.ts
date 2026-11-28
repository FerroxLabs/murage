// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness owner: q1024-memcapture (ruling L). Controller owner: scperf-p1 (worker-controller.ts); real helper owner: scperf-p1 (worker.ts);
// job store owner: memory (jobs.ts); ledger owner: scperf-p1 (io-budget.ts); ruling owner: MAIN.
//
// MAIN-RULING memory L (2026-11-27, _small/memswarm/NOTES.md): "the capture worker must stop cleanly (no SIGKILL backlog growth)".
// MEMSWEEP-1024 saw `[memory-worker] subsystem=capture cause=MEMORY_WORKER_EXIT_NOT_FINAL ... signal=SIGKILL` at every stop on the real store.
// REAL helper process, nothing scripted: the controller's own start() forks the product's helper (SPAWNED_PROXIES.memoryWorker) on an
// active minute with captures owed; MemoryWorkerController.stop() arrives while the helper is draining them. Only the ledger's clock is the
// fixture's (it follows real time).
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetProcessLeaseOwnersForTests } from "./jobs.ts";
const root = mkdtempSync(join(tmpdir(), "capture-clean-stop-"));
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
  origin = 10_000; t0 = performance.now(); const read = () => ({ at: origin + Math.round(performance.now() - t0), fsWriteBlocks: 0, cpuMicros: 0 });
  Reflect.set(ioBudget, "read", read); Reflect.set(ioBudget, "admissionRead", read); ioBudget.resetAdmissionForFixture(); ioBudget.setIsIdle(() => false);
});
afterEach(async () => { for (const c of controllers.splice(0)) await c.stop(); closeDatabase(); Reflect.set(ioBudget, "read", realRead); Reflect.set(ioBudget, "admissionRead", realAdmissionRead); ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture(); });
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

type Life = { kills: string[]; exit: { code: number | null; signal: string | null } | null; sealAsks: number; sealRefused: number };
/** Every helper the controller forked: the kills sent to it, how it exited, and its exit-seal asks and the refusals the controller
 * answered them with (read off the real process and its real IPC channel). */
function watch(controller: MemoryWorkerController, lives: Life[]) {
  const seen = new WeakSet<object>();
  const timer = setInterval(() => {
    const child = Reflect.get(controller, "child") as ChildProcess | null;
    if (!child || seen.has(child)) return; seen.add(child);
    const life: Life = { kills: [], exit: null, sealAsks: 0, sealRefused: 0 }; lives.push(life);
    // the controller answers a bg-grant-request in the same handler turn: the ask is seen first (prepended), its reply is the next bg-grant sent
    let seal = false;
    child.prependListener("message", (m: { type?: string; purpose?: string }) => { if (m?.type === "bg-grant-request") { seal = m.purpose === "exit-seal"; if (seal) life.sealAsks++; } });
    const send = child.send.bind(child) as (...a: unknown[]) => boolean;
    child.send = ((m: { type?: string; ticket?: unknown }, ...rest: unknown[]) => { if (m?.type === "bg-grant" && seal) { seal = false; if (m.ticket === null) life.sealRefused++; } return send(m, ...rest); }) as typeof child.send;
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => { life.kills.push(String(signal ?? "SIGTERM")); return kill(signal); };
    child.once("exit", (code, signal) => { life.exit = { code, signal }; });
  }, 2);
  return () => clearInterval(timer);
}
const jobs = () => (database().prepare("SELECT id,status FROM memory_jobs ORDER BY rowid").all() as Array<{ id: string; status: string }>);
const owed = () => jobs().filter(j => j.status !== "complete").length;
const captured = () => (database().prepare("SELECT (SELECT count(*) FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=j.source_id AND r.kind='source') AS n FROM memory_jobs j ORDER BY j.rowid").all() as Array<{ n: number }>).map(r => Number(r.n));
const say = (k: number) => appendMessage("fixture-thread", { id: `fixture-message-${k}`, at: k + 1, role: "user", kind: "text", text: `Remember clean stop fixture preference ${k}.` });

it.each([["N10", 10], ["N400", 400]] as const)("L clean stop, real helper, %s owed: stop() while the helper drains captures ends it with its FINAL receipt (exit 0, no SIGKILL, no MEMORY_WORKER_EXIT_NOT_FINAL), the backlog does not grow, and the next start lands every capture exactly once", async (_cell, count) => {
  for (let k = 0; k < count; k++) say(k);
  const lives: Life[] = [];
  const first = new MemoryWorkerController({ startHoldMs: 0 }); controllers.push(first);
  const unwatch = watch(first, lives);
  first.start();
  // mid-drain: the real helper is up and has landed at least one capture
  await vi.waitFor(() => expect(jobs().some(j => j.status === "complete"), JSON.stringify({ lives, error: first.error })).toBe(true), { timeout: 120_000, interval: 20 });
  const before = owed();
  const stoppedAt = performance.now();
  await first.stop(); controllers.splice(controllers.indexOf(first), 1); unwatch();
  const took = Math.round(performance.now() - stoppedAt);
  await vi.waitFor(() => expect(lives.every(l => l.exit !== null), JSON.stringify(lives)).toBe(true), { timeout: 10_000, interval: 20 });
  expect({ helpers: lives.length, kills: lives.flatMap(l => l.kills), exits: lives.map(l => l.exit), sealRefused: lives.reduce((n, l) => n + l.sealRefused, 0), error: first.error, slow: took > 5_000 }, `stop() mid-drain (owed ${before} of ${count}, took ${took} ms): every helper ends on its own FINAL write, none is killed`).toEqual({ helpers: 1, kills: [], exits: [{ code: 0, signal: null }], sealRefused: 0, error: null, slow: false });
  expect(owed(), "the stop grew no backlog").toBeLessThanOrEqual(before);
  // the restart: the next process's controller lands what is still owed, each capture once
  closeDatabase(); resetProcessLeaseOwnersForTests(); origin += 120_000; ioBudget.resetAdmissionForFixture();
  const later: Life[] = [];
  const second = new MemoryWorkerController({ startHoldMs: 0 }); controllers.push(second);
  const unwatchSecond = watch(second, later); second.start();
  await vi.waitFor(() => expect(owed(), JSON.stringify({ error: second.error })).toBe(0), { timeout: 240_000, interval: 100 });
  expect(captured().filter(n => n !== 1), "none lost, none doubled").toEqual([]);
  // the stop after the drain, on the field's minute: the backlog and other background writers have spent this minute's background room.
  // The ledger clock moves to the start of a fresh minute (forward only), so the stop cannot outrun the room by a minute roll, and the room
  // is spent in shrinking steps until even one page is refused. The helper's FINAL seal must still be admitted at once.
  const now = origin + Math.round(performance.now() - t0); origin += (Math.floor(now / 60_000) + 1) * 60_000 + 500 - now;
  for (const step of [1024 * 1024, 256 * 1024, 64 * 1024, 16 * 1024, 4096]) for (let k = 0; k < 4096 && ioBudget.admit("BG", step); k++);
  expect(ioBudget.admit("BG", 4096), "fixture: this minute's background room is spent").toBeNull();
  const drainedAt = performance.now();
  await second.stop(); controllers.splice(controllers.indexOf(second), 1); unwatchSecond();
  const tookDrained = Math.round(performance.now() - drainedAt);
  await vi.waitFor(() => expect(later.every(l => l.exit !== null), JSON.stringify(later)).toBe(true), { timeout: 10_000, interval: 20 });
  const last = later.at(-1);
  expect({ sealRefused: last?.sealRefused ?? -1, askedAgain: (last?.sealAsks ?? 0) > 1, kills: later.flatMap(l => l.kills), exit: last?.exit ?? null, error: second.error, slow: tookDrained > 5_000 }, `stop() after the minute was spent (took ${tookDrained} ms): the last helper's FINAL seal is admitted on its first ask, it ends on it, none is killed`).toEqual({ sealRefused: 0, askedAgain: false, kills: [], exit: { code: 0, signal: null }, error: null, slow: false });
}, 480_000);

// The shutdown and restore handover (index.ts data-writer close: memoryWorker.haltHelper()) ends the helper through endOne: io-stop, a 5 s
// grace, then SIGKILL. Mid-drain on a spent minute its FINAL seal must be admitted on the first ask too, or the grace ends in the field's SIGKILL.
it("L clean halt, real helper, N400 owed: haltHelper() mid-drain on a spent minute ends the helper on its FINAL seal (admitted on its first ask), never by SIGKILL", async () => {
  for (let k = 0; k < 400; k++) say(k);
  const lives: Life[] = [];
  const controller = new MemoryWorkerController({ startHoldMs: 0 }); controllers.push(controller);
  const unwatch = watch(controller, lives);
  controller.start();
  await vi.waitFor(() => expect(jobs().some(j => j.status === "complete"), JSON.stringify({ lives, error: controller.error })).toBe(true), { timeout: 120_000, interval: 20 });
  const now = origin + Math.round(performance.now() - t0); origin += (Math.floor(now / 60_000) + 1) * 60_000 + 500 - now;
  for (const step of [1024 * 1024, 256 * 1024, 64 * 1024, 16 * 1024, 4096]) for (let k = 0; k < 4096 && ioBudget.admit("BG", step); k++);
  expect(ioBudget.admit("BG", 4096), "fixture: this minute's background room is spent").toBeNull();
  const before = owed(), haltedAt = performance.now();
  const gone = await controller.haltHelper(); unwatch();
  const took = Math.round(performance.now() - haltedAt);
  await vi.waitFor(() => expect(lives.every(l => l.exit !== null), JSON.stringify(lives)).toBe(true), { timeout: 10_000, interval: 20 });
  const last = lives.at(-1);
  expect({ gone, sealRefused: last?.sealRefused ?? -1, kills: lives.flatMap(l => l.kills), exit: last?.exit ?? null, slow: took > 5_000 }, `haltHelper() mid-drain (owed ${before} of 400, took ${took} ms): the helper ends on its own FINAL seal, none is killed`).toEqual({ gone: true, sealRefused: 0, kills: [], exit: { code: 0, signal: null }, slow: false });
  expect(owed(), "the halt grew no backlog").toBeLessThanOrEqual(before);
}, 240_000);

// Cause C on the REAL helper (MAIN 11-27; ASTRA :9177 H2): the backlog drains at capture priority. With the helper up and draining, a ledger
// minute whose background room other writers have spent still lands captures in that same minute; before cause C none landed until it rolled.
it("C real helper, N400 owed: captures keep landing inside a minute whose background room is spent", async () => {
  for (let k = 0; k < 400; k++) say(k);
  const controller = new MemoryWorkerController({ startHoldMs: 0 }); controllers.push(controller);
  controller.start();
  await vi.waitFor(() => expect(jobs().some(j => j.status === "complete"), JSON.stringify({ error: controller.error })).toBe(true), { timeout: 120_000, interval: 20 });
  const now = origin + Math.round(performance.now() - t0); origin += (Math.floor(now / 60_000) + 1) * 60_000 + 500 - now;
  const minute = () => Math.floor((origin + Math.round(performance.now() - t0)) / 60_000), spent = minute();
  for (const step of [1024 * 1024, 256 * 1024, 64 * 1024, 16 * 1024, 4096]) for (let k = 0; k < 4096 && ioBudget.admit("BG", step); k++);
  expect(ioBudget.admit("BG", 4096), "fixture: this minute's background room is spent").toBeNull();
  const done = () => jobs().filter(j => j.status === "complete").length, from = done();
  await vi.waitFor(() => expect({ landed: done() - from >= 5, sameMinute: minute() === spent }, `captures landed in the spent minute: ${done() - from}`).toEqual({ landed: true, sameMinute: true }), { timeout: 45_000, interval: 50 });
}, 240_000);
