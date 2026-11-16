// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOKE_FOLD } from "./revoke-fold.ts";
import { COVER_TRACE, markerSlice } from "./revoke-marker.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
const make = () => { const f = new WritetimeFixture().cert(true); fixtures.push(f); return f; };
beforeEach(() => { REVOKE_FOLD.enabled = false; });
afterEach(() => { REVOKE_FOLD.enabled = true; COVER_TRACE.on = false; COVER_TRACE.served.length = 0; for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
function job(f: WritetimeFixture, id: number, started: number, audience = true, thread = false) {
  f.db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,1,?,'mark','','active')").run(id, thread ? "thread" : "inherit", JSON.stringify(thread ? { kind: "thread", threadId: "T", cause: "delete-conversation" } : { kind: "inherit", cause: "inherit" }), started);
  if (audience) f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(id);
}
const run = (f: WritetimeFixture) => { COVER_TRACE.on = true; COVER_TRACE.served.length = 0; f.db.exec("BEGIN"); try { markerSlice(f.db, 1, Infinity, null, Infinity); f.db.exec("COMMIT"); } catch (e) { f.db.exec("ROLLBACK"); throw e; } };
const ready = (f: WritetimeFixture) => {
  // Install the fixture index independently of the implementation export, so
  // baseline failures reach selection/progress behavior rather than setup.
  f.db.exec("CREATE INDEX IF NOT EXISTS memory_revoke_jobs_mark_cap ON memory_revoke_jobs(started_lsn DESC,revoke_id) WHERE state='active' AND phase='mark'");
};
describe("bounded walker selection", () => {
  it("R13 1000 mark candidates use the cap index and examine at most 64 job rows", () => {
    const f = make(); ready(f);
    for (let i = 1; i <= 1000; i++) job(f, i, i);
    const sql: string[] = [], reads: number[] = [];
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation((text: string) => {
      const stmt = prepare(text); sql.push(text);
      if (/FROM memory_revoke_jobs/.test(text) && /phase='mark'/.test(text)) {
        const all = stmt.all.bind(stmt);
        vi.spyOn(stmt, "all").mockImplementation((...args) => { const rows = all(...args); reads.push(rows.length); return rows; });
      }
      return stmt;
    });
    run(f);
    expect(Math.max(...reads)).toBeLessThanOrEqual(64);
    const selection = sql.find(s => /INDEXED BY memory_revoke_jobs_mark_cap/.test(s));
    expect(selection).toBeTruthy();
    expect(prepare(`EXPLAIN QUERY PLAN ${selection}`).all().map(r => r.detail).join(" ")).toContain("memory_revoke_jobs_mark_cap");
  });
  it("R13 raw noncoverable prefixes have bounded SQL VM work before eligibility probes", () => {
    const steps: number[] = [];
    for (const n of [1000, 10000]) {
      const f = make(); ready(f);
      f.db.exec("BEGIN");
      job(f, 1, 1, true);
      for (let i = 2; i <= n; i++) job(f, i, i, false);
      f.db.exec("COMMIT");
      const queries: string[] = [];
      const prepare = f.db.prepare.bind(f.db);
      vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => { queries.push(sql); return prepare(sql); });
      run(f);
      const selection = queries.find(sql => sql.includes("INDEXED BY memory_revoke_jobs_mark_cap"));
      expect(selection).toBeTruthy();
      const file = String(prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file);
      const measured = spawnSync("python3", ["-c", `import sqlite3,sys,json
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
steps=0
def tick():
 global steps
 steps+=1
 return 0
c.set_progress_handler(tick,1)
rows=c.execute(sys.argv[2]).fetchall()
print(json.dumps({'steps':steps,'rows':len(rows)}))
`, file, selection!], { encoding: "utf8" });
      expect(measured.status, measured.stderr).toBe(0);
      const result = JSON.parse(measured.stdout);
      expect(result.rows).toBe(64); expect(result.steps).toBeLessThan(5000);
      steps.push(result.steps);
    }
    expect(Math.abs(steps[1] - steps[0])).toBeLessThan(100);
  });
  it("R14 seeded random sets up to 64 preserve class priority, cap and lowest-ID ties", () => {
    let seed = 1729;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let n = 1; n <= 64; n += 7) {
      const f = make(); ready(f);
      const rows = Array.from({ length: n }, (_, i) => { const audience = random() < .6, thread = !audience; const started = 2 + Math.floor(random() * 8); return { id: i + 1, audience, thread, started, cap: started }; });
      for (const r of rows) {
        job(f, r.id, r.started, r.audience, r.thread);
        if (r.audience && random() < .5) {
          r.cap = Math.max(1, r.started - 2);
          f.db.prepare("UPDATE memory_revoke_jobs SET kind='bulk',root=? WHERE revoke_id=?").run(JSON.stringify({ cause: "fold", cohort: { hi: r.cap } }), r.id);
        }
      }
      rows.sort((a, b) => Number(a.audience) - Number(b.audience) || b.cap - a.cap || a.id - b.id);
      run(f);
      expect(COVER_TRACE.served.find(r => r.cls === "walker")?.job).toBe(rows[0].id);
    }
  });
  it("R15 without the optional index an ordinary bounded walk makes progress", () => {
    const f = make(); ready(f); f.db.exec("DROP INDEX memory_revoke_jobs_mark_cap"); job(f, 1, 10);
    f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(1,1,?)").run(JSON.stringify({ kind: "range", threadId: "T", fromLsn: 1 }));
    const reads: number[] = [], prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (/FROM memory_revoke_jobs/.test(sql)) {
        const all = stmt.all.bind(stmt);
        vi.spyOn(stmt, "all").mockImplementation((...args) => { const rows = all(...args); reads.push(rows.length); return rows; });
      }
      return stmt;
    });
    for (let i = 0; i < 12 && f.db.prepare("SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=1").get(); i++) run(f);
    expect(f.db.prepare("SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=1").get()?.n).toBe(0);
    expect(f.db.prepare("SELECT 1 FROM memory_revoke_reached WHERE revoke_id=1 AND thread_id='T'").get()).toBeTruthy();
    expect(Math.max(...reads)).toBeLessThanOrEqual(16);
    expect(COVER_TRACE.served.some(row => row.cls === "walker")).toBe(false);
  });
});
