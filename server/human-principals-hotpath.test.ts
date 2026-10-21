// 1.0.3 I/O hot path: a thread's human binding was read once per thread per route, up to 650,000 times a minute
// (`SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-thread'`). It is now remembered for the rest of the
// synchronous run that read it and dropped by any write to memory_scope_bindings. Synthetic data only: nothing here reads a real store.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, threadHumanPrincipal, OWNER } from "./human-principals.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import * as principals from "./human-principals.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function person(userId: string) {
  const id = observeVerifiedHuman({ platform: "slack", authorityId: "TEAM", connectionId: "connection-" + userId, userId });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" });
  return resolveHumanBinding(id);
}
/** Counts statement runs (get, all, run) of statements prepared from now on; `bindings` is the human-thread reads. */
function counters(db: ReturnType<typeof database>) {
  const real = db.prepare.bind(db); const count = { all: 0, bindings: 0 };
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "get" || key === "all" || key === "run" || key === "iterate") { count.all++; if (sql.includes("human-thread")) count.bindings++; }
        return value.apply(target, args);
      };
    } });
  };
  return count;
}
/** The answer with no memory at all: the statement as it was. */
function uncached(threadId: string) {
  const row = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-thread'").get("human-thread:" + threadId);
  return row ? JSON.parse(String(row.intent)) : OWNER;
}
const tick = () => Promise.resolve();
/** The explicit binding scope (Astra iohot2 Low #4); before it existed every synchronous run was one implicitly. */
const scope = <T>(work: () => T): T => ((principals as { withBindingScope?: <R>(w: () => R) => R }).withBindingScope ?? (<R>(w: () => R) => w()))(work);

it("N messages across M threads read each binding at most a handful of times per message, not once per thread", async () => {
  const db = database();
  const people = Array.from({ length: 6 }, (_, i) => person("U" + i));
  const threads = Array.from({ length: 2400 }, (_, i) => `t-${i}`);
  threads.forEach((thread, i) => { if (i % 8 === 0) bindHumanThread(thread, people[i % people.length]); });  // 300 bound, 2,100 owner threads
  const count = counters(db);
  const MESSAGES = 150;
  const started = performance.now();
  for (let m = 0; m < MESSAGES; m++) {
    // one message: the route asks the human of every task thread of the bot and of its rooms (sixteen asks per thread)
    scope(() => { for (let repeat = 0; repeat < 4; repeat++) for (const thread of threads) threadHumanPrincipal(thread); });
    await tick();
  }
  const ms = performance.now() - started;
  const asks = MESSAGES * 4 * threads.length;
  console.log(`[io-hotpath] asks=${asks} statements=${count.all} bindingReads=${count.bindings} ms=${Math.round(ms)}`);
  // before the fix: bindingReads === asks (1,440,000). Now: one bulk read plus the few point reads before it, per message.
  expect(count.bindings).toBeLessThanOrEqual(MESSAGES * 10);
}, 120_000);

it("answers exactly what an uncached read answers over a random run of reads and binding changes, in one tick and across ticks", async () => {
  const db = database();
  const people = [person("UA"), person("UB"), person("UC")];
  const threads = Array.from({ length: 40 }, (_, i) => `r-${i}`);
  let seed = 0x9e3779b9;
  const rand = (n: number) => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return seed % n; };
  const check = (thread: string) => expect(threadHumanPrincipal(thread)).toEqual(uncached(thread));
  for (let step = 0; step < 4000; step++) {
    const thread = threads[rand(threads.length)];
    const op = rand(12);
    if (op < 6) check(thread);
    else if (op === 6) { try { bindHumanThread(thread, people[rand(people.length)]); } catch { /* already bound: immutable */ } check(thread); }
    else if (op === 7) { db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("human-thread:" + thread); check(thread); }
    else if (op === 8) { db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=? AND subject_type='human-thread'").run(JSON.stringify(people[rand(people.length)]), "human-thread:" + thread); check(thread); }
    else if (op === 9) { check(thread); try { transaction(() => { db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("human-thread:" + thread); check(thread); throw new Error("undo"); }); } catch { /* rolled back */ } check(thread); }
    else if (op === 10) { db.exec(`DELETE FROM memory_scope_bindings WHERE id='human-thread:${thread}'`); check(thread); }
    else await tick();
    if (step % 50 === 0) for (const t of threads) check(t);
  }
});

it("a binding written, replaced or deleted is seen on the very next ask, by each kind of writer", () => {
  const db = database(), a = person("UA"), b = person("UB");
  expect(threadHumanPrincipal("w1")).toEqual(OWNER);          // remembered as unbound
  bindHumanThread("w1", a);                                   // bindHumanThread
  expect(threadHumanPrincipal("w1")).toEqual(a);
  db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(b), "human-thread:w1");  // rebind (prepared UPDATE)
  expect(threadHumanPrincipal("w1")).toEqual(b);
  db.exec("UPDATE memory_scope_bindings SET intent='" + JSON.stringify(a) + "' WHERE id='human-thread:w1'");    // rebind (exec)
  expect(threadHumanPrincipal("w1")).toEqual(a);
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("human-thread:w1");                             // delete
  expect(threadHumanPrincipal("w1")).toEqual(OWNER);
  db.exec("DELETE FROM memory_scope_bindings");                                                                  // delete all
  expect(threadHumanPrincipal("w1")).toEqual(OWNER);
});

it("a bulk read of every binding never answers for a thread bound afterwards", () => {
  const a = person("UA");
  for (let i = 0; i < 20; i++) threadHumanPrincipal("x-" + i);   // passes the point-read limit: all bindings now remembered
  bindHumanThread("late", a);
  expect(threadHumanPrincipal("late")).toEqual(a);
});

// Astra review of 7e31fc7ed (REVISE), findings 1-4.
it("A1: an UPDATE ... RETURNING pulled through iterate(), and a prepared ROLLBACK TO, are seen on the next ask", () => {
  const db = database(), a = person("UA"), b = person("UB");
  bindHumanThread("i1", a);
  expect(threadHumanPrincipal("i1")).toEqual(a);
  for (const row of db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=? RETURNING id").iterate(JSON.stringify(b), "human-thread:i1")) void row;
  expect(threadHumanPrincipal("i1")).toEqual(b);
  db.exec("SAVEPOINT sp");
  db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("human-thread:i1");
  expect(threadHumanPrincipal("i1")).toEqual(OWNER);
  db.prepare("ROLLBACK TO sp").run();
  expect(threadHumanPrincipal("i1")).toEqual(b);
  db.exec("RELEASE sp");
  expect(threadHumanPrincipal("i1")).toEqual(uncached("i1"));
});

it("A2: a single-quoted table name is a binding write, and a binding write that fails part way still drops the memory", () => {
  const db = database(), a = person("UA"), b = person("UB");
  bindHumanThread("q1", a); bindHumanThread("q2", b);
  expect(threadHumanPrincipal("q1")).toEqual(a);
  db.prepare("UPDATE 'memory_scope_bindings' SET intent=? WHERE id=?").run(JSON.stringify(b), "human-thread:q1");
  expect(threadHumanPrincipal("q1")).toEqual(b);
  for (const t of ["q1", "q2", "qz"]) threadHumanPrincipal(t);
  // OR FAIL keeps the rows it changed before the second one collides with the first's new key
  expect(() => db.prepare("UPDATE OR FAIL memory_scope_bindings SET id='human-thread:qz' WHERE id IN ('human-thread:q1','human-thread:q2')").run()).toThrow();
  for (const t of ["q1", "q2", "qz"]) expect(threadHumanPrincipal(t)).toEqual(uncached(t));
});

it("A3: past BULK_MAX bindings no bulk read is made; point memory stays bounded and answers as an uncached read", async () => {
  const { BINDING_MEMO_LIMITS } = await import("./human-principals.ts");
  const keep = { ...BINDING_MEMO_LIMITS };
  try {
    BINDING_MEMO_LIMITS.BULK_MAX = 5; BINDING_MEMO_LIMITS.POINT_MAX = 16;
    const a = person("UA");
    for (let i = 0; i < 30; i++) if (i % 3 === 0) bindHumanThread("p-" + i, a);   // 10 bindings: more than BULK_MAX
    const count = counters(database());
    for (let round = 0; round < 3; round++) for (let i = 0; i < 30; i++) expect(threadHumanPrincipal("p-" + i)).toEqual(uncached("p-" + i));
    // every ask of 30 threads with a 16-thread memory: point reads, never a remembered bulk snapshot answering for the rest
    expect(count.bindings).toBeGreaterThan(30);
  } finally { Object.assign(BINDING_MEMO_LIMITS, keep); }
});

it("A4: another connection's commit is seen on the first ask of the next run, whenever the memory was made", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = database(), a = person("UA");
  expect(threadHumanPrincipal("o1")).toEqual(OWNER);   // remembered as unbound
  const file = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
  const other = new DatabaseSync(file);
  try {
    other.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT scope_id FROM memory_scope_bindings LIMIT 1").get() as { scope_id: string };
    other.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,?,'granted',?)").run("human-thread:o1", row.scope_id, "o1", a.revision, JSON.stringify(a));
    await tick();
    expect(threadHumanPrincipal("o1")).toEqual(a);
    other.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("human-thread:o1");
    await new Promise(resolve => setTimeout(resolve, 0));  // a later macrotask: the memory made in an earlier run is checked again
    expect(threadHumanPrincipal("o1")).toEqual(OWNER);
  } finally { other.close(); }
});

// Astra iohot2 (REVISE on 3bcd0bf29): Medium io-budget.ts:622 and Low #4 human-principals.ts:150.
it("iohot2 M: an iterator insert into another table whose schema-level ON CONFLICT ROLLBACK aborts the transaction drops the memory", () => {
  const db = database(), a = person("UA");
  db.exec("CREATE TABLE abort_probe(x INTEGER UNIQUE ON CONFLICT ROLLBACK)");
  db.exec("INSERT INTO abort_probe VALUES(1)");
  scope(() => {
    expect(threadHumanPrincipal("m1")).toEqual(OWNER);
    db.exec("BEGIN IMMEDIATE");
    bindHumanThread("m1", a);
    expect(threadHumanPrincipal("m1")).toEqual(a);            // remembered inside the transaction
    const insert = db.prepare("INSERT INTO abort_probe VALUES(?) RETURNING x");
    expect(() => { for (const row of insert.iterate(1)) void row; }).toThrow();
    expect(db.isTransaction).toBe(false);                    // SQLite rolled the whole transaction back, the binding with it
    expect(threadHumanPrincipal("m1")).toEqual(uncached("m1"));
    expect(threadHumanPrincipal("m1")).toEqual(OWNER);
  });
});

it("iohot2 L4: a callback queued before a run's first ask never meets that run's memory (another connection's commit is seen)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = database(), a = person("UA");
  const file = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
  const other = new DatabaseSync(file);
  try {
    other.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT scope_id FROM memory_scope_bindings LIMIT 1").get() as { scope_id: string };
    let seen: unknown;
    queueMicrotask(() => {                                   // C, queued first
      other.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,?,'granted',?)").run("human-thread:c1", row.scope_id, "c1", a.revision, JSON.stringify(a));
      seen = threadHumanPrincipal("c1");
    });
    expect(threadHumanPrincipal("c1")).toEqual(OWNER);       // this run's first ask: OWNER
    await tick(); await tick();
    expect(seen).toEqual(a);
  } finally { other.close(); }
});

it("iohot2 L4: outside a scope every ask reads; inside one the memory answers (and is not carried into later work)", async () => {
  const db = database(), a = person("UA");
  bindHumanThread("s1", a);
  const count = counters(db);
  for (let i = 0; i < 20; i++) expect(threadHumanPrincipal("s1")).toEqual(a);
  expect(count.bindings).toBe(20);
  count.bindings = 0;
  let later: Promise<unknown> = Promise.resolve();
  principals.withBindingScope(() => {
    for (let i = 0; i < 20; i++) expect(threadHumanPrincipal("s1")).toEqual(a);
    later = Promise.resolve().then(() => threadHumanPrincipal("s1"));
  });
  expect(count.bindings).toBe(1);
  await later;
  expect(count.bindings).toBe(2);                            // the continuation ran outside the scope: a read
});
