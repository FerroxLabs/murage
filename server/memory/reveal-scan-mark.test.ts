// The reveal scan keeps a persisted high-water mark: after one pass over the
// job table further idle visits cost one probe, rows past the mark are still
// found, a job that finishes below the mark is still found, and a restart
// resumes from the mark instead of rowid 0. Work is counted by the statements
// run, which do not depend on the machine.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import * as reveal from "./reveal-capture.ts";

const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); (reveal as any).resetRevealScan?.(); });

afterEach(() => { vi.useRealTimers(); });
let counter = 0;
function seed(count: number, speaker: string, status = "complete", state = "active") {
  const db = database(), scope = ensureScope("bot", "moss");
  db.exec("BEGIN");
  for (let i = 0; i < count; i++, counter++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,?,'text',?,'settled',NULL,?)").run(`s${counter}`, scope, `m${counter}`, `h${counter}`, speaker, state);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(`s${counter}`, `h${counter}`, JSON.stringify({ text: `t${counter}` }));
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1',?,0,0,0,0,0)").run(`j${counter}`, `s${counter}`, status);
  }
  db.exec("COMMIT");
  return counter - 1;
}
/** The SQL text of every statement prepared while `run` executes. */
function statementsDuring(run: () => void): string[] {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return seen;
}
const rangeScans = (sql: string[]) => sql.filter(text => text.includes("NOT INDEXED")).length;
const receiptSweeps = (sql: string[]) => sql.filter(text => text.includes("subject_id='reveal-capture'")).length;

it("after a full pass, further idle visits are one probe and read no job rows", () => {
  seed(9000, "owner");  // nothing here is eligible for a reveal pass
  expect(reveal.pendingBotRevealJobs()).toEqual([]);
  const visits = statementsDuring(() => { for (let i = 0; i < 20; i++) expect(reveal.pendingBotRevealJobs()).toEqual([]); });
  expect(rangeScans(visits)).toBe(0);
  expect(visits.filter(text => text.includes("max(rowid)")).length).toBeLessThanOrEqual(20);
});

it("rows past the mark are still picked up", () => {
  seed(5000, "owner");
  expect(reveal.pendingBotRevealJobs()).toEqual([]);
  const last = seed(1, "assistant");
  expect(reveal.pendingBotRevealJobs()).toEqual([`j${last}`]);
});

it("a job below the mark that finishes later is still picked up", () => {
  const first = seed(1, "assistant", "pending");
  seed(6000, "owner");
  expect(reveal.pendingBotRevealJobs()).toEqual([]);
  expect(reveal.pendingBotRevealJobs()).toEqual([]);
  database().prepare("UPDATE memory_jobs SET status='complete' WHERE id=?").run(`j${first}`);
  expect(reveal.pendingBotRevealJobs()).toEqual([`j${first}`]);
});

it("the mark is persisted and a restart resumes from it, never from rowid 0", () => {
  seed(9000, "owner");
  reveal.pendingBotRevealJobs();
  const newest = Number(database().prepare("SELECT max(rowid) AS n FROM memory_jobs").get()!.n);
  expect(JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='reveal-scan-mark'").get()!.intent)).hwm).toBe(newest);
  closeDatabase(); (reveal as any).resetRevealScan?.();
  const visits = statementsDuring(() => { for (let i = 0; i < 5; i++) reveal.pendingBotRevealJobs(); });
  expect(rangeScans(visits)).toBe(0);
});

it("deferred receipts are found when due, and a full sweep with none due then sleeps", () => {
  const job = seed(1, "assistant"), scope = ensureScope("bot", "moss");
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?)").run(`reveal-capture:j${job}`, scope, JSON.stringify({ cursor: "", status: "pending", retryAt: Date.now() + 3_600_000, reason: "reveal-source-ineligible", attempts: 3 }));
  expect(reveal.pendingBotRevealJobs()).toEqual([]);  // not due yet
  expect(receiptSweeps(statementsDuring(() => { for (let i = 0; i < 10; i++) reveal.pendingBotRevealJobs(); }))).toBe(0);
  database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ cursor: "", status: "pending", retryAt: 0, attempts: 3 }), `reveal-capture:j${job}`);
  (reveal as any).resetRevealScan?.();
  expect(reveal.pendingBotRevealJobs()).toEqual([`j${job}`]);
});

it("the scans use rowid-range and index access only", () => {
  const plan = (sql: string, ...args: any[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail));
  const range = plan((reveal as any).REVEAL_RANGE_SQL ?? "SELECT 1", 0, 10);
  expect(range.join("\n")).toMatch(/SEARCH j USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<=?\?\)/);
  expect(range.filter(line => line.startsWith("SCAN"))).toEqual([]);
  const retry = plan((reveal as any).REVEAL_RETRY_SQL ?? "SELECT 1", 0, 10);
  expect(retry.join("\n")).toContain("USING INDEX memory_bindings_subject");
  expect(retry.filter(line => line.startsWith("SCAN"))).toEqual([]);
});

it("more unsettled jobs than the open set holds do not pin the mark: steady-state visits are one probe", () => {
  seed(300, "assistant", "pending");   // eligible, never finishing: 44 more than the open set holds
  seed(5000, "owner");
  expect(reveal.pendingBotRevealJobs()).toEqual([]);
  for (let i = 0; i < 3; i++) reveal.pendingBotRevealJobs();
  const visits = statementsDuring(() => { for (let i = 0; i < 20; i++) expect(reveal.pendingBotRevealJobs()).toEqual([]); });
  expect(visits.filter(text => text.includes("j.rowid>?")).length).toBe(0);                 // no window of the job table is read
  expect(visits.filter(text => text.includes("json_each(?)")).length).toBeLessThanOrEqual(20); // the open set: one lookup of at most 256 rowids a visit
  expect(visits.filter(text => text.includes("max(rowid)")).length).toBeLessThanOrEqual(20);
  const plan = database().prepare(`EXPLAIN QUERY PLAN ${reveal.REVEAL_OPEN_SQL}`).all("[1,2,3]").map(row => String(row.detail));
  expect(plan.filter(detail => /SCAN (j|memory_jobs)\b/.test(detail))).toEqual([]);
  const writes = statementsDuring(() => { for (let i = 0; i < 20; i++) reveal.pendingBotRevealJobs(); });
  expect(writes.filter(text => text.includes("INSERT INTO memory_scope_bindings"))).toEqual([]);
});

it("jobs that did not fit the open set are found once the set has room", () => {
  const first = seed(300, "assistant", "pending");
  seed(100, "owner");
  for (let i = 0; i < 4; i++) reveal.pendingBotRevealJobs();
  // The last job overflowed the open set. Finish it; it must still surface.
  database().prepare("UPDATE memory_jobs SET status='complete' WHERE id=?").run(`j${first}`);
  const found = new Set<string>();
  for (let i = 0; i < 400 && !found.has(`j${first}`); i++) {
    for (const id of reveal.pendingBotRevealJobs()) { found.add(id); database().prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?)").run(`reveal-capture:${id}`, ensureScope("bot", "moss"), JSON.stringify({ cursor: "", status: "complete", retryAt: 0 })); }
    // Finish one more each round so the open set drains.
    database().prepare("UPDATE memory_jobs SET status='complete' WHERE id=(SELECT id FROM memory_jobs WHERE status='pending' LIMIT 1)").run();
  }
  expect(found.has(`j${first}`)).toBe(true);
  // Everything that was pending was eventually offered, including the overflow.
  expect(found.size).toBeGreaterThan(256);
});

/** Live: 25,164 receipts parked, a few coming due each minute. Each due receipt that was handed out
 * set the sweep to run again in a second, and a sweep over thousands of receipts is a window a visit,
 * so the receipts were read through again and again (60 windows a minute, 0.66 s, idle). */
it("thousands of parked receipts are read once; later visits read only the receipts that come due", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.now(), db = database(), scope = ensureScope("bot", "moss");
  const jobs: string[] = [];
  for (let i = 0; i < 30; i++) jobs.push(`j${seed(1, "assistant")}`);   // eligible jobs, parked with a receipt
  db.exec("BEGIN");
  const put = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?)");
  // 30 receipts come due two seconds apart; 3,000 more are parked for later
  for (let i = 0; i < 3030; i++) put.run(i < 30 ? `reveal-capture:${jobs[i]}` : `reveal-capture:parked${i}`, scope,
    JSON.stringify({ cursor: "", status: "pending", retryAt: i < 30 ? T0 + 2000 * (i + 1) : T0 + 3_600_000 + i, reason: "reveal-source-ineligible", attempts: 2 }));
  db.exec("COMMIT");
  const found: string[] = [];
  const visits = statementsDuring(() => {
    for (let tick = 0; tick < 90; tick++) {
      vi.setSystemTime(T0 + 1000 * tick);
      for (const id of reveal.pendingBotRevealJobs()) {
        found.push(id);
        // what the reveal pass does with it: the receipt is settled
        db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ cursor: "", status: "complete", retryAt: 0 }), `reveal-capture:${id}`);
      }
    }
  });
  expect(receiptSweeps(visits)).toBeLessThanOrEqual(5);   // the first pass over 3,030 receipts, nothing after
  expect(found).toEqual(jobs);                       // every due receipt is handed out, in order, none twice
});

it("a receipt settled behind the sweep's back is dropped when it comes due, not handed out", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.now(), db = database(), scope = ensureScope("bot", "moss");
  const a = `j${seed(1, "assistant")}`;
  const put = (value: object) => db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(`reveal-capture:${a}`, scope, JSON.stringify(value));
  put({ cursor: "", status: "pending", retryAt: T0 + 5000 });
  for (let i = 0; i < 3; i++) reveal.pendingBotRevealJobs();   // the receipt is held in memory now
  put({ cursor: "", status: "complete", retryAt: 0 });
  vi.setSystemTime(T0 + 6000);
  expect(reveal.pendingBotRevealJobs()).toEqual([]);
  // one parked for a later time by another write is read again when its time comes
  put({ cursor: "", status: "pending", retryAt: T0 + 9000 });
  (reveal as any).resetRevealScan(); for (let i = 0; i < 3; i++) reveal.pendingBotRevealJobs();
  vi.setSystemTime(T0 + 10_000);
  expect(reveal.pendingBotRevealJobs()).toEqual([a]);
});

it("thousands of due, eligible receipts: each visit reads at most 64 of them, never all", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.now(), db = database(), scope = ensureScope("bot", "moss");
  const first = seed(2000, "assistant") - 1999;
  db.exec("BEGIN");
  const put = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?)");
  for (let i = 0; i < 2000; i++) put.run(`reveal-capture:j${first + i}`, scope, JSON.stringify({ cursor: "", status: "pending", retryAt: T0 - 1, reason: "reveal-learning-disabled-or-cancelled", attempts: 1 }));
  db.exec("COMMIT");
  // Count runs of the receipt read, not prepares.
  const real = db.prepare.bind(db); let reads = 0;
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    if (sql !== "SELECT intent FROM memory_scope_bindings WHERE id=?") return statement;
    return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key); return key === "get" ? (...args: unknown[]) => { reads++; return (value as Function).apply(target, args); } : typeof value === "function" ? value.bind(target) : value; } });
  };
  try {
    for (let tick = 0; tick < 3; tick++) { vi.setSystemTime(T0 + 1000 * tick); reveal.pendingBotRevealJobs(); }   // load the receipts into memory
    const before = reads;
    for (let tick = 3; tick < 63; tick++) {
      vi.setSystemTime(T0 + 1000 * tick);
      for (let call = 0; call < 5; call++) expect(reveal.pendingBotRevealJobs().length).toBeLessThanOrEqual(1);   // handed out, never settled: still due
    }
    expect(reads - before).toBeLessThanOrEqual(60 * 64);   // was 2,000 reads per sweep
  } finally { (db as any).prepare = real; }
});
