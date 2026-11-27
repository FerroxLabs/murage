// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY V2 lane W witnesses (design section 3): W-COMMIT (every way a transaction can end wakes the subscriber, with no timer),
// W-WAKE (work left behind is never stranded), W-GUARD (the TEMP guards and the registered functions on the SQLite the app ships),
// W-ORPHAN-COMMIT (a commit by another connection whose writer then dies) and the deadline registry. Everything runs on the real
// connection opened by database(), on the real v13 schema, through the real instrumented wrapper.
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, memoryHoldCode, transaction } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { beginWrite, endWrite, undoWrite } from "../write-tx.ts";
import {
  adoptWorker, armDeadline, commitNotice, deadlineOf, declarePresentationWriter, disarmDeadline, errorClass, expectAck, LostWakeError, memoVersion, onWake,
  onWakeInstall, presentationWrite, probeWakes, raise, resetWakeForTest, REVOKE_STATE_INDEX, REVOKE_UNFINISHED_PROBE, setWakeStatementTapForTest, setWakeClockForTest, setWakeFaultSink, setWakeInstallFaultForTest, WAKE_PRIORITY, wakeInstalled, wakeNotice, wakeStats, watchMemo,
} from "./wake.ts";
import { memoryGate } from "./memory-gate.ts";
import { REVOKE_JOB_STATE } from "./schema.ts";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const turns = async (count = 6) => { for (let i = 0; i < count; i++) await turn(); };
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); };
let windowRow = 0;
const WINDOW = () => `INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('thread-${++windowRow}',1,${windowRow})`;
const REVOKE = (id: number, state = "active") => `INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(${id},'line','{}',1,1,'mark','','${state}')`;
/** A subscriber that records its runs. */
function listen(topic: string, options: Parameters<typeof onWake>[2] = {}) { const runs: string[] = []; onWake(topic, () => { runs.push(topic); }, options); return runs; }

beforeEach(() => { resetWakeForTest(); fresh(); windowRow = 0; });
afterEach(() => { vi.useRealTimers(); closeDatabase(); resetWakeForTest(); });

describe("W-COMMIT: a memory write that commits wakes its subscriber, whatever ended the transaction, with no timer", () => {
  // No timer may be involved: setTimeout and setInterval are faked and never advanced, and the registry must not have armed one.
  const forms: Record<string, (db: DatabaseSync) => void> = {
    "an autocommit prepared run": db => { db.prepare(WINDOW()).run(); },
    "an autocommit exec": db => { db.exec(WINDOW()); },
    "exec BEGIN ... exec COMMIT (the revoke runner's raw form)": db => { db.exec("BEGIN IMMEDIATE"); db.prepare(WINDOW()).run(); db.exec("COMMIT"); },
    "one multi-statement exec that ends in COMMIT": db => { db.exec(`BEGIN IMMEDIATE; ${WINDOW()}; COMMIT`); },
    "one multi-statement exec with the COMMIT in the middle of its text": db => { db.exec(`BEGIN IMMEDIATE; ${WINDOW()}; COMMIT; SELECT 1`); },
    "a RELEASE of the outermost SAVEPOINT": db => { db.exec("SAVEPOINT outer_point"); db.prepare(WINDOW()).run(); db.exec("RELEASE outer_point"); },
    "a prepared COMMIT": db => { db.exec("BEGIN"); db.prepare(WINDOW()).run(); db.prepare("COMMIT").run(); },
    "a prepared END read with get()": db => { db.exec("BEGIN"); db.prepare(WINDOW()).run(); db.prepare("END").get(); },
    "a prepared RELEASE pulled through iterate()": db => { db.exec("SAVEPOINT it_point"); db.prepare(WINDOW()).run(); for (const _ of db.prepare("RELEASE it_point").iterate()) void _; },
    "a RETURNING insert read with all()": db => { db.prepare(`${WINDOW()} RETURNING thread_id`).all(); },
    "a RETURNING insert pulled through iterate()": db => { for (const _ of db.prepare(`${WINDOW()} RETURNING thread_id`).iterate()) void _; },
    "database.ts transaction()": () => { transaction(db => { db.prepare(WINDOW()).run(); }); },
    "a nested transaction() (the inner RELEASE, then the outer COMMIT)": () => { transaction(() => { transaction(db => { db.prepare(WINDOW()).run(); }); }); },
    "write-tx beginWrite / endWrite": db => { beginWrite(db, "wake_witness"); db.prepare(WINDOW()).run(); endWrite(db, "wake_witness"); },
    "a savepoint rolled back after the write that stays": db => { db.exec("BEGIN"); db.prepare(WINDOW()).run(); db.exec("SAVEPOINT inner_point"); db.prepare(REVOKE(900)).run(); db.exec("ROLLBACK TO inner_point; RELEASE inner_point"); db.exec("COMMIT"); },
  };
  for (const [name, write] of Object.entries(forms)) {
    it(name, async () => {
      const db = database();
      expect(wakeInstalled(db)).toBe(true);
      await turns(); // the open-time probes have been delivered (nobody listened)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const runs = listen("window"), revokes = listen("revoke");
      const before = wakeStats();
      write(db);
      expect(runs).toEqual([]); // never inline: the subscriber runs off the committing stack
      await turns();
      expect(runs).toEqual(["window"]);
      expect(revokes).toEqual([]); // nothing unfinished was committed for the other topic
      expect(wakeStats().timerArmed).toBe(false);
      expect(wakeStats().timerArms).toBe(before.timerArms);
      await turns();
      expect(runs).toEqual(["window"]); // once
    });
  }

  it("a rolled-back write takes its wake with it (ROLLBACK, a failed transaction(), undoWrite)", async () => {
    const db = database();
    await turns();
    const runs = listen("window");
    db.exec("BEGIN IMMEDIATE"); db.prepare(WINDOW()).run(); db.exec("ROLLBACK");
    expect(() => transaction(d => { d.prepare(WINDOW()).run(); throw new Error("no"); })).toThrow("no");
    beginWrite(db, "wake_undo"); db.prepare(WINDOW()).run(); undoWrite(db, "wake_undo");
    await turns();
    expect(runs).toEqual([]);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()!.n)).toBe(0);
  });

  it("a wake committed while a later transaction is held open across turns is delivered when that transaction ends, even by rollback", async () => {
    const db = database();
    await turns();
    const runs = listen("window");
    db.prepare(WINDOW()).run();           // committed: the drain is queued
    db.exec("BEGIN IMMEDIATE");           // ...but a transaction is open when it runs
    await turns();
    expect(runs).toEqual([]);
    db.exec("ROLLBACK");
    await turns();
    expect(runs).toEqual(["window"]);
  });

  it("checkpoint debt wakes jobs: a born-complete capture's binding row raises the topic, and the open probe finds it by the subject index (CONTRACT-REQ E)", async () => {
    let db = database();
    await turns();
    const seen: string[] = [];
    for (const topic of ["journal", "jobs", "links"]) onWake(topic, () => { seen.push(topic); });
    db.exec("PRAGMA foreign_keys=OFF");
    const DEBT = (id: string, subject = "checkpoint-pending") => `INSERT INTO memory_scope_bindings VALUES('${id}','scope-a','system','${subject}',0,'granted','{}')`;
    db.exec(DEBT("debt-1"));
    await turns();
    expect(seen).toEqual(["jobs"]);
    seen.length = 0;
    db.exec(DEBT("other-1", "checkpoint-disposition")); // another system subject is not debt
    await turns();
    expect(seen).toEqual([]);
    closeDatabase(); db = database(); await turns(); // no job is pending; the debt row alone is found at open
    expect(seen).toEqual(["jobs"]);
    seen.length = 0;
    db.exec("DELETE FROM memory_scope_bindings WHERE id='debt-1'");
    closeDatabase(); db = database(); await turns();
    expect(seen).toEqual([]); // no debt row, no pending job: nothing raised
  });

  it("each topic's trigger fires for rows that mean work and stays quiet for rows that do not", async () => {
    const db = database();
    await turns();
    const seen: string[] = [];
    for (const topic of ["journal", "revoke", "window", "jobs", "projection", "links"]) onWake(topic, () => { seen.push(topic); });
    const after = async (sql: string) => { seen.length = 0; db.exec(sql); await turns(); return [...seen].sort(); };
    db.exec("PRAGMA foreign_keys=OFF");
    expect(await after(REVOKE(1, "done"))).toEqual([]);
    expect(await after(REVOKE(2, "active"))).toEqual(["revoke"]);
    expect(await after("UPDATE memory_revoke_jobs SET cursor='c' WHERE revoke_id=2")).toEqual(["revoke"]);
    expect(await after("UPDATE memory_revoke_jobs SET state='folded' WHERE revoke_id=2")).toEqual([]); // copied into a fold bulk: no slice serves it
    expect(await after("UPDATE memory_revoke_jobs SET state='done',phase='done' WHERE revoke_id=2")).toEqual([]);
    expect(await after("INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(1,1,'bundle-a')")).toEqual(["revoke"]);
    expect(await after("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('scope-a',1,1)")).toEqual(["window"]);
    expect(await after("DELETE FROM memory_deny_pending_scope")).toEqual(["window"]);
    expect(await after("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES('job-a','src-a',1,'capture','1','pending',0,0)")).toEqual(["jobs", "journal"]);
    // a lease keeps the row, the id and the source: no jobs wake (not pending) and, by G-JOB, no journal row either
    expect(await after("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_until=5 WHERE id='job-a'")).toEqual([]);
    expect(await after("UPDATE memory_jobs SET status='deferred',retry_at=9 WHERE id='job-a'")).toEqual(["jobs"]);
    expect(await after("UPDATE memory_jobs SET status='complete' WHERE id='job-a'")).toEqual([]);
    expect(await after("INSERT INTO memory_projection_receipts(record_id,record_version,index_generation,lexical_status,embedding_status) VALUES('rec-a',1,1,'pending','pending')")).toEqual(["journal", "projection"]);
    expect(await after("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE record_id='rec-a'")).toEqual(["journal"]);
    // a forget owes the removal of the words from the helper's postings: 'delete-pending' is pending work (projection.ts DELETIONS)
    expect(await after("UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending' WHERE record_id='rec-a'")).toEqual(["journal", "projection"]);
    expect(await after("UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' WHERE record_id='rec-a'")).toEqual(["journal"]);
    expect(await after("UPDATE memory_projection_receipts SET embedding_status='pending' WHERE record_id='rec-a'")).toEqual(["projection"]); // the embedding alone
    expect(await after("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('notebook-link:src-a','scope-a','notebook','n',0,'granted','{}')")).toEqual(["links"]);
    expect(await after("UPDATE memory_scope_bindings SET intent='{\"hash\":\"h\"}' WHERE id='notebook-link:src-a'")).toEqual(["links"]);
    expect(await after("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('other-binding','scope-a','notebook','n',0,'granted','{}')")).toEqual([]);
    expect(await after("DELETE FROM memory_scope_bindings WHERE id='notebook-link:src-a'")).toEqual(["links"]);
  });

  it("a write with its own conflict clause records its wake and never fails on a topic already recorded (the outer clause overrides a trigger's)", async () => {
    const db = database(); await turns();
    const runs = listen("window"), links = listen("links");
    db.exec("PRAGMA foreign_keys=OFF");
    const pending = (clause: string, id: number) => `INSERT ${clause} INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('conflict-${id}',1,${id})`;
    db.exec("BEGIN IMMEDIATE");
    db.exec(pending("", 1)); // the topic row now exists and is not drained before the commit
    for (const [index, clause] of ["OR ABORT", "OR FAIL", "OR ROLLBACK", "OR REPLACE", "OR IGNORE"].entries()) db.exec(pending(clause, index + 2));
    db.exec("UPDATE OR FAIL memory_deny_pending SET since_lsn=since_lsn WHERE thread_id='conflict-1'");
    db.exec("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('notebook-link:conflict','scope-a','notebook','n',0,'granted','{}')");
    db.exec("INSERT OR REPLACE INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('notebook-link:conflict','scope-a','notebook','n',1,'granted','{}')");
    db.exec("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('notebook-link:conflict','scope-a','notebook','n',2,'granted','{}') ON CONFLICT(id) DO UPDATE SET revision=excluded.revision");
    db.exec("COMMIT");
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()!.n)).toBe(6);
    expect(Number(db.prepare("SELECT revision FROM memory_scope_bindings WHERE id='notebook-link:conflict'").get()!.revision)).toBe(2);
    await turns();
    expect(runs).toEqual(["window"]); expect(links).toEqual(["links"]);
    // outside a transaction too, with the topic row left by a write whose drain has not run yet (the same call stack)
    db.exec(pending("", 20)); db.exec(pending("OR ABORT", 21)); db.exec(pending("OR FAIL", 22));
    await turns();
    expect(runs).toEqual(["window", "window"]);
  });

  it("an unchanged machine runs nothing: no commit, no drain, no timer, and a read or a lone PRAGMA is not a commit", async () => {
    const db = database();
    await turns();
    const before = wakeStats();
    db.prepare("SELECT count(*) AS n FROM memory_jobs").get();
    db.exec("PRAGMA busy_timeout=1000");
    db.exec("BEGIN"); db.prepare("SELECT 1").get(); // a read transaction left open is not an end
    await turns();
    expect(wakeStats()).toEqual(before);
    expect(before.timerArmed).toBe(false);
    db.exec("COMMIT");
    // a commit that wrote no wake table costs the bus no statement: the drain runs only when a trigger marked a wake
    db.exec("INSERT INTO project_settings(group_id,updated_at) VALUES('group-quiet',1)");
    transaction(d => { d.exec("UPDATE memory_meta SET policy_revision=policy_revision WHERE id=1"); });
    await turns();
    expect(wakeStats().commits).toBeGreaterThan(before.commits);
    expect(wakeStats().drains).toBe(before.drains);
    db.prepare(WINDOW()).run(); await turns();
    expect(wakeStats().drains).toBe(before.drains + 1);
    // a rolled-back wake leaves at most one empty drain behind, and raises nothing
    const raisedBefore = wakeStats().raised;
    db.exec("BEGIN IMMEDIATE"); db.prepare(WINDOW()).run(); db.exec("ROLLBACK"); await turns();
    expect(wakeStats().drains).toBeLessThanOrEqual(before.drains + 2);
    expect(wakeStats().raised).toBe(raisedBefore);
  });

  it("a drain that fails asks the tables once, then backs off on the deadline registry: late, never a loop, never lost", async () => {
    const db = database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runs = listen("window");
    const before = wakeStats();
    db.prepare(WINDOW()).run();              // committed and marked; the drain is queued for the next turn
    db.exec("PRAGMA query_only=ON");         // ...and by then the connection refuses every write, the TEMP wake table included
    await turns();
    expect(wakeStats().probes).toBe(before.probes + 1); // the tables were asked instead
    expect(runs).toEqual(["window"]);
    for (let i = 0; i < 5; i++) { db.exec("BEGIN"); db.prepare("SELECT 1").get(); db.exec("COMMIT"); await turns(); } // later events
    expect(wakeStats().probes).toBe(before.probes + 1); // no probe storm, no drain attempt before the retry time
    expect(wakeStats().drains).toBe(before.drains + 1);
    expect(wakeStats().timerArmed).toBe(true);
    expect(warn.mock.calls.filter(call => String(call[0]).includes("drain failed")).length).toBe(1);
    db.exec("PRAGMA query_only=OFF");
    await vi.advanceTimersByTimeAsync(1_000); await turns();
    expect(wakeStats().drains).toBe(before.drains + 2); // retried at its deadline, and the row that was still there is delivered
    expect(runs).toEqual(["window", "window"]);
    expect(wakeStats().timerArmed).toBe(false);
    warn.mockRestore();
  });

  it("the cross-thread notice moves at the same observation point", async () => {
    const db = database();
    const cells = new Int32Array(commitNotice());
    const before = Atomics.load(cells, 0);
    db.prepare(WINDOW()).run();
    expect(Atomics.load(cells, 0)).toBe(before + 1);
    db.exec("BEGIN IMMEDIATE"); db.prepare(WINDOW()).run();
    expect(Atomics.load(cells, 0)).toBe(before + 1);
    db.exec("COMMIT");
    expect(Atomics.load(cells, 0)).toBe(before + 2);
  });
});

describe("the installer runs on every open (design 3.1, M0)", () => {
  it("a reopened handle has the triggers again, and the open-time probes raise what an earlier process left", async () => {
    let db = database();
    db.prepare(WINDOW()).run(); db.prepare(REVOKE(7)).run();
    closeDatabase();
    expect(wakeInstalled(db)).toBe(false);
    const window = listen("window"), revoke = listen("revoke"), jobs = listen("jobs");
    db = database();
    expect(wakeInstalled(db)).toBe(true);
    await turns();
    expect(window).toEqual(["window"]); expect(revoke).toEqual(["revoke"]); expect(jobs).toEqual([]);
    db.prepare(WINDOW()).run();
    await turns();
    expect(window).toEqual(["window", "window"]);
    expect(memoryHoldCode()).toBeNull();
  });

  it("a topic raised before anyone subscribed is delivered to the first subscriber (start-up order)", async () => {
    const db = database();
    db.prepare(WINDOW()).run();
    await turns();
    const late = listen("window");
    await turns();
    expect(late).toEqual(["window"]);
  });

  it("adds, drops and edits no persisted object: sqlite_schema of the file is text-equal before and after the bus has worked", async () => {
    let db = database();
    closeDatabase();
    const file = join(DATA_DIR, "messages.db");
    const schema = () => { const raw = new DatabaseSync(file, { readOnly: true }); try { return JSON.stringify(raw.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()); } finally { raw.close(); } };
    const before = schema();
    db = database();
    watchMemo("schema_witness", ["memory_deny_pending"]);
    declarePresentationWriter({ name: "project_viewed", table: "project_settings", column: "owner_viewed_at" });
    db.prepare(WINDOW()).run();
    await turns();
    expect(Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE name LIKE 'mem\\_%' ESCAPE '\\'").get()!.n)).toBeGreaterThan(15);
    closeDatabase();
    expect(schema()).toBe(before);
  });
});

describe("the revoke open probe finds unfinished work through the state index and never reads the id range (G-START, W-ORPHAN-COMMIT)", () => {
  // Sean-shaped: tens of thousands of finished jobs, the unfinished one (if any) far from both ends of the key.
  const JOBS = 60_000, MIDDLE = 30_000;
  const seed = (state: (id: number) => string) => {
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit','{}',1,1,'done','',?)");
    for (let id = 1; id <= JOBS; id++) insert.run(id, state(id));
    db.exec("COMMIT");
  };
  const FINISHED = ["done", "undone", "folded"];
  const finished = (id: number) => FINISHED[id % 3]!;
  /** Reopen with a tap on the installer's own statements; report what the open raised for revoke and how each statement reads. */
  const reopen = async () => {
    closeDatabase();
    const seen: string[] = [];
    const runs = listen("revoke");
    setWakeStatementTapForTest(sql => { seen.push(sql); });
    let db: DatabaseSync;
    try { db = database(); } finally { setWakeStatementTapForTest(null); }
    await turns();
    const reads = seen.filter(sql => /^\s*SELECT\b/i.test(sql));
    const plans = reads.map(sql => ({ sql, plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => String(row.detail)) }));
    return { raised: runs.length > 0, statements: seen.length, plans, db };
  };
  /** Every plan step that reads memory_revoke_jobs must be an index seek of the state index: no SCAN, no key-range read. */
  const revokeReads = (plans: { sql: string; plan: string[] }[]) => plans.flatMap(({ plan }) => plan).filter(step => /\bmemory_revoke_jobs\b/.test(step));

  it("the state index the probe names is the registered one, and exists before the probes run", () => {
    expect(REVOKE_STATE_INDEX).toBe(REVOKE_JOB_STATE.name);
    const db = database();
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(REVOKE_STATE_INDEX)).toBeDefined();
  });

  it(`${JOBS} finished jobs: nothing is raised, and every read of the table is a seek of the state index (no scan, no id span)`, async () => {
    const empty = await reopen();
    seed(finished);
    const full = await reopen();
    expect(full.raised).toBe(false); // finished work is not work: no wake, whatever the size of the table
    const steps = revokeReads(full.plans);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const step of steps) expect(step).toMatch(new RegExp(`^SEARCH memory_revoke_jobs USING COVERING INDEX ${REVOKE_STATE_INDEX} \\(state[<>]`));
    expect(full.plans.map(({ sql }) => sql).join("\n")).not.toMatch(/max\(|min\(|ORDER BY revoke_id/i);
    console.log(`GATE-MEASURE W-PROBE revoke open statements: empty=${empty.statements} with-${JOBS}-finished=${full.statements}`);
    expect(full.statements).toBe(empty.statements); // a fixed statement list (the plans above and below are what make each one O(1))
    // G-START: no read this lane's installer and probes make scans a history table (the schema list is the only scan: sqlite_schema, not
    // history). A lane's onWakeInstall hook runs on the handle itself and is that lane's own G-START share.
    const scans = full.plans.flatMap(({ sql, plan }) => plan.filter(step => /^SCAN (?!sqlite_schema\b|sqlite_master\b|CONSTANT ROW$)/.test(step)).map(step => `${step} <- ${sql}`));
    expect(scans).toEqual([]);
  });

  for (const state of ["active", "failed", "seeding", "waiting"]) {
    it(`one '${state}' job at id ${MIDDLE} among ${JOBS - 1} finished ones is found at open (each gap of the index around the finished states)`, async () => {
      seed(id => (id === MIDDLE ? state : finished(id)));
      const open = await reopen();
      expect(open.raised).toBe(true);
      for (const step of revokeReads(open.plans)) expect(step).toMatch(/^SEARCH memory_revoke_jobs USING COVERING INDEX /);
    });
  }

  it("a file without the state index raises revoke without reading the table (fail towards the wake; the subscriber reads for itself)", async () => {
    seed(finished);
    const db = database();
    db.exec(`DROP INDEX ${REVOKE_STATE_INDEX}`);
    await turns();
    const seen: string[] = [];
    setWakeStatementTapForTest(sql => { seen.push(sql); });
    let found: string[];
    try { found = probeWakes("witness"); } finally { setWakeStatementTapForTest(null); }
    expect(found).toContain("revoke");
    expect(seen.filter(sql => /memory_revoke_jobs/.test(sql))).toEqual([REVOKE_UNFINISHED_PROBE]); // the one indexed read, refused at prepare
    expect(() => db.prepare(REVOKE_UNFINISHED_PROBE)).toThrow(/no such index/);
  });
});

describe("the installer: start-up cost, each lane's open hook, and the fail-closed path", () => {
  it("an open costs a fixed, small number of statements whatever the file holds (the G-START share of M0), and none on the metered path", async () => {
    const cost = () => { const before = wakeStats().setupStatements; closeDatabase(); database(); return wakeStats().setupStatements - before; };
    database();
    const empty = cost();
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit','{}',1,1,'mark','',?)");
    for (let id = 1; id <= 3000; id++) insert.run(id, id % 7 === 0 ? "active" : "done");
    for (let i = 0; i < 500; i++) db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,1,?)").run(`thread-${i}`, i);
    db.exec("COMMIT");
    const full = cost();
    console.log(`GATE-MEASURE W-INSTALL setup statements per open: empty=${empty} with-3000-jobs=${full} bound=30`);
    expect(empty).toBeLessThanOrEqual(30);
    expect(full).toBeLessThanOrEqual(empty); // a probe that finds work stops early: never more reads on a larger file
  });

  it("a lane's open hook runs on every open, after the triggers exist and before the probes raise", async () => {
    const seen: string[] = [];
    onWakeInstall(db => { seen.push(`hook:${Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE name='mem_wake'").get()!.n)}:${wakeStats().probes}`); });
    const probesBefore = wakeStats().probes;
    database(); closeDatabase(); database();
    expect(seen).toEqual([`hook:1:${probesBefore}`, `hook:1:${probesBefore + 1}`]);
    const off = onWakeInstall(() => { throw new Error("a broken hook"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    closeDatabase(); const db = database();
    expect(wakeInstalled(db)).toBe(true); // a hook that throws does not undo the install
    off(); warn.mockRestore();
  });

  it("a failed install on a writable handle sets memory aside (fail closed), tells the owner once, and the next good open clears it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setWakeInstallFaultForTest(() => { throw new Error("no temp space"); });
    watchMemo("fence_witness", ["memory_deny_pending"]);
    let db = database();
    expect(wakeInstalled(db)).toBe(false);
    expect(memoryHoldCode()).toBe("MEMORY_WAKE_INSTALL");
    expect(memoryGate(db, "render-learned")).toBe("held:MEMORY_WAKE_INSTALL"); // every use of memory is refused
    expect(memoryGate(db, "replay")).toBe("held:MEMORY_WAKE_INSTALL");
    expect(memoryGate(db, "capture")).toBe("ok"); // what a turn says is still recorded: the next open's probes find the rows
    expect(memoVersion("fence_witness")).not.toBe(memoVersion("fence_witness")); // no memo can match
    expect(error.mock.calls.filter(call => String(call[0]).includes("[memory-wake] install failed")).length).toBe(1);
    db.prepare(WINDOW()).run(); // writes still work; no drain is attempted on a bus that is not there
    await turns();
    expect(wakeStats().drains).toBe(0);
    setWakeInstallFaultForTest(null);
    closeDatabase(); db = database();
    expect(wakeInstalled(db)).toBe(true); expect(memoryHoldCode()).toBeNull(); expect(memoryGate(db, "render-learned")).toBe("ok");
    const window = listen("window");
    await turns();
    expect(window).toEqual(["window"]); // the probe finds what was written while the bus was down
    error.mockRestore();
  });
});

describe("W-WAKE: a subscriber that stops with work left is never stranded", () => {
  it("2,376 standing jobs, the ledger spent after each page, nothing else writing: the queue drains to empty on deadlines alone", async () => {
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit','{}',1,1,'mark','','active')");
    for (let id = 1; id <= 2376; id++) insert.run(id);
    db.exec("COMMIT");
    const faults: Error[] = []; setWakeFaultSink(error => faults.push(error));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let pages = 0;
    onWake("revoke", context => {
      // one page per "minute" of budget: the pace is spent after it, so the subscriber names the instant the minute reopens
      const done = db.prepare("UPDATE memory_revoke_jobs SET state='done',phase='done' WHERE revoke_id IN (SELECT revoke_id FROM memory_revoke_jobs WHERE state='active' ORDER BY revoke_id LIMIT 256)").run();
      pages++;
      const left = Number(db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'").get()!.n);
      if (left > 0) context.armDeadline(Date.now() + 60_000);
      void done;
      return { more: left > 0 };
    }, { priority: WAKE_PRIORITY.closing });
    await turns();
    expect(pages).toBe(1); // the commit's own wake
    for (let minute = 0; minute < 12 && Number(db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'").get()!.n) > 0; minute++) {
      expect(wakeStats()).toMatchObject({ timerArmed: true }); // ONE timer, for the next due time
      await vi.advanceTimersByTimeAsync(60_000);
      await turns();
    }
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'").get()!.n)).toBe(0);
    expect(pages).toBe(Math.ceil(2376 / 256));
    expect(wakeStats().timerArmed).toBe(false); // nothing due: no timer
    expect(faults).toEqual([]);
  });

  it("more=true with neither a deadline nor a gate is a fault, and the topic is still retried (late, never lost)", async () => {
    database(); await turns();
    const faults: Error[] = []; setWakeFaultSink(error => faults.push(error));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let runs = 0;
    onWake("jobs", () => { runs++; return { more: runs === 1 }; }, { name: "forgetful" });
    raise("jobs");
    await turns();
    expect(runs).toBe(1);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(LostWakeError);
    expect(faults[0]!.message).toContain("forgetful");
    await vi.advanceTimersByTimeAsync(999); await turns();
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await turns();
    expect(runs).toBe(2);
  });

  it("more=true with a deadline armed, or with a gate named, is no fault; the gate's release runs the subscriber again", async () => {
    database(); await turns();
    const faults: Error[] = []; setWakeFaultSink(error => faults.push(error));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let runs = 0;
    onWake("jobs", context => { runs++; if (runs === 1) { context.until(gate); return { more: true }; } return undefined; });
    raise("jobs"); await turns();
    expect(runs).toBe(1);
    await turns();
    expect(runs).toBe(1);
    release(); await turns();
    expect(runs).toBe(2);
    expect(faults).toEqual([]);
    expect(wakeStats().timerArmed).toBe(false);
  });

  it("a deadline that is already due means the next turn of the event loop (slice over), with no timer wait", async () => {
    database(); await turns();
    setWakeFaultSink(error => { throw error; });
    let runs = 0;
    onWake("journal", context => { runs++; if (runs < 4) { context.armDeadline(Date.now()); return true; } return false; });
    raise("journal");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(runs).toBe(4);
  });

  it("a subscriber that throws keeps its topic and retries after 1 s, doubling to 60 s; other subscribers are not held up", async () => {
    database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const at: number[] = [], start = Date.now();
    onWake("projection", () => { attempts++; at.push(Date.now() - start); throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }); }, { name: "busy-one" });
    const other = listen("projection");
    raise("projection"); await turns();
    expect(attempts).toBe(1); expect(other).toEqual(["projection"]);
    for (let second = 0; second < 130; second++) { await vi.advanceTimersByTimeAsync(1_000); await turns(2); }
    expect(at.slice(0, 8)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000]);
    expect(other).toEqual(["projection"]); // the retry is the failing subscriber's own
    expect(warn.mock.calls.filter(call => String(call[0]).includes("busy-one")).length).toBe(1); // logged once, by class
    expect(String(warn.mock.calls[0]![0])).toContain("class=BUSY");
    warn.mockRestore();
    expect(errorClass(new Error("SQLITE_FULL: database or disk is full"))).toBe("FULL");
    expect(errorClass(Object.assign(new Error("later"), { name: "BgDeferred" }))).toBe("deferred");
    expect(errorClass(new Error("recall quota reached"))).toBe("quota");
    expect(errorClass(new Error("anything"))).toBe("other");
  });

  it("a failing subscriber is not turned into a loop by wakes that keep arriving: it runs again at its retry time, and then reads them", async () => {
    database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    onWake("jobs", () => { attempts++; if (attempts === 1) throw new Error("database is locked"); });
    raise("jobs"); await turns();
    for (let i = 0; i < 20; i++) { raise("jobs"); await turns(1); }
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); await turns();
    expect(attempts).toBe(2);
    raise("jobs"); await turns();
    expect(attempts).toBe(3); // healthy again: wakes are delivered at once
    warn.mockRestore();
  });

  it("one slice per turn, by priority: owner, closing, applier, background; a higher wake raised between slices goes first", async () => {
    database(); await turns();
    const order: string[] = [];
    onWake("t", () => { order.push("background"); }, { priority: WAKE_PRIORITY.background });
    onWake("t", () => { order.push("applier"); }, { priority: WAKE_PRIORITY.applier });
    onWake("t", () => { order.push("closing"); raise("owner-topic"); }, { priority: WAKE_PRIORITY.closing });
    onWake("owner-topic", () => { order.push("owner"); }, { priority: WAKE_PRIORITY.owner });
    raise("t");
    await turn();
    expect(order).toEqual(["closing"]); // one slice, then the event loop
    await turns();
    expect(order).toEqual(["closing", "owner", "applier", "background"]);
  });

  it("an async subscriber is not re-entered: a wake that arrives while it runs is delivered when it settles", async () => {
    database(); await turns();
    let running = 0, peak = 0, runs = 0, finish!: () => void;
    onWake("jobs", async () => { runs++; running++; peak = Math.max(peak, running); if (runs === 1) await new Promise<void>(resolve => { finish = resolve; }); running--; });
    raise("jobs"); await turns();
    raise("jobs"); raise("jobs"); await turns();
    expect(runs).toBe(1);
    finish(); await turns();
    expect(runs).toBe(2); expect(peak).toBe(1);
  });

  it("unsubscribe stops delivery and drops the subscriber's retry", async () => {
    database(); await turns();
    const runs: number[] = [];
    const off = onWake("jobs", () => { runs.push(1); });
    raise("jobs"); off(); await turns();
    expect(runs).toEqual([]);
    expect(wakeStats().owed).toBe(0);
  });
});

// (The bus's own accounting is read, not vi.getTimerCount(): other parts of the server arm timers of their own after a commit.)
describe("the deadline registry (3.2): the only timer memory holds", () => {
  it("no deadline, no timer; one timer for the earliest due time; the earliest of a topic wins; disarm frees the timer", async () => {
    database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    expect(wakeStats().timerArmed).toBe(false);
    const a = listen("lease"), b = listen("retry");
    const t0 = Date.now();
    armDeadline("lease", t0 + 5_000); armDeadline("retry", t0 + 2_000); armDeadline("lease", t0 + 9_000); // later than the armed one: ignored
    expect(deadlineOf("lease")).toBe(t0 + 5_000);
    expect(wakeStats()).toMatchObject({ timerArmed: true });
    await vi.advanceTimersByTimeAsync(1_999); await turns();
    expect([a, b]).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(1); await turns();
    expect([a, b]).toEqual([[], ["retry"]]);
    expect(wakeStats()).toMatchObject({ timerArmed: true }); // re-armed for the next one
    armDeadline("lease", t0 + 3_000); // earlier: wins
    await vi.advanceTimersByTimeAsync(1_000); await turns();
    expect(a).toEqual(["lease"]);
    expect(wakeStats().timerArmed).toBe(false);
    armDeadline("lease", t0 + 60_000); expect(wakeStats()).toMatchObject({ timerArmed: true });
    disarmDeadline("lease"); expect(wakeStats().timerArmed).toBe(false); expect(deadlineOf("lease")).toBeUndefined();
    expect(() => armDeadline("lease", Number.NaN)).toThrow(TypeError);
  });

  it("after a sleep the due deadlines run once on the first event (a commit), without waiting for the stale timer", async () => {
    const db = database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let clock = 1_000_000; setWakeClockForTest(() => clock);
    const lease = listen("lease"), far = listen("far");
    armDeadline("lease", clock + 30_000); armDeadline("far", clock + 3_600_000);
    clock += 600_000; // the machine slept ten minutes; the timer has not fired
    db.prepare(WINDOW()).run(); // the first event
    await turns();
    expect(lease).toEqual(["lease"]); expect(far).toEqual([]);
    expect(wakeStats()).toMatchObject({ timerArmed: true }); // armed again, for the one that is still ahead
    await vi.advanceTimersByTimeAsync(60_000); await turns();
    expect(lease).toEqual(["lease"]); // once
  });
});

describe("W-GUARD: guards and registered functions on the SQLite the app ships", () => {
  const journal = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_changes WHERE kind='job'").get()!.n);
  const JOB = (id: string, source = "src-a") => `INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES('${id}','${source}',1,'capture','${id}','pending',0,0)`;

  it("G-JOB: an UPDATE that keeps rowid, id and source writes no journal row; an INSERT, a DELETE and an id or source change still do", () => {
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(JOB("job-a")); db.exec(JOB("job-b"));
    expect(journal(db)).toBe(2); // the inserts are journaled
    const base = journal(db);
    db.exec("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_generation=1,lease_until=10 WHERE id='job-a'");
    db.exec("UPDATE memory_jobs SET lease_until=20 WHERE id='job-a'"); // the heartbeat
    db.exec("UPDATE memory_jobs SET status='complete',cursor=3 WHERE id='job-a'");
    db.exec("UPDATE memory_jobs SET attempts=attempts+1"); // two rows in one statement
    expect(journal(db)).toBe(base);
    db.exec("UPDATE memory_jobs SET source_id='src-b' WHERE id='job-a'");
    expect(journal(db)).toBe(base + 1);
    db.exec("UPDATE memory_jobs SET id='job-c' WHERE id='job-b'");
    expect(journal(db)).toBe(base + 2);
    db.exec("UPDATE memory_jobs SET lease_until=30 WHERE id='job-a'"); db.exec("DELETE FROM memory_jobs WHERE id='job-a'");
    expect(journal(db)).toBe(base + 3);
    db.exec(JOB("job-d"));
    expect(journal(db)).toBe(base + 4);
    // the note lets through one row for one update, never a later row of another kind for the same id
    db.exec("UPDATE memory_jobs SET lease_until=40 WHERE id='job-d'");
    db.exec("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job','job-d',0)");
    expect(journal(db)).toBe(base + 5);
  });

  it("G-JOB is connection-local: a connection without the guard journals every update, as every older build does", () => {
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF"); db.exec(JOB("job-a"));
    const base = journal(db);
    const plain = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { plain.exec("PRAGMA busy_timeout=1000; UPDATE memory_jobs SET lease_until=20 WHERE id='job-a'"); } finally { plain.close(); }
    expect(journal(db)).toBe(base + 1);
  });

  const epoch = (db: DatabaseSync) => Number(db.prepare("SELECT epoch FROM memory_recall_epoch WHERE id=1").get()!.epoch);
  const project = (db: DatabaseSync) => { db.exec("INSERT INTO project_settings(group_id,updated_at) VALUES('group-a',1),('group-b',1)"); };
  const VIEWED = { name: "project_viewed", table: "project_settings", column: "owner_viewed_at" };

  it("G-VISIT: the flagged presentation statement does not move the recall epoch; the same statement unflagged does", () => {
    const db = database(); project(db);
    declarePresentationWriter(VIEWED);
    const before = epoch(db);
    db.prepare("UPDATE project_settings SET owner_viewed_at=? WHERE group_id=?").run(5, "group-a");
    expect(epoch(db)).toBe(before + 1); // today's behaviour, and the behaviour of every unflagged statement
    presentationWrite(db, "project_viewed", () => db.prepare("UPDATE project_settings SET owner_viewed_at=? WHERE group_id=?").run(6, "group-a"));
    expect(epoch(db)).toBe(before + 1);
    expect(Number(db.prepare("SELECT owner_viewed_at AS at FROM project_settings WHERE group_id='group-a'").get()!.at)).toBe(6);
    presentationWrite(db, "project_viewed", () => db.exec("UPDATE project_settings SET owner_viewed_at=7")); // both rows
    expect(epoch(db)).toBe(before + 1);
    // the flag never outlives its statement: the next authority change moves the epoch
    db.exec("UPDATE project_settings SET mode='ongoing' WHERE group_id='group-a'");
    expect(epoch(db)).toBe(before + 2);
  });

  it("G-VISIT: a flagged statement that touches an authority column aborts, changes nothing and leaves no flag behind", () => {
    const db = database(); project(db);
    declarePresentationWriter(VIEWED);
    const before = epoch(db);
    expect(() => presentationWrite(db, "project_viewed", () => db.exec("UPDATE project_settings SET owner_viewed_at=9,lead_bot_id='bot-x' WHERE group_id='group-a'"))).toThrow(/presentation write changed another column/);
    expect(db.prepare("SELECT owner_viewed_at AS at,lead_bot_id AS lead FROM project_settings WHERE group_id='group-a'").get()).toEqual({ at: null, lead: null });
    expect(epoch(db)).toBe(before);
    expect(() => presentationWrite(db, "project_viewed", () => db.exec("DELETE FROM project_settings WHERE group_id='group-b'"))).toThrow(/may only update its column/);
    expect(() => presentationWrite(db, "project_viewed", () => db.exec("INSERT INTO project_settings(group_id,updated_at) VALUES('group-c',1)"))).toThrow(/may only update its column/);
    db.exec("UPDATE project_settings SET lead_bot_id='bot-y' WHERE group_id='group-a'");
    expect(epoch(db)).toBe(before + 1);
  });

  it("G-VISIT: only the epoch move of a validated row is dropped; any other epoch move inside the flagged call still happens", () => {
    const db = database(); project(db);
    declarePresentationWriter(VIEWED);
    const before = epoch(db);
    presentationWrite(db, "project_viewed", () => {
      db.exec("UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1"); // not preceded by a validated row
      db.exec("UPDATE project_settings SET owner_viewed_at=3 WHERE group_id='group-a'");
      db.exec("UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1"); // the row's one allowance is spent
    });
    expect(epoch(db)).toBe(before + 2);
    expect(() => presentationWrite(db, "project_viewed", () => presentationWrite(db, "project_viewed", () => 1))).toThrow(/already running/);
    expect(() => presentationWrite(db, "nobody", () => 1)).toThrow(/no writer named/);
    expect(() => declarePresentationWriter({ name: "second", table: "project_settings", column: "mode" })).toThrow(/already has/);
  });

  it("G-VISIT: a table without exactly one persisted epoch trigger gets no guard, and its writer runs unflagged", () => {
    const db = database();
    declarePresentationWriter({ name: "meta_note", table: "memory_revoke_jobs", column: "cursor" }); // no persisted trigger moves the epoch for this table
    expect(Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE name LIKE 'mem\\_visit\\_meta\\_note%' ESCAPE '\\'").get()!.n)).toBe(0);
    const before = epoch(db);
    presentationWrite(db, "meta_note", () => {
      expect(db.prepare("SELECT murage_presenting() AS flag").get()!.flag).toBeNull(); // unflagged
      db.exec("UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1");
    });
    expect(epoch(db)).toBe(before + 1);
  });

  it("memo versions: a registered function is callable from a TEMP trigger; a watched write moves the version, a no-op and another table do not", () => {
    const db = database();
    watchMemo("fence_witness", ["memory_deny_pending", "memory_deny_pending_scope"]);
    const v0 = memoVersion("fence_witness");
    expect(memoVersion("fence_witness")).toBe(v0); // stable while nothing changes
    db.prepare("SELECT count(*) FROM memory_deny_pending").get();
    db.exec("DELETE FROM memory_deny_pending WHERE thread_id='absent'"); // changes 0 rows
    db.exec(REVOKE(1)); // an unwatched table
    expect(memoVersion("fence_witness")).toBe(v0);
    db.exec(WINDOW());
    const v1 = memoVersion("fence_witness"); expect(v1).toBeGreaterThan(v0);
    db.exec("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('scope-a',1,1)");
    const v2 = memoVersion("fence_witness"); expect(v2).toBeGreaterThan(v1);
    db.exec("UPDATE memory_deny_pending_scope SET since_lsn=2"); const v3 = memoVersion("fence_witness"); expect(v3).toBeGreaterThan(v2);
    db.exec("DELETE FROM memory_deny_pending_scope"); expect(memoVersion("fence_witness")).toBeGreaterThan(v3);
    expect(() => memoVersion("undeclared")).toThrow(/no memo named/);
    expect(() => watchMemo("Bad Name", ["memory_jobs"])).toThrow(/bad memo name/);
  });

  it("memo versions never return to an old number: every ROLLBACK, ROLLBACK TO and statement abort moves them (rule 3.4 b, GAP 21)", () => {
    const db = database();
    watchMemo("fence_witness", ["memory_deny_pending"]);
    const seen = new Set<number>([memoVersion("fence_witness")]);
    const moved = () => { const v = memoVersion("fence_witness"); const isNew = !seen.has(v) && v > Math.max(...seen); seen.add(v); return isNew; };
    db.exec("BEGIN IMMEDIATE"); db.exec(WINDOW()); expect(moved()).toBe(true);
    db.exec("ROLLBACK"); expect(moved()).toBe(true); // the row is gone: an entry made before the insert must not match again
    db.exec("BEGIN IMMEDIATE"); db.exec("SAVEPOINT a"); db.exec(WINDOW()); expect(moved()).toBe(true);
    db.exec("ROLLBACK TO a"); expect(moved()).toBe(true);
    db.prepare("ROLLBACK TO a").run(); expect(moved()).toBe(true); // the prepared form
    db.exec("RELEASE a"); db.exec("COMMIT");
    db.exec("BEGIN IMMEDIATE");
    expect(() => db.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('x',1,1),('x',1,1)")).toThrow(); // a statement abort undoes its first row
    expect(moved()).toBe(true);
    db.exec("COMMIT");
    expect(() => transaction(d => { d.exec(WINDOW()); throw new Error("undo"); })).toThrow("undo");
    expect(moved()).toBe(true);
    // a statement abort moves them even when the failed statement touched no watched table (the rule is about the connection, not the table)
    db.exec("BEGIN IMMEDIATE"); db.exec(REVOKE(50));
    const settledBefore = memoVersion("fence_witness");
    expect(() => db.exec(REVOKE(50))).toThrow();
    expect(memoVersion("fence_witness")).toBeGreaterThan(settledBefore);
    db.exec("COMMIT");
  });

  it("memo versions are per handle: with no connection every read is a new number, and a reopened handle never sees an old one (rule 3.4 a)", () => {
    watchMemo("fence_witness", ["memory_deny_pending"]);
    const cold = memoVersion("fence_witness");
    expect(memoVersion("fence_witness")).toBeGreaterThan(cold); // not installed: nothing may match
    database();
    const warm = memoVersion("fence_witness");
    expect(warm).toBeGreaterThan(cold); expect(memoVersion("fence_witness")).toBe(warm);
    closeDatabase();
    const closed = memoVersion("fence_witness"); expect(closed).toBeGreaterThan(warm);
    database();
    const again = memoVersion("fence_witness"); expect(again).toBeGreaterThan(closed); expect(memoVersion("fence_witness")).toBe(again);
    // a watch on a table that does not exist is never installed: fail closed
    watchMemo("ghost", ["memory_no_such_table"]);
    expect(memoVersion("ghost")).not.toBe(memoVersion("ghost"));
  });
});

describe("W-ORPHAN-COMMIT: a commit by another connection whose writer dies cannot strand work", () => {
  const foreignCommit = (sql: string) => { const other = new DatabaseSync(join(DATA_DIR, "messages.db")); try { other.exec(`PRAGMA busy_timeout=1000; BEGIN IMMEDIATE; ${sql}; COMMIT`); } finally { other.close(); } };

  it("the worker's exit (or error) runs the open-time probes again and the subscriber runs, with no timer", async () => {
    database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const window = listen("window"), revoke = listen("revoke");
    const worker = new EventEmitter(); adoptWorker(worker, "witness-worker");
    foreignCommit(WINDOW()); // committed on another connection: this connection's triggers saw nothing
    await turns();
    expect(window).toEqual([]);
    worker.emit("exit", 1);
    await turns();
    expect(window).toEqual(["window"]); expect(revoke).toEqual([]);
    foreignCommit(REVOKE(3));
    worker.emit("error", new Error("worker died"));
    await turns();
    expect(revoke).toEqual(["revoke"]);
    expect(wakeStats().timerArmed).toBe(false);
  });

  it("an opener whose guard proves it wrote no wake table causes no probe when it exits (work has a named cause)", async () => {
    database(); await turns();
    const before = wakeStats().probes;
    for (const name of ["root-set-reclaim", "optional-index", "provenance-stamp", "root-set-compaction"]) { const worker = new EventEmitter(); worker.on("error", () => {}); adoptWorker(worker, name); worker.emit("exit", 0); worker.emit("error", new Error("x")); }
    await turns();
    expect(wakeStats().probes).toBe(before);
  });

  it("a worker's notice raises exactly the topics it names", async () => {
    database(); await turns();
    const window = listen("window"), jobs = listen("jobs");
    const worker = new EventEmitter(); adoptWorker(worker, "witness-worker");
    worker.emit("message", wakeNotice(["jobs"])); worker.emit("message", { type: "something-else", topics: ["window"] }); worker.emit("message", null);
    await turns();
    expect(jobs).toEqual(["jobs"]); expect(window).toEqual([]);
  });

  it("an acknowledgement 5 s late runs the probes; one that arrives in time leaves no timer", async () => {
    database(); await turns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const window = listen("window");
    foreignCommit(WINDOW());
    const acknowledged = expectAck("helper-apply");
    expect(wakeStats()).toMatchObject({ timerArmed: true });
    acknowledged();
    expect(wakeStats().timerArmed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); await turns();
    expect(window).toEqual([]);
    expectAck("helper-apply"); // never acknowledged
    await vi.advanceTimersByTimeAsync(4_999); await turns();
    expect(window).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await turns();
    expect(window).toEqual(["window"]);
  });
});
