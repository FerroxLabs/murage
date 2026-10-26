// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S3 (DESIGN-WRITETIME 3, Opus section 4): the revoke commit, the pending window and the marker. Lineage rows are
// written here as S1's writers will write them (S1's writeLineage is still a stub), and every verdict is read through `verdict` below,
// the design's read predicate (section 1) over the tables S3 writes: S4's deny-read.ts is the production reader of the same rows.
// The revbound r3 cases closed in the write-time slices (REPORT.md A1-A6, FABLE-REPORT.md P1-1/P1-2 as F1/F2) have their commit side
// here; S4 owns their reader side (lessons.ts, readable.ts, deny-read.ts) and references these tests. Every test runs on the build host.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureThreadDeletion } from "./capture.ts";
import { forgetMemory } from "./forget.ts";
import * as revocation from "./memory-revocation.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
/** (read through the namespace so the failing-first run on the base, which has no such export, fails on its assertion, not its import) */
const SOURCE_WORK_ROWS = (revocation as { SOURCE_WORK_ROWS?: number }).SOURCE_WORK_ROWS ?? 256;
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { commitRevoke, inheritMarks, undoRevoke } from "./revoke-commit.ts";
import { markerSlice } from "./revoke-marker.ts";
import { FIRST_LSN, lineChildRef } from "./lineage-types.ts";
import { testThreadNo } from "./testing/writetime-fixture.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { migrateMemorySchema } from "./schema.ts";
import { sessionLookup } from "./deny-read.ts";

const inline = { ...INLINE_REVOCATION };
const dirs: string[] = [], dbs: DatabaseSync[] = [];
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => {
  stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks();
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
/** No bookkeeping step inside the commit, no runner: the window stays open until a test drains it. */
const stopJobs = () => { INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation(); };
function fresh(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "murage-marker-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  migrateMemorySchema(db, "active");
  return db;
}

// ---- lineage as S1 writes it
function takeLsn(db: DatabaseSync): number {
  const lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
  db.prepare("UPDATE memory_lsn SET next=next+1 WHERE id=1").run();
  return lsn;
}
function addLine(db: DatabaseSync, thread: string, id: string, generated: boolean, turnLsn?: number): number {
  const lsn = takeLsn(db);
  db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)").run(testThreadNo(db, thread), lsn, id, generated ? turnLsn ?? lsn : null);
  return lsn;
}
/** A thread of n lines, owner and generated in turn (each reply's turn built at its owner line). Returns the message ids by index. */
function thread(db: DatabaseSync, name: string, n: number): string[] {
  const ids: string[] = [];
  let lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
  const insert = db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)");
  db.exec("BEGIN");
  const no = testThreadNo(db, name);
  for (let i = 0; i < n; i++) {
    const id = `${name}-${i}`, generated = i % 2 === 1;
    insert.run(no, lsn, id, generated ? lsn - 1 : null);
    ids.push(id); lsn++;
  }
  db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn);
  db.exec("COMMIT");
  return ids;
}
const lsnOf = (db: DatabaseSync, t: string, id: string) => Number(db.prepare("SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(testThreadNo(db, t), id)!.lsn);
/** A point carry (a copy, a quote, a hand-off result) from a line into a new generated line of another thread. */
function copyInto(db: DatabaseSync, from: [string, string], to: string, id: string): number {
  const lsn = addLine(db, to, id, true);
  const at = lsnOf(db, from[0], from[1]);
  db.prepare("INSERT INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,0,?,?)").run(testThreadNo(db, from[0]), at, at, lineChildRef(lsn), testThreadNo(db, to));
  db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES(?,?,?)").run(from[0], to, lsn);
  return lsn;
}

// ---- the design's read predicate (DESIGN-WRITETIME 1) over what S3 writes; S4's deny-read.ts is its production form
type V = "shown" | "withheld" | "checking";
function verdict(db: DatabaseSync, t: string, id: string): V {
  const row = db.prepare("SELECT lsn,turn_lsn,turn_lsn IS NOT NULL AS generated FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(testThreadNo(db, t), id);
  if (!row) return "checking";
  const lsn = Number(row.lsn);
  if (db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(t)) return "withheld";
  if (db.prepare("SELECT 1 FROM memory_deny_line WHERE thread_id=? AND lsn=?").get(t, lsn)) return "withheld";
  if (Number(row.generated) !== 1) return "shown";
  const turn = row.turn_lsn === null ? lsn : Number(row.turn_lsn);
  if (db.prepare("SELECT 1 FROM memory_deny_range WHERE thread_id=? AND from_lsn<? AND ?<until_turn_lsn").get(t, lsn, turn)) return "withheld";
  if (db.prepare("SELECT 1 FROM memory_deny_pending WHERE thread_id IN (?,'*') AND since_lsn<=?").get(t, lsn)) return "checking";
  return "shown";
}
function memVerdict(db: DatabaseSync, kind: "record" | "source", id: string, version: number, scopeId: string): V {
  if (db.prepare("SELECT 1 FROM memory_deny_memory WHERE kind=? AND id=? AND version IN (0,?)").get(kind, id, version)) return "withheld";
  if (db.prepare("SELECT 1 FROM memory_deny WHERE kind='scope' AND id=?").get(scopeId)) return "withheld";
  const created = kind === "record" ? db.prepare("SELECT created_lsn AS c FROM memory_record_lsn WHERE id=? AND version=?").get(id, version)?.c : undefined;
  const pending = db.prepare("SELECT 1 FROM memory_deny_pending_scope WHERE scope_id IN (?,'*') AND (? IS NULL OR since_lsn<=?)").get(scopeId, created ?? null, created ?? null);
  return pending ? "checking" : "shown";
}
/** Counts the statements a step runs and the rows they return or change: its work, which does not depend on how busy the machine is. */
function measured<T>(db: DatabaseSync, step: () => T): { out: T; statements: number; rows: number } {
  const original = db.prepare.bind(db);
  const work = { statements: 0, rows: 0 };
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = original(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
    return new Proxy(statement, { get(target, name) {
      const value = target[name as string];
      if (typeof value !== "function") return value;
      if (name === "all" || name === "get" || name === "run" || name === "iterate") return (...args: unknown[]) => {
        const result = value.apply(target, args) as { length?: number; changes?: number | bigint } | undefined;
        work.statements++;
        work.rows += Array.isArray(result) ? result.length : result && typeof result === "object" ? ("changes" in result ? Number(result.changes) : 1) : 0;
        return result;
      };
      return value.bind(target);
    } });
  };
  try { return { out: step(), statements: work.statements, rows: work.rows }; }
  finally { delete (db as { prepare?: unknown }).prepare; }
}
/** Drains every revoke in marker slices of the production budget; returns the most work any one slice did. Work is counted in statements and
 * rows, not wall time: under a parallel test load the process is descheduled mid-slice and the clock measures the other tests (the slice's own
 * clock budget, 8 ms, is checked inside markerSlice; its row budget is the 256 passed here). */
function drain(db: DatabaseSync, each?: () => void): { maxStatements: number; maxRows: number; slices: number } {
  const out = { maxStatements: 0, maxRows: 0, slices: 0 };
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    const slice = measured(db, () => markerSlice(db, 256, 8));
    out.maxStatements = Math.max(out.maxStatements, slice.statements);
    out.maxRows = Math.max(out.maxRows, slice.rows);
    db.exec("COMMIT");
    if (!slice.out) return out;
    out.slices++;
    each?.();
  }
}
const count = (db: DatabaseSync, sql: string, ...args: unknown[]) => Number(db.prepare(sql).get(...args as never[])!.n);

// ---- the commit and the window

it("forgetting an early line in a 200k-line thread: the commit is flat, every descendant is withheld from it, copies read checking until marked, and every slice stays inside its budget", { tags: ["nightly"], timeout: 240_000 }, () => {
  const db = fresh();
  const ids = thread(db, "T", 200_000);
  // 60 replies elsewhere carried a late line of T (copies, quotes, hand-off results)
  const copies: string[] = [];
  for (let i = 0; i < 60; i++) { copyInto(db, ["T", ids[100_001 + 2 * i * 500]!], "U", `u-${i}`); copies.push(`u-${i}`); }
  // every tenth reply was captured into memory (the walk reaches each capture after the forgotten line)
  const capture = db.prepare("INSERT INTO memory_line_capture VALUES(?,?,?)"), tNo = testThreadNo(db, "T");
  db.exec("BEGIN"); for (let i = 1; i < ids.length; i += 20) capture.run(tNo, lsnOf(db, "T", ids[i]!), `message:T:${ids[i]}`); db.exec("COMMIT");
  const untouched = copyInto(db, ["T", ids[2]!], "V", "v-0"); // carried a line from before the forgotten one
  void untouched;
  const forgotten = ids[10]!, a = lsnOf(db, "T", forgotten);
  db.exec("BEGIN IMMEDIATE");
  // measured without the inline marker (inline: false): markInline (revoke-commit.ts) runs marker slices until INLINE_REVOCATION.ms of wall
  // clock has passed, so the statements it adds depend on the machine's speed, not on the thread (3.2k on the box that set the old bound,
  // 5,064 on a faster macOS runner, nightly 40179756396). That marking is the same slice work drain() bounds per slice below. What is left
  // is the commit's own writes for one forgotten line: a fixed few dozen statements (job row, line and range marks, one frontier node, the
  // pending windows, one flow seed), none of them a loop over the thread's lines. 200 leaves room for that set to grow by a few rows and
  // still fails on any per-line or per-capture work in the commit.
  const commit = measured(db, () => commitRevoke(db, { kind: "line", threadId: "T", messageIds: [forgotten], cause: "forget" }, { inline: false }));
  const R = commit.out;
  // the commit's own work is flat in the thread's length
  expect(commit.statements).toBeLessThan(200);
  db.exec("COMMIT");
  expect(R).toBeGreaterThan(0);
  // from the commit: every generated line after the forgotten one in T is withheld, every line written since reads checking at least
  for (let i = 11; i < ids.length; i += 2) expect(verdict(db, "T", ids[i]!)).toBe("withheld");
  for (let i = 1; i < 10; i += 2) expect(verdict(db, "T", ids[i]!)).toBe("shown");
  for (const id of copies) expect(verdict(db, "U", id)).toBe("checking");
  // turns during the window: after every slice, no copy is shown
  const run = drain(db, () => { for (const id of copies) expect(verdict(db, "U", id)).not.toBe("shown"); });
  // a slice's work stays inside its row budget (256), whatever the machine's load. The rows counted here are every row a statement reads
  // plus every row it writes, while the budget is spent on the rows read, so one slice can count up to about twice its budget. With the
  // commit measured without the inline marker, drain() now also runs the job's first slice (it used to run inside markInline, unmeasured):
  // that slice walks the range's 60 carried copies and two capture pages, 394 rows and 224 statements on every run (runner 4, 3 runs);
  // later slices are about 210 statements and 250 rows. 512 is twice the row budget: it holds the first slice and still fails on any slice
  // whose work grows with the thread's 200k lines.
  expect(run.maxRows).toBeLessThanOrEqual(512);
  expect(run.maxStatements).toBeLessThanOrEqual(400);
  expect(run.slices).toBeGreaterThan(1);
  // each capture after the forgotten line was reached as a source (one deny_memory row each); the ones before were not
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='source'")).toBe(count(db, "SELECT count(*) AS n FROM memory_line_capture WHERE lsn>?", a));
  for (const id of copies) expect(verdict(db, "U", id)).toBe("withheld");
  expect(verdict(db, "V", "v-0")).toBe("shown"); // its parent came before the forgotten line
  for (let i = 11; i < ids.length; i += 2) expect(verdict(db, "T", ids[i]!)).toBe("withheld");
  // the job is done: no pending row, no queue, no visited row is left; one range row in T (never one row per line)
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_pending")).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_pending_scope")).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_revoke_frontier")).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_revoke_reached")).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='T'")).toBe(1);
  expect(Number(db.prepare("SELECT from_lsn FROM memory_deny_range WHERE thread_id='T'").get()!.from_lsn)).toBe(a);
});

/** Counts the statements a call runs and the rows they return, on a wrapper of the connection. */
function instrumented(db: DatabaseSync) {
  const stats = { statements: 0, rows: 0, sql: new Set<string>() };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(s, p) {
          const value = Reflect.get(s, p) as unknown;
          if (p === "get" || p === "all" || p === "run") return (...args: unknown[]) => {
            stats.statements++; stats.sql.add(sql);
            const out = (value as (...a: unknown[]) => unknown).apply(s, args);
            if (p === "all") stats.rows += (out as unknown[]).length; else if (p === "get") stats.rows += out ? 1 : 0;
            return out;
          };
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(s) : value;
        } });
      };
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { proxy: proxy as DatabaseSync, stats };
}
/** No statement a hot path runs reads a lineage or mark table whole. */
function noFullScans(db: DatabaseSync, sql: Iterable<string>) {
  for (const text of sql) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map(row => String(row.detail));
    for (const line of plan) expect(line, `${text}\n${plan.join("\n")}`).not.toMatch(/^SCAN (memory_line_lineage|memory_lineage_carry|memory_deny_|memory_line_capture|memory_thread_flow|memory_revoke_frontier|memory_revoke_reached|memory_record_lsn)/);
  }
}

it("the revoke commit and inheritance at write cost the same statements and rows at 1k and 100k lines", () => {
  // Both sizes must finish the same inline work. A real 8 ms deadline makes the row/statement comparison depend on machine load.
  vi.spyOn(performance, "now").mockReturnValue(0);
  const measure = (n: number) => {
    const db = fresh();
    const ids = thread(db, "T", n);
    // a few earlier revokes in the thread, as a used file has
    for (const i of [3, 7]) { db.exec("BEGIN"); commitRevoke(db, { kind: "line", threadId: "T", messageIds: [ids[i]!], cause: "hide" }); db.exec("COMMIT"); }
    const { proxy, stats } = instrumented(db);
    db.exec("BEGIN");
    commitRevoke(proxy, { kind: "line", threadId: "T", messageIds: [ids[Math.floor(n / 2)]!], cause: "forget" });
    db.exec("COMMIT");
    const commit = { statements: stats.statements, rows: stats.rows };
    noFullScans(db, stats.sql);
    stats.statements = 0; stats.rows = 0; stats.sql.clear();
    const child = addLine(db, "W", "w-1", true);
    db.exec("BEGIN");
    const last = lsnOf(db, "T", ids[n - 1]!);
    inheritMarks(proxy, { kind: "line", threadId: "W", lsn: child }, [], [{ threadId: "T", from: last, to: last }, { threadId: "T", from: FIRST_LSN, to: last }]);
    db.exec("COMMIT");
    noFullScans(db, stats.sql);
    return { commit, inherit: { statements: stats.statements, rows: stats.rows } };
  };
  const small = measure(1_000), large = measure(100_000);
  expect(large).toEqual(small);
}, 120_000);

it("undo by revoke id restores what that revoke alone withheld, and keeps another revoke's marks", () => {
  const db = fresh();
  const ids = thread(db, "T", 1_000);
  copyInto(db, ["T", ids[301]!], "U", "u-1");
  db.exec("BEGIN");
  const hide = commitRevoke(db, { kind: "line", threadId: "T", messageIds: [ids[100]!], cause: "hide" });
  const forget = commitRevoke(db, { kind: "line", threadId: "T", messageIds: [ids[600]!], cause: "forget" });
  db.exec("COMMIT");
  drain(db);
  expect(verdict(db, "T", ids[201]!)).toBe("withheld");
  expect(verdict(db, "U", "u-1")).toBe("withheld");
  db.exec("BEGIN"); undoRevoke(db, hide); db.exec("COMMIT");
  drain(db);
  expect(verdict(db, "T", ids[201]!)).toBe("shown");
  expect(verdict(db, "U", "u-1")).toBe("shown");
  expect(verdict(db, "T", ids[601]!)).toBe("withheld"); // the forget's own marks stay
  for (const table of ["memory_deny_line", "memory_deny_range", "memory_deny_pending", "memory_deny_pending_scope", "memory_revoke_frontier", "memory_revoke_reached"])
    expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE revoke_id=?`, hide), table).toBe(0);
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=?", forget)).toBe(1);
});

it("inheritance at write: a child of a marked line enters the revoke's frontier (a finished revoke reopens); a child of a pending line reads checking", () => {
  // the window is what this test looks at: no inline marking at commit (revoke-commit.ts markInline), as when the commit's budget runs out
  const inline = INLINE_REVOCATION.ms; INLINE_REVOCATION.ms = 0;
  onTestFinished(() => { INLINE_REVOCATION.ms = inline; });
  const db = fresh();
  const ids = thread(db, "T", 100);
  db.exec("BEGIN");
  const R = commitRevoke(db, { kind: "line", threadId: "T", messageIds: [ids[10]!], cause: "forget" });
  db.exec("COMMIT");
  // inside the window: a reply quoting a line of T written after the root is pending, not yet marked
  const early = addLine(db, "X", "x-1", true);
  const at5 = lsnOf(db, "T", ids[5]!);
  db.exec("BEGIN"); inheritMarks(db, { kind: "line", threadId: "X", lsn: early }, [], [{ threadId: "T", from: at5, to: at5 }]); db.exec("COMMIT");
  expect(verdict(db, "X", "x-1")).toBe("checking");
  drain(db);
  expect(count(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='done' AND revoke_id=?", R)).toBe(1);
  expect(verdict(db, "X", "x-1")).toBe("shown"); // its parent (line 5) came before the forgotten line
  // after the job: a reply quoting a withheld line is marked by the reopened revoke
  const late = addLine(db, "Y", "y-1", true);
  const at51 = lsnOf(db, "T", ids[51]!);
  db.exec("BEGIN"); inheritMarks(db, { kind: "line", threadId: "Y", lsn: late }, [], [{ threadId: "T", from: at51, to: at51 }]); db.exec("COMMIT");
  expect(verdict(db, "Y", "y-1")).toBe("withheld"); // its own deny row at its write (DELETION-DRAIN-V2 2.3), not only held until the pop
  drain(db);
  expect(verdict(db, "Y", "y-1")).toBe("withheld");
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='Y' AND revoke_id=?", R)).toBe(1);
});

it("a new memory record version carries its created lsn (memory_record_lsn, the one v10 column S3 adds)", () => {
  const db = fresh();
  addLine(db, "T", "t-0", false); addLine(db, "T", "t-1", true);
  db.prepare("INSERT INTO memory_scopes VALUES('s','bot','b','[]',0)").run();
  db.prepare("INSERT INTO memory_records VALUES('r',1,'s','fact','x','owner-statement','active',0,1,NULL,NULL,1)").run();
  expect(db.prepare("SELECT created_lsn FROM memory_record_lsn WHERE id='r' AND version=1").get()?.created_lsn).toBe(3);
});

// ---- the revbound r3 cases (REPORT.md A1-A6, FABLE-REPORT.md P1-1 = F1, P1-2 = F2), commit side. S4 owns the reader side.

function live(): string {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
  setMemoryMode("active");
  return ensureScope("bot", "bot");
}
function source(id: string, scope: string, thread: string | null, message: string | null, revisions = 1, hash = (r: number) => `h-${id}-${r}`) {
  const db = database();
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,?,?,'text','bot','recorded',NULL,'active')").run(id, scope, thread, message, revisions, hash(revisions));
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,1)");
  for (let r = 1; r <= revisions; r++) version.run(id, r, hash(r), JSON.stringify({ text: `rev ${r}` }));
}
function record(id: string, scope: string, version = 1, evidence: Array<[string, number]> = []) {
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES(?,?,?,'fact','secret CORAL','assistant-inference','active',0,1,NULL,NULL,1)").run(id, version, scope);
  for (const [s, r] of evidence) db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,0,5)").run(id, version, s, r);
}
const drainAll = () => transaction(db => runRevocationJobsNow(db));

it("A1/F2: deleting a conversation nothing was captured from writes its deny fact and a revoke; a reply carrying its line is withheld", () => {
  live();
  const db = database();
  addLine(db, "X", "xo", false); addLine(db, "X", "xb", true);
  copyInto(db, ["X", "xb"], "Y", "y-1");
  db.prepare(`INSERT INTO memory_lessons(id,version,parent_id,bot_id,scope,recipients,kind,text,origin,state,evidence,prospect_derived,learning_event_id,created_at,decided_at,spec,where_,thread_id,source_message_id,target_message_id)
    VALUES('L1',1,NULL,'bot','bot',NULL,'note','Use the CORAL code','typed','active',?,0,NULL,1,1,NULL,NULL,'X',NULL,NULL)`).run(JSON.stringify([{ messageId: "xo" }]));
  expect(db.prepare("SELECT 1 FROM memory_sources WHERE thread_id='X'").get()).toBeUndefined();
  const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta").get()!.deletion_epoch);
  stopJobs();
  transaction(tx => captureThreadDeletion(tx, "X"));
  // the commit: the conversation's deny fact (lessons.ts reads it for a message reference with no source row: S4), the epoch, the revoke
  expect(db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id='X'").get()).toBeTruthy();
  expect(Number(db.prepare("SELECT deletion_epoch FROM memory_meta").get()!.deletion_epoch)).toBe(epoch + 1);
  expect(count(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='thread' AND state='active'")).toBe(1);
  expect(verdict(db, "X", "xb")).toBe("withheld");
  expect(verdict(db, "Y", "y-1")).toBe("checking");
  drainAll();
  expect(verdict(db, "Y", "y-1")).toBe("withheld");
});

it("A2: forgetting a record with more supporting rows than the commit tombstones withholds a record resting on an older supporting source from the commit", () => {
  const scope = live();
  const db = database();
  // R has 100 versions, each resting on its own source (the commit tombstones the newest 64); C rests on the source of version 1
  for (let v = 1; v <= 100; v++) { source(`s-${v}`, scope, null, null); record("R", scope, v, [[`s-${v}`, 1]]); }
  record("C", scope, 1, [["s-1", 1]]);
  expect(memVerdict(db, "record", "C", 1, scope)).toBe("shown");
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: "R" });
  expect(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id='s-1'").get()).toBeUndefined(); // still the job's
  expect(memVerdict(db, "record", "C", 1, scope)).toBe("checking");
  expect(memVerdict(db, "source", "s-1", 0, scope)).toBe("checking");
  drainAll();
  expect(memVerdict(db, "record", "C", 1, scope)).toBe("withheld");
  expect(memVerdict(db, "source", "s-1", 0, scope)).toBe("withheld");
  expect(memVerdict(db, "record", "R", 1, scope)).toBe("withheld");
});

it("A3/A4: a copy of a reply that repeated a forgotten line is withheld (checking from the commit, marked by the walk); the reply a lesson cites is withheld from the commit", () => {
  const scope = live();
  const db = database();
  addLine(db, "T", "q", false); addLine(db, "T", "a", true); addLine(db, "T", "b", true); addLine(db, "T", "own", false);
  source("message:T:a", scope, "T", "a");
  copyInto(db, ["T", "b"], "U", "mirror");
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:T:a" });
  expect(verdict(db, "T", "b")).toBe("withheld"); // A4: lessons and feedback citing b read this (S4: lessons.ts through denyLookup)
  expect(verdict(db, "T", "own")).toBe("shown");
  expect(verdict(db, "U", "mirror")).toBe("checking");
  drainAll();
  expect(verdict(db, "U", "mirror")).toBe("withheld"); // A3
});

it("A5: one much-revised source never ends all of its history in one statement: the commit cancels a page, the job the rest", { tags: ["nightly"] }, () => {
  const scope = live();
  const db = database();
  addLine(db, "T", "m", true);
  source("message:T:m", scope, "T", "m", 2_000);
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,?,'capture','1','pending',0,0)");
  db.exec("BEGIN"); for (let r = 1; r <= 2_000; r++) job.run(`j-${r}`, "message:T:m", r); db.exec("COMMIT");
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:T:m" });
  expect(count(db, "SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled'")).toBe(SOURCE_WORK_ROWS);
  drainAll();
  expect(count(db, "SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled'")).toBe(2_000);
  // a deleted conversation's much-revised source: its payloads are blanked a page at a time
  source("message:Z:z", scope, "Z", "z", 2_000);
  transaction(tx => captureThreadDeletion(tx, "Z"));
  drainAll();
  expect(count(db, "SELECT count(*) AS n FROM memory_source_versions WHERE source_id='message:Z:z' AND json_extract(payload,'$.deleted') IS NULL")).toBe(0);
});

it("A6: a re-import admitted while the forgotten source's older hashes waited for their tombstones reads checking, and is ended before the window closes", () => {
  const scope = live();
  const db = database();
  source("legacy:x", scope, null, null, 100);
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "legacy:x" });
  // an old revision's bytes come in again under another path: no tombstone for that hash yet, so admission (import.ts) lets it in
  expect(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash='h-legacy:x-5'").get(scope)).toBeUndefined();
  source("legacy:y", scope, null, null, 1, () => "h-legacy:x-5");
  expect(memVerdict(db, "source", "legacy:y", 0, scope)).toBe("checking");
  // the marker alone cannot close the window: it holds for the bookkeeping job's imports phase
  drain(db);
  expect(memVerdict(db, "source", "legacy:y", 0, scope)).toBe("checking");
  drainAll();
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='legacy:y'").get()?.state).toBe("deleted");
  expect(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id='legacy:y' AND revision IS NULL").get()).toBeTruthy();
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_pending_scope")).toBe(0);
});

it("F1: a reply made under a receipt citing only a promoted copy (no evidence) of a record resting on a forgotten line is withheld from the commit", () => {
  const scope = live();
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('proj-scope','room','proj','[]',0)").run();
  addLine(db, "room-1", "q", false); addLine(db, "room-1", "a", true);
  source("message:room-1:a", scope, "room-1", "a");
  record("R", scope, 1, [["message:room-1:a", 1]]);
  record("C", "proj-scope", 1, []);
  db.prepare("INSERT INTO memory_derivations VALUES('R',1,'C',1)").run();
  addLine(db, "proj", "po", false); addLine(db, "proj", "pr", true);
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('cites-C','proj','d','n','[{\"id\":\"C\",\"version\":1}]','[]','[\"pr\"]',0,0,0,'delivered',0)").run();
  db.prepare("INSERT OR IGNORE INTO memory_thread_flow VALUES('scope:proj-scope','proj',?)").run(lsnOf(db, "proj", "pr"));
  // the receipt's range (receipt-outputs.ts), as linkMemoryDisclosureOutput writes it when pr is linked
  noteReceiptOutput(db, "cites-C", "proj", lsnOf(db, "proj", "pr"), { driverInstance: "d", nativeSession: "n" });
  expect(verdict(db, "proj", "pr")).toBe("shown");
  stopJobs();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:a" });
  expect(verdict(db, "proj", "pr")).toBe("checking");
  expect(memVerdict(db, "record", "C", 1, "proj-scope")).toBe("checking");
  drainAll();
  expect(verdict(db, "proj", "pr")).toBe("withheld");
  expect(memVerdict(db, "record", "C", 1, "proj-scope")).toBe("withheld");
  expect(db.prepare("SELECT 1 FROM memory_deny_session WHERE thread_id='proj' AND native_session='n'").get()).toBeTruthy();
});

// the session readers of memory/dispatch.ts (an owner room or direct chat reads by content, every other room for its audience)
const CONTENT_SESSION_READER = { audience: null }, AUDIENCE_SESSION_READER = { audience: { owner: false, scopeIds: [] as string[] } };
// 1.0.3 keep-all refused (Fable High): a room member's engine keeps its session across turns with memory off. A line its first prompt carried
// is then forgotten or edited: the walker marks that session (deny_session), so the room path's session check resets it, owner room included.
it("a room member's retained session that held a forgotten or edited room line reads deny-session, for the content reader too", async () => {
  for (const cause of ["forget", "edit"] as const) {
    // the WAL checkpointer thread must have exited before its folder is removed (park-audit: ENOTEMPTY and database is locked otherwise)
    closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const scope = live();
    setMemoryMode("off");
    const db = database();
    const room = `room-${cause}`;
    const q = addLine(db, room, "q", false);
    addLine(db, room, "a", true, q);
    const q2 = addLine(db, room, "q2", false);
    addLine(db, room, "a2", true, q2);
    if (cause === "forget") source(`message:${room}:q`, scope, room, "q");
    // the member's engine session: begun on q (its first prompt's head) and resumed through the second turn
    db.prepare("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,?,?,?,?)").run(room, "keep", "s1", q, q2 + 1);
    const key = { threadId: room, driverInstance: "keep", nativeSession: "s1" };
    expect(sessionLookup(db, key, CONTENT_SESSION_READER)).toEqual({ state: "shown" });
    if (cause === "forget") forgetMemory(ownerMemoryTicket(), { kind: "source", id: `message:${room}:q` });
    else transaction(tx => commitRevoke(tx, { kind: "line", threadId: room, messageIds: ["q"], cause: "edit" }));
    drainAll();
    expect(db.prepare("SELECT 1 FROM memory_deny_session WHERE thread_id=? AND driver_instance='keep' AND native_session='s1'").get(room)).toBeTruthy();
    expect(sessionLookup(db, key, CONTENT_SESSION_READER)).toEqual({ state: "withheld", reason: "deny-session" });
    expect(sessionLookup(db, key, AUDIENCE_SESSION_READER)).toEqual({ state: "withheld", reason: "deny-session" });
  }
});

it("a carried range held by a window past 256 other pending rows still inherits that window (Astra delta High 2)", () => {
  const db = fresh(); stopJobs();
  db.prepare("UPDATE memory_lsn SET next=1000 WHERE id=1").run();
  // 300 unrelated install-wide windows (no job row: no cap, each matches the carried range), all older than the one that matters
  const insert = db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',?,?)");
  for (let i = 0; i < 300; i++) insert.run(1 + i, 5000 + i);
  // the parent P's line, of a turn begun before revoke 9's commit; revoke 9's window opens at that line
  const parent = addLine(db, "P", "p1", true, 990);
  const started = takeLsn(db);
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(9,'line','{}',?,?,'flow','','active')").run(parent, started);
  db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',?,9)").run(parent);
  // a line of C carries P's line: it is held under revoke 9 like every other window over its parent
  const child = addLine(db, "C", "c1", true);
  inheritMarks(db, { kind: "line", threadId: "C", lsn: child }, [], [{ threadId: "P", from: parent, to: parent }]);
  expect(count(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='C' AND revoke_id=9")).toBe(1);
});

it("a current-version open moves no cap: the activation runs only in the v10 to v12 step (Revision 3b, boot path)", () => {
  const db = fresh();
  db.prepare(`INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(4,'bulk','{"kind":"bulk","cause":"u2"}',5,20,'flow','','active')`).run();
  db.prepare("INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES('U',5,30,4,'forget')").run();
  migrateMemorySchema(db, "active");
  expect(Number(db.prepare("SELECT started_lsn FROM memory_revoke_jobs WHERE revoke_id=4").get()!.started_lsn)).toBe(20);
});
