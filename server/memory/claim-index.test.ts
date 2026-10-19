// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { CLAIM_INDEX_SQL, compareScope, memoryClaimIndex, RECONCILE_INTERVAL_MS, RECONCILE_STEP_MS, SCAN_CHUNK, SYNC_CHUNKS_PER_CALL } from "./claim-index.ts";
import { reopenParkedThreadJobs } from "./park.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const NOW = 1_000_000;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); jobs.resetMemoryClaimCursor(); database().exec("PRAGMA synchronous=OFF"); });
afterEach(() => { vi.restoreAllMocks(); });

function seed(count: number, scopes: number, from = 0) {
  const db = database();
  db.exec("BEGIN");
  for (let s = 0; s < scopes; s++) db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(`scope-${String(s).padStart(3, "0")}`, `owner-${s}`);
  for (let i = from; i < from + count; i++) {
    const scope = `scope-${String((i * 7) % scopes).padStart(3, "0")}`;
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${i}`, scope, `thread-${i % 50}`, `m${i}`, null, `h${i}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `job ${i}` }), 1);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)")
      .run(`job-${String(i).padStart(6, "0")}`, `src-${i}`);
  }
  db.exec("COMMIT");
}

/** Let the chunked first build finish (it continues on later turns of the event loop). */
async function settled() { for (let n = 0; n < 10_000 && memoryClaimIndex.warming; n++) await new Promise(resolve => setImmediate(resolve)); }
/** One job in a named scope, with its own source. */
function job(id: number, scope: string, status = "pending") {
  const db = database();
  db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(scope, `owner-${scope}`);
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,'text','owner','recorded',NULL,'active')").run(`src-${id}`, scope, `thread-${scope}`, `m${id}`, null, `h${id}`);
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${id}`, `h${id}`, JSON.stringify({ text: `job ${id}` }), 1);
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1',?,0,0,0,0,0)")
    .run(`job-${String(id).padStart(6, "0")}`, `src-${id}`, status);
}

/** Statements prepared while `work` runs (the index caches its own, so count its row checks separately). */
function sqlDuring<T>(work: () => T): { result: T; sql: string[]; checks: number; scanned: number } {
  const db = database(), sql: string[] = [], real = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(((text: string) => { sql.push(text); return real(text); }) as typeof db.prepare);
  const checks = memoryClaimIndex.stats.checks, scanned = memoryClaimIndex.stats.scanned;
  try { return { result: work(), sql, checks: memoryClaimIndex.stats.checks - checks, scanned: memoryClaimIndex.stats.scanned - scanned }; }
  finally { spy.mockRestore(); }
}

describe("memory claim index (A10)", () => {
  it("claims in O(1): after the first claim, one candidate check and no aggregate over the backlog, at 200 or 20,000 jobs", { tags: ["perf-budget"] }, async () => {
    for (const backlog of [200, 20_000]) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); jobs.resetMemoryClaimCursor();
      database().exec("PRAGMA synchronous=OFF");
      seed(backlog, 40);
      expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull(); // starts the build (chunked: the rest on later turns of the loop)
      await settled();
      for (let n = 0; n < 50; n++) {
        const { result, sql, checks, scanned } = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
        expect(result).not.toBeNull();
        expect(checks).toBe(1);
        expect(scanned).toBe(0);
        expect(sql).not.toContain(jobs.MEMORY_CLAIM_SQL.scope);
        expect(sql).not.toContain(jobs.MEMORY_CLAIM_SQL.head);
      }
    }
  });

  it("picks up jobs written after the index was built by reading only the new rows", () => {
    seed(500, 5);
    jobs.claimMemoryJob("w", NOW);
    seed(3, 5, 500);
    const { scanned } = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(scanned).toBe(3);
    const claimed = new Set<string>();
    for (let w = jobs.claimMemoryJob("w", NOW); w; w = jobs.claimMemoryJob("w", NOW)) claimed.add(w.id);
    expect(claimed.has("job-000500") && claimed.has("job-000502")).toBe(true);
    expect(claimed.size).toBe(503 - 2);
  });

  it("a stale entry is re-checked, never trusted: a job completed behind the index is not claimed", () => {
    seed(30, 3);
    jobs.claimMemoryJob("w", NOW);
    database().exec("UPDATE memory_jobs SET status='complete' WHERE id IN ('job-000001','job-000002')");
    const ids: string[] = [];
    for (let w = jobs.claimMemoryJob("w", NOW); w; w = jobs.claimMemoryJob("w", NOW)) ids.push(w.id);
    expect(ids).not.toContain("job-000001");
    expect(ids).not.toContain("job-000002");
    expect(ids.length).toBe(27);
  });

  it("finds a job reopened behind the index through the fallback, and rebuilds", () => {
    seed(12, 2);
    database().exec("UPDATE memory_jobs SET status='deferred',retry_at=" + (NOW + 3_600_000) + " WHERE id='job-000004'");
    const ids: string[] = [];
    for (let w = jobs.claimMemoryJob("w", NOW); w; w = jobs.claimMemoryJob("w", NOW)) ids.push(w.id);
    expect(ids).not.toContain("job-000004");
    // A park reopen or a restore makes it due now, with no hint to the index.
    database().exec("UPDATE memory_jobs SET retry_at=0 WHERE id='job-000004'");
    const rebuilds = memoryClaimIndex.stats.rebuilds;
    expect(jobs.claimMemoryJob("w", NOW)?.id).toBe("job-000004");
    expect(jobs.claimMemoryJob("w", NOW)).toBeNull();
    // the miss marked the index stale: the next claim that reaches it rebuilds it from the table
    seed(1, 2, 12);
    expect(jobs.claimMemoryJob("w", NOW)?.id).toBe("job-000012");
    expect(memoryClaimIndex.stats.rebuilds).toBe(rebuilds + 1);
  });

  it("a stale requeue is claimable again at once (the hint refiles it), with its lease generation fenced", () => {
    seed(4, 1);
    const first = jobs.claimMemoryJob("w", NOW)!;
    expect(jobs.requeueStaleMemoryWork(first, "w")).toBe(true);
    const { result, sql } = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(result?.id).toBe(first.id);
    expect(result!.leaseGeneration).toBe(first.leaseGeneration + 1);
    expect(sql).not.toContain(jobs.MEMORY_CLAIM_SQL.scope);
  });

  it("compares scope ids the way SQLite's BINARY collation does", () => {
    expect(compareScope("a", "b")).toBeLessThan(0);
    expect(compareScope("Z", "a")).toBeLessThan(0);
    // U+FF5E (3 UTF-8 bytes) sorts before U+1F600 (4 bytes, a surrogate pair in UTF-16, which JS would put first)
    expect(compareScope("～", "\u{1f600}")).toBeLessThan(0);
  });
  // Review finding 6: the scan used memory_jobs_pending plus a temporary sort over every open job, on every claim.
  it("reads the table only by bounded rowid ranges: no status index, no sort, the cursor past every examined row", async () => {
    const plan = database().prepare(`EXPLAIN QUERY PLAN ${CLAIM_INDEX_SQL.scan}`).all(0n, 100n).map(row => String(row.detail)).join(" | ");
    expect(plan).not.toContain("memory_jobs_pending");
    expect(plan).not.toContain("TEMP B-TREE");
    expect(plan).toMatch(/SCAN j|SEARCH j USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    // 9,000 finished jobs, then 3 open ones: after the build, a claim with nothing new examines nothing
    seed(9_003, 3);
    database().exec("UPDATE memory_jobs SET status='complete' WHERE rowid<=9000");
    jobs.claimMemoryJob("w", NOW);
    await settled();
    const examined = memoryClaimIndex.stats.examined;
    expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull();
    expect(memoryClaimIndex.stats.examined).toBe(examined);
  });

  it("at 100,000 jobs: the first build is chunked (no step over 50 ms) and a claim costs under 1 ms", async () => {
    seed(100_000, 40);
    const steps: number[] = [];
    const real = (memoryClaimIndex as unknown as { buildStep: (db: unknown) => boolean });
    const buildStep = real.buildStep.bind(memoryClaimIndex);
    // A step is a fixed 4096-row rowid range, so its work is bounded by rows, not by time. Wall time also counts the
    // moments a loaded host (parallel suite shards) takes the core away from the process, which is not the product's
    // step. Measure the process's own CPU time (user+system) per step instead; the 50 ms bound is unchanged.
    const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    const spy = vi.spyOn(real, "buildStep").mockImplementation((db: unknown) => { const t = cpuMs(); try { return buildStep(db); } finally { steps.push(cpuMs() - t); } });
    const t0 = performance.now();
    jobs.claimMemoryJob("w", NOW); // served by the SQL fallback while the build runs
    await settled();
    const buildWall = performance.now() - t0;
    spy.mockRestore();
    expect(steps.length).toBeGreaterThanOrEqual(Math.floor(100_000 / SCAN_CHUNK));
    let selectMs = 0;
    const next = memoryClaimIndex.next.bind(memoryClaimIndex);
    const selectSpy = vi.spyOn(memoryClaimIndex, "next").mockImplementation((...args) => { const t = performance.now(); try { return next(...args); } finally { selectMs += performance.now() - t; } });
    const t1 = performance.now();
    const claims = 500;
    for (let n = 0; n < claims; n++) expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull();
    const perClaim = (performance.now() - t1) / claims;
    selectSpy.mockRestore();
    console.log(`[claim-index 100k] build steps=${steps.length} maxStepMs=${Math.max(...steps).toFixed(1)} sumStepMs=${steps.reduce((a, b) => a + b, 0).toFixed(1)} buildWallMs=${buildWall.toFixed(1)} perSelectionMs=${(selectMs / claims).toFixed(3)} perWholeClaimMs=${perClaim.toFixed(3)}`);
    expect(Math.max(...steps)).toBeLessThan(50);
    expect(selectMs / claims).toBeLessThan(1);
  }, 120_000);

  // Review finding 5: a job reopened behind the index (no hint) was found only when the index ran dry, so a
  // continuously fed scope kept another scope's reopened job waiting indefinitely.
  it("a job reopened behind the index is found by the timed reconcile while another scope never runs dry", async () => {
    let id = 0;
    job(id++, "scope-b", "cancelled"); // parked: not filed
    for (let n = 0; n < 5; n++) job(id++, "scope-a");
    jobs.claimMemoryJob("w", NOW);
    await settled();
    database().exec("UPDATE memory_jobs SET status='pending' WHERE id='job-000000'"); // reopened, no hint
    let clock = performance.now();
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const claimed: string[] = [];
      for (let round = 0; round < 20 && !claimed.includes("job-000000"); round++) {
        job(id++, "scope-a"); // scope a never runs dry
        clock += RECONCILE_INTERVAL_MS / 4;
        const work = jobs.claimMemoryJob("w", NOW);
        if (work) claimed.push(work.id);
      }
      expect(claimed).toContain("job-000000");
    } finally { spy.mockRestore(); }
  });

  it("a reopen reported by its writer is swept for at once", async () => {
    let id = 0;
    job(id++, "scope-b", "cancelled");
    for (let n = 0; n < 5; n++) job(id++, "scope-a");
    jobs.claimMemoryJob("w", NOW);
    await settled();
    database().exec("UPDATE memory_jobs SET status='pending' WHERE id='job-000000'");
    memoryClaimIndex.reopened();
    job(id++, "scope-a");
    const claimed = [jobs.claimMemoryJob("w", NOW)?.id, jobs.claimMemoryJob("w", NOW)?.id];
    expect(claimed).toContain("job-000000");
  });

  // Round 2 P2-B: every reopen notification restarted the sweep from the start, so with another scope always
  // claimable a reopened job above the first few chunks was never found.
  it("reopen notifications every ten seconds do not restart a running sweep: the reopened job is found", async () => {
    seed(60_000, 1);
    database().exec("UPDATE memory_jobs SET status='cancelled'");
    let id = 100_000;
    job(id++, "scope-a");
    job(id++, "scope-b", "cancelled"); // the parked job: high in the table, filed nowhere
    const reopenedId = `job-${String(id - 1).padStart(6, "0")}`;
    jobs.claimMemoryJob("w", NOW);
    await settled();
    database().prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(reopenedId); // reopened, no hint
    let clock = performance.now();
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const claimed: string[] = [];
      for (let round = 0; round < 100 && !claimed.includes(reopenedId); round++) {
        job(id++, "scope-a");
        clock += RECONCILE_STEP_MS;
        if (round % 10 === 0) memoryClaimIndex.reopened(); // another thread's branch change, every ten seconds
        const work = jobs.claimMemoryJob("w", NOW);
        if (work) claimed.push(work.id);
      }
      expect(claimed).toContain(reopenedId);
    } finally { spy.mockRestore(); }
  }, 60_000);

  it("a thread's reopened jobs are filed directly, not left to the sweep", async () => {
    let id = 0;
    for (let n = 0; n < 3; n++) job(id++, "scope-a");
    job(id++, "scope-b");
    jobs.claimMemoryJob("w", NOW); await settled();
    const db = database();
    db.prepare("UPDATE memory_sources SET state='retired' WHERE scope_id='scope-b'").run();
    db.prepare("UPDATE memory_jobs SET status='cancelled',error='parked:v1:'||json_object('s','pending','e',NULL) WHERE source_id IN (SELECT id FROM memory_sources WHERE scope_id='scope-b')").run();
    const threadId = String(db.prepare("SELECT thread_id AS t FROM memory_sources WHERE scope_id='scope-b'").get()!.t);
    jobs.claimMemoryJob("w", NOW); jobs.claimMemoryJob("w", NOW); // round robin meets scope-b's parked job and drops it
    db.prepare("UPDATE memory_sources SET state='active' WHERE scope_id='scope-b'").run();
    const before = memoryClaimIndex.size().ready;
    expect(reopenParkedThreadJobs(db, threadId)).toBe(1);
    expect(memoryClaimIndex.size().ready).toBe(before + 1); // filed by the hint, before any sweep step ran
  });

  // Round 2 P2-C: the loop over every newly appended range was one synchronous block (778 ms at +1M jobs).
  it("a large append after the build is read a few chunks per call and the rest on later turns", async () => {
    seed(2_000, 10);
    jobs.claimMemoryJob("w", NOW); await settled();
    seed(120_000, 10, 2_000);
    const examined = memoryClaimIndex.stats.examined;
    const { result, sql } = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(result).not.toBeNull(); // served from what the index holds
    expect(memoryClaimIndex.stats.examined - examined).toBeLessThanOrEqual((SYNC_CHUNKS_PER_CALL + 1) * SCAN_CHUNK);
    // no aggregate over every open job was asked for while the index caught up
    expect(sql.filter(text => /min\(|group by/i.test(text))).toEqual([]);
    expect(memoryClaimIndex.warming).toBe(true);
    await settled();
    expect(memoryClaimIndex.warming).toBe(false);
    expect(memoryClaimIndex.size().ready + memoryClaimIndex.size().waiting).toBeGreaterThanOrEqual(120_000);
  }, 120_000);

  it("while the first build runs the claim is chosen from the rows read so far, with no SQL aggregate", async () => {
    seed(30_000, 10);
    const { result, sql } = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(result).not.toBeNull();
    expect(memoryClaimIndex.warming).toBe(true);
    expect(sql.filter(text => /min\(|group by/i.test(text))).toEqual([]);
    await settled();
  }, 60_000);
});

describe("memory claim index: warming never runs the aggregate fallback (round-3 P2)", () => {
  it("50,000 finished rows then 200,000 pending: the first claim returns a pending job within a bounded step and runs no aggregate SQL", { tags: ["perf-budget"], timeout: 60_000 }, () => {
    const db = database();
    db.exec("BEGIN");
    db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES('scope-a','conversation','owner-a','[]',0)").run();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<249999)
      INSERT INTO memory_sources SELECT 'src-'||i,'scope-a','thread-a','m'||i,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<249999)
      INSERT INTO memory_source_versions SELECT 'src-'||i,1,'h'||i,'{"text":"x"}',1 FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<249999)
      INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch)
      SELECT 'job-'||printf('%06d',i),'src-'||i,1,'capture','1',CASE WHEN i<50000 THEN 'complete' ELSE 'pending' END,0,0,0,0,0 FROM n`);
    db.exec("COMMIT");
    jobs.invalidateMemoryClaimIndex();
    const started = performance.now();
    const { result, sql } = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    const elapsed = performance.now() - started;
    expect(sql).not.toContain(jobs.MEMORY_CLAIM_SQL.scope);
    expect(sql).not.toContain(jobs.MEMORY_CLAIM_SQL.head);
    expect(elapsed).toBeLessThan(50 + 40); // one bounded step; headroom for the lease write
    expect(result).not.toBeNull();
    expect(result!.id >= "job-050000").toBe(true);
  });
});

describe("blocked jobs met by a selection are closed out in its transaction", () => {
  it("a working job is settled by the index's verdict (not skipped over again), at most one statement for its kind", () => {
    job(0, "scope-a"); job(1, "scope-a"); job(2, "scope-a");
    database().exec("UPDATE memory_sources SET outcome='working' WHERE id IN ('src-0','src-1')");
    const first = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(first.result?.id).toBe("job-000002");
    expect(database().prepare("SELECT id,status,error FROM memory_jobs WHERE id IN ('job-000000','job-000001') ORDER BY id").all())
      .toEqual([{ id: "job-000000", status: "cancelled", error: "settled:working" }, { id: "job-000001", status: "cancelled", error: "settled:working" }]);
    // the next claim does not meet them again
    job(3, "scope-a");
    const second = sqlDuring(() => jobs.claimMemoryJob("w", NOW));
    expect(second.result?.id).toBe("job-000003");
    expect(second.checks).toBeLessThanOrEqual(1);
  });
});

