// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The revoke fold across a round trip: 1.0.3 folds the 1.0.2 backlog, "Prepare to reinstall" steps the file to v10 (the fold map
// memory_revoke_fold is dropped: 1.0.2 refuses it), 1.0.2 runs on the file, then 1.0.3 opens it again. The fold bulks' job rows and their
// cohort ids are v10 rows and stay; 1.0.3 rebuilds the map from them at open, and moves to the bulk whatever 1.0.2 wrote under a folded id
// (1.0.2 does not know the map, so it enqueues and holds under the member's own id, which no slice serves once the member is folded).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { commitRevoke } from "./revoke-commit.ts";
import { holdRevoke, markerSlice, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { repairFoldMap } from "./revoke-fold.ts";
import { downgradeMemorySchema, ensureRevokeLateObjects, migrateMemorySchema } from "./schema.ts";
import { denyLookup } from "./deny-read.ts";
import { MEMBER, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { storm, THREADS } from "./testing/revoke-storm-fixture.ts";
import { BRANCH_TABLES_SQL } from "../branch-index.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => markerSlice(db, rows, Number.POSITIVE_INFINITY, null, Number.POSITIVE_INFINITY));
const drainAll = (db: Db) => { for (let k = 0; k < 200_000; k++) if (!slice(db)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const pathOf = (db: Db) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
const foldJob = (db: Db) => db.prepare("SELECT revoke_id AS r,root,state,phase,cursor FROM memory_revoke_jobs WHERE json_valid(root) AND json_extract(root,'$.cause')='fold' ORDER BY revoke_id").all() as Array<{ r: number; root: string; state: string; phase: string; cursor: string }>;
const hasMap = (db: Db) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_revoke_fold'").get());

/** The 1.0.2 backlog (revoke-fold.test.ts legacy): `count` audience receipt jobs; job `mid` carries a line mark on THREADS[0] lsn 10. */
function legacy(count: number, mid = 3): { fx: WritetimeFixture; jobs: number[]; M: number } {
  const fx = storm(count);
  fx.db.prepare("UPDATE memory_disclosures SET state='revoked'").run();
  fx.db.exec("DELETE FROM memory_receipt_flips");
  // the shapes a real file has (the step to v10 validates the file first)
  fx.db.exec("UPDATE memory_scopes SET audience='[]'; UPDATE memory_records SET assertion='owner-statement'");
  fx.db.exec("INSERT OR IGNORE INTO memory_record_details(record_id,record_version,partition,attention,claim_status) SELECT id,version,'semantic','current','current' FROM memory_records");
  const jobs = tx(fx.db, () => Array.from({ length: count }, (_, i) => commitRevoke(fx.db, { kind: "receipt", bundleId: `b${i}`, cause: "receipt-revoked" }, { inline: false })));
  const M = jobs[mid]!;
  tx(fx.db, () => { holdRevoke(fx.db, M, "bk-1"); fx.denyLine(THREADS[0]!, 10, M); });
  // a line no revoke touches: shown before the round trip, shown after it
  fx.reply("calm", "c1", 900, { turnLsn: 899 });
  return { fx, jobs, M };
}

const LINES: Array<[string, string]> = [["calm", "c1"], ...Array.from({ length: 8 }, (_, i) => [THREADS[i % THREADS.length]!, `r${i}`] as [string, string]), ["late", "late-1"]];
const verdicts = (db: Db) => Object.fromEntries(LINES.map(([threadId, messageId]) => [messageId, denyLookup(db, { threadId, lines: [{ messageId, author: "bot" as never }] }, MEMBER).get(messageId)?.state]));

/** A generated line written on `db` (the fixture's reply, on whichever connection is open now). */
function replyOn(db: Db, thread: string, id: string, lsn: number): void {
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','text','',?)").run(thread, id, Date.now(), JSON.stringify({ id, role: "bot" }));
  db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)").run(testThreadNo(db, thread), lsn, id, lsn - 1);
  db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(lsn + 1);
}
/** "Prepare to reinstall": the real step to v10, on a connection of its own (a process of its own). */
function prepareToReinstall(db: Db): Db {
  const path = pathOf(db);
  db.close();
  const own = new DatabaseSync(path);
  try { expect(downgradeMemorySchema(own, 10)).toEqual({ status: "downgraded", from: 13, to: 10 }); } finally { own.close(); }
  return new DatabaseSync(path);
}
/** What 1.0.2 writes when a line is carried from member M's denied parent (1.0.2 revoke-commit.ts inheritMarks, no map): a job row for M when
 * it has none ('inherit', active, mark), a reactivation when it is done or in hold or tidy, then the child's frontier node and its pending
 * row, all under M's own id. */
function inheritOn102(db: Db, M: number, threadId: string, lsn: number): void {
  tx(db, () => {
    const job = db.prepare("SELECT state,phase FROM memory_revoke_jobs WHERE revoke_id=?").get(M) as { state: string; phase: string } | undefined;
    if (!job) db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(M, JSON.stringify({ kind: "inherit", cause: "inherit" }), lsn, lsn + 1);
    else if (job.state === "done" || job.phase === "hold" || job.phase === "tidy") db.prepare("UPDATE memory_revoke_jobs SET phase='mark',cursor='',state='active' WHERE revoke_id=?").run(M);
    const seq = n(db, "SELECT coalesce(max(seq),0)+1 AS n FROM memory_revoke_frontier WHERE revoke_id=?", M);
    db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,?,?)").run(M, Math.max(1, seq), JSON.stringify({ kind: "line", threadId, lsn }));
    db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(threadId, lsn, M);
    db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
  });
}
/** 1.0.3 opens the file again: the v10 -> v11 migration (ensureRevokeLateObjects inside it), on a new connection. */
function reopen103(db: Db): Db {
  const path = pathOf(db);
  db.close();
  const next = new DatabaseSync(path);
  migrateMemorySchema(next, "active");
  next.exec(BRANCH_TABLES_SQL); // the app's open makes the branch index again (the step to v10 dropped it as derived); the read gate seeks it
  return next;
}

/** Work no slice would ever serve: a pending, scope-pending, frontier or reached row under a folded job or under no job at all. */
const stuck = (db: Db) => ["memory_deny_pending", "memory_deny_pending_scope", "memory_revoke_frontier", "memory_revoke_reached"]
  .reduce((sum, t) => sum + n(db, `SELECT count(*) AS n FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=x.revoke_id AND j.state<>'folded')`), 0);
/** Mark rows of a cohort member whose id resolves neither to a live job nor through the map. */
function unresolved(db: Db, members: readonly number[]): number {
  return ["memory_deny_line", "memory_deny_range", "memory_deny_session", "memory_deny_memory", "memory_deny_pending", "memory_deny_pending_scope", "memory_revoke_frontier"]
    .reduce((sum, t) => sum + n(db, `SELECT count(*) AS n FROM ${t} x WHERE x.revoke_id IN (SELECT value FROM json_each(?))
      AND x.revoke_id NOT IN (SELECT old_id FROM memory_revoke_fold) AND NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=x.revoke_id AND j.state<>'folded')`, JSON.stringify(members)), 0);
}
const foldState = (db: Db) => ["memory_revoke_fold", "memory_revoke_jobs", "memory_revoke_frontier", "memory_deny_pending", "memory_deny_pending_scope", "memory_revoke_reached"]
  .map(t => (db.prepare(`SELECT * FROM ${t}`).all()).map(row => JSON.stringify(row)).sort().join("\n")).join("\n--\n");

afterEach(() => setScopeFlowEdgesRecorded(false));

describe("revoke fold round trip (1.0.3 -> 1.0.2 -> 1.0.3)", () => {
  it("the step to v10 keeps every fold job row and its cohort ids; only the map goes", () => {
    const { fx, jobs } = legacy(8);
    let db = fx.db;
    try {
      while (!foldJob(db).length || foldJob(db)[0]!.state === "seeding") slice(db, 16);
      const [B] = foldJob(db);
      const rows = db.prepare("SELECT * FROM memory_revoke_jobs ORDER BY revoke_id").all();
      db = prepareToReinstall(db);
      expect(hasMap(db)).toBe(false);
      expect(db.prepare("SELECT * FROM memory_revoke_jobs ORDER BY revoke_id").all()).toEqual(rows);
      expect(JSON.parse(String(db.prepare("SELECT root FROM memory_revoke_jobs WHERE revoke_id=?").get(B!.r)!.root)).cohort.ids).toEqual(jobs);
    } finally { try { db.close(); } catch { /* closed */ } fx.close(); }
  });

  it("B walking, members folded: 1.0.2 holds a line under a folded id; back on 1.0.3 the map is rebuilt and nothing reads checking for good", () => {
    const { fx, jobs, M } = legacy(8);
    let db = fx.db;
    try {
      while (!foldJob(db).length || foldJob(db)[0]!.state === "seeding") slice(db, 16);
      const B = foldJob(db)[0]!.r;
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='folded'")).toBe(8);
      const before = verdicts(db);
      expect(before.c1).toBe("checking"); // B's '*' window holds every line to its tidy
      expect(before.r0).toBe("withheld"); // M's line mark (THREADS[0] lsn 10)
      db = prepareToReinstall(db);
      // 1.0.2: a reply carried from M's denied line
      replyOn(db, "late", "late-1", 4000);
      inheritOn102(db, M, "late", 4000);
      db = reopen103(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE bulk_id=?", B)).toBe(8);
      expect(stuck(db)).toBe(0);
      expect(unresolved(db, jobs)).toBe(0);
      drainAll(db);
      const after = verdicts(db);
      expect(after.c1).toBe("shown");
      expect(after.r0).toBe("withheld");
      expect(after["late-1"]).toBe("withheld");
      for (const [, id] of LINES) expect(after[id]).not.toBe("checking");
      for (const [id, state] of Object.entries(before)) if (state === "withheld") expect(after[id]).toBe("withheld");
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending") + n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope")).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='late' AND lsn=4000 AND revoke_id=?", B)).toBe(1);
    } finally { try { db.close(); } catch { /* closed */ } fx.close(); }
  });

  it("fold finished before the downgrade: B's kept row rebuilds the map, 1.0.2's job under a folded id moves to B, verdicts unchanged", () => {
    const { fx, jobs, M } = legacy(8);
    let db = fx.db;
    try {
      drainAll(db);
      const B = foldJob(db)[0]!.r;
      const before = verdicts(db);
      expect(before.c1).toBe("shown");
      db = prepareToReinstall(db);
      replyOn(db, "late", "late-1", 4000);
      inheritOn102(db, M, "late", 4000); // M has no row any more: 1.0.2 makes it an inherit job
      db = reopen103(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE bulk_id=?", B)).toBe(8);
      expect(stuck(db)).toBe(0);
      expect(unresolved(db, jobs)).toBe(0);
      drainAll(db);
      const after = verdicts(db);
      for (const [id, state] of Object.entries(before)) if (id !== "late-1") expect(after[id]).toBe(state);
      expect(after["late-1"]).toBe("withheld");
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending")).toBe(0);
    } finally { try { db.close(); } catch { /* closed */ } fx.close(); }
  });

  it("downgraded mid-fold (B seeding): the map is rebuilt for the enrolled members only, the fold resumes and finishes, nothing is lost", () => {
    for (const stop of [1, 3, 6, 10]) {
      const { fx, jobs, M } = legacy(8);
      let db = fx.db;
      try {
        slice(db); // open
        for (let k = 0; k < stop && foldJob(db)[0]!.state === "seeding"; k++) slice(db, 4);
        const enrolled = n(db, "SELECT count(*) AS n FROM memory_revoke_fold");
        db = prepareToReinstall(db);
        replyOn(db, "late", "late-1", 4000);
        inheritOn102(db, M, "late", 4000);
        db = reopen103(db);
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold")).toBe(enrolled);
        drainAll(db);
        expect(foldJob(db).every(j => j.state === "done")).toBe(true);
        expect(stuck(db)).toBe(0);
        expect(unresolved(db, jobs)).toBe(0);
        const after = verdicts(db);
        expect(after.c1).toBe("shown");
        expect(after.r0).toBe("withheld");
        expect(after["late-1"]).toBe("withheld");
        for (const [, id] of LINES) expect(after[id]).not.toBe("checking");
      } finally { try { db.close(); } catch { /* closed */ } fx.close(); }
    }
  });

  it("the rebuild run twice is a no-op", () => {
    const { fx, M } = legacy(8);
    let db = fx.db;
    try {
      while (!foldJob(db).length || foldJob(db)[0]!.state === "seeding") slice(db, 16);
      db = prepareToReinstall(db);
      replyOn(db, "late", "late-1", 4000);
      inheritOn102(db, M, "late", 4000);
      db = reopen103(db);
      const once = foldState(db);
      ensureRevokeLateObjects(db);
      tx(db, () => repairFoldMap(db));
      expect(foldState(db)).toBe(once);
      db = reopen103(db);
      expect(foldState(db)).toBe(once);
    } finally { try { db.close(); } catch { /* closed */ } fx.close(); }
  });
});
