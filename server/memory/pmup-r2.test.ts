// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pm-upstart review round 2: (P1-1) the lineage repair's merge of older sets is linear in a thread however those sets are
// chained or stored, counted in statements run (not wall time); (P1-2) reference checks are cut into slices that report, and the
// statements that cannot be sliced keep the start-up note moving through a heartbeat thread.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore, downgradeMemorySchema, migrateMemorySchema, referencesBroken, repairOutputRootBackfill, rootSetMembers, validateMemorySchema, REFERENCE_SLICE } from "./schema.ts";
import { startBlockingHeartbeat } from "./blocking-heartbeat.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [] }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster);
});
afterEach(() => closeDatabase());

const keyOf = (thread: string, id: string) => `${thread}\u0000${id}`;
function chainThread(thread: string, n: number, bundle: string) {
  const db = database();
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m${String(i).padStart(6, "0")}`; ids.push(id);
    insert.run(thread, id, i, "bot", "text", "t", JSON.stringify({ id, at: i, role: "bot", kind: "text", text: "t", parentId: i ? ids[i - 1] : null }));
  }
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'engine','S','[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1000)")
    .run(bundle, thread, JSON.stringify(ids));
  db.exec("COMMIT");
  return ids;
}
function resetRepair(db: DatabaseSync) {
  db.exec("DELETE FROM memory_output_roots; DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
}
/** Counts every statement the repair runs (get, all, run). */
function counting(db: DatabaseSync) {
  const counter = { n: 0 };
  const spy = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if (key !== "prepare") return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
    return (sql: string) => new Proxy(target.prepare(sql), { get(statement, name) {
      const member = Reflect.get(statement, name) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => { if (name === "get" || name === "all" || name === "run") counter.n++; return (member as (...x: unknown[]) => unknown).apply(statement, args); };
    } });
  } });
  return { spy, counter };
}
/** Gives each reply an older set of what is above it, in the shape an earlier build left: `shape` "chain" = a chain of sets that
 * add two members at a time (ids unlike the repair's own), "full" = one whole set per reply (the v6 / rs1 form). */
function seedOlderSets(db: DatabaseSync, ids: string[], shape: "chain" | "full") {
  const store = chainStore(db);
  const nodes: string[] = [];
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN");
  for (let i = 1; i < ids.length; i++) {
    let set: string;
    if (shape === "chain") {
      // set of the first i outputs: pairs chained, plus a single closing member when i is odd
      if (i % 2 === 0) { const parent = nodes[i / 2 - 1] ?? null; set = store(parent, i - 2, [keyOf("chat", ids[i - 2]!), keyOf("chat", ids[i - 1]!)].sort()); nodes[i / 2] = set; }
      else { const parent = nodes[(i - 1) / 2] ?? null; set = store(parent, i - 1, [keyOf("chat", ids[i - 1]!)]); }
    } else {
      const keys = ids.slice(0, i).map(id => keyOf("chat", id));
      const id = `rs1:${i}`;
      db.prepare("INSERT OR IGNORE INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, keys.length);
      for (const key of keys) { const at = key.indexOf("\u0000"); db.prepare("INSERT OR IGNORE INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES(?,?,?)").run(id, key.slice(0, at), key.slice(at + 1)); }
      set = id;
    }
    db.prepare("UPDATE memory_output_roots SET set_id=? WHERE thread_id='chat' AND message_id=?").run(set, ids[i]!);
  }
  db.exec("COMMIT");
}
function lookups(n: number, shape: "chain" | "full") {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  const ids = chainThread("chat", n, "B1");
  const db = database();
  resetRepair(db);
  repairOutputRootBackfill(db);
  seedOlderSets(db, ids, shape);
  db.exec("DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  const { spy, counter } = counting(db);
  repairOutputRootBackfill(spy);
  for (const at of [1, 2, 3, Math.floor(n / 2), n - 1]) {
    const set = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[at]!)?.set_id as string;
    expect([...(rootSetMembers(db, set) ?? [])].sort(), `reply ${at}`).toEqual(ids.slice(0, at).map(id => keyOf("chat", id)).sort());
  }
  return counter.n;
}

it("P1 r2: merging older chained sets runs a linear number of statements (1k, 2k, 4k outputs: at most 2.3x per doubling)", () => {
  const a = lookups(1_000, "chain"), b = lookups(2_000, "chain"), c = lookups(4_000, "chain");
  expect(b / a, `${a} -> ${b}`).toBeLessThan(2.3);
  expect(c / b, `${b} -> ${c}`).toBeLessThan(2.3);
}, 600_000);

it("P1 r2: merging whole older sets (the v6 / rs1 form) runs a linear number of statements, each set read once", () => {
  const a = lookups(250, "full"), b = lookups(500, "full"), c = lookups(1_000, "full");
  expect(b / a, `${a} -> ${b}`).toBeLessThan(2.3);
  expect(c / b, `${b} -> ${c}`).toBeLessThan(2.3);
}, 600_000);

it("P1 r2: a long merge walk reports progress and commits inside the walk", () => {
  const ids = chainThread("chat", 3_000, "B1");
  const db = database();
  resetRepair(db);
  repairOutputRootBackfill(db);
  // sets of an unrelated lineage under every reply: nothing is inside the thread's tree, so each walk is long
  const store = chainStore(db);
  db.exec("PRAGMA foreign_keys=OFF");
  let parent: string | null = null;
  for (let i = 0; i < 600; i++) parent = store(parent, i, [keyOf("elsewhere", `x${i}`)]);
  db.prepare("UPDATE memory_output_roots SET set_id=? WHERE thread_id='chat' AND message_id=?").run(parent, ids[1_500]!);
  db.exec("DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  const reports: number[] = [];
  repairOutputRootBackfill(db, { onProgress: p => reports.push(p.done), checkpointMs: 0 });
  const members = rootSetMembers(db, db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[1_500]!)?.set_id as string) ?? new Set();
  expect(members.size).toBe(1_500 + 600);
  expect(members.has(keyOf("elsewhere", "x0"))).toBe(true);
  expect(reports.filter(done => done > 0 && done < 1).length).toBeGreaterThanOrEqual(6);
}, 120_000);

it("P1 r2: reference checks run in slices that report, find a missing parent, and agree with the pragma", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE p(id TEXT PRIMARY KEY, n INTEGER, UNIQUE(id,n));
    CREATE TABLE c(a INTEGER PRIMARY KEY, pid TEXT REFERENCES p(id), pn INTEGER, FOREIGN KEY(pid,pn) REFERENCES p(id,n));
    CREATE TABLE implicit(a INTEGER PRIMARY KEY, pid TEXT REFERENCES p);
    CREATE TABLE bare(pid TEXT REFERENCES p(id)) ; CREATE TABLE norow(pid TEXT PRIMARY KEY, q TEXT REFERENCES p(id)) WITHOUT ROWID;`);
  const total = REFERENCE_SLICE * 3 + 17;
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total}) INSERT INTO p SELECT 'k'||i, i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total}) INSERT INTO c SELECT i, 'k'||i, i FROM n;
    INSERT INTO c VALUES(${total + 1}, NULL, 5); INSERT INTO implicit SELECT a, pid FROM c WHERE pid IS NOT NULL;
    INSERT INTO bare VALUES('k1'); INSERT INTO norow VALUES('x','k1');`);
  let slices = 0;
  for (const table of ["c", "implicit", "bare", "norow"]) expect(referencesBroken(db, table, () => { slices++; }), table).toBe(false);
  expect(slices, "c and implicit are both cut into at least four slices").toBeGreaterThanOrEqual(8);
  for (const [table, row] of [["c", `UPDATE c SET pid='gone' WHERE a=${REFERENCE_SLICE * 2 + 5}`], ["c", `UPDATE c SET pn=-1 WHERE a=7`], ["implicit", `UPDATE implicit SET pid='gone' WHERE a=${total}`], ["bare", "UPDATE bare SET pid='gone'"], ["norow", "UPDATE norow SET q='gone'"]] as const) {
    db.exec(`${row}`);
    expect(referencesBroken(db, table, () => {}), row).toBe(true);
    expect(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0, `pragma agrees: ${row}`).toBe(true);
    db.exec("PRAGMA foreign_keys=OFF");
    if (table === "c") db.exec(`UPDATE c SET pid='k'||a, pn=a WHERE a IN (7, ${REFERENCE_SLICE * 2 + 5})`);
    if (table === "implicit") db.exec(`UPDATE implicit SET pid='k'||a WHERE a=${total}`);
    if (table === "bare") db.exec("UPDATE bare SET pid='k1'");
    if (table === "norow") db.exec("UPDATE norow SET q='k1'");
  }
  db.close();
});

it("P1 r2: the full validation sweep refreshes the note between slices of a large referencing table", () => {
  const db = database();
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${REFERENCE_SLICE * 2 + 50}) INSERT INTO memory_scope_bindings SELECT 'pad'||i,'${scope}','system','pad'||i,0,'granted','{}' FROM n`);
  let touches = 0;
  validateMemorySchema(db, { references: true, onProgress: () => { touches++; } });
  expect(touches, "slices of memory_scope_bindings alone").toBeGreaterThanOrEqual(3);
  db.exec("PRAGMA foreign_keys=OFF; UPDATE memory_scope_bindings SET scope_id='gone' WHERE id='pad77'; PRAGMA foreign_keys=ON");
  expect(() => validateMemorySchema(db, { references: true })).toThrow("INVALID_MEMORY_REFERENCE");
}, 120_000);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const blockFor = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

it("P1 r2: the heartbeat keeps the note moving while the server thread is blocked, and never writes after it ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-"));
  try {
    const file = join(dir, "memory-upgrade-status.json");
    const base = { v: 1, state: "upgrading", phase: "migrating", pid: process.pid, startedAt: Date.now() };
    const beat = startBlockingHeartbeat(file, base, "indexes", 40);
    blockFor(600); // a statement that cannot report: this thread can write nothing
    const first = JSON.parse(readFileSync(file, "utf8"));
    expect(first).toMatchObject({ state: "upgrading", phase: "migrating", step: "indexes", pid: process.pid });
    expect(Date.now() - first.updatedAt, "the note was rewritten during the block").toBeLessThan(300);
    expect(first.stepElapsedMs).toBeGreaterThan(200);
    beat.step("committing");
    blockFor(150);
    expect(JSON.parse(readFileSync(file, "utf8")).step).toBe("committing");
    beat.end();
    rmSync(file, { force: true });
    await sleep(250);
    expect(existsSync(file), "no beat lands after end()").toBe(false);
  } finally { removeTempDirSync(dir); }
});

it("P1 r2: the upgrade's blocking stretch is covered by a heartbeat that always ends", () => {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db, "active");
  expect(downgradeMemorySchema(db, 7).to).toBe(7);
  const steps: string[] = []; let ended = 0;
  migrateMemorySchema(db, "off", { onBlocking: first => { steps.push(first); return { step: step => { steps.push(step); }, end: () => { ended++; } }; } });
  expect(steps).toEqual(["tables", "indexes", "validating", "committing"]);
  expect(ended).toBe(1);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(13);
  // a failed upgrade ends the heartbeat too
  downgradeMemorySchema(db, 7);
  db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON main.memory_lineage_meta BEGIN SELECT RAISE(ABORT,'boom'); END");
  ended = 0;
  expect(() => migrateMemorySchema(db, "off", { onBlocking: () => ({ step: () => {}, end: () => { ended++; } }) })).toThrow();
  expect(ended).toBe(1);
  db.close();
});
