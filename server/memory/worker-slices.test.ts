// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A worker message applied on the main thread is applied in slices: a large index-result writes its receipts
// a slice at a time, each its own transaction of at most about 50 ms, with a turn of the event loop between.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction as realTransaction } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkReconcile, resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController, workerSliceTestHooks } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// `ms` is the wall time of each whole slice transaction (commit included): printed, not asserted. `rowCpuMs` is the process CPU time of
// each slice's row work, the part WORKER_SLICE_MS controls: that is what the 50 ms bound applies to.
const slices = vi.hoisted(() => ({ ms: [] as number[], rowCpuMs: [] as number[], on: false, refuseNext: false, maximumRows: Infinity }));
vi.mock("../database.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  const { BgDeferred } = await import("../bg-admission.ts");
  return { ...actual, transaction: ((operation: any) => {
    if (!slices.on) return actual.transaction(operation);
    const started = performance.now();
    try {
      if (slices.refuseNext) { slices.refuseNext = false; throw new actual.DatabaseBusyError("fixture-receipt", 0); }
      return actual.transaction(db => {
        const count = () => Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n);
        const before = Number.isFinite(slices.maximumRows) ? count() : 0;
        const result = operation(db);
        if (Number.isFinite(slices.maximumRows) && count() - before > slices.maximumRows) throw new BgDeferred(1);
        return result;
      });
    } finally { slices.ms.push(performance.now() - started); }
  }) as typeof actual.transaction };
});

type Internals = { child: unknown; ready: boolean; indexing: boolean; indexRequestId: string | null; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetParkReconcile();
  slices.ms = []; slices.rowCpuMs = []; slices.on = false; slices.refuseNext = false; slices.maximumRows = Infinity;
  workerSliceTestHooks.rowWorkCpuMs = ms => { if (slices.on) slices.rowCpuMs.push(ms); };
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send() {} };
  internals.ready = true;
});
afterEach(async () => { slices.on = false; workerSliceTestHooks.rowWorkCpuMs = null; await controller.stop().catch(() => {}); });

// A wall-clock bound on a real 30,000-row write (what the owner feels): 3.7 s alone, but 52-106 ms for a slice when other work contends for the CPU.
// Only the wall-clock assertion requires the serial timing run (MURAGE_TEST_TIMING=1).
// Completion, every receipt, and multiple transactions are checked in ordinary runs too.
it("an index-result of 30,000 rows is written in slices of at most 50 ms each, and every receipt lands", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  const records: Array<{ id: string; version: number; deleted: boolean }> = [];
  realTransaction(() => {
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','t','a','active',0,0)");
    const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
    for (let i = 0; i < 30_000; i++) { record.run(`r${i}`, scope); receipt.run(`r${i}`); records.push({ id: `r${i}`, version: 1, deleted: false }); }
  });
  internals.indexing = true; internals.indexRequestId = "req";
  (controller as unknown as { indexSent: Map<string, string> }).indexSent = new Map(records.map(row => [`${row.id}\u0000${row.version}`, "active"]));
  slices.on = true;
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "req", records, embeddingStatus: "indexed" });
  const deadline = Date.now() + 60_000;
  while (internals.indexing && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  slices.on = false;
  if (internals.indexing) console.log(JSON.stringify({ receiptRows: Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n), transactions: slices.ms.length, rowCpuSamples: slices.rowCpuMs.length, admission: (await import("../io-budget.ts")).ioBudget.admissionState(), grant: (await import("../io-meter.ts")).ioGrantSnapshot() }));
  expect(internals.indexing).toBe(false);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n)).toBe(30_000);
  expect(slices.ms.length).toBeGreaterThan(1);
  if (process.env.MURAGE_TEST_TIMING === "1") expect(Math.max(...slices.ms)).toBeLessThanOrEqual(50);
  expect(slices.rowCpuMs.length).toBe(slices.ms.length);
  console.log(`WORKER-SLICES wall_max_ms=${Math.max(...slices.ms).toFixed(1)} (commit included) count=${slices.ms.length} rowcpu_max_ms=${Math.max(...slices.rowCpuMs).toFixed(1)}`);
  expect(Math.max(...slices.rowCpuMs)).toBeLessThanOrEqual(50);
}, 120_000);

it("reports one row CPU sample when BEGIN is refused and the receipt transaction retries", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  realTransaction(() => {
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('retry-row',1,?,'fact','t','a','active',0,0)").run(scope);
    db.exec("INSERT INTO memory_projection_receipts VALUES('retry-row',1,0,'pending','pending',NULL)");
  });
  internals.indexing = true; internals.indexRequestId = "retry";
  (controller as unknown as { indexSent: Map<string, string> }).indexSent = new Map([["retry-row\u00001", "active"]]);
  slices.on = true; slices.refuseNext = true;
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "retry", records: [{ id: "retry-row", version: 1, deleted: false }], embeddingStatus: "indexed" });
  const deadline = Date.now() + 60_000;
  while (internals.indexing && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  slices.on = false;
  // MAIN RULING 2026-11-14 one sample per transaction attempt, including the retried attempt
  expect(internals.indexing).toBe(false);
  expect(slices.ms.length).toBeGreaterThanOrEqual(2);
  expect(slices.rowCpuMs).toHaveLength(slices.ms.length);
  expect(slices.rowCpuMs[0]).toBe(0);
  expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='retry-row'").get()?.lexical_status).toBe("indexed");
});

it("shrinks a refused receipt slice and reports CPU for its rolled-back attempt", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  realTransaction(() => {
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','t','a','active',0,0)");
    const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
    for (const id of ["retry-a", "retry-b"]) { record.run(id, scope); receipt.run(id); }
  });
  internals.indexing = true; internals.indexRequestId = "smaller";
  (controller as unknown as { indexSent: Map<string, string> }).indexSent = new Map([["retry-a\u00001", "active"], ["retry-b\u00001", "active"]]);
  slices.on = true; slices.maximumRows = 1;
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "smaller", records: ["retry-a", "retry-b"].map(id => ({ id, version: 1, deleted: false })), embeddingStatus: "indexed" });
  const deadline = Date.now() + 60_000;
  while (internals.indexing && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  slices.on = false;
  // MAIN RULING 2026-11-14 one sample per transaction attempt, including the retried attempt; receipt grant and CPU bounds stay
  expect(internals.indexing).toBe(false);
  expect(slices.ms.length).toBeGreaterThanOrEqual(3);
  expect(slices.rowCpuMs).toHaveLength(slices.ms.length);
  expect(Math.max(...slices.rowCpuMs)).toBeLessThanOrEqual(50);
  expect(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id IN ('retry-a','retry-b') AND lexical_status='indexed'").get()!.n).toBe(2);
});

it("with the turn trace on, each slice logs one numbers-only memory.indexSlice line, after its commit; off, nothing", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  const records: Array<{ id: string; version: number; deleted: boolean }> = [];
  realTransaction(() => {
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','t','a','active',0,0)");
    const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
    for (let i = 0; i < 3_000; i++) { record.run(`r${i}`, scope); receipt.run(`r${i}`); records.push({ id: `r${i}`, version: 1, deleted: false }); }
  });
  const drain = async (requestId: string) => {
    internals.indexing = true; internals.indexRequestId = requestId;
    (controller as unknown as { indexSent: Map<string, string> }).indexSent = new Map(records.map(row => [`${row.id}\u0000${row.version}`, "active"]));
    internals.onWorkerMessage(internals.child, { type: "index-result", requestId, records, embeddingStatus: "indexed" });
    const deadline = Date.now() + 60_000;
    while (internals.indexing && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
    expect(internals.indexing).toBe(false);
  };
  const previous = process.env.MURAGE_TURN_TRACE;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    process.env.MURAGE_TURN_TRACE = "1";
    await drain("req-on");
    const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.includes("phase=memory.indexSlice"));
    expect(lines.length).toBeGreaterThan(1);
    let rows = 0;
    for (const line of lines) {
      const match = /^\[turn-trace\] phase=memory\.indexSlice ms=(\d+\.\d) rowMs=(\d+\.\d) rows=(\d+)$/.exec(line);
      expect(match, line).not.toBeNull();
      expect(Number(match![2])).toBeLessThanOrEqual(Number(match![1]));
      rows += Number(match![3]);
    }
    expect(rows).toBe(3_000);
    log.mockClear();
    process.env.MURAGE_TURN_TRACE = "0";
    await drain("req-off");
    expect(log.mock.calls.filter(call => String(call[0]).includes("memory.indexSlice"))).toEqual([]);
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.MURAGE_TURN_TRACE; else process.env.MURAGE_TURN_TRACE = previous;
  }
}, 120_000);
