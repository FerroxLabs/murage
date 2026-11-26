// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMAUDIT F4 (1.0.21): what one stored line costs the writer while revokes are queued, and what a long thread did to it.
// On f6ae52c670 the writer read the thread's lineage once or twice per queued job (LIMIT 257, no position), so a stored line cost
// (line writes x queued jobs) reads, and any thread with more than 256 generated lines before a cap overflowed that read: the new line
// was marked or held whatever its position, while the read rule (deny-read.ts) showed the very line it rests on.
// Every count below is a count of statements or rows, so it does not depend on the machine.
import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { denyLookup } from "./deny-read.ts";
import { inheritEdge, inheritMarks } from "./revoke-commit.ts";
import { LINEAGE_TURN } from "./schema.ts";
import { stopMemoryRevocation } from "./memory-revocation.ts";
import { CONTENT, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { stopMemoryRevocation(); for (const f of fixtures.splice(0)) f.close(); });

/** Jobs queued in the standing fixture (the owner's profile held 2,376; the read rule stops telling windows apart past 256 `*` rows). */
const QUEUE = 200;
const T = "long";

/** A file with the turn index, as a started server has it. */
function file(): WritetimeFixture {
  const f = new WritetimeFixture(); fixtures.push(f);
  count(f.db);
  f.db.exec(LINEAGE_TURN.sql);
  f.cert(true).ready(T, true);
  return f;
}
/** `n` lines of T at lsn first..first+n-1: generated, every one of a turn begun at `turnLsn`, or (null) owner lines. */
function lines(f: WritetimeFixture, n: number, first: number, turnLsn: number | null): void {
  f.db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?)
    INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn) SELECT ?,?+i,'l'||(?+i),? FROM c`).run(n - 1, testThreadNo(f.db, T), first, first, turnLsn);
  f.db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(first + n);
}
/** A standing queue: QUEUE active revokes of lines in another thread, each with its `*` window (since 1, cap 101..100+QUEUE). */
function queue(f: WritetimeFixture, n = QUEUE): void {
  for (let r = 1; r <= n; r++) {
    f.job(r, 100 + r).pending("*", 1, r);
    f.db.prepare("UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=?").run(JSON.stringify({ kind: "line", threadId: "elsewhere" }), r);
  }
}
interface Cost { statements: number; lineage: number; rows: number; generation: number }
const counting = new WeakMap<DatabaseSync, { cost: Cost | null }>();
/** Counts every statement the file runs while a measure is open. prepare is wrapped once per file, before the writer prepares anything,
 * so a statement the writer keeps (revoke-marker.ts st) is counted in whichever measure runs it. */
function count(db: DatabaseSync): void {
  const slot: { cost: Cost | null } = { cost: null };
  counting.set(db, slot);
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    const methods = statement as unknown as Record<"get" | "all" | "run", (...args: unknown[]) => unknown>;
    for (const name of ["get", "all", "run"] as const) {
      const run = methods[name].bind(statement);
      methods[name] = (...args: unknown[]) => {
        if (slot.cost) { slot.cost.statements++; if (/\bmemory_line_lineage\b/.test(sql)) slot.cost.lineage++; }
        return run(...args);
      };
    }
    return statement;
  };
}
/** Runs `work` in one transaction and counts what it executed: statements, statements over memory_line_lineage, rows changed (triggers
 * included) and deny_generation bumps. */
function measure(f: WritetimeFixture, work: (db: DatabaseSync) => void): Cost {
  const cost: Cost = { statements: 0, lineage: 0, rows: 0, generation: 0 };
  const slot = counting.get(f.db)!;
  const changes = () => Number(f.db.prepare("SELECT total_changes() AS n").get()!.n);
  const generation = f.generation(), before = changes();
  f.db.exec("BEGIN");
  slot.cost = cost;
  try { work(f.db); slot.cost = null; f.db.exec("COMMIT"); }
  catch (error) { slot.cost = null; f.db.exec("ROLLBACK"); throw error; }
  cost.rows = changes() - before;
  cost.generation = f.generation() - generation;
  return cost;
}
const verdict = (f: WritetimeFixture, id: string) => denyLookup(f.db, { threadId: T, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)!;
const denyRows = (f: WritetimeFixture, lsn: number, thread = T) => Number(f.db.prepare("SELECT count(*) AS n FROM memory_deny_line WHERE thread_id=? AND lsn=?").get(thread, lsn)!.n);
const holdRows = (f: WritetimeFixture, lsn: number, thread = T) => Number(f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn=?").get(thread, lsn)!.n);

it("a captured line under a standing queue reads its lineage a fixed number of times, not once per queued job", () => {
  const cost = (jobs: number) => {
    const f = file();
    queue(f, jobs);
    lines(f, 300, 1000, 900);                       // a long thread, every turn begun after every cap
    f.reply(T, "said", 2000, { turnLsn: 1900 });    // the line being captured
    f.db.prepare("UPDATE memory_lsn SET next=3000 WHERE id=1").run();
    // capture.ts: the source captured from a stored line inherits that one line's marks (a one-row range)
    const c = measure(f, db => inheritEdge(db, { kind: "source", id: "message:long:said" }, { threadId: T, messageId: "said" }));
    expect(verdict(f, "said")).toEqual({ state: "shown" });
    return c;
  };
  const none = cost(0), standing = cost(QUEUE);
  console.log(`MEASURED mem-f4 capture of one line, ${QUEUE} queued jobs: ${JSON.stringify(standing)}; no queue: ${JSON.stringify(none)}`);
  // nothing rests on a revoked line: no row, no generation, and the lineage reads do not grow with the queue
  expect(standing.rows).toBe(0);
  expect(standing.generation).toBe(0);
  expect(standing.lineage).toBeLessThanOrEqual(none.lineage + 2);
  expect(standing.statements).toBeLessThanOrEqual(none.statements + 4);
});

it("a thread over 256 lines does not hold a new line that rests on a line outside every window", () => {
  const f = file();
  queue(f);
  lines(f, 300, 10, 5);                             // 300 generated lines of turns begun BEFORE every cap: inside the windows
  f.reply(T, "clean", 2000, { turnLsn: 1900 });     // the parent: its turn began after every cap, so no window holds it
  f.reply(T, "child", 2500, { turnLsn: 2400 });
  f.db.prepare("UPDATE memory_lsn SET next=3000 WHERE id=1").run();
  expect(verdict(f, "clean")).toEqual({ state: "shown" });
  const c = measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 2500 }, [], [{ threadId: T, from: 2000, to: 2000 }]));
  console.log(`MEASURED mem-f4 long thread, clean parent, ${QUEUE} queued jobs: ${JSON.stringify(c)}`);
  // write-time agrees with read-time: the parent reads shown, so the child is neither held nor marked
  expect(holdRows(f, 2500)).toBe(0);
  expect(denyRows(f, 2500)).toBe(0);
  expect(verdict(f, "child")).toEqual({ state: "shown" });
  expect(c.rows).toBe(0);
  expect(c.generation).toBe(0);
  expect(c.lineage).toBeLessThanOrEqual(2);
});

it("a thread over 256 lines does not deny a new line that rests on a line outside every range", () => {
  const f = file();
  f.job(1, 600, "done").denyRange(T, 500, 600, 1);  // a finished forget: lines after 500 of turns begun before 600
  lines(f, 300, 10, 5);                             // 300 generated lines before the range's start (their turns began before its end)
  f.reply(T, "clean", 2000, { turnLsn: 1900 });     // after the range's start, of a turn begun after its end: outside it
  f.reply(T, "child", 2500, { turnLsn: 2400 });
  f.db.prepare("UPDATE memory_lsn SET next=3000 WHERE id=1").run();
  expect(verdict(f, "clean")).toEqual({ state: "shown" });
  const c = measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 2500 }, [], [{ threadId: T, from: 2000, to: 2000 }]));
  expect(denyRows(f, 2500)).toBe(0);
  expect(verdict(f, "child")).toEqual({ state: "shown" });
  expect(f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=1").get()!.state).toBe("done"); // the forget is not reopened
  expect(c.rows).toBe(0);
  expect(c.generation).toBe(0);
});

it("a line inside a range or a window still denies or holds its child at once, in a thread of any length", () => {
  const f = file();
  queue(f, 3);                                      // caps 101..103
  f.job(9, 600, "done").denyRange(T, 500, 600, 9);
  lines(f, 300, 10, 5);
  f.reply(T, "in-range", 700, { turnLsn: 550 });    // after 500, turn begun before 600: denied
  f.reply(T, "in-window", 400, { turnLsn: 102 });   // before the range's start, turn begun before cap 103 only: held by job 3
  f.reply(T, "c1", 2500, { turnLsn: 2400 }).reply(T, "c2", 2600, { turnLsn: 2400 });
  f.db.prepare("UPDATE memory_lsn SET next=3000 WHERE id=1").run();
  expect(verdict(f, "in-range")).toMatchObject({ state: "withheld", reason: "deny-range" });
  expect(verdict(f, "in-window")).toMatchObject({ state: "checking", reason: "pending" });
  const denied = measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 2500 }, [], [{ threadId: T, from: 700, to: 700 }]));
  expect(denyRows(f, 2500)).toBe(1);
  expect(verdict(f, "c1")).toMatchObject({ state: "withheld", reason: "deny-line" });
  expect(denied.generation).toBe(1);                // a row was written: every fence looks again
  const held = measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 2600 }, [], [{ threadId: T, from: 400, to: 400 }]));
  expect(f.db.prepare("SELECT revoke_id FROM memory_deny_pending WHERE thread_id=? AND since_lsn=2600").all(T).map(row => Number(row.revoke_id))).toEqual([3]);
  expect(verdict(f, "c2")).toMatchObject({ state: "checking", reason: "pending" });
  expect(held.generation).toBe(1);
});

/** The jobs holding the line at `lsn` of T. */
const holders = (f: WritetimeFixture, lsn: number) => f.db.prepare("SELECT revoke_id FROM memory_deny_pending WHERE thread_id=? AND since_lsn=? ORDER BY revoke_id").all(T, lsn).map(row => Number(row.revoke_id));
/** A carried run of more than 256 lines: T's lines 1000..1299 (turns begun at 900), carried as [50, 2000] by a child at 6500. */
function longRun(setup: (f: WritetimeFixture) => void): { f: WritetimeFixture; cost: Cost } {
  const f = file();
  lines(f, 300, 1000, 900);
  setup(f);
  f.reply(T, "child", 6500, { turnLsn: 6400 });
  f.db.prepare("UPDATE memory_lsn SET next=7000 WHERE id=1").run();
  return { f, cost: measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 6500 }, [], [{ threadId: T, from: 50, to: 2000 }])) };
}

it("a run of more than 256 lines reads its windows aggregated and still tells them apart", () => {
  // jobs 1..3: `*` windows since 1, caps 101..103. job 4: a `*` window since 500, cap 600 (it starts inside the run)
  const windows = (f: WritetimeFixture) => {
    queue(f, 3);
    f.job(4, 600).pending("*", 500, 4);
    f.db.prepare("UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=4").run(JSON.stringify({ kind: "line", threadId: "elsewhere" }));
  };
  // no line of the run began before any cap: nothing held, nothing written, and a fixed number of lineage reads for the four windows
  const clean = longRun(windows);
  expect(holders(clean.f, 6500)).toEqual([]);
  expect(clean.cost.rows).toBe(0);
  expect(clean.cost.lineage).toBeLessThanOrEqual(3);
  // a line at 300 of a turn begun at 102: before cap 103 only, and before job 4's since (its turn began before cap 600 all the same)
  expect(holders(longRun(f => { windows(f); f.reply(T, "a", 300, { turnLsn: 102 }); }).f, 6500)).toEqual([3]);
  // a line at 700 of a turn begun at 550: inside job 4's window only
  expect(holders(longRun(f => { windows(f); f.reply(T, "b", 700, { turnLsn: 550 }); }).f, 6500)).toEqual([4]);
  // the same old-turn line past the run's end holds nothing
  expect(holders(longRun(f => { windows(f); f.reply(T, "c", 2500, { turnLsn: 102 }); }).f, 6500)).toEqual([]);
  // a window whose cap is above the run's turns (job 5: since 1900, cap 5000) holds it, and it alone: its turn read is not whole,
  // while the others' are read at their own caps
  expect(holders(longRun(f => { windows(f); f.job(5, 5000).pending("*", 1900, 5); }).f, 6500)).toEqual([5]);
});

it("a run of more than 256 lines is held by a window over no stored line of it", () => {
  // 300 owner lines (no generated line at all, so every turn read is whole and empty), windows of line roots elsewhere: job 1's window
  // (since 1) lies over stored lines, none of them generated, and holds nothing; job 2's (since 1900) lies past the run's last line
  const f = file();
  lines(f, 300, 1000, null);
  queue(f, 1);
  f.job(2, 5000).pending("*", 1900, 2);
  f.db.prepare("UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=2").run(JSON.stringify({ kind: "line", threadId: "elsewhere" }));
  f.reply(T, "child", 6500, { turnLsn: 6400 });
  f.db.prepare("UPDATE memory_lsn SET next=7000 WHERE id=1").run();
  f.db.exec("BEGIN");
  inheritMarks(f.db, { kind: "line", threadId: T, lsn: 6500 }, [], [{ threadId: T, from: 50, to: 2000 }]);
  f.db.exec("COMMIT");
  expect(holders(f, 6500)).toEqual([2]);
});

it("a run of more than 256 lines holds on an owner line only inside a window that reaches owner ancestry", () => {
  // job 6: a window of T itself (since 100, cap 150), so an owner line of the run at or after 100 is ancestry it reaches
  const own = (f: WritetimeFixture) => { queue(f, 2); f.job(6, 150).pending(T, 100, 6); };
  expect(holders(longRun(own).f, 6500)).toEqual([]);
  expect(holders(longRun(f => { own(f); f.owner(T, "early", 60); }).f, 6500)).toEqual([]);                          // before the window's since
  expect(holders(longRun(f => { own(f); f.owner(T, "early", 60).owner(T, "asked", 1500); }).f, 6500)).toEqual([6]); // jobs 1, 2: a line root elsewhere
});

it("a run of more than 256 lines is denied by a range only when a line of it is inside the range", () => {
  // a finished forget: lines after 5 of turns begun before 600. The run's first 257 lines are all of later turns, so the position
  // read is not whole and the turn-first read decides
  const range = (f: WritetimeFixture) => f.job(1, 600, "done").denyRange(T, 5, 600, 1);
  const clean = longRun(range);
  expect(denyRows(clean.f, 6500)).toBe(0);
  expect(clean.cost.rows).toBe(0);
  expect(clean.cost.generation).toBe(0);
  // a denied line past the 257th row of the run (1500, turn begun at 550)
  const denied = longRun(f => { range(f); f.reply(T, "late", 1500, { turnLsn: 550 }); });
  expect(verdict(denied.f, "late")).toMatchObject({ state: "withheld", reason: "deny-range" });
  expect(denyRows(denied.f, 6500)).toBe(1);
  expect(verdict(denied.f, "child")).toMatchObject({ state: "withheld", reason: "deny-line" });
  // the same line past the run's end, or before the range's start, denies nothing
  expect(denyRows(longRun(f => { range(f); f.reply(T, "past", 2500, { turnLsn: 550 }); }).f, 6500)).toBe(0);
  expect(denyRows(longRun(f => { f.job(1, 600, "done").denyRange(T, 800, 600, 1); f.reply(T, "before", 700, { turnLsn: 550 }); }).f, 6500)).toBe(0);
});

it("a short run that starts before a range's start is denied only by a line after that start", () => {
  const world = (turnOfLate: number) => {
    const f = file();
    f.job(1, 600, "done").denyRange(T, 800, 600, 1);
    f.reply(T, "early", 700, { turnLsn: 550 });      // before the range's start: the read rule shows it
    f.reply(T, "late", 900, { turnLsn: turnOfLate });
    f.reply(T, "child", 2500, { turnLsn: 2400 });
    f.db.prepare("UPDATE memory_lsn SET next=3000 WHERE id=1").run();
    expect(verdict(f, "early")).toEqual({ state: "shown" });
    f.db.exec("BEGIN");
    inheritMarks(f.db, { kind: "line", threadId: T, lsn: 2500 }, [], [{ threadId: T, from: 700, to: 900 }]);
    f.db.exec("COMMIT");
    return { read: verdict(f, "late").state, denied: denyRows(f, 2500) };
  };
  expect(world(850)).toEqual({ read: "shown", denied: 0 });
  expect(world(550)).toEqual({ read: "withheld", denied: 1 });
});

it("when neither bounded read is whole the child is denied or held (fail closed)", () => {
  // more than 256 lines in the run AND more than 256 generated lines of turns begun before the range's end or the cap, all of them
  // outside the run: nothing bounded proves the run clean
  const far = (f: WritetimeFixture) => f.db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<299)
    INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn) SELECT ?,5000+i,'far'||i,5 FROM c`).run(testThreadNo(f.db, T));
  expect(denyRows(longRun(f => { f.job(1, 600, "done").denyRange(T, 5, 600, 1); far(f); }).f, 6500)).toBe(1);
  expect(holders(longRun(f => { queue(f, 2); far(f); }).f, 6500)).toEqual([1, 2]);
});

it("write-time and read-time agree for every parent position in a long thread", () => {
  const f = file();
  queue(f, 8);                                      // caps 101..108, since 1
  f.job(20, 500, "done").denyRange(T, 400, 500, 20);
  f.job(21, 900, "done").denyRange(T, 800, 900, 21);
  lines(f, 300, 10, 5);                             // history: 300 generated lines of old turns (inside every window)
  lines(f, 300, 1200, 1100);                        // and 300 later lines outside everything
  // parents at chosen positions: [lsn, turn_lsn]
  const parents: Array<[number, number]> = [[350, 107], [360, 108], [370, 104], [420, 105], [430, 410], [450, 499], [460, 500], [550, 450], [560, 520], [810, 100], [820, 850], [850, 899], [860, 900], [950, 890], [960, 940], [1600, 1550]];
  parents.forEach(([lsn, turn]) => f.reply(T, `p${lsn}`, lsn, { turnLsn: turn }));
  f.db.prepare("UPDATE memory_lsn SET next=5000 WHERE id=1").run();
  const seen: string[] = [];
  parents.forEach(([lsn], at) => {
    // each child is a line of a thread of its own (a hold of one child's thread covers its later lines, so a shared thread would hide a miss)
    const child = 3000 + at, thread = `reader-${at}`;
    f.reply(thread, "child", child, { turnLsn: 2900 });
    const read = verdict(f, `p${lsn}`);
    f.db.exec("BEGIN");
    inheritMarks(f.db, { kind: "line", threadId: thread, lsn: child }, [], [{ threadId: T, from: lsn, to: lsn }]);
    f.db.exec("COMMIT");
    const wrote = denyRows(f, child, thread) ? "withheld" : holdRows(f, child, thread) ? "checking" : "shown";
    seen.push(read.state);
    expect(wrote, `parent ${lsn}: read ${JSON.stringify(read)}`).toBe(read.state);
  });
  // the positions cover all three verdicts, so the agreement is not vacuous
  expect(new Set(seen)).toEqual(new Set(["withheld", "checking", "shown"]));
});

it("a carry that writes nothing does not move the deny generation", () => {
  const f = file();
  f.job(1, 100).pending("*", 1, 1);
  f.reply(T, "parent", 50, { turnLsn: 40 });        // inside the window (turn begun before the cap)
  f.reply(T, "child", 500, { turnLsn: 400 });
  f.db.prepare("UPDATE memory_lsn SET next=1000 WHERE id=1").run();
  const carry = () => measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 500 }, [], [{ threadId: T, from: 50, to: 50 }]));
  const first = carry();
  expect(holdRows(f, 500)).toBe(1);
  expect(first.generation).toBe(1);                 // the hold is new: the generation moves, at once
  const again = carry();                            // the same carry again (a streamed reply growing, a redelivered event): already held
  expect(holdRows(f, 500)).toBe(1);
  expect(again.rows).toBe(0);
  expect(again.generation).toBe(0);
  // and a window whose job has finished holds nothing and writes nothing
  f.db.prepare("UPDATE memory_revoke_jobs SET state='done' WHERE revoke_id=1").run();
  f.reply(T, "late", 600, { turnLsn: 550 });
  const done = measure(f, db => inheritMarks(db, { kind: "line", threadId: T, lsn: 600 }, [], [{ threadId: T, from: 50, to: 50 }]));
  expect(holdRows(f, 600)).toBe(0);
  expect(done.generation).toBe(0);
});
