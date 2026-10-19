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
import { MemoryWorkerController } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const slices = vi.hoisted(() => ({ ms: [] as number[], on: false }));
vi.mock("../database.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  return { ...actual, transaction: ((operation: any) => {
    if (!slices.on) return actual.transaction(operation);
    const started = performance.now();
    try { return actual.transaction(operation); } finally { slices.ms.push(performance.now() - started); }
  }) as typeof actual.transaction };
});

type Internals = { child: unknown; ready: boolean; indexing: boolean; indexRequestId: string | null; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetParkReconcile();
  slices.ms = []; slices.on = false;
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send() {} };
  internals.ready = true;
});
afterEach(async () => { slices.on = false; await controller.stop().catch(() => {}); });

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
  expect(internals.indexing).toBe(false);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n)).toBe(30_000);
  expect(slices.ms.length).toBeGreaterThan(1);
  expect(Math.max(...slices.ms)).toBeLessThanOrEqual(50);
}, 120_000);
