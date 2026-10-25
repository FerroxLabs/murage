// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SELF-OVERLOAD-105 item 1 (deletion cover): N conversation deletions cost about one whole-store walk, as N audience drains do under
// DRAIN-104. Section 1's failure list, one block per item. Every test asserts the privacy fact AND that the mechanism fired (COVER_PROBE),
// so it fails on 1.0.4 (no DELETION_COVER knob: every deletion walks on its own and the probe shows no skip). The new exports are read
// through the module object so this file loads (and fails on its assertions) against the base marker too.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import { commitRevoke, undoRevoke } from "./revoke-commit.ts";
import * as fold from "./revoke-fold.ts";
import { denyLookup } from "./deny-read.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { CARRY_CHILD_CODE, lineChildRef, OBJECT_EDGE_LSN, objectCarryThread, recordChildRef, turnChildRef, type FrontierNode, type MemoryRef } from "./lineage-types.ts";
import { CONTENT, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
const M = marker as unknown as Record<string, any>;
type Probe = { skips: number; enqueueSkips: number; pointPasses: number; partial: number; handlerRuns: number; waits: number; coverRows: number; cleanups: number };
const probe = (): Probe => ({ ...(M.COVER_PROBE as Probe) });
/** Work the cover saved a follower: visits skipped (at the pop or the enqueue), covered ranges point-passed, ranges walked only partly. */
const saved = (p: Probe) => p.skips + p.enqueueSkips + p.pointPasses + p.partial;
const COVER_REVOKE = -3;
const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null));
const drainAll = (db: Db, rows = 256) => { for (let k = 0; k < 200_000; k++) if (!slice(db, rows)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const jobRow = (db: Db, id: number) => db.prepare("SELECT state,phase FROM memory_revoke_jobs WHERE revoke_id=?").get(id) as { state: string; phase: string } | undefined;
const deletionCover = (on: boolean) => { if (M.DELETION_COVER) M.DELETION_COVER.enabled = on; };

/** Store writers (the rows S1's writers leave), as revoke-cover.test.ts builds them. */
class Store {
  constructor(readonly fx: WritetimeFixture) {}
  get db(): Db { return this.fx.db; }
  line(T: string, lsn: number, generated: boolean, turnLsn = lsn - 1): this {
    if (generated) this.fx.reply(T, `${T}-${lsn}`, lsn, { turnLsn }); else this.fx.owner(T, `${T}-${lsn}`, lsn);
    return this;
  }
  carry(T: string, from: number, to: number, child: { line: [string, number] } | { turn: [string, number] } | { ref: MemoryRef }): this {
    const row = "line" in child ? [CARRY_CHILD_CODE.line, lineChildRef(child.line[1]), testThreadNo(this.db, child.line[0])]
      : "turn" in child ? [CARRY_CHILD_CODE.turn, turnChildRef(child.turn[1]), testThreadNo(this.db, child.turn[0])]
      : [CARRY_CHILD_CODE.record, recordChildRef(child.ref), 0];
    this.db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, T), to, from, row[0]!, row[1]!, row[2]!);
    return this;
  }
  consumer(ref: { kind: "source" | "record"; id: string }, child: [string, number]): this {
    this.db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, objectCarryThread(ref)), OBJECT_EDGE_LSN, OBJECT_EDGE_LSN, CARRY_CHILD_CODE.line, lineChildRef(child[1]), testThreadNo(this.db, child[0]));
    return this;
  }
  capture(T: string, lsn: number, id: string, scope = "s-room"): this {
    this.fx.source(id, scope, { thread: T, message: `${T}-${lsn}` });
    this.db.prepare("INSERT OR IGNORE INTO memory_line_capture(thread_no,lsn,source_id) VALUES(?,?,?)").run(testThreadNo(this.db, T), lsn, id);
    return this;
  }
  session(T: string, ns: string, first: number, last: number): this { this.fx.sessionLineage(T, "fuigo", ns, first, last); return this; }
  receipt(b: string, T: string, lsn: number, records: readonly string[]): this {
    this.db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'fuigo',?,?,'[]','[]',0,0,0,'delivered',0)")
      .run(b, T, `ns-${b}`, JSON.stringify(records.map(id => ({ id, version: 1 }))));
    noteReceiptOutput(this.db, b, T, lsn, { driverInstance: "fuigo", nativeSession: `ns-${b}` });
    return this;
  }
  head(next = 5000): this { this.db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(next); return this; }
}
const store = () => { const fx = new WritetimeFixture(); fx.cert(true); return new Store(fx); };

function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** A store of chats sharing memory: every carry's last line is a generated line whose turn began before every cap (the deletions come after
 * the whole history, as on a real store), so the per-job walk and the covered walk reach the same facts under any pop order. */
function sharedStore(seed: number, size = 1): Store {
  const rnd = mulberry(seed), s = store();
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const TH = ["ta", "tb", "tc", "td", "te", "tf"];
  const lines = new Map<string, number[]>(TH.map(t => [t, []])), gen = new Map<string, number[]>(TH.map(t => [t, []]));
  const N = 120 * size;
  for (let lsn = 1; lsn <= N; lsn++) {
    const T = TH[(lsn - 1) % TH.length]!, g = Math.floor((lsn - 1) / TH.length) % 2 === 1; // rounds alternate owner and generated lines in every chat
    s.line(T, lsn, g, Math.min(lsn - 1, 3));
    lines.get(T)!.push(lsn); if (g) gen.get(T)!.push(lsn);
  }
  for (const T of TH) for (let k = 0; k < 2; k++) { const first = 1 + Math.floor(rnd() * N), last = first + Math.floor(rnd() * 40); s.session(T, `${T}-s${k}`, first, last); }
  const sources: string[] = [];
  for (let k = 0; k < 20 * size; k++) { const T = pick(TH), id = `src${k}`; s.capture(T, pick(gen.get(T)!), id); sources.push(id); }
  const records: string[] = [];
  for (let k = 0; k < 16 * size; k++) { const id = `rec${k}`; s.fx.record(id, 1, rnd() < 0.3 ? "s-bot" : "s-room", [...new Set([pick(sources), pick(sources)])]); records.push(id); }
  for (let k = 0; k < 8 * size; k++) { const a = pick(records), b = pick(records); if (a !== b) { try { s.fx.derive(a, 1, b, 1); } catch { /* duplicate */ } } }
  for (let k = 0; k < 90 * size; k++) {
    const P = pick(TH), from = pick(lines.get(P)!), ends = gen.get(P)!.filter(l => l >= from && l <= from + 18);
    if (!ends.length) continue;
    const to = pick(ends), Q = pick(TH.filter(t => t !== P)), r = rnd();
    if (r < 0.45) s.carry(P, from, to, { line: [Q, pick(lines.get(Q)!)] });
    else if (r < 0.6) s.carry(P, from, to, { turn: [Q, pick(gen.get(Q)!) - 1] });
    else if (r < 0.8) s.carry(P, from, to, { ref: { kind: "record", id: pick(records), version: 1 } });
    else s.carry(P, from, to, { ref: { kind: "source", id: pick(sources) } });
  }
  for (let k = 0; k < 8 * size; k++) { const T = pick(TH); s.consumer(rnd() < 0.5 ? { kind: "source", id: pick(sources) } : { kind: "record", id: pick(records) }, [T, pick(lines.get(T)!)]); }
  for (let k = 0; k < 6 * size; k++) { const T = pick(TH); s.receipt(`bun${k}`, T, pick(gen.get(T)!), [pick(records), pick(records)]); }
  s.head();
  return s;
}
const deleteThread = (db: Db, T: string) => tx(db, () => commitRevoke(db, { kind: "thread", threadId: T, cause: "delete-conversation" }));

/** The facts a reader sees, revoke ids aside: deny_line, deny_memory and deny_session as sets, deny_range as (thread, from, until) rows. */
function facts(db: Db) {
  const set = (sql: string) => new Set((db.prepare(sql).all() as Array<Record<string, unknown>>).map(r => JSON.stringify(Object.values(r))));
  return {
    lines: set("SELECT thread_id,lsn FROM memory_deny_line ORDER BY 1,2"),
    memory: set("SELECT kind,id,version FROM memory_deny_memory ORDER BY 1,2,3"),
    sessions: set("SELECT thread_id,driver_instance,native_session FROM memory_deny_session ORDER BY 1,2,3"),
    ranges: (db.prepare("SELECT thread_id t,from_lsn f,until_turn_lsn u FROM memory_deny_range").all() as Array<{ t: string; f: number; u: number }>),
  };
}
function expectSameFacts(a: ReturnType<typeof facts>, b: ReturnType<typeof facts>): void {
  for (const key of ["lines", "memory", "sessions"] as const) {
    for (const k of b[key]) expect(a[key].has(k), `${key} ${k} missing with cover`).toBe(true);
    for (const k of a[key]) expect(b[key].has(k), `${key} ${k} extra with cover`).toBe(true);
  }
  const held = (rows: typeof a.ranges, r: { t: string; f: number; u: number }) => rows.some(x => x.t === r.t && x.f <= r.f && x.u >= r.u);
  for (const r of b.ranges) expect(held(a.ranges, r), `range ${JSON.stringify(r)} missing with cover`).toBe(true);
  for (const r of a.ranges) expect(held(b.ranges, r), `range ${JSON.stringify(r)} extra with cover`).toBe(true);
}
/** The content verdict of every generated line of every chat (the owner's reader). */
function verdicts(db: Db): string {
  const rows = db.prepare("SELECT l.thread_no,t.thread_id,l.message_id FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE l.turn_lsn IS NOT NULL ORDER BY l.thread_no,l.lsn").all() as Array<{ thread_id: string; message_id: string }>;
  const byThread = new Map<string, string[]>();
  for (const row of rows) byThread.set(row.thread_id, [...(byThread.get(row.thread_id) ?? []), row.message_id]);
  const out: string[] = [];
  for (const [threadId, ids] of byThread) {
    const seen = denyLookup(db, { threadId, lines: ids.map(messageId => ({ messageId, author: "generated" as const })) }, CONTENT);
    for (const id of ids) out.push(`${threadId}:${id}=${seen.get(id)?.state}`);
  }
  return out.join("\n");
}

beforeEach(() => { fold.REVOKE_FOLD.enabled = false; marker.REVOKE_COVER.enabled = true; deletionCover(true); M.resetCoverProbe?.(); marker.setScopeFlowEdgesRecorded(true); });
afterEach(() => { fold.REVOKE_FOLD.enabled = true; marker.REVOKE_COVER.enabled = true; deletionCover(true); });

describe("1 D: N deletions cost about one walk, with the per-job walk's facts (fail-before: the knob and the skips)", () => {
  for (const seed of [1, 2, 3]) {
    it(`differential on a shared store (seed ${seed}): four deletions, cover on vs per job`, () => {
      expect(M.DELETION_COVER, "the deletion cover knob exists").toBeDefined();
      const on = sharedStore(seed), off = sharedStore(seed);
      try {
        for (const T of ["ta", "tc", "te", "tb"]) { deleteThread(on.db, T); deleteThread(off.db, T); }
        M.resetCoverProbe?.();
        deletionCover(true); drainAll(on.db);
        const p = probe();
        deletionCover(false); drainAll(off.db); deletionCover(true);
        // the mechanism fired: deletions skipped under a deletion coverer
        const reached = on.db.prepare("SELECT revoke_id r,count(*) n FROM memory_revoke_reached GROUP BY 1").all();
        const jobs = on.db.prepare("SELECT revoke_id r,state,phase FROM memory_revoke_jobs").all();
        expect(saved(p), `work saved under the deletion cover; probe ${JSON.stringify(p)} reached ${JSON.stringify(reached)} jobs ${JSON.stringify(jobs)}`).toBeGreaterThan(0);
        expect(p.coverRows, "cover rows written by a deletion walker").toBeGreaterThan(0);
        // the facts are the per-job walk's (the owner's reader sees the same verdicts)
        expectSameFacts(facts(on.db), facts(off.db));
        expect(verdicts(on.db)).toBe(verdicts(off.db));
        // every job finished; no window left open
        expect(n(on.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'")).toBe(0);
        expect(n(on.db, "SELECT count(*) AS n FROM memory_deny_pending")).toBe(0);
      } finally { on.fx.close(); off.fx.close(); }
    });
  }
  it("four deletions: the handler walks about once (handler runs with cover well below the per-job walk's)", () => {
    const on = sharedStore(5), off = sharedStore(5);
    try {
      for (const T of ["ta", "tc", "te", "tb"]) { deleteThread(on.db, T); deleteThread(off.db, T); }
      M.resetCoverProbe?.(); deletionCover(true); drainAll(on.db); const withCover = probe().handlerRuns;
      M.resetCoverProbe?.(); deletionCover(false); drainAll(off.db); deletionCover(true);
      // with the cover off no deletion gets a cover context, so the probe counts nothing: count the per-job walk by its reached rows instead
      const perJobVisits = n(off.db, "SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id>0") + n(off.db, "SELECT count(*) AS n FROM memory_deny_memory");
      const coveredVisits = n(on.db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id>0`) + n(on.db, "SELECT count(*) AS n FROM memory_deny_memory");
      expect(withCover).toBeGreaterThan(0);
      expect(coveredVisits, `covered ${coveredVisits} vs per job ${perJobVisits}`).toBeLessThan(perJobVisits);
    } finally { on.fx.close(); off.fx.close(); }
  });
});

describe("2 F1: the class rule. A deletion never skips under an audience coverer; an audience follower skips under a deletion", () => {
  function audienceJob(db: Db, id: number, cap: number, nodes: readonly FrontierNode[]): number {
    db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,'mark','','active')")
      .run(id, "inherit", JSON.stringify({ kind: "inherit", cause: "inherit" }), cap, cap);
    db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(id);
    for (const node of nodes) marker.enqueueNode(db, id, node);
    return id;
  }
  it("an audience job (higher cap) walked source s0 and record rec0 to hold; a deletion reaching them walks them itself and writes content marks", () => {
    const s = sharedStore(7);
    try {
      const db = s.db;
      // the audience coverer at a cap above any deletion's, as its finished walk leaves it: done in phase done (a counting row), its audience
      // marks on s0 and rec0, and its cover rows for both visits (coverKey), still present because another audience job is active
      // (cap 9000: above the deletion's commit slot, which is above the store's head of 5000, so only the class rule can refuse the row)
      const A = audienceJob(db, 900, 9000, []);
      db.prepare("UPDATE memory_revoke_jobs SET phase='done',state='done' WHERE revoke_id=?").run(A);
      // (the deletion's quiet tidy cleans the rows afterwards; the trace records at the skip, so the question is answered before that)
      for (const [kind, id, version] of [["source", "src0", 0], ["record", "rec0", 1]] as const) {
        db.prepare("INSERT OR IGNORE INTO memory_deny_memory(kind,id,version,revoke_id) VALUES(?,?,?,?)").run(kind, id, version, A);
        const key = kind === "source" ? `s:${id}` : `r:${id}:${version}`;
        db.prepare("INSERT OR IGNORE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,?)").run(COVER_REVOKE, M.coverKey(key, 0, A), 9000);
      }
      expect(n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=${COVER_REVOKE}`)).toBe(2);
      // a deletion whose walk reaches src0 and rec0 (seeded directly into its frontier, so the reach is certain)
      const D = deleteThread(db, "tf");
      expect(Number((db.prepare("SELECT started_lsn AS c FROM memory_revoke_jobs WHERE revoke_id=?").get(D) as { c: number }).c)).toBeLessThan(9000);
      tx(db, () => { marker.enqueueNode(db, D, { kind: "source", id: "src0" }); marker.enqueueNode(db, D, { kind: "record", id: "rec0", version: 1 }); });
      M.resetCoverProbe?.(); M.COVER_TRACE.on = true;
      try { drainAll(db); } finally { M.COVER_TRACE.on = false; }
      // whatever skipped (the audience follower 901 may, under the deletion's rows), nothing skipped under A's rows
      expect((M.COVER_TRACE.coverers as number[]).includes(A), "no skip was granted by the audience coverer's rows").toBe(false);
      // no skip under the audience coverer: the deletion's own content marks exist for both
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='source' AND id='src0' AND revoke_id=?", D)).toBe(1);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND id='rec0' AND revoke_id=?", D)).toBe(1);
      // and the content reader is withheld on them by a content mark (an audience-only mark would not do)
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='source' AND id='src0' AND revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience)")).toBeGreaterThan(0);
    } finally { s.fx.close(); }
  });
  it("a deletion walked to hold; an audience job (lower cap) reaching the same source skips under it", () => {
    const s = sharedStore(8);
    try {
      const db = s.db;
      const D = deleteThread(db, "ta");
      tx(db, () => marker.enqueueNode(db, D, { kind: "source", id: "src1" }));
      const cap = Number((db.prepare("SELECT started_lsn AS c FROM memory_revoke_jobs WHERE revoke_id=?").get(D) as { c: number } | undefined)?.c ?? 0);
      // an audience job below the deletion's cap, queued beside it: the deletion outranks it as the walker; once the deletion holds, its
      // cover rows count for the audience follower (the rows are cleaned only when no coverable job is left, F8)
      const A = audienceJob(db, 950, Math.max(1, cap - 1), [{ kind: "source", id: "src1" }]);
      M.resetCoverProbe?.();
      drainAll(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='source' AND id='src1' AND revoke_id=?", D)).toBe(1);
      expect(probe().skips, "the audience follower skipped under the deletion's cover").toBeGreaterThan(0);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='source' AND id='src1' AND revoke_id=?", A)).toBe(0);
      expect(jobRow(db, A)?.state ?? "done").not.toBe("active");
    } finally { s.fx.close(); }
  });
});

describe("3 F2: a deletion is never undone (its marks stand for the jobs that skipped under them)", () => {
  it("foldRefusesUndo is true for a deletion and undoRevoke changes no row of it", () => {
    const s = sharedStore(9);
    try {
      const db = s.db;
      const D = deleteThread(db, "tb");
      expect(marker.foldRefusesUndo(db, D)).toBe(true);
      const before = n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=?", D);
      expect(before).toBeGreaterThan(0);
      expect(() => tx(db, () => undoRevoke(db, D))).toThrow(/MEMORY_REVOKE_UNDO_BULK/);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=?", D)).toBe(before);
      expect(jobRow(db, D)?.state).toBe("active");
      // finished and pruned (a newer revoke took the max id): still refused (Astra 105 review, finding 1)
      drainAll(db);
      const later = deleteThread(db, "tc"); drainAll(db);
      expect(later).toBeGreaterThan(D);
      expect(jobRow(db, D)).toBeUndefined();
      const walked = n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=?", D);
      expect(marker.foldRefusesUndo(db, D)).toBe(true);
      expect(() => tx(db, () => undoRevoke(db, D))).toThrow(/MEMORY_REVOKE_UNDO_BULK/);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=?", D)).toBe(walked);
    } finally { s.fx.close(); }
  });
});

describe("4 F3 + F7: a follower waits while the coverer still walks; its own windows stay until its frontier is empty", () => {
  it("two deletions: the second skips nothing until the first's frontier is empty, and its pending rows go only with its last pop", () => {
    const s = sharedStore(10);
    try {
      const db = s.db;
      const A = deleteThread(db, "ta"), B = deleteThread(db, "tc"); // B has the greater cap: it is the walker, A the follower
      M.resetCoverProbe?.();
      // one small slice at a time: while B (the walker) has a head, A only waits (no skip anywhere)
      let sawWait = false;
      for (let k = 0; k < 20_000; k++) {
        const row = jobRow(db, B);
        if (!row || row.state !== "active" || row.phase === "hold" || row.phase === "tidy") break; // the walker's frontier is empty: its rows count from here
        const walking = row.phase === "mark" && n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0", B) > 0;
        const before = probe();
        if (!slice(db, 8)) break;
        if (walking) expect(saved(probe()), "no skip while the coverer walks").toBe(saved(before));
        if (probe().waits > 0) sawWait = true;
      }
      expect(sawWait, "the follower waited on an uncovered head").toBe(true);
      expect(jobRow(db, A)?.state).toBe("active");
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", A)).toBeGreaterThan(0);
      // A's windows stay until A's own frontier is empty; then A skipped what B covered
      drainAll(db, 8);
      expect(n(db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", A)).toBe(0);
      expect(jobRow(db, A)?.state ?? "done").not.toBe("active");
      expect(saved(probe())).toBeGreaterThan(0);
    } finally { s.fx.close(); }
  });
});

describe("5 F8: the cover rows are cleaned only when no coverable job (audience or deletion) is left", () => {
  it("after the last deletion's tidy, no COVER_REVOKE row remains", () => {
    const s = sharedStore(11);
    try {
      const db = s.db;
      for (const T of ["ta", "tb", "tc"]) deleteThread(db, T);
      drainAll(db);
      expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'")).toBe(0);
      expect(n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=${COVER_REVOKE}`)).toBe(0);
      expect(probe().cleanups).toBeGreaterThan(0);
    } finally { s.fx.close(); }
  });
});

describe("6 F6: the knob off is 1.0.4 (every deletion walks on its own: no cover row, no skip)", () => {
  it("with DELETION_COVER off, two deletions write no cover row", () => {
    const s = sharedStore(12);
    try {
      deletionCover(false);
      const db = s.db;
      deleteThread(db, "ta"); deleteThread(db, "tb");
      M.resetCoverProbe?.();
      drainAll(db);
      expect(probe().skips).toBe(0);
      expect(n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=${COVER_REVOKE}`)).toBe(0);
    } finally { deletionCover(true); s.fx.close(); }
  });
});
