// SPDX-License-Identifier: AGPL-3.0-or-later
// Blocked jobs leave the open statuses (CLAIM-REDESIGN.md, CLAIM-DESIGN-FABLE.md): tests T1-T7, T9, T10 and T13. T8 is
// claim-wake.test.ts, T11 claim-deny-restart.test.ts, T12 claim-settle-downgrade.test.ts. Rows examined per statement are
// accounted by testing/claim-rows.ts (8.1); T7 asserts the plan each of its formulas rests on.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { CLAIM_INDEX_CHECK_LIMIT, CLAIM_INDEX_SQL, memoryClaimIndex, SCAN_CHUNK, SYNC_CHUNKS_PER_CALL } from "./claim-index.ts";
import { SETTLE_CATEGORIES, SETTLE_SQL, settleRows } from "./claim-settle.ts";
import { measure } from "./testing/claim-rows.ts";
import { captureSource } from "./capture.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { forgetTurnCaptureJob, turnCaptureJobId } from "./turn-capture-jobs.ts";
import { claimSettleSweepFinished, claimSettleSweepStep, parkMaintenancePending, parkMaintenanceStep, parkReconcileStep, parkRetiredThreadJobs, reopenParkedThreadJobs, resetClaimSettleSweep, resetParkReconcile, resetParkSweep, SETTLE_SWEEP_SQL } from "./park.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const NOW = 1_000_000;
const OPEN = "('pending','partial','deferred','leased')";
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture"); jobs.resetMemoryClaimCursor(); resetParkSweep(); resetClaimSettleSweep();
  database().exec("PRAGMA synchronous=OFF");
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.MURAGE_APP_VERSION; });

/** The most rows one claim examines on a file not yet swept (8.1, 4.5): the idle probe (open statuses, leases held), meta and roster;
 * the index's candidate checks and their settle (six statements over at most CLAIM_INDEX_CHECK_LIMIT rowids); the index's own
 * reading of the table (a build chunk or new rows, SYNC_CHUNKS_PER_CALL chunks at most); then per window the window statements
 * (CLAIM_WINDOW rows + 1 per statement), scope and head (6 per row + 1), and a settle (six statements: five at 3 per row + 1, the
 * `denied` one at 5 per row + 1, testing/claim-rows.ts); the row, payload and lease. (The design's formula counts one settle per
 * claim; a claim settles per window and after the index's checks.) */
const leasesHeld = 64;
const settleRowsOf = (n: number) => 5 * (3 * n + 1) + (5 * n + 1);
const ROWS_CEILING = (3 + leasesHeld + 1) + 2
  + CLAIM_INDEX_CHECK_LIMIT * 5 + settleRowsOf(CLAIM_INDEX_CHECK_LIMIT) + SYNC_CHUNKS_PER_CALL * SCAN_CHUNK * 2 + 2 * SYNC_CHUNKS_PER_CALL
  + jobs.CLAIM_MAX_WINDOWS * ((jobs.CLAIM_WINDOW + 8) + 2 * (6 * jobs.CLAIM_WINDOW + 1) + settleRowsOf(jobs.CLAIM_WINDOW)) + 8;
async function settled() { for (let n = 0; n < 10_000 && memoryClaimIndex.warming; n++) await new Promise(resolve => setImmediate(resolve)); }

interface Raw { id: string; scope?: string; thread?: string; state?: string; outcome?: string; kind?: string; status?: string; attempts?: number; lease?: number; retry?: number; sourceRevision?: number; error?: string | null }
/** One source with its version rows and one job, written directly (the shapes capture.ts no longer produces). */
function raw(r: Raw) {
  const db = database(), scope = r.scope ?? "scope-000", revision = r.sourceRevision ?? 1;
  db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(scope, `owner-${scope}`);
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)").run(`src-${r.id}`, scope, r.thread ?? `thread-${r.id}`, `m-${r.id}`, null, revision, `h-${r.id}`, r.kind ?? "text", "owner", r.outcome ?? "recorded", r.state ?? "active");
  for (const rev of new Set([1, revision])) db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run(`src-${r.id}`, rev, `h-${r.id}-${rev}`, JSON.stringify({ text: `${r.id} text` }), 1);
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch,error) VALUES(?,?,1,'capture','1',?,?,?,?,0,0,?)")
    .run(`job-${r.id}`, `src-${r.id}`, r.status ?? "pending", r.retry ?? 0, r.attempts ?? 0, r.lease ?? 0, r.error ?? null);
}
const job = (id: string) => database().prepare("SELECT status,error,attempts,lease_generation FROM memory_jobs WHERE id=?").get(`job-${id}`)!;
const denyThread = (thread: string) => database().prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,1,1)").run(thread);
const denyScope = (scope: string) => database().prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('scope',?,1,1)").run(scope);
const tombstone = (sourceId: string, revision: number | null) => database().prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,?,NULL,1,'owner-forget',1)").run(`tomb-${sourceId}-${revision}`, sourceId, revision);

/** `blocked` jobs whose sources are still working (a file written before blocked jobs left the open statuses), then `eligible`. */
function seedBlockedThenEligible(blocked: number, eligible: number, scope = "scope-000", from = 0) {
  const db = database();
  db.exec("BEGIN");
  db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(scope, `owner-${scope}`);
  for (let k = 0; k < blocked + eligible; k++) {
    const i = from + k;
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,?,?,?,NULL,?)").run(`src-${i}`, scope, `thread-${i % 50}`, `m${i}`, null, `h${i}`, "text", "owner", k < blocked ? "working" : "recorded", "active");
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `${i} x` }), 1);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)")
      .run(`job-${String(i).padStart(6, "0")}`, `src-${i}`);
  }
  db.exec("COMMIT");
}
const openBlocked = () => Number(database().prepare(`SELECT count(*) AS n FROM memory_jobs j LEFT JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
  WHERE j.status IN ${OPEN} AND (s.id IS NULL OR s.state!='active' OR s.outcome='working' OR (s.kind IN ('tool-outcome','activity') AND s.outcome='failed') OR j.attempts>=3
    OR EXISTS (SELECT 1 FROM memory_deny d WHERE (d.kind='thread' AND d.id=s.thread_id) OR (d.kind='scope' AND d.id=s.scope_id))
    OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=s.revision)))`).get()!.n);

const BOUNDS = [600, 6000, 18000];

describe("T1: working turns never sit in the open statuses, and a claim costs the same at 600, 6,000 and 18,000 of them", () => {
  it("is flat", async () => {
    const perB: Array<{ b: number; execs: number[]; checks: number[]; examined: number[]; rows: number[] }> = [];
    for (const b of BOUNDS) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      setMemoryMode("capture"); jobs.resetMemoryClaimCursor(); database().exec("PRAGMA synchronous=OFF");
      for (let i = 0; i < b; i++) recordMemorySettlement("thread", `turn-${i}`, "working");
      for (let i = 0; i < 3000; i++) captureSource(database(), { id: `text-${i}`, threadId: "thread", kind: "text", speaker: "owner", outcome: "recorded", text: `a note ${i}` });
      expect(Number(database().prepare(`SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.status IN ${OPEN} AND s.outcome='working'`).get()!.n)).toBe(0);
      expect(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled' AND error='settled:working'").get()!.n)).toBe(b);
      let first = jobs.claimMemoryJob("w", Date.now());
      for (let tries = 0; first === null && tries < 20; tries++) { await settled(); first = jobs.claimMemoryJob("w", Date.now()); }  // a first build may still be reading the table
      expect(first?.sourceId.startsWith("text-")).toBe(true);
      await settled();
      const execs: number[] = [], checks: number[] = [], examined: number[] = [], rows: number[] = [];
      for (let n = 0; n < 20; n++) {
        const before = memoryClaimIndex.stats.examined;
        const m = measure(() => jobs.claimMemoryJob("w", Date.now()));
        expect(m.result?.sourceId.startsWith("text-")).toBe(true);
        expect(m.unknown).toEqual([]);
        execs.push(m.sqls.length); checks.push(m.checks); examined.push(memoryClaimIndex.stats.examined - before); rows.push(m.total);
      }
      perB.push({ b, execs, checks, examined, rows });
    }
    for (const row of perB) { expect(Math.max(...row.checks)).toBeLessThanOrEqual(2); expect(row.examined.every(n => n === 0)).toBe(true); }
    expect(perB[1]!.execs).toEqual(perB[0]!.execs);
    expect(perB[2]!.execs).toEqual(perB[0]!.execs);
    // rows examined, statement by statement, are the same at every B
    expect(perB[1]!.rows).toEqual(perB[0]!.rows);
    expect(perB[2]!.rows).toEqual(perB[0]!.rows);
  }, 900_000);
});

describe("T2: a file written before the change (blocked jobs still open): per-claim cost is capped and the eligible job is reached", () => {
  for (const blocked of BOUNDS) {
    it(`${blocked} blocked ahead of 3000 eligible`, async () => {
      seedBlockedThenEligible(blocked, 3000);
      const ceiling = CLAIM_INDEX_CHECK_LIMIT + 5 + jobs.CLAIM_MAX_WINDOWS * 8 + 40;
      let calls = 0, first: string | null = null;
      while (first === null && calls < 60) {
        calls++;
        const m = measure(() => jobs.claimMemoryJob("w", NOW));
        expect(m.sqls.length).toBeLessThanOrEqual(ceiling);
        expect(m.unknown).toEqual([]);
        expect(m.total).toBeLessThanOrEqual(ROWS_CEILING);
        for (const text of m.sqls) if (/memory_jobs/.test(text) && /memory_sources/.test(text) && /min\(/.test(text)) expect([jobs.MEMORY_CLAIM_SQL.scope, jobs.MEMORY_CLAIM_SQL.head], text).toContain(text);
        if (m.result) first = m.result.sourceId;
      }
      expect(first).not.toBeNull();
      expect(Number(first!.slice(4))).toBeGreaterThanOrEqual(blocked);
      expect(calls).toBeLessThanOrEqual(Math.ceil(blocked / 1536) + 1);
      expect(openBlocked()).toBe(0);
      await settled();
      const costs: number[] = [];
      const rows: number[] = [];
      for (let n = 0; n < 20; n++) { const m = measure(() => jobs.claimMemoryJob("w", NOW)); expect(m.result).not.toBeNull(); expect(m.unknown).toEqual([]); costs.push(m.sqls.length); rows.push(m.total); }
      expect(Math.max(...costs)).toBeLessThanOrEqual(60);
      // then flat: no claim reads more than the warm path's checks and probes (no window, no settle)
      expect(Math.max(...rows)).toBeLessThanOrEqual((3 + leasesHeld + 1) + 2 + 2 * 5 + settleRowsOf(2) + 2 * SYNC_CHUNKS_PER_CALL + 8);
    }, 300_000);

    it(`${blocked} blocked, settle sweep run first: the first claim is eligible and as cheap as T1's`, async () => {
      seedBlockedThenEligible(blocked, 3000);
      let steps = 0;
      while (!claimSettleSweepStep(database(), () => {}, NOW).done) steps++;
      expect(steps).toBeLessThanOrEqual(Math.ceil((blocked + 3000) / 500) + 1);
      expect(openBlocked()).toBe(0);
      expect(claimSettleSweepFinished()).toBe(true);
      const first = jobs.claimMemoryJob("w", NOW);
      expect(Number(first!.sourceId.slice(4))).toBeGreaterThanOrEqual(blocked);
      await settled();
      for (let n = 0; n < 5; n++) { const m = measure(() => jobs.claimMemoryJob("w", NOW)); expect(m.result).not.toBeNull(); expect(m.checks).toBeLessThanOrEqual(2); expect(m.sqls.length).toBeLessThanOrEqual(60); expect(m.unknown).toEqual([]); expect(m.total).toBeLessThanOrEqual(ROWS_CEILING); }
    }, 300_000);
  }
});

/** Blocked rows the window statements used to filter before their LIMIT (review P2 #3): `attempts=3` rows; tied retry_at and expired
 * leases. The claim index never files a capped row (its scan reads attempts<3), so `working` rows the index does file come first
 * and spend its check budget: the claim then reads the windows, which is the path under test. */
function seedCapped(working: number, blocked: number, eligible: number, shape: "capped" | "tied-leases") {
  const db = database();
  db.exec("BEGIN");
  db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES('scope-000','conversation','owner','[]',0)").run();
  for (let i = 0; i < working + blocked + eligible; i++) {
    const isBlocked = i >= working && i < working + blocked;
    db.prepare("INSERT INTO memory_sources VALUES(?,'scope-000',?,?,NULL,1,?,'text','owner',?,NULL,'active')").run(`src-${i}`, `thread-${i % 50}`, `m${i}`, `h${i}`, i < working ? "working" : "recorded");
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `${i} x` }));
    const status = shape === "tied-leases" && isBlocked && i % 2 ? "leased" : "pending";
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1',?,?,?,?,0,0)")
      .run(`job-${String(i).padStart(6, "0")}`, `src-${i}`, status, shape === "tied-leases" ? 5 : 0, isBlocked ? 3 : 0, status === "leased" ? NOW - 1 : 0);
  }
  db.exec("COMMIT");
}
describe("T2b: blocked rows the windows used to filter (attempts at the cap, tied retry_at, expired leases) cost rows returned, and the first claim settles them", () => {
  for (const shape of ["capped", "tied-leases"] as const) {
    it(shape, () => {
      seedCapped(600, 400, 10, shape);
      const m = measure(() => jobs.claimMemoryJob("w", NOW));
      expect(m.unknown).toEqual([]);
      expect(m.result!.id >= "job-001000").toBe(true);
      const windows = new Set<string>([jobs.MEMORY_CLAIM_SQL.window, jobs.MEMORY_CLAIM_SQL.windowTied, jobs.MEMORY_CLAIM_SQL.windowLater]);
      let windowStatements = 0;
      m.sqls.forEach((sql, at) => { if (windows.has(sql)) { windowStatements++; expect(m.rows[at]).toBe(m.returned[at]! + 1); } });
      expect(windowStatements).toBeGreaterThan(0);
      expect(m.total).toBeLessThanOrEqual(ROWS_CEILING);
      expect(openBlocked()).toBe(0);
      expect(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='failed' AND attempts=3").get()!.n)).toBe(400);
      expect(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled' AND error='settled:working'").get()!.n)).toBe(600);
    });
  }
});

describe("T3: no starvation", () => {
  it("scope A (18,000 blocked, then 5 eligible) and scope B (5,000 eligible) alternate once A is reachable; a reopened job is not passed by any position", () => {
    // a job at the very front of the open range, parked at once (a retired source), reopened after a hundred claims
    raw({ id: "front", scope: "scope-a", thread: "front-thread", state: "retired" });
    parkRetiredThreadJobs(database(), "front-thread");
    expect(job("front").status).toBe("cancelled");
    seedBlockedThenEligible(18_000, 5, "scope-a", 0);
    seedBlockedThenEligible(0, 5000, "scope-b", 100_000);
    const scopeOf = (sourceId: string) => String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(sourceId)!.scope_id);
    let calls = 0; const order: string[] = [];
    while (order.length < 10 && calls < 60) { calls++; const w = jobs.claimMemoryJob("w", NOW); if (w) order.push(scopeOf(w.sourceId)); }
    expect(order).toEqual(["scope-a", "scope-b", "scope-a", "scope-b", "scope-a", "scope-b", "scope-a", "scope-b", "scope-a", "scope-b"]);
    expect(calls).toBeLessThanOrEqual(Math.ceil(18_000 / 1536) + 1 + 9);
    // a hundred claims later the parked job at the front becomes claimable (a branch reactivation)
    for (let n = 0; n < 100; n++) expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull();
    database().prepare("UPDATE memory_sources SET state='active' WHERE id='src-front'").run();
    expect(reopenParkedThreadJobs(database(), "front-thread")).toBe(1);
    const next = [jobs.claimMemoryJob("w", NOW)!.sourceId, jobs.claimMemoryJob("w", NOW)!.sourceId];
    expect(next).toContain("src-front");
  }, 300_000);
});

describe("T4: settling, one test per category", () => {
  const all = () => settleRows(database(), database().prepare("SELECT rowid AS r FROM memory_jobs").all().map(r => r.r as number), NOW);
  function untouched(ids: string[]) { return ids.map(id => JSON.stringify(job(id))); }
  it("superseded and deleted sources close the job as cancelled", () => {
    raw({ id: "ok" }); raw({ id: "sup", sourceRevision: 2 }); raw({ id: "del", state: "deleted" });
    const before = untouched(["ok"]);
    all();
    expect(job("sup")).toMatchObject({ status: "cancelled", error: "settled:superseded", lease_generation: 1 });
    expect(job("del")).toMatchObject({ status: "cancelled", error: "settled:superseded" });
    expect(untouched(["ok"])).toEqual(before);
  });
  it("a working source closes the job as cancelled", () => {
    raw({ id: "ok" }); raw({ id: "w", outcome: "working", status: "partial" });
    all();
    expect(job("w")).toMatchObject({ status: "cancelled", error: "settled:working" });
    expect(job("ok").status).toBe("pending");
  });
  it("a failed tool outcome or activity completes the job", () => {
    raw({ id: "ok" }); raw({ id: "t", kind: "tool-outcome", outcome: "failed" }); raw({ id: "a", kind: "activity", outcome: "failed", status: "deferred", retry: NOW + 9999 }); raw({ id: "good", kind: "tool-outcome", outcome: "completed" });
    all();
    expect(job("t").status).toBe("complete"); expect(job("a").status).toBe("complete");
    expect(job("good").status).toBe("pending"); expect(job("ok").status).toBe("pending");
  });
  it("attempts at the cap close the job as failed", () => {
    raw({ id: "ok" }); raw({ id: "x", attempts: 3, status: "deferred" });
    all();
    expect(job("x").status).toBe("failed"); expect(job("ok").status).toBe("pending");
  });
  it("a retired source parks the job, and a branch reactivation reopens it with its old status and error", () => {
    raw({ id: "ok" }); raw({ id: "r", state: "retired", status: "partial", error: "some reason", thread: "branch-thread" });
    all();
    expect(job("r").status).toBe("cancelled"); expect(String(job("r").error)).toMatch(/^parked:v1:/);
    expect(job("ok").status).toBe("pending");
    database().prepare("UPDATE memory_sources SET state='active' WHERE id='src-r'").run();
    expect(reopenParkedThreadJobs(database(), "branch-thread")).toBe(1);
    expect(job("r")).toMatchObject({ status: "partial", error: "some reason" });
  });
  it("a live lease is never settled; an expired one is", () => {
    raw({ id: "live", outcome: "working", status: "leased", lease: NOW + 10_000 }); raw({ id: "dead", outcome: "working", status: "leased", lease: NOW - 1 });
    all();
    expect(job("live").status).toBe("leased");
    expect(job("dead")).toMatchObject({ status: "cancelled", error: "settled:working" });
  });
  it("a deleted conversation or scope, or a source tombstoned at its revision, closes the job as cancelled (denied); a tombstone of another revision does not", () => {
    raw({ id: "ok" }); raw({ id: "td", thread: "dead-thread" }); raw({ id: "sd", scope: "dead-scope", status: "deferred", retry: NOW + 9999 });
    raw({ id: "tb" }); raw({ id: "tb-null", status: "partial" }); raw({ id: "tb-other" });
    denyThread("dead-thread"); denyScope("dead-scope");
    tombstone("src-tb", 1); tombstone("src-tb-null", null); tombstone("src-tb-other", 2);
    const before = untouched(["ok", "tb-other"]);
    all();
    for (const id of ["td", "sd", "tb", "tb-null"]) expect(job(id), id).toMatchObject({ status: "cancelled", error: "settled:denied" });
    expect(untouched(["ok", "tb-other"])).toEqual(before);
  });
  it("a retired source in a deleted conversation is cancelled, not parked, and a branch reactivation never reopens it", () => {
    raw({ id: "rd", thread: "dead-branch", state: "retired", status: "partial" });
    denyThread("dead-branch");
    all();
    expect(job("rd")).toMatchObject({ status: "cancelled", error: "settled:denied" });
    database().prepare("UPDATE memory_sources SET state='active' WHERE id='src-rd'").run();
    expect(reopenParkedThreadJobs(database(), "dead-branch")).toBe(0);
  });
  it("a parked job whose conversation was deleted since is not reopened by reactivation or the reconciliation", () => {
    raw({ id: "p", thread: "later-dead", state: "retired", status: "pending" });
    all();
    expect(String(job("p").error)).toMatch(/^parked:v1:/);
    denyThread("later-dead");
    database().prepare("UPDATE memory_sources SET state='active' WHERE id='src-p'").run();
    expect(reopenParkedThreadJobs(database(), "later-dead")).toBe(0);
    expect(reopenParkedThreadJobs(database(), "later-dead", ["m-p"])).toBe(0);
    resetParkReconcile(); while (!parkReconcileStep(database(), () => {}).done) { /* one pass */ }
    expect(job("p").status).toBe("cancelled");
  });
  it("the claim index's verdict settles a denied job it meets (denied, not skipped), and the claim takes the next one", () => {
    raw({ id: "a-den", thread: "dead-thread" }); raw({ id: "b-ok" });
    denyThread("dead-thread");
    expect(jobs.claimMemoryJob("w", NOW)?.id).toBe("job-b-ok");
    expect(job("a-den")).toMatchObject({ status: "cancelled", error: "settled:denied" });
  });
  it("only the rows asked for change, and at most six statements run whatever the number of rows", () => {
    for (let i = 0; i < 300; i++) raw({ id: `b${i}`, outcome: "working" });
    raw({ id: "keep" });
    const rids = database().prepare("SELECT rowid AS r FROM memory_jobs WHERE id!='job-keep'").all().map(r => r.r as number);
    const m = measure(() => settleRows(database(), rids, NOW));
    expect(SETTLE_CATEGORIES).toEqual(["superseded", "denied", "working", "tool", "attempts", "retired"]);
    expect(m.sqls.length).toBeLessThanOrEqual(6);
    expect(m.unknown).toEqual([]);
    expect(Math.max(...m.rows)).toBe(300 * 5 + 1);  // the `denied` statement's seeks; the other five count 3 per row
    expect(m.result).toHaveLength(300);
    expect(job("keep").status).toBe("pending");
  });
});

describe("T5: the settle sweep is bounded and resumable", () => {
  it("20,000 open rows of every blocked category: one marker, killed and resumed, nothing settled twice", () => {
    const db = database();
    db.exec("BEGIN");
    const statuses = ["pending", "partial", "deferred", "leased"];
    let blocked = 0;
    denyThread("denied-thread");
    for (let i = 0; i < 20_000; i++) {
      const c = i % 8, status = statuses[i % 4]!;
      const r: Raw = { id: String(i), scope: `scope-${i % 5}`, status, retry: status === "deferred" ? NOW + 5000 * (i % 3) : 0 };
      if (c === 1) r.sourceRevision = 2; else if (c === 2) r.state = "deleted"; else if (c === 3) r.outcome = "working";
      else if (c === 4) { r.kind = "tool-outcome"; r.outcome = "failed"; } else if (c === 5) r.attempts = 3; else if (c === 6) r.state = "retired";
      else if (c === 7) r.thread = "denied-thread";
      if (c !== 0) blocked++;
      raw(r);
    }
    db.exec("COMMIT");
    expect(openBlocked()).toBe(blocked);
    const per: number[] = []; let total = 0, steps = 0;
    for (;;) {
      const m = measure(() => claimSettleSweepStep(database(), () => {}, NOW));
      steps++; per.push(m.result.settled); total += m.result.settled;
      expect(m.result.settled).toBeLessThanOrEqual(500);
      expect(m.sqls.filter(text => /^UPDATE memory_jobs/.test(text)).length).toBeLessThanOrEqual(6);
      expect(m.sqls.length).toBeLessThanOrEqual(6 + 8 + 4);
      if (m.result.done) break;
      if (steps === 7) { closeDatabase(); resetClaimSettleSweep(); database().exec("PRAGMA synchronous=OFF"); }  // the process ends and starts again
    }
    expect(total).toBe(blocked);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE error='settled:denied'").get()!.n)).toBe(20_000 / 8);
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(20_000 / 500));
    expect(openBlocked()).toBe(0);
    expect(JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-claim-settle-sweep'").get()!.intent)).done).toBe(true);
    expect(parkMaintenancePending()).toBe(true);  // the other passes still run; this one is done
    expect(claimSettleSweepFinished()).toBe(true);
    // a new app version runs it once more (a downgrade then an upgrade), and finds nothing
    process.env.MURAGE_APP_VERSION = "9.9.9"; resetClaimSettleSweep();
    let again = 0; while (!claimSettleSweepStep(database(), () => {}, NOW).done) again++;
    expect(again).toBeGreaterThan(0);
    expect(JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-claim-settle-sweep'").get()!.intent)).version).toBe("9.9.9");
  }, 300_000);

  it("1,000,000 finished jobs and 100 open ones finish in one step", () => {
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO memory_scopes VALUES('scope-000','conversation','owner','[]',0)").run();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<999999)
      INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) SELECT 'done-'||i,'gone-'||i,1,'capture','1','complete',0,0,0,0,0 FROM n`);
    for (let i = 0; i < 100; i++) raw({ id: `open${i}`, outcome: i % 2 ? "working" : "recorded" });
    const m = measure(() => claimSettleSweepStep(database(), () => {}, NOW));
    expect(m.result).toMatchObject({ done: true, settled: 50 });
    expect(m.sqls.length).toBeLessThanOrEqual(17);
  }, 300_000);

  it("is a step of the maintenance, after the park sweep", () => {
    raw({ id: "w", outcome: "working" });
    let guard = 0; while (!claimSettleSweepFinished() && guard++ < 10) parkMaintenanceStep(database());
    expect(job("w").status).toBe("cancelled");
  });
});

describe("T7: query plans: the access path each row formula of testing/claim-rows.ts counts", () => {
  const plan = (sql: string, ...params: unknown[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])).map(r => String(r.detail)).join(" | ");
  /** No scan of a table but the materialized rowid lists, the json lists and the uncorrelated ANY_DENY probe (it stops at its first row). */
  const noScan = (text: string, name: string) => {
    expect(text, name).not.toMatch(/TEMP B-TREE/);
    expect(text, name).not.toMatch(/memory_source_versions/);
    for (const step of text.split(" | ")) if (/^SCAN /.test(step)) expect(step, `${name}: ${text}`).toMatch(/^SCAN (c|r|n|json_each VIRTUAL TABLE.*|memory_deny|CONSTANT ROW)$/);
  };
  const probes = (text: string, name: string) => {
    expect(text, name).toMatch(/SEARCH j USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(text, name).toMatch(/SEARCH s USING INDEX sqlite_autoindex_memory_sources_1 \(id=\?\)/);
    expect(text, name).toMatch(/SEARCH dn USING PRIMARY KEY \(kind=\? AND id=\?\)/);
    expect(text, name).toMatch(/SEARCH t USING COVERING INDEX sqlite_autoindex_memory_tombstones_2 \(target_type=\? AND target_id=\?/);
  };
  it("every statement of the accounting table", () => {
    raw({ id: "x" }); denyThread("some-thread");
    const q = jobs.MEMORY_CLAIM_SQL;
    // windows: index columns and LIMIT only, covering, in index order (no sort)
    expect(plan(q.window, "pending", NOW, 256)).toMatch(/^SEARCH j USING COVERING INDEX memory_jobs_pending \(status=\? AND retry_at<\?\)$/);
    expect(plan(q.windowTied, "pending", 0, 0, NOW, 256)).toMatch(/^SEARCH j USING COVERING INDEX memory_jobs_pending \(status=\? AND retry_at=\? AND rowid>\?\)$/);
    expect(plan(q.windowLater, "pending", 0, 0, NOW, 256)).toMatch(/^SEARCH j USING COVERING INDEX memory_jobs_pending \(status=\? AND retry_at>\? AND retry_at<\?\)$/);
    for (const sql of [q.window, q.windowTied, q.windowLater]) { expect(sql).not.toMatch(/attempts|lease_until|memory_sources/); }
    // the idle probe: two index seeks, no source
    const anyOpen = plan(q.anyOpen, NOW, NOW);
    expect(anyOpen.match(/SEARCH j USING (COVERING )?INDEX memory_jobs_pending \(status=\? AND retry_at<\?\)/g)).toHaveLength(2);
    expect(anyOpen).not.toMatch(/memory_sources/); noScan(anyOpen, "anyOpen");
    const nextDue = plan(q.nextDue, NOW, NOW, NOW, NOW, NOW);
    expect(nextDue.match(/INDEX memory_jobs_pending \(status=\? AND retry_at>\?\)/g)).toHaveLength(3);
    expect(nextDue).toMatch(/INDEX memory_jobs_pending \(status=\?\)/); noScan(nextDue, "nextDue");
    expect(q.nextDue.split("UNION ALL SELECT min(")[0]).not.toMatch(/attempts/);
    // scope and head: the materialized window, a rowid probe, a source probe and the deny/tombstone seeks per row, once
    for (const [name, sql, params] of [["scope", q.scope, ["", '["1"]', NOW]], ["head", q.head, ['["1"]', "scope-000", NOW]]] as const) {
      const text = plan(sql, ...params);
      expect(text, name).toMatch(/MATERIALIZE r/); probes(text, name); noScan(text, name);
      expect(text.match(/SEARCH t USING/g), name).toHaveLength(1);
    }
    // the recent fallback: the newest rowids by the primary key (the one SCAN of memory_jobs allowed, inside its CTE), then probes
    const recent = plan(q.recentNewest, NOW, NOW, '["scope-000"]', null, "[]", 256);
    expect(recent).toMatch(/MATERIALIZE n \| SCAN memory_jobs \|/);
    expect(recent.replace("MATERIALIZE n | SCAN memory_jobs |", "")).not.toMatch(/SCAN memory_jobs/);
    probes(recent, "recentNewest"); expect(recent).not.toMatch(/TEMP B-TREE/);
    expect(q.recentNewest).toMatch(/ORDER BY rowid DESC LIMIT \?6/);
    for (const name of ["byId", "row"] as const) { const text = plan(q[name], ...(name === "row" ? [1] : [NOW, NOW, "job-x"])); noScan(text, name); }
    expect(plan(q.byId, NOW, NOW, "job-x")).toMatch(/SEARCH j USING INDEX sqlite_autoindex_memory_jobs_1 \(id=\?\)|SEARCH j USING INDEX \w+ \(id=\?\)/);
    expect(plan(q.row, 1)).toMatch(/SEARCH j USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(plan(q.payload, "src-x", 1, 1)).toMatch(/SEARCH memory_source_versions USING (INDEX|PRIMARY KEY|INTEGER PRIMARY KEY)[^|]*\(source_id=\? AND revision=\?\)/);
    // the index's candidate check: one rowid, its source and the seeks
    const check = plan(CLAIM_INDEX_SQL.check, 1);
    expect(check).toMatch(/SEARCH j USING INTEGER PRIMARY KEY \(rowid=\?\)/); expect(check).toMatch(/SEARCH s USING INDEX sqlite_autoindex_memory_sources_1 \(id=\?\)/);
    expect(check).toMatch(/SEARCH dn USING PRIMARY KEY/); expect(check).toMatch(/SEARCH t USING COVERING INDEX sqlite_autoindex_memory_tombstones_2/); noScan(check, "check");
    // the open walk (first build, reconcile): memory_jobs_pending in its own order, then the source by its key
    for (const [name, sql, params] of [["openFirst", CLAIM_INDEX_SQL.openFirst, ["pending", 8]], ["openTied", CLAIM_INDEX_SQL.openTied, ["pending", 0, 0, 8]], ["openLater", CLAIM_INDEX_SQL.openLater, ["pending", 0, 8]]] as const) {
      const text = plan(sql, ...params);
      expect(text, name).toMatch(/^SEARCH j USING INDEX memory_jobs_pending \(status=\?[^|]*\) \| SEARCH s USING INDEX sqlite_autoindex_memory_sources_1 \(id=\?\)( LEFT-JOIN)?$/); noScan(text, name);
    }
    // settles: by rowid only, then the source probe and (denied) the seeks
    for (const [name, sql] of Object.entries(SETTLE_SQL)) {
      const text = plan(sql, '["1"]', NOW);
      expect(text, name).toMatch(/SEARCH memory_jobs USING INTEGER PRIMARY KEY \(rowid=\?\)/);
      noScan(text, name);
    }
    expect(plan(SETTLE_SQL.denied, '["1"]', NOW)).toMatch(/SEARCH t USING COVERING INDEX sqlite_autoindex_memory_tombstones_2/);
    for (const [name, sql] of Object.entries(SETTLE_SWEEP_SQL)) { const text = plan(sql, ...["pending", 0, 0, 500].slice(0, (sql.match(/\?/g) ?? []).length)); expect(text, name).toMatch(/INDEX memory_jobs_pending/); noScan(text, name); }
  });
  it("the redrive and the reopen statements keep their access paths with the deny and tombstone terms", () => {
    raw({ id: "x" });
    const redrive = plan(jobs.REDRIVE_SQL, NOW, '["MEMORY_WORKER_EXITED"]', 10);
    expect(redrive).toMatch(/memory_jobs_pending \(status=\?/); expect(redrive).not.toMatch(/SCAN memory_jobs\b(?! USING)/);
  });
});

describe("T9: a starting turn claims its own prompt's capture first", () => {
  it("the working turn's job does not replace the prompt's as the thread's newest", () => {
    captureSource(database(), { id: "prompt", threadId: "thread", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text: "what is the plan" });
    const promptJob = turnCaptureJobId("thread");
    expect(promptJob).toBeDefined();
    recordMemorySettlement("thread", "t1", "working");
    expect(turnCaptureJobId("thread")).toBe(promptJob);
    const work = jobs.claimMemoryJob("w", Date.now(), undefined, { jobId: promptJob });
    expect(work?.sourceId).toBe("prompt");
    forgetTurnCaptureJob("thread", promptJob!);
  });
});

describe("T6: the recent-scopes fallback while the index is warming reads the newest rowids only", () => {
  it("finds the newest capture of the scope with at most CLAIM_WINDOW x 6 rows examined, and leaves out the turn's own messages", () => {
    seedBlockedThenEligible(0, 10_000, "scope-000");
    seedBlockedThenEligible(0, 50, "scope-b", 20_000);  // newer rows of another scope
    jobs.invalidateMemoryClaimIndex();  // the first build is chunked (SCAN_CHUNK rowids per claim): the index cannot answer yet
    const q = jobs.MEMORY_CLAIM_SQL;
    const first = measure(() => jobs.claimMemoryJob("w", NOW, ["scope-000"]));
    expect(memoryClaimIndex.warming).toBe(true);
    expect(first.result?.sourceId).toBe("src-9999");
    expect(first.unknown).toEqual([]);
    expect(first.sqls.filter(sql => sql === q.recentNewest)).toHaveLength(1);
    expect(first.rows[first.sqls.indexOf(q.recentNewest)]).toBeLessThanOrEqual(jobs.CLAIM_WINDOW * 6);
    // no aggregate over the open range is ever asked (the old recent/recentExcluding are gone)
    expect(first.sqls.filter(sql => /max\(j\.rowid\)/.test(sql) && sql !== q.recentNewest)).toEqual([]);
    const second = measure(() => jobs.claimMemoryJob("w", NOW, ["scope-000"], { exclude: { threadId: "thread-48", messageIds: ["m9998"] } }));
    expect(memoryClaimIndex.warming).toBe(true);
    expect(second.result?.sourceId).toBe("src-9997");
    expect(second.rows[second.sqls.indexOf(q.recentNewest)]).toBeLessThanOrEqual(jobs.CLAIM_WINDOW * 6);
  });
});

describe("T10: write paths", () => {
  it("a redrive leaves a failed job failed when its source is working, superseded, a failed tool, in a deleted conversation or scope, or tombstoned; parks a retired one; reopens an ordinary one", () => {
    raw({ id: "ret", state: "retired", status: "failed", error: "MEMORY_WORKER_EXITED", thread: "branch-thread" });
    raw({ id: "wor", outcome: "working", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "sup", sourceRevision: 2, status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "tool", kind: "tool-outcome", outcome: "failed", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "del", state: "deleted", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "dth", thread: "dead-thread", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "dsc", scope: "dead-scope", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "dret", thread: "dead-thread", state: "retired", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "tomb", status: "failed", error: "MEMORY_WORKER_EXITED" });
    raw({ id: "fine", status: "failed", error: "MEMORY_WORKER_EXITED" });
    denyThread("dead-thread"); denyScope("dead-scope"); tombstone("src-tomb", 1);
    expect(jobs.redriveTransientFailedJobs(1000, NOW)).toBe(2);
    for (const id of ["wor", "sup", "tool", "del", "dth", "dsc", "dret", "tomb"]) expect(job(id), id).toMatchObject({ status: "failed", error: "MEMORY_WORKER_EXITED" });
    expect(job("fine")).toMatchObject({ status: "pending", error: "redriven:MEMORY_WORKER_EXITED", attempts: 0 });
    expect(job("ret").status).toBe("cancelled");
    expect(JSON.parse(String(job("ret").error).slice("parked:v1:".length))).toEqual({ s: "pending", e: "redriven:MEMORY_WORKER_EXITED" });
    // the branch selected again: the job comes back already redriven (one attempt cycle, not a second redrive)
    database().prepare("UPDATE memory_sources SET state='active' WHERE id='src-ret'").run();
    expect(reopenParkedThreadJobs(database(), "branch-thread", ["m-ret"])).toBe(1);
    expect(job("ret")).toMatchObject({ status: "pending", error: "redriven:MEMORY_WORKER_EXITED", attempts: 0 });
    // a second restart redrives nothing
    expect(jobs.redriveTransientFailedJobs(1000, NOW)).toBe(0);
  });
  it("a working capture is born cancelled and settling the turn creates a pending job", () => {
    recordMemorySettlement("thread", "t1", "working");
    const id = "turn:thread:t1";
    expect(database().prepare("SELECT status,error FROM memory_jobs WHERE source_id=?").all(id)).toEqual([{ status: "cancelled", error: "settled:working" }]);
    recordMemorySettlement("thread", "t1", "completed");
    expect(database().prepare("SELECT source_revision AS r,status FROM memory_jobs WHERE source_id=? ORDER BY source_revision").all(id)).toEqual([{ r: 1, status: "cancelled" }, { r: 2, status: "pending" }]);
  });
});

describe("T13: reactivation after a restart", () => {
  it("a job failed by MEMORY_WORKER_EXITED on a branch the owner left runs once the branch is selected again", () => {
    raw({ id: "keep", thread: "bt" });
    raw({ id: "x", thread: "bt", status: "failed", error: "MEMORY_WORKER_EXITED" });
    // the branch is left (branch-change.ts retires the message's source and parks its open jobs; this one is already failed)
    database().prepare("UPDATE memory_sources SET state='retired' WHERE thread_id='bt' AND message_id IN ('m-x')").run();
    parkRetiredThreadJobs(database(), "bt", ["m-x"]);
    expect(job("x").status).toBe("failed");
    // a restart: new process state, the redrive at the worker's start parks it (its source is retired)
    closeDatabase(); jobs.resetMemoryClaimCursor(); resetClaimSettleSweep(); resetParkSweep(); database().exec("PRAGMA synchronous=OFF");
    expect(jobs.redriveTransientFailedJobs(1000, NOW)).toBe(1);
    expect(job("x").status).toBe("cancelled");
    expect(jobs.claimMemoryJob("w", NOW)?.id).toBe("job-keep");
    expect(jobs.claimMemoryJob("w", NOW)).toBeNull();
    // the branch is selected again (branch-change.ts:85: the sources go active, then reopenParkedThreadJobs for those messages)
    database().prepare("UPDATE memory_sources SET state='active' WHERE thread_id='bt' AND message_id IN ('m-x')").run();
    expect(reopenParkedThreadJobs(database(), "bt", ["m-x"])).toBe(1);
    const work = jobs.claimMemoryJob("w", NOW);
    expect(work?.id).toBe("job-x");
    expect(job("x")).toMatchObject({ status: "leased", error: "redriven:MEMORY_WORKER_EXITED" });
  });
});
