// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 revoke fold (REVOKE-FOLD-DESIGN r3 + r4): the 1.0.2 backlog of audience-only per-receipt jobs is folded into one bulk walk per cohort.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { commitRevoke, inheritMarks, undoRevoke } from "./revoke-commit.ts";
import { holdRevoke, MARKER_STEP_RESERVE, markerSlice, markerWorkPending, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { foldCohorts, REVOKE_FOLD } from "./revoke-fold.ts";
import * as foldModule from "./revoke-fold.ts";
import { activateRevokesAtUpgrade } from "./schema.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import { denyLookup, refsLookup } from "./deny-read.ts";
import { FLIP_DRAIN_MAX } from "./receipt-outputs.ts";
import { CONTENT, MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { changes, flipAll, SHARED, storm, THREADS } from "./testing/revoke-storm-fixture.ts";

type Db = DatabaseSync;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256, cap = Number.POSITIVE_INFINITY) => tx(db, () => markerSlice(db, rows, Number.POSITIVE_INFINITY, null, cap));
const drainAll = (db: Db) => { for (let n = 0; n < 200_000; n++) if (!slice(db)) return n; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const pathOf = (db: Db) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
const foldJob = (db: Db) => db.prepare("SELECT revoke_id AS r,root,root_lsn,started_lsn,state,phase FROM memory_revoke_jobs WHERE json_valid(root) AND json_extract(root,'$.cause')='fold' ORDER BY revoke_id").all() as Array<{ r: number; root: string; root_lsn: number; started_lsn: number; state: string; phase: string }>;
const ids = (db: Db, sql: string, ...a: Array<string | number>) => (db.prepare(sql).all(...a) as Array<{ r: number }>).map(row => Number(row.r));
const PEND_MIN = "SELECT min(since_lsn) AS n FROM memory_deny_pending WHERE thread_id IN (?,'*')";
const memberRows = (db: Db, members: readonly number[]) => ["memory_deny_pending", "memory_deny_pending_scope", "memory_revoke_frontier", "memory_revoke_reached"]
  .reduce((sum, t) => sum + n(db, `SELECT count(*) AS n FROM ${t} WHERE revoke_id IN (SELECT value FROM json_each(?))`, JSON.stringify(members)), 0);

/** The 1.0.2 backlog: `count` receipts flipped before the flip queue, each committed as its own audience job (kind receipt). Job `mid` is
 * mid-mark with inherited frontier nodes, a hold row and a line mark. Every commit slot is above every fixture position. */
function legacy(count: number, mid = Math.min(3, count - 1), order: readonly number[] = Array.from({ length: count }, (_, i) => i)): { fx: WritetimeFixture; jobs: number[] } {
  const fx = storm(count);
  fx.db.prepare("UPDATE memory_disclosures SET state='revoked'").run();
  fx.db.exec("DELETE FROM memory_receipt_flips");
  // `order`: the receipts in commit order (jobs[k] is the k-th commit, receipt b{order[k]})
  const jobs = tx(fx.db, () => order.map(i => commitRevoke(fx.db, { kind: "receipt", bundleId: `b${i}`, cause: "receipt-revoked" }, { inline: false })));
  const M = jobs[mid]!;
  tx(fx.db, () => {
    fx.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(M);
    fx.db.prepare("DELETE FROM memory_revoke_frontier WHERE revoke_id=? AND seq<0").run(M); // its flow phase is over
    fx.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,100,?),(?,101,?)").run(M, JSON.stringify({ kind: "line", threadId: "inh-a", lsn: 500 }), M, JSON.stringify({ kind: "line", threadId: "inh-b", lsn: 501 }));
    holdRevoke(fx.db, M, "bk-1");
    fx.denyLine(THREADS[0]!, 10, M);
  });
  return { fx, jobs };
}

afterEach(() => setScopeFlowEdgesRecorded(false));

describe("T1 backlog fold", () => {
  it("122 legacy jobs, one mid-mark with inherited nodes and a hold: ONE cohort, one bulk B, every window held, then one walk", () => {
    const { fx, jobs } = legacy(122);
    const db = fx.db;
    try {
      setScopeFlowEdgesRecorded(true); fx.cert(false); // the certificate is not ready at listen
      const roots = (db.prepare("SELECT min(root_lsn) AS lo, max(started_lsn) AS hi, min(started_lsn) AS s FROM memory_revoke_jobs WHERE revoke_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(jobs))) as { lo: number; hi: number; s: number };
      const sourceMarks = n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE seq>0 AND revoke_id IN (SELECT value FROM json_each(?))", JSON.stringify(jobs));
      // the cohort count is pinned: no turn position lies in [lo, hi), so the whole backlog is ONE cohort
      expect(foldCohorts(db, jobs.map(id => ({ id, kind: "receipt", root: {}, rootLsn: 0, started: n(db, "SELECT started_lsn AS n FROM memory_revoke_jobs WHERE revoke_id=?", id) })))).toHaveLength(1);
      expect(slice(db)).toBe(true); // listen: (0) open
      let [B] = foldJob(db);
      expect(B).toMatchObject({ state: "seeding", root_lsn: roots.lo, started_lsn: roots.hi });
      expect(JSON.parse(B!.root)).toEqual({ kind: "bulk", cause: "fold", cohort: { lo: roots.s, hi: roots.hi, ids: jobs } });
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*' AND revoke_id=? AND since_lsn=?", B!.r, roots.lo)).toBe(1);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id='*' AND revoke_id=? AND since_lsn=?", B!.r, roots.lo)).toBe(1);
      let slices = 0;
      while (foldJob(db)[0]!.state === "seeding") {
        expect(markerWorkPending(db)).toBe(true);
        if (++slices === 3) fx.cert(true); // turning ready mid-fold
        slice(db, 64);
        expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*' AND revoke_id=?", B!.r)).toBeGreaterThan(0);
      }
      [B] = foldJob(db);
      expect(B!.state).toBe("active");
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE bulk_id=?", B!.r)).toBe(122);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='folded'")).toBe(122);
      expect(memberRows(db, jobs)).toBe(0);
      // every old mark node under B (with one fresh receipt node per re-committed root); only hold: rows copied
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0", B!.r)).toBe(sourceMarks + 122);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND node LIKE '%inh-%'", B!.r)).toBe(2);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=?", B!.r)).toBe(1);
      // every member's pending rows were copied into B's flow (DRAIN-104 section 4): B's closure is certified, so its '*' rows end at its
      // flow gate (before 1.0.4 they went with its tidy)
      expect(JSON.parse(foldJob(db)[0]!.root)).toMatchObject({ narrow: 1, closureIds: jobs.map((_, i) => i) });
      for (let k = 0; k < 10_000 && foldJob(db)[0]!.phase === "flow"; k++) slice(db, 64);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*' AND revoke_id=?", B!.r)).toBe(0);
      drainAll(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id IN (SELECT value FROM json_each(?))", JSON.stringify(jobs))).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", B!.r)).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND id=?", SHARED.id)).toBeGreaterThanOrEqual(1);
    } finally { fx.close(); }
  });

  it("differential: the folded walk withholds a superset of a per-job run of each root, equal on lines and sessions", () => {
    const a = legacy(6), b = legacy(6);
    try {
      drainAll(a.fx.db); // folded
      expect(foldJob(a.fx.db)).toHaveLength(1);
      // per-job: every root walks on its own (the 1.0.2 behaviour)
      REVOKE_FOLD.enabled = false;
      try { drainAll(b.fx.db); } finally { REVOKE_FOLD.enabled = true; }
      expect(foldJob(b.fx.db)).toHaveLength(0);
      const set = (db: Db, sql: string) => new Set((db.prepare(sql).all() as Array<{ k: string }>).map(r => r.k));
      const lines = "SELECT DISTINCT thread_id||':'||lsn AS k FROM memory_deny_line WHERE revoke_id>0";
      const sessions = "SELECT DISTINCT thread_id||':'||driver_instance||':'||native_session AS k FROM memory_deny_session";
      const memory = "SELECT DISTINCT kind||':'||id||':'||version AS k FROM memory_deny_memory";
      expect(set(a.fx.db, lines)).toEqual(set(b.fx.db, lines));
      expect(set(a.fx.db, sessions)).toEqual(set(b.fx.db, sessions));
      for (const k of set(b.fx.db, memory)) expect(set(a.fx.db, memory).has(k)).toBe(true);
      for (const r of b.fx.db.prepare("SELECT thread_id AS t,from_lsn AS f,until_turn_lsn AS u FROM memory_deny_range").all() as Array<{ t: string; f: number; u: number }>)
        expect(n(a.fx.db, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id=? AND from_lsn<=? AND until_turn_lsn>=?", r.t, r.f, r.u)).toBeGreaterThan(0);
    } finally { a.fx.close(); b.fx.close(); }
  });
});

describe("T2 crash mid-fold, writes between stages", () => {
  it("a restart after every slice (and a rolled-back slice) resumes one bulk; written lines land once; no window rises", () => {
    const { fx, jobs } = legacy(12);
    const file = pathOf(fx.db);
    try {
      let written = 0, flips = 0, last = Number.NEGATIVE_INFINITY;
      const floors = THREADS.map(T => n(fx.db, PEND_MIN, T));
      const sourceMarks = n(fx.db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE seq>0 AND revoke_id IN (SELECT value FROM json_each(?))", JSON.stringify(jobs));
      for (let k = 0; k < 2000; k++) {
        const db = new DatabaseSync(file); // a new process: listen again
        try {
          if (k === 5) { db.exec("BEGIN IMMEDIATE"); markerSlice(db, 8); db.exec("ROLLBACK"); } // crashed before its commit
          const [B] = foldJob(db);
          if (B && B.state !== "seeding") break;
          if (B) expect(markerWorkPending(db)).toBe(true);
          slice(db, 8);
          const after = foldJob(db);
          expect(after.filter(j => j.state === "seeding").length).toBeLessThanOrEqual(1);
          if (after[0]?.state === "active") expect(memberRows(db, jobs)).toBe(0);
          for (const [i, T] of THREADS.entries()) expect(n(db, PEND_MIN, T)).toBeLessThanOrEqual(floors[i]!);
          // between slices: a line written under a member's deny row, and (every 4th) a new receipt flip
          tx(db, () => inheritMarks(db, { kind: "line", threadId: "late", lsn: 3000 + written }, [], [{ threadId: THREADS[0]!, from: 10, to: 10 }]));
          written++;
          if (k % 4 === 0 && flips < 3) { db.prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id=?").run(`b${flips}`); db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(`b${flips}`); flips++; }
          last = k;
        } finally { db.close(); }
      }
      expect(last).toBeGreaterThan(5);
      const folds = foldJob(fx.db);
      expect(folds[0]!.state).toBe("active");
      const B = folds[0]!.r;
      expect(n(fx.db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE bulk_id=?", B)).toBe(12);
      // the pending copy ran for every member across the restarts, each counted once (DRAIN-104 section 4)
      expect(JSON.parse(folds[0]!.root)).toMatchObject({ narrow: 1, closureIds: Array.from({ length: 12 }, (_, i) => i) });
      // each written line once (under B, or under the member and then copied); no duplicate root
      expect(n(fx.db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND node LIKE '%\"late\"%'", B)).toBe(written);
      expect(n(fx.db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0", B)).toBe(sourceMarks + 12 + written);
      // a second listen opens nothing new for B's cohort
      const again = new DatabaseSync(file);
      try { slice(again); expect(foldJob(again).filter(j => JSON.parse(j.root).cohort.ids.some((id: number) => jobs.includes(id)))).toHaveLength(1); } finally { again.close(); }
    } finally { fx.close(); }
  });
});

describe("T3 undo", () => {
  it("undo of one root is refused at every stage, of B, and after B is pruned or recreated by inheritance; a drain bulk is refused too (DRAIN-104 2.5)", () => {
    const { fx, jobs } = legacy(6);
    const db = fx.db;
    const snap = () => ["memory_revoke_jobs", "memory_deny_pending", "memory_revoke_frontier", "memory_revoke_fold"].map(t => n(db, `SELECT count(*) AS n FROM ${t}`)).join(",");
    const refused = (id: number) => { const before = snap(); expect(() => tx(db, () => undoRevoke(db, id))).toThrow("MEMORY_REVOKE_UNDO_BULK"); expect(snap()).toBe(before); };
    try {
      slice(db); // open: members listed, none enrolled
      const B = foldJob(db)[0]!.r;
      refused(jobs[5]!); refused(B);
      while (foldJob(db)[0]!.state === "seeding") { slice(db, 2); refused(jobs[0]!); refused(jobs[5]!); }
      expect(denyLookup(db, { threadId: THREADS[1]!, lines: [{ messageId: "r1", author: "bot" as never }] }, MEMBER).get("r1")!.state).not.toBe("shown");
      drainAll(db);
      // R2: a content forget of the same record, undone, leaves B's denial in force
      const F = tx(db, () => commitRevoke(db, { kind: "memory", ref: SHARED, cause: "forget" }, { inline: false }));
      drainAll(db);
      tx(db, () => undoRevoke(db, F));
      drainAll(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE id=? AND revoke_id=?", SHARED.id, B)).toBe(1);
      // B pruned (a later job is newer): still refused
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=?", B)).toBe(0);
      refused(B); refused(jobs[1]!);
      // late inheritance onto a pruned B recreates it under B's id; it is still refused, and a later listen never folds it
      tx(db, () => inheritMarks(db, { kind: "line", threadId: "late", lsn: 4000 }, [], [{ threadId: THREADS[0]!, from: 10, to: 10 }]));
      expect(db.prepare("SELECT kind FROM memory_revoke_jobs WHERE revoke_id=?").get(B)).toMatchObject({ kind: "inherit" });
      refused(B);
      const other = new DatabaseSync(pathOf(db));
      try { slice(other); expect(n(other, "SELECT count(*) AS n FROM memory_revoke_fold WHERE old_id=?", B)).toBe(0); } finally { other.close(); }
      drainAll(db);
    } finally { fx.close(); }
    const s = storm(4);
    try {
      flipAll(s);
      slice(s.db);
      const [bulk] = ids(s.db, "SELECT revoke_id AS r FROM memory_revoke_jobs WHERE kind='bulk' AND state='active'");
      const before = n(s.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='undoing'");
      expect(() => tx(s.db, () => undoRevoke(s.db, bulk!))).toThrow("MEMORY_REVOKE_UNDO_BULK");
      expect(n(s.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='undoing'")).toBe(before);
      drainAll(s.db);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE revoke_id=?", bulk!)).toBeGreaterThan(0);
    } finally { s.close(); }
  });
});

describe("T4 a turn during the fold", () => {
  it("audience readers read checking throughout; a line written on a member's denied parent is marked under B; the owner's direct chat passes", () => {
    const { fx } = legacy(8);
    const db = fx.db;
    try {
      fx.reply(THREADS[0]!, "room-late", 3100, { turnLsn: 3099 });
      slice(db);
      const B = foldJob(db)[0]!.r;
      let k = 0;
      while (foldJob(db)[0]!.state === "seeding") {
        const page = { threadId: THREADS[1]!, lines: [{ messageId: "r1", author: "bot" as never }] };
        expect(denyLookup(db, page, MEMBER).get("r1")!.state).toBe("checking");
        expect(denyLookup(db, page, CONTENT).get("r1")!.state).toBe("shown");
        if (k++ === 2) tx(db, () => inheritMarks(db, { kind: "line", threadId: THREADS[0]!, lsn: 3100 }, [], [{ threadId: THREADS[0]!, from: 10, to: 10 }]));
        slice(db, 4);
      }
      for (let guard = 0; guard < 100_000 && n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND state IN ('active','seeding')", B); guard++) {
        expect(denyLookup(db, { threadId: THREADS[0]!, lines: [{ messageId: "room-late", author: "bot" as never }] }, MEMBER).get("room-late")!.state).not.toBe("shown");
        slice(db);
      }
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id=? AND lsn=3100 AND revoke_id=?", THREADS[0]!, B)).toBe(1);
      expect(denyLookup(db, { threadId: THREADS[0]!, lines: [{ messageId: "room-late", author: "bot" as never }] }, MEMBER).get("room-late")!.state).toBe("withheld");
    } finally { fx.close(); }
  });
});

describe("T5 positions and cohorts", () => {
  // two eligible jobs (b0 in storm-a, b1 in storm-b); `setup` puts a turn position between their caps on b0's own thread
  const two = (setup: (fx: WritetimeFixture, s1: number, s2: number) => void) => {
    const { fx, jobs } = legacy(2);
    try {
      const [s1, s2] = jobs.map(id => n(fx.db, "SELECT started_lsn AS n FROM memory_revoke_jobs WHERE revoke_id=?", id)) as [number, number];
      setup(fx, s1, s2);
      drainAll(fx.db);
      return { folds: foldJob(fx.db).length, fx, s1, s2 };
    } catch (e) { fx.close(); throw e; }
  };
  it("a prompt begun between two commits splits them: session first_lsn, line turn_lsn; that turn's line and session are denied by neither", () => {
    // the turn began at s1 (job 1's cap, inside [s1, s2)): job 1 does not deny it, and no merged cap s2 may
    for (const setup of [
      (fx: WritetimeFixture, s1: number) => { fx.sessionLineage(THREADS[0]!, "fuigo", "sx", s1, s1 + 1); },
      (fx: WritetimeFixture, s1: number, s2: number) => { fx.reply(THREADS[0]!, "lx", s2 + 5, { turnLsn: s1 }); },
    ]) {
      const { folds, fx, s1 } = two(setup);
      try {
        expect(folds).toBe(0);
        expect(n(fx.db, "SELECT count(*) AS n FROM memory_revoke_fold")).toBe(0);
        // the line begun at s1 is shown; b0's own reply (turn 9, below its cap) is withheld
        const seen = denyLookup(fx.db, { threadId: THREADS[0]!, lines: [{ messageId: "lx", author: "bot" as never }, { messageId: "r0", author: "bot" as never }] }, MEMBER);
        expect(seen.get("r0")!.state).toBe("withheld");
        if (n(fx.db, "SELECT count(*) AS n FROM messages WHERE id='lx'")) expect(seen.get("lx")!.state).toBe("shown");
        expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_range WHERE thread_id=? AND until_turn_lsn>?", THREADS[0]!, s1)).toBe(0);
        expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=? AND native_session='sx'", THREADS[0]!)).toBe(0);
        expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=? AND native_session='s0'", THREADS[0]!)).toBeGreaterThan(0);
      } finally { fx.close(); }
    }
  });
  it("two roots with different caps in one thread, either walk order: lines begun before the caps are denied, a turn at or after hi is not", () => {
    // b0 and b4 both land in storm-a; commit order [b0..b4] walks b0's root first, the reverse order walks b4's first (B's frontier is in
    // ids order). Either way B's one cap is hi, every range in the thread stops at hi, and the same lines are withheld.
    const outcome = (order: number[]) => {
      const { fx, jobs } = legacy(5, 2, order);
      try {
        const caps = jobs.map(id => n(fx.db, "SELECT started_lsn AS n FROM memory_revoke_jobs WHERE revoke_id=?", id));
        const capOf = (bundle: number) => caps[order.indexOf(bundle)]!;
        expect(capOf(0)).not.toBe(capOf(4));
        const hi = Math.max(...caps);
        fx.reply(THREADS[0]!, "mid", 900, { turnLsn: 899 }); // begun below both caps, after both roots' lines
        fx.reply(THREADS[0]!, "at-hi", hi + 2, { turnLsn: hi });
        fx.reply(THREADS[0]!, "after-hi", hi + 4, { turnLsn: hi + 3 });
        drainAll(fx.db);
        const folds = foldJob(fx.db);
        expect(folds).toHaveLength(1);
        const B = folds[0]!;
        // B's walk caps at its cohort's hi, its members' own cap (FOLD-MEMBER-CAP); its started_lsn (the pending windows' cap) is its
        // activation slot, above hi
        expect(JSON.parse(B.root).cohort.hi).toBe(hi);
        expect(B.started_lsn).toBeGreaterThan(hi);
        // the walk order is the commit order: B's cohort ids are the jobs in revoke_id order, so b{order[0]}'s root is re-committed first
        expect(JSON.parse(B.root).cohort.ids).toEqual(jobs);
        const ranges = fx.db.prepare("SELECT from_lsn AS f,until_turn_lsn AS u FROM memory_deny_range WHERE thread_id=? AND revoke_id=? ORDER BY from_lsn").all(THREADS[0]!, B.r) as Array<{ f: number; u: number }>;
        expect(ranges.length).toBeGreaterThan(0);
        for (const r of ranges) expect(r.u).toBe(hi);
        const lines = ["r0", "r4", "mid", "at-hi", "after-hi"];
        const seen = denyLookup(fx.db, { threadId: THREADS[0]!, lines: lines.map(messageId => ({ messageId, author: "bot" as never })) }, MEMBER);
        const states = Object.fromEntries(lines.map(l => [l, seen.get(l)!.state]));
        expect(states).toEqual({ r0: "withheld", r4: "withheld", mid: "withheld", "at-hi": "shown", "after-hi": "shown" });
        const sessions = (fx.db.prepare("SELECT native_session AS s FROM memory_deny_session WHERE thread_id=? ORDER BY native_session").all(THREADS[0]!) as Array<{ s: string }>).map(r => r.s);
        expect(sessions).toEqual(expect.arrayContaining(["s0", "s4"]));
        // the coverage, not the row shape: walking b4's root first leaves a second range from b0's earlier line, both capped at hi
        return { states, sessions, from: Math.min(...ranges.map(r => r.f)), caps: [...new Set(ranges.map(r => r.u))] };
      } finally { fx.close(); }
    };
    const forward = outcome([0, 1, 2, 3, 4]), backward = outcome([4, 3, 2, 1, 0]);
    expect(backward).toEqual(forward);
  });
  it("overlapping open turns: one below lo and one between split; both outside [lo, hi) do not (r4 A1)", () => {
    const run = (positions: (s1: number, s2: number) => number[]) => {
      const { fx, jobs } = legacy(2);
      const [s1, s2] = jobs.map(id => n(fx.db, "SELECT started_lsn AS n FROM memory_revoke_jobs WHERE revoke_id=?", id)) as [number, number];
      const open = positions(s1, s2).map((p, i) => { fx.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(p + 1); return openTurnLineage(fx.db, { threadId: `ot-${i}`, turnId: `t${i}` }); });
      fx.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(s2 + 100);
      try { slice(fx.db); return foldJob(fx.db).length; } finally { for (const t of open) closeTurnLineage(t); fx.close(); }
    };
    expect(run((s1) => [s1 - 50, s1])).toBe(0);
    expect(run((s1, s2) => [s1 - 50, s2 + 10])).toBe(1);
    expect(run(() => [])).toBe(1);
  });
  it("a turn begun at or after hi is not denied by B; one before its root's cap is", () => {
    const { fx } = legacy(4);
    try {
      fx.reply(THREADS[0]!, "after-hi", 3200, { turnLsn: 3199 });
      drainAll(fx.db);
      const B = foldJob(fx.db)[0]!, hi = Number(JSON.parse(B.root).cohort.hi);
      expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=? AND until_turn_lsn=?", B.r, hi)).toBeGreaterThan(0);
      expect(n(fx.db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=? AND until_turn_lsn>?", B.r, hi)).toBe(0);
      const seen = denyLookup(fx.db, { threadId: THREADS[0]!, lines: [{ messageId: "after-hi", author: "bot" as never }, { messageId: "r4", author: "bot" as never }] }, MEMBER);
      expect(seen.get("r4")!.state).toBe("withheld");
      expect(seen.get("after-hi")!.state).toBe("shown");
    } finally { fx.close(); }
  });
});

describe("T6 runtime burst", () => {
  it("two drains in two slices fold into one walk; a drain while B marks is not joined; drains either side of a seeding fold fold with each other", () => {
    const fx = storm(12);
    const db = fx.db;
    try {
      slice(db); // listen with nothing to fold
      flipAll(fx);
      // a cap that commits part of the flips per slice: two drains, two flow bulks
      while (n(db, "SELECT count(*) AS n FROM memory_receipt_flips")) slice(db, 256, 30);
      const drains = ids(db, "SELECT revoke_id AS r FROM memory_revoke_jobs WHERE kind='bulk' AND state='active' AND phase='flow'");
      expect(drains.length).toBeGreaterThanOrEqual(2);
      slice(db);
      const [B] = foldJob(db);
      expect(JSON.parse(B!.root).cohort.ids).toEqual(drains);
      for (let step = 0, extra = 0; foldJob(db)[0]!.state === "seeding"; step++) {
        // two drains either side of the seeding fold's slices (its re-commits take slots between them)
        if (extra < 2 && step % 3 === 1) { db.prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id=?").run(`b${extra}`); db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(`b${extra}`); extra++; }
        slice(db, 4);
      }
      const later = ids(db, "SELECT revoke_id AS r FROM memory_revoke_jobs WHERE kind='bulk' AND state='active' AND phase='flow' AND root LIKE '%receipt-revoked%'");
      expect(later).toHaveLength(2);
      slice(db);
      const folds = foldJob(db);
      expect(folds).toHaveLength(2);
      expect(JSON.parse(folds[1]!.root).cohort.ids).toEqual(later);
      expect(JSON.parse(folds[1]!.root).cohort.ids).not.toContain(B!.r);
      // B marks; a third drain opens its own bulk and is not joined
      for (let g = 0; g < 10_000 && foldJob(db).find(j => j.r === B!.r)?.phase === "flow"; g++) slice(db, 16);
      while (foldJob(db).find(j => j.r === folds[1]!.r)?.state === "seeding") slice(db);
      db.prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id='b9'").run(); db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b9'").run();
      slice(db); slice(db);
      expect(n(db, "SELECT count(DISTINCT bulk_id) AS n FROM memory_revoke_fold")).toBe(2);
      expect(foldJob(db).some(j => j.state === "seeding")).toBe(false);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE bulk_id IN (?,?)", folds[0]!.r, folds[1]!.r)).toBe(drains.length + 2);
      drainAll(db);
    } finally { fx.close(); }
  });
});

describe("T7 bounds", () => {
  it("FLIP_DRAIN_MAX + 1 eligible jobs make two cohorts", () => {
    const fx = new WritetimeFixture();
    try {
      const jobs = Array.from({ length: FLIP_DRAIN_MAX + 1 }, (_, i) => ({ id: i + 1, kind: "receipt", root: {}, rootLsn: 1, started: 5000 + i }));
      expect(foldCohorts(fx.db, jobs).map(c => c.ids.length)).toEqual([FLIP_DRAIN_MAX, 1]);
    } finally { fx.close(); }
  });
  it("a one-row budget pages the map, the copy and the cleanup over many slices, each admitted; a child under 40 member ids is held once", () => {
    const { fx, jobs } = legacy(40);
    const db = fx.db;
    try {
      for (const id of jobs) fx.denyLine(THREADS[1]!, 11, id);
      slice(db, 1);
      const B = foldJob(db)[0]!.r;
      let slices = 0;
      while (foldJob(db)[0]!.state === "seeding") { expect(slice(db, 1)).toBe(true); slices++; }
      expect(slices).toBeGreaterThan(40 * 4);
      tx(db, () => inheritMarks(db, { kind: "line", threadId: "child", lsn: 5000 }, [], [{ threadId: THREADS[1]!, from: 11, to: 11 }]));
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE node LIKE '%\"child\"%'")).toBe(1);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND node LIKE '%\"child\"%'", B)).toBe(1);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='child'")).toBe(1);
      drainAll(db);
    } finally { fx.close(); }
  });
});

describe("T7 bound: no fold step exceeds the slice cap", () => {
  it("a synthetic 122-job, 6k-row backlog: every fold slice and every slice of B's tidy stays within the cap; the walk within cap + reserve", () => {
    const { fx, jobs } = legacy(122);
    const db = fx.db;
    const CAP = 64;
    try {
      // 6,000 hold rows on one member (each its own bookkeeping job, long gone): the hold copy and B's hold phase page them
      tx(db, () => { const ins = db.prepare("INSERT INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,0)"); for (let k = 0; k < 6000; k++) ins.run(jobs[3]!, `hold:bk-gone-${k}`); });
      const total = () => changes(fx);
      let foldMax = 0, tidyMax = 0, allMax = 0, slices = 0, tidySlices = 0, heldAtActivation = -1;
      for (let guard = 0; guard < 200_000; guard++) {
        const before = foldJob(db)[0];
        const c0 = total();
        const moved = slice(db, 4, CAP);
        const used = total() - c0;
        allMax = Math.max(allMax, used); slices++;
        if (!before || before.state === "seeding") foldMax = Math.max(foldMax, used);
        else if (before.phase === "tidy" || before.phase === "hold") { tidyMax = Math.max(tidyMax, used); tidySlices++; }
        // at activation every hold row of every member is under B, copied a page per slice from the saved key
        if (before?.state === "seeding" && foldJob(db)[0]!.state === "active") heldAtActivation = n(db, "SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=? AND thread_id LIKE 'hold:%'", before.r);
        if (!moved) break;
      }
      expect(heldAtActivation).toBe(6001);
      const B = n(db, "SELECT bulk_id AS n FROM memory_revoke_fold LIMIT 1");
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE bulk_id=?", B)).toBe(122);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='folded'")).toBe(0); // B's tidy took the member rows, page by page
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding')")).toBe(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_reached WHERE thread_id LIKE 'hold:%'")).toBe(0);
      expect(tidySlices).toBeGreaterThan(122 / 4);
      expect({ foldMax: foldMax <= CAP, tidyMax: tidyMax <= CAP }).toEqual({ foldMax: true, tidyMax: true });
      expect(allMax).toBeLessThanOrEqual(CAP + MARKER_STEP_RESERVE);
      expect(slices).toBeGreaterThan(6000 / 4);
    } finally { fx.close(); }
  }, 300_000);
});

describe("T8 no backlog", () => {
  it("no fold runs; an ordinary forget walks as before", () => {
    const fx = storm(4);
    try {
      tx(fx.db, () => commitRevoke(fx.db, { kind: "memory", ref: SHARED, cause: "forget" }, { inline: false }));
      drainAll(fx.db);
      expect(foldJob(fx.db)).toHaveLength(0);
      expect(n(fx.db, "SELECT count(*) AS n FROM memory_revoke_fold")).toBe(0);
      expect(refsLookup(fx.db, [{ kind: "memory", ref: SHARED }], CONTENT).state).toBe("withheld");
    } finally { fx.close(); }
  });
});

describe("T8 DRAIN-104 section 4: a certified fold bulk ends its '*' window at its flow gate", () => {
  // read through the namespace so this block loads (and fails on its assertions) against the 1.0.3 fold too
  const knob = () => (foldModule as unknown as { FOLD_CLOSURE?: { enabled: boolean } }).FOLD_CLOSURE ?? { enabled: false };
  const X = ["x-t1", "x-t2", "x-t3"];
  afterEach(() => { knob().enabled = true; });
  /** legacy(6): member 0 (flow phase) expanded x-t1 (its pending row) and still holds a flow item for x-t2; the mid member (mark phase) holds
   * rows for x-t3 and a scope. */
  function closureLegacy(): { fx: WritetimeFixture; jobs: number[] } {
    const L = legacy(6);
    const db = L.fx.db, A = L.jobs[0]!, M = L.jobs[3]!;
    tx(db, () => {
      db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,5,?)").run(X[0]!, A);
      db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,-90,?)").run(A, JSON.stringify({ node: X[1], since: 5 }));
      db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,5,?)").run(X[2]!, M);
      db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-x',5,?)").run(M);
    });
    setScopeFlowEdgesRecorded(true);
    return L;
  }
  const cursor = (db: Db, B: number) => JSON.parse(String((db.prepare("SELECT cursor FROM memory_revoke_jobs WHERE revoke_id=?").get(B) as { cursor: string }).cursor) || "{}").fold as { stage: string; job: number; pk?: unknown } | undefined;
  /** Slices until B has left its flow phase (the gate ran); returns B's row then. */
  function toGate(db: Db, rows = 64): ReturnType<typeof foldJob>[number] {
    for (let k = 0; k < 10_000; k++) { const [B] = foldJob(db); if (B && B.state === "active" && B.phase !== "flow") return B; slice(db, rows); }
    throw new Error("unbounded");
  }
  const star = (db: Db, B: number) => n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*' AND revoke_id=?", B) + n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id='*' AND revoke_id=?", B);
  const held = (db: Db, B: number) => [...X.map(T => n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?", T, B)), n(db, "SELECT count(*) AS n FROM memory_deny_pending_scope WHERE scope_id='s-x' AND revoke_id=?", B)];

  it("a member's expanded thread, its flow item and a mark-phase member's rows are B's after its gate, and no '*' row is left", () => {
    const { fx } = closureLegacy();
    try {
      const B = toGate(fx.db);
      expect(JSON.parse(B.root)).toMatchObject({ narrow: 1, closureIds: [0, 1, 2, 3, 4, 5] });
      expect(star(fx.db, B.r)).toBe(0);
      expect(held(fx.db, B.r)).toEqual([1, 1, 1, 1]);
    } finally { fx.close(); }
  });

  it("stopped mid pending copy and resumed by the 1.0.3 fold on the same file: holds next, no early sweep, '*' kept", () => {
    const { fx, jobs } = closureLegacy();
    const file = pathOf(fx.db);
    try {
      let k = 0;
      for (; k < 10_000; k++) { const [B] = foldJob(fx.db); const c = B && cursor(fx.db, B.r); if (c?.stage === "frontier" && c.pk !== undefined && c.job === 3) break; slice(fx.db, 1); }
      const B = foldJob(fx.db)[0]!.r;
      const later = memberRows(fx.db, jobs.slice(4)), own = n(fx.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", jobs[3]!);
      expect(later).toBeGreaterThan(0);
      knob().enabled = false; // the 1.0.3 fold: reads stage "frontier" past the member's last seq, moves to "holds", ignores pk
      const db = new DatabaseSync(file);
      try {
        slice(db, 1);
        expect(cursor(db, B)).toMatchObject({ stage: "holds", job: 3 });
        expect(cursor(db, B)!.pk).toBeUndefined();
        expect(memberRows(db, jobs.slice(4))).toBe(later); // nothing swept early
        expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", jobs[3]!)).toBe(own); // the member's rows wait for its clean
        const row = toGate(db);
        expect(JSON.parse(row.root).narrow).toBeUndefined();
        expect(star(db, B)).toBeGreaterThan(0); // not certified: '*' kept to the tidy
      } finally { db.close(); }
    } finally { fx.close(); }
  });

  it("a fold with one member cleaned before the rule gets no narrow and keeps '*'", () => {
    const { fx } = closureLegacy();
    try {
      knob().enabled = false;
      for (let k = 0; k < 10_000; k++) { const [B] = foldJob(fx.db); const c = B && cursor(fx.db, B.r); if (c && c.job >= 1 && c.stage === "root") break; slice(fx.db, 1); }
      knob().enabled = true;
      const B = toGate(fx.db);
      expect(JSON.parse(B.root).closureIds).toEqual([1, 2, 3, 4, 5]);
      expect(JSON.parse(B.root).narrow).toBeUndefined();
      expect(star(fx.db, B.r)).toBeGreaterThan(0);
    } finally { fx.close(); }
  });

  it("rewound by repairFoldMap after a v10 round trip: the member counted once, and '*' kept (reupgraded)", () => {
    const { fx } = closureLegacy();
    const db = fx.db;
    try {
      for (let k = 0; k < 10_000; k++) { const [B] = foldJob(db); const c = B && cursor(db, B.r); if (c?.stage === "holds" && c.job === 2) break; slice(db, 1); }
      const B = foldJob(db)[0]!.r;
      expect(JSON.parse(foldJob(db)[0]!.root).closureIds).toEqual([0, 1, 2]);
      // the v10 round trip: the map is lost, the upgrade marks the bulk reupgraded and the repair rewinds B to member 2's frontier copy
      db.exec("DELETE FROM memory_revoke_fold");
      tx(db, () => { activateRevokesAtUpgrade(db); foldModule.repairFoldMap(db); });
      expect(cursor(db, B)).toMatchObject({ stage: "frontier", job: 2 });
      const row = toGate(db);
      expect(JSON.parse(row.root)).toMatchObject({ reupgraded: 1, closureIds: [0, 1, 2, 3, 4, 5] });
      expect(star(db, B)).toBeGreaterThan(0);
    } finally { fx.close(); }
  });
});
