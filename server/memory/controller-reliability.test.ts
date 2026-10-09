// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROPOSAL-v2 10.4 and 10.1 item 7, with the real MemoryWorkerController and a stand-in child:
// errors clear per subsystem at the end of the next clean unit, a held write lock is neither an error nor an
// attempt, quitting spends no attempt, and a turn between its slot and its send keeps the worker off the main thread.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController, TURN_HOLD_MAX_MS } from "./worker-controller.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { resetMemoryClaimCursor } from "./jobs.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const state = vi.hoisted(() => ({ claimThrows: null as Error | null, claims: 0 }));
vi.mock("./jobs.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return { ...actual, claimMemoryJob: (...args: Parameters<typeof actual.claimMemoryJob>) => {
    if (state.claimThrows) throw state.claimThrows;
    const work = actual.claimMemoryJob(...args);
    if (work) state.claims++;
    return work;
  } };
});

type Internals = { child: unknown; ready: boolean; work: MemoryWork | null; indexing: boolean; onWorkerMessage(child: unknown, message: unknown): void; failWork(reason: string): void; tick(requested?: boolean): void; error: string | null; errors: Map<string, string> };
let controller: MemoryWorkerController, internals: Internals, sent: Array<Record<string, any>>, lines: string[], other: DatabaseSync | null;

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetMemoryClaimCursor();
  state.claimThrows = null; state.claims = 0; sent = []; lines = []; other = null; resetWorkerLog(); resetObserveWindows(); setObserveSink(line => lines.push(line));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  // the controller's pacing and the turn hold count on the monotonic clock: it follows the fake clock here
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => { sent.push(message); } };
  internals.ready = true;
});
afterEach(async () => { try { other?.close(); } catch { /* closed */ } await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); setObserveSink(); });

const messages = (n: number) => { for (let i = 0; i < n; i++) appendMessage("thread", { id: `m${i}`, ...(i ? { parentId: `m${i - 1}` } : {}), at: i + 1, role: "user", kind: "text", text: `Durable evidence number ${i}` }); };
const jobs = () => database().prepare("SELECT status,attempts,error FROM memory_jobs ORDER BY rowid").all().map(row => ({ status: String(row.status), attempts: Number(row.attempts), error: row.error === null ? null : String(row.error) }));
const resultFor = (work: MemoryWork) => ({ type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes, chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });

it("a tick that throws shows MEMORY_WORKER_UNAVAILABLE, logs its cause, and the next clean tick clears it", async () => {
  messages(1);
  state.claimThrows = new Error("INVALID_SOMETHING");
  controller.start();
  await vi.advanceTimersByTimeAsync(50);
  expect(controller.error).toBe("MEMORY_WORKER_UNAVAILABLE");
  expect(lines.some(line => line.includes("subsystem=capture cause=INVALID_SOMETHING"))).toBe(true);
  state.claimThrows = null;
  controller.wake();
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.error).toBeNull();
  expect(state.claims).toBeGreaterThan(0);
});

it("a held write lock is not an error: nothing is shown, no attempt is spent, and the work follows once the lock is gone", async () => {
  messages(1);
  database();
  other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  controller.start();
  await vi.advanceTimersByTimeAsync(300);
  expect(controller.error).toBeNull();
  expect(sent.filter(message => message.stage === "capture")).toHaveLength(0);
  expect(jobs()).toEqual([{ status: "pending", attempts: 0, error: null }]);
  other.exec("ROLLBACK");
  await vi.advanceTimersByTimeAsync(1500);
  expect(sent.filter(message => message.stage === "capture")).toHaveLength(1);
});

it("errors clear per subsystem: a clean capture does not hide a failing index, and a good index batch does not hide a capture failure", async () => {
  messages(1);
  controller.start();
  await vi.advanceTimersByTimeAsync(100);
  const work = sent.find(message => message.stage === "capture") as MemoryWork;
  expect(work).toBeTruthy();
  internals.onWorkerMessage(internals.child, { type: "index-error", reason: "MEMORY_INDEX_FAILED" });
  expect(controller.error).toBe("MEMORY_INDEX_FAILED");
  internals.onWorkerMessage(internals.child, resultFor(work));
  await vi.advanceTimersByTimeAsync(10);
  expect(jobs()[0].status).toBe("complete");
  expect(controller.error).toBe("MEMORY_INDEX_FAILED");  // the capture succeeding clears the capture subsystem only
  expect(controller.status().errors).toEqual({ index: "MEMORY_INDEX_FAILED" });
});

it("a worker that goes away because Murage is quitting spends no attempt and shows no error; one that crashes spends one", async () => {
  messages(2);
  controller.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(internals.work).toBeTruthy();
  internals.failWork("MEMORY_WORKER_STOPPED");
  controller.wake();  // (the exit handler asks for the next tick in a real run)
  expect(controller.error).toBeNull();
  expect(jobs()[0]).toMatchObject({ status: "deferred", attempts: 0, error: "transient:1:MEMORY_WORKER_STOPPED" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(internals.work).toBeTruthy();
  internals.failWork("MEMORY_WORKER_EXITED");
  expect(controller.error).toBe("MEMORY_WORKER_EXITED");
  expect(jobs().filter(job => job.attempts === 1)).toHaveLength(1);
});

it("a turn between its slot and its send keeps the worker's claims off the main thread, for at most the hold limit", async () => {
  messages(1);
  const release = controller.holdForTurn();
  controller.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.claims).toBe(0);
  expect(sent).toHaveLength(0);
  release();
  await vi.advanceTimersByTimeAsync(200);
  expect(state.claims).toBe(1);
});

it("a hold that is never released ends by itself after the hold limit", async () => {
  messages(1);
  controller.holdForTurn();
  controller.start();
  await vi.advanceTimersByTimeAsync(TURN_HOLD_MAX_MS - 500);
  expect(state.claims).toBe(0);
  await vi.advanceTimersByTimeAsync(1500);
  expect(state.claims).toBe(1);
});

it("receipts for an indexed batch wait for the turn too, then are written", async () => {
  database().prepare("INSERT INTO memory_scopes VALUES('s','conversation','o','[]',0)").run();
  database().prepare("INSERT INTO memory_records VALUES('r',1,'s','fact','text','owner-statement','active',0,0,NULL,NULL,0)").run();
  database().prepare("INSERT INTO memory_projection_receipts VALUES('r',1,1,'pending','pending',NULL)").run();
  const release = controller.holdForTurn();
  internals.indexing = true;
  (controller as unknown as { indexRequestId: string }).indexRequestId = "req";
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "req", records: [{ id: "r", version: 1, deleted: false }], embeddingStatus: "indexed" });
  await vi.advanceTimersByTimeAsync(500);
  expect(database().prepare("SELECT lexical_status FROM memory_projection_receipts").get()?.lexical_status).toBe("pending");
  release();
  await vi.advanceTimersByTimeAsync(300);
  expect(database().prepare("SELECT lexical_status FROM memory_projection_receipts").get()?.lexical_status).toBe("indexed");
});

it("publishing waits out a held write lock instead of failing the job", async () => {
  messages(1);
  controller.start();
  await vi.advanceTimersByTimeAsync(100);
  const work = sent.find(message => message.stage === "capture") as MemoryWork;
  other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  internals.onWorkerMessage(internals.child, resultFor(work));
  await vi.advanceTimersByTimeAsync(600);
  expect(jobs()[0]).toMatchObject({ status: "leased", attempts: 0 });
  expect(controller.error).toBeNull();
  other.exec("ROLLBACK");
  await vi.advanceTimersByTimeAsync(600);
  expect(jobs()[0]).toMatchObject({ status: "complete", attempts: 0 });
});

it("failed jobs with a transient cause are given their attempts back when the controller starts", () => {
  messages(1);
  database().prepare("UPDATE memory_jobs SET status='failed',attempts=3,error='MEMORY_WORKER_EXITED'").run();
  controller.start();
  expect(jobs()[0]).toMatchObject({ status: "pending", attempts: 0, error: "redriven:MEMORY_WORKER_EXITED" });
});
