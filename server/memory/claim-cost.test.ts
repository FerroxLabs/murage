import type { SQLInputValue } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import * as jobs from "./jobs.ts";
import { memoryTickGapMs, resetBacklogTrace, traceBacklog, traceSlowStep } from "./claim-trace.ts";

const NOW = 1_000_000;
// These tests commit thousands of rows one by one; the default synchronous=FULL makes that fsync-bound
// (over 20 s on a Windows runner). Durability is not what they check.
function noFsync() { database().exec("PRAGMA synchronous=OFF"); }
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); jobs.resetMemoryClaimCursor?.(); noFsync(); });
afterEach(() => { delete process.env.MURAGE_TURN_TRACE; resetBacklogTrace(); vi.restoreAllMocks(); });

/** Seed `count` capture jobs over `scopes` scopes with a few KB of text each. `mix` adds every
 * state the claim has to skip or admit: deferred later, expired lease, live lease, attempts
 * exhausted, retired source, failed tool outcome, working source, complete. */
function seed(count: number, scopes: number, mix = false) {
  const db = database();
  db.exec("BEGIN");
  for (let s = 0; s < scopes; s++) db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(`scope-${String(s).padStart(3, "0")}`, `owner-${s}`);
  const text = "the quick brown fox jumps over the lazy dog. ".repeat(80);
  for (let i = 0; i < count; i++) {
    const scope = `scope-${String((i * 7) % scopes).padStart(3, "0")}`;
    let state = "active", outcome = "recorded", kind = "text", status = "pending", retry = 0, attempts = 0, lease = 0;
    if (mix) {
      const m = i % 12;
      if (m === 1) { status = "deferred"; retry = NOW + 5000; }
      else if (m === 2) { status = "deferred"; retry = NOW - 1; attempts = 1; }
      else if (m === 3) { status = "leased"; lease = NOW - 10; }
      else if (m === 4) { status = "leased"; lease = NOW + 10_000; }
      else if (m === 5) { status = "pending"; attempts = 3; }
      else if (m === 6) state = "retired";
      else if (m === 7) { kind = "tool-outcome"; outcome = "failed"; }
      else if (m === 8) outcome = "working";
      else if (m === 9) status = "complete";
      else if (m === 10) status = "partial";
    }
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,1,?,?,?,?,NULL,?)").run(`src-${i}`, scope, `thread-${i % 50}`, `m${i}`, null, `h${i}`, kind, "owner", outcome, state);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,?)").run(`src-${i}`, `h${i}`, JSON.stringify({ text: `${i} ${text}` }), 1);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1',?,?,?,?,0,0)")
      .run(`job-${String(i).padStart(5, "0")}`, `src-${i}`, status, retry, attempts, lease);
  }
  db.exec("COMMIT");
}

/** The claim query as it was before this change: the oracle for order and filters. */
const OLD_CLAIM = `SELECT j.*,s.scope_id,s.kind,s.speaker,s.outcome,
      length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS total_bytes
      FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
      JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision
      WHERE s.state='active' AND s.outcome!='working' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed') AND j.attempts<3 AND j.retry_at<=?
      AND (j.status IN ('pending','partial','deferred') OR (j.status='leased' AND j.lease_until<?))
      AND (? IS NULL OR (j.stage='capture' AND s.scope_id IN (SELECT value FROM json_each(?))))
      ORDER BY CASE WHEN s.scope_id>? THEN 0 ELSE 1 END,s.scope_id,j.rowid LIMIT 1`;
const OLD_RECENT = OLD_CLAIM.replace("CASE WHEN s.scope_id>? THEN 0 ELSE 1 END,s.scope_id,j.rowid", "j.rowid DESC");

function oracleSequence(recent?: string[]) {
  const db = database();
  const saved = db.prepare("SELECT id,status,lease_owner,lease_generation,lease_until FROM memory_jobs").all();
  const out: string[] = [];
  let last = "";
  for (;;) {
    const r = recent ? JSON.stringify(recent) : null;
    const row = db.prepare(recent ? OLD_RECENT : OLD_CLAIM).get(...(recent ? [NOW, NOW, r, r] : [NOW, NOW, null, null, last]));
    if (!row) break;
    out.push(String(row.id));
    if (!recent) last = String(row.scope_id);
    db.prepare("UPDATE memory_jobs SET status='leased',lease_until=? WHERE id=?").run(NOW + 30000, row.id);
  }
  for (const r of saved) db.prepare("UPDATE memory_jobs SET status=?,lease_owner=?,lease_generation=?,lease_until=? WHERE id=?").run(r.status, r.lease_owner, r.lease_generation, r.lease_until, r.id);
  return out;
}
function newSequence(recent?: string[]) {
  const out: string[] = [];
  for (;;) { const w = jobs.claimMemoryJob("w", NOW, recent); if (!w) break; out.push(w.id); }
  return out;
}

describe("claim cost", () => {
  it("reads at most one payload per claim, and only for the chosen job", () => {
    seed(4000, 60);
    const db = database();
    const sql: string[] = [];
    const real = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((text: string) => { sql.push(text); return real(text); }) as typeof db.prepare);
    const work = jobs.claimMemoryJob("w", NOW);
    expect(work?.text.length).toBeGreaterThan(3000);
    const payloadReads = sql.filter(text => text.includes("payload"));
    expect(payloadReads.length).toBe(1);
    expect(payloadReads[0]).toContain("source_id=? AND revision=?");
    // choosing the job never mentions the versions table at all
    const choosing = sql.slice(0, sql.indexOf(payloadReads[0]));
    expect(choosing.filter(text => text.includes("memory_source_versions"))).toEqual([]);
  });

  it("chooses the job with no sort and no scan of the versions table", () => {
    seed(200, 10);
    const db = database();
    const q = jobs.MEMORY_CLAIM_SQL;
    const params: Record<string, SQLInputValue[]> = { anyOpen: [NOW, NOW], scope: ["", NOW, NOW], head: [NOW, NOW, "scope-001"], recent: [NOW, NOW, '["scope-001"]'], row: [1] };
    for (const name of ["anyOpen", "scope", "head", "row"] as const) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${q[name]}`).all(...params[name]).map(r => String(r.detail)).join("\n");
      expect(plan, name).not.toMatch(/TEMP B-TREE/);
      expect(plan, name).not.toMatch(/memory_source_versions/);
      expect(plan, name).not.toMatch(/SCAN (j|memory_jobs)\b/);
    }
    const recentPlan = db.prepare(`EXPLAIN QUERY PLAN ${q.recent}`).all(...params.recent).map(r => String(r.detail)).join("\n");
    expect(recentPlan).not.toMatch(/TEMP B-TREE/);
    expect(recentPlan).not.toMatch(/memory_source_versions/);
  });

  it("with nothing claimable does one indexed existence check and opens no write transaction", () => {
    seed(300, 5);
    database().exec("UPDATE memory_jobs SET status='complete'");
    const db = database();
    const sql: string[] = [];
    const real = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((text: string) => { sql.push(text); return real(text); }) as typeof db.prepare);
    const exec = vi.spyOn(db, "exec");
    expect(jobs.claimMemoryJob("w", NOW)).toBeNull();
    expect(sql).toEqual([jobs.MEMORY_CLAIM_SQL.anyOpen]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("claim equivalence with the previous query", () => {
  it("claims the same job ids in the same order over a seed with every state", () => {
    seed(900, 17, true);
    const expected = oracleSequence();
    expect(expected.length).toBeGreaterThan(300);
    expect(new Set(expected).size).toBe(expected.length);
    // round robin: consecutive claims move across scopes before returning to one
    const scopes = expected.slice(0, 17).map(id => database().prepare("SELECT s.scope_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").get(id)!.scope_id);
    expect(new Set(scopes).size).toBe(17);
    expect(newSequence()).toEqual(expected);
  });

  it("claims the same job ids in recent-scopes mode", () => {
    seed(400, 9, true);
    const recent = ["scope-002", "scope-005", "scope-008"];
    const expected = oracleSequence(recent);
    expect(expected.length).toBeGreaterThan(20);
    expect(newSequence(recent)).toEqual(expected);
  });

  it("wraps to the lowest scope when the last one served was the highest", () => {
    seed(30, 3);
    const first = jobs.claimMemoryJob("w", NOW)!, second = jobs.claimMemoryJob("w", NOW)!, third = jobs.claimMemoryJob("w", NOW)!, fourth = jobs.claimMemoryJob("w", NOW)!;
    expect([first.scopeId, second.scopeId, third.scopeId, fourth.scopeId]).toEqual(["scope-000", "scope-001", "scope-002", "scope-000"]);
  });
});

describe("pacing and trace", () => {
  it("leaves no pause after a cheap cycle and holds synchronous work to a quarter of wall time otherwise", () => {
    expect(memoryTickGapMs(0.4)).toBe(0);
    expect(memoryTickGapMs(1.9)).toBe(0);
    for (const busy of [2, 10, 50, 120]) expect(busy / (busy + memoryTickGapMs(busy))).toBeLessThanOrEqual(0.25);
    expect(memoryTickGapMs(5000)).toBe(15000);  // no one-second ceiling: a long cycle still gets three times its length
  });

  it("logs the backlog at start and when it crosses a power of ten, only under MURAGE_TURN_TRACE=1", () => {
    const lines: string[] = [];
    traceBacklog(5, l => lines.push(l)); traceSlowStep("memory.claim", 80, l => lines.push(l));
    expect(lines).toEqual([]);
    process.env.MURAGE_TURN_TRACE = "1";
    for (const n of [5, 7, 9, 10, 40, 99, 100, 250, 99, 9]) traceBacklog(n, l => lines.push(l));
    expect(lines).toEqual([
      "[turn-trace] phase=memory.backlog start=true pending=5",
      "[turn-trace] phase=memory.backlog pending=10",
      "[turn-trace] phase=memory.backlog pending=100",
      "[turn-trace] phase=memory.backlog pending=99",
      "[turn-trace] phase=memory.backlog pending=9",
    ]);
  });

  it("logs a step only when it held the loop over 50 ms, by name and milliseconds", () => {
    process.env.MURAGE_TURN_TRACE = "1";
    const lines: string[] = [];
    traceSlowStep("memory.claim", 50, l => lines.push(l));
    traceSlowStep("memory.claim", 73.4, l => lines.push(l));
    expect(lines).toEqual(["[turn-trace] phase=memory.claim slow=true ms=73"]);
  });
});
