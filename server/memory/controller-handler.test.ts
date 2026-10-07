// The worker's IPC handler returns quickly: the projection receipts of an index-result, and the publication
// and checkpoint refresh of a finished job, are written on the next turn of the event loop, in the same
// order and transactions as before, while the job stays held so nothing else is claimed in between.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkReconcile, resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const slow = vi.hoisted(() => ({ ms: 0 }));
vi.mock("../database.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  return { ...actual, transaction: ((operation: any) => actual.transaction((db: any) => { const result = operation(db); const end = performance.now() + slow.ms; while (performance.now() < end) { /* a write that takes this long */ } return result; })) as typeof actual.transaction };
});

type Internals = { child: unknown; ready: boolean; indexing: boolean; indexRequestId: string | null; work: MemoryWork | null; onWorkerMessage(child: unknown, message: unknown): void; tick(): void };
let controller: MemoryWorkerController, internals: Internals, sent: MemoryWork[];
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetParkReconcile();
  slow.ms = 0; sent = [];
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => { if (message.type !== "index") sent.push(message); } };
  internals.ready = true;
});
afterEach(async () => { await controller.stop().catch(() => {}); });

it("an index-result of 16 rows returns the handler in under 20 ms however long the write takes, and the receipts follow", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id), records: Array<{ id: string; version: number; deleted: boolean }> = [];
  for (let i = 0; i < 16; i++) {
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','t','a','active',0,0)").run(`r${i}`, scope);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(`r${i}`);
    records.push({ id: `r${i}`, version: 1, deleted: false });
  }
  internals.indexing = true; internals.indexRequestId = "req";
  slow.ms = 120;
  const started = performance.now();
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "req", records, embeddingStatus: "indexed" });
  expect(performance.now() - started).toBeLessThan(20);
  expect(internals.indexing).toBe(true);
  await settle();
  expect(internals.indexing).toBe(false);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n)).toBe(16);
});

it("a finished job is published after the handler returns, and stays held until then", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence number 0" });
  internals.tick();
  expect(sent).toHaveLength(1);
  const work = sent[0];
  slow.ms = 120;
  const started = performance.now();
  internals.onWorkerMessage(internals.child, { type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes,
    chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });
  expect(performance.now() - started).toBeLessThan(20);
  expect(internals.work).not.toBeNull();
  expect(String(database().prepare("SELECT status FROM memory_jobs WHERE id=?").get(work.id)!.status)).toBe("leased");
  await settle();
  expect(internals.work).toBeNull();
  expect(String(database().prepare("SELECT status FROM memory_jobs WHERE id=?").get(work.id)!.status)).toBe("complete");
});
