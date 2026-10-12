// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pm-upstart review round 3: (P1-1) the lineage merge is linear in links visited and members touched, including older sets whose
// ancestry interleaves with the members they add; (P1-2) cache loading and the stray walk report progress; (P1-3) reference checks cut
// by key seek (no min/max scan, sparse keys, WITHOUT ROWID) and the one indivisible statement runs under a heartbeat; (P2-1) reference
// checks agree with the pragma on affinity and on a column named rowid; (P2-2) end() waits for the writer's last write.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [] }], groups: [] };
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
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
const resetRepair = (db: DatabaseSync) => db.exec("DELETE FROM memory_output_roots; DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
const setRoot = (db: DatabaseSync, set: string, id: string) => db.prepare("UPDATE memory_output_roots SET set_id=? WHERE thread_id='chat' AND message_id=?").run(set, id);

/** Older sets in an interleaved shape: the root set holds ONE member in the middle (m1) and its first delta holds a member above it
 * and one below it ({m0, m2}), then each delta adds the next two. Reply i's set is the first i outputs. */
function seedInterleaved(db: DatabaseSync, ids: string[]) {
  const store = chainStore(db);
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
  const q: string[] = [store(null, 0, [keyOf("chat", ids[1]!)])];
  for (let j = 1; 2 * j < ids.length; j++) q[j] = store(q[j - 1]!, 2 * j - 1, j === 1 ? [keyOf("chat", ids[0]!), keyOf("chat", ids[2]!)] : [keyOf("chat", ids[2 * j - 1]!), keyOf("chat", ids[2 * j]!)]);
  for (let i = 3; i < ids.length; i++) {
    const set = i % 2 === 1 ? q[(i - 1) / 2]! : store(q[i / 2 - 1]!, i - 1, [keyOf("chat", ids[i - 1]!)]);
    setRoot(db, set, ids[i]!);
  }
  db.exec("COMMIT");
}
function traversal(n: number) {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  const ids = chainThread("chat", n, "B1");
  const db = database();
  resetRepair(db);
  repairOutputRootBackfill(db);
  seedInterleaved(db, ids);
  db.exec("DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  const stats = { links: 0, members: 0 };
  repairOutputRootBackfill(db, { stats });
  for (const at of [3, 4, Math.floor(n / 2), n - 1]) {
    const set = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[at]!)?.set_id as string;
    expect([...(rootSetMembers(db, set) ?? [])].sort(), `reply ${at}`).toEqual(ids.slice(0, at).map(id => keyOf("chat", id)).sort());
  }
  return stats.links + stats.members;
}

it("P1 r3: older sets whose ancestry interleaves with what they add are merged in linear links and members (1k, 2k, 4k: at most 2.3x per doubling)", () => {
  const a = traversal(1_000), b = traversal(2_000), c = traversal(4_000);
  expect(b / a, `${a} -> ${b}`).toBeLessThan(2.3);
  expect(c / b, `${b} -> ${c}`).toBeLessThan(2.3);
  expect(c, "a few visits per reply, not a walk of the chain").toBeLessThan(4_000 * 8);
}, 600_000);

it("P1 r3: reading a long ancestry into the cache and walking its strays both report progress and commit", () => {
  const ids = chainThread("chat", 200, "B1");
  const db = database();
  resetRepair(db);
  repairOutputRootBackfill(db);
  const store = chainStore(db);
  db.exec("PRAGMA foreign_keys=OFF");
  let parent: string | null = null;
  for (let i = 0; i < 1_024; i++) parent = store(parent, i, [keyOf("elsewhere", `x${i}`)]);
  setRoot(db, parent!, ids[100]!);
  db.exec("DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  const reports: number[] = [];
  repairOutputRootBackfill(db, { onProgress: p => reports.push(p.done), checkpointMs: 0 });
  const members = rootSetMembers(db, db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id=?").get(ids[100]!)?.set_id as string) ?? new Set();
  expect(members.size).toBe(100 + 1_024);
  // 1,024 links: four notes while reading them, four while building, four while walking the strays
  expect(reports.filter(done => done > 0 && done < 1).length).toBeGreaterThanOrEqual(10);
}, 120_000);

const spyPrepared = (db: DatabaseSync) => {
  const sql: string[] = [];
  const spy = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if (key !== "prepare") return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
    return (text: string) => { sql.push(text); return target.prepare(text); };
  } });
  return { spy, sql };
};

it("P1 r3: reference slices are cut by key seek: no min/max scan, and sparse rowids cost no empty slices", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE p(id TEXT PRIMARY KEY); INSERT INTO p VALUES('k');
    CREATE TABLE c(a INTEGER PRIMARY KEY, pid TEXT REFERENCES p(id)); INSERT INTO c VALUES(1,'k'); INSERT INTO c VALUES(40000000,'k');`);
  const { spy, sql } = spyPrepared(db);
  let slices = 0;
  expect(referencesBroken(spy, "c", () => { slices++; })).toBe(false);
  expect(slices, "two rows 40 million rowids apart are one slice").toBeLessThanOrEqual(2);
  expect(sql.filter(text => /\b(min|max)\s*\(/i.test(text)), "no aggregate that reads the whole table to find its ends").toEqual([]);
  db.exec("UPDATE c SET pid='gone' WHERE a=40000000");
  expect(referencesBroken(db, "c", () => {})).toBe(true);
});

it("P1 r3: a WITHOUT ROWID table is cut into slices by primary key and agrees with the pragma", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE p(id TEXT PRIMARY KEY, n INTEGER, UNIQUE(id,n));");
  const total = REFERENCE_SLICE * 2 + 30;
  db.exec(`CREATE TABLE one(a INTEGER PRIMARY KEY, pid TEXT REFERENCES p(id)) WITHOUT ROWID;
    CREATE TABLE two(a INTEGER, b TEXT, pid TEXT, pn INTEGER, PRIMARY KEY(a,b), FOREIGN KEY(pid,pn) REFERENCES p(id,n)) WITHOUT ROWID;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total}) INSERT INTO p SELECT 'k'||i, i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total}) INSERT INTO one SELECT i, 'k'||i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total}) INSERT INTO two SELECT i, 'b'||(i%7), 'k'||i, i FROM n;`);
  for (const table of ["one", "two"]) {
    let slices = 0;
    expect(referencesBroken(db, table, () => { slices++; }), table).toBe(false);
    expect(slices, `${table} is cut into slices`).toBeGreaterThanOrEqual(3);
  }
  for (const [table, update] of [["one", `UPDATE one SET pid='gone' WHERE a=${total - 3}`], ["two", `UPDATE two SET pn=-1 WHERE a=${REFERENCE_SLICE + 11}`]] as const) {
    db.exec(update);
    expect(referencesBroken(db, table, () => {}), update).toBe(true);
    expect(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0, `pragma agrees: ${update}`).toBe(true);
  }
});

it("P1 r3: the one statement that cannot be sliced runs under the caller's hold, and validation before the upgrade asks for a heartbeat for it", () => {
  const db = new DatabaseSync(":memory:");
  // every name for the rowid is a column: there is no key to slice by
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE p(id TEXT PRIMARY KEY); INSERT INTO p VALUES('k');
    CREATE TABLE odd(rowid, _rowid_, oid, pid TEXT REFERENCES p(id)); INSERT INTO odd VALUES(NULL,NULL,NULL,'gone');`);
  let held = 0;
  expect(referencesBroken(db, "odd", () => {}, run => { held++; return run(); })).toBe(true);
  expect(held).toBe(1);
  // through the upgrade: the heartbeat is started for that statement and ended after it
  const file = new DatabaseSync(":memory:");
  migrateMemorySchema(file, "active");
  file.exec("CREATE TABLE zz(rowid, _rowid_, oid, scope TEXT REFERENCES memory_scopes(id)); INSERT INTO zz VALUES(NULL,NULL,NULL,NULL)");
  expect(downgradeMemorySchema(file, 7).to).toBe(7);
  const steps: string[] = []; let ended = 0;
  migrateMemorySchema(file, "off", { onBlocking: first => { steps.push(first); return { step: step => { steps.push(step); }, end: () => { ended++; } }; } });
  expect(steps[0], "validation's indivisible statement is covered").toBe("validating");
  expect(steps).toContain("tables");
  expect(ended, "every heartbeat started is ended").toBe(2);
  let holds = 0;
  validateMemorySchema(file, { references: true, hold: run => { holds++; return run(); } });
  expect(holds).toBe(1);
});

it("P2 r3: reference checks apply only the parent column's affinity and agree with the pragma", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE tp(id TEXT PRIMARY KEY); CREATE TABLE ip(id INTEGER PRIMARY KEY);
    INSERT INTO tp VALUES('01'); INSERT INTO ip VALUES(1);
    CREATE TABLE int_child(a INTEGER PRIMARY KEY, pid INTEGER REFERENCES tp(id));
    CREATE TABLE text_child(a INTEGER PRIMARY KEY, pid TEXT REFERENCES ip(id));`);
  // INTEGER 1 against a TEXT parent '01': the pragma stores the child as text '1', which is not '01'
  db.exec("INSERT INTO int_child VALUES(1, 1)");
  expect(db.prepare("PRAGMA foreign_key_check(int_child)").all().length).toBe(1);
  expect(referencesBroken(db, "int_child", () => {})).toBe(true);
  // TEXT '1' against an INTEGER parent 1: the pragma reads the child as the integer 1, which is there
  db.exec("INSERT INTO text_child VALUES(1, '1')");
  expect(db.prepare("PRAGMA foreign_key_check(text_child)").all().length).toBe(0);
  expect(referencesBroken(db, "text_child", () => {})).toBe(false);
});

it("P2 r3: a column named rowid does not hide orphans", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE p(id TEXT PRIMARY KEY); INSERT INTO p VALUES('k');
    CREATE TABLE shadow(rowid INTEGER, pid TEXT REFERENCES p(id)); INSERT INTO shadow VALUES(NULL,'gone');
    CREATE TABLE text_shadow(rowid TEXT, pid TEXT REFERENCES p(id)); INSERT INTO text_shadow VALUES('zz','k'); INSERT INTO text_shadow VALUES('aa','gone');`);
  for (const table of ["shadow", "text_shadow"]) {
    expect(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length, `pragma: ${table}`).toBe(1);
    expect(referencesBroken(db, table, () => {}), table).toBe(true);
  }
});

it("P2 r4: a generated column named rowid (omitted by table_info) does not hide orphans", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE p(id TEXT PRIMARY KEY); INSERT INTO p VALUES('k');
    CREATE TABLE gen(pid TEXT REFERENCES p(id), rowid INT GENERATED ALWAYS AS (NULL) VIRTUAL); INSERT INTO gen(pid) VALUES('k'); INSERT INTO gen(pid) VALUES('gone');`);
  expect(db.prepare("PRAGMA foreign_key_check(gen)").all().length, "pragma").toBe(1);
  expect(referencesBroken(db, "gen", () => {}), "gen").toBe(true);
});

const blockFor = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("P2 r3: end() returns only after the writer's last write has landed, so a slow rename cannot overwrite a later state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-r3-"));
  try {
    const file = join(dir, "memory-upgrade-status.json");
    // the first beat holds its rename back for 5.6 s (longer than any give-up end() could once have had)
    const beat = startBlockingHeartbeat(file, { v: 1, state: "upgrading", phase: "migrating", pid: process.pid, startedAt: Date.now() }, "indexes", 40, 5_600);
    for (let waited = 0; !readdirSync(dir).some(name => name.endsWith(".tmp")) && waited < 100; waited++) blockFor(50);
    expect(readdirSync(dir).some(name => name.endsWith(".tmp")), "a write is in flight").toBe(true);
    beat.end();
    expect(existsSync(file), "the in-flight write finished before end() returned").toBe(true);
    writeFileSync(file, JSON.stringify({ state: "ready" }));
    await sleep(1_500);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ state: "ready" });
    expect(readdirSync(dir).filter(name => name !== "memory-upgrade-status.json"), "no stray temp file").toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
