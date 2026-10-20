// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { CLAIM_INDEX_SQL, compareScope, memoryClaimIndex, RECONCILE_INTERVAL_MS, RECONCILE_STEP_MS, SCAN_CHUNK, SYNC_CHUNKS_PER_CALL } from "./claim-index.ts";
import { reopenParkedThreadJobs } from "./park.ts";
import { RID_BLOCK, RidList } from "./rid-list.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { windowsPerfBudget } from "../testing/windows-hosted.ts";

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
  it("reads new rows only by bounded rowid ranges: no status index, no sort, the cursor past every examined row", async () => {
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

  it("at 100,000 jobs: the first build is chunked (no step over 50 ms) and a claim costs under 1 ms", { timeout: 120_000, ...windowsPerfBudget() }, async () => {
    seed(100_000, 40);
    const steps: number[] = [];
    const real = (memoryClaimIndex as unknown as { buildStep: (db: unknown) => boolean });
    const buildStep = real.buildStep.bind(memoryClaimIndex);
    // A step is one page of the open walk, so its work is bounded by rows, not by time. Wall time also counts the
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
  });

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


// 1.0.3 preflight on the owner's data copy: the server thread stalled 13 to 33 s inside memory.claim. The index's first build and its
// reconcile sweep (every 30 s, and at once on every reopen) walked EVERY rowid of memory_jobs (156k rows there, 99.9% finished) on
// the server thread, so each sweep re-read the whole finished history, and under the revoke drain's disk load one 4,096-rowid chunk
// took up to 33 s. The build and the sweep now walk the open statuses through memory_jobs_pending (keyset pages, no sort), so their
// cost follows the open backlog, never the history.
describe("claim index stall budget (1.0.3 preflight)", () => {
  /** `total` jobs, every `every`-th one open (the rest finished), statuses and retry times mixed, in `scopes` scopes. */
  function history(total: number, every: number, scopes = 8) {
    const db = database();
    db.exec("BEGIN");
    for (let s = 0; s < scopes; s++) db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(`scope-${s}`, `owner-${s}`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${total - 1})
      INSERT INTO memory_sources SELECT 'src-'||i,'scope-'||(i%${scopes}),'thread-'||(i%50),'m'||i,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${total - 1})
      INSERT INTO memory_source_versions SELECT 'src-'||i,1,'h'||i,'{"text":"x"}',1 FROM n`);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${total - 1})
      INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch)
      SELECT 'job-'||printf('%07d',i),'src-'||i,1,'capture','1',
        CASE WHEN i%${every}<>3 THEN (CASE WHEN i%9=0 THEN 'cancelled' ELSE 'complete' END)
          WHEN (i/${every})%4=0 THEN 'partial' WHEN (i/${every})%4=1 THEN 'deferred' WHEN (i/${every})%8=2 THEN 'leased' ELSE 'pending' END,
        CASE WHEN i%${every}=3 AND (i/${every})%3=0 THEN ${NOW} - ((i/${every})%997) ELSE 0 END,0,0,0,0 FROM n`);
    db.exec("COMMIT");
    return Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','deferred','leased')").get()!.n);
  }
  /** Real wall time (performance.now is mocked as the index's clock in some of these tests). */
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  const wall = <T>(work: () => T): { result: T; ms: number } => { const t = now(); const result = work(); return { result, ms: now() - t }; };

  it("the open walk reads memory_jobs_pending in index order: no sort, no scan of the table", () => {
    const plan = (sql: string, ...params: unknown[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])).map(row => String(row.detail)).join(" | ");
    for (const [name, sql, params] of [["openFirst", CLAIM_INDEX_SQL.openFirst, ["pending", 0, 10, 10]], ["openTied", CLAIM_INDEX_SQL.openTied, ["pending", 0, 0, 10, 10]],
      ["openLater", CLAIM_INDEX_SQL.openLater, ["pending", 0, 10, 10]]] as const) {
      const text = plan(sql, ...params);
      expect(text, name).toMatch(/SEARCH j USING INDEX memory_jobs_pending \(status=\?/);
      expect(text, name).toMatch(/SEARCH s USING INDEX sqlite_autoindex_memory_sources_1 \(id=\?\)/);
      expect(text, name).not.toMatch(/TEMP B-TREE|SCAN j|SCAN s/);
    }
  });

  it("300,000 jobs of history, 600 open: the build and a full reconcile sweep read the open jobs only, and no step passes 100 ms", async () => {
    const open = history(300_000, 500);
    expect(open).toBe(600);
    const steps: number[] = [];
    const index = memoryClaimIndex as unknown as { buildStep: (...args: unknown[]) => boolean; reconcileStep: (...args: unknown[]) => void };
    const buildStep = index.buildStep.bind(memoryClaimIndex), reconcileStep = index.reconcileStep.bind(memoryClaimIndex);
    vi.spyOn(index, "buildStep").mockImplementation((...args: unknown[]) => { const t = now(); try { return buildStep(...args); } finally { steps.push(now() - t); } });
    vi.spyOn(index, "reconcileStep").mockImplementation((...args: unknown[]) => { const t = now(); try { reconcileStep(...args); } finally { steps.push(now() - t); } });
    const before = memoryClaimIndex.stats.examined;
    const claims: number[] = [];
    const first = wall(() => jobs.claimMemoryJob("w", NOW));
    claims.push(first.ms);
    expect(first.result).not.toBeNull();
    await settled();
    // the build read the open jobs, not the 300,000 rows of history
    const built = memoryClaimIndex.stats.examined - before;
    expect(built).toBeLessThanOrEqual(open + 8);
    expect(memoryClaimIndex.size().ready + memoryClaimIndex.size().waiting).toBeGreaterThanOrEqual(open - 1);
    // a reopen asks for a sweep at once; the whole sweep reads the open jobs again, nothing else
    memoryClaimIndex.reopened();
    const swept = memoryClaimIndex.stats.examined;
    let clock = performance.now();
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 0.01));
    try {
      for (let n = 0; n < 40; n++) { clock += RECONCILE_STEP_MS; claims.push(wall(() => jobs.claimMemoryJob("w", NOW)).ms); }
    } finally { spy.mockRestore(); }
    expect(memoryClaimIndex.stats.examined - swept).toBeLessThanOrEqual(2 * open);
    console.log(`[claim-index stall] open=${open} history=300000 buildExamined=${built} sweepExamined=${memoryClaimIndex.stats.examined - swept} maxStepMs=${Math.max(...steps).toFixed(1)} maxClaimMs=${Math.max(...claims).toFixed(1)}`);
    expect(Math.max(...steps)).toBeLessThan(100);
    expect(Math.max(...claims)).toBeLessThan(100);
  }, 300_000);

  it("a job reopened deep in the finished history (no hint) is found by the sweep over the open statuses", async () => {
    history(60_000, 1_000);
    expect(jobs.claimMemoryJob("w", NOW)).not.toBeNull();
    await settled();
    // finished long ago, reopened behind the index's back (a park reopen without a hint)
    database().exec("UPDATE memory_jobs SET status='pending',retry_at=0 WHERE id='job-0000010'");
    memoryClaimIndex.reopened();
    const seen: string[] = [];
    let clock = performance.now();
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 0.01));
    try {
      for (let n = 0; n < 200 && !seen.includes("job-0000010"); n++) { clock += RECONCILE_STEP_MS; const work = jobs.claimMemoryJob("w", NOW); if (work) seen.push(work.id); }
    } finally { spy.mockRestore(); }
    expect(seen).toContain("job-0000010");
  }, 120_000);

  it("history() makes open jobs of every open status, with mixed retry times", () => {
    history(20_000, 20, 1);
    const rows = database().prepare("SELECT status,count(*) AS n,count(DISTINCT retry_at) AS t FROM memory_jobs WHERE status IN ('pending','partial','deferred','leased') GROUP BY status ORDER BY status").all();
    expect(rows.map(row => String(row.status))).toEqual(["deferred", "leased", "partial", "pending"]);
    for (const row of rows) expect(Number(row.t)).toBeGreaterThan(1);
  });

  it("open jobs of mixed statuses and retry times over several pages are filed in rowid order per scope (the round robin's documented order)", async () => {
    const open = history(60_000, 20, 1);
    expect(open).toBeGreaterThan(2 * 1024);
    // claims while the build is still filing pages: consumed heads and filed rows meet the later, lower rowids of the next statuses
    for (let n = 0; n < 5; n++) jobs.claimMemoryJob("w", NOW);
    await settled();
    // a reopen sweep files nothing twice
    memoryClaimIndex.reopened();
    for (let n = 0; n < 10; n++) jobs.claimMemoryJob("w", NOW);
    const lists = (memoryClaimIndex as unknown as { scopes: Map<string, RidList> }).scopes;
    for (const list of lists.values()) {
      const live = list.toArray();
      expect(live).toEqual([...live].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect(new Set(live).size).toBe(live.length);
    }
  }, 120_000);

  it("jobs arriving during a sweep at the same retry time do not keep it going: the sweep ends and its queued pass runs", async () => {
    history(20_000, 20, 4);
    jobs.claimMemoryJob("w", NOW);
    await settled();
    memoryClaimIndex.reopened();
    const state = memoryClaimIndex as unknown as { reconcileWalk: unknown };
    let clock = performance.now(), next = 1_000_000, ended = false;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 0.01));
    try {
      for (let n = 0; n < 40 && !ended; n++) {
        // more new pending jobs per step than a page holds
        const db = database();
        db.exec(`WITH RECURSIVE k(i) AS (SELECT ${next} UNION ALL SELECT i+1 FROM k WHERE i<${next + 1499})
          INSERT INTO memory_sources SELECT 'src-'||i,'scope-0','thread-x','m'||i,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM k`);
        db.exec(`WITH RECURSIVE k(i) AS (SELECT ${next} UNION ALL SELECT i+1 FROM k WHERE i<${next + 1499}) INSERT INTO memory_source_versions SELECT 'src-'||i,1,'h'||i,'{"text":"x"}',1 FROM k`);
        db.exec(`WITH RECURSIVE k(i) AS (SELECT ${next} UNION ALL SELECT i+1 FROM k WHERE i<${next + 1499})
          INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch)
          SELECT 'job-'||i,'src-'||i,1,'capture','1','pending',0,0,0,0,0 FROM k`);
        next += 1500;
        clock += RECONCILE_STEP_MS;
        jobs.claimMemoryJob("w", NOW);
        if (n > 0 && state.reconcileWalk === null) ended = true;
      }
    } finally { spy.mockRestore(); }
    expect(ended).toBe(true);
  }, 120_000);

  /** `count` new open jobs in `scope`, rowids after every existing one, the i-th with retry time retry(i). */
  function arrive(first: number, count: number, scope: string, retry: string) {
    const db = database();
    const k = `WITH RECURSIVE k(i) AS (SELECT ${first} UNION ALL SELECT i+1 FROM k WHERE i<${first + count - 1})`;
    db.exec(`${k} INSERT INTO memory_sources SELECT 'src-'||i,'${scope}','thread-x','m'||i,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM k`);
    db.exec(`${k} INSERT INTO memory_source_versions SELECT 'src-'||i,1,'h'||i,'{"text":"x"}',1 FROM k`);
    db.exec(`${k} INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch)
      SELECT 'job-'||i,'src-'||i,1,'capture','1','pending',${retry},0,0,0,0 FROM k`);
  }
  /** Sweep steps with `perStep` arrivals before each (retry time from the step `n` and the row `i`), until the sweep ends or `steps` run out;
   * returns the step it ended at (null: still running) and the jobs claimed. `during(n)` runs before each step's arrivals. */
  function sweepUnderArrivals(steps: number, perStep: number, retry: (n: number) => string, during: (n: number) => void = () => {}) {
    const state = memoryClaimIndex as unknown as { reconcileWalk: unknown };
    let clock = performance.now(), next = 5_000_000, endedAt: number | null = null, ran = false;
    const claimed: string[] = [];
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 0.01));
    try {
      for (let n = 0; n < steps; n++) {
        during(n);
        arrive(next, perStep, "scope-0", retry(n));
        next += perStep;
        clock += RECONCILE_STEP_MS;
        const work = jobs.claimMemoryJob("w", NOW);
        if (work) claimed.push(work.id);
        if (state.reconcileWalk !== null) ran = true;
        if (n > 0 && endedAt === null && state.reconcileWalk === null) endedAt = n;
      }
    } finally { spy.mockRestore(); }
    // the sweep did run (a pass that never began would also read as ended)
    expect(ran).toBe(true);
    return { endedAt, claimed };
  }

  it("I1: a sweep ends while every step brings more jobs than a page holds, at ever later future retry times (Astra build2 H1)", async () => {
    const open = history(60_000, 20, 4);
    jobs.claimMemoryJob("w", NOW);
    await settled();
    memoryClaimIndex.reopened();
    // 1,500 jobs per step, each step's retry times later than the last one's: they are past the pass's retry bound (the claim's now)
    const { endedAt } = sweepUnderArrivals(60, 1_500, n => `${NOW + 1_000 + n * 1_500}+(i%1000)`);
    expect(endedAt).not.toBeNull();
    // the pass reads the open jobs it began with, a page per step: it ends within that many steps and two more
    expect(endedAt!).toBeLessThanOrEqual(Math.ceil(open / 1024) + 2);
    expect(memoryClaimIndex.stats.cut).toBe(0);
  }, 120_000);

  it("I1: a pass ends at its row cap even when arrivals break the writers' rule (ever later retry times in the past)", async () => {
    history(2_000, 20, 4);
    jobs.claimMemoryJob("w", NOW);
    await settled();
    const cut = memoryClaimIndex.stats.cut;
    memoryClaimIndex.reopened();
    // retry times below the pass's bound and above its cursor, written after it began: the cap (8 x (end + 1) + 8 pages) ends it
    const { endedAt } = sweepUnderArrivals(40, 1_500, n => `${NOW - 900_000 + n * 1_500}+(i%1000)`);
    expect(endedAt).not.toBeNull();
    expect(memoryClaimIndex.stats.cut).toBe(cut + 1);
  }, 120_000);

  it("I2: a job reopened behind a running sweep (no hint) is claimed after the sweep and its queued pass, while arrivals continue", async () => {
    history(60_000, 20, 4);
    jobs.claimMemoryJob("w", NOW);
    await settled();
    memoryClaimIndex.reopened();
    // after two steps the sweep is past every pending job at retry 0: reopen a finished one there and report it
    const reopen = (n: number) => { if (n === 2) { database().exec("UPDATE memory_jobs SET status='pending',retry_at=0 WHERE id='job-0000010'"); memoryClaimIndex.reopened(); } };
    const { endedAt, claimed } = sweepUnderArrivals(60, 1_500, n => `${NOW + 1_000 + n * 1_500}+(i%1000)`, reopen);
    expect(endedAt).not.toBeNull();
    // filed again (the flood of not-due arrivals spends claims' check budgets, so the SQL fallback may serve other jobs first)
    const ready = (memoryClaimIndex as unknown as { ready: Set<bigint> }).ready;
    const rid = database().prepare("SELECT rowid AS rid FROM memory_jobs WHERE id='job-0000010'").get()!.rid as number;
    expect(claimed.includes("job-0000010") || ready.has(BigInt(rid))).toBe(true);
  }, 120_000);

  it("I3: a job not due when the index was built is filed by the due frontier when its retry time passes, with no rebuild", async () => {
    job(1, "scope-a"); job(2, "scope-b");
    database().exec("UPDATE memory_jobs SET status='deferred',retry_at=" + (NOW + 5_000) + " WHERE id='job-000001'");
    // the claim at NOW builds the index (a due job keeps the idle guard from answering first) and takes the due job
    expect(jobs.claimMemoryJob("w", NOW)?.id).toBe("job-000002");
    await settled();
    const rebuilds = memoryClaimIndex.stats.rebuilds;
    expect(jobs.claimMemoryJob("w", NOW + 4_000)).toBeNull();
    expect(jobs.claimMemoryJob("w", NOW + 5_000)?.id).toBe("job-000001");
    expect(memoryClaimIndex.stats.rebuilds).toBe(rebuilds);
  });

  it("I4: filing a page costs O(page) whatever the open backlog: 25,000 and 100,000 open jobs in one scope, retry order opposite to rowid order (Astra build2 H2)", async () => {
    const runOne = async (count: number) => {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec("PRAGMA synchronous=OFF");
      memoryClaimIndex.invalidate(); jobs.resetMemoryClaimCursor();
      // every page of the walk reads rowids below all the ones filed before it: the old merge copied the whole list on each page
      setMemoryMode("capture");
      database().exec("INSERT OR IGNORE INTO memory_scopes VALUES('scope-0','conversation','owner-0','[]',0)");
      arrive(1, count, "scope-0", `${NOW} - i`);
      const index = memoryClaimIndex as unknown as { page: (...args: unknown[]) => boolean; scopes: Map<string, RidList> };
      const page = index.page.bind(memoryClaimIndex);
      const perPage: number[] = [], stepMs: number[] = [];
      const moves = () => [...index.scopes.values()].reduce((sum, list) => sum + list.moves, 0);
      const spy = vi.spyOn(index, "page").mockImplementation((...args: unknown[]) => {
        const m = moves(), t = Number(process.hrtime.bigint()) / 1e6;
        try { return page(...args); } finally { perPage.push(moves() - m); stepMs.push(Number(process.hrtime.bigint()) / 1e6 - t); }
      });
      try { jobs.claimMemoryJob("w", NOW); await settled(); } finally { spy.mockRestore(); }
      expect(memoryClaimIndex.size().ready + memoryClaimIndex.size().waiting).toBeGreaterThanOrEqual(count - 1);
      return { maxMoves: Math.max(...perPage), maxMs: Math.max(...stepMs) };
    };
    const small = await runOne(25_000), large = await runOne(100_000);
    console.log(`[claim-index O(page)] moves/page 25k=${small.maxMoves} 100k=${large.maxMoves} maxStepMs 25k=${small.maxMs.toFixed(1)} 100k=${large.maxMs.toFixed(1)}`);
    // the bound from the design: each insert moves at most one block, a split at most a block and the block list
    expect(large.maxMoves).toBeLessThanOrEqual(1024 * RID_BLOCK + 8 * (RID_BLOCK + 100_000 / (RID_BLOCK / 2)));
    // and it does not grow with the backlog (the old merge's per-page copy grew 4x from 25k to 100k)
    expect(large.maxMoves).toBeLessThanOrEqual(small.maxMoves * 1.5 + 1024);
    expect(large.maxMs).toBeLessThan(100);
  }, 300_000);

  it("RidList keeps rowids ascending without duplicates under out-of-order inserts and front drops", () => {
    const list = new RidList(), mirror = new Set<bigint>();
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let n = 0; n < 20_000; n++) {
      const rid = BigInt(rand() % 50_000);
      expect(list.insert(rid)).toBe(!mirror.has(rid));
      mirror.add(rid);
      if (n % 1_000 === 999) { const sorted = [...mirror].sort((a, b) => (a < b ? -1 : 1)); list.dropFront(100); for (const rid of sorted.slice(0, 100)) mirror.delete(rid); }
    }
    const want = [...mirror].sort((a, b) => (a < b ? -1 : 1));
    expect(list.toArray()).toEqual(want);
    expect([...list.descending()]).toEqual([...want].reverse());
    expect(list.size).toBe(want.length);
  });

  it("RidList: 100,000 inserts in descending order move O(1) block pointers per split, and front drops move none (Astra build3 H1)", () => {
    const list = new RidList();
    const t = performance.now();
    for (let rid = 100_000n; rid > 0n; rid--) list.insert(rid);
    const took = performance.now() - t;
    const splits = Math.ceil(100_000 / (RID_BLOCK / 2));
    console.log(`[rid-list reverse] 100k inserts ${took.toFixed(1)} ms, block moves ${list.blockMoves} over at most ${splits} splits`);
    // a split at the front of the list costs no block move beyond the odd refill of the front slack: amortized O(1), not n / RID_BLOCK
    expect(list.blockMoves).toBeLessThanOrEqual(4 * splits);
    expect(took).toBeLessThan(2_000);
    expect(list.size).toBe(100_000);
    // consumed heads leave their slots free; the free run is compacted now and then, at most one move per block
    const before = list.blockMoves;
    for (let n = 0; n < 50; n++) list.dropFront(RID_BLOCK);
    expect(list.blockMoves - before).toBeLessThanOrEqual(2 * Math.ceil(100_000 / (RID_BLOCK / 2)));
    expect(list.size).toBe(100_000 - 50 * RID_BLOCK);
    expect(list.toArray()[0]).toBe(BigInt(50 * RID_BLOCK + 1));
    // a rowid below every held one lands at the front, and the order holds through it
    expect(list.insert(5n)).toBe(true);
    expect(list.insert(5n)).toBe(false);
    const all = list.toArray();
    expect(all[0]).toBe(5n);
    expect(all[1]).toBe(BigInt(50 * RID_BLOCK + 1));
    expect(all.length).toBe(list.size);
    for (let i = 1; i < all.length; i++) expect(all[i]! > all[i - 1]!).toBe(true);
  });

  it("recent() answers from the due frontier only once it has finished: 1,100 jobs due at once leave the newest past the first page, so the conservative path answers (Astra build3 Medium)", async () => {
    job(1, "scope-r"); // claimable now, the oldest in the scope
    arrive(2, 1_100, "scope-r", `${NOW + 5_000}`);
    expect(jobs.claimMemoryJob("w", NOW)?.id).toBe("job-000001");
    await settled();
    // the 1,100 come due together: the frontier's first page (1,024 rows, in rowid order) leaves the newest 76 unread
    const state = memoryClaimIndex as unknown as { frontierWalk: unknown };
    const answer = memoryClaimIndex.recent(database(), NOW + 5_000, ["scope-r"]);
    expect(state.frontierWalk).not.toBeNull();
    expect(answer).toBeUndefined();
    // the claim for recent scopes takes the newest job, never an older one the half-read frontier happens to hold
    expect(jobs.claimMemoryJob("w", NOW + 5_000, ["scope-r"])?.id).toBe("job-1101");
    expect(state.frontierWalk).toBeNull();
    // with the frontier finished the index answers itself
    const next = memoryClaimIndex.recent(database(), NOW + 5_001, ["scope-r"]);
    expect(next).not.toBeUndefined();
    expect(next).not.toBeNull();
  }, 60_000);
});
