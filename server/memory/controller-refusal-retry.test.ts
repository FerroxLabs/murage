// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness owner: thrust-crashlock (1.0.19). Controller retry owner: scperf-p1 (worker-controller.ts).
//
// docs/designs/1019-roombase-pinned C4 + C6 (W13 restart stall). After a crash the start releases the dead process's leases
// (C6). When the I/O budget refuses that release (BgDeferred), the controller used to log `next=later` and never try again, so
// the dead lease held the thread's capture until its lease_until. C4: every refusal schedules exactly one retry at the budget's
// named time. The refusals here are real: the BG ledger is full, so the instrumented connection refuses the memory writer.
import { EventEmitter } from "node:events";
import { execFileSync, fork } from "node:child_process";
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
import { claimMemoryJob, releaseDeadProcessLeases, resetProcessLeaseOwnersForTests } from "./jobs.ts";
vi.mock("./jobs.ts", async original => {
  const actual = await original<typeof import("./jobs.ts")>();
  return { ...actual, releaseDeadProcessLeases: vi.fn(actual.releaseDeadProcessLeases) };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), fork: vi.fn() }));
const root = mkdtempSync(join(tmpdir(), "controller-refusal-retry-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let at = 0, controller: MemoryWorkerController;
const realRead = Reflect.get(ioBudget, "read") as () => unknown;
const realAdmissionRead = Reflect.get(ioBudget, "admissionRead") as () => unknown;
class Child extends EventEmitter {
  send = vi.fn((_message: unknown) => true); connected = true; stderr = null;
  kill() { this.emit("exit", 0); return true; } disconnect() { this.emit("exit", 0); }
}
type Internals = { bgRetryAt: number; child: Child | null; ready: boolean; owner: string; work: unknown; bootRecoveryTimer: unknown; deferredFailure: unknown; failWork(reason: string): void; bootSteps: { redrive: boolean; release: boolean }; bootRecovery(): void };
/** A scripted helper for the real spawn path: ready at once, initialised on `init`, holds every capture it is sent (never answers). */
class Helper extends EventEmitter {
  works: Array<{ id: string }> = []; connected = true; stderr = null;
  send = vi.fn((message: { type?: string; id?: string; leaseGeneration?: number }) => {
    if (message.type === "init") setTimeout(() => { this.emit("message", { type: "index-opening" }); this.emit("message", { type: "initialised" }); }, 0);
    else if (typeof message.id === "string" && "leaseGeneration" in message) this.works.push({ id: message.id });
    return true;
  });
  kill() { this.crash(0); return true; } disconnect() { this.crash(0); }
  crash(code: number) { this.connected = false; this.emit("exit", code, null); }
}
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
});
beforeEach(async () => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  await stopWalMaintenance(); await stopSearchIndex();
  // the ledger's clock is the fixture's: 54 s into minute 0, so the full-ledger fixture below is admitted
  at = 54_000; const read = () => ({ at, fsWriteBlocks: 0, cpuMicros: 0 });
  Reflect.set(ioBudget, "read", read); Reflect.set(ioBudget, "admissionRead", read); ioBudget.resetAdmissionForFixture(); ioBudget.setIsIdle(() => false);
  controller = new MemoryWorkerController({ startHoldMs: 0 }); const i = controller as unknown as Internals; i.child = new Child(); i.ready = true;
  vi.mocked(releaseDeadProcessLeases).mockClear(); vi.mocked(fork).mockClear();
});
afterEach(async () => { await controller.stop(); closeDatabase(); Reflect.set(ioBudget, "read", realRead); Reflect.set(ioBudget, "admissionRead", realAdmissionRead); ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture(); });
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

/** The minute's BG room is used up: every memory write is refused (BgDeferred) until the minute rolls. */
function fill() { const t = ioBudget.admit("BG", 12 * 1024 * 1024)!; expect(t, "full-ledger fixture").not.toBeNull(); ioBudget.settle(t, t.bytes); }
/** One owner ask with its capture job, leased by a process that is gone (this process's lease-owner record starts empty, as after a restart). */
function deadLease() {
  appendMessage("fixture-thread", { id: "fixture-message", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  const work = claimMemoryJob("dead-worker")!; expect(work, "dead lease fixture").toBeTruthy();
  resetProcessLeaseOwnersForTests();
  return work.id;
}
const job = (id: string) => database().prepare("SELECT status,lease_owner,attempts FROM memory_jobs WHERE id=?").get(id) as { status: string; lease_owner: string | null; attempts: number };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("C4+C6 a dead lease whose release is refused at start is released by one retry at the named time and is then claimed at once", async () => {
  const id = deadLease();
  fill(); at = 59_000; // one second before the roll: the budget names the roll as the retry time
  controller.start();
  // the start's release was really refused: the dead lease is still there, and one retry timer is armed
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(1);
  expect(job(id)).toMatchObject({ status: "leased", lease_owner: "dead-worker" });
  expect((controller as unknown as Internals).bootRecoveryTimer, "a refused start release arms its retry").not.toBeNull();
  at = 60_001; // the minute rolls (the dead lease's own lease_until is about a minute away and never reached here)
  await vi.waitFor(() => expect(job(id).lease_owner).not.toBe("dead-worker"), { timeout: 4_000, interval: 50 });
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(2);
  // released, then claimed by this process at once: the job is in the helper's hands, attempts untouched
  await vi.waitFor(() => expect(job(id)).toMatchObject({ status: "leased", lease_owner: (controller as unknown as Internals).owner, attempts: 0 }), { timeout: 4_000, interval: 50 });
  // exactly one retry: the release that ran is not run again
  await settle(1_500);
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(2);
  expect((controller as unknown as Internals).bootRecoveryTimer).toBeNull();
});

it("fable-crashlock A1 a start redrive the budget refuses is retried once at the named time: a job the crashed run failed is not left failed for the whole run", async () => {
  // a capture the previous run failed three times because its helper died (says nothing about the conversation): owed a redrive at start
  appendMessage("fixture-thread", { id: "fixture-message", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  const id = String((database().prepare("SELECT id FROM memory_jobs").get() as { id: string }).id);
  database().prepare("UPDATE memory_jobs SET status='failed',attempts=3,error='MEMORY_WORKER_EXITED' WHERE id=?").run(id);
  fill(); at = 59_000;
  controller.start();
  // the start's redrive was really refused: the job is still failed, and one retry timer is armed
  expect(job(id)).toMatchObject({ status: "failed", attempts: 3 });
  expect((controller as unknown as Internals).bootRecoveryTimer, "a refused start redrive arms its retry").not.toBeNull();
  at = 60_001;
  // redriven by the one retry (attempts given back), then claimed by this process at once
  await vi.waitFor(() => expect(job(id)).toMatchObject({ status: "leased", lease_owner: (controller as unknown as Internals).owner, attempts: 0 }), { timeout: 4_000, interval: 50 });
  expect(database().prepare("SELECT error FROM memory_jobs WHERE id=?").get(id)).toEqual({ error: "redriven:MEMORY_WORKER_EXITED" });
  await settle(1_000);
  expect((controller as unknown as Internals).bootRecoveryTimer).toBeNull();
});

it("C4 a second refusal replaces the retry timer instead of adding one; the release runs once it is admitted", async () => {
  const id = deadLease();
  fill(); at = 59_000;
  controller.start();
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(1);
  at = 59_500; // the retry fires inside the same refused minute: refused again, one new timer at the roll
  await vi.waitFor(() => expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(2), { timeout: 3_000, interval: 25 });
  expect(job(id).lease_owner).toBe("dead-worker");
  at = 60_001;
  await vi.waitFor(() => expect(job(id).lease_owner).not.toBe("dead-worker"), { timeout: 3_000, interval: 25 });
  await settle(1_500);
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(3);
});

it("W13 a restarted idle server refuses the start release until the roll; the owner's next message runs it at once", async () => {
  const id = deadLease();
  // nothing runs after a restart: the idle rule refuses every BG write, and the budget names the roll (50 s away) as the retry time
  at = 10_000; ioBudget.setIsIdle(() => true);
  controller.start();
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(1);
  expect(job(id)).toMatchObject({ status: "leased", lease_owner: "dead-worker" });
  // the refusal arms only its own timer: the capture queue's pacing gate is not moved to the roll (it would hold every claim,
  // the owner's next capture included, while work is in flight and nothing clears it)
  expect((controller as unknown as Internals).bgRetryAt, "a refused start step never paces the capture queue").toBe(0);
  // the owner sends a message: the server is active again and the arrival wakes the worker
  ioBudget.setIsIdle(() => false);
  appendMessage("fixture-thread", { id: "fixture-message-2", at: 2, role: "user", kind: "text", text: "And the second preference." });
  await vi.waitFor(() => expect(job(id).lease_owner).not.toBe("dead-worker"), { timeout: 3_000, interval: 25 });
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(2);
  expect((controller as unknown as Internals).bootRecoveryTimer).toBeNull();
  // and the capture queue is not paced to the roll the idle refusal named: this process claims the released job at once
  await vi.waitFor(() => expect(job(id)).toMatchObject({ status: "leased", lease_owner: (controller as unknown as Internals).owner }), { timeout: 3_000, interval: 25 });
});

it("C4 a deferral the budget refuses (failWork) is retried once at the named time; the lease is not left until lease_until", async () => {
  appendMessage("fixture-thread", { id: "fixture-message", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  const i = controller as unknown as Internals;
  const work = claimMemoryJob(i.owner)!; expect(work).toBeTruthy();
  i.work = work;
  fill(); at = 59_000;
  i.failWork("MEMORY_WORKER_TIMEOUT");
  expect(job(work.id)).toMatchObject({ status: "leased", lease_owner: i.owner });
  expect(i.deferredFailure, "the refused deferral arms its retry").not.toBeNull();
  at = 60_001;
  await vi.waitFor(() => expect(job(work.id).status).not.toBe("leased"), { timeout: 4_000, interval: 50 });
  expect(job(work.id).lease_owner).toBeNull();
  expect(i.deferredFailure).toBeNull();
});

it("crashlockfix H2 (D5) a start step refused while a capture is in flight never paces the queue: after the arrival and the helper's crash the next job is claimed within 10 s, not at the roll 50 s away", async () => {
  // the real spawn path: the controller forks scripted helpers and claims for itself
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  const i = controller as unknown as Internals; i.child = null; i.ready = false;
  appendMessage("fixture-thread", { id: "fixture-in-flight", at: 1, role: "user", kind: "text", text: "The capture that is in flight." });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works.length).toBe(1), { timeout: 4_000, interval: 25 });
  const inFlight = helpers[0]!.works[0]!.id;
  expect(job(inFlight)).toMatchObject({ status: "leased", lease_owner: i.owner });
  // a lease the crashed process left behind (the fixture writes it as the crash left it)
  appendMessage("fixture-thread", { id: "fixture-message", at: 2, role: "user", kind: "text", text: "Remember the fixture preference." });
  const dead = String((database().prepare("SELECT id FROM memory_jobs WHERE id<>? AND status='pending'").get(inFlight) as { id: string }).id);
  database().prepare("UPDATE memory_jobs SET status='leased',lease_owner='dead-worker',lease_until=?,lease_generation=lease_generation+1 WHERE id=?").run(Date.now() + 120_000, dead);
  // the server goes idle with the capture still in flight, and the owed release step runs (its retry timer firing): the idle rule
  // refuses it and names the roll, 50 s away
  at = 10_000; ioBudget.setIsIdle(() => true);
  const calls = vi.mocked(releaseDeadProcessLeases).mock.calls.length;
  i.bootSteps.release = false; i.bootRecovery();
  expect(vi.mocked(releaseDeadProcessLeases).mock.calls.length).toBe(calls + 1);
  expect(job(dead)).toMatchObject({ status: "leased", lease_owner: "dead-worker" });
  // the owner sends a message: the server is active, the arrival runs the owed release at once (wake() returns early: work in flight)
  ioBudget.setIsIdle(() => false);
  appendMessage("fixture-thread", { id: "fixture-arrival", at: 3, role: "user", kind: "text", text: "And the second preference." });
  await vi.waitFor(() => expect(job(dead).lease_owner).not.toBe("dead-worker"), { timeout: 3_000, interval: 25 });
  // the in-flight capture's helper crashes: its job is deferred and the queue looks again. Nothing in this path clears a pacing gate
  // the refusal might have set, so a start step that paced the queue (bgRetryMs) holds the next claim to the roll.
  const crashedAt = performance.now();
  helpers[0]!.crash(1);
  const state = () => JSON.stringify({ helpers: helpers.length, works: helpers.map(h => h.works.length), bgRetryAt: i.bgRetryAt - performance.now(), child: i.child !== null, ready: i.ready, x: Object.fromEntries(["respawnAt", "nextEligibleWorkAt", "scheduledAt", "ticking", "initFailures"].map(k => [k, Reflect.get(i, k)])), now: performance.now(), dateNow: Date.now(), jobs: database().prepare("SELECT id,status,lease_owner,attempts,retry_at FROM memory_jobs").all() });
  // the crash reschedules the queue at its own next due time (the crashed job's 5 s retry); the roll the refusal named is 50 s away
  await vi.waitFor(() => expect(helpers[1]?.works.length, state()).toBe(1), { timeout: 10_000, interval: 25 });
  expect(performance.now() - crashedAt).toBeLessThan(10_000);
  // the crash spent one attempt of the crashed capture (MEMORY_WORKER_EXITED); whichever job is due first is claimed by this process
  expect(job(inFlight).attempts).toBe(1);
  expect(job(helpers[1]!.works[0]!.id)).toMatchObject({ status: "leased", lease_owner: i.owner });
  expect(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE lease_owner='dead-worker'").get()).toEqual({ n: 0 });
}, 30_000);

it("crashlock H2 (D5) a failWork deferral refused while the server is idle never paces the queue: the owner's next message is claimed within seconds, not at the roll 50 s away", async () => {
  // the real spawn path: the controller forks scripted helpers and claims for itself
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  const i = controller as unknown as Internals; i.child = null; i.ready = false;
  appendMessage("fixture-thread", { id: "fixture-in-flight", at: 1, role: "user", kind: "text", text: "The capture that is in flight." });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works.length).toBe(1), { timeout: 4_000, interval: 25 });
  const inFlight = helpers[0]!.works[0]!.id;
  expect(job(inFlight)).toMatchObject({ status: "leased", lease_owner: i.owner });
  // the server goes idle with the capture still in flight (the owed capture drains while idle), and its helper dies: the deferral
  // runs as memory-worker, so the idle rule refuses it and names the roll, 50 s away
  at = 10_000; ioBudget.setIsIdle(() => true);
  helpers[0]!.crash(1);
  expect(job(inFlight)).toMatchObject({ status: "leased", lease_owner: i.owner });
  expect(i.deferredFailure, "the refused deferral arms its own retry").not.toBeNull();
  // the owner sends a message: the server is active, the arrival moves the deferral's retry to now and the queue claims at once
  ioBudget.setIsIdle(() => false);
  const sentAt = performance.now();
  appendMessage("fixture-thread", { id: "fixture-arrival", at: 2, role: "user", kind: "text", text: "And the second preference." });
  const arrival = String((database().prepare("SELECT id FROM memory_jobs WHERE id<>?").get(inFlight) as { id: string }).id);
  await vi.waitFor(() => expect(job(inFlight).status).not.toBe("leased"), { timeout: 4_000, interval: 25 });
  expect(i.deferredFailure).toBeNull();
  await vi.waitFor(() => expect(helpers.flatMap(h => h.works.map(w => w.id))).toContain(arrival), { timeout: 8_000, interval: 25 });
  expect(performance.now() - sentAt).toBeLessThan(8_000);
  expect(job(arrival)).toMatchObject({ status: "leased", lease_owner: i.owner });
  expect(i.bgRetryAt, "a refused failWork deferral never paces the capture queue").toBe(0);
}, 30_000);
