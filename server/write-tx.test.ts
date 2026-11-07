// SPDX-License-Identifier: AGPL-3.0-or-later
// DBBUSY-1018: a write frame opened with beginWrite claims the write lock first, so a commit on another connection (the
// checkpointer worker's merge slice) makes it wait instead of failing with SQLITE_BUSY_SNAPSHOT (517) at its first write.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { afterCommit, scopedTx } from "./tx-scope.ts";
import { beginRead, beginWrite, endWrite, undoWrite } from "./write-tx.ts";

const open: DatabaseSync[] = [];
function fileDb(): string {
  const file = join(mkdtempSync(join(tmpdir(), "write-tx-")), "t.db");
  const db = connect(file, 0);
  db.exec("CREATE TABLE t(v INTEGER)");
  return file;
}
function connect(file: string, busyMs: number): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`PRAGMA busy_timeout=${busyMs}`);
  open.push(db);
  return db;
}
const count = (db: DatabaseSync) => Number((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n);
afterEach(() => { for (const db of open.splice(0)) { try { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); } catch { /* closed */ } } });

describe("beginWrite (write-tx.ts)", () => {
  it("control: a deferred SAVEPOINT that read before another connection committed fails its write with 517", () => {
    const file = fileDb();
    const owner = connect(file, 1000), worker = connect(file, 0);
    owner.exec("SAVEPOINT p");
    count(owner);
    worker.exec("INSERT INTO t VALUES (1)");
    let code: unknown;
    try { owner.exec("INSERT INTO t VALUES (2)"); } catch (error) { code = (error as { errcode?: number }).errcode; }
    expect(code).toBe(517);
  });

  it("waits for a writer on another connection, then reads its commit and writes, with no error", async () => {
    // Ordering, not wall clock: the worker takes the write lock and holds it until the parent says go; the parent proves the
    // lock is held (a busy_timeout=0 probe is answered busy), says go and opens its frame at once. The worker commits only
    // after go, so the frame either waits in its busy handler for that commit or (if the parent was slow) starts after it;
    // either way it must see the worker's row and write with no 517.
    const file = fileDb();
    const flag = new Int32Array(new SharedArrayBuffer(8)); // [0] lock held, [1] go
    const holder = new Worker(`
      const { workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.file);
      db.exec("PRAGMA busy_timeout=0");
      db.exec("BEGIN IMMEDIATE");
      db.exec("INSERT INTO t VALUES (1)");
      Atomics.store(workerData.flag, 0, 1); Atomics.notify(workerData.flag, 0);
      while (Atomics.load(workerData.flag, 1) === 0) Atomics.wait(workerData.flag, 1, 0, 50);
      Atomics.wait(workerData.flag, 0, 1, 100); // give the parent's beginWrite time to reach its busy handler
      db.exec("COMMIT"); db.close();
    `, { eval: true, workerData: { file, flag } });
    const exited = new Promise(resolve => holder.once("exit", resolve));
    while (Atomics.load(flag, 0) === 0) await new Promise(resolve => setTimeout(resolve, 5));
    const probe = connect(file, 0);
    let held: unknown;
    try { probe.exec("BEGIN IMMEDIATE"); } catch (error) { held = (error as { errcode?: number }).errcode; }
    expect(Number(held) & 0xff).toBe(5);
    const owner = connect(file, 10000);
    Atomics.store(flag, 1, 1); Atomics.notify(flag, 1);
    beginWrite(owner, "p");
    expect(count(owner)).toBe(1);
    owner.exec("INSERT INTO t VALUES (2)");
    endWrite(owner, "p");
    expect(owner.isTransaction).toBe(false);
    await exited;
    expect(count(connect(file, 0))).toBe(2);
  });

  it("a connection with busy_timeout=0 (the merge worker) meeting an open frame is answered busy at once", () => {
    const file = fileDb();
    const owner = connect(file, 1000), worker = connect(file, 0);
    beginWrite(owner, "p");
    count(owner);
    let code: unknown;
    try { worker.exec("BEGIN IMMEDIATE"); } catch (error) { code = (error as { errcode?: number }).errcode; }
    expect(Number(code) & 0xff).toBe(5);
    owner.exec("INSERT INTO t VALUES (1)");
    endWrite(owner, "p");
    worker.exec("BEGIN IMMEDIATE"); worker.exec("INSERT INTO t VALUES (2)"); worker.exec("COMMIT");
    expect(count(owner)).toBe(2);
  });

  it("inside an open transaction it is a savepoint only: endWrite does not commit, undoWrite drops only its own writes", () => {
    const db = connect(fileDb(), 0);
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO t VALUES (1)");
    beginWrite(db, "inner");
    db.exec("INSERT INTO t VALUES (2)");
    endWrite(db, "inner");
    expect(db.isTransaction).toBe(true);
    beginWrite(db, "inner2");
    db.exec("INSERT INTO t VALUES (3)");
    undoWrite(db, "inner2");
    expect(db.isTransaction).toBe(true);
    db.exec("COMMIT");
    expect(count(db)).toBe(2);
  });

  it("the refusal shape (ROLLBACK TO the point, then endWrite) keeps nothing and ends the transaction", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "p");
    db.exec("INSERT INTO t VALUES (1)");
    db.exec("ROLLBACK TO p");
    endWrite(db, "p");
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("undoWrite of a top-level frame rolls the whole transaction back", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "p");
    db.exec("INSERT INTO t VALUES (1)");
    undoWrite(db, "p");
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("same-name nesting commits only at the outer endWrite", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "p");
    beginWrite(db, "p");
    db.exec("INSERT INTO t VALUES (1)");
    endWrite(db, "p");
    expect(db.isTransaction).toBe(true);
    endWrite(db, "p");
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(1);
  });

  it("an inner frame left open (its undo failed) does not stop the outer undo from ending the transaction", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "outer");
    beginWrite(db, "inner");
    db.exec("INSERT INTO t VALUES (1)");
    undoWrite(db, "outer");
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("a top-level frame after a transaction ended elsewhere starts clean", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "p");
    db.exec("ROLLBACK"); // a raw rollback (project-card-executor's dispatch path) ends it behind the helper's back
    beginWrite(db, "q");
    db.exec("INSERT INTO t VALUES (1)");
    endWrite(db, "q");
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(1);
  });
  it("a failed top-level RELEASE rolls the whole transaction back itself; the caller's undo is then a no-op", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "p");
    db.exec("INSERT INTO t VALUES (1)");
    db.exec("RELEASE p"); // the savepoint is gone behind the helper's back; the BEGIN IMMEDIATE is still open
    expect(() => endWrite(db, "p")).toThrow();
    expect(db.isTransaction).toBe(false);
    undoWrite(db, "p");
    expect(count(db)).toBe(0);
    beginWrite(db, "q"); db.exec("INSERT INTO t VALUES (2)"); endWrite(db, "q");
    expect(count(db)).toBe(1);
  });

  it("a failed nested RELEASE keeps its frame for the caller's undo, and the outer undo still ends the transaction", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "o");
    beginWrite(db, "i");
    db.exec("INSERT INTO t VALUES (1)");
    db.exec("RELEASE i");
    expect(() => endWrite(db, "i")).toThrow();
    expect(db.isTransaction).toBe(true);
    expect(() => undoWrite(db, "i")).toThrow(); // its savepoint is gone too; the frame still leaves the stack
    undoWrite(db, "o");
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("same-name nesting with the inner frame released behind the helper's back: inner undo, then outer undo, ends it", () => {
    const db = connect(fileDb(), 0);
    beginWrite(db, "p");
    db.exec("INSERT INTO t VALUES (1)");
    beginWrite(db, "p");
    db.exec("INSERT INTO t VALUES (2)");
    db.exec("RELEASE p"); // releases the inner p only
    undoWrite(db, "p");   // inner frame: ROLLBACK TO / RELEASE now act on the outer savepoint, which the outer frame survives
    expect(db.isTransaction).toBe(true);
    undoWrite(db, "p");   // the outer frame is still found and ends the whole transaction
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("a failed endWrite inside scopedTx runs no commit hook and leaves nothing written", () => {
    const db = connect(fileDb(), 0);
    let ran = false;
    expect(() => scopedTx(() => {
      beginWrite(db, "p");
      try {
        afterCommit(() => { ran = true; });
        db.exec("INSERT INTO t VALUES (1)");
        db.exec("RELEASE p");
        endWrite(db, "p");
      } catch (error) { undoWrite(db, "p"); throw error; }
    })).toThrow();
    expect(ran).toBe(false);
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  it("beginRead does not wait for a writer on another connection and reads the last commit", () => {
    // busy_timeout=0 on the reader: if beginRead ever asked for the writer lock it would be answered busy at once and throw,
    // so "no throw, count=1 while the writer holds its lock" is the whole check, with no clock.
    const file = fileDb();
    const owner = connect(file, 0), worker = connect(file, 0);
    worker.exec("INSERT INTO t VALUES (1)");
    worker.exec("BEGIN IMMEDIATE");
    worker.exec("INSERT INTO t VALUES (2)");
    expect(() => beginRead(owner, "r")).not.toThrow();
    expect(count(owner)).toBe(1);
    expect(() => endWrite(owner, "r")).not.toThrow();
    expect(owner.isTransaction).toBe(false);
    worker.exec("COMMIT");
    expect(count(owner)).toBe(2);
  });

  it("a failed ROLLBACK with the transaction still open keeps ownership and throws; the next undo ends it", () => {
    // A stub handle: ROLLBACK fails (transaction stays open) while `failRollback` is set. No real SQLite build fails a plain
    // ROLLBACK on demand, so this checks the helper's bookkeeping only.
    let inTx = false, failRollback = false;
    const run: string[] = [];
    const stub = {
      get isTransaction() { return inTx; },
      exec(sql: string) {
        run.push(sql);
        if (sql.startsWith("BEGIN")) inTx = true;
        else if (sql === "ROLLBACK") { if (failRollback) throw Object.assign(new Error("rollback failed"), { errcode: 5 }); inTx = false; }
        else if (sql === "COMMIT") inTx = false;
        else if (sql.startsWith("RELEASE") && failRollback) throw new Error("release failed");
      },
    } as unknown as DatabaseSync;
    beginWrite(stub, "p");
    failRollback = true;
    expect(() => undoWrite(stub, "p")).toThrow("rollback failed");
    expect(stub.isTransaction).toBe(true);
    expect(() => endWrite(stub, "p")).toThrow("rollback failed"); // RELEASE fails, its ROLLBACK fails: still owned, still open
    failRollback = false;
    undoWrite(stub, "p"); // the outer frame is still found: ROLLBACK, not ROLLBACK TO
    expect(stub.isTransaction).toBe(false);
    expect(run.filter(sql => sql === "ROLLBACK")).toHaveLength(3);
    expect(run.some(sql => sql.startsWith("ROLLBACK TO"))).toBe(false);
    beginWrite(stub, "q"); endWrite(stub, "q");
    expect(stub.isTransaction).toBe(false);
  });

  it("RELEASE ok, COMMIT fails, its ROLLBACK fails: the outer frame stays owned and the next undo is a full ROLLBACK", () => {
    // Stub handle again: COMMIT fails with the transaction still open, then the first ROLLBACK fails too.
    let inTx = false, failCommit = false, failRollback = false;
    const run: string[] = [];
    const stub = {
      get isTransaction() { return inTx; },
      exec(sql: string) {
        run.push(sql);
        if (sql.startsWith("BEGIN")) inTx = true;
        else if (sql === "COMMIT") { if (failCommit) throw Object.assign(new Error("commit failed"), { errcode: 5 }); inTx = false; }
        else if (sql === "ROLLBACK") { if (failRollback) throw Object.assign(new Error("rollback failed"), { errcode: 5 }); inTx = false; }
      },
    } as unknown as DatabaseSync;
    beginWrite(stub, "p");
    failCommit = true; failRollback = true;
    expect(() => endWrite(stub, "p")).toThrow("rollback failed");
    expect(stub.isTransaction).toBe(true);
    failCommit = false; failRollback = false;
    undoWrite(stub, "p"); // the outer frame survived the failed COMMIT: ROLLBACK, never ROLLBACK TO the released point
    expect(stub.isTransaction).toBe(false);
    expect(run.filter(sql => sql === "ROLLBACK")).toHaveLength(2);
    expect(run.some(sql => sql.startsWith("ROLLBACK TO"))).toBe(false);
    beginWrite(stub, "q"); endWrite(stub, "q"); // a fresh frame opens its own transaction and commits it
    expect(run.slice(-4)).toEqual(["BEGIN IMMEDIATE", "SAVEPOINT q", "RELEASE q", "COMMIT"]);
    expect(stub.isTransaction).toBe(false);
  });

  it("RELEASE ok, COMMIT fails and SQLite already ended the transaction: endWrite throws the COMMIT error and owns nothing", () => {
    let inTx = false, failCommit = false;
    const run: string[] = [];
    const stub = {
      get isTransaction() { return inTx; },
      exec(sql: string) {
        run.push(sql);
        if (sql.startsWith("BEGIN")) inTx = true;
        else if (sql === "COMMIT") { inTx = false; if (failCommit) throw new Error("commit failed"); }
        else if (sql === "ROLLBACK") inTx = false;
      },
    } as unknown as DatabaseSync;
    beginWrite(stub, "p");
    failCommit = true;
    expect(() => endWrite(stub, "p")).toThrow("commit failed");
    failCommit = false;
    undoWrite(stub, "p"); // nothing left to do
    expect(run.filter(sql => sql === "ROLLBACK")).toHaveLength(0);
    beginWrite(stub, "q"); endWrite(stub, "q");
    expect(run.slice(-4)).toEqual(["BEGIN IMMEDIATE", "SAVEPOINT q", "RELEASE q", "COMMIT"]);
  });
});

it.each(["RELEASE p", "COMMIT"])("keeps the %s failure beside a failed rollback and permits cleanup retry", failing => {
  const original = new Error("finalization failed"), cleanup = new Error("rollback failed");
  let inTx = false, broken = false;
  const db = {
    get isTransaction() { return inTx; },
    exec(sql: string) {
      if (sql === "BEGIN IMMEDIATE") inTx = true;
      if (broken && sql === failing) throw original;
      if (sql === "ROLLBACK") { if (broken) throw cleanup; inTx = false; }
    },
  } as unknown as DatabaseSync;
  beginWrite(db, "p"); broken = true;
  let failure: unknown;
  try { endWrite(db, "p"); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([original, cleanup]);
  expect((failure as AggregateError).cause).toBe(original);
  expect(db.isTransaction).toBe(true);
  broken = false; undoWrite(db, "p");
  expect(db.isTransaction).toBe(false);
});
