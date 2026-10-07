// Fixes for the Codex audit of lane/0163-memory-claim: the sweep and the park
// statements are asserted by their query plans, not by rows changed; the
// parking marker is structured and validated; permanent cancellation ends
// parking; a downgrade is repaired by the per-launch reconciliation; rowids
// past 2^53 are read and bound exactly.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureBranchChange, captureSource } from "./capture.ts";
import { claimMemoryJob, deferStaleMemoryWork, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import * as park from "./park.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { memoryOwnerRoute } from "./settings.ts";

// Members of the module under test that exist only after the fix are reached through this view.
const fix = park as unknown as Record<string, any>;
const NOW = 5_000_000;
const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor(); park.resetParkSweep(); fix.resetParkReconcile?.();
});
afterEach(() => { closeDatabase(); });

/** Thread: m1 is the root, m2 and m3 are sibling replies (two branches). */
function thread(id = "t") {
  const db = database();
  const row = (message: string, parent: string | null) => db.prepare("INSERT INTO messages VALUES(?,?,1,'user','text',?,?)").run(id, message, message, JSON.stringify({ parentId: parent }));
  row("m1", null); row("m2", "m1"); row("m3", "m1");
  for (const m of ["m1", "m2", "m3"]) captureSource(db, { id: `message:${id}:${m}`, threadId: id, messageId: m, kind: "text", speaker: "owner", outcome: "recorded", text: `text ${m}` });
  return db;
}
const job = (source: string) => database().prepare("SELECT status,error,lease_owner,lease_generation FROM memory_jobs WHERE source_id=? ORDER BY source_revision DESC").get(source) as { status: string; error: string | null; lease_owner: string | null; lease_generation: number };
const plan = (sql: string, ...args: any[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => String(r.detail)).join("\n");

/** n sources with ids src-0.. and one pending job each; every third source is retired (the stuck backlog). `rowidOf` places the job rowids. */
function legacy(n: number, rowidOf: (i: number) => number | bigint = i => i + 1) {
  const db = database();
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_scopes VALUES('s','conversation','o','[]',0)").run();
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,'s','t',?,NULL,1,?,'text','owner','recorded',NULL,?)").run(`src-${i}`, `m${i}`, `h${i}`, i % 3 === 0 ? "retired" : "active");
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: "x" }));
    db.prepare("INSERT INTO memory_jobs(rowid,id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,?,1,'capture','1','pending',0,0)").run(rowidOf(i), `job-${i}`, `src-${i}`);
  }
  db.exec("COMMIT");
  return db;
}
const stuck = () => Number(database().prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.state='retired' AND j.status='pending'").get()!.n);
const completeResult = (work: { id: string; leaseGeneration: number; text: string }) => ({ id: work.id, leaseGeneration: work.leaseGeneration, status: "complete" as const, nextCursor: Buffer.byteLength(work.text),
  chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] });

describe("finding 1: scan bounds are access paths", () => {
  it("the sweep selects its window by a rowid seek and updates over that rowid range, never through the status index", () => {
    legacy(10);
    const select = plan(fix.PARK_SQL.sweepSelect, 0);
    expect(select).toMatch(/SEARCH memory_jobs USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    expect(select).not.toContain("memory_jobs_pending");
    const update = plan(fix.PARK_SQL.sweepPark, 0, 100);
    expect(update).toMatch(/SEARCH memory_jobs USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<=?\?\)/);
    expect(update).not.toContain("memory_jobs_pending");
    expect(update).not.toMatch(/SCAN memory_jobs/);
  });

  it("rowid gaps do not produce empty batches: every step covers a full window of real rows", () => {
    const n = park.PARK_SWEEP_WINDOW * 2 + 100;
    legacy(n, i => (i + 1) * 1_000_000);
    const total = stuck(), parked: number[] = [];
    let steps = 0;
    for (; !park.parkSweepFinished() && steps < 10; steps++) parked.push(park.parkStuckJobsStep(database()).parked);
    expect(park.parkSweepFinished()).toBe(true);
    expect(steps).toBe(3);
    expect(parked.reduce((a, b) => a + b, 0)).toBe(total);
    expect(parked[0]).toBeGreaterThan(100);  // a window of 500 real rows holds about 167 retired ones, not zero
    expect(stuck()).toBe(0);
  });

  it("thread park and reopen are driven by the thread's sources and probe jobs by source id", () => {
    thread();
    for (const sql of [fix.PARK_SQL.thread, fix.PARK_SQL.reopenThread]) {
      const text = plan(sql, "t");
      expect(text).toContain("memory_sources_thread");
      expect(text).toMatch(/SEARCH j USING (COVERING )?INDEX sqlite_autoindex_memory_jobs_2 \(source_id=\?/);
      expect(text).not.toContain("memory_jobs_pending");
      expect(text).not.toMatch(/SCAN (j|memory_jobs)/);
    }
  });

  it("restore parking walks the leased range and probes each source by primary key", () => {
    thread();
    const text = plan(fix.PARK_SQL.restore);
    expect(text).toMatch(/SEARCH memory_jobs USING INDEX memory_jobs_pending \(status=\?\)/);
    expect(text).toMatch(/SEARCH s USING INDEX sqlite_autoindex_memory_sources_1 \(id=\?\)/);
    expect(text).not.toMatch(/SCAN/);
  });

  it("the reconciliation reads a window of cancelled index entries and reopens by rowid", () => {
    thread();
    const select = plan(fix.PARK_SQL.reconcileTied, 0, 0);
    expect(select).toMatch(/SEARCH memory_jobs USING (COVERING )?INDEX memory_jobs_pending \(status=\?/);
    expect(select).not.toMatch(/SCAN|TEMP B-TREE/);
    expect(plan(fix.PARK_SQL.reconcileReopen, 1)).toMatch(/SEARCH memory_jobs USING INTEGER PRIMARY KEY \(rowid=\?\)/);
  });
});

describe("finding 3: the done flag follows the commit", () => {
  it("a rolled-back final batch leaves the sweep retryable in the same process", () => {
    const db = legacy(park.PARK_SWEEP_WINDOW + 50);
    const total = stuck();
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    for (let i = 0; i < 5 && !finished; i++) finished = park.parkStuckJobsStep(db).done;
    expect(finished).toBe(true);
    expect(stuck()).toBe(0);
    db.exec("ROLLBACK");
    expect(stuck()).toBe(total);
    expect(park.parkSweepFinished()).toBe(false);
    let parked = 0;
    for (let i = 0; i < 5 && !park.parkSweepFinished(); i++) parked += park.parkStuckJobsStep(db).parked;
    expect(parked).toBe(total);
    expect(park.parkSweepFinished()).toBe(true);
  });
});

describe("finding 4: permanent cancellation ends parking", () => {
  it("retire, exclude, un-exclude, re-activate: the parked job stays cancelled like a job the exclusion cancelled itself", async () => {
    const db = thread("thread-a");
    await memoryOwnerRoute("/api/memory/action", { action: "configure", mode: "capture" }, ownerMemoryTicket(), roster);
    captureBranchChange(db, "thread-a", "m2");  // m3 retires and its job is parked
    expect(job("message:thread-a:m3").error).toMatch(/^parked:/);
    await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: ["thread-a"] }, ownerMemoryTicket(), roster);
    expect(job("message:thread-a:m1").status).toBe("cancelled");  // cancelled directly by the exclusion
    expect(job("message:thread-a:m3")).toMatchObject({ status: "cancelled", error: null });  // its parking is gone
    await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: [] }, ownerMemoryTicket(), roster);
    captureBranchChange(db, "thread-a", "m3");  // m3 is active again
    expect(db.prepare("SELECT state FROM memory_sources WHERE id='message:thread-a:m3'").get()?.state).toBe("active");
    expect(job("message:thread-a:m3").status).toBe("cancelled");
    expect(job("message:thread-a:m1").status).toBe("cancelled");
    fix.resetParkReconcile(); fix.parkReconcileStep(db);
    expect(job("message:thread-a:m3").status).toBe("cancelled");  // the reconciliation does not bring it back either
  });

  it("a newer revision of a parked source clears the old marker as well", () => {
    const db = thread();
    captureBranchChange(db, "t", "m2");
    captureSource(db, { id: "message:t:m3", threadId: "t", messageId: "m3", kind: "text", speaker: "owner", outcome: "recorded", text: "edited m3" });
    // no explicit forget call: capturing the newer revision itself ends the parking of the old one
    expect(db.prepare("SELECT status,error FROM memory_jobs WHERE source_id='message:t:m3' AND source_revision=1").get()).toEqual({ status: "cancelled", error: null });
  });
});

describe("finding 5: a downgrade is repaired on the next launch", () => {
  it("an older build re-activates a source without reopening its job; the new code reopens it exactly", () => {
    const db = thread();
    db.prepare("UPDATE memory_jobs SET status='deferred',attempts=1,retry_at=?,error='worker-failed' WHERE source_id='message:t:m3'").run(NOW + 5000);
    const before = db.prepare("SELECT * FROM memory_jobs WHERE source_id='message:t:m3'").get();
    captureBranchChange(db, "t", "m2");
    expect(job("message:t:m3").status).toBe("cancelled");
    db.prepare("UPDATE memory_sources SET state='active' WHERE id='message:t:m3'").run();  // what the older build's branch change does
    expect(job("message:t:m3").status).toBe("cancelled");
    expect(fix.parkReconcileStep(db)).toEqual({ reopened: 1, done: true });
    expect(db.prepare("SELECT * FROM memory_jobs WHERE source_id='message:t:m3'").get()).toEqual({ ...before, lease_generation: Number((before as any).lease_generation) + 1 });
    // a second downgrade, later: the next launch (a fresh pass) repairs it too
    captureBranchChange(db, "t", "m2");
    db.prepare("UPDATE memory_sources SET state='active' WHERE id='message:t:m3'").run();
    expect(fix.parkReconcileStep(db).reopened).toBe(0);  // the pass of this launch is over
    // downgrade then upgrade always changes the running version, which is what makes the pass matter
    const saved = process.env.MURAGE_APP_VERSION; process.env.MURAGE_APP_VERSION = "upgraded-again";
    try { fix.resetParkReconcile(); expect(fix.parkReconcileStep(db).reopened).toBe(1); }
    finally { if (saved === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = saved; }
    expect(job("message:t:m3").status).toBe("deferred");
  });

  it("leaves retired sources and superseded revisions parked, and works through cancelled rows in bounded windows", () => {
    const db = legacy(10);
    db.prepare("UPDATE memory_sources SET state='retired'").run();
    db.prepare("UPDATE memory_jobs SET status='pending'").run();
    park.parkStuckJobsStep(db);  // everything parked
    const cancelledMany = park.PARK_SWEEP_WINDOW * 2 + 40;
    db.exec("BEGIN");
    for (let i = 0; i < cancelledMany; i++) db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,'src-1',1,'x',?,'cancelled',0,0)").run(`c-${i}`, `v${i}`);
    db.exec("COMMIT");
    db.prepare("UPDATE memory_sources SET state='active' WHERE id IN ('src-2','src-4')").run();
    db.prepare("UPDATE memory_sources SET revision=2 WHERE id='src-4'").run();  // src-4's parked job belongs to a replaced revision
    db.prepare("INSERT INTO memory_source_versions VALUES('src-4',2,'h',?,1)").run(JSON.stringify({ text: "y" }));
    const steps: number[] = [];
    while (!fix.parkReconcileFinished() && steps.length < 10) steps.push(fix.parkReconcileStep(db).reopened);
    expect(steps).toHaveLength(3);
    expect(steps.reduce((a, b) => a + b, 0)).toBe(1);
    expect(job("src-2").status).toBe("pending");
    expect(job("src-4").status).toBe("cancelled");
    expect(job("src-3").status).toBe("cancelled");
  });
});

describe("finding 6: the parking marker is structured and validated", () => {
  const reopenAll = (db: ReturnType<typeof database>) => { db.prepare("UPDATE memory_sources SET state='active' WHERE id='message:t:m3'").run(); fix.resetParkReconcile(); fix.parkReconcileStep(db); };

  it("restores NULL, the empty string and an error containing a bar exactly", () => {
    for (const prior of [null, "", "a|b|c", "plain"]) {
      closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
      const db = thread();
      db.prepare("UPDATE memory_jobs SET status='deferred',error=? WHERE source_id='message:t:m3'").run(prior);
      captureBranchChange(db, "t", "m2");
      expect(job("message:t:m3").status).toBe("cancelled");
      captureBranchChange(db, "t", "m3");
      expect(db.prepare("SELECT status,error FROM memory_jobs WHERE source_id='message:t:m3'").get()).toEqual({ status: "deferred", error: prior });
    }
  });

  it("a forged or malformed parked-looking value is an ordinary cancelled job: never reopened and never an error", () => {
    const forged = ["parked:pending|worker failure", "parked:ordinary failure", "parked:v1:{\"s\":\"complete\",\"e\":null}", "parked:v1:{\"s\":\"pending\"}",
      "parked:v1:{bad json", "parked:v1:{\"s\":\"pending\",\"e\":5}", "parked:v1:[1,2]", "PARKED:V1:{\"s\":\"pending\",\"e\":null}", "parked:v1:{\"s\":\"leased\",\"e\":null}", "parked:v2:{\"s\":\"pending\",\"e\":null}"];
    for (const value of forged) {
      closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
      const db = thread();
      captureBranchChange(db, "t", "m2");
      db.prepare("UPDATE memory_jobs SET error=? WHERE source_id='message:t:m3'").run(value);
      expect(() => captureBranchChange(db, "t", "m3")).not.toThrow();  // the branch transaction is not aborted
      expect(db.prepare("SELECT status,error FROM memory_jobs WHERE source_id='message:t:m3'").get()).toEqual({ status: "cancelled", error: value });
      expect(() => reopenAll(db)).not.toThrow();
      expect(job("message:t:m3")).toMatchObject({ status: "cancelled", error: value });
    }
  });

  it("a worker reason that starts with the marker is stored escaped and can never be read as one", () => {
    const db = thread();
    const reason = "parked:v1:{\"s\":\"pending\",\"e\":null}";
    const work = claimMemoryJob("w", NOW)!;
    publishMemoryWork(work, "w", { id: work.id, leaseGeneration: work.leaseGeneration, status: "deferred", nextCursor: work.cursor, chunks: [], reason }, NOW);
    const stored = String(db.prepare("SELECT error FROM memory_jobs WHERE id=?").get(work.id)!.error);
    expect(stored.startsWith("parked:")).toBe(false);
    expect(stored).toContain(reason);
    db.prepare("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_until=?,lease_generation=7 WHERE id=?").run(NOW + 1_000_000, work.id);
    expect(deferStaleMemoryWork({ ...work, leaseGeneration: 7 }, "w", reason, NOW)).toBe(true);
    expect(String(db.prepare("SELECT error FROM memory_jobs WHERE id=?").get(work.id)!.error).startsWith("parked:")).toBe(false);
  });
});

describe("finding 7: rowids past 2^53", () => {
  it("the claim returns a job whose rowid is 9007199254740993", () => {
    const db = legacy(1, () => 9007199254740993n);
    db.prepare("UPDATE memory_sources SET state='active'").run();
    expect(claimMemoryJob("w", NOW)?.id).toBe("job-0");
    expect(claimMemoryJob("w", NOW, ["s"])).toBeNull();  // leased now; the recent-scopes path reads the rowid the same way
    db.prepare("UPDATE memory_jobs SET status='pending',lease_until=0").run();
    expect(claimMemoryJob("w", NOW, ["s"])?.id).toBe("job-0");
  });

  it("the persisted cursor stops on an odd rowid above 2^53 and a reset process resumes from it", () => {
    const base = 9007199254740993n;  // 2^53 + 1, odd
    legacy(park.PARK_SWEEP_WINDOW + 50, i => base + BigInt(i) * 2n);  // every rowid odd, all above 2^53
    const total = stuck();
    expect(park.parkStuckJobsStep(database()).done).toBe(false);
    const cursor = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-parked-sweep'").get()!.intent)).cursor;
    expect(cursor).toBe(String(base + BigInt(park.PARK_SWEEP_WINDOW - 1) * 2n));  // the 500th rowid, exact
    park.resetParkSweep();  // a new launch
    expect(park.parkStuckJobsStep(database()).done).toBe(true);
    expect(stuck()).toBe(0);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled'").get()!.n)).toBe(total);
  });

  it("the sweep cursor keeps such rowids exactly", () => {
    legacy(4, i => 9007199254740991n + BigInt(i));
    const total = stuck();
    expect(total).toBeGreaterThan(0);
    while (!park.parkSweepFinished()) park.parkStuckJobsStep(database());
    expect(stuck()).toBe(0);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled'").get()!.n)).toBe(total);
  });
});

describe("audit test gaps", () => {
  it("a retired worker's late result is refused after park and after reopen, and nothing is applied twice", () => {
    const db = thread();
    let work = claimMemoryJob("w", NOW)!;
    while (!work.sourceId.endsWith("m3")) work = claimMemoryJob("w", NOW)!;
    const retired = completeResult(work);
    captureBranchChange(db, "t", "m2");  // parks the leased job and fences the lease
    expect(() => publishMemoryWork(work, "w", retired, NOW)).toThrow("STALE_MEMORY_LEASE");
    captureBranchChange(db, "t", "m3");  // reopens it
    expect(job("message:t:m3").status).toBe("pending");
    expect(() => publishMemoryWork(work, "w", retired, NOW)).toThrow("STALE_MEMORY_LEASE");
    const records = () => Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE kind='source'").get()!.n);
    expect(records()).toBe(0);
    let fresh = claimMemoryJob("w2", NOW)!;
    while (!fresh.sourceId.endsWith("m3")) fresh = claimMemoryJob("w2", NOW)!;
    expect(fresh.leaseGeneration).toBeGreaterThan(work.leaseGeneration);
    expect(() => publishMemoryWork(work, "w", retired, NOW)).toThrow("STALE_MEMORY_LEASE");
    publishMemoryWork(fresh, "w2", completeResult(fresh), NOW);
    expect(records()).toBe(1);
    expect(() => publishMemoryWork(fresh, "w2", completeResult(fresh), NOW)).toThrow("STALE_MEMORY_LEASE");
    expect(records()).toBe(1);
  });

  it("two connections sweeping serialize on the write lock and never park a job twice or lose the cursor", () => {
    const db = legacy(park.PARK_SWEEP_WINDOW * 2 + 90);
    const total = stuck();
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      db.exec("BEGIN IMMEDIATE");
      const first = park.parkStuckJobsStep(db).parked;  // inside the caller's transaction
      expect(() => park.parkStuckJobsStep(other)).toThrow(/locked|busy/i);  // the second writer waits its turn
      db.exec("COMMIT");
      let parked = first;
      for (let i = 0; i < 10 && !park.parkSweepFinished(); i++) { parked += park.parkStuckJobsStep(i % 2 ? db : other).parked; }
      expect(park.parkSweepFinished()).toBe(true);
      expect(parked).toBe(total);
      expect(stuck()).toBe(0);
      expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='cancelled'").get()!.n)).toBe(total);
    } finally { other.close(); }
  });
});
