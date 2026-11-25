// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMORY V2 lane C, slice inherit (design 4.3 V3, V3b, V4, V5 item 4): an inherit job closes in the write that creates it, children of
// one transaction share one job, write-time inheritance agrees with the read rule, and a hold is released by its own revoke only.
// Every test runs the real writer (revoke-commit.ts inheritMarks) and the real marker on a real SQLite file with the real schema.
// On f6ae52c670 V3-W is RED with 1,000 active jobs (no inline close; the seams below do not exist there and are read as absent).
import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { denyLookup } from "./deny-read.ts";
import * as commit from "./revoke-commit.ts";
import { markerSlice } from "./revoke-marker.ts";
import { INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const { inheritMarks } = commit;
/** The differential seams (absent on the base build: every job is queued and unshared there). */
const seam = (commit as unknown as { INHERIT_CLOSE?: { inline: boolean; share: boolean } }).INHERIT_CLOSE ?? { inline: false, share: false };
const fixtures: WritetimeFixture[] = [];
const INLINE_MS = INLINE_REVOCATION.ms;
afterEach(() => { stopMemoryRevocation(); seam.inline = true; seam.share = true; INLINE_REVOCATION.ms = INLINE_MS; for (const f of fixtures.splice(0)) f.close(); });

const T = "room";
function file(): WritetimeFixture {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.db.exec("PRAGMA journal_mode=WAL"); // as the app's file (the one-transaction job share reads the WAL index)
  f.cert(true).ready(T, true);
  return f;
}
const tx = <R>(db: DatabaseSync, work: () => R): R => {
  db.exec("BEGIN IMMEDIATE");
  try { const out = work(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
};
const n = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number(db.prepare(sql).get(...args)!.n);
const activeJobs = (db: DatabaseSync) => n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing','seeding')");
const pendingRows = (db: DatabaseSync) => n(db, "SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n");
/** Every mark, as rows (mark_lsn left out: it is the slot the mark was written at, not what it denies). */
const marks = (db: DatabaseSync, withId = true) => JSON.stringify({
  line: db.prepare(`SELECT thread_id,lsn,reason${withId ? ",revoke_id" : ""} FROM memory_deny_line ORDER BY 1,2,3${withId ? ",4" : ""}`).all(),

  session: db.prepare(`SELECT thread_id,driver_instance,native_session${withId ? ",revoke_id" : ""} FROM memory_deny_session ORDER BY 1,2,3${withId ? ",4" : ""}`).all(),
  memory: db.prepare(`SELECT kind,id,version${withId ? ",revoke_id" : ""} FROM memory_deny_memory ORDER BY 1,2,3${withId ? ",4" : ""}`).all(),
});
/** Range rows, read apart from the other marks. */
type Range = { thread_id: string; from_lsn: number; until_turn_lsn: number; reason: string; revoke_id: number };
const ranges = (db: DatabaseSync, withId = true) => (db.prepare("SELECT thread_id,from_lsn,until_turn_lsn,reason,revoke_id FROM memory_deny_range ORDER BY 1,2,3,4,5").all() as unknown as Range[]).map(row => withId ? row : { ...row, revoke_id: 0 });
const READERS = [CONTENT, MEMBER, OWNER] as const;
/** The queue drained by the real marker, one committed slice at a time, as the runner commits them. */
function drain(db: DatabaseSync): void {
  for (let i = 0; i < 100_000 && activeJobs(db) > 0; i++) tx(db, () => markerSlice(db));
  expect(activeJobs(db)).toBe(0);
}
let statements = 0;
function count(db: DatabaseSync): void {
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    const methods = statement as unknown as Record<"get" | "all" | "run", (...args: unknown[]) => unknown>;
    for (const name of ["get", "all", "run"] as const) { const run = methods[name].bind(statement); methods[name] = (...args: unknown[]) => { statements++; return run(...args); }; }
    return statement;
  };
}

/** Inheriting writes under coalesced ranges (revoke -1, no job), each its own transaction, spread over 40 threads so no thread reaches
 * the marker's own range merge (DENY_RANGE_COALESCE, 64 rows), which would hide the rows compared here. Children are lines and turns (a
 * range node the walk follows); with `chain`, every third rests on the child written before it in its thread (a mark of an earlier
 * write's own job). `afterEach`: the oracle's runner, run between two writes. */
function writes(count_: number, inline: boolean, chain: boolean, afterEach_: (db: DatabaseSync) => void = () => undefined): { f: WritetimeFixture; perWrite: number } {
  seam.inline = inline;
  const f = file();
  count(f.db);
  const thread = (t: number) => `r${t}`;
  for (let t = 0; t < 40; t++) {
    f.ready(thread(t), true).denyRange(thread(t), 10, 100, -1).reply(thread(t), `parent${t}`, 50, { turnLsn: 40 });
    f.sessionLineage(thread(t), "driver", "native", 45, 1_000_000); // a session every walk reaches
  }
  let used = 0;
  for (let i = 0; i < count_; i++) {
    const R = thread(i % 40), j = Math.floor(i / 40), lsn = 1000 + i * 10;
    f.reply(R, `c${i}`, lsn, { turnLsn: lsn - 5 });
    f.db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(lsn + 1);
    const from = chain && j % 3 === 2 ? lsn - 400 : 50;
    const before = statements;
    tx(f.db, () => inheritMarks(f.db, j % 3 === 1 ? { kind: "turn", threadId: R, lsn: lsn - 5, holdFrom: lsn, line: lsn } : { kind: "line", threadId: R, lsn }, [], [{ threadId: R, from, to: from }]));
    used += statements - before;
    afterEach_(f.db);
  }
  return { f, perWrite: used / count_ };
}
const allMarks = (db: DatabaseSync) => `${marks(db)}${JSON.stringify(ranges(db))}`;
const verdictsOf = (f: WritetimeFixture) => READERS.map(reader => f.db.prepare("SELECT t.thread_id AS thread,l.message_id AS id FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no ORDER BY l.lsn").all()
  .map(row => denyLookup(f.db, { threadId: String(row.thread), lines: [{ messageId: String(row.id), author: "generated" }] }, reader).get(String(row.id))!.state));

it("V3-W: 1,000 inheriting writes under a coalesced range leave no job and no pending row, with the marks of the drained queue", () => {
  INLINE_REVOCATION.ms = 1000; // the walk's row caps are under test, not this machine's clock: a walk past 8 ms stays queued, as before
  const closed = writes(1000, true, false);
  const left = { jobs: activeJobs(closed.f.db), pending: pendingRows(closed.f.db) };
  const base = writes(1000, false, false);
  const queued = { jobs: activeJobs(base.f.db), pending: pendingRows(base.f.db) };
  console.log(`MEASURED memv2-C inherit V3-W after 1,000 inheriting writes: active jobs ${queued.jobs} -> ${left.jobs}, pending rows ${queued.pending} -> ${left.pending}; statements per inheriting write ${base.perWrite} -> ${closed.perWrite}`);
  expect(left).toEqual({ jobs: 0, pending: 0 });
  expect(queued).toEqual({ jobs: 1000, pending: 1000 }); // the oracle really queued (the seam is not a no-op)
  drain(base.f.db);
  expect(pendingRows(base.f.db)).toBe(0);
  expect(n(closed.f.db, "SELECT count(*) AS n FROM memory_deny_line WHERE reason='inherit'")).toBe(1000);
  expect(n(closed.f.db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id>0")).toBe(1000); // every walk ran: its range
  expect(n(closed.f.db, "SELECT count(*) AS n FROM memory_deny_session")).toBe(1000);                 // and its session stage
  expect(allMarks(closed.f.db)).toBe(allMarks(base.f.db)); // every mark, row by row, under the same revoke ids and caps
  expect(verdictsOf(closed.f)).toEqual(verdictsOf(base.f));
  expect(n(closed.f.db, "SELECT count(*) AS n FROM memory_revoke_frontier")).toBe(0);
});
it("V3-W (chained): a child resting on an earlier child's mark closes inline with the marks of a runner that drains after every write", () => {
  INLINE_REVOCATION.ms = 1000;
  const closed = writes(600, true, true);
  expect({ jobs: activeJobs(closed.f.db), pending: pendingRows(closed.f.db) }).toEqual({ jobs: 0, pending: 0 });
  // the base with the real marker run to the end between two writes: the same rows, ids and caps
  const prompt = writes(600, false, true, db => drain(db));
  expect(allMarks(closed.f.db)).toBe(allMarks(prompt.f.db));
  // the base drained only at the end adds a late child to the job still queued, at that job's older cap: the same line, session and
  // memory marks; its range rows end at the older cap, so nothing it withholds is shown here
  const late = writes(600, false, true);
  expect(activeJobs(late.f.db)).toBeGreaterThan(300);
  drain(late.f.db);
  expect(marks(closed.f.db)).toBe(marks(late.f.db));
  const here = verdictsOf(closed.f), there = verdictsOf(late.f);
  for (let r = 0; r < here.length; r++) for (let i = 0; i < here[r]!.length; i++) if (there[r]![i] !== "shown") expect(`${r}:${i}:${here[r]![i]}`).toBe(`${r}:${i}:${there[r]![i]}`);
});

/** 100 children written in ONE transaction under the coalesced range: 40 lines, 20 turns, 40 sessions (60 range rows: under the merge). */
function hundred(share: boolean, inline: boolean): WritetimeFixture {
  seam.share = share; seam.inline = inline;
  const f = file();
  f.denyRange(T, 10, 100, -1).reply(T, "parent", 50, { turnLsn: 40 });
  for (let i = 0; i < 100; i++) f.reply(T, `c${i}`, 1000 + i * 10, { turnLsn: 995 + i * 10 });
  f.db.prepare("UPDATE memory_lsn SET next=5000 WHERE id=1").run();
  f.reply(T, "before", 500, { turnLsn: 490 }).reply(T, "between", 1505, { turnLsn: 1500 });
  const kid = (i: number): Parameters<typeof inheritMarks>[1] => i % 5 < 2 ? { kind: "session", session: { threadId: T, driverInstance: "driver", nativeSession: `s${i}` }, lsn: 1000 + i * 10 }
    : i % 5 === 4 ? { kind: "turn", threadId: T, lsn: 995 + i * 10, holdFrom: 1000 + i * 10, line: 1000 + i * 10 } : { kind: "line", threadId: T, lsn: 1000 + i * 10 };
  tx(f.db, () => { for (let i = 0; i < 100; i++) inheritMarks(f.db, kid(i), [], [{ threadId: T, from: 50, to: 50 }]); });
  f.db.prepare("UPDATE memory_lsn SET next=max(next,8000) WHERE id=1").run();
  f.reply(T, "after", 9000, { turnLsn: 8990 }); // a clean line of a turn begun after the transaction
  return f;
}
const child = (f: WritetimeFixture, id: string, reader = CONTENT) => denyLookup(f.db, { threadId: T, lines: [{ messageId: id, author: "generated" }] }, reader).get(id)!;
/** Range rows of `one` against the 100 jobs': each starts where one of theirs does and ends at or below it, and the lowest is the same row. */
function rangesWithin(one: WritetimeFixture, many: WritetimeFixture): void {
  const theirs = ranges(many.db, false), ours = ranges(one.db, false);
  expect(ours.filter(row => !theirs.some(base => base.from_lsn === row.from_lsn && base.thread_id === row.thread_id && base.reason === row.reason && base.until_turn_lsn >= row.until_turn_lsn))).toEqual([]);
  const lowest = (rows: Range[]) => rows.filter(row => row.reason === "inherit").sort((x, y) => x.from_lsn - y.from_lsn)[0]!;
  expect(lowest(ours).from_lsn).toBe(lowest(theirs).from_lsn);
  // the one job's cap (the slot its first child took) and the caps of the 100 jobs are all slots taken inside the one transaction: no
  // turn began at or after the lowest and before the highest, so a row that ends at the lower cap denies the same lines
  const caps = [...theirs, ...ours].filter(row => row.reason === "inherit").map(row => row.until_turn_lsn);
  expect(Math.max(...caps) - Math.min(...caps)).toBeLessThan(200);
  expect(n(many.db, "SELECT count(*) AS n FROM memory_line_lineage WHERE turn_lsn>=? AND turn_lsn<=?", Math.min(...caps), Math.max(...caps))).toBe(0);
}
it("W-COALESCE: 100 children in one transaction give one job whose marks and holds are those of 100 jobs", () => {
  const one = hundred(true, false), many = hundred(false, false);
  expect(n(many.db, "SELECT count(*) AS n FROM memory_revoke_jobs")).toBe(100);
  expect(n(one.db, "SELECT count(*) AS n FROM memory_revoke_jobs")).toBe(1);
  // queued: the same marks and the same frontier nodes row by row (the job id apart)
  expect(marks(one.db, false)).toBe(marks(many.db, false));
  const nodes = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT node FROM memory_revoke_frontier ORDER BY node").all());
  expect(nodes(one.db)).toBe(nodes(many.db));
  expect(n(one.db, "SELECT count(*) AS n FROM memory_revoke_frontier")).toBe(100);
  // holds: markPending keeps a job's rows on a thread from its lowest since, so the one job's lowest row is the lowest of the 100 jobs'
  // rows; no child the 100 jobs hold reads shown under the one
  expect(n(one.db, "SELECT min(since_lsn) AS n FROM memory_deny_pending")).toBe(n(many.db, "SELECT min(since_lsn) AS n FROM memory_deny_pending"));
  for (const reader of READERS) for (let i = 0; i < 100; i++) if (child(many, `c${i}`, reader).state !== "shown") expect(`${i}:${child(one, `c${i}`, reader).state}`).toBe(`${i}:${child(many, `c${i}`, reader).state}`);
  expect(child(one, "c2").state).toBe("withheld");
  drain(one.db); drain(many.db);
  // walked: lines, sessions and memory row by row; ranges: the one job walks the thread once per part, at the cap its first child took
  expect(marks(one.db, false)).toBe(marks(many.db, false));
  expect(n(many.db, "SELECT count(*) AS n FROM memory_deny_range WHERE reason='inherit'")).toBe(60);
  expect(n(one.db, "SELECT count(*) AS n FROM memory_deny_session")).toBe(40);
  rangesWithin(one, many);
  expect(pendingRows(one.db)).toBe(0);
  expect(verdictsOf(one)).toEqual(verdictsOf(many));
  expect(child(one, "c2").state).toBe("withheld");
  expect(child(one, "after").state).toBe("shown");
  // closed inline: the same marks again, one job id, nothing left
  INLINE_REVOCATION.ms = 1000;
  const closed = hundred(true, true);
  expect(marks(closed.db, false)).toBe(marks(many.db, false));
  rangesWithin(closed, many);
  expect(verdictsOf(closed)).toEqual(verdictsOf(many));
  expect(n(closed.db, "SELECT count(DISTINCT revoke_id) AS n FROM memory_deny_line WHERE reason='inherit'")).toBe(1);
  expect({ jobs: activeJobs(closed.db), pending: pendingRows(closed.db) }).toEqual({ jobs: 0, pending: 0 });
});
it("W-COALESCE: nothing is folded across transactions", () => {
  const f = file();
  f.denyRange(T, 10, 100, -1).reply(T, "parent", 50, { turnLsn: 40 });
  for (let i = 0; i < 3; i++) f.reply(T, `c${i}`, 1000 + i * 10, { turnLsn: 995 + i * 10 });
  f.db.prepare("UPDATE memory_lsn SET next=5000 WHERE id=1").run();
  const write = (i: number) => inheritMarks(f.db, { kind: "line", threadId: T, lsn: 1000 + i * 10 }, [], [{ threadId: T, from: 50, to: 50 }]);
  tx(f.db, () => write(0));
  tx(f.db, () => write(1)); // the next transaction of the same synchronous run
  expect(tx(f.db, () => write(2))).toBeUndefined();
  expect(f.db.prepare("SELECT lsn,revoke_id FROM memory_deny_line WHERE reason='inherit' ORDER BY lsn").all().map(row => Number(row.revoke_id))).toEqual([1, 2, 3]);
  const caps = f.db.prepare("SELECT started_lsn FROM memory_revoke_jobs ORDER BY revoke_id").all().map(row => Number(row.started_lsn));
  expect(new Set(caps).size).toBe(caps.length);
});

it("V4-W: for 200 random (range, line) pairs the write-time verdict is the read rule's", () => {
  const f = file();
  let seed = 0x1021c;
  const rnd = (k: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % k; };
  let denied = 0, held = 0, shown = 0;
  for (let i = 0; i < 200; i++) {
    const thread = `t${i}`, R = i + 1;
    f.ready(thread, true);
    const from = 100 + rnd(200), until = from + 1 + rnd(200), lsn = 50 + rnd(400), turn = Math.max(1, lsn - 1 - rnd(120));
    f.reply(thread, "p", lsn, { turnLsn: turn }).reply(thread, "c", 9000, { turnLsn: 8990 });
    // a finished forget's range, or a standing window (since = from, cap = until) of an active one
    const window = rnd(2) === 1;
    if (window) f.job(R, until).pending(thread, from, R); else f.job(R, until, "done").denyRange(thread, from, until, R);
    f.db.prepare("UPDATE memory_lsn SET next=max(next,10000) WHERE id=1").run();
    const read = denyLookup(f.db, { threadId: thread, lines: [{ messageId: "p", author: "generated" }] }, CONTENT).get("p")!;
    tx(f.db, () => inheritMarks(f.db, { kind: "line", threadId: thread, lsn: 9000 }, [], [{ threadId: thread, from: lsn, to: lsn }]));
    const mark = n(f.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id=? AND lsn=9000", thread);
    const hold = n(f.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn=9000", thread);
    const wrote = mark ? "withheld" : hold ? "checking" : "shown";
    expect(`${i}:${from}-${until}:${lsn}/${turn}:${window}:${wrote}`).toBe(`${i}:${from}-${until}:${lsn}/${turn}:${window}:${read.state}`);
    if (mark) denied++; else if (hold) held++; else shown++;
  }
  console.log(`MEASURED memv2-C inherit V4-W 200 pairs: denied ${denied}, held ${held}, shown ${shown}`);
  expect(Math.min(denied, held, shown)).toBeGreaterThan(10); // every verdict is exercised
});

for (const [name, reader] of [["content", CONTENT], ["audience member", MEMBER], ["audience owner", OWNER]] as const) {
  for (const order of [[1, 2], [2, 1]] as const) {
    it(`V5-OWN (${name}, revoke ${order[0]} closes first): a hold is released exactly when its own revoke finishes`, () => {
      const f = file();
      // two overlapping windows on one thread (since 10; caps 100 and 200) over the parent line
      f.reply(T, "parent", 50, { turnLsn: 40 }).reply(T, "c", 1000, { turnLsn: 990 });
      f.job(1, 100).pending(T, 10, 1).job(2, 200).pending(T, 10, 2);
      f.db.prepare("UPDATE memory_lsn SET next=2000 WHERE id=1").run();
      expect(child(f, "c", reader).state).toBe("shown");
      tx(f.db, () => inheritMarks(f.db, { kind: "line", threadId: T, lsn: 1000 }, [], [{ threadId: T, from: 50, to: 50 }]));
      const holds = () => f.db.prepare("SELECT revoke_id FROM memory_deny_pending WHERE thread_id=? AND since_lsn=1000 ORDER BY revoke_id").all(T).map(row => Number(row.revoke_id));
      expect(holds()).toEqual([1, 2]); // one hold per revoke, each under its own id
      expect(child(f, "c", reader).state).toBe("checking");
      const finish = (R: number) => { for (let i = 0; i < 100 && n(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND state='active'", R); i++) tx(f.db, () => markerSlice(f.db, 256, Number.POSITIVE_INFINITY, null, Number.POSITIVE_INFINITY, { only: R })); };
      finish(order[0]);
      expect(holds()).toEqual([order[1]]);           // the finished revoke's hold is gone, the other's is not
      expect(child(f, "c", reader).state).toBe("checking");
      finish(order[1]);
      expect(holds()).toEqual([]);
      expect(child(f, "c", reader).state).toBe("shown");
    });
  }
}

// Review round 2 (High): an error that ends the writer's WHOLE transaction during the inline close is the writer's to see. SQLite rolls
// a transaction back on its own for a full disk, an I/O error, out of memory or an interrupt; RAISE(ROLLBACK) in a TEMP trigger on the
// walk's own finishing step stands for it here. Before the fix closeInherit swallowed it: inheritMarks returned normally with the
// child's mark and hold gone, and whatever the writer wrote next was committed statement by statement with no hold behind it.
it("V3 error path: an error that rolls the writer's transaction back during the inline close reaches the writer; nothing is committed without its hold", () => {
  seam.inline = true;
  INLINE_REVOCATION.ms = 1000;
  const f = file();
  f.ready("rx", true).denyRange("rx", 10, 100, -1).reply("rx", "parent", 50, { turnLsn: 40 });
  f.sessionLineage("rx", "driver", "native", 45, 1_000_000);
  f.reply("rx", "child", 1000, { turnLsn: 995 });
  f.db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(1001);
  f.db.exec("CREATE TEMP TRIGGER simulated_full BEFORE UPDATE OF state ON main.memory_revoke_jobs WHEN NEW.state='done' BEGIN SELECT RAISE(ROLLBACK,'simulated: database or disk is full'); END");
  const jobs0 = n(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs"), marks0 = n(f.db, "SELECT count(*) AS n FROM memory_deny_line");
  let thrown: unknown = null, returned = false;
  f.db.exec("BEGIN IMMEDIATE");
  try { inheritMarks(f.db, { kind: "line", threadId: "rx", lsn: 1000 }, [], [{ threadId: "rx", from: 50, to: 50 }]); returned = true; }
  catch (error) { thrown = error; }
  const open = (f.db as unknown as { isTransaction: boolean }).isTransaction;
  if (open) f.db.exec("ROLLBACK");
  expect(open).toBe(false);          // the simulated error did end the transaction (the scenario is the one under test)
  expect(returned).toBe(false);      // and the writer was told: it does not go on in autocommit
  expect(String((thrown as Error | null)?.message)).toMatch(/simulated/);
  expect(n(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs")).toBe(jobs0);
  expect(n(f.db, "SELECT count(*) AS n FROM memory_deny_line")).toBe(marks0);
  // control: a step that fails INSIDE the savepoint (no transaction-wide rollback) is absorbed and the job stays queued, window open
  f.db.exec("DROP TRIGGER simulated_full; CREATE TEMP TRIGGER simulated_step BEFORE UPDATE OF state ON main.memory_revoke_jobs WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'simulated: step failed'); END");
  tx(f.db, () => inheritMarks(f.db, { kind: "line", threadId: "rx", lsn: 1000 }, [], [{ threadId: "rx", from: 50, to: 50 }]));
  expect(activeJobs(f.db)).toBe(1);
  expect(pendingRows(f.db)).toBeGreaterThan(0);
  expect(n(f.db, "SELECT count(*) AS n FROM memory_deny_line WHERE reason='inherit'")).toBe(1);
  f.close();
});
