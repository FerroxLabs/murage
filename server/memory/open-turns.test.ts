// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema v9 (1.0.2 lineage-cold): the turns still working live in a table of their own, kept by triggers on memory_sources, so
// start-up and every settlement read a set as small as the turns in flight, however many turns the history holds. Nothing in the upgrade
// reads or sorts a whole table (the first v9 built two indexes with single statements that held the writers off for as long as they ran:
// 3,002 ms for an owner write at the r2 review). These tests pin:
// - no index is created on a table that already holds rows, and the trigger bodies carry no schema-qualified name (SQLite refuses one);
// - the table equals the working turn sources at every step, under any interleaving of writes with the backfill;
// - an owner write between slices never waits for the build; a stopped or killed build resumes from its persisted cursor;
// - the validator proves a ready table slice by slice and leaves a table still being filled alone;
// - the downgrade is the exact inverse and the real 1.0.1 inspector (d950cbf67) accepts what it leaves;
// - start-up and a settlement read only memory_open_turns, flat from 10,000 to 1,000,000 completed turns.
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import {
  bumpOpenTurnsBoot, nextOpenTurnsSliceRows, OPEN_TURNS_MAX_ROWS, OPEN_TURNS_MIN_ROWS, openTurnsStep, startOpenTurnsReconcile, type InterruptOpenTurn,
} from "./open-turns.ts";
import { OPEN_TURNS_OF_THREAD_SQL, interruptOpenTurn, recordMemorySettlement, reconcileInterruptedMemoryTurns } from "./settlement.ts";
import { setMemoryMode } from "./repository.ts";
import { LISTING_SQL } from "./replay-lineage.ts";
import { downgradeMemorySchema, LANE2_DERIVED_NAMES, MEMORY_SCHEMA, MEMORY_SCHEMA_V8, MEMORY_SCHEMA_VERSION, WRITETIME_TABLES, migrateMemorySchema, openTurnsDiffer, openTurnsReady, validateMemorySchema, WRITETIME_TRIGGERS } from "./schema.ts";

// (msearch2: the owner-tail table, its build row and its triggers are derived and made at every open from v8 on: they are not part of this step)
const ownerTailObjects = ["memory_owner_tail", "memory_owner_tail_build", "memory_owner_tail_insert", "memory_owner_tail_update", "memory_owner_tail_delete", "memory_records_owner_tail"];
import { validateMemorySchema as validateAs101 } from "./testing/schema-1.0.1.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const SOURCE_COLUMNS = "id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state";
/** `turns` turn sources in 97 threads, every `working`-th one working, the rest completed; ids in the `turn:` range. */
function addTurns(db: DatabaseSync, turns: number, working: number, from = 1): void {
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i+1 FROM n WHERE i<?2 + ?1 - 1)
    INSERT INTO memory_sources(${SOURCE_COLUMNS}) SELECT 'turn:t'||(i%97)||':'||printf('%08d',i),'w','t'||(i%97),NULL,printf('%08d',i),1,'h','turn','harness',
      CASE WHEN ?3>0 AND i%?3=0 THEN 'working' ELSE 'completed' END,NULL,'active' FROM n`).run(from, turns, working);
}
const workingIds = (db: DatabaseSync) => (db.prepare("SELECT id FROM memory_sources WHERE kind='turn' AND outcome='working' ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
const tableIds = (db: DatabaseSync) => (db.prepare("SELECT source_id FROM memory_open_turns ORDER BY source_id").all() as Array<{ source_id: string }>).map(row => row.source_id);
const equalsReference = (db: DatabaseSync) => expect(tableIds(db)).toEqual(workingIds(db));
/** What an interrupted turn becomes (the tests that do not need the capture pipeline). */
const interrupt: InterruptOpenTurn = (db, turn) => { db.prepare("UPDATE memory_sources SET outcome='interrupted' WHERE id=?").run(turn.id); };
const build = (db: DatabaseSync) => db.prepare("SELECT * FROM memory_open_turns_build WHERE id=1").get() as { boot: number; ready: number; cursor: string | null; done: number };

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  return db;
}
/** A file as an upgrade finds it: the 1.0.2 development schema one version back (v8) holding `turns` turn sources, migrated to v9. */
function upgradedFile(turns: number, working: number): { db: DatabaseSync; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "open-turns-")), file = join(dir, "messages.db"); dirs.push(dir);
  const db = new DatabaseSync(file); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  downgradeMemorySchema(db, 8);
  addTurns(db, turns, working);
  migrateMemorySchema(db);
  return { db, dir, file };
}

it("the upgrade from v8 creates no index on a table that holds rows, and the triggers name their tables without a schema prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-turns-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  downgradeMemorySchema(db, 8);
  addTurns(db, 20_000, 500);
  const before = new Map((db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema").all() as Array<{ name: string; type: string; tbl_name: string; sql: string | null }>).map(row => [row.name, row]));
  const rows = (name: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.n);
  const sourcesBefore = rows("memory_sources");
  migrateMemorySchema(db);
  const after = db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema").all() as Array<{ name: string; type: string; tbl_name: string; sql: string | null }>;
  // (revoke-bounded r3's late objects are made at every open from v9 on, beside the versioned text: schema.ts REVOKE_LATE_SQL)
  // (1.0.3 lane 2's derived objects, the age-key table and its company, are made empty at every v10 open too: schema.ts ensureRecordKeys)
  const revokeLate = new Set([...ownerTailObjects, ...LANE2_DERIVED_NAMES, "memory_deny", "memory_revocation_targets", "memory_evidence_by_source", "memory_source_origins", "memory_late_build", "memory_revoke_fold", "memory_revoke_fold_bulk", "memory_evidence_by_source_insert", "memory_evidence_by_source_delete", "memory_source_origins_insert"]);
  // (v13's source stamps and last-flow stamps, two tables and their triggers on memory_source_versions and memory_thread_flow, are created
  // empty in the same step: schema.ts SOURCE_LSN_SCHEMA)
  const sourceLsn = new Set(["memory_source_lsn", "memory_source_lsn_insert", "memory_thread_flow_last", "memory_thread_flow_last_insert"]);
  const added = after.filter(row => !before.has(row.name) && !revokeLate.has(row.name) && !sourceLsn.has(row.name) && !(WRITETIME_TRIGGERS as readonly string[]).includes(row.name));
  // everything that appeared belongs to the new tables or to a trigger on the sources: no index on a table that already held rows
  const indexes = added.filter(row => row.type === "index");
  expect(indexes.length).toBeGreaterThan(0);
  // (v10 adds the write-time lineage tables in the same step, all created empty with their indexes)
  const writetime = new Set<string>(Object.values(WRITETIME_TABLES));
  for (const index of indexes) expect(index.tbl_name.startsWith("memory_open_turns") || writetime.has(index.tbl_name), index.name).toBe(true);
  expect(added.filter(row => row.type === "table" && !writetime.has(row.name)).map(row => row.name).sort()).toEqual(["memory_open_turns", "memory_open_turns_build", "memory_session_incarnation", "upgrade_integrity_pass"]); // (upgrade_integrity_pass: the integrity pass's own empty table, made in the same step; memory_session_incarnation: v12 makes it empty)
  for (const trigger of added.filter(row => row.type === "trigger")) {
    expect(trigger.tbl_name).toBe("memory_sources");
    // SQLite refuses a qualified name inside a trigger ("cannot reference objects in database main"): none is used
    expect(trigger.sql, trigger.name).not.toMatch(/\b(main|temp|memory)\s*\.\s*memory_/i);
    expect(trigger.sql, trigger.name).not.toMatch(/\b[a-z_]+\s*\.\s*memory_open_turns/i);
  }
  expect(added.filter(row => row.type === "trigger").map(row => row.name).sort()).toEqual(["memory_open_turns_close", "memory_open_turns_delete", "memory_open_turns_insert", "memory_open_turns_keep"]);
  // created empty and not ready; nothing of the history was read into it, and every row of the sources is untouched
  expect(rows("memory_open_turns")).toBe(0);
  expect(build(db)).toMatchObject({ ready: 0, done: 0, cursor: null });
  expect(rows("memory_sources")).toBe(sourcesBefore);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(MEMORY_SCHEMA_VERSION);
  validateMemorySchema(db);
});

it("the triggers keep exactly the sources with kind 'turn' and outcome 'working', under every kind of write", () => {
  const db = memoryDb();
  bumpOpenTurnsBoot(db);
  const sql = (text: string, ...binds: Array<string | number>) => db.prepare(text).run(...binds);
  const seed = (id: string, kind: string, outcome: string) => sql(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES(?,'w','t1',NULL,?,1,'h',?, 'harness',?,NULL,'active')`, id, id.slice(-2), kind, outcome);
  seed("turn:t1:a1", "turn", "working"); seed("turn:t1:a2", "turn", "completed"); seed("message:t1:a3", "text", "working"); seed("turn:t1:a4", "turn", "working");
  equalsReference(db);
  expect(tableIds(db)).toEqual(["turn:t1:a1", "turn:t1:a4"]);
  // an upsert that keeps a turn working keeps its start's stamp
  sql("UPDATE memory_open_turns SET boot=0 WHERE source_id='turn:t1:a1'");
  sql("UPDATE memory_sources SET outcome='working',revision=2 WHERE id='turn:t1:a1'");
  expect(db.prepare("SELECT boot FROM memory_open_turns WHERE source_id='turn:t1:a1'").get()?.boot).toBe(0);
  sql("UPDATE memory_sources SET outcome='working',turn_id='renamed' WHERE id='turn:t1:a1'");
  expect(db.prepare("SELECT turn_id FROM memory_open_turns WHERE source_id='turn:t1:a1'").get()?.turn_id).toBe("renamed");
  // settling, reopening, changing kind, deleting
  sql("UPDATE memory_sources SET outcome='completed' WHERE id='turn:t1:a1'");
  equalsReference(db);
  sql("UPDATE memory_sources SET outcome='working' WHERE id='turn:t1:a2'");
  sql("UPDATE memory_sources SET kind='text' WHERE id='turn:t1:a4'");
  equalsReference(db);
  sql("UPDATE memory_sources SET kind='turn' WHERE id='turn:t1:a4'");
  equalsReference(db);
  sql("DELETE FROM memory_sources WHERE id='turn:t1:a4'");
  equalsReference(db);
  expect(tableIds(db)).toEqual(["turn:t1:a2"]);
  // a seeded random interleaving agrees with the reference at every step
  let a = 7;
  const next = (n: number) => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a % n; };
  for (let step = 0; step < 600; step++) {
    const id = `turn:t${next(4)}:${String(next(30)).padStart(2, "0")}`, exists = Boolean(db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(id));
    const roll = next(5);
    if (!exists) sql(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES(?,'w','t1',NULL,'x',1,'h','turn','harness',?,NULL,'active')`, id, roll % 2 ? "working" : "completed");
    else if (roll === 0) sql("DELETE FROM memory_sources WHERE id=?", id);
    else if (roll === 1) sql("UPDATE memory_sources SET kind=CASE kind WHEN 'turn' THEN 'text' ELSE 'turn' END WHERE id=?", id);
    else sql("UPDATE memory_sources SET outcome=? WHERE id=?", roll === 2 ? "working" : "completed", id);
    if (step % 40 === 0) equalsReference(db);
  }
  equalsReference(db);
  expect(openTurnsDiffer(db, null, null)).toBe(false);
});

it("the backfill settles the turns that were working before the upgrade, passes over completed ones, and ends ready with the table equal to the reference", () => {
  const { db } = upgradedFile(6_000, 100);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE outcome='working'").get()?.n)).toBeGreaterThan(50);
  bumpOpenTurnsBoot(db);
  let steps = 0, interrupted = 0;
  for (;;) {
    const step = openTurnsStep(db, interrupt, 200);
    interrupted += step.interrupted; steps++;
    if (step.ready) break;
    expect(steps).toBeLessThan(500);
  }
  expect(interrupted).toBe(Math.floor(6_000 / 100));
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE outcome='working'").get()?.n)).toBe(0);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE outcome='completed'").get()?.n)).toBe(6_000 - interrupted);
  expect(build(db)).toMatchObject({ ready: 1, cursor: null, done: 6_000 });
  expect(openTurnsReady(db)).toBe(true);
  equalsReference(db);
  validateMemorySchema(db);
});

it("a turn that starts while the backfill runs is kept by the triggers and left alone; one that ends meanwhile is dropped; the end equals the reference", () => {
  const { db } = upgradedFile(4_000, 80);
  bumpOpenTurnsBoot(db);
  let serial = 0;
  const live: string[] = [];
  for (let steps = 0; ; steps++) {
    const step = openTurnsStep(db, interrupt, 120);
    // owner activity between slices, behind and ahead of the cursor
    for (const prefix of ["turn:a", "turn:t9", "turn:zz"]) {
      const id = `${prefix}:${String(++serial).padStart(6, "0")}`;
      db.prepare(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES(?,'w','t1',NULL,'x',1,'h','turn','harness','working',NULL,'active')`).run(id);
      live.push(id);
    }
    if (live.length > 6 && steps % 2) db.prepare("UPDATE memory_sources SET outcome='completed' WHERE id=?").run(live.shift()!);
    if (live.length > 9 && steps % 3 === 0) db.prepare("DELETE FROM memory_sources WHERE id=?").run(live.shift()!);
    if (step.ready) break;
    expect(steps).toBeLessThan(500);
  }
  // the turns of this start (every id inserted above that is still working) were never settled by the backfill
  for (const id of live) expect(db.prepare("SELECT outcome FROM memory_sources WHERE id=?").get(id)?.outcome).toBe("working");
  equalsReference(db);
  validateMemorySchema(db);
});

it("a slice is bounded by time and by 512 rows, grows only within the target, shrinks at once on an overrun", async () => {
  const { db } = upgradedFile(3_000, 60);
  bumpOpenTurnsBoot(db);
  expect(nextOpenTurnsSliceRows(32, 1, 5)).toBeGreaterThan(32);
  expect(nextOpenTurnsSliceRows(400, 40, 5)).toBeLessThan(200);
  expect(nextOpenTurnsSliceRows(OPEN_TURNS_MAX_ROWS, 1, 5)).toBe(OPEN_TURNS_MAX_ROWS);
  expect(nextOpenTurnsSliceRows(OPEN_TURNS_MIN_ROWS, 500, 5)).toBe(OPEN_TURNS_MIN_ROWS);
  const run = startOpenTurnsReconcile(db, interrupt, { slice: 32, pauseMs: 1, busyPauseMs: 1, targetMs: 5 });
  await expect(run.done).resolves.toEqual({ finished: true });
  expect(run.stats.maxSliceRows).toBeLessThanOrEqual(OPEN_TURNS_MAX_ROWS);
  expect(run.stats.slices).toBeGreaterThan(3);
  expect(run.stats.interrupted).toBe(3_000 / 60);
  equalsReference(db);
});

it("an owner write while the table is being filled waits no more than one slice (r2: 3,002 ms behind a single index statement), on a 250,000-turn file", async () => {
  const { db, file } = upgradedFile(250_000, 5_000);
  bumpOpenTurnsBoot(db);
  // the owner's connection: a second handle on the same file, as the server's writers are
  const owner = new DatabaseSync(file); dbs.push(owner);
  // (commits are not fsynced on either connection: the disk of the machine running this is not what is measured, only the wait for the writer lock)
  owner.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS owner_writes(x)");
  db.exec("PRAGMA synchronous=NORMAL");
  const waits: number[] = [];
  const lag = monitorEventLoopDelay({ resolution: 1 }); lag.enable();
  const run = startOpenTurnsReconcile(db, interrupt, { slice: 32, pauseMs: 1, busyPauseMs: 1, targetMs: 5 });
  const probe = setInterval(() => {
    const started = performance.now();
    owner.exec("BEGIN IMMEDIATE");
    waits.push(performance.now() - started);
    owner.exec("INSERT INTO owner_writes VALUES(1); COMMIT");
  }, 2);
  await run.done; clearInterval(probe); lag.disable();
  console.log(`OWNER-WRITE during the open-turns build of 250,000 turns: ${waits.length} writes, longest ${Math.max(...waits).toFixed(1)} ms, event loop max ${(lag.max / 1e6).toFixed(1)} ms, ${run.stats.slices} slices, longest ${run.stats.maxSliceMs.toFixed(1)} ms, largest ${run.stats.maxSliceRows} rows`);
  expect(waits.length).toBeGreaterThan(20);
  expect(Math.max(...waits), "an owner write waits for a slice at most, never for the build").toBeLessThan(50);
  expect(run.stats.maxSliceMs).toBeLessThan(300); // the slice is bounded by rows (next line) and the owner wait above; a loaded host stalls the slice thread (134 ms seen with an owner wait of 3.4 ms)
  expect(run.stats.maxSliceRows).toBeLessThanOrEqual(512);
  expect(run.stats.slices).toBeGreaterThan(50);
  expect(openTurnsReady(db)).toBe(true);
  equalsReference(db);
}, 300_000);

it("a build stopped part-way resumes from its persisted cursor on a new connection and finishes with the table equal to the reference", () => {
  const { db, file } = upgradedFile(5_000, 100);
  bumpOpenTurnsBoot(db);
  expect(openTurnsStep(db, interrupt, 300).ready).toBe(false);
  expect(openTurnsStep(db, interrupt, 300).ready).toBe(false);
  const cursor = build(db).cursor;
  expect(cursor).toMatch(/^turn:/);
  db.close(); dbs.splice(dbs.indexOf(db), 1);
  const again = new DatabaseSync(file); dbs.push(again);
  again.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
  expect(build(again)).toMatchObject({ ready: 0, cursor, done: 600 });
  // what was written while it was down is kept by the triggers
  again.prepare(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES('turn:zz:down',  'w','t1',NULL,'x',1,'h','turn','harness','working',NULL,'active')`).run();
  bumpOpenTurnsBoot(again);
  while (!openTurnsStep(again, interrupt, 300).ready);
  expect(tableIds(again)).toEqual([]);
  expect(again.prepare("SELECT outcome FROM memory_sources WHERE id='turn:zz:down'").get()?.outcome).toBe("interrupted");
  validateMemorySchema(again);
});

it("a process killed in the middle of the build leaves a correct file; the next start resumes and finishes", async () => {
  const { db, file } = upgradedFile(8_000, 200);
  db.close(); dbs.splice(dbs.indexOf(db), 1);
  const child = fork(join(import.meta.dirname, "testing", "open-turns-child.ts"), [file], { execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>(res => child.once("exit", () => res()));
  await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("child never reported progress")), 20_000); child.on("message", (m: { type?: string }) => { if (m.type === "progress") { clearTimeout(t); res(); } }); });
  child.kill("SIGKILL"); await exited;
  const after = new DatabaseSync(file); dbs.push(after);
  after.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
  expect(after.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  const row = build(after);
  expect(row.ready).toBe(0);
  expect(row.cursor).toMatch(/^turn:/);
  validateMemorySchema(after);
  bumpOpenTurnsBoot(after);
  while (!openTurnsStep(after, interrupt, 400).ready);
  expect(openTurnsReady(after)).toBe(true);
  expect(Number(after.prepare("SELECT count(*) AS n FROM memory_sources WHERE outcome='working'").get()?.n)).toBe(0);
  equalsReference(after);
  validateMemorySchema(after);
}, 90_000);

it("the validator holds a ready table to the sources slice by slice, and leaves one still being filled alone", () => {
  const { db } = upgradedFile(3_000, 50);
  bumpOpenTurnsBoot(db);
  // being filled: a table that lacks rows is not an error (nothing reads it as complete)
  db.exec("INSERT INTO memory_open_turns VALUES('turn:ghost:1','ghost','1',1)");
  expect(() => validateMemorySchema(db)).not.toThrow();
  db.exec("DELETE FROM memory_open_turns WHERE source_id='turn:ghost:1'");
  while (!openTurnsStep(db, interrupt, 500).ready);
  validateMemorySchema(db);
  // ready: a row the sources do not justify, and a working turn the table lost, are both refused
  db.exec("INSERT INTO memory_open_turns VALUES('turn:ghost:1','ghost','1',1)");
  expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_OPEN_TURNS");
  db.exec("DELETE FROM memory_open_turns WHERE source_id='turn:ghost:1'");
  db.exec(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES('turn:real:1','w','real',NULL,'1',1,'h','turn','harness','working',NULL,'active')`);
  validateMemorySchema(db);
  db.exec("DROP TRIGGER memory_open_turns_insert");
  db.exec(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES('turn:real:2','w','real',NULL,'2',1,'h','turn','harness','working',NULL,'active')`);
  expect(() => validateMemorySchema(db)).toThrow();
});

it("v9 -> v8 drops the table, the build row and the four triggers and leaves exactly the v8 text; 9 -> 8 -> 6 passes the REAL 1.0.1 inspector (d950cbf67) and the unconverted v9 file is refused", () => {
  const { db, file } = upgradedFile(2_000, 40);
  bumpOpenTurnsBoot(db);
  while (!openTurnsStep(db, interrupt, 500).ready);
  // 1.0.1's own validator refuses a v9 file (its version is newer than it reads)
  expect(() => validateAs101(db)).toThrow(/MEMORY_SCHEMA_NEWER|MEMORY_SCHEMA_UNSUPPORTED/);
  expect(downgradeMemorySchema(db, 8)).toMatchObject({ status: "downgraded", from: MEMORY_SCHEMA_VERSION, to: 8 });
  const names = new Set((db.prepare("SELECT name FROM sqlite_schema").all() as Array<{ name: string }>).map(row => row.name));
  for (const gone of ["memory_open_turns", "memory_open_turns_build", "memory_open_turns_thread", "memory_open_turns_boot", "memory_open_turns_insert", "memory_open_turns_keep", "memory_open_turns_close", "memory_open_turns_delete"]) expect(names.has(gone), gone).toBe(false);
  // exactly the v8 text
  const v8 = new DatabaseSync(":memory:"); dbs.push(v8);
  v8.exec(MEMORY_SCHEMA_V8);
  const objects = (handle: DatabaseSync) => (handle.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_%'").all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>).filter(row => !ownerTailObjects.includes(row.name)).map(row => `${row.type}|${row.name}|${row.tbl_name}|${row.sql}`).sort();
  expect(objects(db)).toEqual(objects(v8));
  validateMemorySchema(db);
  expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 8, to: 6 });
  db.close(); dbs.splice(dbs.indexOf(db), 1);
  const check = new DatabaseSync(file); dbs.push(check);
  check.exec("PRAGMA foreign_keys=ON");
  expect(check.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
  expect(() => validateAs101(check)).not.toThrow();
  expect(() => validateAs101(check, { references: true })).not.toThrow();
  // and the next 1.0.2 start brings the derived objects back, empty and not ready, then finds the turns again
  migrateMemorySchema(check);
  expect(build(check)).toMatchObject({ ready: 0 });
  validateMemorySchema(check);
  expect(MEMORY_SCHEMA).toContain("memory_open_turns");
});

// ---- start-up and settlement: flat in the history --------------------------------------------------------------------------------------

const plan = (db: DatabaseSync, sql: string, ...binds: Array<string | number>): string => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds).map(row => String(row.detail)).join("\n");
function counting<T>(db: DatabaseSync, run: () => T): { value: T; sql: string[]; rows: number } {
  const real = db.prepare.bind(db) as DatabaseSync["prepare"];
  const sql: string[] = []; let rows = 0;
  (db as unknown as { prepare: unknown }).prepare = (text: string) => {
    const statement = real(text);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement), exec = statement.run.bind(statement);
    own.get = (...args) => { sql.push(text); const row = (get as (...a: unknown[]) => unknown)(...args); if (row) rows++; return row; };
    own.all = (...args) => { sql.push(text); const found = (all as (...a: unknown[]) => unknown[])(...args); rows += found.length; return found; };
    own.run = (...args) => { sql.push(text); return (exec as (...a: unknown[]) => unknown)(...args); };
    return statement;
  };
  try { return { value: run(), sql, rows }; } finally { (db as unknown as { prepare: unknown }).prepare = real; }
}

for (const turns of [10_000, 100_000, 1_000_000]) it(`start-up with ${turns.toLocaleString()} completed turns does the same constant work: it counts the start and reads only memory_open_turns (r2: ${turns * 7} VM instructions)`, () => {
  const db = memoryDb();
  addTurns(db, turns, 0);
  // a few turns a stopped process left working, stamped with an earlier start
  for (let index = 0; index < 3; index++) db.exec(`INSERT INTO memory_sources(${SOURCE_COLUMNS}) VALUES('turn:zz:${index}','w','zz',NULL,'${index}',1,'h','turn','harness','working',NULL,'active')`);
  expect(tableIds(db).length).toBe(3);
  db.exec("UPDATE memory_open_turns_build SET ready=1");
  const bumped = counting(db, () => bumpOpenTurnsBoot(db));
  const started = performance.now();
  const reconciled = counting(db, () => { let ready = false; while (!ready) ready = openTurnsStep(db, interrupt, 64).ready; });
  const took = performance.now() - started;
  console.log(`START-UP ${turns}: bump ${bumped.sql.length} statements / ${bumped.rows} rows; reconcile ${reconciled.sql.length} statements / ${reconciled.rows} rows, ${took.toFixed(1)} ms`);
  expect(bumped.sql.length).toBeLessThanOrEqual(5);
  expect(bumped.rows, "rows read before the server listens").toBeLessThan(1_000);
  expect(reconciled.rows, "rows read to settle the turns of an earlier start").toBeLessThan(1_000);
  expect(reconciled.sql.length).toBeLessThan(40);
  for (const text of [...bumped.sql, ...reconciled.sql]) expect(text, "nothing at start-up reads the sources by kind or outcome").not.toMatch(/FROM memory_sources WHERE (kind|outcome)/);
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE outcome='interrupted'").get()?.n).toBe(3);
  expect(tableIds(db)).toEqual([]);
  // the statements it ran are served by the table's own indexes
  expect(plan(db, "SELECT source_id,thread_id,turn_id FROM memory_open_turns WHERE boot<? ORDER BY boot LIMIT ?", 5, 8)).toMatch(/SEARCH memory_open_turns USING (COVERING )?INDEX memory_open_turns_boot/);
  // a settlement reads the turns of its thread from the table, by the thread index, and nothing else
  const settle = plan(db, OPEN_TURNS_OF_THREAD_SQL, "t1");
  expect(settle).toMatch(/SEARCH memory_open_turns USING (COVERING )?INDEX memory_open_turns_thread \(thread_id=\?\)/);
  expect(settle).not.toMatch(/memory_sources/);
  expect(settle).not.toMatch(/SCAN/);
}, 120_000);

it("a settlement settles the other working turns of its thread from the table, and a restart settles the turns the last start left", () => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const db = database();
  setMemoryMode("capture");
  recordMemorySettlement("chat", "turn-1", "working");
  recordMemorySettlement("chat", "turn-2", "working");
  recordMemorySettlement("other", "turn-3", "working");
  expect(tableIds(db)).toEqual(["turn:chat:turn-1", "turn:chat:turn-2", "turn:other:turn-3"]);
  recordMemorySettlement("chat", "turn-2", "completed");
  expect(db.prepare("SELECT outcome FROM memory_sources WHERE id='turn:chat:turn-1'").get()?.outcome).toBe("completed");
  expect(db.prepare("SELECT outcome FROM memory_sources WHERE id='turn:chat:turn-2'").get()?.outcome).toBe("completed");
  expect(tableIds(db)).toEqual(["turn:other:turn-3"]);
  // a restart: the start counter moves and what the last start left is interrupted, with the capture pipeline's own wording
  reconcileInterruptedMemoryTurns();
  expect(db.prepare("SELECT outcome FROM memory_sources WHERE id='turn:other:turn-3'").get()?.outcome).toBe("interrupted");
  expect(tableIds(db)).toEqual([]);
  expect(typeof interruptOpenTurn).toBe("function");
});

it("without the cover index the lineage listing still seeks the output index by (thread, message): no scan of the outputs", () => {
  const db = memoryDb();
  const listing = plan(db, LISTING_SQL, "x", "x", "x", 1);
  expect(listing).toMatch(/SEARCH memory_disclosure_outputs USING (COVERING )?INDEX memory_disclosure_outputs_message \(thread_id=\? AND message_id=\?\)/);
  expect(listing).not.toMatch(/SCAN memory_disclosure_outputs/);
  expect(plan(db, "SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=?", "x", "x")).toMatch(/USING (COVERING )?INDEX memory_disclosure_outputs_message/);
});

it("no file of the application creates an index with a statement that reads a whole table at upgrade, or holds the writers for a build", () => {
  expect(existsSync(join(import.meta.dirname, "cold-index-build.ts"))).toBe(false);
  expect(MEMORY_SCHEMA).not.toMatch(/memory_disclosure_outputs_cover|memory_sources_kind_outcome/);
});

// ---- 1.0.2 lineage-cold r3 (Fable P3-3, P3-5) ----------------------------------------------------------------------------------------------

it("one source that cannot be settled is passed over, not the end of the run: the rest are settled and the table becomes ready (r3: the run stopped on every start)", () => {
  const db = memoryDb();
  addTurns(db, 400, 10);
  // as an upgraded file finds them: working turns the table does not hold, and the build not ready
  db.exec("DELETE FROM memory_open_turns; UPDATE memory_open_turns_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1");
  const bad = workingIds(db)[3]!;
  const failing: InterruptOpenTurn = (handle, turn) => { if (turn.id === bad) { handle.prepare("UPDATE memory_sources SET outcome='interrupted' WHERE id=?").run(turn.id); throw new Error("malformed row"); } interrupt(handle, turn); };
  let step = openTurnsStep(db, failing, 512);
  for (let guard = 0; !step.ready && guard < 10; guard++) step = openTurnsStep(db, failing, 512);
  expect(step.ready, "the table became ready").toBe(true);
  // the failing one stays as it was (its own writes rolled back): still working, never extracted; every other one was settled
  expect(workingIds(db)).toEqual([bad]);
});

it("a v9 file written by the r2 build of this lane (two cold indexes, no open-turns table) is brought to this v9 in constant time and validates (r3: refused)", () => {
  const db = memoryDb();
  downgradeMemorySchema(db, 9); // the r2 build wrote v9
  addTurns(db, 50, 5);
  // the r2 shape: no open-turns tables or triggers, the two cold-lineage indexes
  db.exec(`DROP TRIGGER memory_open_turns_insert; DROP TRIGGER memory_open_turns_keep; DROP TRIGGER memory_open_turns_close; DROP TRIGGER memory_open_turns_delete;
    DROP TABLE memory_open_turns; DROP TABLE memory_open_turns_build;
    CREATE INDEX IF NOT EXISTS memory_disclosure_outputs_cover ON memory_disclosure_outputs(thread_id,message_id,bundle_id);
    CREATE INDEX IF NOT EXISTS memory_sources_kind_outcome ON memory_sources(kind,outcome);`);
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  migrateMemorySchema(db, "active");
  validateMemorySchema(db);
  expect(openTurnsReady(db)).toBe(false);
  // the backfill then finds the working turns as for any upgraded file
  let step = openTurnsStep(db, interrupt, 512);
  for (let guard = 0; !step.ready && guard < 10; guard++) step = openTurnsStep(db, interrupt, 512);
  expect(step.ready).toBe(true);
  equalsReference(db);
});
