import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
import { MEMORY_SCHEMA_V1, MEMORY_SCHEMA_VERSION, migrateMemorySchema } from "./memory/schema.ts";
import { finishRevocationIndexAtStartup } from "./memory/revocation-index.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { initializeOwnerDeletions } from "./owner-deletions.ts";
import { haveV101, V101 } from "./testing/pm-sends-v101.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/installation-recovery.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) removeTempDirSync(path); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-backup-cli-"));
  roots.push(root);
  const data = join(root, "installation with spaces");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), '{"profile":{"name":"Fixture"},"flux":{"apiKey":"never-print-this-canary"}}');
  return { root, data, target: join(root, "backup with spaces.zip") };
}
const run = (args: string[], env?: Record<string, string>) => exec(process.execPath, [cli, ...args], { timeout: 20_000, ...(env ? { env: { ...process.env, ...env } } : {}) });

it("backs up and inspects an explicit offline installation through the real CLI", async () => {
  const f = fixture();
  const original = readFileSync(join(f.data, "config.json"));
  const saved = await run(["backup", "--data-dir", f.data, "--output", f.target]);
  const inspected = await run(["inspect", "--archive", f.target]);
  const planned = await run(["plan-restore", "--archive", f.target]);
  expect(saved.stdout + saved.stderr + inspected.stdout + inspected.stderr).not.toContain("never-print-this-canary");
  expect(JSON.parse(saved.stdout)).toMatchObject({ ok: true, operation: "backup", restorePolicy: "paused-review-required" });
  expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, operation: "inspect", sha256: JSON.parse(saved.stdout).sha256, activationAvailable: false });
  expect(JSON.parse(planned.stdout)).toMatchObject({ ok: true, operation: "plan-restore", sha256: JSON.parse(saved.stdout).sha256, activationAvailable: false });
  expect(planned.stdout + planned.stderr).not.toContain("never-print-this-canary");
  expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
});

it("exports damaged bytes privately without claiming a restorable backup", async () => {
  const f = fixture();
  const damaged = '{"secret":"damaged-private-canary",';
  writeFileSync(join(f.data, "config.json"), damaged);
  const result = await run(["export-damaged", "--data-dir", f.data, "--output", f.target]);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: "export-damaged", complete: false,
    activationAvailable: false, restorePolicy: "preservation-only-no-restore", warning: expect.stringContaining("Do not share") });
  expect(result.stdout + result.stderr).not.toContain("damaged-private-canary");
  expect(readFileSync(join(f.data, "config.json"), "utf8")).toBe(damaged);
  await expect(run(["inspect", "--archive", f.target])).rejects.toMatchObject({ code: 1 });
});

it("fails clearly for active ownership, duplicate options or a restore without target and inspected hash", async () => {
  const f = fixture();
  const owner = acquireDataDirLease(f.data);
  try {
    await expect(run(["backup", "--data-dir", f.data, "--output", f.target])).rejects.toMatchObject({ code: 1 });
  } finally { owner.release(); }
  await expect(run(["inspect", "--archive", f.target, "--archive", f.target])).rejects.toMatchObject({ code: 1 });
  await expect(run(["restore", "--archive", f.target])).rejects.toMatchObject({ code: 1 });
});

it("restores the hash-bound archive inactive and rolls back byte-for-byte through real CLI processes", async () => {
  const f = fixture(), original = readFileSync(join(f.data, "config.json"));
  const saved = JSON.parse((await run(["backup", "--data-dir", f.data, "--output", f.target])).stdout);
  const restored = await run(["restore", "--data-dir", f.data, "--archive", f.target, "--sha256", saved.sha256]);
  expect(JSON.parse(restored.stdout)).toMatchObject({ ok: true, operation: "restore", status: "restored-review-required", activationAvailable: false });
  expect(restored.stdout + restored.stderr).not.toContain("never-print-this-canary");
  expect(readFileSync(join(f.data, "config.json"), "utf8")).not.toContain("never-print-this-canary");
  expect(() => assertRestoreReviewed(f.data)).toThrow();
  const rolledBack = await run(["rollback", "--data-dir", f.data]);
  expect(JSON.parse(rolledBack.stdout)).toMatchObject({ ok: true, operation: "rollback", status: "rolled-back" });
  expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
  expect(() => assertRestoreReviewed(f.data)).not.toThrow();
});

it("names the damaged component without exposing receipt contents", async () => {
  const f = fixture();
  writeFileSync(join(f.data, "delegation-receipts.json"), '[{"private":"receipt-secret-canary"}]');
  let failure: any;
  try { await run(["backup", "--data-dir", f.data, "--output", f.target]); } catch (error) { failure = error; }
  expect(failure?.code).toBe(1);
  expect(JSON.parse(failure.stderr)).toMatchObject({ ok: false, error: "INVALID_INSTALLATION_RECORDS", component: "delegation-receipts.json" });
  expect(failure.stderr).not.toContain("receipt-secret-canary");
});

it("a delegated recovery child can backup, restore and roll back while the primary owner remains held", async () => {
  const f = fixture(), original = readFileSync(join(f.data, "config.json"));
  const owner = acquireDataDirLease(f.data);
  try {
    const saved = JSON.parse((await run(["backup", "--data-dir", f.data, "--output", f.target], owner.utilityServerLeaseEnvironment())).stdout);
    expect(() => acquireDataDirLease(f.data)).toThrow();
    const restored = JSON.parse((await run(["restore", "--data-dir", f.data, "--archive", f.target, "--sha256", saved.sha256], owner.utilityServerLeaseEnvironment())).stdout);
    expect(restored.activationAvailable).toBe(false);
    expect(() => acquireDataDirLease(f.data)).toThrow();
    await run(["rollback", "--data-dir", f.data], owner.utilityServerLeaseEnvironment());
    expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
    expect(() => acquireDataDirLease(f.data)).toThrow();
  } finally { owner.release(); }
});

it("downgrades a stopped installation's memory schema to v1 and refuses a running one", async () => {
  const f = fixture(), file = join(f.data, "messages.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
  db.exec(MEMORY_SCHEMA_V1); db.exec("INSERT INTO memory_meta VALUES(1,1,'00000000-0000-4000-8000-000000000000',0,0,0,'active');");
  migrateMemorySchema(db); db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m',1,'user','text','never-print-this-canary chat','{}');"); db.close();
  const missing = await run(["memory-downgrade", "--data-dir", join(f.root, "nowhere")]).catch(error => error);
  expect(missing.stderr).toContain("MEMORY_DATABASE_MISSING");
  const owner = acquireDataDirLease(f.data);
  const running = await run(["memory-downgrade", "--data-dir", f.data]).catch(error => error);
  owner.release();
  expect(running.stderr).toContain("LEASE");
  const first = await run(["memory-downgrade", "--data-dir", f.data]);
  expect(first.stdout + first.stderr).not.toContain("never-print-this-canary");
  expect(JSON.parse(first.stdout)).toEqual({ ok: true, operation: "memory-downgrade", status: "downgraded", from: MEMORY_SCHEMA_VERSION, to: 1 });
  expect(JSON.parse((await run(["memory-downgrade", "--data-dir", f.data])).stdout)).toMatchObject({ ok: true, status: "already-v1" });
  const check = new DatabaseSync(file);
  try {
    expect(check.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(1);
    expect(check.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('memory_record_details','memory_learning_config')").get()?.n).toBe(0);
    expect(check.prepare("SELECT text FROM messages").get()?.text).toContain("chat");
  } finally { check.close(); }
  expect(() => acquireDataDirLease(f.data).release()).not.toThrow();
});

it.each([2,3,6,8,9,10])("supports a stopped-installation downgrade to v%s",async to=>{
 const f=fixture(),db=new DatabaseSync(join(f.data,"messages.db"));migrateMemorySchema(db);db.close();
 const result=await run(["memory-downgrade","--data-dir",f.data,"--to",String(to)]);
 expect(JSON.parse(result.stdout)).toMatchObject({status:"downgraded",from:MEMORY_SCHEMA_VERSION,to});
});

// "Prepare to reinstall Murage 1.0.1" (electron/main.mjs) runs memory-downgrade --to 6, because the 1.0.1 tag (d950cbf67)
// has MEMORY_SCHEMA_VERSION 6 and refuses anything newer. 1.0.2 is v9, so the step traverses v9 (the open-turns table), v8 (the revocation index) and v7.
it("the reinstall-1.0.1 downgrade leaves a file at exactly the version 1.0.1 reads, with the 1.0.2-only objects gone and the data kept", async () => {
  const f = fixture(), file = join(f.data, "messages.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m',1,'user','text','kept chat','{}')");
  // the 1.0.2 application objects 1.0.1 does not know (hand-off queue, deletion records) leave with the memory objects
  initializePendingDelegations(db); initializeOwnerDeletions(db);
  db.exec("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES('h1','t','peer','sender','fresh',NULL,'{\"toBotId\":\"peer\",\"message\":\"m\",\"depth\":0,\"attempts\":0}')");
  // a finished 1.0.2 start: every receipt indexed, lookup index built, ready flag set
  finishRevocationIndexAtStartup(db);
  expect(db.prepare("SELECT ready FROM memory_revocation_index_build").get()?.ready).toBe(1);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(MEMORY_SCHEMA_VERSION);
  const objectsBefore = (db.prepare("SELECT name FROM sqlite_schema").all() as Array<{ name: string }>).map(row => row.name);
  db.close();
  const first = JSON.parse((await run(["memory-downgrade", "--data-dir", f.data, "--to", "6"])).stdout);
  expect(first).toEqual({ ok: true, operation: "memory-downgrade", status: "downgraded", from: MEMORY_SCHEMA_VERSION, to: 6, handoffs: 1, handoffsStarted: 0 });
  expect(JSON.parse((await run(["memory-downgrade", "--data-dir", f.data, "--to", "6"])).stdout)).toMatchObject({ status: "already-v6", from: 6, to: 6 });
  const check = new DatabaseSync(file);
  try {
    // 1.0.1 checks schema_version <= 6 (MEMORY_SCHEMA_NEWER otherwise) and validates its own shape
    expect(check.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
    const names = new Set((check.prepare("SELECT name FROM sqlite_schema").all() as Array<{ name: string }>).map(row => row.name));
    // every memory object this build creates that the real 1.0.1 (git archive d950cbf67, the same migration run by its own code) does not, plus the revocation
    // lookup index: computed, not listed by hand. Without the extracted 1.0.1 the list that was checked against it is used.
    let gone = ["memory_disclosure_refs", "memory_disclosure_refs_bundle", "memory_disclosure_refs_ref", "memory_disclosure_refs_delete", "memory_disclosure_refs_insert", "memory_disclosure_refs_update",
      "memory_disclosures_state", "memory_revocation_index_build", "memory_root_set_compaction", "memory_root_set_parents", "memory_root_set_parents_parent", "memory_session_roots_set",
      "memory_open_turns", "memory_open_turns_build", "memory_open_turns_thread", "memory_open_turns_boot", "memory_open_turns_insert", "memory_open_turns_keep", "memory_open_turns_close", "memory_open_turns_delete"];
    if (haveV101) {
      const specifier = join(V101, "server", "memory", "schema.ts");
      const old101 = await import(/* @vite-ignore */ specifier) as { migrateMemorySchema(db: DatabaseSync, mode?: "active"): unknown };
      const reference = new DatabaseSync(":memory:");
      try {
        reference.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
        old101.migrateMemorySchema(reference, "active");
        const known = new Set((reference.prepare("SELECT name FROM sqlite_schema").all() as Array<{ name: string }>).map(row => row.name));
        gone = objectsBefore.filter(name => name.startsWith("memory_") && !known.has(name));
      } finally { reference.close(); }
      expect(gone.length).toBeGreaterThan(5);
      expect(gone).toContain("memory_revocation_index_build");
    }
    for (const name of gone) expect(names.has(name), name).toBe(false);
    expect(check.prepare("SELECT text FROM messages").get()?.text).toBe("kept chat");
    // none of the application objects 1.0.1 does not know remain, and the waiting hand-off went back to the file 1.0.1 reads
    for (const gone of ["pending_delegations", "pending_delegations_import", "owner_deleted_threads", "pd_thread", "pd_started"]) expect(names.has(gone), gone).toBe(false);
    expect(JSON.parse(readFileSync(join(f.data, "delegations.json"), "utf8"))).toEqual({ t: [expect.objectContaining({ id: "h1", toBotId: "peer" })] });
  } finally { check.close(); }
  // the next 1.0.2 start brings the derived objects back
  const again = new DatabaseSync(file);
  try {
    migrateMemorySchema(again);
    expect(again.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(MEMORY_SCHEMA_VERSION);
    expect(again.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='memory_revocation_index_build'").get()?.n).toBe(1);
  } finally { again.close(); }
});
it("memory-downgrade --to 10 steps 1.0.3 back to 1.0.2 without the 1.0.1 application rewind, and refuses a target it does not know",async()=>{
 const f=fixture(),db=new DatabaseSync(join(f.data,"messages.db"));migrateMemorySchema(db);db.close();
 expect(JSON.parse((await run(["memory-downgrade","--data-dir",f.data,"--to","10"])).stdout)).toEqual({ok:true,operation:"memory-downgrade",status:"downgraded",from:MEMORY_SCHEMA_VERSION,to:10});
 expect(JSON.parse((await run(["memory-downgrade","--data-dir",f.data,"--to","10"])).stdout)).toMatchObject({status:"already-v10",from:10,to:10});
 // 11 (1.0.3 before the lineage door epoch) is a target since memory schema 12, 12 (1.0.3 to 1.0.6) since 13; 13, the current one, is not
 const refused=await run(["memory-downgrade","--data-dir",f.data,"--to","13"]).catch(error=>error);
 expect(refused.stderr).toContain("--to 1|2|3|4|5|6|7|8|9|10|11|12]");
});
