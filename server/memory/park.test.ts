import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import { captureSource, captureBranchChange } from "./capture.ts";
import { claimMemoryJob, MEMORY_CLAIM_SQL, resetMemoryClaimCursor } from "./jobs.ts";
import { PARK_SWEEP_WINDOW, parkStuckJobsStep, parkSweepFinished, resetParkSweep } from "./park.ts";
import { pauseRestoredMemory } from "./restore.ts";

const NOW = 5_000_000;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetMemoryClaimCursor(); resetParkSweep(); });
afterEach(() => { delete process.env.MURAGE_TURN_TRACE; });

/** Thread "t": m1 is the root, m2 and m3 are sibling replies (two branches). */
function thread() {
  const db = database();
  const row = (id: string, parent: string | null) => db.prepare("INSERT INTO messages VALUES('t',?,1,'user','text',?,?)").run(id, id, JSON.stringify({ parentId: parent }));
  row("m1", null); row("m2", "m1"); row("m3", "m1");
  for (const id of ["m1", "m2", "m3"]) captureSource(db, { id: `message:t:${id}`, threadId: "t", messageId: id, kind: "text", speaker: "owner", outcome: "recorded", text: `text ${id}` });
  return db;
}
const jobRows = () => database().prepare("SELECT id,source_id,status,cursor,coverage,retry_at,attempts,lease_owner,lease_until,error FROM memory_jobs ORDER BY id").all();
const openCount = () => Number(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','deferred','leased')").get()!.n);
const statusOf = (id: string) => database().prepare("SELECT status FROM memory_jobs WHERE source_id=?").get(`message:t:${id}`)?.status;

describe("parking jobs of retired sources", () => {
  it("retiring a branch parks its open jobs and re-activating it reopens exactly the same jobs", () => {
    const db = thread();
    // every open shape: partial progress, a deferral with its reason and retry time
    db.prepare("UPDATE memory_jobs SET status='partial',cursor=4,coverage='{\"throughByte\":4}' WHERE source_id='message:t:m3'").run();
    db.prepare("UPDATE memory_jobs SET status='deferred',attempts=1,retry_at=?,error='worker-failed' WHERE source_id='message:t:m2'").run(NOW + 5000);
    const before = jobRows();
    captureBranchChange(db, "t", "m2");  // m3 retires
    expect(db.prepare("SELECT state FROM memory_sources WHERE id='message:t:m3'").get()?.state).toBe("retired");
    const parked = db.prepare("SELECT status,error FROM memory_jobs WHERE source_id='message:t:m3'").get()!;
    expect(parked.status).toBe("cancelled");
    expect(String(parked.error)).toMatch(/^parked:v1:\{"s":"partial"/);
    expect(openCount()).toBe(2);
    captureBranchChange(db, "t", "m2");  // repeating changes nothing
    expect(openCount()).toBe(2);
    captureBranchChange(db, "t", "m3");  // m3 is back, m2 retires with its deferral
    expect(statusOf("m2")).toBe("cancelled");
    expect(jobRows().find(r => r.source_id === "message:t:m3")).toEqual(before.find(r => r.source_id === "message:t:m3"));
    captureBranchChange(db, "t", "m2");  // m2 is back with its status, attempts, retry time and reason
    expect(jobRows().find(r => r.source_id === "message:t:m2")).toEqual(before.find(r => r.source_id === "message:t:m2"));
    expect(jobRows().find(r => r.source_id === "message:t:m1")).toEqual(before.find(r => r.source_id === "message:t:m1"));
  });

  it("a leased job of a retired source is parked with its lease fenced and comes back pending", () => {
    const db = thread();
    expect(claimMemoryJob("w", NOW)?.sourceId).toBe("message:t:m1");
    const m3 = claimMemoryJob("w", NOW)!;  // the second claim is m2 or m3: retire whichever it is
    const other = m3.sourceId.endsWith("m2") ? "m3" : "m2";
    captureBranchChange(db, "t", other);
    const row = db.prepare("SELECT status,lease_owner,lease_generation FROM memory_jobs WHERE id=?").get(m3.id)!;
    expect(row.status).toBe("cancelled");
    expect(row.lease_owner).toBeNull();
    expect(Number(row.lease_generation)).toBeGreaterThan(m3.leaseGeneration);
    captureBranchChange(db, "t", m3.sourceId.slice(-2));
    expect(db.prepare("SELECT status,lease_owner FROM memory_jobs WHERE id=?").get(m3.id)).toEqual({ status: "pending", lease_owner: null });
  });

  it("a parked job is never claimed and does not hold the idle guard open", () => {
    const db = thread();
    captureBranchChange(db, "t", "m1");  // m2 and m3 retire; only m1 stays
    expect(claimMemoryJob("w", NOW)?.sourceId).toBe("message:t:m1");
    db.prepare("UPDATE memory_jobs SET status='complete' WHERE source_id='message:t:m1'").run();
    expect(openCount()).toBe(0);
    expect(db.prepare(MEMORY_CLAIM_SQL.anyOpen).get(NOW, NOW)).toBeUndefined();  // the one idle probe finds nothing
    expect(claimMemoryJob("w", NOW)).toBeNull();
    // without parking the same rows keep the guard open although nothing can be claimed
    db.prepare("UPDATE memory_jobs SET status='pending',error=NULL WHERE source_id='message:t:m2'").run();
    expect(db.prepare(MEMORY_CLAIM_SQL.anyOpen).get(NOW, NOW)).toBeDefined();
    expect(claimMemoryJob("w", NOW)).toBeNull();
  });

  it("a newer revision keeps its own job and the older parked job stays parked", () => {
    const db = thread();
    captureBranchChange(db, "t", "m2");
    captureSource(db, { id: "message:t:m3", threadId: "t", messageId: "m3", kind: "text", speaker: "owner", outcome: "recorded", text: "edited m3" });
    captureBranchChange(db, "t", "m3");
    const rows = db.prepare("SELECT source_revision,status FROM memory_jobs WHERE source_id='message:t:m3' ORDER BY source_revision").all();
    expect(rows).toEqual([{ source_revision: 1, status: "cancelled" }, { source_revision: 2, status: "pending" }]);
  });

  it("restore parks a leased job of a retired source instead of requeueing it", () => {
    const db = thread();
    db.prepare("UPDATE memory_sources SET state='retired' WHERE id='message:t:m3'").run();
    db.prepare("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_until=?").run(NOW);
    pauseRestoredMemory(db);
    expect(statusOf("m3")).toBe("cancelled");
    expect(statusOf("m1")).toBe("pending");
  });
});

describe("one-time sweep of jobs already stuck", () => {
  /** n sources; every third is retired with a pending job (the stuck backlog), the rest are active. */
  function legacy(n: number) {
    const db = database();
    db.exec("BEGIN");
    db.prepare("INSERT INTO memory_scopes VALUES('s','conversation','o','[]',0)").run();
    for (let i = 0; i < n; i++) {
      db.prepare("INSERT INTO memory_sources VALUES(?,'s','t',?,NULL,1,?,'text','owner','recorded',NULL,?)").run(`src-${i}`, `m${i}`, `h${i}`, i % 3 === 0 ? "retired" : "active");
      db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: "x" }));
      db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0)").run(`job-${i}`, `src-${i}`);
    }
    db.exec("COMMIT");
    return db;
  }
  const stuck = () => Number(database().prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.state='retired' AND j.status='pending'").get()!.n);

  it("parks in bounded batches, resumes after an interruption and is a no-op once done", () => {
    const n = PARK_SWEEP_WINDOW * 3 + 120, db = legacy(n);
    const total = stuck();
    const lines: string[] = [];
    process.env.MURAGE_TURN_TRACE = "1";
    const sizes: number[] = [];
    let steps = 0;
    for (; !parkSweepFinished() && steps < 50; steps++) {
      sizes.push(parkStuckJobsStep(db, l => lines.push(l)).parked);
      if (steps === 1) { resetParkSweep(); expect(stuck()).toBeGreaterThan(0); }  // the process restarts mid-sweep
    }
    expect(steps).toBe(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PARK_SWEEP_WINDOW);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
    expect(stuck()).toBe(0);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='pending'").get()!.n)).toBe(n - total);  // active jobs untouched
    expect(JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-parked-sweep'").get()!.intent)).done).toBe(true);
    // trace: counts only, never an id or content
    expect(lines).toHaveLength(4);
    expect(lines.every(l => /^\[turn-trace\] phase=memory\.park( parked=\d+)?( done=true)?$/.test(l))).toBe(true);
    expect(lines.at(-1)).toContain("done=true");
    // the done flag survives a restart and the sweep is a no-op afterwards
    resetParkSweep();
    const before = jobRows();
    expect(parkStuckJobsStep(db, l => lines.push(l))).toEqual({ parked: 0, done: true });
    expect(jobRows()).toEqual(before);
    expect(lines).toHaveLength(4);
  });

  it("resumes from the persisted cursor, not from the start", () => {
    const db = legacy(PARK_SWEEP_WINDOW * 2 + 10);
    parkStuckJobsStep(db);
    expect(JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-parked-sweep'").get()!.intent)).cursor).toBe(String(PARK_SWEEP_WINDOW));
    db.prepare("UPDATE memory_jobs SET status='pending',error=NULL WHERE id='job-0'").run();  // behind the cursor
    resetParkSweep();
    while (!parkSweepFinished()) parkStuckJobsStep(db);
    expect(db.prepare("SELECT status FROM memory_jobs WHERE id='job-0'").get()?.status).toBe("pending");
  });

  it("swept jobs come back when their source is active again", () => {
    const db = thread();
    db.prepare("UPDATE memory_sources SET state='retired' WHERE id='message:t:m3'").run();  // the old behaviour: retired, job left pending
    while (!parkSweepFinished()) parkStuckJobsStep(db);
    expect(statusOf("m3")).toBe("cancelled");
    captureBranchChange(db, "t", "m3");
    expect(db.prepare("SELECT status,error FROM memory_jobs WHERE source_id='message:t:m3'").get()).toEqual({ status: "pending", error: null });
  });
});
