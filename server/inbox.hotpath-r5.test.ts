// SPDX-License-Identifier: AGPL-3.0-or-later
// hotpath round r5 (closes Astra r4c): the Chief's conversations are completed
// before the unrelated history; a thread's setup facts come from ONE snapshot;
// the deferred projection does its JSON work before, never inside, the writer lock.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { INBOX_DEFERRED_SQL, initializeInbox, inboxProjectionReady, inboxProjectionSlice, startInboxProjectionFill } from "./inbox.ts";
import { inboxDeferredDrain } from "./inbox-fill-worker.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { SETUP_FACT_STATEMENTS, readSetupThreadFacts } from "./setup-thread-facts.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
const memory = () => { const db = new DatabaseSync(":memory:"); databases.push(db); initializeMessageTables(db); return db; };
function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "murage-r5-")); dirs.push(dir);
  const file = join(dir, "messages.db");
  const db = new DatabaseSync(file); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
  initializeMessageTables(db);
  return { db, file };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const refusal = (id: string, at: number, output = "") => JSON.stringify({ id, at, role: "bot", kind: "activity", tool: { name: "run", ok: false, providerError: { httpStatus: 402, provider: "flux-router" }, output } });
const reply = (id: string, at: number, extra: Record<string, unknown> = {}) => JSON.stringify({ id, at, role: "bot", kind: "text", text: "All set", turnTerminal: true, ...extra });
const insertRow = (db: DatabaseSync, thread: string, id: string, at: number, kind: string, text: string | null, json: string) =>
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot',?,?,?)").run(thread, id, at, kind, text, json);
/** Filler rows of about `pad` bytes each: in conversations of 100 named `other<n>`, or all in the one conversation `thread` when given. */
const filler = (db: DatabaseSync, from: number, to: number, pad: number, thread?: string) =>
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i+1 FROM n WHERE i < ?2)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE 'other' || (i / 100) END, 'f' || i, i, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, 'text', 'line ' || i,
      json_object('id','f' || i,'at',i,'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i,'pad',substr(replace(hex(zeroblob(?4)),'0','x'),1,?5)) FROM n`).run(from, to - 1, thread ?? null, Math.ceil(pad / 2), pad);

/** Admitted rows are charged 60 ms/MiB by the fill's insert (the r4 slow-disk model); diverted rows are not read by it. */
function slowDisk(db: DatabaseSync, msPerMiB: number): DatabaseSync {
  const burn = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* a slow read */ } };
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("INSERT OR IGNORE INTO inbox_raw")) return statement;
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "run") {
              return (...args: unknown[]) => {
                const scoped = typeof args[0] === "string";
                const [from, to, budget] = (scoped ? args.slice(1) : args) as [number, number, number | undefined];
                const { bytes } = target.prepare(`SELECT COALESCE(SUM(octet_length(json)),0) AS bytes FROM messages WHERE ${scoped ? "thread_id=? AND " : ""}rowid>? AND rowid<=? AND octet_length(json)+256<=?`)
                  .get(...((scoped ? [args[0], from, to, budget ?? Number.MAX_SAFE_INTEGER] : [from, to, budget ?? Number.MAX_SAFE_INTEGER]) as number[])) as { bytes: number };
                burn(bytes / 1048576 * msPerMiB);
                return (inner.run as (...a: unknown[]) => unknown)(...args);
              };
            }
            const member = Reflect.get(inner, name) as unknown;
            return typeof member === "function" ? member.bind(inner) : member;
          },
        });
      };
    },
  });
}

describe("r5 P1#1: the Chief's conversations are completed before the unrelated history", () => {
  it("a fresh 402 on a Chief thread stored last is KNOWN within a small bound, with owner turns pausing the fill", async () => {
    const db = memory();
    // About 100 MiB of unrelated history first (the 3M-message install, scaled; the slow-disk model charges 60 ms/MiB),
    // then the Chief's conversation last by rowid: an older reply, then the fresh refusal.
    filler(db, 0, 100_000, 1_000);
    filler(db, 100_000, 101_500, 100, "chief");
    insertRow(db, "chief", "answered", 2_000_000, "text", "All set", reply("answered", 2_000_000));
    insertRow(db, "chief", "refused-now", 3_000_000, "activity", null, refusal("refused-now", 3_000_000));
    initializeInbox(db);
    const fill = startInboxProjectionFill(slowDisk(db, 60), { busy: () => true, priorityThreads: () => ["chief"] });
    const started = performance.now();
    let facts = readSetupThreadFacts(db, "chief");
    while (facts.known === false && performance.now() - started < 4_000) { await sleep(20); facts = readSetupThreadFacts(db, "chief"); }
    const elapsed = performance.now() - started;
    const readyThen = inboxProjectionReady(db);
    fill.stop();
    console.log(`[r5-chief] known after ${elapsed.toFixed(0)} ms (owner turn live: 250 ms pause per slice), ${fill.stats.slices} slices, fill ready=${readyThen}`);
    expect(facts.known, "the Chief thread's facts are known").not.toBe(false);
    expect(facts.refusal, "and the fresh 402 is reported").toMatchObject({ refusal: { httpStatus: 402 } });
    expect(elapsed).toBeLessThan(3_000);
    expect(readyThen, "while the unrelated history is still being filled").toBe(false);
  }, 60_000);

  it("a Chief thread whose recovery row is deferred is completed first too, and the recovery wins", async () => {
    const { db } = fileDb();
    filler(db, 0, 30_000, 1_000);
    insertRow(db, "chief", "refused", 1_000, "activity", null, refusal("refused", 1_000));
    insertRow(db, "chief", "recovered", 2_000, "text", "All set", reply("recovered", 2_000, { pad: "x".repeat(300 * 1024) }));
    filler(db, 30_000, 30_100, 100, "tail");
    initializeInbox(db);
    const fill = startInboxProjectionFill(db, { busy: () => true, priorityThreads: () => ["chief"] });
    const started = performance.now();
    let facts = readSetupThreadFacts(db, "chief");
    while (facts.known === false && performance.now() - started < 8_000) { await sleep(20); facts = readSetupThreadFacts(db, "chief"); }
    const elapsed = performance.now() - started;
    const readyThen = inboxProjectionReady(db);
    fill.stop();
    console.log(`[r5-chief-deferred] known after ${elapsed.toFixed(0)} ms, fill ready=${readyThen}`);
    expect(facts.known).not.toBe(false);
    expect(facts).toMatchObject({ answered: true, answeredAt: 2_000, refusal: null });
    expect(readyThen).toBe(false);
  }, 60_000);

  it("the per-thread completion is exact: a thread with an unprojected row is still UNKNOWN", () => {
    const db = memory();
    filler(db, 0, 5_000, 100);
    filler(db, 5_000, 5_100, 100, "chief");
    filler(db, 5_100, 9_000, 100, "late");
    initializeInbox(db);
    expect(readSetupThreadFacts(db, "chief")).toMatchObject({ known: false });
    inboxProjectionSlice(db, { rows: 10_000, weight: 512 * 1024 }, ["chief"]);
    expect(readSetupThreadFacts(db, "chief")).toMatchObject({ known: false }); // rows projected, completion not yet recorded by this slice
    inboxProjectionSlice(db, { rows: 10_000, weight: 512 * 1024 }, ["chief"]);
    expect(readSetupThreadFacts(db, "chief")).not.toHaveProperty("known");
    expect(readSetupThreadFacts(db, "late")).toMatchObject({ known: false });
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_projection_state WHERE name='t:chief' AND done=1")).toBe(1);
  });
});

describe("r5 P1#2: the facts are read from one snapshot", () => {
  it("a worker drain between the answer read and the completeness check cannot make a historical 402 KNOWN", () => {
    const { db, file } = fileDb();
    insertRow(db, "t", "refused", 1_000, "activity", null, refusal("refused", 1_000));
    insertRow(db, "t", "recovered", 2_000, "text", "All set", reply("recovered", 2_000, { pad: "x".repeat(300 * 1024) }));
    initializeInbox(db);
    inboxProjectionSlice(db, { rows: 10_000, weight: 64 * 1024 }); // the refusal is admitted, the recovery deferred
    inboxProjectionSlice(db, { rows: 10_000, weight: 64 * 1024 }); // nothing follows: the fill waits for the deferred row
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(1);
    const other = new DatabaseSync(file); databases.push(other);
    other.exec("PRAGMA busy_timeout=1000;");
    const drain = inboxDeferredDrain(other, INBOX_DEFERRED_SQL);
    const prepared = Object.fromEntries(Object.entries(SETUP_FACT_STATEMENTS).map(([name, sql]) => [name, db.prepare(sql)])) as Record<string, ReturnType<DatabaseSync["prepare"]>>;
    prepared.completed = db.prepare("SELECT done FROM inbox_projection_state WHERE name=?");
    let drained = false;
    const realAnswer = prepared.answer!;
    const interleaved = { ...prepared, answer: { get: (...args: never[]) => { const row = realAnswer.get(...args); if (!drained) { drained = true; while (drain.step()) { /* the worker projects the recovery */ } } return row; } } };
    const facts = readSetupThreadFacts(db, "t", interleaved as never);
    expect(drained).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred"), "the drain really ran between the reads").toBe(0);
    const obsolete = facts.known !== false && facts.refusal !== null;
    expect(obsolete, "never KNOWN with the obsolete 402").toBe(false);
    expect(facts.known === false || (facts.answered && facts.refusal === null)).toBe(true);
    // and the next read, after the drain, is the recovery
    expect(readSetupThreadFacts(db, "t")).toMatchObject({ answered: true, refusal: null });
  });
});

describe("r5 P1#3: no JSON work under the writer lock", () => {
  const MIB128 = 128 * 1024 * 1024;
  const hugeRefusal = (id: string, at: number) => JSON.stringify({ id, at, role: "bot", kind: "activity", tool: { name: "run", ok: false, providerError: { httpStatus: 402, provider: "flux-router" }, output: "x".repeat(MIB128) } });

  it("the locked apply of a 128 MiB deferred row is short", () => {
    const { db, file } = fileDb();
    insertRow(db, "t", "big", 1_000, "activity", null, hugeRefusal("big", 1_000));
    initializeInbox(db);
    inboxProjectionSlice(db, { rows: 10_000, weight: 512 * 1024 });
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(1);
    const other = new DatabaseSync(file); databases.push(other);
    other.exec("PRAGMA busy_timeout=0;");
    const drain = inboxDeferredDrain(other, INBOX_DEFERRED_SQL);
    const stageStarted = performance.now();
    (drain as { stage?: () => boolean }).stage?.(); // the JSON work: outside any lock
    const staged = performance.now() - stageStarted;
    const lockStarted = performance.now();
    expect(drain.step()).toBe(true);
    const hold = performance.now() - lockStarted;
    console.log(`[r5-lock] 128 MiB row: staging ${staged.toFixed(0)} ms (no lock), locked apply ${hold.toFixed(1)} ms`);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(0);
    expect(hold, "the writer lock is held for a guarded small apply").toBeLessThan(50);
  }, 120_000);

  it("while the worker projects a 128 MiB row, no main-thread message write waits more than 50 ms", async () => {
    const { db } = fileDb();
    insertRow(db, "t", "big", 1_000, "activity", null, hugeRefusal("big", 1_000));
    filler(db, 0, 500, 100);
    initializeInbox(db);
    const fill = startInboxProjectionFill(db, {});
    const waits: number[] = [];
    const write = db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('live',?,?,'bot','text','hi',?)");
    const projected = () => count(db, "SELECT COUNT(*) AS n FROM setup_marks WHERE thread_id='t'") > 0;
    // The fill drains the deferred rows once it has reached the end of the history: let it get there and start the worker, then write
    // (writes stop once the row is projected: the fill chases every row written after it began).
    while (count(db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred") === 0 && !projected()) await sleep(1);
    await sleep(100);
    const begun = performance.now();
    for (let i = 0; !projected() && performance.now() - begun < 90_000; i++) {
      const started = performance.now();
      try { write.run(`w${i % 50}`, i, JSON.stringify({ id: `w${i}`, at: i, role: "bot", kind: "text", text: "hi" })); }
      catch { waits.push(Number.POSITIVE_INFINITY); } // the writer lock never came
      waits.push(performance.now() - started);
      await sleep(1);
    }
    expect(projected(), "the worker projected the row while the writes ran").toBe(true);
    expect(await fill.done).toEqual({ filled: true });
    const worst = Math.max(...waits);
    console.log(`[r5-writes] ${waits.length} main-thread writes during the worker projection: worst ${worst.toFixed(1)} ms`);
    expect(count(db, "SELECT COUNT(*) AS n FROM setup_marks WHERE thread_id='t'")).toBe(1);
    expect(worst).toBeLessThan(50);
  }, 180_000);
});
