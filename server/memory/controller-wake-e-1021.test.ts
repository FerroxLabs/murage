// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memv2 lane E (worker-controller.ts: the jobs topic's open probe, the helper-exit handler, the boot capture step).
// Owner of probeWakes/setWakeProbe/onWake (wake.ts): lane W. Owner of BgDeferred's reservationWait (io-budget refusalRetry): lane D.
//
// Four rows (int-1021-n4 board, and design 4.1 E6 for the last): (1) Astra final #8: a capture job is born complete, so the only row that says a checkpoint
// is owed is its debt binding; the jobs topic's open probe must see it. (2) Design 3.1: when the memory helper goes away the main thread
// runs the open-time probes again ("helper-restart"). (3) memv2-D B3: a boot recovery step refused on a missed ledger lock
// (reservationWait) retries at its own short delay, not at the budget's next minute.
// (4) a lost index acknowledgement asks the helper for one rolled-checkpoint walk (worker-rolled-pass-1021.test.ts has the helper side).
// (5) B5 hook (added by memv2-D, owned by lane E): the running helper stays registered as a WAL reader whatever an older helper's late exit does.
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { appendMessage } from "../message-db.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import type { Message } from "../store.ts";
import { captureMessage } from "./capture.ts";
import { releaseDeadProcessLeases } from "./jobs.ts";
import { setMemoryMode } from "./repository.ts";
import { drainWakesNow, onWake, probeWakes, wakeInstalled } from "./wake.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

vi.mock("./jobs.ts", async original => {
  const actual = await original<typeof import("./jobs.ts")>();
  return { ...actual, releaseDeadProcessLeases: vi.fn(actual.releaseDeadProcessLeases) };
});
vi.mock("./wake.ts", async original => {
  const actual = await original<typeof import("./wake.ts")>();
  return { ...actual, probeWakes: vi.fn(actual.probeWakes) };
});
// the receipt write of an index batch fails outright once (not a deferral, not a busy lock): the real writer otherwise
const receiptFault = vi.hoisted(() => ({ armed: false }));
vi.mock("./recall-view-schema.ts", async original => {
  const actual = await original<typeof import("./recall-view-schema.ts")>();
  return { ...actual, coverReceiptChanges: vi.fn((...args: Parameters<typeof actual.coverReceiptChanges>) => {
    if (receiptFault.armed) { receiptFault.armed = false; throw new Error("fixture: receipt write failed"); }
    return actual.coverReceiptChanges(...args);
  }) };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), fork: vi.fn() }));
// B5 hook (E-owned): the WAL readers registered now, as wal-maintenance.ts holds them (the real registry, observed)
const walReaders = vi.hoisted(() => new Set<{ name: string; release?: (done: () => void) => void }>());
vi.mock("../wal-maintenance.ts", async original => {
  const actual = await original<typeof import("../wal-maintenance.ts")>();
  return { ...actual, registerWalReader: vi.fn((reader: Parameters<typeof actual.registerWalReader>[0]) => {
    const off = actual.registerWalReader(reader); walReaders.add(reader);
    return () => { walReaders.delete(reader); off(); };
  }) };
});

const T = "t-wake";
class Helper extends EventEmitter {
  connected = true; stderr = null;
  works = 0;
  send = vi.fn((message: { type?: string; id?: string; leaseGeneration?: number }) => {
    if (message.type === "init") setTimeout(() => { this.emit("message", { type: "index-opening" }); this.emit("message", { type: "initialised" }); }, 0);
    else if (typeof message.id === "string" && "leaseGeneration" in message) this.works++; // holds the capture it is sent
    return true;
  });
  kill() { this.crash(0); return true; } disconnect() { this.crash(0); }
  crash(code: number) { this.connected = false; this.emit("exit", code, null); }
}
let controller: MemoryWorkerController | undefined;
const unsubscribe: (() => void)[] = [];
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  vi.mocked(releaseDeadProcessLeases).mockClear(); vi.mocked(probeWakes).mockClear(); vi.mocked(fork).mockReset();
});
afterEach(async () => { for (const off of unsubscribe.splice(0)) off(); await controller?.stop(); controller = undefined; closeDatabase(); vi.restoreAllMocks(); });

/** A tool outcome as the server writes it: its capture job is born complete and owes the thread's checkpoint (one debt binding). */
function toolOutcome(id: string, text: string) {
  const db = database();
  transaction(() => { storeAnchorMessage(db, T, id, text, "bot"); captureMessage(db, T, { id, at: 1, role: "bot", kind: "activity", text, tool: { name: "read_file", ok: true } } as unknown as Message); });
}
const debts = () => Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending'").get()!.n);
const pending = () => Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','deferred','leased')").get()!.n);

it("W-E8-PROBE the jobs topic's open probe raises for a checkpoint a born-complete job still owes, and stays quiet once it is rolled", () => {
  const db = database();
  expect(wakeInstalled(db), "the wake bus is installed on the real connection").toBe(true);
  expect(probeWakes("open"), "an empty store owes nothing").not.toContain("jobs");
  toolOutcome("tool-1", "notes-1.md: 4 lines kept");
  // the fixture is the case the row is about: no claimable job, only the debt binding
  expect(pending()).toBe(0); expect(debts()).toBe(1);
  expect(probeWakes("open")).toContain("jobs");
  // the probe is two seeks on named indexes, never a scan
  for (const sql of ["SELECT 1 FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status IN ('pending','partial','deferred','leased') LIMIT 1",
    "SELECT 1 FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' LIMIT 1"]) {
    expect(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all())).toMatch(/SEARCH .* USING (COVERING )?INDEX/);
  }
  db.prepare("DELETE FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending'").run();
  expect(probeWakes("open"), "nothing owed, nothing pending: no wake").not.toContain("jobs");
});

it("W-E-RESTART a helper that exits unasked makes the main thread run the open-time probes again, which see the owed checkpoint and wake the jobs topic", async () => {
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  // a helper is started for queued work: one owner message, whose capture the scripted helper holds
  appendMessage(T, { id: "ask", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works).toBe(1), { timeout: 4_000, interval: 25 });
  let jobsWakes = 0;
  unsubscribe.push(onWake("jobs", () => { jobsWakes++; }));
  // the controller rolls an owed checkpoint itself within a tick, so the debt is written and the helper goes in one synchronous span:
  // a born-complete job's INSERT fires no jobs trigger, only the probe can see the debt
  toolOutcome("tool-1", "notes-1.md: 4 lines kept");
  drainWakesNow(); jobsWakes = 0; vi.mocked(probeWakes).mockClear();
  expect(debts(), "the checkpoint is still owed when the helper goes").toBe(1);
  helpers[0]!.crash(1);
  const call = vi.mocked(probeWakes).mock.calls.findIndex(args => args[0] === "helper-restart");
  expect(call, "the exit handler ran the open-time probes").toBeGreaterThanOrEqual(0);
  expect(vi.mocked(probeWakes).mock.results[call]!.value).toContain("jobs");
  // the held capture is requeued by the exit too, so this wake alone does not prove the debt seek: W-E8-PROBE does
  drainWakesNow();
  await vi.waitFor(() => { drainWakesNow(); expect(jobsWakes).toBeGreaterThan(0); }, { timeout: 2_000, interval: 10 });
  // a stop is not a restart: nothing is probed for a helper Murage itself sends away
  vi.mocked(probeWakes).mockClear();
  await controller.stop(); controller = undefined;
  expect(vi.mocked(probeWakes)).not.toHaveBeenCalledWith("helper-restart");
});

it("W-E-BOOT-LOCKMISS a boot release refused on a missed ledger lock retries at its own 250 ms, not at the budget's next minute", async () => {
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); return helper as unknown as ReturnType<typeof fork>; });
  vi.mocked(releaseDeadProcessLeases).mockImplementationOnce(() => { throw new BgDeferred(250, true); });
  vi.spyOn(ioBudget, "nextAdmissionMs").mockReturnValue(50_000);
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  const started = performance.now();
  controller.start();
  expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(vi.mocked(releaseDeadProcessLeases)).toHaveBeenCalledTimes(2), { timeout: 3_000, interval: 25 });
  expect(performance.now() - started).toBeLessThan(3_000);
});

it("W-E6-LOSTACK a lost index acknowledgement asks the helper for one rolled-checkpoint walk (design 4.1 E6: in place of its 5-minute re-walk)", async () => {
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  appendMessage(T, { id: "ask", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works).toBe(1), { timeout: 4_000, interval: 25 });
  const asked = () => helpers[0]!.send.mock.calls.filter(([message]) => message.type === "purge-rolled").length;
  expect(asked(), "a helper that answers is not asked").toBe(0);
  helpers[0]!.emit("message", { type: "index-error" });
  expect(asked(), "the helper's answer to an index batch was lost").toBe(1);
});

it("W-E6-LOSTACK-RECEIPT an index batch whose receipts fail to write (MEMORY_INDEX_FAILED) asks the helper for one rolled-checkpoint walk", async () => {
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  vi.spyOn(ioBudget, "backgroundRoom").mockReturnValue(1 << 30);
  appendMessage(T, { id: "ask", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works).toBe(1), { timeout: 4_000, interval: 25 });
  const asked = () => helpers[0]!.send.mock.calls.filter(([message]) => message.type === "purge-rolled").length;
  // an index batch is out (the controller's own bookkeeping for one; the helper answers it below)
  Object.assign(controller as unknown as { indexRequestId: string; indexing: boolean }, { indexRequestId: "batch-1", indexing: true });
  receiptFault.armed = true;
  helpers[0]!.emit("message", { type: "index-result", requestId: "batch-1", records: [{ id: "rec-1", version: 1, deleted: true }] });
  await vi.waitFor(() => expect(receiptFault.armed, "the receipt write ran").toBe(false), { timeout: 2_000, interval: 10 });
  await vi.waitFor(() => expect(asked(), "the helper's answer was lost with its receipts").toBe(1), { timeout: 2_000, interval: 10 });
});

it("W-E-W5-TRANSPORT an index-debt ask goes to the index-debt door (taken over from memv2-D): a grant is echoed as index-debt, a refusal is retried at that door's own time", async () => {
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  appendMessage(T, { id: "ask", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works).toBe(1), { timeout: 4_000, interval: 25 });
  // the door itself is memv2-D's (io-budget admitIndexDebt, index-debt-1021 / index-debt-controller-1021): here only what the controller carries
  const MiB = 1024 * 1024;
  const door = vi.spyOn(ioBudget, "admitIndexDebt").mockReturnValueOnce(null).mockReturnValueOnce({ kind: "BG", bytes: 20 * MiB } as unknown as ReturnType<typeof ioBudget.admitIndexDebt>);
  vi.spyOn(ioBudget, "indexDebtRetryMs").mockReturnValue(1_234);
  vi.spyOn(ioBudget, "nextAdmissionMs").mockReturnValue(50_000);
  const grants = () => helpers[0]!.send.mock.calls.map(([message]) => message as { type?: string; ticket?: { purpose?: string; bytes?: number } | null; retryInMs?: number }).filter(message => message.type === "bg-grant");
  helpers[0]!.emit("message", { type: "bg-grant-request", ceiling: 20 * MiB, purpose: "index-debt" });
  expect(door, "the index-debt door, not the minute's background ticket").toHaveBeenCalledWith(20 * MiB);
  expect(grants().at(-1)?.ticket, "refused").toBeNull();
  expect(grants().at(-1)?.retryInMs, "retried at the index-debt door's time, not the minute's").toBe(1_234);
  helpers[0]!.emit("message", { type: "bg-grant-request", ceiling: 20 * MiB, purpose: "index-debt" });
  expect(grants().at(-1)?.ticket?.purpose, "the grant names its purpose").toBe("index-debt");
  expect(grants().at(-1)?.ticket?.bytes).toBe(20 * MiB);
});

it("W-B5-LATE-EXIT a helper let go at stop whose exit comes after the next helper started leaves that helper registered as a WAL reader", async () => {
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  appendMessage(T, { id: "ask", at: 1, role: "user", kind: "text", text: "Remember the fixture preference." });
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  await vi.waitFor(() => expect(helpers[0]?.works).toBe(1), { timeout: 4_000, interval: 25 });
  expect([...walReaders].map(r => r.name)).toEqual(["memory helper"]);
  // the first helper hangs: neither the disconnect nor the kill is seen to land, so stop lets it go after its grace and kill wait
  const stuck = helpers[0]!;
  stuck.kill = () => true; stuck.disconnect = () => {};
  await controller.stop();
  expect(walReaders.size, "a helper let go is no longer asked").toBe(0);
  controller.start();
  appendMessage(T, { id: "ask-2", at: 2, role: "user", kind: "text", text: "Remember the second fixture preference." });
  // the next helper is started for the queued work and registers when it reports initialised
  await vi.waitFor(() => { expect(helpers).toHaveLength(2); expect(walReaders.size).toBe(1); }, { timeout: 12_000, interval: 25 });
  // now the first helper's exit arrives
  stuck.crash(0);
  expect([...walReaders].map(r => r.name), "the running helper is still registered").toEqual(["memory helper"]);
  // and the entry is the running helper's: a release asks it, not the dead one
  [...walReaders][0]!.release?.(() => {});
  expect(helpers[1]!.send.mock.calls.some(([message]) => message.type === "wal-release")).toBe(true);
  expect(stuck.send.mock.calls.some(([message]) => message.type === "wal-release")).toBe(false);
}, 40_000);
