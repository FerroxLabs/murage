// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memory V2 lane C, slice "windows" (MEMORY-V2-DESIGN 4.3 V5 parts 1-3; gap-check 15, 25, 36a).
// The pending-window readers of deny-read.ts on a real SQLite file with the real schema (WritetimeFixture): the memo of the exact read
// (V5-1), the strict TEMP summary past 256 rows (V5-2) and the three reader rules (V5-3). Each test prints one MEMV2C line.
// Mutants: MEMV2_C_MUTANT=a|b|c|d switches one test-only seam on for the whole file (a: only `seeding` is uncapped, the 36a bug;
// b: a delete lowers the lowest since and the uncapped count; c: the memo is keyed on the process counter alone; d: a job state or
// started_lsn update does not reset the summary; e: the summary seek trusts the data_version the memo sampled before the pending-row
// read, the code at 123f612e2f; f: a summary stamped with another data_version is answered anyway; g: the memo ignores a TEMP table
// that shadows a watched name, the code at 032b285875 for a shadow made before install; h: PRAGMA temp.schema_version left out of the
// version; i: the shadow probe compares names with case; j: a dropped memo trigger is not noticed; k: the memo reads the unqualified
// pragma_data_version, the code at 2fe03224ca; l: the summary seek reads it unqualified, the code at 2fe03224ca; m: the memo counts its
// triggers by name prefix, the code at 2fe03224ca; n: the summary never checks its own triggers, the code at 2fe03224ca; o: the memo reads
// main.pragma_data_version, which a view of that name in main shadows; p: the summary seek ignores such a view). Every one must turn at least its
// named witness RED, except h: the shadow probe runs on every call, so h is defence in depth required by F-R3 C-R3 and is declared, not killed.
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { denyReadMeter, refsLookup, resetDenyReadMeter } from "./deny-read.ts";
import { PENDING_ALL_SCOPES, PENDING_ALL_THREADS, type LineageReader } from "./lineage-types.ts";
import { CONTENT, MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";

// the V2 modules do not exist on the product base (f6ae52c670): loaded by a computed path so the V5-1 witness still runs there
const load = async <T>(path: string): Promise<T | null> => { try { return await import(/* @vite-ignore */ path) as T; } catch { return null; } };
const wake = await load<typeof import("./revoke-wake.ts")>("./revoke-wake.ts");
const summary = await load<typeof import("./window-summary.ts")>("./window-summary.ts");
const MUTANT = process.env.MEMV2_C_MUTANT ?? "";

let f: WritetimeFixture;
function hooks(on: boolean): void {
  if (summary) Object.assign(summary.windowSummaryTestHooks, { seedingOnlyUncapped: on && MUTANT === "a", deleteLowersBounds: on && MUTANT === "b", noJobUpdateReset: on && MUTANT === "d", trustMemoVersion: on && MUTANT === "e", ignoreForeignCommit: on && MUTANT === "f", unqualifiedDataVersion: on && MUTANT === "l", ignoreMissingTriggers: on && MUTANT === "n", ignoreMainShadow: on && MUTANT === "p" });
  if (wake) Object.assign(wake.revokeWakeTestHooks, { processCounterOnly: on && MUTANT === "c", ignoreTempShadow: on && MUTANT === "g", noTempSchemaVersion: on && MUTANT === "h", caseSensitiveShadow: on && MUTANT === "i", ignoreMissingTriggers: on && MUTANT === "j", unqualifiedDataVersion: on && MUTANT === "k", triggersByPrefix: on && MUTANT === "m", qualifiedDataVersion: on && MUTANT === "o" });
}
beforeEach(() => { hooks(true); f = new WritetimeFixture().cert(true); });
afterEach(() => { f.close(); hooks(false); });

/** Counts every execution of a SELECT over a pending table by the product (the statement objects themselves; the test's own reads are tagged). */
function spyPendingReads(db: DatabaseSync): { reads: number } {
  const counts = { reads: 0 };
  const prepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
    if (/^\s*(WITH|SELECT)\b/i.test(sql) && /FROM memory_deny_pending/.test(sql)) for (const method of ["all", "get"]) {
      const run = statement[method]!.bind(statement);
      statement[method] = (...args: unknown[]) => { counts.reads++; return run(...args); };
    }
    return statement;
  };
  return counts;
}
const line = (thread: string, id = "reply", reader: LineageReader = CONTENT) => refsLookup(f.db, [{ kind: "line", threadId: thread, messageId: id }], reader).state;
const record = (id: string, scopeId: string) => refsLookup(f.db, [{ kind: "memory", ref: { kind: "record", id, version: 1, scopeId } }], CONTENT).state;
const note = () => refsLookup(f.db, [{ kind: "memory", ref: { kind: "note", id: "note-1" } }], CONTENT).state;
const build = () => summary!.buildWindowSummariesNow(f.db);
const summaryRow = (key = PENDING_ALL_THREADS, tbl = 0) => f.db.prepare("/*test*/ SELECT state,n,low,cap,uncapped FROM temp.mem_c_window_summary WHERE tbl=? AND key=?").get(tbl, key) as Record<string, number> | undefined;

/** n capped `*` windows (since 4000, caps firstCap..) and four lines: before every since, inside, and of a turn begun after every cap. */
function seedStar(n: number, firstCap = 5001): void {
  f.db.exec("BEGIN");
  for (let j = 1; j <= n; j++) f.job(j, firstCap + j - 1).pending(PENDING_ALL_THREADS, 4000, j);
  f.reply("th-early", "reply", 100, { turnLsn: 99 });
  f.reply("th-old", "reply", 4500, { turnLsn: 4400 });
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  f.db.exec("COMMIT");
}

// ---- V5-1: the exact read, memoised ----
it("V5-1: 100 lookups on an unchanged key run the pending-table read once per key (was once per lookup per key)", () => {
  const spy = spyPendingReads(f.db);
  seedStar(34);                                   // the field's `*` key holds 34 rows
  f.pending("th-old", 4000, 1);
  expect(line("th-old")).toBe("checking");        // warm: installs the version triggers outside the measured loop
  const versionReads = wake?.revokeWakeStats().versionReads ?? 0;
  spy.reads = 0;
  for (let i = 0; i < 100; i++) expect(line("th-old")).toBe("checking");
  const first = spy.reads;
  for (let i = 0; i < 100; i++) expect(line("th-new")).toBe("shown");
  console.log(`MEMV2C V5-1 pendingReadsPer100Lookups sameThread=${first} otherThread=${spy.reads - first} versionReads=${(wake?.revokeWakeStats().versionReads ?? 0) - versionReads}`);
  expect(first).toBe(0);                          // both keys (the thread's own, `*`) were read by the warm lookup
  expect(spy.reads - first).toBe(1);              // a new thread: its own key once; `*` is already held
  // and the memo is the exact read: a new window is seen by the very next lookup, and gone with its row
  f.job(900, 9500).pending(PENDING_ALL_THREADS, 8000, 900);
  expect(line("th-new")).toBe("checking");
  f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=900").run();
  expect(line("th-new")).toBe("shown");
});

it("V5-1 rollback (mutant c): a memo entry made inside a savepoint or a transaction never answers after its rollback", () => {
  seedStar(10);
  expect(line("th-new")).toBe("shown");
  // a window opened and rolled back: the entry "checking" must not survive
  f.db.exec("BEGIN; SAVEPOINT s1");
  f.job(900, 9500).pending(PENDING_ALL_THREADS, 8000, 900);
  expect(line("th-new")).toBe("checking");
  f.db.exec("ROLLBACK TO s1");
  expect(line("th-new")).toBe("shown");
  // the privacy direction: a window closed inside a savepoint reads shown there; after the rollback the row is back and must hold again
  f.job(901, 9500).pending(PENDING_ALL_THREADS, 8000, 901);
  expect(line("th-new")).toBe("checking");
  f.db.exec("SAVEPOINT s2; DELETE FROM memory_deny_pending WHERE revoke_id=901");
  expect(line("th-new")).toBe("shown");
  f.db.exec("ROLLBACK TO s2");
  expect(line("th-new")).toBe("checking");
  f.db.exec("COMMIT");
  // the same with a full ROLLBACK
  f.db.exec("BEGIN; DELETE FROM memory_deny_pending WHERE revoke_id=901");
  expect(line("th-new")).toBe("shown");
  f.db.exec("ROLLBACK");
  expect(line("th-new")).toBe("checking");
  // a statement that aborts half way (its rows undone by SQLite) leaves no stale entry either
  f.db.exec("BEGIN; DELETE FROM memory_deny_pending WHERE revoke_id=901");
  expect(line("th-new")).toBe("shown");
  expect(() => f.db.exec("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',8000,901),('*',8000,901)")).toThrow();
  expect(line("th-new")).toBe("shown");
  f.db.exec("ROLLBACK");
  expect(line("th-new")).toBe("checking");
});

it("V5-1 version pairs: after any rollback the version differs from every version seen before it", () => {
  seedStar(3);
  const seen = new Map<number, string>();
  const state = () => JSON.stringify(f.db.prepare("/*test*/ SELECT thread_id,since_lsn,revoke_id FROM memory_deny_pending ORDER BY 1,2,3").all());
  const check = (label: string) => {
    const version = wake!.memoVersion("windows", f.db), now = state(), known = seen.get(version);
    if (known !== undefined) expect(known, `version ${version} met again at ${label} with other rows`).toBe(now);
    seen.set(version, now);
  };
  check("start"); check("again");
  expect(seen.size).toBe(1);                      // an unchanged key: the same version (a memo can hit at all)
  let id = 1000;
  for (let round = 0; round < 40; round++) {
    f.db.exec("BEGIN"); check("begin");
    f.pending(PENDING_ALL_THREADS, 4000, ++id); check("insert");
    f.db.exec("SAVEPOINT s"); f.pending(PENDING_ALL_THREADS, 4000, ++id); check("insert in savepoint");
    f.db.exec("ROLLBACK TO s"); check("rollback to");
    f.pending(PENDING_ALL_THREADS, 4001, ++id); check("insert after rollback to");
    f.db.exec(round % 2 ? "ROLLBACK" : "COMMIT"); check("end");
    f.pending(PENDING_ALL_THREADS, 4002, ++id); check("autocommit insert");
  }
  // a commit by another connection (its rows fire no trigger here) moves the version too
  const before = wake!.memoVersion("windows", f.db);
  const other = new DatabaseSync(String((f.db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)[0]!.file));
  other.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('th-new',1,77777)").run();
  other.close();
  expect(wake!.memoVersion("windows", f.db)).not.toBe(before);
  expect(line("th-new")).toBe("checking");
});

it("V5-1 no version, no memo: a first use inside a transaction and a query_only handle run the exact read every time", () => {
  const spy = spyPendingReads(f.db); f.reply("th-x", "reply", 7000, { turnLsn: 6990 });   // a committed generated line: the query_only reader below reaches its window reads
  f.db.exec("BEGIN");
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  for (let i = 0; i < 5; i++) expect(line("th-new")).toBe("shown");
  expect(spy.reads).toBe(10);                     // two keys, five lookups: nothing remembered
  f.job(1, 9500).pending(PENDING_ALL_THREADS, 8000, 1);
  expect(line("th-new")).toBe("checking");
  f.db.exec("ROLLBACK");
  const path = String((f.db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)[0]!.file);
  const reader = new DatabaseSync(path);
  try {
    reader.exec("PRAGMA query_only=1");
    const readerSpy = spyPendingReads(reader);
    const installs = wake!.revokeWakeStats().installs;
    for (let i = 0; i < 5; i++) refsLookup(reader, [{ kind: "line", threadId: "th-x", messageId: "reply" }], CONTENT);
    expect(wake!.revokeWakeStats().installs).toBe(installs);
    expect(reader.prepare("/*test*/ SELECT count(*) AS n FROM sqlite_temp_master").get()).toEqual({ n: 0 });
    console.log(`MEMV2C V5-1 queryOnly reads=${readerSpy.reads}`);
  } finally { reader.close(); }
});

// ---- V5-2: past 256 rows ----
it("V5-2: the first overflow read holds everything and queues a paged build; no reader runs an aggregate or a page; then one TEMP seek answers", () => {
  const spy = spyPendingReads(f.db);
  seedStar(700);
  resetDenyReadMeter(); summary!.resetWindowSummaryStats();
  expect([line("th-early"), line("th-old"), line("th-new")]).toEqual(["checking", "checking", "checking"]);   // today's answer (gap-check 25)
  expect(summary!.windowSummaryStats()).toMatchObject({ pages: 0, queued: 1 });
  for (const sql of denyReadMeter().sql) if (/memory_deny_pending/.test(sql)) expect(sql, "an aggregate on a reader's path").not.toMatch(/count\(|min\(|max\(/i);
  expect(build()).toBe(Math.floor(700 / summary!.SUMMARY_PAGE) + 1);                                            // bounded pages, as closing work
  expect(summaryRow()).toEqual({ state: 1, n: 700, low: 4000, cap: 5700, uncapped: 0 });
  expect([line("th-early"), line("th-old"), line("th-new")]).toEqual(["shown", "checking", "shown"]);
  spy.reads = 0; summary!.resetWindowSummaryStats();
  const versionReads = wake!.revokeWakeStats().versionReads;
  for (let i = 0; i < 100; i++) expect(line("th-new")).toBe("shown");
  const got = { pendingReads: spy.reads, summarySeeks: summary!.windowSummaryStats().seeks, versionReads: wake!.revokeWakeStats().versionReads - versionReads, pages: summary!.windowSummaryStats().pages };
  console.log(`MEMV2C V5-2 overflowingKey per100Lookups ${JSON.stringify(got)}`);
  expect(got).toEqual({ pendingReads: 0, summarySeeks: 100, versionReads: 100, pages: 0 });
});

it("V5-2 the build runs from the wake, in pages, never on the reader's call", async () => {
  seedStar(300);
  summary!.resetWindowSummaryStats();
  expect(line("th-new")).toBe("checking");
  expect(summary!.windowSummaryStats().pages).toBe(0);
  for (let turn = 0; turn < 50 && summaryRow()?.state !== 1; turn++) await new Promise(resolve => setImmediate(resolve));
  expect(summary!.windowSummaryStats().pages).toBe(3);
  expect(line("th-new")).toBe("shown");
});

it("V5-2 uncapped as the exact read (mutant a, gap-check 36a): an inherit hold among more than 256 rows keeps a later turn's line held", () => {
  seedStar(300);
  f.job(900, 5100).pending(PENDING_ALL_THREADS, 6000, 900);        // since past its job's cap: every inherit hold. No cap.
  expect(line("th-new")).toBe("checking"); build();
  expect(summaryRow()).toMatchObject({ state: 1, n: 301, uncapped: 1 });
  expect(line("th-new")).toBe("checking");                         // the bug read it capped: shown
  expect(line("th-early")).toBe("shown");
  // the same row arriving AFTER the build (the trigger's classification), and a row with no job, and one still seeding
  f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=900").run();
  f.db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=900").run();   // resets; rebuild without it
  expect(line("th-new")).toBe("checking"); build();
  expect(line("th-new")).toBe("shown");
  f.job(901, 5100).pending(PENDING_ALL_THREADS, 6000, 901);
  expect(summaryRow()).toMatchObject({ state: 1, uncapped: 1 });
  expect(line("th-new")).toBe("checking");
});

it("V5-2 a delete lowers the count only (mutant b): never the uncapped count, never the lowest since", () => {
  seedStar(300);
  f.job(900, 5100).pending(PENDING_ALL_THREADS, 6000, 900);        // uncapped
  f.job(901, 5002).pending(PENDING_ALL_THREADS, 3000, 901).job(902, 5003).pending(PENDING_ALL_THREADS, 3000, 902); // two rows share the lowest since
  f.reply("th-3000", "reply", 3000, { turnLsn: 2990 });
  expect(line("th-new")).toBe("checking"); build();
  expect(summaryRow()).toEqual({ state: 1, n: 303, low: 3000, cap: 5300, uncapped: 1 });
  f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=5").run();     // a capped row goes: the uncapped one is still there
  expect(line("th-new")).toBe("checking");
  f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=901").run();   // one of the two lowest goes: the other still holds lsn 3000
  expect(line("th-3000")).toBe("checking");
  expect(summaryRow()).toEqual({ state: 1, n: 301, low: 3000, cap: 5300, uncapped: 1 });
  // under the boundary the summary is dropped and the exact read answers
  f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id BETWEEN 10 AND 60").run();
  expect(summaryRow()).toBeUndefined();
  expect(line("th-new")).toBe("checking");
  f.db.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=900").run();
  expect(line("th-new")).toBe("shown");
});

it("V5-2 a job DELETE or an UPDATE of its state or started_lsn puts every summary back to hold-everything until rebuilt (mutant d)", () => {
  seedStar(300);
  f.reply("th-late-turn", "reply", 9100, { turnLsn: 6000 });       // its turn began after every cap (5001..5300)
  const built = () => { expect(line("th-new")).toBe("checking"); build(); expect(summaryRow()?.state).toBe(1); };
  built();
  expect([line("th-new"), line("th-late-turn"), line("th-early")]).toEqual(["shown", "shown", "shown"]);
  f.db.prepare("UPDATE memory_revoke_jobs SET started_lsn=7000 WHERE revoke_id=7").run();   // that window's cap moved up
  expect(line("th-late-turn")).toBe("checking");
  expect(line("th-early")).toBe("checking");                       // hold everything, not a stale summary
  built();
  expect([line("th-late-turn"), line("th-new"), line("th-early")]).toEqual(["checking", "shown", "shown"]);
  f.db.prepare("UPDATE memory_revoke_jobs SET state='seeding' WHERE revoke_id=9").run();
  expect(line("th-new")).toBe("checking");
  expect(summaryRow()).toBeUndefined();
  built();
  expect([line("th-new"), line("th-early")]).toEqual(["checking", "shown"]);
  f.db.prepare("UPDATE memory_revoke_jobs SET state='active' WHERE revoke_id=9").run();
  built();
  expect(line("th-new")).toBe("shown");
  f.db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=11").run();                   // its row has no job now: no cap
  expect(line("th-new")).toBe("checking");
  expect(summaryRow()).toBeUndefined();
  built();
  expect([line("th-new"), line("th-early")]).toEqual(["checking", "shown"]);
  // a job row written over (INSERT OR REPLACE fires no delete trigger) resets too
  f.job(11, 5011); built();
  expect(line("th-new")).toBe("shown");
  f.job(12, 9500);
  expect(line("th-new")).toBe("checking");
});

it("V5-2 the summary is restored by a rollback with the rows it summarises", () => {
  seedStar(300);
  expect(line("th-new")).toBe("checking"); build();
  expect(line("th-new")).toBe("shown");
  const before = summaryRow();
  f.db.exec("BEGIN; SAVEPOINT s");
  f.job(900, 5100).pending(PENDING_ALL_THREADS, 6000, 900).pending(PENDING_ALL_THREADS, 10, 900);
  expect([line("th-new"), line("th-early")]).toEqual(["checking", "checking"]);
  f.db.exec("ROLLBACK TO s");
  expect(summaryRow()).toEqual(before);
  expect([line("th-new"), line("th-early")]).toEqual(["shown", "shown"]);
  f.db.prepare("UPDATE memory_revoke_jobs SET state='seeding' WHERE revoke_id=9").run(); line("th-early");
  expect(summaryRow()).toBeUndefined();
  f.db.exec("ROLLBACK");
  expect(summaryRow()).toEqual(before);
  expect(line("th-new")).toBe("shown");
  // rows committed by another connection fired no trigger here: the summary is not trusted until rebuilt
  const other = new DatabaseSync(String((f.db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)[0]!.file));
  other.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',10,88888)").run();
  other.close();
  expect([line("th-new"), line("th-early")]).toEqual(["checking", "checking"]);
  build();
  expect([line("th-new"), line("th-early")]).toEqual(["checking", "checking"]); // row 88888 has no job: no cap, and its since is 10
});

// ---- V5-2 race (round 3, privacy): another connection commits a hold INSIDE one lookup ----
// One lookup reads, in this order: data_version (the memo's version), the pending rows of the thread's key and of `*`, the summary row.
// At 123f612e2f the summary was compared with the data_version of the FIRST read, so a hold committed by another connection after it
// left the summary's bounds standing and the lookup answered "shown" for lines the new hold covers. The interleaving is made exact,
// with no sleep and no seam in the product: the second connection commits from inside the product's own statement execution.
const databaseFile = (): string => String((f.db.prepare("/*test*/ PRAGMA database_list").all() as Array<{ file: string }>)[0]!.file);
/** Runs `commit` once, immediately before the product next executes a statement whose SQL `at` matches; answers how often it ran. */
function commitInside(at: (sql: string) => boolean, commit: () => void): { fired: () => number; restore: () => void } {
  const proto = StatementSync.prototype as unknown as Record<"all" | "get", (...args: unknown[]) => unknown>;
  const original = { all: proto.all, get: proto.get };
  let fired = 0;
  const restore = (): void => { proto.all = original.all; proto.get = original.get; };
  for (const method of ["all", "get"] as const) proto[method] = function (this: StatementSync, ...args: unknown[]) {
    if (!fired && !this.sourceSQL.startsWith("/*test*/") && at(this.sourceSQL)) { fired++; restore(); commit(); }
    return original[method].apply(this, args);
  };
  return { fired: () => fired, restore };
}
/** The exact read of one key's pending rows (deny-read.ts rawPending). */
const PENDING_ROW_READ = (sql: string): boolean => sql.includes("WITH raw AS MATERIALIZED") && sql.includes("FROM memory_deny_pending");
/** The reader's seek of the summary row (window-summary.ts summaryWindow). */
const SUMMARY_SEEK = (sql: string): boolean => sql.includes("FROM temp.mem_c_window_summary WHERE tbl=? AND key=?");
/** A hold on every thread from lsn 10 with no job row (so no cap), committed by a second connection. */
function foreignHold(): void {
  const other = new DatabaseSync(databaseFile());
  try { other.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',10,88888)").run(); } finally { other.close(); }
}
/** A WAL file, 300 capped `*` windows with a finished summary that answers "shown" for a line under every since and for a turn after every cap. */
function summarised(): void {
  expect(f.db.prepare("/*test*/ PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });   // the product's mode: readers never block a commit
  seedStar(300);
  f.reply("th-early-2", "reply", 110, { turnLsn: 109 });
  expect(line("th-new")).toBe("checking"); build();
  expect(summaryRow()).toEqual({ state: 1, n: 300, low: 4000, cap: 5300, uncapped: 0 });
  summary!.resetWindowSummaryStats();
  expect([line("th-new"), line("th-early")]).toEqual(["shown", "shown"]);
  expect(summary!.windowSummaryStats().seeks).toBe(2);             // answered by the summary, not by hold-everything
}
for (const [name, at] of [["between the version read and the pending-row read", PENDING_ROW_READ], ["between the pending-row read and the summary seek", SUMMARY_SEEK]] as const) {
  it(`V5-2 race (mutant e): a hold committed by another connection ${name} of one lookup is withheld by that lookup`, () => {
    summarised();
    // control: the hook alone changes nothing (a lookup of a thread whose own key was never read runs all three reads)
    let hook = commitInside(at, () => {});
    try { expect(line("th-early-2")).toBe("shown"); } finally { hook.restore(); }
    expect(hook.fired()).toBe(1);
    f.reply("th-early-3", "reply", 120, { turnLsn: 119 });
    f.reply("th-new-3", "reply", 9010, { turnLsn: 9000 });
    expect(line("th-new-3")).toBe("shown");
    // the race: the hold lands after this lookup read data_version, and it covers the line (lsn 120 >= 10, no cap)
    hook = commitInside(at, foreignHold);
    let raced: string;
    try { raced = line("th-early-3"); } finally { hook.restore(); }
    expect(hook.fired()).toBe(1);
    console.log(`MEMV2C V5-2 race (${name}): the racing lookup answered ${raced}`);
    // 123f612e2f answered shown from the bounds [4000, 5300). In the first form its own `*` read had already returned the new row (the
    // leak); in the second the commit lands after that read and the seek is the one statement that can still see it (strictness).
    expect(raced).toBe("checking");
    expect(summary!.windowSummaryStats().built).toBe(0);           // withheld by hold-everything: nothing was rebuilt on the reader's call
    expect([line("th-new-3"), line("th-new"), line("th-early")]).toEqual(["checking", "checking", "checking"]);
    build();
    expect(summaryRow()).toEqual({ state: 1, n: 301, low: 10, cap: 5300, uncapped: 1 });
    expect([line("th-early-3"), line("th-new-3"), line("th-new")]).toEqual(["checking", "checking", "checking"]);
  });
}
it("V5-2 race (mutant f): a summary built before another connection's commit never answers after it, whenever the commit landed", () => {
  summarised();
  foreignHold();                                                    // between two lookups
  expect([line("th-early"), line("th-new")]).toEqual(["checking", "checking"]);
  // a commit that leaves the pending rows alone is still a commit this handle's triggers did not see: hold until rebuilt
  build();
  const other = new DatabaseSync(databaseFile());
  try { other.prepare("DELETE FROM memory_deny_pending WHERE revoke_id=88888").run(); } finally { other.close(); }
  expect(line("th-early")).toBe("checking");
  build();
  expect(summaryRow()).toEqual({ state: 1, n: 300, low: 4000, cap: 5300, uncapped: 0 });
  expect([line("th-early"), line("th-new")]).toEqual(["shown", "shown"]);
});
it("V5-2 race: inside a read transaction the lookup answers from its snapshot, and from the new rows as soon as the transaction ends", () => {
  summarised();
  f.db.exec("BEGIN");
  try {
    expect(line("th-early")).toBe("shown");                        // the snapshot starts here
    foreignHold();                                                  // not in this snapshot: neither its row nor its data_version
    expect(f.db.prepare("/*test*/ SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=88888").get()).toEqual({ n: 0 });
    expect(line("th-early")).toBe("shown");
  } finally { f.db.exec("COMMIT"); }
  expect([line("th-early"), line("th-new")]).toEqual(["checking", "checking"]);
});

// ---- C-R3 (f-design-r3-opus/F-R3.md section 4, CONTRACT-REQ C-R3): a TEMP table that shadows a watched name ----
// The readers name the pending tables unqualified, so a TEMP table of the same name is what they read; the memo's triggers sit on main.
// A withholding row written to the shadow must be withheld by the very next lookup, warm memo or not.
const shadow = (table: string) => f.db.exec(`/*test*/ CREATE TEMP TABLE ${table} AS SELECT * FROM main.${table} WHERE 0`);
it("C-R3 shadow made before the memo is installed (mutant g): a hold written to temp.memory_deny_pending_scope is withheld by the next lookup", () => {
  f.job(1, 5001);
  f.db.prepare("UPDATE memory_lsn SET next=4500 WHERE id=1").run();
  f.record("rec-x", 1, "s-room");
  shadow("memory_deny_pending_scope");             // before the first lookup of this handle: the memo installs with the shadow present
  expect(record("rec-x", "s-room")).toBe("shown");
  expect(record("rec-x", "s-room")).toBe("shown"); // warm
  f.db.prepare("/*test*/ INSERT INTO temp.memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-room',4000,1)").run();
  const got = record("rec-x", "s-room");
  console.log(`MEMV2C C-R3 shadow-pre pending_scope: ${got}`);
  expect(got).toBe("checking");
  expect(wake!.memoDataVersion("windows", f.db)).toBeNull(); // no memo, so no summary, while the shadow exists
  f.db.exec("/*test*/ DROP TABLE temp.memory_deny_pending_scope");
  expect(record("rec-x", "s-room")).toBe("shown");  // the main rows again (none)
  expect(wake!.memoDataVersion("windows", f.db)).not.toBeNull();
});
it("C-R3 shadow made after the memo is warm: a hold written to temp.memory_deny_pending (thread) or temp.memory_deny_pending_scope is withheld", () => {
  f.job(1, 9500);
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  f.db.prepare("UPDATE memory_lsn SET next=4500 WHERE id=1").run();
  f.record("rec-x", 1, "s-room");
  for (let i = 0; i < 3; i++) { expect(line("th-new")).toBe("shown"); expect(record("rec-x", "s-room")).toBe("shown"); }
  shadow("memory_deny_pending");
  f.db.prepare("/*test*/ INSERT INTO temp.memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('th-new',8000,1)").run();
  shadow("memory_deny_pending_scope");
  f.db.prepare("/*test*/ INSERT INTO temp.memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-room',4000,1)").run();
  const got = [line("th-new"), record("rec-x", "s-room")];
  console.log(`MEMV2C C-R3 shadow-post thread,scope: ${got.join(",")}`);
  expect(got).toEqual(["checking", "checking"]);
});
it("C-R3 a shadow already in place when the hold lands, its name in another case (mutants g, i): the next lookup withholds", () => {
  f.job(1, 5001);
  f.db.prepare("UPDATE memory_lsn SET next=4500 WHERE id=1").run();
  f.record("rec-x", 1, "s-room");
  expect(record("rec-x", "s-room")).toBe("shown");  // warm
  f.db.exec("/*test*/ CREATE TEMP TABLE Memory_Deny_Pending_Scope AS SELECT * FROM main.memory_deny_pending_scope WHERE 0");
  expect(record("rec-x", "s-room")).toBe("shown");  // the shadow is what the readers read now (empty), and it stays in place
  expect(record("rec-x", "s-room")).toBe("shown");
  f.db.prepare("/*test*/ INSERT INTO temp.memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-room',4000,1)").run();
  const got = record("rec-x", "s-room");
  console.log(`MEMV2C C-R3 shadow in place, mixed case: ${got}`);
  expect(got).toBe("checking");
});
it("C-R3 a dropped memo trigger (mutant j): a pending row written after the drop is withheld by the next lookup", () => {
  f.job(1, 9500);
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  expect(line("th-new")).toBe("shown");              // warm: the triggers are installed
  f.db.exec("/*test*/ DROP TRIGGER temp.mem_c_memo_windows__memory_deny_pending__i");
  expect(line("th-new")).toBe("shown");
  f.pending("th-new", 8000, 1);                      // fires no trigger of the memo now
  const got = line("th-new");
  console.log(`MEMV2C C-R3 dropped trigger: ${got}`);
  expect(got).toBe("checking");
  expect(f.db.prepare("/*test*/ SELECT count(*) AS n FROM temp.sqlite_master WHERE name='mem_c_memo_windows__memory_deny_pending__i'").get()).toEqual({ n: 1 }); // installed again
});
it("C-R3 no summary answers for a shadowed key (mutant g): main's summary of 300 rows never answers for temp rows below its lowest since", () => {
  seedStar(300);                                   // main: 300 `*` windows from 4000; th-early (100) is before all of them
  expect(line("th-early")).toBe("checking");       // overflow: hold everything, build queued
  build();
  expect(line("th-early")).toBe("shown");          // the summary answers: low 4000
  shadow("memory_deny_pending");
  f.db.exec("BEGIN");
  const put = f.db.prepare("/*test*/ INSERT INTO temp.memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,50,?)");
  for (let j = 1; j <= 300; j++) put.run(PENDING_ALL_THREADS, j);
  f.db.exec("COMMIT");
  const got = line("th-early");
  console.log(`MEMV2C C-R3 shadow summary: ${got}`);
  expect(got).toBe("checking");
});

// ---- ASTRA 2fe03224ca: the version reads cannot be shadowed, and a decoy trigger never stands in for a dropped one ----
// The unqualified table-valued pragma_data_version resolves to a TEMP table or view of that name first. A view that answers the version
// the handle has now hides every later commit of another connection unless the read is schema-qualified (main.pragma_data_version).
const pinDataVersion = (): void => {
  const now = Number((f.db.prepare("/*test*/ PRAGMA data_version").get() as { data_version: number }).data_version);
  f.db.exec(`/*test*/ CREATE TEMP VIEW pragma_data_version AS SELECT ${now + (process.env.MEMV2_C_R8 === "pin" ? 1 : 0)} AS data_version`);
  expect(f.db.prepare("/*test*/ SELECT data_version FROM pragma_data_version").get()).toEqual({ data_version: now }); // the shadow is what the bare name reads
};
it("R6 a TEMP view named pragma_data_version, then another connection's hold (mutant k): the memo key moves and the hold is withheld", () => {
  expect(f.db.prepare("/*test*/ PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
  f.job(1, 9500);
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  pinDataVersion();
  expect(line("th-new")).toBe("shown");
  expect(line("th-new")).toBe("shown");                 // warm, under the shadow
  const before = wake!.memoVersion("windows", f.db);
  expect(wake!.memoVersion("windows", f.db)).toBe(before); // control: an unchanged store keeps its key (the memo can hit at all)
  foreignHold();                                        // '*' from lsn 10, no cap: covers lsn 9000
  const got = line("th-new");
  console.log(`MEMV2C R6 pragma_data_version shadow, memo: ${got}`);
  expect(got).toBe("checking");
  expect(wake!.memoVersion("windows", f.db)).not.toBe(before);
});
it("R6 a TEMP view named pragma_data_version, then another connection's hold (mutant l): main's summary never answers after the commit", () => {
  summarised();                                         // 300 `*` windows, summary built at the handle's data_version
  pinDataVersion();                                     // the view answers that same version from now on
  expect(line("th-early")).toBe("shown");               // control: the summary still answers before any foreign commit
  foreignHold();                                        // the memo moves (main.pragma_data_version), so the overflow key is read again
  const got = line("th-early");
  console.log(`MEMV2C R6 pragma_data_version shadow, summary: ${got}`);
  expect(got).toBe("checking");
});
it("R6 a dropped memo trigger replaced by a decoy of the same prefix (mutant m): a pending row written after it is withheld", () => {
  f.job(1, 9500);
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  expect(line("th-new")).toBe("shown");                 // warm: the triggers are installed
  f.db.exec(`/*test*/ DROP TRIGGER temp.mem_c_memo_windows__memory_deny_pending__i;
    CREATE TEMP TRIGGER mem_c_memo_windows__decoy AFTER UPDATE ON main.memory_lsn BEGIN SELECT 1; END;`);
  expect(f.db.prepare("/*test*/ SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger' AND name GLOB 'mem_c_memo_windows__*'").get()).toEqual({ n: 15 }); // the count by prefix is whole again
  expect(line("th-new")).toBe("shown");
  expect(line("th-new")).toBe("shown");
  f.pending("th-new", 8000, 1);
  const got = line("th-new");
  console.log(`MEMV2C R6 decoy memo trigger: ${got}`);
  expect(got).toBe("checking");
});
it("R6 a dropped summary trigger (mutant n): a `*` row this handle writes below the summary's lowest since is withheld", () => {
  summarised();
  f.db.exec("/*test*/ DROP TRIGGER temp.mem_c_ws_0_i");
  f.pending(PENDING_ALL_THREADS, 50, 77777);            // no job: uncapped, from lsn 50; the summary row is not told (its insert trigger is gone)
  expect(summaryRow()).toEqual({ state: 1, n: 300, low: 4000, cap: 5300, uncapped: 0 }); // the stale row the seek would find
  const got = line("th-early");                         // lsn 100
  console.log(`MEMV2C R6 dropped summary trigger: ${got}`);
  expect(got).toBe("checking");
  expect(line("th-new")).toBe("checking");
});

// main.pragma_data_version is not safe either: it resolves to a table or view of that name in main, which any connection can persist.
const mainPragmaView = (value: number): void => {
  const other = new DatabaseSync(databaseFile());
  try { other.exec(`CREATE VIEW pragma_data_version AS SELECT ${value + (process.env.MEMV2_C_R8 === "main" ? 1 : 0)} AS data_version`); } finally { other.close(); }
  expect(f.db.prepare("/*test*/ SELECT data_version FROM main.pragma_data_version").get()).toEqual({ data_version: value }); // the view is what the qualified name reads
};
it("R6 a view named pragma_data_version persisted in main by another connection, then its hold (mutant o): the memo key moves and the hold is withheld", () => {
  expect(f.db.prepare("/*test*/ PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
  f.job(1, 9500);
  f.reply("th-new", "reply", 9000, { turnLsn: 8990 });
  mainPragmaView(7);
  expect(line("th-new")).toBe("shown");
  expect(line("th-new")).toBe("shown");                 // warm, with the view in place
  const before = wake!.memoVersion("windows", f.db);
  expect(wake!.memoVersion("windows", f.db)).toBe(before); // control: the memo can hit
  foreignHold();
  const got = line("th-new");
  console.log(`MEMV2C R6 main pragma_data_version view, memo: ${got}`);
  expect(got).toBe("checking");
  expect(wake!.memoVersion("windows", f.db)).not.toBe(before);
});
it("R6 a view named pragma_data_version persisted in main, answering the summary's build version, then a hold (mutant p): the summary never answers", () => {
  summarised();
  const built = Number((f.db.prepare("/*test*/ PRAGMA data_version").get() as { data_version: number }).data_version); // no commit since the build
  mainPragmaView(built);                                // its commit moves this handle's version; the view keeps answering the build's
  foreignHold();
  const got = line("th-early");
  console.log(`MEMV2C R6 main pragma_data_version view, summary: ${got}`);
  expect(got).toBe("checking");
});

// ---- V5-3: three reader rules, each its own witness ----
it("V5-3 thread lines: since <= line and turn < cap, exact and summarised", () => {
  for (const n of [40, 300]) {
    f.close(); f = new WritetimeFixture().cert(true);
    seedStar(n);
    f.reply("th-mid", "reply", 5001 + n - 1, { turnLsn: 5001 + n - 2 });   // its turn began before the newest cap only
    f.reply("th-at-since", "reply", 4000, { turnLsn: 3999 });
    f.reply("th-under-since", "reply", 3999, { turnLsn: 3998 });
    f.reply("th-at-cap", "reply", 9000, { turnLsn: 5001 + n - 1 });        // turn == the highest cap: not under it
    line("th-new"); if (n > 256) build();
    const got = ["th-early", "th-under-since", "th-at-since", "th-old", "th-mid", "th-at-cap", "th-new"].map(thread => line(thread));
    console.log(`MEMV2C V5-3 lines rows=${n} ${got.join(",")}`);
    expect(got).toEqual(["shown", "shown", "checking", "checking", "checking", "shown", "shown"]);
  }
});
it("V5-3 memory objects: the creation lsn against the lowest since, exact and summarised", () => {
  for (const n of [40, 300]) {
    f.close(); f = new WritetimeFixture().cert(true);
    f.db.exec("BEGIN");
    for (let j = 1; j <= n; j++) f.job(j, 5000 + j).pendingScope(PENDING_ALL_SCOPES, 4000 + (j % 5), j);
    for (const [id, lsn] of [["rec-early", 100], ["rec-under", 3999], ["rec-at", 4000], ["rec-inside", 4500], ["rec-after-caps", 9000]] as const) {
      f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn);
      f.record(id, 1, "s-room");
    }
    f.db.prepare("UPDATE memory_lsn SET next=9500 WHERE id=1").run();
    f.db.exec("COMMIT");
    record("rec-early", "s-room"); if (n > 256) { expect(record("rec-early", "s-room")).toBe("checking"); build(); }
    const got = ["rec-early", "rec-under", "rec-at", "rec-inside", "rec-after-caps"].map(id => record(id, "s-room"));
    console.log(`MEMV2C V5-3 memory rows=${n} ${got.join(",")}`);
    // a memory object has no turn: the caps do not release it (the lower bound only)
    expect(got).toEqual(["shown", "shown", "checking", "checking", "checking"]);
  }
});
it("V5-3 unknown-scope objects: any pending row holds, at 1 row and past 256 (the global count, no summary needed)", () => {
  expect(note()).toBe("shown");
  f.job(1, 5001).pendingScope("s-other", 4000, 1);
  expect(note()).toBe("checking");
  f.db.prepare("DELETE FROM memory_deny_pending_scope").run();
  expect(note()).toBe("shown");
  seedStar(300);
  summary!.resetWindowSummaryStats();
  expect(note()).toBe("checking");
  build();
  expect(note()).toBe("checking");
  f.db.prepare("DELETE FROM memory_deny_pending").run();
  expect(note()).toBe("shown");
});

// ---- V5-W: the property ----
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const LINES: Array<[string, number, number]> = [["l1", 100, 99], ["l2", 3500, 3400], ["l3", 4500, 4400], ["l4", 5500, 5400], ["l5", 6500, 6400], ["l6", 7500, 7400], ["l7", 7600, 3000], ["l8", 9000, 8990]];
const RECORDS: Array<[string, number]> = [["r1", 100], ["r2", 3600], ["r3", 5200], ["r4", 9000]];
interface PRow { key: string; s: number; cap: number; ao: boolean }
function exactRows(table: "memory_deny_pending" | "memory_deny_pending_scope"): PRow[] {
  const column = table === "memory_deny_pending" ? "thread_id" : "scope_id";
  return (f.db.prepare(`/*oracle*/ SELECT p.${column} AS key,p.since_lsn AS s,j.started_lsn AS c,j.state AS st,EXISTS(SELECT 1 FROM memory_revoke_audience a WHERE a.revoke_id=p.revoke_id) AS ao
    FROM ${table} p LEFT JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id`).all() as Array<Record<string, unknown>>).map(row => ({
    key: String(row.key), s: Number(row.s), ao: Boolean(Number(row.ao)),
    cap: row.c === null || row.st === "seeding" || Number(row.s) > Number(row.c) ? Infinity : Number(row.c),
  }));
}
it("V5-W: over random rows and random insert/delete/job/rollback/savepoint orders: exact <= reader <= hold-everything, and at most 256 rows on every key: reader == exact", () => {
  const tally = { checks: 0, exactRegime: 0, overflow: 0, overflowShown: 0, overflowStricter: 0, builds: 0, rollbacks: 0 };
  for (const [seed, initial] of [[11, 0], [12, 200], [13, 250], [14, 300], [15, 300], [16, 520], [17, 257], [18, 280]] as const) {
    f.close(); f = new WritetimeFixture().cert(true);
    const random = prng(seed), pick = (n: number) => Math.floor(random() * n);
    f.db.exec("BEGIN");
    for (const [id, lsn, turn] of LINES) f.reply("th-a", id, lsn, { turnLsn: turn });
    for (const [id, lsn] of RECORDS) { f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn); f.record(id, 1, "s-room"); }
    f.db.prepare("UPDATE memory_lsn SET next=9500 WHERE id=1").run();
    f.db.exec("COMMIT");
    const probeAll = () => [
      ...LINES.map(([id]) => line("th-a", id, CONTENT)), ...LINES.map(([id]) => line("th-a", id, MEMBER)),
      ...RECORDS.map(([id]) => record(id, "s-room")), note()];
    const baseline = probeAll();                                    // no pending row anywhere: what each probe reads when nothing holds it
    let next = 1, depth = 0, inTx = false;
    const insert = (forceKey?: [0 | 1, string]) => {
      const j = next++, since = 3000 + pick(4000), kind = random();
      const where = forceKey ?? ((): [0 | 1, string] => { const at = random(); return at < 0.5 ? [0, PENDING_ALL_THREADS] : at < 0.7 ? [0, "th-a"] : at < 0.85 ? [1, PENDING_ALL_SCOPES] : [1, "s-room"]; })();
      if (kind < 0.55) f.job(j, since + pick(3000));                 // capped
      else if (kind < 0.7) f.job(j, since - 1 - pick(500));          // an inherit hold: since past its job's cap
      else if (kind < 0.8) f.job(j, since + pick(3000), "seeding");
      else if (kind < 0.9) { /* no job row */ }
      else { f.job(j, since + pick(3000)); f.db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(j); }
      if (where[0] === 0) f.pending(where[1], since, j); else f.pendingScope(where[1], since, j);
    };
    f.db.exec("BEGIN"); for (let i = 0; i < initial; i++) insert(seed % 2 ? [1, PENDING_ALL_SCOPES] : [0, PENDING_ALL_THREADS]); f.db.exec("COMMIT");
    const someJob = () => (f.db.prepare("/*test*/ SELECT revoke_id FROM memory_revoke_jobs ORDER BY revoke_id LIMIT 1 OFFSET ?").get(pick(Math.max(1, next - 1))) as { revoke_id?: number } | undefined)?.revoke_id;
    for (let step = 0; step < (process.env.MEMV2_C_R8 === "steps2" ? 2 : 140); step++) {
      const op = random();
      if (op < 0.30) insert();
      else if (op < 0.50) {
        const table = random() < 0.6 ? "memory_deny_pending" : "memory_deny_pending_scope";
        const n = Number((f.db.prepare(`/*test*/ SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
        if (n) { const burst = random() < 0.2 ? 40 : 1; f.db.prepare(`DELETE FROM ${table} WHERE (${table === "memory_deny_pending" ? "thread_id" : "scope_id"},since_lsn,revoke_id) IN (SELECT * FROM ${table} LIMIT ? OFFSET ?)`).run(burst, pick(n)); }
      }
      else if (op < 0.56) { const j = someJob(); if (j !== undefined) f.db.prepare("UPDATE memory_revoke_jobs SET state=CASE state WHEN 'seeding' THEN 'active' ELSE 'seeding' END WHERE revoke_id=?").run(j); }
      else if (op < 0.62) { const j = someJob(); if (j !== undefined) f.db.prepare("UPDATE memory_revoke_jobs SET started_lsn=? WHERE revoke_id=?").run(3000 + pick(7000), j); }
      else if (op < 0.65) { const j = someJob(); if (j !== undefined) f.db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=?").run(j); }
      else if (op < 0.80) { tally.builds += summary!.buildWindowSummariesNow(f.db) ? 1 : 0; }
      else if (op < 0.86) { if (!inTx) { if (process.env.MEMV2_C_R8 !== "notx") { f.db.exec("BEGIN"); inTx = true; depth = 0; } } else { f.db.exec(`SAVEPOINT s${++depth}`); } }
      else if (op < 0.92) { if (inTx && depth) { f.db.exec(`ROLLBACK TO s${depth}`); tally.rollbacks++; } else if (inTx) { f.db.exec("ROLLBACK"); inTx = false; tally.rollbacks++; } }
      else if (op < 0.96) { if (inTx && depth) f.db.exec(`RELEASE s${depth--}`); else if (inTx) { f.db.exec("COMMIT"); inTx = false; } }
      else if (inTx) { f.db.exec("ROLLBACK"); inTx = false; depth = 0; tally.rollbacks++; }
      // the exact verdicts, row by row with no limit (the three reader rules, deny-read.ts)
      const threads = exactRows("memory_deny_pending"), scopes = exactRows("memory_deny_pending_scope");
      const lineHeld = (content: boolean, lsn: number, turn: number) => threads.some(row => (row.key === "th-a" || row.key === PENDING_ALL_THREADS) && !(content && row.ao) && row.s <= lsn && turn < row.cap);
      const memoryRows = [...threads.filter(row => row.key === PENDING_ALL_THREADS), ...scopes.filter(row => row.key === PENDING_ALL_SCOPES || row.key === "s-room")].filter(row => !row.ao);
      const exact = [
        ...LINES.map(([, lsn, turn]) => lineHeld(true, lsn, turn)), ...LINES.map(([, lsn, turn]) => lineHeld(false, lsn, turn)),
        ...RECORDS.map(([, lsn]) => memoryRows.some(row => row.s <= lsn)), [...threads, ...scopes].some(row => !row.ao)];
      const count = (rows: PRow[], key: string) => rows.filter(row => row.key === key).length;
      const lineKeysExact = count(threads, "th-a") <= 256 && count(threads, PENDING_ALL_THREADS) <= 256;
      const memoryKeysExact = count(threads, PENDING_ALL_THREADS) <= 256 && count(scopes, PENDING_ALL_SCOPES) <= 256 && count(scopes, "s-room") <= 256;
      const regime = [...LINES.map(() => lineKeysExact), ...LINES.map(() => lineKeysExact), ...RECORDS.map(() => memoryKeysExact), threads.length <= 256 && scopes.length <= 256];
      const got = probeAll();
      for (let i = 0; i < got.length; i++) {
        tally.checks++;
        const label = `seed ${seed} step ${step} probe ${i}`;
        // reader <= hold-everything: a probe is either what it reads with no window at all, or "checking"
        expect([baseline[i], "checking"], label).toContain(got[i]);
        // exact <= reader: what the rows hold is never shown
        if (exact[i]) expect(got[i], label).toBe("checking");
        if (regime[i]) { tally.exactRegime++; expect(got[i], label).toBe(exact[i] ? "checking" : baseline[i]); }
        else { tally.overflow++; if (got[i] !== "checking") tally.overflowShown++; else if (!exact[i]) tally.overflowStricter++; }
      }
    }
    if (inTx) f.db.exec("ROLLBACK");
  }
  console.log(`MEMV2C V5-W ${JSON.stringify(tally)}`);
  // the property is not vacuous: both regimes were met, summaries were built, used (a probe read past 256 rows) and rolled back
  expect(tally.exactRegime).toBeGreaterThan(1000);
  expect(tally.overflow).toBeGreaterThan(1000);
  expect(tally.overflowShown).toBeGreaterThan(50);
  expect(tally.rollbacks).toBeGreaterThan(20);
}, 120_000);
