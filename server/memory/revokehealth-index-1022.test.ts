// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (worker-controller.ts indexBatchFailed and the suspect-alone selection, projection.ts PENDING,
// optional-index.ts required-build backoff). Consumers: the memory helper (worker.ts, its index batches) and server/index.ts's idle sweep
// (buildOptionalIndexesWhenIdle), owned by the memory lane.
//
// 1.0.22 revokehealth item 8 (HIDDEN-COST-fable H8, M26): one record whose batch always fails (the helper's index-error, a helper that dies
// on it, or one that never answers) blocked every record behind it, for good; and a required index whose build failed started a new
// worker at every 30 s idle sweep.
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { REQUIRED_INDEXES, buildOptionalIndexOffThread, buildOptionalIndexesWhenIdle, registerRequiredIndex } from "./optional-index.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { migrateMemorySchema } from "./schema.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
type Fault = "error" | "crash" | "silent";
type IndexMessage = { type?: string; requestId?: string; records?: Array<{ id: string; version: number; deleted: boolean }> };
/** A helper that indexes every batch, except one holding `bad-record`: that batch fails the way `fault` says. */
class Helper extends EventEmitter {
  connected = true; stderr = null;
  fault: Fault; batches: string[][];
  constructor(fault: Fault, batches: string[][]) { super(); this.fault = fault; this.batches = batches; }
  send = vi.fn((message: IndexMessage) => {
    if (message.type === "init") setTimeout(() => { this.emit("message", { type: "index-opening" }); this.emit("message", { type: "initialised" }); }, 0);
    if (message.type === "index") {
      const records = message.records ?? [];
      this.batches.push(records.map(r => r.id));
      setTimeout(() => {
        if (!records.some(r => r.id === "bad-record")) this.emit("message", { type: "index-result", requestId: message.requestId, records: records.map(r => ({ id: r.id, version: r.version, deleted: r.deleted })), embeddingStatus: "indexed" });
        else if (this.fault === "error") this.emit("message", { type: "index-error" });
        else if (this.fault === "crash") this.crash(1);
      }, 0);
    }
    return true;
  });
  kill() { this.crash(0); return true; } disconnect() { this.crash(0); }
  crash(code: number) { if (!this.connected) return; this.connected = false; this.emit("exit", code, null); }
}
let controller: MemoryWorkerController | undefined;
const dirs: string[] = [], dbs: DatabaseSync[] = [];
// each case starts with fresh write admission (an earlier case's helper writes and refusals are not carried into the next)
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); ioBudget.resetAdmissionForFixture(); ioBudget.resetBgRelief(); });
afterEach(async () => {
  await controller?.stop(); controller = undefined; closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const db of dbs.splice(0)) try { db.close(); } catch { /* closed */ }
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

it.each<[Fault]>([["error"], ["crash"], ["silent"]])("W-INDEX-SKIP (%s) a record whose batch always fails is tried alone, skipped after 3, and the records beside it are indexed", async fault => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-25T00:00:00Z"));
  reconcileMemoryRoster({ bots: [{ id: "a", threadId: "thread-a" }], groups: [] }); setMemoryMode("capture");
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  for (const id of ["bad-record", "good-1", "good-2"]) {
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','fixture text','owner-statement','active',0,0)").run(id, scope);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
  }
  const batches: string[][] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(fault, batches); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  vi.spyOn(ioBudget, "backgroundRoom").mockReturnValue(1 << 30);
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  // the first batch goes about 14 min after start (the start's own gates); each crash or timed-out batch then costs a respawn
  await vi.advanceTimersByTimeAsync(40 * 60_000);
  expect(batches.length, "fixture: index batches were sent").toBeGreaterThan(0);
  const receipt = (id: string) => db.prepare("SELECT lexical_status AS status,error FROM memory_projection_receipts WHERE record_id=?").get(id)!;
  expect([receipt("good-1").status, receipt("good-2").status], "the records beside the bad one are indexed").toEqual(["indexed", "indexed"]);
  expect(receipt("bad-record"), "the bad record is skipped, its receipt kept").toEqual({ status: "pending", error: "MEMORY_INDEX_RECORD_SKIPPED" });
  const sent = batches.length;
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(batches.length, "a skipped record is not sent again").toBe(sent);
});

it("W-INDEX-SKIP-DELETE a removal whose batch always fails is never skipped (a forget's index scrub stays owed)", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-25T00:00:00Z"));
  reconcileMemoryRoster({ bots: [{ id: "a", threadId: "thread-a" }], groups: [] }); setMemoryMode("capture");
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('bad-record',1,?,'fact','','owner-statement','deleted',0,0)").run(scope);
  db.prepare("INSERT INTO memory_projection_receipts VALUES('bad-record',1,0,'delete-pending','pending',NULL)").run();
  const batches: string[][] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper("error", batches); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  vi.spyOn(ioBudget, "backgroundRoom").mockReturnValue(1 << 30);
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  controller.start();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(batches.length, "fixture: the removal was sent more than 3 times").toBeGreaterThan(3);
  expect(db.prepare("SELECT lexical_status AS status,error FROM memory_projection_receipts WHERE record_id='bad-record'").get()).toEqual({ status: "delete-pending", error: null });
});

it("W-REQIDX-BACKOFF a required index whose build fails on its worker is not started again at every idle sweep: it waits 1 min, then doubles", async () => {
  const { setReadTimeJudgeRetired } = await import("./root-set-reclaim.ts");
  setReadTimeJudgeRetired(true);
  const bad = registerRequiredIndex({ name: "fixture_required_broken", table: "memory_records", minSchemaVersion: 0, sql: "CREATE INDEX IF NOT EXISTS fixture_required_broken ON memory_records(no_such_column)" });
  const log = vi.spyOn(console, "log");
  try {
    const dir = mkdtempSync(join(tmpdir(), "reqidx-backoff-")); dirs.push(dir);
    const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    migrateMemorySchema(db, "active");
    for (const index of REQUIRED_INDEXES) if (index !== bad) await buildOptionalIndexOffThread(db, index, { inline: true });
    const idle = { ownerIdleMs: () => 3_600_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
    const starts = () => log.mock.calls.filter(([line]) => String(line).includes("index build start name=fixture_required_broken")).length;
    let now = Date.parse("2026-11-25T00:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // idle sweeps every 30 s (at 0, 30, 60 ... s): the failed build waits 1 min, then 2 min (doubling); base starts a worker at every sweep
    const sweep = async () => { await buildOptionalIndexesWhenIdle(db, idle); now += 30_000; };
    await sweep(); await sweep();
    expect(starts(), "the sweep 30 s after a failed build starts no worker for it").toBe(1);
    await sweep();
    expect(starts(), "after its 1 min wait the build is tried again").toBe(2);
    await sweep(); await sweep(); await sweep();
    expect(starts(), "the second failure waits 2 min: three sweeps start nothing").toBe(2);
    await sweep();
    expect(starts(), "after 2 min it is tried again").toBe(3);
  } finally { REQUIRED_INDEXES.splice(REQUIRED_INDEXES.indexOf(bad), 1); setReadTimeJudgeRetired(false); }
});
