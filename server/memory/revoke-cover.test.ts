// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DRAIN-104 r6 (audience cover): N flip drains cost about one whole-store walk. Section 6's failure list, one block per item. Every D test
// asserts the privacy fact AND that the mechanism fired (COVER_PROBE / COVER_TRACE), so it fails on 1.0.3 (no probe) and with
// DRAIN104_BASELINE=1 (REVOKE_COVER.enabled = false, the per-job walk); the differential tests compare against that per-job walk.
// The new exports are read through namespace objects so this file loads (and fails on its assertions) against the 1.0.3 marker too.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as marker from "./revoke-marker.ts";
import * as commit from "./revoke-commit.ts";
import * as fold from "./revoke-fold.ts";
import { writeCaptureLineage } from "./lineage-write.ts";
import { refsLookup } from "./deny-read.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { CARRY_CHILD_CODE, FIRST_LSN, lineChildRef, OBJECT_EDGE_LSN, objectCarryThread, recordChildRef, sessionChildRef, turnChildRef, type FrontierNode, type MemoryRef } from "./lineage-types.ts";
import { CONTENT, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

type Db = DatabaseSync;
type Probe = { skips: number; enqueueSkips: number; pointPasses: number; partial: number; sourceLines: number; handlerRuns: number; cheapRuns: number; waits: number; coverRows: number; cleanups: number };
type Trace = { on: boolean; coverers: number[]; enqueueKinds: string[]; served: Array<{ job: number; cls: string }> };
const M = marker as unknown as Record<string, any>, C = commit as unknown as Record<string, any>;
const ZERO: Probe = { skips: 0, enqueueSkips: 0, pointPasses: 0, partial: 0, sourceLines: 0, handlerRuns: 0, cheapRuns: 0, waits: 0, coverRows: 0, cleanups: 0 };
const probe = (): Probe => ({ ...(M.COVER_PROBE as Probe | undefined ?? ZERO) });
const trace = (): Trace => M.COVER_TRACE as Trace | undefined ?? { on: false, coverers: [], enqueueKinds: [], served: [] };
const BASELINE = process.env.DRAIN104_BASELINE === "1";
/** Cover on (or off for the per-job baseline run of a differential); the env baseline keeps it off throughout (fail-first control). */
function cover(on: boolean): void { if (M.REVOKE_COVER) M.REVOKE_COVER.enabled = on && !BASELINE; }
const COVER_REVOKE = -3, WALKER_REVOKE = -5;

const tx = <T>(db: Db, run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const slice = (db: Db, rows = 256, cap = Number.POSITIVE_INFINITY) => tx(db, () => marker.markerSlice(db, rows, Number.POSITIVE_INFINITY, null, cap));
const drainAll = (db: Db, rows = 256) => { for (let k = 0; k < 200_000; k++) if (!slice(db, rows)) return k; throw new Error("unbounded"); };
const n = (db: Db, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
const pathOf = (db: Db) => String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
const jobRow = (db: Db, id: number) => db.prepare("SELECT state,phase,started_lsn FROM memory_revoke_jobs WHERE revoke_id=?").get(id) as { state: string; phase: string; started_lsn: number } | undefined;
const coverCount = (db: Db) => n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=${COVER_REVOKE}`);

/** A job row as the marker leaves one in its mark phase, with its frontier. Audience: a memory_revoke_audience row (an audience inherit job). */
function job(db: Db, id: number, cap: number, nodes: readonly FrontierNode[], o: { audience?: boolean; kind?: string; root?: object; phase?: string; state?: string } = {}): number {
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,?,'',?)")
    .run(id, o.kind ?? "inherit", JSON.stringify(o.root ?? { kind: "inherit", cause: "inherit" }), cap, cap, o.phase ?? "mark", o.state ?? "active");
  if (o.audience !== false) db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(id);
  for (const node of nodes) marker.enqueueNode(db, id, node);
  return id;
}
const range = (threadId: string, fromLsn: number): FrontierNode => ({ kind: "range", threadId, fromLsn });
const src = (id: string): FrontierNode => ({ kind: "source", id });
const rec = (id: string, version = 1): FrontierNode => ({ kind: "record", id, version });

/** Store writers (the rows S1's writers leave). */
class Store {
  constructor(readonly fx: WritetimeFixture) {}
  get db(): Db { return this.fx.db; }
  line(T: string, lsn: number, generated: boolean, turnLsn = lsn - 1): this {
    if (generated) this.fx.reply(T, `${T}-${lsn}`, lsn, { turnLsn }); else this.fx.owner(T, `${T}-${lsn}`, lsn);
    return this;
  }
  carry(T: string, from: number, to: number, child: { line: [string, number] } | { turn: [string, number] } | { ref: MemoryRef } | { session: [string, string, string] }): this {
    const row = "line" in child ? [CARRY_CHILD_CODE.line, lineChildRef(child.line[1]), testThreadNo(this.db, child.line[0])]
      : "turn" in child ? [CARRY_CHILD_CODE.turn, turnChildRef(child.turn[1]), testThreadNo(this.db, child.turn[0])]
      : "ref" in child ? [CARRY_CHILD_CODE.record, recordChildRef(child.ref), 0]
      : [CARRY_CHILD_CODE.session, sessionChildRef(child.session[1], child.session[2]), testThreadNo(this.db, child.session[0])];
    this.db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, T), to, from, row[0]!, row[1]!, row[2]!);
    return this;
  }
  /** A consumer of a memory object (objectNode walks it). */
  consumer(ref: { kind: "source" | "record"; id: string }, child: [string, number]): this {
    this.db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)")
      .run(testThreadNo(this.db, objectCarryThread(ref)), OBJECT_EDGE_LSN, OBJECT_EDGE_LSN, CARRY_CHILD_CODE.line, lineChildRef(child[1]), testThreadNo(this.db, child[0]));
    return this;
  }
  /** A source captured from line T:lsn (memory_sources names the line; memory_line_capture holds the edge). */
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

/** Below every cap the random-store tests use (see randomStore). */
const TURN_TOP = 3;
function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** A random store: threads of owner and generated lines, short and prefix carries between them (lines, turns, records, sources, sessions),
 * captures, records with evidence and derivations, object consumers, receipts citing records, a bot scope's records.
 * Kept inside the states the per-job walk reaches the same way under every pop order, so a differential compares the cover, not the order:
 * every generated line's turn began before every cap in play (a line of a later turn is marked at its write, lineage-write.ts, which this
 * fixture does not run); captures, receipts and every carry's last line are generated lines. The base's own-walk skip runs no point pass,
 * so a user line or a short carry of user lines reached after the job entered its thread lower is followed or not by pop order alone
 * (DRAIN-104 section 9, residual 1, pre-existing, filed for its own design); the cover changes pop order, so such a store differs by order. */
function randomStore(seed: number, size = 1): { s: Store; roots: () => FrontierNode[] } {
  const rnd = mulberry(seed), s = store(), db = s.db;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const TH = ["ta", "tb", "tc", "td", "te"];
  const lines = new Map<string, number[]>(TH.map(t => [t, []])), gen = new Map<string, number[]>(TH.map(t => [t, []]));
  const N = 90 * size;
  for (let lsn = 1; lsn <= N; lsn++) {
    const T = pick(TH), g = rnd() < 0.55;
    s.line(T, lsn, g, Math.min(lsn - 1 - Math.floor(rnd() * 3), TURN_TOP));
    lines.get(T)!.push(lsn); if (g) gen.get(T)!.push(lsn);
  }
  for (const T of TH) for (let k = 0; k < 2; k++) { const first = 1 + Math.floor(rnd() * N), last = first + Math.floor(rnd() * 40); s.session(T, `${T}-s${k}`, first, last); }
  const sources: string[] = [];
  for (let k = 0; k < 14 * size; k++) { const T = pick(TH), l = gen.get(T)!; if (!l.length) continue; const id = `src${k}`; s.capture(T, pick(l), id); sources.push(id); }
  const records: string[] = [];
  for (let k = 0; k < 12 * size; k++) { const id = `rec${k}`; s.fx.record(id, 1, rnd() < 0.3 ? "s-bot" : "s-room", sources.length ? [pick(sources)] : []); records.push(id); }
  for (let k = 0; k < 6 * size; k++) { const a = pick(records), b = pick(records); if (a !== b) { try { s.fx.derive(a, 1, b, 1); } catch { /* duplicate */ } } }
  for (let k = 0; k < 70 * size; k++) {
    const P = pick(TH), pl = lines.get(P)!;
    if (!pl.length) continue;
    const from = rnd() < 0.1 ? FIRST_LSN : pick(pl), ends = gen.get(P)!.filter(l => from === FIRST_LSN || (l >= from && l <= from + 12));
    if (!ends.length) continue;
    const to = pick(ends);
    const Q = pick(TH.filter(t => t !== P)), r = rnd();
    if (r < 0.45 && lines.get(Q)!.length) s.carry(P, from, to, { line: [Q, pick(lines.get(Q)!)] });
    else if (r < 0.6 && gen.get(Q)!.length) s.carry(P, from, to, { turn: [Q, pick(gen.get(Q)!) - 1] });
    else if (r < 0.75) s.carry(P, from, to, { ref: { kind: "record", id: pick(records), version: 1 } });
    else if (r < 0.88 && sources.length) s.carry(P, from, to, { ref: { kind: "source", id: pick(sources) } });
    else s.carry(P, from, to, { session: [Q, "fuigo", `${Q}-s${Math.floor(rnd() * 2)}`] });
  }
  for (let k = 0; k < 6 * size; k++) { const T = pick(TH), l = lines.get(T)!; if (l.length && sources.length) s.consumer({ kind: "source", id: pick(sources) }, [T, pick(l)]); }
  for (let k = 0; k < 4 * size; k++) { const T = pick(TH), l = gen.get(T)!; if (l.length) s.receipt(`bun${k}`, T, pick(l), [pick(records), pick(records)]); }
  s.head();
  const roots = (): FrontierNode[] => {
    const out: FrontierNode[] = [];
    for (let k = 0; k < 3; k++) {
      const r = rnd(), T = pick(TH), l = lines.get(T)!;
      if (r < 0.4 && l.length) out.push(range(T, pick(l)));
      else if (r < 0.65 && sources.length) out.push(src(pick(sources)));
      else if (r < 0.85) out.push(rec(pick(records)));
      else if (r < 0.93) out.push({ kind: "scope", scopeId: "s-bot" });
      else out.push({ kind: "receipt", bundleId: `bun${Math.floor(rnd() * 4 * size)}` });
    }
    return out;
  };
  void db;
  return { s, roots };
}

/** Every deny fact, by key (whatever revoke wrote it): the audience reader withholds on any audience row (deny-read.ts NOT_AUDIENCE_ONLY). */
function facts(db: Db) {
  const set = (sql: string) => new Set((db.prepare(sql).all() as Array<{ k: string }>).map(r => r.k));
  return {
    lines: set("SELECT DISTINCT thread_id||':'||lsn AS k FROM memory_deny_line"),
    sessions: set("SELECT DISTINCT thread_id||':'||driver_instance||':'||native_session AS k FROM memory_deny_session"),
    memory: set("SELECT DISTINCT kind||':'||id||':'||version AS k FROM memory_deny_memory"),
    ranges: db.prepare("SELECT thread_id AS t,from_lsn AS f,until_turn_lsn AS u FROM memory_deny_range").all() as Array<{ t: string; f: number; u: number }>,
  };
}
const sorted = (s: Set<string>) => [...s].sort();
function withheldLines(db: Db, f: ReturnType<typeof facts>, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    if (f.lines.has(k)) { out.add(k); continue; }
    const at = k.lastIndexOf(":"), T = k.slice(0, at), lsn = Number(k.slice(at + 1));
    const row = db.prepare("SELECT l.turn_lsn AS t FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.lsn=?").get(T, lsn) as { t: number | null } | undefined;
    const turn = row ? (row.t ?? lsn) : lsn;
    if (f.ranges.some(r => r.t === T && r.f < lsn && turn < r.u)) out.add(k);
  }
  return out;
}
/** The cover run withholds exactly what the per-job run does: equal lines, sessions and memory marks; every range of either run is held by a
 * range of the other at or before its start with an end at or after its end. */
function expectSameFacts(withCover: Db, perJob: Db, superset = false): void {
  const a = facts(withCover), b = facts(perJob);
  // a line is withheld by its own mark or by a range that holds it (deny-read.ts: from_lsn < lsn and turn_lsn < until); a job skipped
  // under a coverer leaves no own mark on a line the coverer's range already withholds, so lines compare as withheld, not as rows
  const all = [...new Set([...a.lines, ...b.lines])];
  const wa = withheldLines(withCover, a, all), wb = withheldLines(perJob, b, all);
  if (superset) { for (const k of wb) expect(wa.has(k), `lines ${k}`).toBe(true); for (const key of ["sessions", "memory"] as const) for (const k of b[key]) expect(a[key].has(k), `${key} ${k}`).toBe(true); }
  else { expect(sorted(wa)).toEqual(sorted(wb)); expect(sorted(a.sessions)).toEqual(sorted(b.sessions)); expect(sorted(a.memory)).toEqual(sorted(b.memory)); }
  const held = (rows: typeof a.ranges, r: { t: string; f: number; u: number }) => rows.some(x => x.t === r.t && x.f <= r.f && x.u >= r.u);
  for (const r of b.ranges) expect(held(a.ranges, r), `range ${JSON.stringify(r)}`).toBe(true);
  if (!superset) for (const r of a.ranges) expect(held(b.ranges, r), `range ${JSON.stringify(r)}`).toBe(true);
}
/** Builds the same store twice; `setup` adds the jobs; runs one with cover, one per job (cover off); returns both (caller closes). */
function twin(build: () => Store, setup: (s: Store) => void, run: (s: Store, withCover: boolean) => void = (s) => { drainAll(s.db); }): { on: Store; off: Store } {
  const on = build(), off = build();
  setup(on); setup(off);
  cover(true); run(on, true);
  cover(false); try { run(off, false); } finally { cover(true); }
  return { on, off };
}

beforeEach(() => { fold.REVOKE_FOLD.enabled = false; cover(true); M.resetCoverProbe?.(); const t = trace(); t.on = true; });
afterEach(() => { fold.REVOKE_FOLD.enabled = true; cover(true); if (M.REVOKE_COVER) M.REVOKE_COVER.enqueueSkip = true; const t = trace(); t.on = false; });

describe("1 D: skip only under a coverer whose cap is at or above the job's own (T1)", () => {
  it("a lower-cap coverer that reached hold first does not cover a higher-cap drain; a job below both does skip", () => {
    const s = store();
    try {
      keeper(s.db);
      // T: the receipt output at 10, a reply whose turn began at 59 (between the caps 50 and 80) at 60, quoted into U by a carry [55, 65]
      s.line("T", 10, true, 9).line("T", 55, false).line("T", 60, true, 59).line("T", 65, false).line("U", 70, true, 69).head();
      s.carry("T", 55, 65, { line: ["U", 70] });
      const lo = job(s.db, 1, 50, [range("T", 10)]);
      drainAll(s.db);
      expect(jobRow(s.db, lo)?.state ?? "done").toBe("done");
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U'")).toBe(0); // under cap 50 the reply is not reached
      expect(coverCount(s.db)).toBeGreaterThan(0); // the lower cap left its cover
      const hi = job(s.db, 2, 80, [range("T", 10)]);
      const before = probe();
      drainAll(s.db);
      // the later, higher-cap drain walked T itself: the reply begun between the caps is withheld under it
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn=70 AND revoke_id=?", hi)).toBe(1);
      expect(probe().handlerRuns).toBeGreaterThan(before.handlerRuns);
      expect(trace().coverers).not.toContain(lo);
      // positive control: a job with a cap below both skips its walk of T (a point pass under a coverer)
      const low = job(s.db, 3, 40, [range("T", 10)]);
      const ctl = probe();
      drainAll(s.db);
      expect(probe().pointPasses).toBe(ctl.pointPasses + 1);
      expect(probe().handlerRuns).toBe(ctl.handlerRuns);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_range WHERE revoke_id=?", low)).toBe(0);
    } finally { s.fx.close(); }
  });
});

describe("2 D: a partly covered thread (T2)", () => {
  const build = () => {
    const s = store();
    for (let l = 40; l <= 130; l += 1) s.line("T", l, true);
    for (let l = 200; l <= 210; l++) s.line("U", l, true);
    s.carry("T", 60, 60, { line: ["U", 201] }).carry("T", 99, 99, { line: ["U", 202] }).carry("T", 100, 100, { line: ["U", 203] }).carry("T", 120, 125, { line: ["U", 204] });
    s.session("T", "between", 70, 90); // begun after the consumer's line, before its cap, run to or past 50: it held line 50
    return s.head();
  };
  for (const held of [null, 120] as const) {
    it(`K walked T from 100; R' enters at 50${held ? " after its own walk from 120" : ""}: lines 50-99 under R', 100 on under K, the session under R'`, () => {
      const R = 2, K = 1;
      const { on, off } = twin(build, s => { job(s.db, K, 300, [range("T", 100)]); job(s.db, R, 250, held ? [range("T", held), range("T", 50)] : [range("T", 50)]); });
      try {
        for (const s of [on, off]) {
          expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn IN (201,202) AND revoke_id=?", R)).toBe(2);
          expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn IN (203,204) AND revoke_id=?", K)).toBe(2);
          expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_session WHERE native_session='between' AND revoke_id=?", R)).toBe(1);
        }
        // with cover R' never walked from 100 on: no carry ending there was followed under it
        expect(n(on.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn=203 AND revoke_id=?", R)).toBe(0);
        expect(probe().partial).toBeGreaterThanOrEqual(1);
        if (held) expect(probe().pointPasses).toBeGreaterThanOrEqual(1);
        expectSameFacts(on.db, off.db);
      } finally { on.fx.close(); off.fx.close(); }
    });
  }
});

describe("3 D: the starting line (T3)", () => {
  const build = () => {
    const s = store();
    s.line("T", 50, true, 49);
    for (const l of [70, 75, 80, 81, 85]) s.line("T", l, false); // quoted lines: no generated line of a turn before any cap
    s.line("T", 90, true, 89);
    s.line("U", 300, true).line("U", 301, true).line("W", 302, true).line("V", 1, true, 0).line("X", 5, true, 4);
    s.carry("T", 70, 80, { line: ["U", 300] });       // holds 80, not K's 50
    s.carry("T", 81, 85, { line: ["U", 301] });       // holds 81, not 80
    s.carry("T", FIRST_LSN, 90, { line: ["W", 302] }); // a prefix carry: holds K's 50, so K followed it
    s.capture("T", 80, "S");                          // the source R' reaches (its line is T:80)
    s.capture("T", 80, "S2");                         // a second capture at 80
    s.carry("V", 1, 1, { ref: { kind: "source", id: "S" } }); // R' reaches S through its own walk (carryChild), never an inherit
    s.carry("V", 1, 1, { line: ["X", 5] });
    s.line("Y", 6, true, 5).line("Z", 7, true, 6);
    s.carry("X", 5, 5, { line: ["Y", 6] }).carry("Y", 6, 6, { line: ["Z", 7] }); // a longer path: the frontier pops in order, so T:89 comes later
    s.carry("Z", 7, 7, { turn: ["T", 89] });          // a second entry into T at 89, after the first at 80
    return s.head();
  };
  it("a covered source still hands R' its line; R' point-passes the quote carry and the captures at 80, nothing below K's entry, nothing twice", () => {
    const K = 1, R = 2;
    let sawSourceRow = false;
    const { on, off } = twin(build, s => { job(s.db, K, 200, [range("T", 50), src("S")]); job(s.db, R, 150, [range("V", 1)]); },
      (s, withCover) => {
        for (let k = 0; k < 10_000; k++) {
          if (withCover && n(s.db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND node LIKE '%\"source\"%\"S\"%'", R)) sawSourceRow = true;
          if (!slice(s.db, 3)) return;
        }
        throw new Error("unbounded");
      });
    try {
      expect(sawSourceRow).toBe(true); // the covered source was enqueued under R' and popped
      expect(probe().sourceLines).toBeGreaterThanOrEqual(1);
      for (const s of [on, off]) {
        expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn=300 AND revoke_id=?", R)).toBe(1);
        expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind='source' AND id='S2' AND revoke_id=?", R)).toBe(1);
        expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn=301")).toBe(0);
        expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='W' AND lsn=302 AND revoke_id=?", K)).toBe(1);
      }
      // the prefix carry was K's: never re-enqueued under R'; one point pass (at 80), the later entry at 89 the own-walk skip
      expect(n(on.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='W' AND revoke_id=?", R)).toBe(0);
      expect(probe().pointPasses).toBe(1);
      expectSameFacts(on.db, off.db);
    } finally { on.fx.close(); off.fx.close(); }
  });
});

/** A bookkeeping job keeps a revoke in its hold phase while its binding is present (revoke-marker.ts hold). */
function holdOpen(db: Db, revokeId: number, jobId: string): void {
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,'s-room','system',?,0,'granted','{}')").run(`memory-revocation:${jobId}`, `memory-revocation-${jobId}`);
  marker.holdRevoke(db, revokeId, jobId);
}
/** An audience job held open in its hold phase: while it lives no tidy is the last quiet one (2.7), so the cover rows stay to be read. */
// (in its hold phase from the start: a job in mark is a walker candidate, and a walker in hold stays the walker, 2.6)
function keeper(db: Db, id = 990): number { job(db, id, 1, [], { phase: "hold" }); holdOpen(db, id, `keep${id}`); return id; }
const holdClose = (db: Db, jobId: string) => db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(`memory-revocation:${jobId}`);

describe("4 + 19 D: a cover row counts only once its job's frontier is empty; the hold phase counts (T4)", () => {
  it("restart after every slice: no skip while the coverer has a head, skips while it holds (before its tidy), none again while inheritance reopens it", () => {
    const K = 1, R = 2;
    let reopened = 0, usedInHold = 0, usedInMark = 0;
    const { on, off } = twin(() => randomStore(4104, 2).s, s => {
      job(s.db, K, 900, [range("ta", 1), range("tb", 1), range("tc", 1), src("src1"), rec("rec2")]);
      job(s.db, R, 400, [range("ta", 20), range("tc", 5), src("src1"), rec("rec2"), range("td", 1), src("src3"), rec("rec5")]);
      holdOpen(s.db, K, "bk1");
    }, (s, withCover) => {
      const file = pathOf(s.db);
      let open = true, reopenedHere = false; // each run (cover on, per job) reopens K once
      for (let k = 0; k < 20_000; k++) {
        const db = new DatabaseSync(file); // a new process every slice
        try {
          const t0 = trace().coverers.length;
          const moved = slice(db, 16);
          const phase = jobRow(db, K)?.phase, by = trace().coverers.slice(t0).filter(j => j === K).length;
          if (phase === "mark") usedInMark += by; // no cover of K counts while K has a head
          if (phase === "hold") usedInHold += by;
          // mid-consumer: the coverer reopened by inheritance (a line written under one of its marks)
          if (!reopenedHere && (withCover ? usedInHold > 0 : phase === "hold") && jobRow(db, R)?.state === "active") {
            const mark = db.prepare("SELECT thread_id AS t,lsn FROM memory_deny_line WHERE revoke_id=? LIMIT 1").get(K) as { t: string; lsn: number };
            tx(db, () => commit.inheritMarks(db, { kind: "line", threadId: "late", lsn: 4900 }, [], [{ threadId: mark.t, from: mark.lsn, to: mark.lsn }]));
            expect(jobRow(db, K)!.phase).toBe("mark");
            reopenedHere = true; reopened++;
          }
          if (!moved) { if (open) { holdClose(db, "bk1"); open = false; continue; } break; }
        } finally { db.close(); }
      }
    });
    try {
      expect(reopened).toBe(2);
      expect(usedInHold).toBeGreaterThan(0); // the consumer skipped under K while K held, before K's tidy
      expect(usedInMark).toBe(0);
      expectSameFacts(on.db, off.db);
    } finally { on.fx.close(); off.fx.close(); }
  });

  for (const seed of [11, 12, 13, 14, 15, 16]) {
    it(`differential on a random store (seed ${seed}): three audience jobs, cover on vs per job`, () => {
      const { on, off } = twin(() => randomStore(seed).s, s => {
        const r = mulberry(seed * 31), TH = ["ta", "tb", "tc", "td", "te"];
        const roots = (k: number) => Array.from({ length: k }, () => r() < 0.5 ? range(TH[Math.floor(r() * 5)]!, 1 + Math.floor(r() * 80)) : r() < 0.7 ? src(`src${Math.floor(r() * 14)}`) : rec(`rec${Math.floor(r() * 12)}`));
        job(s.db, 1, 900, roots(6)); job(s.db, 2, 60, roots(4)); job(s.db, 3, 45, roots(4));
      });
      try { expectSameFacts(on.db, off.db); } finally { on.fx.close(); off.fx.close(); }
    });
  }
  it("the differential seeds above used the cover (mechanism fired)", () => {
    const { on, off } = twin(() => randomStore(11).s, s => { job(s.db, 1, 900, [range("ta", 1), range("tb", 1), range("tc", 1), range("td", 1), range("te", 1)]); job(s.db, 2, 60, [range("tb", 10), src("src2"), rec("rec3")]); });
    try { expect(probe().skips + probe().pointPasses + probe().enqueueSkips).toBeGreaterThan(0); expectSameFacts(on.db, off.db); } finally { on.fx.close(); off.fx.close(); }
  });
});

describe("5 L: an audience-only revoke is never undone (T5)", () => {
  it("undo of a drain bulk, an audience inherit job and a fold bulk is refused and changes no row; undo of a content revoke still runs", () => {
    const s = store();
    try {
      s.line("T", 1, true, 0).line("T", 2, false);
      s.receipt("b1", "T", 1, []).head();
      const snap = () => ["memory_revoke_jobs", "memory_deny_pending", "memory_revoke_frontier", "memory_deny_line"].map(t => n(s.db, `SELECT count(*) AS n FROM ${t}`)).join(",");
      s.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b1'").run(); // a flip: the next slice drains it into a bulk
      slice(s.db);
      const drain = Number((s.db.prepare("SELECT revoke_id AS r FROM memory_revoke_jobs WHERE kind='bulk'").get() as { r: number }).r);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_revoke_audience WHERE revoke_id=?", drain)).toBe(1);
      const inherit = job(s.db, 50, 100, [range("T", 1)]);
      const foldBulk = job(s.db, 51, 100, [range("T", 1)], { kind: "bulk", root: { kind: "bulk", cause: "fold", cohort: { lo: 1, hi: 2, ids: [] } } });
      for (const id of [drain, inherit, foldBulk]) {
        const before = snap();
        expect(() => tx(s.db, () => commit.undoRevoke(s.db, id))).toThrow("MEMORY_REVOKE_UNDO_BULK");
        expect(snap()).toBe(before);
      }
      const hide = tx(s.db, () => commit.commitRevoke(s.db, { kind: "line", threadId: "T", messageIds: ["T-2"], cause: "hide" }, { inline: false }));
      tx(s.db, () => commit.undoRevoke(s.db, hide));
      expect(jobRow(s.db, hide)!.state).toBe("undoing");
    } finally { s.fx.close(); }
  });
});

describe("6 D: caps moved by an upgrade step (T6)", () => {
  it("a row carries the cap its walk used: J (cap 15) walks a thread K walked at 10, and point-passes a range K walked after the step at 20", () => {
    const s = store();
    try {
      keeper(s.db);
      s.line("T", 5, false).line("T", 30, true, 29).session("T", "s12", 12, 30);
      s.line("T2", 40, false).capture("T2", 40, "S").head();
      const K = job(s.db, 1, 10, [range("T", 5)]);
      drainAll(s.db);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_session WHERE native_session='s12'")).toBe(0); // begun at 12, after K's cap
      s.db.prepare("UPDATE memory_revoke_jobs SET started_lsn=20 WHERE revoke_id=?").run(K); // the step (done or pruned: the row's cap stays 10)
      const J = job(s.db, 2, 15, [range("T", 5)]);
      let before = probe();
      drainAll(s.db);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_session WHERE native_session='s12' AND revoke_id=?", J)).toBe(1);
      expect(probe().handlerRuns).toBeGreaterThan(before.handlerRuns);
      expect(probe().pointPasses).toBe(before.pointPasses);
      // control: a job below 10 does skip (a point pass)
      before = probe();
      job(s.db, 3, 8, [range("T", 5)]);
      drainAll(s.db);
      expect(probe().pointPasses).toBe(before.pointPasses + 1);
      // a visit walked before the step (cap 10) and its downstream range after it (cap 20)
      const K2 = job(s.db, 4, 10, [src("S")]);
      expect(slice(s.db, 3)).toBe(true); // the source's visit, at cap 10
      expect(M.coverRows?.(s.db, "s:S", true)).toEqual([{ from: 0, job: K2, cap: 10 }]);
      s.db.prepare("UPDATE memory_revoke_jobs SET started_lsn=20 WHERE revoke_id=?").run(K2);
      drainAll(s.db);
      expect((M.coverRows?.(s.db, "T2") as Array<{ cap: number }>).map(r => r.cap)).toEqual([20]);
      before = probe();
      job(s.db, 5, 15, [src("S")]);
      drainAll(s.db);
      expect(probe().skips).toBe(before.skips); // the source is walked (its row's cap 10 is below 15)
      expect(probe().handlerRuns).toBeGreaterThan(before.handlerRuns);
      expect(probe().pointPasses).toBe(before.pointPasses + 1); // its range is covered at 20
      // a fold bulk back from 1.0.2 walks at started_lsn (S): no row below S covers it
      s.line("T3", 1, true, 0).line("T3", 2, true, 1).head();
      job(s.db, 6, 25, [range("T3", 1)]);
      drainAll(s.db);
      before = probe();
      job(s.db, 7, 30, [range("T3", 1)], { kind: "bulk", root: { kind: "bulk", cause: "fold", cohort: { lo: 1, hi: 9, ids: [] }, reupgraded: 1 } });
      drainAll(s.db);
      expect(probe().pointPasses).toBe(before.pointPasses);
      expect(probe().handlerRuns).toBeGreaterThan(before.handlerRuns);
      // control: the same bulk not reupgraded caps at its cohort's hi (9) and is covered
      before = probe();
      job(s.db, 8, 30, [range("T3", 1)], { kind: "bulk", root: { kind: "bulk", cause: "fold", cohort: { lo: 1, hi: 9, ids: [] } } });
      drainAll(s.db);
      expect(probe().pointPasses).toBe(before.pointPasses + 1);
    } finally { s.fx.close(); }
  });
});

describe("7 D: the reader class differs (T7)", () => {
  it("a content forget and an audience bulk reach the same record; neither skips the other's nodes; the content reader is withheld by the forget alone", () => {
    const s = store();
    try {
      keeper(s.db);
      s.fx.record("X", 1, "s-room").record("Y", 1, "s-room");
      s.head();
      const F = job(s.db, 1, 900, [rec("X")], { audience: false });
      const A = job(s.db, 2, 500, [rec("X"), rec("Y")]);
      drainAll(s.db);
      expect(probe().skips).toBe(0);
      expect((M.coverRows?.(s.db, "r:X:1", true) as Array<{ job: number }> ?? []).map(r => r.job)).toEqual([A]); // content writes no cover
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE id='X' AND revoke_id IN (?,?)", F, A)).toBe(2);
      // positive control: a lower audience job does skip under the audience bulk
      job(s.db, 3, 100, [rec("X")]);
      drainAll(s.db);
      expect(probe().skips).toBe(1);
      expect(trace().coverers).toEqual([A]);
      const ref = (id: string) => [{ kind: "memory" as const, ref: { kind: "record" as const, id, version: 1, scopeId: "s-room" } }];
      expect(refsLookup(s.db, ref("X"), CONTENT).state).toBe("withheld");
      expect(refsLookup(s.db, ref("Y"), CONTENT).state).toBe("shown");
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE id='Y' AND revoke_id=?", A)).toBe(1); // Y is the audience bulk's alone
      s.db.prepare("DELETE FROM memory_deny_memory WHERE revoke_id=?").run(F); // without the forget's own mark the content reader is shown X
      expect(refsLookup(s.db, ref("X"), CONTENT).state).toBe("shown");
    } finally { s.fx.close(); }
  });
});

describe("9 P: no loop through skips (T9)", () => {
  it("a covered cycle T:30 -> U:40 -> T:30 ends with one point pass each, and a store whose every node is covered drains", () => {
    const s = store();
    try {
      s.line("T", 10, true, 9).line("T", 25, false).line("T", 30, true, 29).line("T", 35, false).line("U", 35, false).line("U", 40, true, 39).line("U", 45, false);
      s.carry("T", 25, 35, { line: ["U", 40] }).carry("U", 35, 45, { line: ["T", 30] }).head();
      keeper(s.db);
      job(s.db, 1, 900, [range("T", 10)]);
      drainAll(s.db);
      const before = probe();
      const R = job(s.db, 2, 100, [range("T", 30)]);
      const slices = drainAll(s.db);
      expect(slices).toBeLessThan(40);
      expect(jobRow(s.db, R)?.state ?? "done").toBe("done");
      expect(probe().pointPasses - before.pointPasses).toBe(2); // T:30 and U:40, each once; the cycle back to T:30 is the own-walk skip
      expect(probe().handlerRuns - before.handlerRuns).toBe(0);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='U' AND lsn=40")).toBeGreaterThan(0);
    } finally { s.fx.close(); }
  });
});

describe("10 + 15 P: no starvation; the budget holds (T10)", () => {
  it("content jobs finish first, the unreadable one is retried in its turn, the walker drains, queued jobs only skip, restart and a higher-cap drain", () => {
    const { s } = randomStore(9001, 5);
    const ROWS = 8; // a small slice, so the walker's walk spans the checks below
    const db0 = s.db, file = pathOf(db0);
    try {
      const bad = job(db0, 1, 800, [], { audience: false }); // lowest id: 1.0.3 serves it first every slice
      db0.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'not a node')").run(bad);
      const W = job(db0, 2, 900, ["ta", "tb", "tc", "td", "te"].map(T => range(T, 1)));
      const Q = [job(db0, 3, 300, [range("ta", 5), rec("rec1")]), job(db0, 4, 200, [range("tb", 9), src("src2")]), job(db0, 5, 100, [range("tc", 3)])];
      // two content inherit jobs of one line node each (a late line: little rests on it), as 203-225 on the real data
      const last = (T: string) => n(db0, "SELECT max(lsn) AS n FROM memory_line_lineage WHERE thread_no=(SELECT no FROM memory_thread_no WHERE thread_id=?)", T);
      s.line("q1", 4001, true, 2).line("q2", 4002, true, 2).head(); // lines nothing rests on
      void last;
      const C1 = job(db0, 6, 950, [{ kind: "line", threadId: "q1", lsn: 4001 }], { audience: false }), C2 = job(db0, 7, 950, [{ kind: "line", threadId: "q2", lsn: 4002 }], { audience: false });
      let db = db0, throws = 0, contentDoneAt = -1, restarted = false, higher = 0, slices = 0;
      const t = trace();
      for (let k = 0; k < 4000; k++) {
        slices++;
        const served0 = t.served.length, runs0 = probe().handlerRuns, rows0 = probe().coverRows;
        const w0 = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
        let moved: boolean | "blocked" = false;
        try { moved = slice(db, ROWS, 400); } catch (e) { if (!String(e).includes("MEMORY_REVOKE_NODE_UNREADABLE")) throw e; throws++; moved = true; }
        const wrote = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n) - w0;
        // the budget (item 15): today's bound (the cap and one step's reserve) plus one cover row per visit
        expect(wrote).toBeLessThanOrEqual(400 + marker.MARKER_STEP_RESERVE + (probe().coverRows - rows0));
        const here = t.served.slice(served0);
        if (here.length && here.every(x => x.cls === "others")) expect(probe().handlerRuns).toBe(runs0); // the others never walk
        if (contentDoneAt < 0 && [C1, C2].every(id => (jobRow(db, id)?.state ?? "done") === "done")) { contentDoneAt = k; expect(jobRow(db, W)?.state).toBe("active"); }
        if (k === 6 && !restarted) {
          expect(jobRow(db, W)?.state).toBe("active");
          // a higher-cap audience job appears in mark, then a restart: the persisted walker resumes
          higher = job(db, 8, 990, [range("te", 2)]);
          db.close(); db = new DatabaseSync(file); restarted = true;
          const mark = t.served.length;
          for (let j = 0; j < 6; j++) { try { slice(db, ROWS, 400); } catch { throws++; } }
          expect(t.served.slice(mark).filter(x => x.cls === "walker").map(x => x.job)[0]).toBe(W);
        }
        if (k === 12) {
          expect(jobRow(db, W)?.state).toBe("active");
          // a higher-cap drain arrives mid-walk: its flow phase runs at once, then it waits (its head is not covered) until the walker is done
          const D = job(db, 9, 995, [range("td", 2)], { kind: "bulk", phase: "flow", root: { kind: "bulk", cause: "receipt-revoked" } });
          marker.seedFlow(db, D, "td", 1);
          for (let j = 0; j < 4 && jobRow(db, D)!.phase === "flow"; j++) { try { slice(db, ROWS, 400); } catch { throws++; } } // the unreadable job's turn rolls a slice back
          expect(jobRow(db, D)!.phase).toBe("mark");
          expect(n(db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0", D)).toBe(1);
        }
        if (!moved || !n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active' AND revoke_id<>?", bad)) break;
      }
      expect(contentDoneAt).toBeGreaterThanOrEqual(0);
      expect(contentDoneAt).toBeLessThan(12);
      expect(jobRow(db, W)?.state ?? "done").toBe("done");
      for (const id of [...Q, higher, 9]) expect(jobRow(db, id)?.state ?? "done").toBe("done");
      expect(throws).toBeGreaterThan(0);
      expect(throws).toBeLessThanOrEqual(Math.ceil(slices / 2) + 3); // retried only in its turn (the content slices), never every slice
      expect(jobRow(db, bad)!.state).toBe("active"); // fail closed: it stays
      // a persisted walker id naming a pruned job is replaced by the greatest cap in mark
      db.prepare(`INSERT OR REPLACE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(${WALKER_REVOKE},'walker',424242)`).run();
      const lo = job(db, 20, 50, [range("ta", 60)]), hi = job(db, 21, 70, [range("tb", 60)]);
      void lo;
      const mark = t.served.length;
      for (let j = 0; j < 4; j++) { try { slice(db); } catch { /* the unreadable job */ } }
      expect(t.served.slice(mark).filter(x => x.cls === "walker").map(x => x.job)[0]).toBe(hi);
      if (db !== db0) db.close();
    } finally { s.fx.close(); }
  });
});

describe("11 L: cover is deleted only when no other audience work remains (T11)", () => {
  it("no cleanup while a drain bulk seeds; the last quiet tidy removes every cover and walker row; a drain landing mid-cleanup leaves only valid rows", () => {
    const { s } = randomStore(311, 2);
    const db = s.db;
    try {
      s.line("RT", 4000, true, 3999).head();
      s.receipt("late-b", "RT", 4000, []);
      job(db, 1, 900, ["ta", "tb", "tc"].map(T => range(T, 1)));
      job(db, 2, 300, [range("ta", 10), range("tb", 3)]);
      const seeding = tx(db, () => commit.openBulkRevoke(db, "receipt-revoked", true));
      drainAll(db);
      expect(coverCount(db)).toBeGreaterThan(64); // the walker's hold left its cover (more than one cleanup page)
      expect(probe().skips + probe().pointPasses).toBeGreaterThan(0);
      expect(probe().cleanups).toBe(0); // a seeding drain bulk is audience work: no cleanup
      tx(db, () => commit.activateBulkRevoke(db, seeding));
      drainAll(db);
      expect(coverCount(db)).toBe(0);
      expect(n(db, `SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id=${WALKER_REVOKE}`)).toBe(0);
      // again, and a flip lands once the cleanup has started
      job(db, 30, 900, ["ta", "tb", "tc", "td"].map(T => range(T, 1)));
      job(db, 31, 300, [range("tc", 10)]);
      let flipped = false;
      const cleaned = probe().cleanups;
      for (let k = 0; k < 50_000; k++) {
        if (!flipped && probe().cleanups > cleaned && coverCount(db) > 0) {
          db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='late-b'").run();
          flipped = true;
          expect(slice(db, 8)).toBe(true); // the drain opens its bulk
          // the cleaning job finishes without its cleanup; every row left is valid (its job row absent or finished, unmapped)
          for (let j = 0; j < 20 && n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id IN (30,31) AND state='active'"); j++) slice(db, 8);
          const left = db.prepare(`SELECT thread_id AS k FROM memory_revoke_reached WHERE revoke_id=${COVER_REVOKE}`).all() as Array<{ k: string }>;
          expect(left.length).toBeGreaterThan(0);
          for (const { k } of left) {
            const id = Number(k.slice(-10)), row = jobRow(db, id);
            if (id !== 30 && id !== 31) continue; // the new bulk's own rows count from its own hold
            expect(!row || (["active", "done"].includes(row.state) && ["hold", "tidy", "done"].includes(row.phase))).toBe(true);
          }
        }
        if (!slice(db, 8)) break;
      }
      expect(flipped).toBe(true);
      expect(coverCount(db)).toBe(0); // the next quiet tidy took them
    } finally { s.fx.close(); }
  });
});

describe("12 D: the enqueue-time skip and the covered source (T12)", () => {
  for (const seed of [21, 22, 23, 24]) {
    it(`enqueue-skipped iff pop-skipped, for records, objects, receipts and scopes (seed ${seed}); sources always enqueued`, () => {
      // job 1 walks every thread from 30 and the bot scope; job 2 enters ta and tb lower, so its own walk of [1, 30) meets children job 1 visited
      // (and a thread only job 2 walks, carrying a record job 1 visited: at least one enqueue-time skip whatever the seed)
      const setup = (s: Store) => {
        s.line("tz", 4101, true, 2).carry("tz", 4101, 4101, { ref: { kind: "record", id: "rec7", version: 1 } }).head();
        job(s.db, 1, 900, ["ta", "tb", "tc", "td", "te"].map(T => range(T, 30)).concat([{ kind: "scope", scopeId: "s-bot" }, rec("rec7")]));
        job(s.db, 2, 120, [range("ta", 1), range("tb", 1), range("tz", 4101), rec("rec4"), src("src5"), { kind: "scope", scopeId: "s-bot" }, { kind: "receipt", bundleId: "bun1" }]);
      };
      const a = randomStore(seed).s, b = randomStore(seed).s;
      try {
        setup(a); setup(b);
        drainAll(a.db);
        const withSkip = probe(), kinds = [...trace().enqueueKinds];
        M.resetCoverProbe?.();
        if (M.REVOKE_COVER) M.REVOKE_COVER.enqueueSkip = false;
        drainAll(b.db);
        const without = probe();
        expect(withSkip.enqueueSkips).toBeGreaterThan(0);
        expect(without.enqueueSkips).toBe(0);
        expect(without.skips).toBe(withSkip.skips + withSkip.enqueueSkips);
        expect(kinds).not.toContain("source");
        expectSameFacts(a.db, b.db);
      } finally { a.fx.close(); b.fx.close(); }
    });
  }
  it("a covered source's pop: its line enqueued when R' holds nothing at or below it, not when it does; nothing else of the handler runs", () => {
    const s = store();
    try {
      keeper(s.db);
      s.line("T", 10, true, 9).line("T", 40, false).line("T", 41, true, 40).capture("T", 40, "S");
      s.fx.record("E", 1, "s-room", ["S"]);
      s.line("P", 1, true, 0).head();
      const K = job(s.db, 1, 900, [src("S"), range("T", 10)]);
      drainAll(s.db);
      let before = probe();
      const R = job(s.db, 2, 100, [src("S")]);
      drainAll(s.db);
      expect(probe().sourceLines).toBe(before.sourceLines + 1);
      // S, then S again from the point pass's capture at 40 (a covered visit writes nothing, so it is a skip again; R' now holds T at 40,
      // so the line is not enqueued twice)
      expect(probe().skips).toBe(before.skips + 2);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='T' AND lsn=40 AND revoke_id=?", R)).toBe(1);
      expect((M.coverRows?.(s.db, "s:S", true) as Array<{ job: number }>).map(r => r.job)).toEqual([K]); // no cover row of R' for the source
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE id='E' AND revoke_id=?", R)).toBe(0); // its evidence stage did not run
      before = probe();
      const R2 = job(s.db, 3, 100, [range("T", 10), src("S")]); // R2 holds T from 10 by the time S pops
      drainAll(s.db);
      expect(probe().sourceLines).toBe(before.sourceLines);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='T' AND lsn=40 AND revoke_id=?", R2)).toBe(0);
      // an inherited child onto a covered node is enqueued (inheritance is not the walk) and ends marked
      const R3 = job(s.db, 4, 100, [], {});
      s.db.prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES('record','P0',0,?)").run(R3);
      s.db.prepare("UPDATE memory_revoke_jobs SET phase='hold' WHERE revoke_id=?").run(R3);
      tx(s.db, () => commit.inheritMarks(s.db, { kind: "record", ref: { kind: "record", id: "E", version: 1 }, lsn: 4000 }, [{ kind: "memory", ref: { kind: "record", id: "P0" } }]));
      expect(n(s.db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND node LIKE '%\"E\"%'", R3)).toBe(1);
      before = probe();
      drainAll(s.db);
      expect(probe().skips).toBe(before.skips + 1);
      expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE id='E'")).toBeGreaterThan(0);
    } finally { s.fx.close(); }
  });
});

describe("13 D: a folded member's rows never count on their own (T13)", () => {
  it("rows of a job folded at listen count for no consumer while its bulk lives; after the bulk is pruned and the map lost, they count and the facts hold", () => {
    const build = () => {
      const { s } = randomStore(1313, 2);
      s.line("ta", 3000, true, 170).head(); // a turn position between the consumer's cap and the members'
      return s;
    };
    const members = [1, 2], consumer = 3, consumer2 = 80;
    const { on, off } = twin(build, s => {
      job(s.db, 1, 301, ["ta", "tb", "tc", "td"].map(T => range(T, 1)));
      job(s.db, 2, 300, [range("te", 1)]);
      job(s.db, consumer, 150, [range("ta", 4), range("tb", 2), src("src3")]);
      job(s.db, 38, 5, []); holdOpen(s.db, 38, "keep"); // an audience job held open: no quiet tidy removes the cover meanwhile
    }, (s, withCover) => {
      const db = s.db;
      fold.REVOKE_FOLD.enabled = false;
      // job 1 walks part of the store under 1.0.4 (its cover rows written, its frontier not empty)
      for (let k = 0; k < 6; k++) slice(db, 64);
      if (withCover) { expect(jobRow(db, 1)!.phase).toBe("mark"); expect(coverCount(db)).toBeGreaterThan(0); }
      // the listen fold (this connection has not listened yet: the fold was off) takes jobs 1 and 2 into one bulk
      fold.REVOKE_FOLD.enabled = withCover; // the per-job baseline never folds
      for (let k = 0; k < 50_000; k++) {
        const t0 = trace().coverers.length;
        const moved = slice(db, 64);
        for (const by of trace().coverers.slice(t0)) expect(members).not.toContain(by); // never under a member's rows while the bulk lives
        if (!moved) break;
      }
      if (withCover) expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE old_id IN (1,2)")).toBe(2);
      // a later job makes the bulk prunable, then the map is lost (a v10 round trip) and repaired: members of pruned bulks stay unmapped
      job(db, 60, 10, [range("ta", 1)], { audience: false }); // ids above the bulk's (it takes the next free id, 39)
      drainAll(db);
      if (withCover) {
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE json_valid(root) AND json_extract(root,'$.cause')='fold'")).toBe(0);
        db.exec("DELETE FROM memory_revoke_fold");
        tx(db, () => fold.repairFoldMap(db));
        expect(n(db, "SELECT count(*) AS n FROM memory_revoke_fold WHERE old_id=1")).toBe(0);
      }
      job(db, consumer2, 120, [range("ta", 2), range("tc", 1), src("src4")]);
      const t1 = trace().coverers.length;
      drainAll(db);
      if (withCover) expect(trace().coverers.slice(t1)).toContain(1); // the member's rows count now (its bulk, done at a cap at or above its own, subsumes)
      holdClose(db, "keep"); drainAll(db);
      fold.REVOKE_FOLD.enabled = false;
    });
    try { expectSameFacts(on.db, off.db, true); } finally { on.fx.close(); off.fx.close(); }
  });
});

describe("14 D: a downgrade round trip (T14)", () => {
  it("1.0.4 skips, the 1.0.3 slice function drains the rest (cover rows unread), 1.0.4 again: facts equal the per-job run; a row of a job 1.0.3 finished counts", () => {
    const { on, off } = twin(() => randomStore(1414, 2).s, s => {
      job(s.db, 1, 950, [range("ta", 1), range("tb", 1)]);
      job(s.db, 2, 900, [range("tc", 1), range("td", 1), range("te", 1)]);
      job(s.db, 3, 100, [range("ta", 6), src("src1"), range("tc", 4)]);
    }, (s, withCover) => {
      const db = s.db;
      if (withCover) {
        // 1.0.4: job 1 walks and finishes, job 2 (the next walker) walks part, job 3 skips under job 1
        for (let k = 0; k < 400 && (jobRow(db, 1)?.state ?? "done") !== "done"; k++) slice(db, 64);
        for (let k = 0; k < 3; k++) slice(db, 8);
        expect(jobRow(db, 2)!.phase).toBe("mark");
        // 1.0.3: every job walks fully in id order (REVOKE_COVER off is the 1.0.3 marker: no cover read or written, ACTIVE_JOBS)
        cover(false); drainAll(db); cover(true);
        expect(jobRow(db, 2)?.state ?? "done").toBe("done");
        // 1.0.4 again: a new consumer skips under job 2's rows (written before the downgrade, its walk finished by 1.0.3)
        job(db, 10, 200, [range("tc", 3), range("te", 2)]);
        const t0 = trace().coverers.length;
        drainAll(db);
        expect(trace().coverers.slice(t0)).toContain(2);
      } else {
        drainAll(db);
        job(db, 10, 200, [range("tc", 3), range("te", 2)]);
        drainAll(db);
      }
    });
    try { expectSameFacts(on.db, off.db); } finally { on.fx.close(); off.fx.close(); }
  });
});

describe("16 D: late cap-free fan-out inherits at write (2.11, T15)", () => {
  /** The six late writes, each with its site's SQL and its site's inheritEdge call (bring-in.ts, capture.ts, jobs.ts, consolidate.ts,
   * authority.ts correctMemory and settings.ts promote). */
  function lateWrites(db: Db): void {
    const ie = C.inheritEdge as (tx: Db, child: MemoryRef, parent: unknown) => void, ies = C.inheritEdges as (tx: Db, child: { id: string; version: number }) => void;
    tx(db, () => {
      // a capture: source S2 from the denied line T:20
      db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES('S2','s-room','T','T-20',NULL,1,'h','message','user','ok',NULL,'active')").run();
      writeCaptureLineage(db, { threadId: "T", messageId: "T-20" }, "S2"); ie(db, { kind: "source", id: "S2" }, { threadId: "T", messageId: "T-20" });
      // a bring-in with no turn: source C copied from S (the v10 trigger writes its origin)
      db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES('C','s-other','Room',NULL,NULL,1,'hc','bring-in','bot','recorded',NULL,'active')").run();
      db.prepare("INSERT INTO memory_source_versions VALUES('C',1,'hc',?,0)").run(JSON.stringify({ text: "x", broughtFrom: { sources: [{ id: "S" }] } }));
      for (const row of db.prepare("SELECT origin_id FROM memory_source_origins WHERE bring_in_id='C'").all()) ie(db, { kind: "source", id: "C" }, { kind: "source", id: String(row.origin_id) });
      // an extraction: record X with evidence from S
      db.prepare("INSERT INTO memory_records VALUES('X',1,'s-room','source','t','assistant-inference','active',0,0,NULL,NULL,0)").run();
      db.prepare("INSERT INTO memory_evidence VALUES('X',1,'S',1,0,3)").run(); ie(db, { kind: "record", id: "X", version: 1 }, { kind: "source", id: "S" });
      // a consolidation: X2 derived from the denied record R0
      db.prepare("INSERT INTO memory_records VALUES('X2',1,'s-room','fact','t','assistant-inference','candidate',0,0,NULL,NULL,0)").run();
      db.prepare("INSERT INTO memory_derivations VALUES('R0',1,'X2',1)").run(); ie(db, { kind: "record", id: "X2", version: 1 }, { kind: "record", id: "R0", version: 1 });
      // an owner correction: version 2 of R0 (its evidence and derivations copied, then the version edge)
      db.prepare("INSERT INTO memory_records VALUES('R0',2,'s-room','fact','t2','owner-statement','active',0,0,NULL,'R0',0)").run();
      db.prepare("INSERT INTO memory_evidence SELECT record_id,2,source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id='R0' AND record_version=1").run();
      db.prepare("INSERT INTO memory_derivations VALUES('R0',1,'R0',2)").run(); ies(db, { id: "R0", version: 2 });
      // a promote: R0 v1 copied to another scope
      db.prepare("INSERT INTO memory_records VALUES('P',1,'s-project','fact','t','owner-statement','active',0,0,NULL,NULL,0)").run();
      db.prepare("INSERT INTO memory_derivations VALUES('R0',1,'P',1)").run(); ie(db, { kind: "record", id: "P", version: 1 }, { kind: "record", id: "R0", version: 1 });
    });
  }
  const build = () => {
    const s = store();
    s.line("T", 10, true, 9).line("T", 20, false).line("T", 21, true, 20).capture("T", 20, "S");
    s.fx.record("R0", 1, "s-room", ["S"]);
    return s.head();
  };
  const LATE: MemoryRef[] = [{ kind: "source", id: "S2", scopeId: "s-room" }, { kind: "source", id: "C", scopeId: "s-other" }, { kind: "record", id: "X", version: 1, scopeId: "s-room" }, { kind: "record", id: "X2", version: 1, scopeId: "s-room" }, { kind: "record", id: "R0", version: 2, scopeId: "s-room" }, { kind: "record", id: "P", version: 1, scopeId: "s-project" }];
  for (const audience of [true, false]) {
    it(`each late write after ${audience ? "an audience bulk's" : "a content forget's"} walk passed is marked at its write; a lower consumer skips T and S; facts equal the per-job run`, () => {
      const K = 1;
      const { on, off } = twin(build, s => { keeper(s.db); job(s.db, K, 900, [range("T", 10), src("S")], { audience }); },
        (s) => {
          drainAll(s.db);
          lateWrites(s.db);
          // at its write each child enters K's frontier (K reopened: 2.11 through inheritMarks); a content reader reads it "checking" on its
          // scope's pending row meanwhile, an audience reader never reads a memory object "checking" (deny-read.ts) and has it at K's next slice
          expect(jobRow(s.db, K)?.phase).toBe("mark");
          for (const ref of LATE) expect(n(s.db, "SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0 AND node LIKE ?", K, `%"id":"${ref.id}"%`), `${ref.kind}:${ref.id} enqueued under K`).toBeGreaterThan(0);
          if (!audience) for (const ref of LATE) expect(refsLookup(s.db, [{ kind: "memory", ref }], CONTENT).state, `${ref.kind}:${ref.id}`).not.toBe("shown");
          drainAll(s.db);
          job(s.db, 2, 100, [range("T", 10), src("S")]);
          drainAll(s.db);
        });
      try {
        // (refsLookup skips audience-only memory marks for every reader, deny-read.ts NOT_AUDIENCE_ONLY: the audience's marks are the rows)
        if (!audience) for (const s of [on, off]) for (const ref of LATE) expect(refsLookup(s.db, [{ kind: "memory", ref }], CONTENT).state, `${ref.kind}:${ref.id}`).toBe("withheld");
        for (const s of [on, off]) for (const ref of LATE) expect(n(s.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind=? AND id=?", ref.kind, ref.id), `${ref.kind}:${ref.id} marked`).toBeGreaterThan(0);
        for (const ref of LATE) expect(n(on.db, "SELECT count(*) AS n FROM memory_deny_memory WHERE kind=? AND id=? AND revoke_id=?", ref.kind, ref.id, K)).toBeGreaterThan(0);
        if (audience) expect(probe().skips + probe().pointPasses).toBeGreaterThan(0);
        expectSameFacts(on.db, off.db);
      } finally { on.fx.close(); off.fx.close(); }
    });
  }
  it("source text: every INSERT into memory_evidence or memory_derivations, and bring-in's copied source, is followed by inheritEdge", () => {
    const dir = join(__dirname);
    const sites: string[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/INSERT[^"'`]*INTO memory_(evidence|derivations)\b/.test(line) && !(file === "bring-in.ts" && /INSERT INTO memory_source_versions/.test(line))) return;
        sites.push(`${file}:${i + 1}`);
        const near = lines.slice(i, i + 4).join("\n");
        expect(/inheritEdges?\(/.test(near), `${file}:${i + 1} writes a late edge without inheritEdge`).toBe(true);
      });
    }
    // the 2.11 list (grep at the base): a new site is caught above; a removed one shows here
    const files = [...new Set(sites.map(x => x.split(":")[0]))].sort();
    expect(files).toEqual(["authority.ts", "bring-in.ts", "consolidate.ts", "identity.ts", "import.ts", "jobs.ts", "pip-episodes.ts", "pip-lived.ts", "pip-stance.ts", "reveal-capture.ts", "review.ts", "routes.ts", "settings.ts"]);
    expect(sites.length).toBe(26);
    expect(/writeCaptureLineage\([^)]*\);\s*\n?\s*\/\/[^\n]*\n\s*inheritEdge\(/.test(readFileSync(join(dir, "capture.ts"), "utf8"))).toBe(true);
  });
});

describe("17 D: the cover key codec (T16)", () => {
  it("signed lsns round-trip in order; keys of different length or with \\u0001 are apart; two jobs' rows are both found; FIRST_LSN covers every entry; a 10,000-char key is walked", () => {
    const code = M.coverLsn as (lsn: number) => string, key = M.coverKey as (k: string, f: number, j: number) => string | null;
    const lsns = [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER];
    const codes = lsns.map(code);
    expect(codes.every(c => c.length === 17)).toBe(true);
    expect([...codes].sort()).toEqual(codes);
    expect(codes.map(c => Number(BigInt(c) - 2n ** 53n))).toEqual(lsns);
    expect(key("x".repeat(10_000), 0, 1)).toBeNull();
    const s = store();
    try {
      const ins = (k: string, from: number, job: number, cap: number) => s.db.prepare(`INSERT INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(${COVER_REVOKE},?,?)`).run(key(k, from, job)!, cap);
      const obj = objectCarryThread({ kind: "note", id: "n1" });
      ins("ab", 5, 1, 10); ins("abc", 3, 2, 10); ins(obj, 0, 3, 10); ins(`${obj}x`, 0, 4, 10); ins("ab", 5, 7, 12); ins("ab", -4, 8, 12);
      expect(M.coverRows(s.db, "ab")).toEqual([{ from: -4, job: 8, cap: 12 }, { from: 5, job: 1, cap: 10 }, { from: 5, job: 7, cap: 12 }]);
      expect(M.coverRows(s.db, "abc")).toEqual([{ from: 3, job: 2, cap: 10 }]);
      expect(M.coverRows(s.db, obj, true)).toEqual([{ from: 0, job: 3, cap: 10 }]);
      // a cover at FIRST_LSN covers every entry; a key too long for a row is walked
      s.line("T", 7, true, 6).line("x".repeat(10_000), 8, true, 7).head();
      ins("T", FIRST_LSN, 90, 100);
      let before = probe();
      job(s.db, 91, 50, [range("T", 7)]);
      drainAll(s.db);
      expect(probe().pointPasses).toBe(before.pointPasses + 1);
      before = probe();
      job(s.db, 92, 80, [range("x".repeat(10_000), 8)]);
      drainAll(s.db);
      expect(probe().handlerRuns).toBe(before.handlerRuns + 1);
      expect(M.coverRows(s.db, "x".repeat(10_000))).toEqual([]);
    } finally { s.fx.close(); }
  });
});

describe("18 D: a cover row's job seek never reads another job (T17, a regression guard)", () => {
  it("ids are never reused: prune, then a new bulk takes a fresh id and the old rows name an absent id below the max", () => {
    const s = store();
    try {
      s.line("T", 1, true, 0).head();
      job(s.db, 1, 50, [range("T", 1)]);
      job(s.db, 2, 40, [], { audience: false });
      drainAll(s.db);
      expect(jobRow(s.db, 1)).toBeUndefined(); // pruned (a newer row is kept)
      const bulk = tx(s.db, () => commit.openBulkRevoke(s.db, "receipt-revoked", true));
      expect(bulk).toBe(3);
      for (const { k } of s.db.prepare(`SELECT thread_id AS k FROM memory_revoke_reached WHERE revoke_id=${COVER_REVOKE}`).all() as Array<{ k: string }>) {
        expect(Number(k.slice(-10))).toBe(1);
        expect(Number(k.slice(-10))).toBeLessThan(bulk);
      }
    } finally { s.fx.close(); }
  });
});
