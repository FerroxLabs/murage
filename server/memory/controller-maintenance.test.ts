// R2: the parking maintenance decision sits on a path every dispatch reaches,
// projection batches included, so a projection queue that never empties cannot
// starve it. The real MemoryWorkerController runs with a stand-in worker.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkReconcile, resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

const calls = vi.hoisted(() => ({ maintenance: 0 }));
vi.mock("./park.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./park.ts")>();
  return { ...actual, parkMaintenanceStep: (...args: Parameters<typeof actual.parkMaintenanceStep>) => { calls.maintenance++; return actual.parkMaintenanceStep(...args); } };
});

// Pacing is not under test here: no cycle earns a pause.
vi.mock("./claim-trace.ts", async importOriginal => ({ ...(await importOriginal<typeof import("./claim-trace.ts")>()), memoryTickGapMs: () => 0 }));

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void; tick(): void };
let controller: MemoryWorkerController, internals: Internals, batches: number;

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetParkReconcile();
  calls.maintenance = 0; batches = 0;
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    if (message.type === "index") { batches++; internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records, embeddingStatus: "indexed" }); }
  } };
  internals.ready = true;
});
afterEach(async () => { await controller.stop().catch(() => {}); vi.restoreAllMocks(); });

/** More pending projection receipts than 16 batches of 16 can drain. */
function projectionBacklog(records: number) {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database();
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.exec("BEGIN");
  for (let i = 0; i < records; i++) {
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','t','a','active',0,0)").run(`r${i}`, scope);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(`r${i}`);
  }
  db.exec("COMMIT");
}
/** The acknowledgement of a projection batch is applied after the IPC handler returns. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const pending = () => Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='pending'").get()!.n);

it("a projection queue that never empties still reaches parking maintenance within 16 work cycles", async () => {
  projectionBacklog(16 * 20);
  for (let i = 0; i < 16; i++) { internals.tick(); await settle(); }
  expect(batches).toBe(16);
  expect(pending()).toBeGreaterThan(0);  // the queue was not empty at any of the 16 cycles
  expect(calls.maintenance).toBeGreaterThanOrEqual(1);
});

it("maintenance does not run on cycles before the sixteenth while projection work stands", async () => {
  projectionBacklog(16 * 20);
  for (let i = 0; i < 15; i++) { internals.tick(); await settle(); }
  expect(batches).toBe(15);
  expect(calls.maintenance).toBe(0);
});
