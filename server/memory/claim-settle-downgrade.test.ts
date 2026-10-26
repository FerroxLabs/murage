// SPDX-License-Identifier: AGPL-3.0-or-later
// T12 (CLAIM-DESIGN-FABLE.md 6, I8): 1.0.2 -> 1.0.1 -> 1.0.2 on the same app version. The downgrade deletes the settle sweep's and the
// park reconciliation's done markers, 1.0.1's validator accepts the file, and the next v10 open runs both passes from the start over
// what 1.0.1 wrote (blocked jobs left pending, a parked job whose source it re-activated).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeInbox } from "../inbox.ts";
import { initializeMessageTables } from "../message-tables.ts";
import { downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { validateMemorySchema as validateMemorySchema101 } from "./testing/schema-1.0.1.ts";
import { claimSettleSweepStep, parkReconcileStep, parkStuckJobsStep, resetClaimSettleSweep, resetParkReconcile, resetParkSweep } from "./park.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const NOW = 1_000_000;
const MARKERS = "('memory-claim-settle-sweep','memory-parked-reconcile')";
let dir = "";
afterEach(() => { delete process.env.MURAGE_APP_VERSION; if (dir) removeTempDirSync(dir); dir = ""; resetClaimSettleSweep(); resetParkReconcile(); resetParkSweep(); });

/** A source with one version and one job (the columns every schema version has). */
function write(db: DatabaseSync, id: string, opts: { outcome?: string; state?: string; status?: string; error?: string | null } = {}) {
  db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,'scope-1','thread-1',?,NULL,1,?,'text','owner',?,NULL,?)")
    .run(`src-${id}`, `m-${id}`, `h-${id}`, opts.outcome ?? "recorded", opts.state ?? "active");
  db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)").run(`src-${id}`, `h-${id}`, JSON.stringify({ text: id }));
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch,error) VALUES(?,?,1,'capture','1',?,0,0,0,0,0,?)")
    .run(`job-${id}`, `src-${id}`, opts.status ?? "pending", opts.error ?? null);
}
const markers = (db: DatabaseSync) => db.prepare(`SELECT id,intent FROM memory_scope_bindings WHERE id IN ${MARKERS} ORDER BY id`).all().map(r => ({ id: String(r.id), done: JSON.parse(String(r.intent)).done }));
function settleToEnd(db: DatabaseSync) { let settled = 0, steps = 0; for (;;) { const r = claimSettleSweepStep(db, () => {}, NOW); settled += r.settled; steps++; if (r.done) return { settled, steps }; } }
function reconcileToEnd(db: DatabaseSync) { let reopened = 0, steps = 0; for (;;) { const r = parkReconcileStep(db, () => {}); reopened += r.reopened; steps++; if (r.done) return { reopened, steps }; } }

it("T12: after a round trip through 1.0.1 on the same version, the settle sweep and the reconciliation run again from the start", () => {
  process.env.MURAGE_APP_VERSION = "1.0.2-roundtrip";
  dir = mkdtempSync(join(tmpdir(), "claim-settle-downgrade-"));
  const db = new DatabaseSync(join(dir, "messages.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA foreign_keys=ON;");
    initializeMessageTables(db); initializeInbox(db);
    migrateMemorySchema(db, "active");
    db.prepare("INSERT INTO memory_scopes VALUES('scope-1','conversation','owner-1','[]',0)").run();
    // 1.0.2: a few blocked jobs, one retired source's job; both passes run to their end
    for (let i = 0; i < 40; i++) write(db, `w${i}`, { outcome: "working" });
    write(db, "parked", { state: "retired" });
    while (!parkStuckJobsStep(db, () => {}).done) { /* park sweep */ }
    expect(settleToEnd(db).settled).toBe(40);
    reconcileToEnd(db);
    expect(markers(db)).toEqual([{ id: "memory-claim-settle-sweep", done: true }, { id: "memory-parked-reconcile", done: true }]);
    expect(String(db.prepare("SELECT error FROM memory_jobs WHERE id='job-parked'").get()!.error)).toMatch(/^parked:v1:/);

    // the installer's "reinstall 1.0.1" step
    expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 13, to: 6 });
    expect(() => validateMemorySchema101(db)).not.toThrow();
    expect(markers(db)).toEqual([]);

    // 1.0.1 runs: it writes blocked jobs as pending again (300 of working turns, 20 of retired sources) and re-activates the
    // retired source without knowing about parking (its job stays cancelled with the marker)
    db.exec("BEGIN");
    for (let i = 0; i < 300; i++) write(db, `v101w${i}`, { outcome: "working" });
    for (let i = 0; i < 20; i++) write(db, `v101r${i}`, { state: "retired" });
    db.exec("COMMIT");
    db.prepare("UPDATE memory_sources SET state='active' WHERE id='src-parked'").run();

    // 1.0.2 again, the same version: a new process (nothing in memory) opens and upgrades the file
    resetClaimSettleSweep(); resetParkReconcile(); resetParkSweep();
    migrateMemorySchema(db, "active");
    validateMemorySchema(db);
    expect(Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()!.schema_version)).toBe(13);
    const sweep = settleToEnd(db);
    expect(sweep.settled).toBe(320);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','deferred','leased')").get()!.n)).toBe(0);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled' AND substr(error,1,10)='parked:v1:'").get()!.n)).toBe(21);  // the 20, and the one 1.0.1 re-activated (the reconciliation's)
    const reconcile = reconcileToEnd(db);
    expect(reconcile.reopened).toBe(1);
    expect(db.prepare("SELECT status,error FROM memory_jobs WHERE id='job-parked'").get()).toEqual({ status: "pending", error: null });
    expect(markers(db)).toEqual([{ id: "memory-claim-settle-sweep", done: true }, { id: "memory-parked-reconcile", done: true }]);
  } finally { db.close(); }
});
